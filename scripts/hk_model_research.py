#!/usr/bin/env python3
"""Validate the Hong Kong research contract without touching production.

This module deliberately does not collect data or train a model.  It owns the
HK research boundary: the public four-object view, the larger training
universe, point-in-time and missing-value rules, leakage-safe price features,
and an explicit shadow report when no immutable HK panel is available.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_PATH = ROOT / "data" / "model-research" / "hk-contract.json"
SOURCE_REGISTRY_PATH = ROOT / "data" / "model-research" / "hk-source-registry-v1.json"
PUBLIC_UNIVERSE_PATH = ROOT / "models" / "sector-rotation" / "hk-public-universe-v1.json"
TRAINING_UNIVERSE_PATH = ROOT / "models" / "sector-rotation" / "hk-training-universe-v1.json"
HK_DATASET_ROOT = ROOT / "data" / "model-research" / "hk"
HK_PANEL_PATH = HK_DATASET_ROOT / "panel.csv.gz"

PRODUCTION_MODELS = (
    ROOT / "models" / "sector-rotation" / "a-share-v1.json",
    ROOT / "models" / "sector-rotation" / "a-share-up-probability-v1.json",
    ROOT / "models" / "sector-rotation" / "a-share-relative-probability-v2.json",
)
PRODUCTION_CONTENT = ROOT / "content"
PRODUCTION_LEDGER = ROOT / "data" / "prediction-ledger"

HORIZONS = (1, 5, 20)
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
PANEL_REQUIRED_COLUMNS = ("date", "objectId")
PANEL_HASH_BASIS = "raw-gzip-bytes-v1"
PUBLIC_IDS = ("hsi", "hstech", "hk_innovative_drug", "hk_tech_internet")
OFFICIAL_INDUSTRY_CODES = (
    "00011.01", "00011.02", "00011.03", "00011.06", "00011.07", "00011.08",
    "00011.09", "00011.10", "00011.11", "00011.12", "00011.13", "00011.14",
)
REQUIRED_METRICS = (
    "trainSampleCount", "oosWindowCount", "auc", "brier", "brierSkill", "rankIC",
    "topBottomSpread", "afterCostSpread", "predictionDispersion", "dataCompleteness",
    "regimePerformance", "rawProbabilityDistribution", "calibratedProbabilityDistribution",
    "featureMissingRates", "zeroVarianceFeatures", "providerFailures",
)


class HKModelResearchError(RuntimeError):
    """A deterministic HK research contract failure."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise HKModelResearchError(f"invalid JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise HKModelResearchError(f"JSON object required: {path}")
    return value


def sha256_path(path: Path) -> str:
    try:
        return sha256_bytes(path.read_bytes())
    except OSError as exc:
        raise HKModelResearchError(f"artifact missing: {path}") from exc


def sha256_canonical_json_path(path: Path) -> str:
    return sha256_bytes(canonical_json(read_json(path)))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise HKModelResearchError(message)


def _date(value: Any, label: str) -> str:
    _require(isinstance(value, str) and DATE_PATTERN.fullmatch(value) is not None, f"{label} must be YYYY-MM-DD")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as exc:
        raise HKModelResearchError(f"{label} must be a real calendar date") from exc
    _require(parsed.isoformat() == value, f"{label} must be a canonical calendar date")
    return value


