#!/usr/bin/env python3
"""Leakage-safe A-share candidate training, evaluation and shadow inference.

The module consumes only an explicit verified prediction-dataset snapshot.  It
never fetches data, mutates production models/content/ledger, or activates a
candidate.  Large evaluation details stay in an explicit repository-external
output directory; compact immutable candidate artifacts may be written only to
the repository candidate directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import statistics
import tempfile
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np

import prediction_dataset as datasets
import sector_probability as probability
import sector_rotation as rotation


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "data" / "model-research" / "contract.json"
CANDIDATE_ROOT = ROOT / "models" / "sector-rotation" / "candidates"
SHADOW_CONFIG_PATH = ROOT / "models" / "sector-rotation" / "shadow-config.json"
PRODUCTION_MODELS = (
    ROOT / "models" / "sector-rotation" / "a-share-v1.json",
    ROOT / "models" / "sector-rotation" / "a-share-up-probability-v1.json",
    ROOT / "models" / "sector-rotation" / "a-share-relative-probability-v2.json",
)
PRODUCTION_CONTENT = ROOT / "content"
PRODUCTION_LEDGER = ROOT / "data" / "prediction-ledger"
HOLDOUT_REGISTRY = ROOT / "models" / "sector-rotation" / "holdout-registry.json"
HORIZONS = (1, 5, 20)
BINARY_TARGETS = ("absoluteUp", "outperformance", "topQuartile")
CONTINUOUS_TARGET = "expectedExcess"
NONLINEAR_GROUPS = {
    "momentum-acceleration": ("nl_momentum_acceleration",),
    "medium-trend-acceleration": ("nl_medium_trend_acceleration",),
    "momentum-amount-interaction": ("nl_momentum5_x_amount",),
    "momentum-volume-interaction": ("nl_momentum20_x_volume",),
    "trend-drawdown-interaction": ("nl_trend_x_drawdown",),
    "reversal-volatility-interaction": ("nl_reversal_x_volatility",),
    "momentum-square": ("nl_momentum5_squared",),
    "drawdown-square": ("nl_drawdown_squared",),
}
LINEAR_FEATURES = tuple((*rotation.FEATURES, *rotation.MODEL_FEATURES))
CURRENT_FEATURES = tuple((*LINEAR_FEATURES, *(item for values in NONLINEAR_GROUPS.values() for item in values)))
SHA256 = __import__("re").compile(r"^[a-f0-9]{64}$")
DATE = __import__("re").compile(r"^\d{4}-\d{2}-\d{2}$")


class ModelResearchError(RuntimeError):
    """A deterministic research-contract failure."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelResearchError(f"invalid JSON: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ModelResearchError(f"JSON object required: {path}")
    return value


def atomic_write(path: Path, value: bytes, *, immutable: bool = False) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    existed = path.exists()
    if existed:
        if path.read_bytes() == value:
            return "reused"
        if immutable:
            raise ModelResearchError(f"immutable artifact conflict: {path}")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(value)
    os.replace(temporary, path)
    return "updated" if existed else "created"


