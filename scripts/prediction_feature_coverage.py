#!/usr/bin/env python3
"""Frozen A-share feature-coverage contract v2 and model-lineage verifier.

This module deliberately does not train, score, calibrate or alter the frozen
model.  It separates model use from independently collected production signals.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
CONTRACT_VERSION = "prediction-feature-coverage-v2"
MODEL_PATH = ROOT / "models" / "sector-rotation" / "a-share-relative-probability-v2.json"
LINEAGE_PATH = ROOT / "models" / "sector-rotation" / "a-share-relative-probability-v2.lineage.json"
DATASET_ROOT = ROOT / "models" / "sector-rotation" / "datasets" / "a-share"
GROUP_WEIGHTS = {
    "priceRelativeStrength": 0.25,
    "turnoverAndVolume": 0.25,
    "marketBreadth": 0.20,
    "etfAndInstitutionFlow": 0.20,
    "policyAndEventMapping": 0.10,
}
MODEL_GROUPS = {"priceRelativeStrength", "turnoverAndVolume"}


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def finite_ratio(value: Any, default: float = 0.0) -> float:
    try:
        ratio = float(value)
    except (TypeError, ValueError):
        return default
    return ratio if math.isfinite(ratio) and 0.0 <= ratio <= 1.0 else default


def build_coverage_contract(
    *,
    expected_model_inputs: int,
    available_model_inputs: int,
    price_relative_strength_health: float,
    turnover_and_volume_health: float,
    market_breadth_summary: dict[str, Any] | None,
) -> dict[str, Any]:
    """Build the v2 contract from current-run facts only.

    Market breadth contributes to production and provider health only.  It is
    excluded from the frozen model and training-ready measures until an approved
    point-in-time historical contract exists.
    """
    if expected_model_inputs <= 0 or not 0 <= available_model_inputs <= expected_model_inputs:
        raise ValueError("invalid model input counts")
    breadth = market_breadth_summary or {}
    breadth_coverage = finite_ratio(breadth.get("groupCoverage"))
    breadth_status = str(breadth.get("status") or "unavailable")
    if breadth_status not in {"ready", "partial", "stale", "unavailable"}:
        breadth_status = "unavailable"
    group_health = {
        "priceRelativeStrength": finite_ratio(price_relative_strength_health),
        "turnoverAndVolume": finite_ratio(turnover_and_volume_health),
        "marketBreadth": breadth_coverage,
        "etfAndInstitutionFlow": 0.0,
        "policyAndEventMapping": 0.0,
    }
    model_feature_coverage = sum(GROUP_WEIGHTS[group] for group in MODEL_GROUPS)
    production_signal_coverage = (
        GROUP_WEIGHTS["priceRelativeStrength"] * group_health["priceRelativeStrength"]
        + GROUP_WEIGHTS["turnoverAndVolume"] * group_health["turnoverAndVolume"]
        + GROUP_WEIGHTS["marketBreadth"] * group_health["marketBreadth"]
    )
    provider_health_coverage = sum(GROUP_WEIGHTS[group] * group_health[group] for group in GROUP_WEIGHTS)
    groups = {
        "priceRelativeStrength": {
            "weight": GROUP_WEIGHTS["priceRelativeStrength"],
            "modelRequired": True,
            "trainingReady": True,
            "productionStatus": "ready" if group_health["priceRelativeStrength"] == 1 else "partial",
            "providerHealth": group_health["priceRelativeStrength"],
        },
        "turnoverAndVolume": {
            "weight": GROUP_WEIGHTS["turnoverAndVolume"],
            "modelRequired": True,
            "trainingReady": True,
            "productionStatus": "ready" if group_health["turnoverAndVolume"] == 1 else "partial",
            "providerHealth": group_health["turnoverAndVolume"],
        },
        "marketBreadth": {
            "weight": GROUP_WEIGHTS["marketBreadth"],
            "modelRequired": False,
            "trainingReady": False,
            "productionStatus": breadth_status,
            "productionGroupCoverage": group_health["marketBreadth"],
            "providerHealth": group_health["marketBreadth"],
            "reason": "point-in-time history begins with immutable forward snapshots in P1-D",
        },
        "etfAndInstitutionFlow": {
            "weight": GROUP_WEIGHTS["etfAndInstitutionFlow"],
            "modelRequired": False,
            "trainingReady": False,
            "productionStatus": "not_implemented",
            "providerHealth": 0.0,
        },
        "policyAndEventMapping": {
            "weight": GROUP_WEIGHTS["policyAndEventMapping"],
            "modelRequired": False,
            "trainingReady": False,
            "productionStatus": "not_implemented",
            "providerHealth": 0.0,
        },
    }
    contract = {
        "coverageContractVersion": CONTRACT_VERSION,
        "modelInputCompleteness": available_model_inputs / expected_model_inputs,
        "modelInputCount": {"available": available_model_inputs, "required": expected_model_inputs},
        "modelFeatureCoverage": model_feature_coverage,
        "productionSignalCoverage": production_signal_coverage,
        "trainingReadyCoverage": model_feature_coverage,
        "providerHealthCoverage": provider_health_coverage,
        "productionFeatureCoverage": model_feature_coverage,
        "deprecatedAliasOf": "modelFeatureCoverage",
        "groups": groups,
    }
    validate_coverage_contract(contract)
    return contract


def validate_coverage_contract(contract: dict[str, Any]) -> None:
    if contract.get("coverageContractVersion") != CONTRACT_VERSION:
        raise ValueError("unsupported coverage contract version")
    for key in (
        "modelInputCompleteness",
        "modelFeatureCoverage",
        "productionSignalCoverage",
        "trainingReadyCoverage",
        "providerHealthCoverage",
        "productionFeatureCoverage",
    ):
        if not 0.0 <= finite_ratio(contract.get(key), default=-1.0) <= 1.0:
            raise ValueError(f"invalid {key}")
    if contract["productionFeatureCoverage"] != contract["modelFeatureCoverage"]:
        raise ValueError("deprecated productionFeatureCoverage must alias modelFeatureCoverage")
    if contract.get("deprecatedAliasOf") != "modelFeatureCoverage":
        raise ValueError("deprecated alias target changed")
    if contract["modelFeatureCoverage"] != 0.50:
        raise ValueError("frozen model feature coverage must remain 0.50")
    if contract["trainingReadyCoverage"] != 0.50:
        raise ValueError("market breadth cannot increase training-ready coverage without point-in-time history")
    if contract["productionSignalCoverage"] > 0.70 + 1e-12:
        raise ValueError("market breadth cannot raise production signal coverage above 0.70 in v1")


def verify_lineage(root: Path = ROOT, lineage_path: Path | None = None) -> dict[str, Any]:
    lineage_path = lineage_path or root / LINEAGE_PATH.relative_to(ROOT)
    lineage = read_json(lineage_path)
    required = {
        "schemaVersion", "modelVersion", "modelPath", "modelSha256", "datasetId",
        "datasetManifestSha256", "featureContractVersion", "labelContractVersion",
        "benchmarkContractVersion", "associationBasis", "trainedFromCommit", "status",
    }
    if set(lineage) != required or lineage.get("schemaVersion") != 1:
        raise ValueError("model lineage sidecar fields do not match schemaVersion 1")
    if lineage["status"] != "production" or lineage["associationBasis"] != "repository-baseline-and-dataset-manifest":
        raise ValueError("invalid production lineage association")
    model_path = root / str(lineage["modelPath"])
    if not model_path.is_file() or sha256_file(model_path) != lineage["modelSha256"]:
        raise ValueError("production model SHA-256 does not match lineage sidecar")
    model = read_json(model_path)
    if model.get("version") != lineage["modelVersion"]:
        raise ValueError("model version does not match lineage sidecar")
    manifest_path = root / "models" / "sector-rotation" / "datasets" / "a-share" / str(lineage["datasetId"]) / "manifest.json"
    if not manifest_path.is_file() or sha256_file(manifest_path) != lineage["datasetManifestSha256"]:
        raise ValueError("dataset manifest SHA-256 does not match lineage sidecar")
    manifest = read_json(manifest_path)
    if manifest.get("datasetId") != lineage["datasetId"]:
        raise ValueError("datasetId does not match dataset manifest")
    contracts = manifest.get("contracts", {})
    expected = {
        "features": lineage["featureContractVersion"],
        "labels": lineage["labelContractVersion"],
        "benchmark": lineage["benchmarkContractVersion"],
    }
    if any(contracts.get(key) != value for key, value in expected.items()):
        raise ValueError("dataset contract versions do not match lineage sidecar")
    return {
        "ok": True,
        "sidecar": str(lineage_path.relative_to(root)).replace("\\", "/"),
        "modelSha256": lineage["modelSha256"],
        "datasetId": lineage["datasetId"],
        "datasetManifestSha256": lineage["datasetManifestSha256"],
        "featureContractVersion": lineage["featureContractVersion"],
        "labelContractVersion": lineage["labelContractVersion"],
        "benchmarkContractVersion": lineage["benchmarkContractVersion"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify-lineage", help="verify immutable production model lineage sidecar")
    verify.add_argument("--root", type=Path, default=ROOT)
    args = parser.parse_args()
    if args.command == "verify-lineage":
        print(json.dumps(verify_lineage(args.root), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
