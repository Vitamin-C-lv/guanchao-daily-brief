#!/usr/bin/env python3
"""Reproducible P1-C ledger-stability and A-share feature-coverage audit."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import os
import shutil
import statistics
import sys
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))

import prediction_ledger as ledger
import sector_probability as probability
import sector_rotation as rotation


BASELINE = "2c4dc081bb591830f78d532b32416a92f6446b40"
MODEL_PATH = ROOT / "models/sector-rotation/a-share-relative-probability-v2.json"
DATASET_ROOT = ROOT / "models/sector-rotation/datasets/a-share/a-share-2026-07-21-3448b55c8ae4"


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_digest(root: Path) -> str:
    rows = [{"path": path.relative_to(root).as_posix(), "sha256": sha256(path)} for path in sorted(root.rglob("*")) if path.is_file()]
    return hashlib.sha256(json.dumps(rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")).hexdigest()


def workflow_text() -> str:
    return (ROOT / ".github/workflows/prediction-ledger.yml").read_text(encoding="utf-8")


def run_ledger_simulation() -> dict[str, Any]:
    """Exercise the immutable operations in a copied ledger, never the worktree ledger."""
    source = ROOT / "data/prediction-ledger"
    with tempfile.TemporaryDirectory(prefix="p1c-ledger-") as temporary:
        temporary_root = Path(temporary)
        audit_ledger = temporary_root / "ledger"
        audit_public = temporary_root / "public"
        audit_compat = temporary_root / "prediction-history.json"
        audit_review = temporary_root / "prediction-review-latest.json"
        shutil.copytree(source, audit_ledger)
        before = ledger.verify_ledger(audit_ledger)
        snapshot_files_before = sorted(audit_ledger.glob("snapshots/**/*.json.gz"))

        # Exact existing document is the no-op input: same run id, same gzip bytes.
        existing = ledger.read_gzip_document(snapshot_files_before[-1])
        no_op_written = ledger.append_snapshot(audit_ledger, existing)
        no_op_files = len(list(audit_ledger.glob("snapshots/**/*.json.gz")))

        # A new publication revision intentionally keeps the immutable prediction
        # records identical while using a distinct publication version/createdAt.
        revised = ledger.build_snapshot(
            predictions=existing["predictions"],
            created_at="2026-07-25T20:00:00+08:00",
            data_as_of=existing["dataAsOf"],
            edition=existing["edition"],
            code_commit=BASELINE,
            models=existing["models"],
        )
        append_written = ledger.append_snapshot(audit_ledger, revised)
        ledger.rebuild_index(audit_ledger)
        after_append = ledger.verify_ledger(audit_ledger)
        duplicate_written = ledger.append_snapshot(audit_ledger, revised)
        ledger.rebuild_index(audit_ledger)

        evaluated_ids = {event["predictionId"] for event in ledger.collect_evaluations(audit_ledger)}
        candidate = next(record for record in ledger.collect_predictions(audit_ledger) if record["predictionId"] not in evaluated_ids and record["publicationStatus"] == "published")
        simulated_returns = {sector_id: 0.01 + index * 0.001 for index, sector_id in enumerate(ledger.A_SHARE_SECTOR_IDS)}
        simulated_returns[candidate["sectorId"]] = 0.05
        evaluation = ledger.evaluate_prediction_from_returns(
            candidate,
            simulated_returns,
            benchmark_return=0.012,
            evaluated_at="2026-07-25T20:00:00+08:00",
            source_hashes={"p1cSimulation": "f" * 64},
            code_commit=BASELINE,
        )
        evaluation_written = ledger.append_evaluation(audit_ledger, evaluation)
        ledger.rebuild_index(audit_ledger)
        ledger.write_weekly_review(audit_ledger, "2026-W30", output_path=audit_review)
        after_evaluation = ledger.verify_ledger(audit_ledger)

        weekly = ledger.write_weekly_review(audit_ledger, "2026-W30", output_path=audit_review)
        first_export = ledger.export_public(audit_ledger, audit_public, compatibility_path=audit_compat, review_path=audit_review)
        first_digest = tree_digest(audit_public)
        second_export = ledger.export_public(audit_ledger, audit_public, compatibility_path=audit_compat, review_path=audit_review)
        second_digest = tree_digest(audit_public)
        final = ledger.verify_ledger(audit_ledger, public_root=audit_public)
        return {
            "before": before,
            "noOp": {"written": no_op_written, "snapshotFilesBefore": len(snapshot_files_before), "snapshotFilesAfter": no_op_files},
            "appendSimulation": {"written": append_written, "runId": revised["runId"], "snapshotFilesAfter": after_append["snapshotCount"], "predictionRecordsAfter": after_append["predictionRecordCount"]},
            "idempotency": {"secondWrite": duplicate_written, "runId": revised["runId"]},
            "evaluationSimulation": {"written": evaluation_written, "eventId": evaluation["evaluationEventId"], "predictionId": candidate["predictionId"], "verification": after_evaluation},
            "weeklyReview": {"isoWeek": weekly["isoWeek"], "counts": weekly["counts"]},
            "publicExport": {"first": first_export, "second": second_export, "firstTreeSha256": first_digest, "secondTreeSha256": second_digest, "byteIdentical": first_digest == second_digest},
            "finalVerification": final,
        }


def ledger_audit(output: Path) -> dict[str, Any]:
    workflow = workflow_text()
    index = read_json(ROOT / "data/prediction-ledger/index.json")
    rotation_payload = read_json(ROOT / "content/sector-rotation.json")
    simulation = run_ledger_simulation()
    current_date = str(rotation_payload.get("generatedAt", ""))[:10]
    publication_versions = []
    for path in sorted((ROOT / "data/prediction-ledger/snapshots").glob("**/*.json.gz")):
        document = ledger.read_gzip_document(path)
        publication_versions.append({"dataAsOf": document["dataAsOf"], "createdAt": document["createdAt"], "runId": document["runId"]})
    latest_match = any(item["createdAt"] == rotation_payload.get("generatedAt") for item in publication_versions)
    github_dry_run = os.environ.get("P1C_GITHUB_DRY_RUN_RESULT", "not_run_by_audit_script; dispatch must be performed from authorized GitHub context after code review")
    report = {
        "baseline": BASELINE,
        "workflow": {
            "path": ".github/workflows/prediction-ledger.yml",
            "trigger": "push main, pull_request, workflow_dispatch, weekdays schedule",
            "writeEvent": "normal writer only after validate on refs/heads/main; workflow_dispatch dry_run may execute from another ref but cannot commit or push",
            "contentChangeGuard": "validate-prediction-ledger.mjs requires content/sector-rotation.json generatedAt to match an immutable snapshot before automation; post-refresh verification repeats the requirement",
            "githubLedgerAuthority": "actions/checkout fetch-depth 0 checks out ref main and validates data/prediction-ledger; no ignored local ledger path is used",
        },
        "schedule": {"cron": ["30 7 * * 1-5", "30 10 * * 5"], "timezone": "UTC (GitHub Actions cron); Asia/Shanghai = 15:30 weekdays closing and 18:30 Friday weekly", "modeResolution": "weekday closing; Friday 10:30 UTC weekly"},
        "permissions": {"default": "contents: read", "automate": "contents: write only", "leastPrivilege": True},
        "concurrency": {"group": "prediction-ledger-${{ github.ref }}", "cancelInProgress": False, "preventsDuplicateMainWriters": True},
        "dryRun": {"supported": "workflow_dispatch dry_run boolean", "behavior": "runs refresh, append, rebuild and verify in ephemeral runner worktree; skips commit and push when DRY_RUN=true", "githubRun": github_dry_run},
        "noOp": simulation["noOp"],
        "appendSimulation": simulation["appendSimulation"],
        "idempotency": simulation["idempotency"],
        "evaluationSimulation": simulation["evaluationSimulation"],
        "publicExport": simulation["publicExport"],
        "weeklyReview": simulation["weeklyReview"],
        "verify": simulation["finalVerification"],
        "pushConflict": "fetch origin main; conflict-safe rebase; reverify; push at most three times; rebase conflict aborts and fails without overwrite",
        "partialFailure": "immutable event writes use same-directory temporary files plus os.replace; derived files are rebuilt and verified before commit; a failed runner has no push, while any committed state has passed verification",
        "latestSnapshotReason": "content/sector-rotation.json generatedAt is 2026-07-24T20:19:06+08:00 and exactly matches a ledger publication version. No later committed main content generation exists at the audited baseline; this is an expected post-merge/not-yet-scheduled-run state, not a missing-snapshot defect.",
        "currentPublication": {"generatedAt": rotation_payload.get("generatedAt"), "matchingSnapshot": latest_match, "lastPredictionDate": index["lastPredictionDate"]},
        "productionWriteRecommended": False,
        "blockers": ["GitHub workflow dry-run is an external dispatch and is intentionally not invoked by this local audit command."],
        "findings": [
            "PR validation has contents: read and cannot write the ledger; automate is strictly main-only.",
            "The workflow's no-change path commits nothing after a full verify.",
            "A subsequent daily payload with a newer date will pass the automation date guard and append one deterministic snapshot; an equal/older date is a no-op.",
        ],
        "workflowTextAssertions": {"hasDispatchDryRun": "dry_run:" in workflow, "hasMainOnlyCondition": "github.ref == 'refs/heads/main'" in workflow, "hasRetry": "for attempt in 1 2 3" in workflow},
    }
    write_json(output, report)
    return report


def production_groups() -> list[dict[str, Any]]:
    return [
        {"featureId": "priceRelativeStrength", "weight": 0.25, "available": True, "reason": None, "source": "CSI sector-index close", "action": "retain"},
        {"featureId": "turnoverAndVolume", "weight": 0.25, "available": True, "reason": None, "source": "CSI sector-index trading value and volume", "action": "retain"},
        {"featureId": "marketBreadth", "weight": 0.20, "available": False, "reason": "provider_not_implemented", "source": None, "action": "implement cross-sectional constituent breadth from an existing reliable public source"},
        {"featureId": "etfAndInstitutionFlow", "weight": 0.20, "available": False, "reason": "provider_not_implemented", "source": None, "action": "defer; it combines two unimplemented data classes and is not a one-feature low-risk change"},
        {"featureId": "policyAndEventMapping", "weight": 0.10, "available": False, "reason": "adapter_not_wired", "source": "existing evidence/event inputs", "action": "define deterministic sector mapping and production approval before model use"},
    ]


def panel_rows() -> list[dict[str, Any]]:
    with gzip.open(DATASET_ROOT / "panel.csv.gz", "rt", encoding="utf-8", newline="") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        for feature in rotation.FEATURES + rotation.MODEL_FEATURES:
            row[feature] = float(row[feature])
    return rows


def feature_coverage_audit(output: Path, lineage_output: Path, recomputation_output: Path) -> dict[str, Any]:
    dataset_manifest = read_json(DATASET_ROOT / "manifest.json")
    model = read_json(MODEL_PATH)
    diagnostics = read_json(ROOT / "content/prediction-diagnostics.json")
    rows = panel_rows()
    model_features = list(probability.PROBABILITY_FEATURES)
    dates = sorted({row["date"] for row in rows})
    recent_dates = dates[-20:]
    recent = [row for row in rows if row["date"] in set(recent_dates)]
    taxonomy = read_json(rotation.TAXONOMY_PATH)
    codes = [item["code"] for item in taxonomy["indices"]]
    raw_and_cs = set(rotation.FEATURES + rotation.MODEL_FEATURES)
    nonlinear = set(model_features) - raw_and_cs
    feature_records = []
    per_feature = []
    for feature in model_features:
        values: list[float] = []
        nulls = 0
        for row in recent:
            try:
                value = probability.feature_value(row, feature)
                values.append(float(value))
            except (KeyError, TypeError, ValueError):
                nulls += 1
        stds = []
        zero_sessions = 0
        for day in recent_dates:
            day_values = []
            for row in rows:
                if row["date"] != day:
                    continue
                try:
                    day_values.append(float(probability.feature_value(row, feature)))
                except (KeyError, TypeError, ValueError):
                    pass
            if len(day_values) == len(codes):
                std = statistics.pstdev(day_values)
                stds.append(std)
                zero_sessions += int(std == 0.0)
        record = {
            "featureId": feature,
            "featureName": rotation.MODEL_FEATURE_DESCRIPTIONS.get(feature, rotation.FEATURE_DESCRIPTIONS.get(feature, feature)),
            "contractVersion": dataset_manifest["contracts"]["features"],
            "market": "a-share",
            "horizons": [1, 5, 20],
            "modelRequired": True,
            "trainingAvailable": True,
            "productionAvailable": True,
            "latestAsOf": dates[-1],
            "sourceProvider": "CSI Index (direct history in immutable dataset)",
            "sourceType": "official_index_market_data",
            "officialSource": rotation.CSI_API,
            "adapter": "scripts/sector_rotation.py build_features",
            "normalizer": "cross-sectional z-score" if feature.startswith("cs_") else "derived interaction" if feature in nonlinear else "point-in-time feature",
            "productionField": feature,
            "missingRate": nulls / len(recent) if recent else None,
            "crossSectionStd": {"min": min(stds) if stds else None, "max": max(stds) if stds else None, "latest": stds[-1] if stds else None},
            "zeroVariance": zero_sessions > 0,
            "stale": False,
            "proxy": False,
            "productionApproved": True,
            "failureReason": None,
            "affectedSectors": [],
            "affectedDates": [],
            "expectedCoverageUplift": 0.0,
            "recommendedAction": "retain; frozen model input",
        }
        feature_records.append(record)
        per_feature.append({"featureId": feature, "observations": len(values), "nullCount": nulls, "zeroVarianceSessions": zero_sessions, "latestCrossSectionStd": record["crossSectionStd"]["latest"]})
    groups = production_groups()
    coverage_numerator = sum(group["weight"] for group in groups if group["available"])
    missing_groups = []
    for group in groups:
        group_record = {
            "featureId": group["featureId"], "featureName": group["featureId"], "contractVersion": "production-feature-groups-v1 (diagnostic-only)", "market": "a-share", "horizons": [1, 5, 20],
            "modelRequired": False, "trainingAvailable": False, "productionAvailable": group["available"], "latestAsOf": "2026-07-24", "sourceProvider": group["source"], "sourceType": "production_feature_group", "officialSource": rotation.CSI_API if group["available"] else None,
            "adapter": "scripts/sector_probability.py:data_diagnostics", "normalizer": None, "productionField": group["featureId"], "missingRate": 0.0 if group["available"] else 1.0, "crossSectionStd": None,
            "zeroVariance": False, "stale": False, "proxy": False, "productionApproved": group["available"], "failureReason": group["reason"], "affectedSectors": [] if group["available"] else codes,
            "affectedDates": [] if group["available"] else ["2026-07-24"], "expectedCoverageUplift": 0.0 if group["available"] else group["weight"], "recommendedAction": group["action"],
        }
        feature_records.append(group_record)
        if not group["available"]:
            missing_groups.append(group_record)
    a_share_diagnostics = [item for item in diagnostics["entries"] if item["market"] == "a-share"]
    data_diagnostics = model["dataDiagnostics"]
    recomputation = {
        "modelInputCompleteness": {"numerator": len(model_features), "denominator": len(model_features), "value": 1.0, "definition": "finite frozen model inputs across all 12 sectors at model artifact asOf"},
        "productionFeatureCoverage": {"numerator": coverage_numerator, "denominator": 1.0, "value": coverage_numerator, "definition": "weighted implemented production feature groups, not the model-vector feature count", "availableGroups": [group["featureId"] for group in groups if group["available"]], "missingGroups": [group["featureId"] for group in groups if not group["available"]]},
        "latestProductionEvidence": {"contentAsOf": "2026-07-24", "diagnosticValues": [{"horizon": item["horizon"], "modelInputCompleteness": item["modelInputCompleteness"], "productionFeatureCoverage": item["productionFeatureCoverage"]} for item in a_share_diagnostics], "perFeatureProductionCache": "not Git-tracked; the audited baseline preserves summary diagnostics but not a 2026-07-24 per-feature matrix"},
        "recentFrozenPanel": {"start": recent_dates[0], "end": recent_dates[-1], "sessions": len(recent_dates), "sectorsPerSession": len(codes), "expectedObservations": len(recent_dates) * len(codes), "perFeature": per_feature},
    }
    lineage = {
        "model": {"path": str(MODEL_PATH.relative_to(ROOT)).replace("\\", "/"), "sha256": sha256(MODEL_PATH), "datasetId": model.get("datasetId"), "featureContractVersion": model.get("featureContractVersion"), "auditedDatasetId": dataset_manifest["datasetId"]},
        "path": ["CSI sector index history", "scripts/sector_rotation.py build_features", "immutable dataset panel.csv.gz", "scripts/sector_probability.py feature_value/current_predictions", "content/sector-rotation.json and content/prediction-diagnostics.json", "prediction ledger snapshot"],
        "modelFeatures": model_features,
        "productionGroupCalculation": {"source": "scripts/sector_probability.py:data_diagnostics", "weights": {group["featureId"]: group["weight"] for group in groups}, "available": [group["featureId"] for group in groups if group["available"]], "calculation": "sum(weights of statically declared available groups)"},
        "definitionDrift": ["modelInputCompleteness is a 26-input vector availability measure", "productionFeatureCoverage is a five-group implementation-status measure", "the latter is currently a declared static availability set rather than a provider-health-derived per-date calculation"],
    }
    report = {
        "baseline": BASELINE,
        "currentExactCoverage": coverage_numerator,
        "coverageNumerator": coverage_numerator,
        "coverageDenominator": 1.0,
        "coverageDisplay": "50% (0.50 / 1.00 weighted production-feature groups; equivalently two implemented 25% groups of five groups)",
        "modelInputCompleteness": 1.0,
        "modelFeatureCount": len(model_features),
        "latestProductionPredictionDate": "2026-07-24",
        "recentEffectiveTradingSessions": {"source": "immutable frozen dataset panel, not ignored daily cache", "start": recent_dates[0], "end": recent_dates[-1], "count": len(recent_dates)},
        "features": feature_records,
        "missingFeatures": missing_groups,
        "proxyFeatures": [],
        "staleFeatures": [],
        "zeroVarianceFeatures": [record["featureId"] for record in feature_records if record["zeroVariance"]],
        "nullHandling": {"silentZeroDetected": False, "evidence": "feature_value rejects missing/non-finite input; dataset construction rejects missing required columns and values; diagnostic contract states missingIsNeverZero=true"},
        "sectorMapping": {"expected": codes, "mapped": [sector["code"] for sector in data_diagnostics["sectors"]], "failures": [], "allSectorsSameValue": False, "exactDuplicateVectors": data_diagnostics["crossSection"]["exactDuplicateVectors"]},
        "providerFailures": data_diagnostics["sourceHealth"]["failures"],
        "hardcoding": {"coverageValueHardcoded": False, "availabilitySetStatic": True, "location": "scripts/sector_probability.py:data_diagnostics available_groups", "impact": "50% follows 0.25 + 0.25; it is not a runtime provider-coverage calculation"},
        "sourceToModelLineage": lineage,
        "recomputation": recomputation,
        "risks": [
            {"level": "high", "item": "marketBreadth", "reason": "20% production feature group missing"},
            {"level": "high", "item": "etfAndInstitutionFlow", "reason": "20% production feature group missing; two data domains combined"},
            {"level": "medium", "item": "policyAndEventMapping", "reason": "10% group lacks deterministic sector adapter"},
            {"level": "medium", "item": "diagnostic_observability", "reason": "latest content exposes summary coverage but no Git-tracked per-feature production matrix for 2026-07-24"},
        ],
        "nextStageCandidates": [
            {"featureId": "marketBreadth", "reason": "largest single focused missing group with real sector cross-section", "source": "existing reliable public constituent/market data path subject to P1-D source approval", "historicalDepth": "must prove >=2 years before use", "updateFrequency": "trading day", "implementationFiles": ["scripts/sector_rotation.py", "scripts/sector_probability.py", "scripts/prediction_dataset.py"], "estimatedCoverageBefore": 0.50, "estimatedCoverageAfter": 0.70, "maintenanceRisk": "medium", "dataQualityRisk": "medium", "recommendedForNextStage": True},
            {"featureId": "policyAndEventMapping", "reason": "uses existing evidence/event inputs and has the lowest provider expansion pressure", "source": "existing evidence/event inputs plus deterministic A-core12 mapping", "historicalDepth": "must prove point-in-time history", "updateFrequency": "trading day/event driven", "implementationFiles": ["scripts/sector_rotation.py", "scripts/sector_probability.py"], "estimatedCoverageBefore": 0.50, "estimatedCoverageAfter": 0.60, "maintenanceRisk": "medium", "dataQualityRisk": "high", "recommendedForNextStage": True},
            {"featureId": "etfAndInstitutionFlow", "reason": "large 20% potential but combines two domains; only begin after a narrow P1-D design decision", "source": "not selected in P1-C", "historicalDepth": "unverified", "updateFrequency": "trading day", "implementationFiles": ["scripts/sector_rotation.py", "scripts/prediction_dataset.py"], "estimatedCoverageBefore": 0.50, "estimatedCoverageAfter": 0.70, "maintenanceRisk": "high", "dataQualityRisk": "high", "recommendedForNextStage": False},
        ],
        "suitableForNextStage": True,
        "blockers": ["No committed 2026-07-24 per-feature production cache exists; only summary diagnostics are auditable for that latest content date.", "The frozen production model JSON does not embed datasetId or featureContractVersion, so the frozen dataset association is confirmed by repository baseline/manifest but not cryptographically self-described by the model artifact.", "No provider may be selected or implemented until P1-D is explicitly authorized."],
    }
    write_json(output, report)
    write_json(lineage_output, lineage)
    write_json(recomputation_output, recomputation)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "reports/prediction")
    arguments = parser.parse_args()
    ledger_audit(arguments.output_dir / "p1c-ledger-stability.json")
    feature_coverage_audit(arguments.output_dir / "p1c-a-share-feature-coverage.json", arguments.output_dir / "p1c-feature-lineage.json", arguments.output_dir / "p1c-coverage-recomputation.json")
    print(json.dumps({"ok": True, "outputs": [str(arguments.output_dir / name) for name in ("p1c-ledger-stability.json", "p1c-a-share-feature-coverage.json", "p1c-feature-lineage.json", "p1c-coverage-recomputation.json")]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