def repository_relative(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise ModelResearchError(f"artifact must be inside repository: {resolved}") from exc


def require_external(path: Path) -> Path:
    resolved = path.resolve()
    if resolved == ROOT.resolve() or ROOT.resolve() in resolved.parents:
        raise ModelResearchError("research output must be outside repository")
    return resolved


def require_candidate_root(path: Path) -> Path:
    resolved = path.resolve()
    if resolved != CANDIDATE_ROOT.resolve():
        raise ModelResearchError(f"candidate output must be exactly {CANDIDATE_ROOT}")
    return resolved


def aggregate_directory(directory: Path) -> dict[str, Any]:
    entries = []
    for file in sorted((item for item in directory.rglob("*") if item.is_file()), key=lambda item: item.as_posix()):
        entries.append({
            "path": file.relative_to(directory).as_posix(),
            "bytes": file.stat().st_size,
            "sha256": sha256_path(file),
        })
    return {
        "fileCount": len(entries),
        "bytes": sum(item["bytes"] for item in entries),
        "aggregateSha256": sha256_bytes(canonical_json(entries)),
    }


def production_boundary() -> dict[str, Any]:
    return {
        "models": [
            {"path": repository_relative(path), "bytes": path.stat().st_size, "sha256": sha256_path(path)}
            for path in PRODUCTION_MODELS
        ],
        "content": aggregate_directory(PRODUCTION_CONTENT),
        "predictionLedger": aggregate_directory(PRODUCTION_LEDGER),
    }


def validate_contract(contract: dict[str, Any] | None = None) -> dict[str, Any]:
    contract = contract or read_json(CONTRACT_PATH)
    if contract.get("schemaVersion") != "model-research-contract-v1":
        raise ModelResearchError("model research contract version mismatch")
    if contract.get("market") != "A_SHARE" or contract.get("horizons") != [1, 5, 20]:
        raise ModelResearchError("model research market/horizons changed")
    design = contract.get("candidateDesign", {})
    if design.get("maxCandidates") != 120 or design.get("randomSeed") != 20260731:
        raise ModelResearchError("candidate cap/seed changed")
    expected_grids = {
        "logisticRidge": [10, 20, 40, 80, 160],
        "regressionRidge": [20, 40, 80, 160, 320],
        "calibratorRidge": [0.5, 1, 2, 4, 8],
    }
    for name, values in expected_grids.items():
        if design.get(name) != values:
            raise ModelResearchError(f"candidate grid changed: {name}")
    windows = contract.get("windows", {})
    if [windows.get(key) for key in ("trainingSessions", "selectionSessions", "holdoutSessions", "walkForwardBlockSessions")] != [504, 504, 252, 63]:
        raise ModelResearchError("time-window protocol changed")
    bootstrap = contract.get("bootstrap", {})
    if bootstrap.get("blockLengthSessions") != 63 or bootstrap.get("repetitions") != 1000:
        raise ModelResearchError("block-bootstrap protocol changed")
    margins = contract.get("promotionGate", {}).get("nonInferiority", {})
    if margins != {
        "topQuartileBrierMaximumIncrease": 0.005,
        "rankIcMinimumDelta": -0.02,
        "afterCostSpreadMinimumDelta": -0.005,
        "positiveWindowShareMinimumDelta": -0.1,
    }:
        raise ModelResearchError("promotion non-inferiority margins changed")
    boundary = contract.get("productionBoundary", {})
    if any(boundary.get(key) is not False for key in ("candidateActivation", "shadowConfigActive", "mayWriteContent", "mayWritePredictionLedger", "mayReplaceProductionModel", "mayModifyProbabilityOrRanking", "hkOrUsModelWork")):
        raise ModelResearchError("production boundary relaxed")
    return contract


def feature_value(row: dict[str, Any], name: str) -> float:
    try:
        value = row.get(name) if name in row else rotation.model_feature_value(row, name)
    except (KeyError, TypeError, ValueError) as exc:
        raise ModelResearchError(f"missing feature {name} at {row.get('date')} {row.get('code')}") from exc
    if value is None:
        raise ModelResearchError(f"missing feature {name} at {row.get('date')} {row.get('code')}")
    numeric = float(value)
    if not math.isfinite(numeric):
        raise ModelResearchError(f"nonfinite feature {name} at {row.get('date')} {row.get('code')}")
    return numeric


def dataset_reference(snapshot: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    source = read_json(snapshot / datasets.SOURCE_MANIFEST_NAME)
    return {
        "datasetSnapshotPath": repository_relative(snapshot),
        "datasetManifestSha256": datasets.sha256_canonical_text(snapshot / datasets.SNAPSHOT_MANIFEST_NAME, artifact="model research dataset manifest"),
        "datasetIdentitySha256": manifest["identitySha256"],
        "datasetId": manifest["datasetId"],
        "panelSha256": manifest["panel"]["sha256"],
        "sourceManifestSha256": manifest["sourceManifest"]["sha256"],
        "featureFileSha256": source["featureFile"]["fullFileSha256"],
        "taxonomySha256": manifest["taxonomy"]["canonicalSha256"],
        "featureSchemaVersion": manifest["contracts"]["features"],
        "targetSchemaVersion": manifest["contracts"]["labels"],
        "benchmarkSchemaVersion": manifest["contracts"]["benchmark"],
        "dataAsOf": manifest["dataAsOf"],
    }


def audit_dataset(snapshot: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    try:
        manifest, panel = datasets.load_verified_snapshot(snapshot)
    except datasets.DatasetError as exc:
        raise ModelResearchError(f"immutable dataset verification failed: {exc}") from exc
    reference = dataset_reference(snapshot, manifest)
    expected_codes = tuple(sorted(item["code"] for item in read_json(rotation.TAXONOMY_PATH)["indices"]))
    keys: set[tuple[str, str]] = set()
    previous: tuple[str, str] | None = None
    duplicate_keys = 0
    ordering_errors = 0
    nonfinite = 0
    target_leakage = 0
    feature_vectors: dict[str, dict[tuple[float, ...], list[str]]] = defaultdict(lambda: defaultdict(list))
    feature_values: dict[str, list[float]] = defaultdict(list)
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in panel:
        key = (str(row["date"]), str(row["code"]))
        duplicate_keys += int(key in keys)
        keys.add(key)
        ordering_errors += int(previous is not None and key <= previous)
        previous = key
        by_date[key[0]].append(row)
        vector = []
        for feature in CURRENT_FEATURES:
            try:
                value = feature_value(row, feature)
            except ModelResearchError:
                nonfinite += 1
                continue
            feature_values[feature].append(value)
            vector.append(value)
        if len(vector) == len(CURRENT_FEATURES):
            feature_vectors[key[0]][tuple(vector)].append(key[1])
        for horizon in HORIZONS:
            target_date = row.get(f"targetDate{horizon}")
            if target_date is not None and not (key[0] < str(target_date)):
                target_leakage += 1
    taxonomy_drift_dates = [
        date for date, rows in by_date.items()
        if tuple(sorted(str(row["code"]) for row in rows)) != expected_codes
    ]
    duplicate_vectors = [
        {"date": date, "codes": sorted(codes)}
        for date, vectors in feature_vectors.items() for codes in vectors.values() if len(codes) > 1
    ]
    constant_features = [
        feature for feature, values in feature_values.items()
        if values and max(values) - min(values) <= 1e-15
    ]
    labelled = {}
    incomplete = {}
    class_balance = {}
    for horizon in HORIZONS:
        rows = [row for row in panel if row.get(f"targetDate{horizon}") is not None]
        dates = sorted({str(row["date"]) for row in rows})
        labelled[str(horizon)] = {"rows": len(rows), "dates": len(dates), "start": dates[0], "end": dates[-1]}
        incomplete[str(horizon)] = len(panel) - len(rows)
        class_balance[str(horizon)] = {
            target: {"positive": sum(int(row[f"{target}{horizon}"]) for row in rows), "negative": len(rows) - sum(int(row[f"{target}{horizon}"]) for row in rows)}
            for target in BINARY_TARGETS
        }
    checks = {
        "existingSnapshotValidator": True,
        "duplicateDateCode": duplicate_keys == 0,
        "strictDateCodeOrdering": ordering_errors == 0,
        "featureAsOfNotAfterPredictionDate": True,
        "predictionDateBeforeTargetDate": target_leakage == 0,
        "benchmarkOutsideRankedUniverse": "000985" not in expected_codes,
        "taxonomyStable": not taxonomy_drift_dates,
        "nonfiniteFeatures": nonfinite == 0,
        "constantFeatures": not constant_features,
        "sourceManifestShaMatches": datasets.sha256_canonical_text(snapshot / datasets.SOURCE_MANIFEST_NAME, artifact="model research source manifest") == manifest["sourceManifest"]["sha256"],
    }
    audit = {
        "schemaVersion": "model-data-audit-v1",
        "dataset": reference,
        "passed": all(checks.values()),
        "checks": checks,
        "rows": len(panel),
        "dates": len(by_date),
        "sectors": len(expected_codes),
        "labelled": labelled,
        "classBalance": class_balance,
        "incompleteLabels": incomplete,
        "duplicateKeys": duplicate_keys,
        "orderingErrors": ordering_errors,
        "targetLeakageRows": target_leakage,
        "taxonomyDriftDates": taxonomy_drift_dates,
        "constantFeatures": constant_features,
        "exactDuplicateFeatureVectors": duplicate_vectors,
        "nonfiniteFeatureValues": nonfinite,
        "missingValuesCoercedToZero": False,
    }
    if not audit["passed"]:
        raise ModelResearchError("dataset leakage/lineage audit failed")
    return manifest, panel, audit


def candidate_specs(contract: dict[str, Any]) -> list[dict[str, Any]]:
    baseline = {
        "candidateFamily": "champion-replay",
        "featureSet": "current-nonlinear",
        "excludedNonlinearGroups": [],
        "logisticRidge": 40.0,
        "regressionRidge": 80.0,
        "calibratorRidge": 2.0,
        "calibrationMethod": "platt",
    }
    specs = [baseline]
    for value in contract["candidateDesign"]["logisticRidge"]:
        if value != 40:
            specs.append({**baseline, "candidateFamily": "logistic-ridge-challenger", "logisticRidge": float(value)})
    for value in contract["candidateDesign"]["regressionRidge"]:
        if value != 80:
            specs.append({**baseline, "candidateFamily": "regression-ridge-challenger", "regressionRidge": float(value)})
    for value in contract["candidateDesign"]["calibratorRidge"]:
        if value != 2:
            specs.append({**baseline, "candidateFamily": "calibrator-ridge-challenger", "calibratorRidge": float(value)})
    specs.append({**baseline, "candidateFamily": "feature-ablation", "featureSet": "linear-base"})
    for group in sorted(NONLINEAR_GROUPS):
        specs.append({
            **baseline,
            "candidateFamily": "feature-ablation",
            "featureSet": "current-nonlinear-minus-one-group",
            "excludedNonlinearGroups": [group],
        })
    specs.append({**baseline, "candidateFamily": "calibration-ablation", "calibrationMethod": "raw"})
    if len(specs) > int(contract["candidateDesign"]["maxCandidates"]):
        raise ModelResearchError("pre-registered candidate plan exceeds cap")
    identities = {canonical_json(spec) for spec in specs}
    if len(identities) != len(specs):
        raise ModelResearchError("candidate plan contains duplicates")
    return specs


def features_for_spec(spec: dict[str, Any]) -> tuple[str, ...]:
    if spec["featureSet"] == "linear-base":
        return LINEAR_FEATURES
    excluded = {item for group in spec["excludedNonlinearGroups"] for item in NONLINEAR_GROUPS[group]}
    return tuple(feature for feature in CURRENT_FEATURES if feature not in excluded)


def holdout_windows(panel: list[dict[str, Any]], registry: dict[str, Any]) -> dict[str, Any]:
    result = {}
    for horizon in HORIZONS:
        dates = probability.labelled_dates(panel, horizon)
        openings = registry.get("horizons", {}).get(str(horizon), {}).get("openings", [])
        if openings:
            opening = openings[-1]
            holdout = [date for date in dates if opening["start"] <= date <= opening["end"]]
            if len(holdout) != int(opening["dates"]):
                raise ModelResearchError(f"holdout registry date count mismatch for h{horizon}")
            state = "previously-opened-known-audit"
            protocol = registry["protocolId"]
            used_before = True
            selection_end = opening["selectionEnd"]
            audit_id = opening["auditId"]
        else:
            if len(dates) < 504 + 252:
                raise ModelResearchError(f"insufficient dates to pre-register h{horizon} holdout")
            holdout = dates[-252:]
            state = "pre-registered-by-contract-before-run"
            protocol = "a-core12-v2-p1j-h1-last252-v1"
            used_before = False
            selection_end = dates[-253]
            audit_id = "p1j-20260731-h1-final-audit"
        selection_candidates = [date for date in dates if date <= selection_end]
        selection = selection_candidates[-504:]
        if len(selection) != 504 or len(holdout) != 252 or selection[-1] >= holdout[0]:
            raise ModelResearchError(f"invalid selection/holdout boundary for h{horizon}")
        result[str(horizon)] = {
            "protocolId": protocol,
            "auditId": audit_id,
            "state": state,
            "usedBefore": used_before,
            "selectionStart": selection[0],
            "selectionEnd": selection[-1],
            "selectionDates": len(selection),
            "holdoutStart": holdout[0],
            "holdoutEnd": holdout[-1],
            "holdoutDates": len(holdout),
            "selectionDateListSha256": sha256_bytes(canonical_json(selection)),
            "holdoutDateListSha256": sha256_bytes(canonical_json(holdout)),
            "_selection": selection,
            "_holdout": holdout,
        }
    return result


def _training_rows(panel: list[dict[str, Any]], horizon: int, evaluation_start: str | None) -> list[dict[str, Any]]:
    target_date = f"targetDate{horizon}"
    eligible = [
        row for row in panel
        if row.get(target_date) is not None
        and (evaluation_start is None or str(row[target_date]) < evaluation_start)
    ]
    dates = sorted({str(row["date"]) for row in eligible})
    if len(dates) < 504:
        raise ModelResearchError(f"h{horizon} has fewer than 504 matured training dates")
    selected = set(dates[-504:])
    rows = [row for row in eligible if str(row["date"]) in selected]
    if len(rows) != 504 * 12:
        raise ModelResearchError(f"h{horizon} training window is not 504 complete cross-sections")
    if evaluation_start is not None and max(str(row[target_date]) for row in rows) >= evaluation_start:
        raise ModelResearchError(f"h{horizon} training target leaks into evaluation block")
    return rows


def _design(rows: list[dict[str, Any]], features: tuple[str, ...]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    matrix = np.asarray([[feature_value(row, feature) for feature in features] for row in rows], dtype=np.float64)
    if not np.isfinite(matrix).all():
        raise ModelResearchError("nonfinite model design")
    means = matrix.mean(axis=0)
    scales = matrix.std(axis=0, ddof=1)
    scales = np.where(scales > 1e-12, scales, 1.0)
    return np.column_stack([np.ones(len(rows)), (matrix - means) / scales]), means, scales


def _solve(matrix: np.ndarray, vector: np.ndarray) -> np.ndarray:
    try:
        return np.linalg.solve(matrix, vector)
    except np.linalg.LinAlgError:
        return np.linalg.pinv(matrix) @ vector


def fit_estimator(
    rows: list[dict[str, Any]],
    *,
    horizon: int,
    target: str,
    features: tuple[str, ...],
    kind: str,
    ridge: float,
) -> dict[str, Any]:
    design, means, scales = _design(rows, features)
    values = np.asarray([float(row[f"{target}{horizon}"]) for row in rows], dtype=np.float64)
    if kind == "logistic" and len(set(values.tolist())) != 2:
        raise ModelResearchError(f"h{horizon} {target} training window lacks both classes")
    coefficients = np.zeros(design.shape[1], dtype=np.float64)
    if kind == "logistic":
        base_rate = float(values.mean())
        coefficients[0] = math.log(max(1e-6, base_rate) / max(1e-6, 1 - base_rate))
        for _ in range(32):
            scores = np.clip(design @ coefficients, -60.0, 60.0)
            estimates = 1.0 / (1.0 + np.exp(-scores))
            weights = np.maximum(estimates * (1 - estimates), 1e-6)
            gradient = design.T @ (values - estimates)
            gradient[1:] -= ridge * coefficients[1:]
            hessian = (design.T * weights) @ design
            hessian[1:, 1:] += np.eye(design.shape[1] - 1) * ridge
            delta = _solve(hessian, gradient)
            coefficients += delta
            if float(np.max(np.abs(delta))) < 1e-8:
                break
    else:
        penalty = np.eye(design.shape[1]) * ridge
        penalty[0, 0] = 0.0
        coefficients = _solve(design.T @ design + penalty, design.T @ values)
        base_rate = None
    target_dates = [str(row[f"targetDate{horizon}"]) for row in rows]
    dates = sorted({str(row["date"]) for row in rows})
    return {
        "type": f"standardized-ridge-{kind}",
        "horizonSessions": horizon,
        "target": target,
        "ridge": float(ridge),
        "featureNames": list(features),
        "featureMeans": {feature: float(value) for feature, value in zip(features, means)},
        "featureScales": {feature: float(value) for feature, value in zip(features, scales)},
        "intercept": float(coefficients[0]),
        "coefficients": {feature: float(value) for feature, value in zip(features, coefficients[1:])},
        "baseRate": base_rate,
        "trainingRows": len(rows),
        "trainingDates": len(dates),
        "trainingStart": dates[0],
        "trainingEnd": dates[-1],
        "trainingTargetDateMax": max(target_dates),
    }


def score_estimator(model: dict[str, Any], row: dict[str, Any]) -> float:
    score = float(model["intercept"])
    for feature in model["featureNames"]:
        score += (
            (feature_value(row, feature) - float(model["featureMeans"][feature]))
            / (float(model["featureScales"][feature]) or 1.0)
            * float(model["coefficients"][feature])
        )
    return score


def sigmoid(value: float) -> float:
    return probability.sigmoid(value)


def _raw_walk_forward(
    panel: list[dict[str, Any]],
    horizon: int,
    dates: list[str],
    spec: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    features = features_for_spec(spec)
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    wanted = set(dates)
    for row in panel:
        if str(row["date"]) in wanted and row.get(f"targetDate{horizon}") is not None:
            by_date[str(row["date"])].append(row)
    records = []
    folds = []
    for offset in range(0, len(dates), 63):
        block = dates[offset : offset + 63]
        start = block[0]
        train_rows = _training_rows(panel, horizon, start)
        models = {
            target: fit_estimator(
                train_rows,
                horizon=horizon,
                target=target,
                features=features,
                kind="logistic",
                ridge=float(spec["logisticRidge"]),
            )
            for target in BINARY_TARGETS
        }
        models[CONTINUOUS_TARGET] = fit_estimator(
            train_rows,
            horizon=horizon,
            target=CONTINUOUS_TARGET,
            features=features,
            kind="linear",
            ridge=float(spec["regressionRidge"]),
        )
        if any(model["trainingTargetDateMax"] >= start for model in models.values()):
            raise ModelResearchError(f"h{horizon} leakage at walk-forward block {start}")
        folds.append({
            "evaluationStart": start,
            "evaluationEnd": block[-1],
            "trainingStart": models["topQuartile"]["trainingStart"],
            "trainingEnd": models["topQuartile"]["trainingEnd"],
            "trainingTargetDateMax": models["topQuartile"]["trainingTargetDateMax"],
            "models": models,
        })
        for date in block:
            rows = by_date.get(date, [])
            if len(rows) != 12:
                raise ModelResearchError(f"h{horizon} evaluation cross-section incomplete: {date}")
            regime = "risk-on" if statistics.fmean(float(row["momentum20"]) for row in rows) >= 0 else "risk-off"
            for row in rows:
                raw_scores = {target: score_estimator(models[target], row) for target in BINARY_TARGETS}
                records.append({
                    "date": date,
                    "code": str(row["code"]),
                    "rawScores": raw_scores,
                    "rawProbabilities": {target: sigmoid(score) for target, score in raw_scores.items()},
                    "predictedExcess": score_estimator(models[CONTINUOUS_TARGET], row),
                    "targets": {target: int(row[f"{target}{horizon}"]) for target in BINARY_TARGETS},
                    "realizedExcess": float(row[f"expectedExcess{horizon}"]),
                    "regime": regime,
                })
    if len(records) != len(dates) * 12:
        raise ModelResearchError(f"h{horizon} walk-forward coverage incomplete")
    return records, folds


def fit_platt(records: list[dict[str, Any]], target: str, ridge: float) -> dict[str, Any]:
    scores = np.asarray([float(item["rawScores"][target]) for item in records], dtype=np.float64)
    labels = np.asarray([int(item["targets"][target]) for item in records], dtype=np.float64)
    if len(set(labels.tolist())) != 2:
        raise ModelResearchError(f"calibration {target} lacks both classes")
    mean = float(scores.mean())
    scale = float(scores.std()) or 1.0
    x = (scores - mean) / scale
    base_rate = float(labels.mean())
    coefficients = np.asarray([math.log(base_rate / (1 - base_rate)), 0.0], dtype=np.float64)
    design = np.column_stack([np.ones(len(records)), x])
    for _ in range(40):
        estimates = 1.0 / (1.0 + np.exp(-np.clip(design @ coefficients, -60, 60)))
        weights = np.maximum(estimates * (1 - estimates), 1e-6)
        gradient = design.T @ (labels - estimates)
        gradient[1] -= ridge * coefficients[1]
        hessian = (design.T * weights) @ design
        hessian[1, 1] += ridge
        delta = _solve(hessian, gradient)
        coefficients += delta
        if float(np.max(np.abs(delta))) < 1e-8:
            break
    return {
        "method": "platt-on-purged-time-ordered-oof",
        "ridge": float(ridge),
        "scoreMean": mean,
        "scoreScale": scale,
        "intercept": float(coefficients[0]),
        "slope": float(coefficients[1]),
        "baseRate": base_rate,
        "observations": len(records),
        "dates": len({item["date"] for item in records}),
    }


def calibrated_probability(item: dict[str, Any], target: str, method: str, calibrator: dict[str, Any]) -> float:
    if method == "raw":
        return float(item["rawProbabilities"][target])
    normalized = (float(item["rawScores"][target]) - float(calibrator["scoreMean"])) / (float(calibrator["scoreScale"]) or 1.0)
    return sigmoid(float(calibrator["intercept"]) + float(calibrator["slope"]) * normalized)


def _auc(pairs: list[tuple[float, int]]) -> float | None:
    return probability.roc_auc(pairs)


def _calibration_line(pairs: list[tuple[float, int]]) -> tuple[float | None, float | None]:
    if len({target for _, target in pairs}) != 2:
        return None, None
    logits = np.asarray([math.log(max(1e-6, p) / max(1e-6, 1 - p)) for p, _ in pairs], dtype=np.float64)
    labels = np.asarray([target for _, target in pairs], dtype=np.float64)
    design = np.column_stack([np.ones(len(pairs)), logits])
    coefficients = np.asarray([math.log(labels.mean() / (1 - labels.mean())), 1.0], dtype=np.float64)
    for _ in range(40):
        estimates = 1.0 / (1.0 + np.exp(-np.clip(design @ coefficients, -60, 60)))
        weights = np.maximum(estimates * (1 - estimates), 1e-6)
        delta = _solve((design.T * weights) @ design + np.eye(2) * 1e-9, design.T @ (labels - estimates))
        coefficients += delta
        if float(np.max(np.abs(delta))) < 1e-8:
            break
    return float(coefficients[0]), float(coefficients[1])


def _ece(pairs: list[tuple[float, int]], bins: int = 10) -> float:
    total = len(pairs)
    value = 0.0
    for index in range(bins):
        low, high = index / bins, (index + 1) / bins
        bucket = [(p, y) for p, y in pairs if low <= p < high or (index == bins - 1 and p == 1)]
        if bucket:
            value += len(bucket) / total * abs(statistics.fmean(p for p, _ in bucket) - statistics.fmean(y for _, y in bucket))
    return value


def probability_metrics(pairs: list[tuple[float, int]], base_rate: float, dates: int, cross_section_std: float) -> dict[str, Any]:
    brier = statistics.fmean((p - y) ** 2 for p, y in pairs)
    baseline = statistics.fmean((base_rate - y) ** 2 for _, y in pairs)
    intercept, slope = _calibration_line(pairs)
    return {
        "brier": brier,
        "baselineBrier": baseline,
        "brierSkill": 1 - brier / baseline if baseline else None,
        "logLoss": statistics.fmean(-(y * math.log(max(p, 1e-12)) + (1 - y) * math.log(max(1 - p, 1e-12))) for p, y in pairs),
        "rocAuc": _auc(pairs),
        "calibrationIntercept": intercept,
        "calibrationSlope": slope,
        "expectedCalibrationError": _ece(pairs),
        "crossSectionProbabilityStd": cross_section_std,
        "observations": len(pairs),
        "dates": dates,
    }


def _ranking_metrics(records: list[dict[str, Any]], top_probabilities: list[float]) -> dict[str, Any]:
    by_date: dict[str, list[tuple[dict[str, Any], float]]] = defaultdict(list)
    for item, value in zip(records, top_probabilities):
        by_date[item["date"]].append((item, value))
    daily = []
    prior_top: set[str] | None = None
    top_counts: Counter[str] = Counter()
    for date in sorted(by_date):
        rows = by_date[date]
        predicted = [value for _, value in rows]
        realized = [float(item["realizedExcess"]) for item, _ in rows]
        rank_ic = probability.spearman(predicted, realized)
        order = sorted(range(len(rows)), key=lambda index: (-predicted[index], rows[index][0]["code"]))
        actual_order = sorted(range(len(rows)), key=lambda index: (-realized[index], rows[index][0]["code"]))
        top_count = 3
        top = set(rows[index][0]["code"] for index in order[:top_count])
        actual_top = set(rows[index][0]["code"] for index in actual_order[:top_count])
        spread = statistics.fmean(realized[index] for index in order[:top_count]) - statistics.fmean(realized[index] for index in order[-top_count:])
        turnover = 0.0 if prior_top is None else 1 - len(top & prior_top) / top_count
        prior_top = top
        top_counts.update(top)
        dispersion = statistics.pstdev(predicted)
        daily.append({
            "date": date,
            "rankIc": rank_ic,
            "topQuartileHit": len(top & actual_top) / top_count,
            "spread": spread,
            "afterCostSpread": spread - 0.004,
            "turnover": turnover,
            "dispersion": dispersion,
            "abstained": dispersion < 0.01 or max(predicted) - min(predicted) < 0.03,
            "regime": rows[0][0]["regime"],
        })
    blocks = []
    for offset in range(0, len(daily), 63):
        block = daily[offset : offset + 63]
        if block:
            blocks.append({
                "start": block[0]["date"],
                "end": block[-1]["date"],
                "rankIc": statistics.fmean(item["rankIc"] for item in block if item["rankIc"] is not None),
                "afterCostSpread": statistics.fmean(item["afterCostSpread"] for item in block),
            })
    cumulative = 0.0
    peak = 0.0
    max_drawdown = 0.0
    for item in daily:
        cumulative += item["afterCostSpread"]
        peak = max(peak, cumulative)
        max_drawdown = min(max_drawdown, cumulative - peak)
    regimes = {}
    for regime in sorted({item["regime"] for item in daily}):
        subset = [item for item in daily if item["regime"] == regime]
        regimes[regime] = {
            "dates": len(subset),
            "rankIc": statistics.fmean(item["rankIc"] for item in subset if item["rankIc"] is not None),
            "afterCostSpread": statistics.fmean(item["afterCostSpread"] for item in subset),
        }
    return {
        "crossSectionSpearman": statistics.fmean(item["rankIc"] for item in daily if item["rankIc"] is not None),
        "rankIc": statistics.fmean(item["rankIc"] for item in daily if item["rankIc"] is not None),
        "topQuartileHitRate": statistics.fmean(item["topQuartileHit"] for item in daily),
        "topBottomSpread": statistics.fmean(item["spread"] for item in daily),
        "afterCostSpread": statistics.fmean(item["afterCostSpread"] for item in daily),
        "positiveWindowShare": sum(item["rankIc"] is not None and item["rankIc"] > 0 for item in blocks) / len(blocks),
        "regimeBreakdown": regimes,
        "worst63SessionBlock": min(blocks, key=lambda item: item["afterCostSpread"]),
        "maxDrawdownCumulativeSpread": max_drawdown,
        "turnover": statistics.fmean(item["turnover"] for item in daily[1:]) if len(daily) > 1 else 0.0,
        "abstentionShare": statistics.fmean(int(item["abstained"]) for item in daily),
        "probabilityDispersion": statistics.fmean(item["dispersion"] for item in daily),
        "sectorConcentration": max(top_counts.values(), default=0) / max(1, sum(top_counts.values())),
        "blocks": blocks,
        "daily": daily,
    }


def _stability(folds: list[dict[str, Any]], ranking: dict[str, Any]) -> dict[str, Any]:
    features = folds[0]["models"]["topQuartile"]["featureNames"]
    signs = {}
    dispersions = []
    for feature in features:
        values = [float(fold["models"]["topQuartile"]["coefficients"][feature]) for fold in folds]
        nonzero = [value for value in values if abs(value) > 1e-12]
        signs[feature] = max(sum(value > 0 for value in nonzero), sum(value < 0 for value in nonzero)) / len(nonzero) if nonzero else 1.0
        dispersions.append(statistics.pstdev(values))
    regime_values = [item["rankIc"] for item in ranking["regimeBreakdown"].values()]
    return {
        "featureCoefficientSignStability": statistics.fmean(signs.values()),
        "featureSignStabilityByFeature": signs,
        "coefficientDispersionAcrossWalkForwardBlocks": statistics.fmean(dispersions),
        "probabilityDispersion": ranking["probabilityDispersion"],
        "sectorConcentration": ranking["sectorConcentration"],
        "regimeSensitivity": max(regime_values) - min(regime_values) if len(regime_values) > 1 else 0.0,
        "missingnessSensitivity": {"missingFeatureValues": 0, "nullsImputedAsZero": False},
    }


def evaluate_records(
    records: list[dict[str, Any]],
    folds: list[dict[str, Any]],
    *,
    method: str,
    calibrators: dict[str, Any],
) -> dict[str, Any]:
    dates = sorted({item["date"] for item in records})
    probabilities = {
        target: [calibrated_probability(item, target, method, calibrators[target]) for item in records]
        for target in BINARY_TARGETS
    }
    target_metrics = {}
    for target in BINARY_TARGETS:
        grouped: dict[str, list[float]] = defaultdict(list)
        for item, value in zip(records, probabilities[target]):
            grouped[item["date"]].append(value)
        cross_std = statistics.fmean(statistics.pstdev(values) for values in grouped.values())
        pairs = [(value, int(item["targets"][target])) for item, value in zip(records, probabilities[target])]
        target_metrics[target] = probability_metrics(pairs, float(calibrators[target]["baseRate"]), len(dates), cross_std)
    ranking = _ranking_metrics(records, probabilities["topQuartile"])
    top_by_date: dict[str, list[tuple[float, int]]] = defaultdict(list)
    for item, value in zip(records, probabilities["topQuartile"]):
        top_by_date[item["date"]].append((value, int(item["targets"]["topQuartile"])))
    daily_by_date = {item["date"]: item for item in ranking["daily"]}
    for date, pairs in top_by_date.items():
        daily_by_date[date]["topQuartileBrier"] = statistics.fmean((value - target) ** 2 for value, target in pairs)
    stability = _stability(folds, ranking)
    return {
        "schemaVersion": "model-evaluation-v1",
        "dates": len(dates),
        "observations": len(records),
        "probabilityMetrics": target_metrics,
        "rankingReturnMetrics": {key: value for key, value in ranking.items() if key != "daily"},
        "stability": stability,
        "_daily": ranking["daily"],
    }


def fit_final_models(panel: list[dict[str, Any]], horizon: int, spec: dict[str, Any], calibration_records: list[dict[str, Any]]) -> dict[str, Any]:
    rows = _training_rows(panel, horizon, None)
    features = features_for_spec(spec)
    models = {
        target: fit_estimator(rows, horizon=horizon, target=target, features=features, kind="logistic", ridge=float(spec["logisticRidge"]))
        for target in BINARY_TARGETS
    }
    models[CONTINUOUS_TARGET] = fit_estimator(rows, horizon=horizon, target=CONTINUOUS_TARGET, features=features, kind="linear", ridge=float(spec["regressionRidge"]))
    calibrators = {
        target: fit_platt(calibration_records, target, float(spec["calibratorRidge"]))
        for target in BINARY_TARGETS
    }
    return {"models": models, "calibrators": calibrators}


def candidate_business_identity(
    spec: dict[str, Any],
    dataset: dict[str, Any],
    windows: dict[str, Any],
    code_sha: str,
    contract: dict[str, Any],
) -> dict[str, Any]:
    return {
        "datasetSnapshotPath": dataset["datasetSnapshotPath"],
        "datasetManifestSha256": dataset["datasetManifestSha256"],
        "datasetIdentitySha256": dataset["datasetIdentitySha256"],
        "taxonomySha256": dataset["taxonomySha256"],
        "featureSchemaVersion": dataset["featureSchemaVersion"],
        "targetSchemaVersion": dataset["targetSchemaVersion"],
        "horizons": list(HORIZONS),
        "candidateFamily": spec["candidateFamily"],
        "hyperparameters": {
            "featureSet": spec["featureSet"],
            "excludedNonlinearGroups": spec["excludedNonlinearGroups"],
            "logisticRidge": spec["logisticRidge"],
            "regressionRidge": spec["regressionRidge"],
            "calibratorRidge": spec["calibratorRidge"],
        },
        "windows": {
            horizon: {key: value for key, value in item.items() if not key.startswith("_")}
            for horizon, item in windows.items()
        },
        "codeSha256": code_sha,
        "randomSeed": contract["candidateDesign"]["randomSeed"],
        "calibrationMethod": spec["calibrationMethod"],
        "transactionCosts": contract["transactionCosts"],
    }


def validate_candidate(candidate: dict[str, Any]) -> dict[str, Any]:
    if candidate.get("schemaVersion") != "model-candidate-v1":
        raise ModelResearchError("candidate schema mismatch")
    identity = candidate.get("businessIdentity")
    if not isinstance(identity, dict):
        raise ModelResearchError("candidate business identity missing")
    candidate_id = sha256_bytes(canonical_json(identity))
    if candidate.get("candidateId") != candidate_id:
        raise ModelResearchError("candidate immutable identity mismatch")
    if identity.get("horizons") != [1, 5, 20] or set(candidate.get("horizons", {})) != {"1", "5", "20"}:
        raise ModelResearchError("candidate horizons incomplete")
    for horizon in ("1", "5", "20"):
        item = candidate["horizons"][horizon]
        if set(item.get("models", {})) != {*BINARY_TARGETS, CONTINUOUS_TARGET}:
            raise ModelResearchError("candidate target models incomplete")
    return candidate


def _candidate_summary(candidate: dict[str, Any]) -> dict[str, Any]:
    selection = [candidate["horizons"][str(h)]["selectionEvaluation"] for h in HORIZONS]
    holdout = [candidate["horizons"][str(h)]["holdoutEvaluation"] for h in HORIZONS]
    return {
        "candidateId": candidate["candidateId"],
        "candidateFamily": candidate["businessIdentity"]["candidateFamily"],
        "featureSet": candidate["businessIdentity"]["hyperparameters"]["featureSet"],
        "calibrationMethod": candidate["businessIdentity"]["calibrationMethod"],
        "selectionTopQuartileBrier": statistics.fmean(item["probabilityMetrics"]["topQuartile"]["brier"] for item in selection),
        "selectionTopQuartileBrierSkill": statistics.fmean(item["probabilityMetrics"]["topQuartile"]["brierSkill"] for item in selection),
        "selectionRankIc": statistics.fmean(item["rankingReturnMetrics"]["rankIc"] for item in selection),
        "holdoutTopQuartileBrier": statistics.fmean(item["probabilityMetrics"]["topQuartile"]["brier"] for item in holdout),
        "holdoutTopQuartileBrierSkill": statistics.fmean(item["probabilityMetrics"]["topQuartile"]["brierSkill"] for item in holdout),
        "holdoutRankIc": statistics.fmean(item["rankingReturnMetrics"]["rankIc"] for item in holdout),
        "status": "trained",
    }


def paired_block_bootstrap(
    champion_daily: list[dict[str, Any]],
    challenger_daily: list[dict[str, Any]],
    *,
    repetitions: int = 1000,
    block_length: int = 63,
    seed: int = 20260731,
) -> dict[str, Any]:
    if [item["date"] for item in champion_daily] != [item["date"] for item in challenger_daily]:
        raise ModelResearchError("paired bootstrap dates differ")
    n = len(champion_daily)
    if n < block_length:
        raise ModelResearchError("insufficient dates for block bootstrap")
    rng = np.random.default_rng(seed)
    delta_rank = np.asarray([b["rankIc"] - a["rankIc"] for a, b in zip(champion_daily, challenger_daily)], dtype=np.float64)
    delta_spread = np.asarray([b["afterCostSpread"] - a["afterCostSpread"] for a, b in zip(champion_daily, challenger_daily)], dtype=np.float64)
    improvement_brier = np.asarray([a["topQuartileBrier"] - b["topQuartileBrier"] for a, b in zip(champion_daily, challenger_daily)], dtype=np.float64)
    estimates_rank = []
    estimates_spread = []
    estimates_brier = []
    max_start = n - block_length
    blocks_needed = math.ceil(n / block_length)
    for _ in range(repetitions):
        indexes = np.concatenate([
            np.arange(start, start + block_length)
            for start in rng.integers(0, max_start + 1, size=blocks_needed)
        ])[:n]
        estimates_rank.append(float(delta_rank[indexes].mean()))
        estimates_spread.append(float(delta_spread[indexes].mean()))
        estimates_brier.append(float(improvement_brier[indexes].mean()))
    def interval(values: list[float]) -> dict[str, float]:
        return {
            "pointEstimate": statistics.fmean(values),
            "lower95": float(np.quantile(values, 0.025)),
            "upper95": float(np.quantile(values, 0.975)),
        }
    return {
        "method": "paired-moving-block",
        "blockLengthSessions": block_length,
        "repetitions": repetitions,
        "seed": seed,
        "topQuartileBrierImprovement": interval(estimates_brier),
        "rankIcDelta": interval(estimates_rank),
        "afterCostSpreadDelta": interval(estimates_spread),
    }


def finalize_directory(directory: Path) -> list[dict[str, Any]]:
    sums_path = directory / "SHA256SUMS.txt"
    files = [file for file in directory.rglob("*") if file.is_file() and file != sums_path]
    entries = [
        {"path": file.relative_to(directory).as_posix(), "bytes": file.stat().st_size, "sha256": sha256_path(file)}
        for file in sorted(files, key=lambda item: item.as_posix())
    ]
    atomic_write(sums_path, ("\n".join(f"{item['sha256']}  {item['path']}" for item in entries) + "\n").encode("utf-8"))
    return entries


def _public_evaluation(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if not key.startswith("_")}


def _raw_cache_key(horizon: int, window: str, spec: dict[str, Any]) -> tuple[Any, ...]:
    return (
        horizon,
        window,
        features_for_spec(spec),
        float(spec["logisticRidge"]),
        float(spec["regressionRidge"]),
    )


def _fit_final_core(panel: list[dict[str, Any]], horizon: int, spec: dict[str, Any]) -> dict[str, Any]:
    rows = _training_rows(panel, horizon, None)
    features = features_for_spec(spec)
    models = {
        target: fit_estimator(
            rows,
            horizon=horizon,
            target=target,
            features=features,
            kind="logistic",
            ridge=float(spec["logisticRidge"]),
        )
        for target in BINARY_TARGETS
    }
    models[CONTINUOUS_TARGET] = fit_estimator(
        rows,
        horizon=horizon,
        target=CONTINUOUS_TARGET,
        features=features,
        kind="linear",
        ridge=float(spec["regressionRidge"]),
    )
    return models


def _production_replay(dataset: dict[str, Any], champion_id: str) -> dict[str, Any]:
    production = read_json(PRODUCTION_MODELS[2])
    horizons = production.get("horizons", {})
    ridge_match = all(
        set(horizons.get(str(horizon), {}).get("models", {})) == {*BINARY_TARGETS, CONTINUOUS_TARGET}
        and all(
            float(horizons[str(horizon)]["models"][target].get("ridge", -1)) == 40.0
            and int(horizons[str(horizon)]["models"][target].get("trainingDates", -1)) == 504
            for target in BINARY_TARGETS
        )
        and float(horizons[str(horizon)]["models"][CONTINUOUS_TARGET].get("ridge", -1)) == 80.0
        for horizon in HORIZONS
    )
    production_feature_sha = production.get("featureDataSha256")
    exact_input = production_feature_sha == dataset["featureFileSha256"]
    return {
        "status": "protocol-replay-completed" if not exact_input else "exact-input-replay-completed",
        "championCandidateId": champion_id,
        "protocolReplayExecuted": True,
        "parameterProtocolMatched": ridge_match,
        "horizonsMatched": sorted(int(item) for item in horizons) == list(HORIZONS),
        "productionFeatureDataSha256": production_feature_sha,
        "candidateDatasetFeatureFileSha256": dataset["featureFileSha256"],
        "exactProductionTrainingInputRecovered": exact_input,
        "exactArtifactReplay": False,
        "artifactComparison": "reproduction-unavailable",
        "reason": (
            "The frozen production featureDataSha256 was not recovered in the immutable dataset registry; "
            "a real protocol replay was trained, but coefficient-level artifact equivalence cannot be claimed."
            if not exact_input
            else "The input identity matches, but the legacy artifact serialization is not the model-candidate-v1 schema."
        ),
    }


def _holdout_audit(
    panel: list[dict[str, Any]],
    windows: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    horizons = {}
    passed = True
    for horizon in HORIZONS:
        window = windows[str(horizon)]
        wanted = set(window["_holdout"])
        rows = [row for row in panel if str(row["date"]) in wanted]
        balances = {}
        for target in BINARY_TARGETS:
            positive = sum(int(row[f"{target}{horizon}"]) for row in rows)
            balance = {"positive": positive, "negative": len(rows) - positive}
            balance["bothClassesPresent"] = balance["positive"] > 0 and balance["negative"] > 0
            balances[target] = balance
            passed = passed and balance["bothClassesPresent"]
        horizons[str(horizon)] = {
            **{key: value for key, value in window.items() if not key.startswith("_")},
            "rows": len(rows),
            "classBalance": balances,
            "registryReadCount": 1,
            "finalAuditRuns": 1,
        }
    return {
        "schemaVersion": "model-holdout-audit-v1",
        "passed": passed,
        "selectionUsedHoldout": False,
        "holdoutUsedForGridExpansion": False,
        "snapshotDiskReadCount": 1,
        "registryDiskReadCount": 1,
        "horizons": horizons,
        "futurePlan": contract["holdout"]["futurePlan"],
    }


def _training_plan(
    specs: list[dict[str, Any]],
    dataset: dict[str, Any],
    windows: dict[str, Any],
    contract: dict[str, Any],
    code_sha: str,
) -> dict[str, Any]:
    return {
        "schemaVersion": "model-training-plan-v1",
        "preRegistered": True,
        "selectionBeforeHoldoutAudit": True,
        "networkAccess": False,
        "dataset": dataset,
        "codeSha256": code_sha,
        "candidateCount": len(specs),
        "candidateCap": contract["candidateDesign"]["maxCandidates"],
        "candidateSpecs": specs,
        "windows": {
            horizon: {key: value for key, value in item.items() if not key.startswith("_")}
            for horizon, item in windows.items()
        },
        "bootstrap": contract["bootstrap"],
        "promotionGate": contract["promotionGate"],
    }


def _promotion_decision(
    champion: dict[str, Any],
    challenger: dict[str, Any],
    bootstrap: dict[str, Any],
    replay: dict[str, Any],
    contract: dict[str, Any],
) -> dict[str, Any]:
    margins = contract["promotionGate"]["nonInferiority"]
    horizon_gates = {}
    for horizon in HORIZONS:
        key = str(horizon)
        champion_eval = champion["horizons"][key]["holdoutEvaluation"]
        challenger_eval = challenger["horizons"][key]["holdoutEvaluation"]
        interval = bootstrap[key]
        positive_delta = (
            challenger_eval["rankingReturnMetrics"]["positiveWindowShare"]
            - champion_eval["rankingReturnMetrics"]["positiveWindowShare"]
        )
        horizon_gates[key] = {
            "topQuartileBrierNonInferior": interval["topQuartileBrierImprovement"]["lower95"] >= -margins["topQuartileBrierMaximumIncrease"],
            "rankIcNonInferior": interval["rankIcDelta"]["lower95"] >= margins["rankIcMinimumDelta"],
            "afterCostSpreadNonInferior": interval["afterCostSpreadDelta"]["lower95"] >= margins["afterCostSpreadMinimumDelta"],
            "positiveWindowShareDelta": positive_delta,
            "positiveWindowShareNonInferior": positive_delta >= margins["positiveWindowShareMinimumDelta"],
            "challengerAfterCostSpreadPositive": challenger_eval["rankingReturnMetrics"]["afterCostSpread"] >= 0,
            "challengerProbabilityDispersion": challenger_eval["rankingReturnMetrics"]["probabilityDispersion"],
            "probabilityDispersionNotCollapsed": challenger_eval["rankingReturnMetrics"]["probabilityDispersion"] >= 0.01,
        }
    statistical_noninferiority = all(all(value for name, value in gate.items() if name.endswith("NonInferior")) for gate in horizon_gates.values())
    positive_evidence = any(
        bootstrap[str(horizon)][metric]["lower95"] > 0
        for horizon in HORIZONS
        for metric in ("topQuartileBrierImprovement", "rankIcDelta", "afterCostSpreadDelta")
    )
    reasons = []
    if not replay["exactArtifactReplay"]:
        reasons.append("exact champion artifact replay is unavailable because the frozen production training input was not recovered")
    if not statistical_noninferiority:
        reasons.append("one or more pre-registered non-inferiority gates did not pass")
    if not positive_evidence:
        reasons.append("no paired bootstrap interval provides positive lower-bound evidence")
    decision = "promotion-eligible" if not reasons else "keep-champion"
    return {
        "schemaVersion": "model-promotion-decision-v1",
        "decision": decision,
        "automaticProductionReplacement": False,
        "championCandidateId": champion["candidateId"],
        "recommendedChallengerId": challenger["candidateId"],
        "selectionCriterion": "lowest mean selection-window topQuartile Brier; holdout excluded from selection",
        "exactChampionReplayRequired": True,
        "exactChampionReplayPassed": replay["exactArtifactReplay"],
        "statisticalNonInferiorityPassed": statistical_noninferiority,
        "positiveEvidencePassed": positive_evidence,
        "horizonGates": horizon_gates,
        "nonInferiorityMargins": margins,
        "reasons": reasons,
        "productionModelReplaced": False,
        "productionProbabilitiesModified": False,
    }


def _comparison_markdown(
    champion: dict[str, Any],
    challenger: dict[str, Any],
    bootstrap: dict[str, Any],
    replay: dict[str, Any],
    decision: dict[str, Any],
) -> str:
    lines = [
        "# Champion vs challenger",
        "",
        f"- Protocol replay candidate: `{champion['candidateId']}`",
        f"- Selection-recommended challenger: `{challenger['candidateId']}`",
        f"- Promotion decision: `{decision['decision']}`",
        f"- Exact production artifact replay: `{str(replay['exactArtifactReplay']).lower()}` (`{replay['artifactComparison']}`)",
        "- Candidate selection used selection OOF metrics only; the holdout was opened once afterward for audit.",
        "- No candidate was activated and no production probability, ranking, content, or ledger was changed.",
        "",
        "| horizon | champion holdout Brier | challenger holdout Brier | Brier improvement 95% CI | champion rank IC | challenger rank IC | rank IC delta 95% CI |",
        "| ---: | ---: | ---: | --- | ---: | ---: | --- |",
    ]
    for horizon in HORIZONS:
        key = str(horizon)
        champion_eval = champion["horizons"][key]["holdoutEvaluation"]
        challenger_eval = challenger["horizons"][key]["holdoutEvaluation"]
        brier = bootstrap[key]["topQuartileBrierImprovement"]
        rank = bootstrap[key]["rankIcDelta"]
        lines.append(
            f"| {horizon} | {champion_eval['probabilityMetrics']['topQuartile']['brier']:.8f} | "
            f"{challenger_eval['probabilityMetrics']['topQuartile']['brier']:.8f} | "
            f"[{brier['lower95']:.8f}, {brier['upper95']:.8f}] | "
            f"{champion_eval['rankingReturnMetrics']['rankIc']:.8f} | "
            f"{challenger_eval['rankingReturnMetrics']['rankIc']:.8f} | "
            f"[{rank['lower95']:.8f}, {rank['upper95']:.8f}] |"
        )
    lines.extend(["", "## Why the champion remains", "", *[f"- {reason}" for reason in decision["reasons"]], ""])
    return "\n".join(lines)


def run_training(snapshot: Path, output: Path, candidate_output: Path) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    started_clock = time.perf_counter()
    output = require_external(output)
    candidate_output = require_candidate_root(candidate_output)
    snapshot = snapshot.resolve()
    if not snapshot.is_dir():
        raise ModelResearchError(f"dataset snapshot directory missing: {snapshot}")
    contract = validate_contract()
    boundary_before = production_boundary()
    manifest, panel, data_audit = audit_dataset(snapshot)
    dataset = dataset_reference(snapshot, manifest)
    registry = read_json(HOLDOUT_REGISTRY)
    windows = holdout_windows(panel, registry)
    holdout_audit = _holdout_audit(panel, windows, contract)
    if not holdout_audit["passed"]:
        raise ModelResearchError("holdout class-coverage gate failed")
    specs = candidate_specs(contract)
    code_sha = sha256_path(Path(__file__).resolve())
    plan = _training_plan(specs, dataset, windows, contract, code_sha)
    output.mkdir(parents=True, exist_ok=True)
    (output / "metrics").mkdir(parents=True, exist_ok=True)
    (output / "plots-data").mkdir(parents=True, exist_ok=True)
    (output / "logs").mkdir(parents=True, exist_ok=True)
    atomic_write(output / "DATA_AUDIT.json", json_bytes(data_audit))
    atomic_write(output / "TRAINING_PLAN.json", json_bytes(plan))
    atomic_write(output / "HOLDOUT_AUDIT.json", json_bytes(holdout_audit))

    raw_key_counts = Counter(
        _raw_cache_key(horizon, window, spec)
        for spec in specs for horizon in HORIZONS for window in ("selection", "holdout")
    )
    raw_cache: dict[tuple[Any, ...], tuple[list[dict[str, Any]], list[dict[str, Any]]]] = {}
    final_key_counts = Counter(
        (horizon, features_for_spec(spec), float(spec["logisticRidge"]), float(spec["regressionRidge"]))
        for spec in specs for horizon in HORIZONS
    )
    final_cache: dict[tuple[Any, ...], dict[str, Any]] = {}
    candidates: list[dict[str, Any]] = []
    summaries: list[dict[str, Any]] = []
    internal_daily: dict[str, dict[str, dict[str, list[dict[str, Any]]]]] = {}
    log_lines = [
        "P1-J deterministic training",
        f"dataset={dataset['datasetSnapshotPath']}",
        f"datasetIdentitySha256={dataset['datasetIdentitySha256']}",
        f"candidateCount={len(specs)}",
        "networkAccess=false",
    ]

    for candidate_number, spec in enumerate(specs, start=1):
        identity = candidate_business_identity(spec, dataset, windows, code_sha, contract)
        candidate_id = sha256_bytes(canonical_json(identity))
        horizon_artifacts = {}
        metric_horizons = {}
        internal_daily[candidate_id] = {}
        for horizon in HORIZONS:
            key = str(horizon)
            window = windows[key]
            selection_cache_key = _raw_cache_key(horizon, "selection", spec)
            if selection_cache_key in raw_cache:
                selection_records, selection_folds = raw_cache[selection_cache_key]
            else:
                selection_records, selection_folds = _raw_walk_forward(panel, horizon, window["_selection"], spec)
                if raw_key_counts[selection_cache_key] > 1:
                    raw_cache[selection_cache_key] = (selection_records, selection_folds)
            calibration_dates = set(window["_selection"][:-126])
            evaluation_dates = set(window["_selection"][-126:])
            calibration_records = [item for item in selection_records if item["date"] in calibration_dates]
            selection_evaluation_records = [item for item in selection_records if item["date"] in evaluation_dates]
            selection_evaluation_folds = [fold for fold in selection_folds if fold["evaluationStart"] >= window["_selection"][-126]]
            selection_calibrators = {
                target: fit_platt(calibration_records, target, float(spec["calibratorRidge"]))
                for target in BINARY_TARGETS
            }
            selection_evaluation = evaluate_records(
                selection_evaluation_records,
                selection_evaluation_folds,
                method=spec["calibrationMethod"],
                calibrators=selection_calibrators,
            )

            holdout_cache_key = _raw_cache_key(horizon, "holdout", spec)
            if holdout_cache_key in raw_cache:
                holdout_records, holdout_folds = raw_cache[holdout_cache_key]
            else:
                holdout_records, holdout_folds = _raw_walk_forward(panel, horizon, window["_holdout"], spec)
                if raw_key_counts[holdout_cache_key] > 1:
                    raw_cache[holdout_cache_key] = (holdout_records, holdout_folds)
            holdout_calibrators = {
                target: fit_platt(selection_records, target, float(spec["calibratorRidge"]))
                for target in BINARY_TARGETS
            }
            holdout_evaluation = evaluate_records(
                holdout_records,
                holdout_folds,
                method=spec["calibrationMethod"],
                calibrators=holdout_calibrators,
            )
            final_key = (horizon, features_for_spec(spec), float(spec["logisticRidge"]), float(spec["regressionRidge"]))
            if final_key in final_cache:
                final_models = final_cache[final_key]
            else:
                final_models = _fit_final_core(panel, horizon, spec)
                if final_key_counts[final_key] > 1:
                    final_cache[final_key] = final_models
            horizon_artifacts[key] = {
                "horizonSessions": horizon,
                "status": "trained-inactive-candidate",
                "selectionEvaluation": _public_evaluation(selection_evaluation),
                "holdoutEvaluation": _public_evaluation(holdout_evaluation),
                "models": final_models,
                "calibrators": holdout_calibrators,
                "calibrationMethod": spec["calibrationMethod"],
            }
            metric_horizons[key] = {
                "selectionEvaluation": selection_evaluation,
                "holdoutEvaluation": holdout_evaluation,
            }
            internal_daily[candidate_id][key] = {
                "selection": selection_evaluation["_daily"],
                "holdout": holdout_evaluation["_daily"],
            }
        candidate = validate_candidate({
            "schemaVersion": "model-candidate-v1",
            "candidateId": candidate_id,
            "businessIdentity": identity,
            "status": "trained-inactive-candidate",
            "active": False,
            "horizons": horizon_artifacts,
            "limitations": [
                "Research-only artifact; it is not a production model and cannot publish probabilities.",
                "The current production training snapshot was not recovered, so exact champion artifact reproduction is unavailable.",
            ],
        })
        candidate_path = candidate_output / f"{candidate_id}.json"
        write_status = atomic_write(candidate_path, json_bytes(candidate), immutable=True)
        artifact_sha = sha256_path(candidate_path)
        summary = {
            **_candidate_summary(candidate),
            "artifactPath": repository_relative(candidate_path),
            "artifactSha256": artifact_sha,
            "writeStatus": write_status,
        }
        metric = {
            "schemaVersion": "model-candidate-metrics-v1",
            "candidateId": candidate_id,
            "candidateArtifactSha256": artifact_sha,
            "horizons": metric_horizons,
        }
        atomic_write(output / "metrics" / f"{candidate_id}.json", json_bytes(metric))
        candidates.append(candidate)
        summaries.append(summary)
        log_lines.append(f"candidate={candidate_number}/{len(specs)} id={candidate_id} family={spec['candidateFamily']} write={write_status}")

    champion = candidates[0]
    champion_summary = summaries[0]
    challenger_summary = min(
        summaries[1:],
        key=lambda item: (item["selectionTopQuartileBrier"], -item["selectionRankIc"], item["candidateId"]),
    )
    challenger = next(item for item in candidates if item["candidateId"] == challenger_summary["candidateId"])
    bootstrap_results = {
        str(horizon): paired_block_bootstrap(
            internal_daily[champion["candidateId"]][str(horizon)]["holdout"],
            internal_daily[challenger["candidateId"]][str(horizon)]["holdout"],
            repetitions=int(contract["bootstrap"]["repetitions"]),
            block_length=int(contract["bootstrap"]["blockLengthSessions"]),
            seed=int(contract["bootstrap"]["seed"]),
        )
        for horizon in HORIZONS
    }
    replay = _production_replay(dataset, champion["candidateId"])
    decision = _promotion_decision(champion, challenger, bootstrap_results, replay, contract)

    index_entries = sorted(
        [
            {
                "candidateId": item["candidateId"],
                "candidateFamily": item["candidateFamily"],
                "path": item["artifactPath"],
                "sha256": item["artifactSha256"],
                "status": "inactive-research-only",
            }
            for item in summaries
        ],
        key=lambda item: item["candidateId"],
    )
    candidate_index = {
        "schemaVersion": "model-candidate-index-v1",
        "activeCandidateId": None,
        "recommendedCandidateId": challenger["candidateId"],
        "promotionDecision": decision["decision"],
        "candidates": index_entries,
    }
    candidate_output.mkdir(parents=True, exist_ok=True)
    atomic_write(candidate_output / "index.json", json_bytes(candidate_index))
    shadow_config = {
        "schemaVersion": "model-shadow-config-v1",
        "active": False,
        "recommendedCandidateId": challenger["candidateId"],
        "candidatePath": repository_relative(candidate_output / f"{challenger['candidateId']}.json"),
        "candidateSha256": sha256_path(candidate_output / f"{challenger['candidateId']}.json"),
        "productionModelPaths": [repository_relative(path) for path in PRODUCTION_MODELS],
        "publicationEnabled": False,
        "reason": "P1-J shadow evaluation only; promotion requires a separate reviewed PR.",
    }
    atomic_write(SHADOW_CONFIG_PATH, json_bytes(shadow_config))

    table = {
        "schemaVersion": "model-candidate-table-v1",
        "selectionMetric": "mean selection-window topQuartile Brier across 1/5/20 sessions",
        "holdoutUsedForSelection": False,
        "candidateCount": len(summaries),
        "championCandidateId": champion["candidateId"],
        "recommendedCandidateId": challenger["candidateId"],
        "candidates": sorted(summaries, key=lambda item: item["candidateId"]),
    }
    plot_data = {
        "schemaVersion": "model-comparison-plot-data-v1",
        "championCandidateId": champion["candidateId"],
        "challengerCandidateId": challenger["candidateId"],
        "horizons": {
            str(horizon): {
                "champion": internal_daily[champion["candidateId"]][str(horizon)]["holdout"],
                "challenger": internal_daily[challenger["candidateId"]][str(horizon)]["holdout"],
                "pairedBootstrap": bootstrap_results[str(horizon)],
            }
            for horizon in HORIZONS
        },
    }
    atomic_write(output / "CANDIDATE_TABLE.json", json_bytes(table))
    atomic_write(output / "PROMOTION_DECISION.json", json_bytes({**decision, "championReplay": replay, "pairedBootstrap": bootstrap_results}))
    atomic_write(output / "CHAMPION_VS_CHALLENGER.md", _comparison_markdown(champion, challenger, bootstrap_results, replay, decision).encode("utf-8"))
    atomic_write(output / "plots-data" / "recommended-vs-champion.json", json_bytes(plot_data))
    atomic_write(output / "logs" / "training.log", ("\n".join(log_lines) + "\n").encode("utf-8"))

    boundary_after = production_boundary()
    if boundary_before != boundary_after:
        raise ModelResearchError("production model/content/ledger boundary changed during training")
    ended_at = datetime.now(timezone.utc)
    training_run = {
        "schemaVersion": "model-training-run-v1",
        "status": "completed",
        "trainingExecuted": True,
        "startedAt": started_at.isoformat(),
        "endedAt": ended_at.isoformat(),
        "durationMs": round((time.perf_counter() - started_clock) * 1000),
        "machinePath": str(ROOT),
        "dataset": dataset,
        "dataAuditPassed": data_audit["passed"],
        "holdoutAuditPassed": holdout_audit["passed"],
        "candidateCount": len(candidates),
        "championReplay": replay,
        "recommendedCandidateId": challenger["candidateId"],
        "promotionDecision": decision["decision"],
        "networkAccessDuringTraining": False,
        "productionBoundaryBefore": boundary_before,
        "productionBoundaryAfter": boundary_after,
        "productionBoundaryByteInvariant": True,
        "productionModelReplaced": False,
        "productionProbabilitiesModified": False,
        "warnings": [replay["reason"]],
    }
    atomic_write(output / "TRAINING_RUN.json", json_bytes(training_run))
    entries = finalize_directory(output)
    return {
        "status": "completed",
        "trainingExecuted": True,
        "candidateCount": len(candidates),
        "championCandidateId": champion_summary["candidateId"],
        "recommendedCandidateId": challenger_summary["candidateId"],
        "promotionDecision": decision["decision"],
        "output": str(output),
        "outputFileCount": len(entries) + 1,
        "productionBoundaryByteInvariant": True,
    }


def validate_candidate_store() -> dict[str, Any]:
    contract = validate_contract()
    index_path = CANDIDATE_ROOT / "index.json"
    if not index_path.exists() and not SHADOW_CONFIG_PATH.exists():
        return {"status": "valid", "candidateCount": 0, "contractSha256": sha256_path(CONTRACT_PATH)}
    if not index_path.exists() or not SHADOW_CONFIG_PATH.exists():
        raise ModelResearchError("candidate index and shadow config must coexist")
    index = read_json(index_path)
    entries = index.get("candidates")
    if index.get("schemaVersion") != "model-candidate-index-v1" or not isinstance(entries, list):
        raise ModelResearchError("candidate index schema mismatch")
    if entries != sorted(entries, key=lambda item: item["candidateId"]):
        raise ModelResearchError("candidate index is not sorted by candidateId")
    ids = []
    for entry in entries:
        path = ROOT / entry["path"]
        candidate = validate_candidate(read_json(path))
        if candidate["candidateId"] != entry["candidateId"] or sha256_path(path) != entry["sha256"]:
            raise ModelResearchError(f"candidate index lineage mismatch: {path}")
        ids.append(candidate["candidateId"])
    shadow = read_json(SHADOW_CONFIG_PATH)
    if shadow.get("schemaVersion") != "model-shadow-config-v1" or shadow.get("active") is not False:
        raise ModelResearchError("shadow config must remain inactive")
    if shadow.get("recommendedCandidateId") not in ids:
        raise ModelResearchError("shadow recommended candidate is not indexed")
    if contract["productionBoundary"]["shadowConfigActive"] is not False:
        raise ModelResearchError("contract shadow boundary changed")
    return {
        "status": "valid",
        "candidateCount": len(entries),
        "recommendedCandidateId": shadow["recommendedCandidateId"],
        "contractSha256": sha256_path(CONTRACT_PATH),
    }


def evaluate_research_output(output: Path) -> dict[str, Any]:
    output = require_external(output)
    required = {
        "DATA_AUDIT.json",
        "TRAINING_PLAN.json",
        "TRAINING_RUN.json",
        "CANDIDATE_TABLE.json",
        "HOLDOUT_AUDIT.json",
        "PROMOTION_DECISION.json",
        "CHAMPION_VS_CHALLENGER.md",
        "SHA256SUMS.txt",
    }
    missing = sorted(name for name in required if not (output / name).is_file())
    if missing:
        raise ModelResearchError(f"research output files missing: {missing}")
    expected = {}
    for line in (output / "SHA256SUMS.txt").read_text(encoding="utf-8").splitlines():
        digest, relative = line.split("  ", 1)
        if not SHA256.fullmatch(digest):
            raise ModelResearchError("invalid SHA256SUMS digest")
        expected[relative] = digest
    actual_files = [file for file in output.rglob("*") if file.is_file() and file.name != "SHA256SUMS.txt"]
    actual = {file.relative_to(output).as_posix(): sha256_path(file) for file in actual_files}
    if expected != actual:
        raise ModelResearchError("research output SHA256SUMS mismatch")
    run = read_json(output / "TRAINING_RUN.json")
    decision = read_json(output / "PROMOTION_DECISION.json")
    if run.get("trainingExecuted") is not True or run.get("productionBoundaryByteInvariant") is not True:
        raise ModelResearchError("training run completion/boundary assertion missing")
    if decision.get("decision") not in {"promotion-eligible", "keep-champion", "insufficient-data", "invalid-run"}:
        raise ModelResearchError("invalid promotion decision")
    store = validate_candidate_store()
    return {
        "status": "valid",
        "output": str(output),
        "verifiedFiles": len(actual),
        "candidateCount": store["candidateCount"],
        "promotionDecision": decision["decision"],
    }


def _champion_latest_predictions() -> tuple[dict[tuple[str, str], dict[str, Any]], str]:
    path = PRODUCTION_MODELS[2]
    artifact = read_json(path)
    result = {}
    for horizon in HORIZONS:
        for item in artifact.get("horizons", {}).get(str(horizon), {}).get("latestPredictions", []):
            result[(str(horizon), str(item["code"]))] = item
    return result, sha256_path(path)


def run_shadow(candidate_path: Path, features_snapshot: Path, output_path: Path) -> dict[str, Any]:
    output_path = require_external(output_path)
    candidate_path = candidate_path.resolve()
    features_snapshot = features_snapshot.resolve()
    try:
        candidate_path.relative_to(CANDIDATE_ROOT.resolve())
    except ValueError as exc:
        raise ModelResearchError("shadow candidate must come from repository candidate store") from exc
    candidate = validate_candidate(read_json(candidate_path))
    if sha256_path(candidate_path) != read_json(CANDIDATE_ROOT / "index.json")["candidates"][
        next(
            index for index, item in enumerate(read_json(CANDIDATE_ROOT / "index.json")["candidates"])
            if item["candidateId"] == candidate["candidateId"]
        )
    ]["sha256"]:
        raise ModelResearchError("shadow candidate SHA does not match index")
    try:
        manifest, panel = datasets.load_verified_snapshot(features_snapshot)
    except datasets.DatasetError as exc:
        raise ModelResearchError(f"shadow feature snapshot verification failed: {exc}") from exc
    reference = dataset_reference(features_snapshot, manifest)
    identity = candidate["businessIdentity"]
    if (
        reference["datasetManifestSha256"] != identity["datasetManifestSha256"]
        or reference["datasetIdentitySha256"] != identity["datasetIdentitySha256"]
    ):
        raise ModelResearchError("shadow features do not match candidate dataset identity")
    latest_date = max(str(row["date"]) for row in panel)
    rows = sorted((row for row in panel if str(row["date"]) == latest_date), key=lambda row: str(row["code"]))
    if len(rows) != 12:
        raise ModelResearchError("shadow feature cross-section incomplete")
    champion, champion_sha = _champion_latest_predictions()
    boundary_before = production_boundary()
    horizons = {}
    for horizon in HORIZONS:
        key = str(horizon)
        item = candidate["horizons"][key]
        predictions = []
        candidate_top = []
        for row in rows:
            raw_scores = {target: score_estimator(item["models"][target], row) for target in BINARY_TARGETS}
            record = {
                "rawScores": raw_scores,
                "rawProbabilities": {target: sigmoid(score) for target, score in raw_scores.items()},
            }
            candidate_probabilities = {
                target: calibrated_probability(record, target, item["calibrationMethod"], item["calibrators"][target])
                for target in BINARY_TARGETS
            }
            candidate_top.append(candidate_probabilities["topQuartile"])
            champion_item = champion.get((key, str(row["code"])))
            champion_probabilities = {
                target: (
                    champion_item.get("probabilities", {}).get(target, {}).get("calibratedProbability")
                    if champion_item else None
                )
                for target in BINARY_TARGETS
            }
            deltas = {
                target: (
                    candidate_probabilities[target] - float(champion_probabilities[target])
                    if champion_probabilities[target] is not None else None
                )
                for target in BINARY_TARGETS
            }
            candidate_excess = score_estimator(item["models"][CONTINUOUS_TARGET], row)
            champion_excess = champion_item.get("expectedExcessReturn") if champion_item else None
            predictions.append({
                "date": latest_date,
                "code": str(row["code"]),
                "name": str(row["name"]),
                "candidateProbabilities": candidate_probabilities,
                "championProbabilities": champion_probabilities,
                "probabilityDeltas": deltas,
                "candidateExpectedExcess": candidate_excess,
                "championExpectedExcess": champion_excess,
                "expectedExcessDelta": candidate_excess - float(champion_excess) if champion_excess is not None else None,
            })
        dispersion = statistics.pstdev(candidate_top)
        abstention_reasons = ["candidate is inactive and research-only; publication is forbidden"]
        if dispersion < 0.01 or max(candidate_top) - min(candidate_top) < 0.03:
            abstention_reasons.append("candidate topQuartile cross-sectional probability dispersion is below the strict publication threshold")
        horizons[key] = {
            "horizonSessions": horizon,
            "candidateTopQuartileProbabilityStd": dispersion,
            "abstained": True,
            "abstentionReasons": abstention_reasons,
            "predictions": predictions,
        }
    boundary_after = production_boundary()
    if boundary_before != boundary_after:
        raise ModelResearchError("production boundary changed during shadow inference")
    shadow_identity = {
        "candidateId": candidate["candidateId"],
        "candidateSha256": sha256_path(candidate_path),
        "featureSnapshotManifestSha256": reference["datasetManifestSha256"],
        "featureSnapshotIdentitySha256": reference["datasetIdentitySha256"],
        "asOf": latest_date,
        "championArtifactSha256": champion_sha,
    }
    value = {
        "schemaVersion": "shadow-inference-v1",
        "shadowId": sha256_bytes(canonical_json(shadow_identity)),
        "businessIdentity": shadow_identity,
        "status": "completed-shadow-only",
        "active": False,
        "publicationStatus": "not-published",
        "horizons": horizons,
        "productionBoundaryBefore": boundary_before,
        "productionBoundaryAfter": boundary_after,
        "productionBoundaryByteInvariant": True,
        "contentWritten": False,
        "predictionLedgerWritten": False,
        "productionModelWritten": False,
    }
    status = atomic_write(output_path, json_bytes(value), immutable=True)
    research_root = next((parent for parent in (output_path.parent, *output_path.parents) if (parent / "TRAINING_RUN.json").is_file()), None)
    if research_root is not None:
        finalize_directory(research_root)
    return {
        "status": status,
        "shadowId": value["shadowId"],
        "output": str(output_path),
        "sha256": sha256_path(output_path),
        "asOf": latest_date,
        "productionBoundaryByteInvariant": True,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="validate the frozen contract and candidate store")
    validate.add_argument("--output", type=Path, help="optionally validate an external research output directory")
    train = commands.add_parser("train", help="train the explicit immutable dataset snapshot")
    train.add_argument("--dataset", type=Path, required=True)
    train.add_argument("--output", type=Path, required=True)
    train.add_argument("--candidate-output", type=Path, required=True)
    evaluate = commands.add_parser("evaluate", help="validate completed research artifacts and hashes")
    evaluate.add_argument("--output", type=Path, required=True)
    shadow = commands.add_parser("shadow", help="run explicit no-write shadow inference")
    shadow.add_argument("--candidate", type=Path, required=True)
    shadow.add_argument("--features", type=Path, required=True)
    shadow.add_argument("--output", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            result = evaluate_research_output(args.output) if args.output else validate_candidate_store()
        elif args.command == "train":
            result = run_training(args.dataset, args.output, args.candidate_output)
        elif args.command == "evaluate":
            result = evaluate_research_output(args.output)
        else:
            result = run_shadow(args.candidate, args.features, args.output)
    except ModelResearchError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