def _finite_positive(value: Any, label: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise HKModelResearchError(f"{label} must be numeric or null") from exc
    _require(math.isfinite(parsed) and parsed > 0, f"{label} must be finite and positive")
    return parsed


def _validate_universe(contract: dict[str, Any], public: dict[str, Any], training: dict[str, Any]) -> None:
    public_objects = public.get("objects")
    _require(isinstance(public_objects, list), "public universe objects missing")
    _require(tuple(item.get("id") for item in public_objects) == PUBLIC_IDS, "public HK universe must be exactly the four frozen objects")
    _require(public.get("displayedObjectCount") == 4, "public HK universe count changed")
    _require(public.get("market") == "HK", "public HK universe market mismatch")

    training_objects = training.get("objects")
    _require(isinstance(training_objects, list), "training universe objects missing")
    official = [item for item in training_objects if item.get("kind") == "official_industry"]
    _require(len(official) == 12, "HK training universe must include exactly 12 official industries")
    _require(tuple(item.get("code") for item in official) == OFFICIAL_INDUSTRY_CODES, "official HK industry order/codes changed")
    _require(all(item.get("officialClassification") is True for item in official), "official industry classification flag missing")
    _require(all(item.get("doNotBackfillFromCurrentConstituents") is True for item in training_objects), "current constituent backfill policy relaxed")
    proxies = [item for item in training_objects if item.get("kind") == "theme_proxy"]
    _require(len(proxies) >= 2, "theme proxy training objects missing")
    _require(all(item.get("officialClassification") is False for item in proxies), "theme proxy cannot be labelled official HSICS history")
    _require({item.get("trainingObjectId") for item in public_objects} <= {item.get("id") for item in training_objects}, "public object is not mapped to training universe")
    _require(contract.get("publicTrainingSeparation", {}).get("publicMustNotRequireAllOfficialIndustries") is True, "public/training separation policy missing")


def validate_contract(contract: dict[str, Any] | None = None) -> dict[str, Any]:
    contract = contract or read_json(CONTRACT_PATH)
    _require(contract.get("schemaVersion") == "hk-model-research-contract-v1", "HK research contract version mismatch")
    _require(contract.get("market") == "HK", "HK research contract market mismatch")
    _require(contract.get("timezone") == "Asia/Shanghai", "HK research contract timezone mismatch")
    _require(contract.get("horizons") == list(HORIZONS), "HK research horizons must be [1, 5, 20]")
    _require(contract.get("publicUniversePath") == "models/sector-rotation/hk-public-universe-v1.json", "public universe path changed")
    _require(contract.get("trainingUniversePath") == "models/sector-rotation/hk-training-universe-v1.json", "training universe path changed")
    _require(contract.get("sourceRegistryPath") == "data/model-research/hk-source-registry-v1.json", "source registry path changed")

    public = read_json(PUBLIC_UNIVERSE_PATH)
    training = read_json(TRAINING_UNIVERSE_PATH)
    sources = read_json(SOURCE_REGISTRY_PATH)
    _validate_universe(contract, public, training)

    targets = contract.get("targets", {})
    _require(targets.get("index") == {"binary": ["absolute_up"], "continuous": ["expected_return"]}, "index target contract changed")
    _require(targets.get("theme") == {"binary": ["relative_outperformance_vs_hsi"], "continuous": ["expected_excess_vs_hsi"]}, "theme target contract changed")
    _require(targets.get("topQuartile", {}).get("role") == "research-only", "topQuartile cannot be a public HK theme target")
    _require(targets.get("topQuartile", {}).get("minimumCrossSection") == 4, "topQuartile minimum cross-section missing")

    feature_rows = contract.get("candidateFeatures")
    _require(isinstance(feature_rows, list) and feature_rows, "HK candidate features missing")
    _require(all(item.get("missingPolicy") == "preserve-null" for item in feature_rows), "HK features must preserve nulls")
    source_ids = {item.get("id") for item in sources.get("sources", [])}
    source_ids |= {item.get("id") for item in sources.get("providerFailures", [])}
    for item in feature_rows:
        _require(set(item.get("requiredSources", [])) <= source_ids, f"unknown feature source for {item.get('id')}")

    _require(contract.get("panelDesign", {}).get("independentHorizonTraining") is True, "HK horizons must train independently")
    _require(contract.get("panelDesign", {}).get("noRandomSplit") is True, "random split cannot enter HK validation")
    validation = contract.get("validation", {})
    _require(validation.get("protocol") == "walk-forward-purged-time-series-with-embargo", "HK validation protocol changed")
    _require(validation.get("purgeTargetDatesBeforeEvaluationStart") is True, "HK target purge missing")
    _require(validation.get("calibration") == "only-after-out-of-sample-discrimination", "HK calibration gate changed")
    _require(set(contract.get("requiredMetrics", [])) == set(REQUIRED_METRICS), "HK required metrics changed")

    candidates = contract.get("modelCandidates", [])
    _require({item.get("family") for item in candidates} == {"regularized-logistic-regression", "gradient-boosted-trees"}, "HK candidate model families changed")
    _require("neural-network" in contract.get("modelExclusions", []), "HK neural network exclusion missing")
    _require(all(value is False for value in contract.get("productionBoundary", {}).values()), "HK production boundary relaxed")
    return contract


def _history_map(history: Iterable[dict[str, Any]] | dict[str, Any], label: str) -> tuple[list[str], dict[str, float | None]]:
    if isinstance(history, dict):
        rows = [{"date": date, "close": close} for date, close in history.items()]
    else:
        rows = list(history)
    mapped: dict[str, float | None] = {}
    for row in rows:
        _require(isinstance(row, dict), f"{label} row must be an object")
        date = _date(row.get("date"), f"{label} date")
        _require(date not in mapped, f"duplicate {label} date: {date}")
        value = row.get("close")
        mapped[date] = _finite_positive(value, f"{label} close at {date}")
    dates = sorted(mapped)
    return dates, mapped


def _return_at(values: list[float | None], index: int, horizon: int) -> float | None:
    if index < horizon:
        return None
    current = values[index]
    previous = values[index - horizon]
    if current is None or previous is None:
        return None
    return current / previous - 1.0


def _mean_window(values: list[float | None], start: int, end: int) -> float | None:
    window = values[start : end + 1]
    if len(window) != end - start + 1 or any(value is None for value in window):
        return None
    return sum(value for value in window if value is not None) / len(window)


def _volatility20(values: list[float | None], index: int) -> float | None:
    if index < 20:
        return None
    returns: list[float] = []
    for position in range(index - 19, index + 1):
        current = values[position]
        previous = values[position - 1]
        if current is None or previous is None:
            return None
        returns.append(current / previous - 1.0)
    mean = sum(returns) / len(returns)
    return math.sqrt(sum((value - mean) ** 2 for value in returns) / len(returns))


def derive_price_features(
    history: Iterable[dict[str, Any]] | dict[str, Any],
    benchmark_history: Iterable[dict[str, Any]] | dict[str, Any],
) -> list[dict[str, Any]]:
    """Derive point-in-time features; missing source values remain null."""
    dates, object_values = _history_map(history, "object history")
    benchmark_dates, benchmark_values = _history_map(benchmark_history, "benchmark history")
    _require(dates == benchmark_dates, "object and HSI benchmark sessions must be aligned before feature derivation")
    values = [object_values[date] for date in dates]
    benchmark = [benchmark_values[date] for date in dates]
    output: list[dict[str, Any]] = []
    for index, date in enumerate(dates):
        row: dict[str, Any] = {"date": date}
        for horizon in (1, 5, 20):
            object_return = _return_at(values, index, horizon)
            benchmark_return = _return_at(benchmark, index, horizon)
            row[f"return_{horizon}"] = object_return
            row[f"relative_return_{horizon}"] = (
                object_return - benchmark_return
                if object_return is not None and benchmark_return is not None
                else None
            )
        row["volatility_20"] = _volatility20(values, index)
        for window in (20, 60):
            mean = _mean_window(values, index - window + 1, index) if index >= window - 1 else None
            current = values[index]
            row[f"distance_ma{window}"] = current / mean - 1.0 if current is not None and mean is not None else None
        output.append(row)
    return output


def _aggregate_directory(path: Path) -> str | None:
    if not path.exists():
        return None
    entries: list[dict[str, str]] = []
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        entries.append({"path": child.relative_to(ROOT).as_posix(), "sha256": sha256_path(child)})
    return sha256_bytes(canonical_json(entries))


def production_boundary() -> dict[str, Any]:
    return {
        "models": {path.relative_to(ROOT).as_posix(): sha256_path(path) for path in PRODUCTION_MODELS},
        "contentSha256": _aggregate_directory(PRODUCTION_CONTENT),
        "predictionLedgerSha256": _aggregate_directory(PRODUCTION_LEDGER),
    }


def _read_panel_bytes(panel_path: Path) -> bytes | None:
    if not panel_path.exists():
        return None
    try:
        return panel_path.read_bytes()
    except OSError as exc:
        raise HKModelResearchError(f"cannot read HK panel: {panel_path}") from exc


def panel_descriptor(panel_bytes: bytes | None) -> dict[str, Any]:
    """Validate immutable panel bytes and return a deterministic descriptor."""
    if panel_bytes is None:
        return {
            "status": "unavailable",
            "panelSha256": None,
            "panelHashBasis": PANEL_HASH_BASIS,
            "requiredColumns": list(PANEL_REQUIRED_COLUMNS),
            "history": {"sessions": 0, "rows": 0, "objects": 0, "firstDate": None, "lastDate": None},
        }

    panel_sha256 = sha256_bytes(panel_bytes)
    try:
        csv_bytes = gzip.decompress(panel_bytes)
    except (EOFError, gzip.BadGzipFile, OSError) as exc:
        raise HKModelResearchError("HK panel is not a readable gzip stream") from exc
    try:
        csv_text = csv_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise HKModelResearchError("HK panel CSV must be UTF-8") from exc

    reader = csv.DictReader(io.StringIO(csv_text, newline=""))
    fieldnames = reader.fieldnames or []
    _require(all(column in fieldnames for column in PANEL_REQUIRED_COLUMNS), "HK panel required columns are missing")
    rows = 0
    dates: set[str] = set()
    objects: set[str] = set()
    seen: set[tuple[str, str]] = set()
    try:
        for row in reader:
            rows += 1
            row_date = _date(row.get("date"), f"HK panel row {rows} date")
            object_id = row.get("objectId")
            _require(isinstance(object_id, str) and bool(object_id.strip()), f"HK panel row {rows} objectId is required")
            object_id = object_id.strip()
            key = (row_date, object_id)
            _require(key not in seen, f"duplicate HK panel row: {row_date}/{object_id}")
            seen.add(key)
            dates.add(row_date)
            objects.add(object_id)
    except csv.Error as exc:
        raise HKModelResearchError(f"invalid HK panel CSV: {exc}") from exc
    _require(rows > 0 and dates and objects, "HK panel exists but contains no usable rows")
    ordered_dates = sorted(dates)
    return {
        "status": "snapshot-present",
        "panelSha256": panel_sha256,
        "panelHashBasis": PANEL_HASH_BASIS,
        "requiredColumns": list(PANEL_REQUIRED_COLUMNS),
        "history": {
            "sessions": len(dates),
            "rows": rows,
            "objects": len(objects),
            "firstDate": ordered_dates[0],
            "lastDate": ordered_dates[-1],
        },
    }


def _research_contract_identity() -> tuple[str, dict[str, Any]]:
    contract = read_json(CONTRACT_PATH)
    components = {
        "market": "HK",
        "contractSha256": sha256_canonical_json_path(CONTRACT_PATH),
        "publicUniverseSha256": sha256_canonical_json_path(PUBLIC_UNIVERSE_PATH),
        "trainingUniverseSha256": sha256_canonical_json_path(TRAINING_UNIVERSE_PATH),
        "sourceRegistrySha256": sha256_canonical_json_path(SOURCE_REGISTRY_PATH),
        "featureContractVersion": contract["featureContractVersion"],
        "labelContractVersion": contract["labelContractVersion"],
    }
    contract_sha256 = sha256_bytes(canonical_json(components))
    return f"hk-research-contract-{contract_sha256[:12]}", components


def dataset_identity(panel_path: Path | None = None) -> dict[str, Any]:
    validate_contract()
    panel_path = panel_path or HK_PANEL_PATH
    research_contract_id, contract_components = _research_contract_identity()
    descriptor = panel_descriptor(_read_panel_bytes(panel_path))
    identity_components = {
        **contract_components,
        "researchContractId": research_contract_id,
        "panelSha256": descriptor["panelSha256"],
        "panelHashBasis": descriptor["panelHashBasis"],
        "snapshotStatus": descriptor["status"],
    }
    identity_sha = sha256_bytes(canonical_json(identity_components))
    return {
        "datasetId": f"hk-research-{identity_sha[:12]}" if descriptor["status"] == "snapshot-present" else None,
        "researchContractId": research_contract_id,
        "identitySha256": identity_sha,
        "identityComponents": identity_components,
    }


def _provider_failures() -> list[dict[str, Any]]:
    return read_json(SOURCE_REGISTRY_PATH).get("providerFailures", [])


def dataset_status(panel_path: Path | None = None) -> dict[str, Any]:
    panel_path = panel_path or HK_PANEL_PATH
    identity = dataset_identity(panel_path)
    descriptor = panel_descriptor(_read_panel_bytes(panel_path))
    return {
        "status": descriptor["status"],
        "history": descriptor["history"],
        "panelPath": str(panel_path.relative_to(ROOT)).replace("\\", "/") if panel_path.is_relative_to(ROOT) else "external-panel",
        "panelSha256": descriptor["panelSha256"],
        "panelHashBasis": descriptor["panelHashBasis"],
        "providerFailures": _provider_failures(),
        "datasetId": identity["datasetId"],
        "researchContractId": identity["researchContractId"],
        "identitySha256": identity["identitySha256"],
    }


def _empty_metrics(provider_failures: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "trainSampleCount": None,
        "oosWindowCount": None,
        "auc": None,
        "brier": None,
        "brierSkill": None,
        "rankIC": None,
        "topBottomSpread": None,
        "afterCostSpread": None,
        "predictionDispersion": None,
        "dataCompleteness": None,
        "regimePerformance": None,
        "rawProbabilityDistribution": None,
        "calibratedProbabilityDistribution": None,
        "featureMissingRates": None,
        "zeroVarianceFeatures": None,
        "providerFailures": provider_failures,
    }


def build_research_report() -> dict[str, Any]:
    contract = validate_contract()
    dataset = dataset_status()
    reason = "没有显式、可验证的港股历史面板；不训练、不输出默认概率，候选保持shadow。"
    horizons = {
        str(horizon): {
            "status": "insufficient-data",
            "targetFamily": "index-and-theme-contract",
            "metrics": _empty_metrics(dataset["providerFailures"]),
            "qualityGatePassed": False,
            "reason": reason,
            "validation": contract["validation"],
        }
        for horizon in HORIZONS
    }
    return {
        "schemaVersion": "hk-model-research-report-v1",
        "market": "HK",
        "candidateStatus": "shadow",
        "dataset": dataset,
        "horizons": horizons,
        "qualityGate": {
            "passed": False,
            "decision": "keep-shadow",
            "reasons": [reason, "每个预测周期都缺少训练样本和样本外窗口。"],
        },
        "productionApply": {
            "applied": False,
            "candidateActivation": False,
            "contentWritten": False,
            "predictionLedgerWritten": False,
            "productionModelWritten": False,
        },
        "productionBoundary": contract["productionBoundary"],
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("command", choices=["validate", "report"])
    return root


def configure_cli_stdio_utf8() -> None:
    """Use one explicit UTF-8 CLI path on Windows, Linux and CI."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="strict")


def main() -> None:
    configure_cli_stdio_utf8()
    args = parser().parse_args()
    before = production_boundary()
    contract = validate_contract()
    report = build_research_report()
    after = production_boundary()
    _require(before == after, "HK research changed a production boundary")
    output = {
        "status": "valid",
        "market": "HK",
        "contract": contract["schemaVersion"],
        "candidateStatus": report["candidateStatus"],
        "dataset": report["dataset"],
        "horizons": report["horizons"],
        "qualityGate": report["qualityGate"],
        "productionApply": report["productionApply"],
        "productionBoundaryByteInvariant": True,
    }
    print(json.dumps(output if args.command == "validate" else report, ensure_ascii=False, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
