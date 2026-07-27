#!/usr/bin/env python3
"""Append immutable prediction snapshots and evaluate matured A-share records."""

from __future__ import annotations

import gzip
import hashlib
import json
import tempfile
from collections import defaultdict
from functools import lru_cache
from pathlib import Path
from typing import Any

import sector_rotation as rotation


LEDGER_DIR = rotation.DATA_DIR / "predictions"
SNAPSHOT_LEDGER = LEDGER_DIR / "snapshots.jsonl.gz"
EVALUATION_LEDGER = LEDGER_DIR / "evaluations.jsonl.gz"
PUBLIC_PATH = rotation.PREDICTION_HISTORY_PATH
ARCHIVE_INDEX = rotation.ROOT / "data" / "archive" / "index.json"
MAX_LOCAL_UNCOMPRESSED_BYTES = 32 * 1024 * 1024
PUBLIC_RECORD_LIMIT = 24_000


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_jsonl_gzip(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


def write_jsonl_gzip(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    raw_size = sum(len(canonical(record).encode("utf-8")) + 1 for record in records)
    if raw_size > MAX_LOCAL_UNCOMPRESSED_BYTES:
        raise RuntimeError(f"prediction ledger would exceed {MAX_LOCAL_UNCOMPRESSED_BYTES} bytes")
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as raw:
        temp_name = Path(raw.name)
    try:
        with gzip.open(temp_name, "wt", encoding="utf-8", compresslevel=9) as handle:
            for record in records:
                handle.write(canonical(record) + "\n")
        temp_name.replace(path)
    finally:
        temp_name.unlink(missing_ok=True)


def archive_rotations() -> list[dict[str, Any]]:
    rotations: list[dict[str, Any]] = []
    if ARCHIVE_INDEX.exists():
        index = rotation.read_json(ARCHIVE_INDEX)
        for entry in index.get("snapshots", []):
            path = ARCHIVE_INDEX.parent / str(entry.get("file", ""))
            if not path.exists():
                continue
            try:
                with gzip.open(path, "rt", encoding="utf-8") as handle:
                    payload = json.load(handle)
                snapshot = payload.get("sectorRotation")
                if isinstance(snapshot, dict):
                    rotations.append(snapshot)
            except (OSError, ValueError, TypeError):
                continue
    if rotation.CONTENT_PATH.exists():
        rotations.append(rotation.read_json(rotation.CONTENT_PATH))
    rotations.sort(key=lambda item: str(item.get("generatedAt", "")))
    return rotations


def source_urls(market: dict[str, Any], item: dict[str, Any]) -> list[str]:
    indexes = set(item.get("sourceIndexes", []))
    for group in (item.get("evidence", []), item.get("counterEvidence", [])):
        for point in group:
            indexes.update(point.get("sourceIndexes", []))
    sources = market.get("sources", [])
    return [sources[index]["url"] for index in sorted(indexes) if 0 <= index < len(sources)]


def abstention_id(model_version: str, market: str, date: str, horizon: int, code: str) -> str:
    identity = "\0".join([model_version, market, date, str(horizon), code, "abstained"])
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"ab-{market}-{date.replace('-', '')}-h{horizon}-{code}-{digest}"


def normalize_record_contract(record: dict[str, Any]) -> dict[str, Any]:
    """Add state lineage without modifying immutable numerical prediction fields."""
    if {
        "legacy", "model_availability", "publication_status", "output_mode", "calibration_status",
        "probability_source", "probability_target", "model_input_completeness", "production_feature_coverage",
    }.issubset(record):
        return record
    legacy = record.get("ranking_target") == "absolute-up-legacy" or "probability-v1" in str(record.get("model_version", ""))
    if legacy:
        probability_source = "historical_base_rate" if (
            record.get("absolute_up_probability") is not None
            and record.get("absolute_up_probability") == record.get("historical_base")
        ) else "legacy_unknown"
        record.update({
            "legacy": True,
            "model_availability": "trained",
            "publication_status": "published",
            "output_mode": "probability",
            "calibration_status": "legacy_unknown",
            "probability_source": probability_source,
            "probability_target": "absolute_up",
            "model_input_completeness": record.get("data_completeness"),
            "production_feature_coverage": None,
        })
        return record
    if record.get("market") == "hk":
        record.update({
            "legacy": False,
            "model_availability": "not_trained",
            "publication_status": "not_applicable",
            "output_mode": "current_observation",
            "calibration_status": "not_applicable",
            "probability_source": "none",
            "probability_target": "none",
            "model_input_completeness": None,
            "production_feature_coverage": None,
            "prediction_status": "not_applicable",
            "result": "not-applicable",
            "abstain_reason": ["港股概率模型尚未建设；当前记录仅为市场结构观察。"],
        })
        return record
    record.update({
        "legacy": False,
        "model_availability": "trained",
        "publication_status": "abstained",
        "output_mode": "evidence_observation",
        "calibration_status": "disabled",
        "probability_source": "raw_model",
        "probability_target": "top_quartile",
        "model_input_completeness": 1.0,
        "production_feature_coverage": 0.5,
    })
    return record


def extract_records(snapshot: dict[str, Any]) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    model = snapshot.get("model", {})
    model_version = str(model.get("version", "unknown"))
    created_at = str(snapshot.get("generatedAt", ""))
    for market in snapshot.get("markets", []):
        market_id = str(market.get("id", ""))
        if market_id not in {"a-share", "hk"}:
            continue
        for horizon_key, horizon in (
            ("tomorrow", market.get("horizons", {}).get("tomorrow", {})),
            ("oneWeek", market.get("horizons", {}).get("oneWeek", {})),
            ("oneMonth", market.get("horizons", {}).get("oneMonth", {})),
        ):
            sessions = int(horizon.get("sessions") or {"tomorrow": 1, "oneWeek": 5, "oneMonth": 20}[horizon_key])
            if horizon.get("status") == "ready":
                for item in horizon.get("items", []):
                    # Pre-probability condition-score cards were not published
                    # as probabilities and have no immutable forecast identity.
                    if not item.get("forecastId"):
                        continue
                    is_relative = item.get("rankingTarget") == "top-quartile"
                    if not is_relative and item.get("upProbability") is None:
                        continue
                    record = {
                        "prediction_id": item["forecastId"],
                        "prediction_date": horizon["asOf"],
                        "market": market_id,
                        "sector_id": item.get("code") or item["sector"],
                        "sector_name": item["sector"],
                        "horizon": sessions,
                        "due_date": item.get("dueDate") or horizon.get("dueDate"),
                        "ranking_target": "top-quartile" if is_relative else "absolute-up-legacy",
                        "raw_score": item.get("rawScore"),
                        "raw_probability": item.get("rawProbability"),
                        "calibrated_probability": item.get("calibratedProbability") if is_relative else item.get("calibratedProbability", item.get("upProbability")),
                        "relative_outperformance_probability": item.get("outperformanceProbability"),
                        "top_quartile_probability": item.get("topQuartileProbability"),
                        "absolute_up_probability": item.get("absoluteUpProbability", item.get("upProbability")),
                        "expected_excess_return": item.get("expectedExcessReturn"),
                        "historical_base": item.get("historicalBaseRate"),
                        "effective_edge": item.get("effectiveEdge", item.get("probabilityEdge")),
                        "prediction_status": "published",
                        "abstain_reason": [],
                        "model_version": model_version,
                        "data_as_of": horizon["asOf"],
                        "created_at": created_at,
                        "data_completeness": 1.0,
                        "observation_score": None,
                        "claim": item.get("claim", ""),
                        "evidence": item.get("evidence", []),
                        "counter_evidence": item.get("counterEvidence", []),
                        "trigger": item.get("trigger", ""),
                        "invalidation": item.get("invalidation", ""),
                        "source_urls": source_urls(market, item),
                    }
                    state = horizon if is_relative else {}
                    record.update({
                        "legacy": not is_relative,
                        "model_availability": state.get("modelAvailability", "trained"),
                        "publication_status": state.get("publicationStatus", "published"),
                        "output_mode": state.get("outputMode", "probability"),
                        "calibration_status": state.get("calibrationStatus", "legacy_unknown" if not is_relative else "enabled"),
                        "probability_source": state.get("probabilitySource", "legacy_unknown" if not is_relative else "calibrated_model"),
                        "probability_target": state.get("probabilityTarget", "absolute_up" if not is_relative else "top_quartile"),
                        "model_input_completeness": state.get("modelInputCompleteness", 1.0),
                        "production_feature_coverage": state.get("productionFeatureCoverage"),
                    })
                    output.append(normalize_record_contract(record))
            elif horizon.get("status") == "abstained":
                for item in horizon.get("observationItems", []):
                    code = item.get("code") or item["sector"]
                    record = {
                        "prediction_id": abstention_id(model_version, market_id, horizon["asOf"], sessions, code),
                        "prediction_date": horizon["asOf"],
                        "market": market_id,
                        "sector_id": code,
                        "sector_name": item["sector"],
                        "horizon": sessions,
                        "due_date": horizon.get("dueDate"),
                        "ranking_target": "evidence-observation",
                        "raw_score": None,
                        "raw_probability": None,
                        "calibrated_probability": None,
                        "relative_outperformance_probability": None,
                        "top_quartile_probability": None,
                        "absolute_up_probability": None,
                        "expected_excess_return": None,
                        "historical_base": None,
                        "effective_edge": None,
                        "prediction_status": "model-abstained",
                        "abstain_reason": horizon.get("abstainReasons", []),
                        "model_version": str(horizon.get("diagnostics", {}).get("modelVersion") or model_version),
                        "data_as_of": horizon["asOf"],
                        "created_at": created_at,
                        "data_completeness": horizon.get("diagnostics", {}).get("dataCompleteness"),
                        "observation_score": item.get("score"),
                        "claim": item.get("signal", ""),
                        "evidence": [],
                        "counter_evidence": [],
                        "trigger": horizon.get("nextWatch", [""])[0],
                        "invalidation": "质量闸门通过前不发布概率。",
                        "source_urls": source_urls(market, item),
                    }
                    record.update({
                        "legacy": False,
                        "model_availability": horizon.get("modelAvailability", "trained"),
                        "publication_status": horizon.get("publicationStatus", "abstained"),
                        "output_mode": horizon.get("outputMode", "evidence_observation"),
                        "calibration_status": horizon.get("calibrationStatus", "disabled"),
                        "probability_source": horizon.get("probabilitySource", "raw_model"),
                        "probability_target": horizon.get("probabilityTarget", "top_quartile"),
                        "model_input_completeness": horizon.get("modelInputCompleteness", 1.0),
                        "production_feature_coverage": horizon.get("productionFeatureCoverage", 0.5),
                    })
                    output.append(normalize_record_contract(record))
    return output


def immutable_core(record: dict[str, Any]) -> dict[str, Any]:
    return {key: record.get(key) for key in (
        "prediction_id", "prediction_date", "market", "sector_id", "horizon", "due_date",
        "ranking_target", "raw_score", "raw_probability", "calibrated_probability",
        "relative_outperformance_probability", "top_quartile_probability",
        "absolute_up_probability", "expected_excess_return", "prediction_status",
        "model_version", "data_as_of", "legacy", "model_availability", "publication_status", "output_mode",
        "calibration_status", "probability_source", "probability_target", "model_input_completeness", "production_feature_coverage",
    )}


def merge_snapshots(existing: list[dict[str, Any]], candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {record["prediction_id"]: record for record in existing}
    for candidate in candidates:
        previous = by_id.get(candidate["prediction_id"])
        if previous is None:
            by_id[candidate["prediction_id"]] = candidate
        elif immutable_core(previous) != immutable_core(candidate):
            raise RuntimeError(f"immutable prediction changed: {candidate['prediction_id']}")
    return sorted(by_id.values(), key=lambda item: (item["prediction_date"], item["market"], item["horizon"], item["sector_id"]))


@lru_cache(maxsize=256)
def a_share_returns(prediction_date: str, due_date: str) -> tuple[dict[str, float], float | None, str | None]:
    taxonomy = rotation.read_json(rotation.TAXONOMY_PATH)
    returns: dict[str, float] = {}
    for item in taxonomy["indices"]:
        rows = {row["date"]: row["close"] for row in rotation.read_history(rotation.HISTORY_DIR / f"{item['code']}.csv.gz")}
        if prediction_date in rows and due_date in rows:
            returns[item["code"]] = rows[due_date] / rows[prediction_date] - 1
    benchmark_rows = {row["date"]: row["close"] for row in rotation.read_history(rotation.BENCHMARK_HISTORY_PATH)}
    benchmark = (
        benchmark_rows[due_date] / benchmark_rows[prediction_date] - 1
        if prediction_date in benchmark_rows and due_date in benchmark_rows else None
    )
    return returns, benchmark, max(benchmark_rows) if benchmark_rows else None


def evaluation_for(record: dict[str, Any]) -> dict[str, Any] | None:
    if record["prediction_status"] == "model-abstained":
        return {
            "prediction_id": record["prediction_id"],
            "result": "model-abstained",
            "evaluated_at": rotation.now_iso(),
        }
    if record["market"] != "a-share" or not record.get("due_date"):
        return None
    returns, benchmark, latest_date = a_share_returns(record["prediction_date"], record["due_date"])
    if latest_date is None or record["due_date"] > latest_date:
        return None
    if record["sector_id"] not in returns or benchmark is None or len(returns) < 4:
        return {
            "prediction_id": record["prediction_id"],
            "result": "data-insufficient",
            "evaluated_at": rotation.now_iso(),
        }
    absolute_return = returns[record["sector_id"]]
    excess = absolute_return - benchmark
    ordered = sorted(returns, key=returns.get, reverse=True)
    rank = ordered.index(record["sector_id"]) + 1
    top_count = max(1, (len(ordered) + 3) // 4)
    actual_top = rank <= top_count
    if record["ranking_target"] == "top-quartile":
        edge = float(record.get("effective_edge") or 0)
        if abs(edge) < 3:
            result = "near-neutral"
        else:
            result = "correct" if (edge > 0) == actual_top else "wrong"
    else:
        probability_value = record.get("absolute_up_probability")
        if probability_value is None:
            return {
                "prediction_id": record["prediction_id"],
                "result": "data-insufficient",
                "evaluated_at": rotation.now_iso(),
            }
        probability = float(probability_value)
        if abs(probability - 50) < 1:
            result = "near-neutral"
        else:
            result = "correct" if (probability > 50) == (absolute_return > 0) else "wrong"
    return {
        "prediction_id": record["prediction_id"],
        "realized_absolute_return": absolute_return * 100,
        "realized_benchmark_return": benchmark * 100,
        "realized_excess_return": excess * 100,
        "realized_sector_rank": rank,
        "realized_sector_count": len(ordered),
        "realized_top_quartile": actual_top,
        "result": result,
        "evaluated_at": rotation.now_iso(),
    }


def update_evaluations(records: list[dict[str, Any]], existing: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id = {item["prediction_id"]: item for item in existing}
    for record in records:
        if record["prediction_id"] in by_id:
            continue
        evaluation = evaluation_for(record)
        if evaluation is not None:
            by_id[evaluation["prediction_id"]] = evaluation
    return sorted(by_id.values(), key=lambda item: item["prediction_id"])


def public_payload(records: list[dict[str, Any]], evaluations: list[dict[str, Any]]) -> dict[str, Any]:
    evaluation_by_id = {item["prediction_id"]: item for item in evaluations}
    combined = [{**record, **evaluation_by_id.get(record["prediction_id"], {"result": "pending"})} for record in records]
    combined = combined[-PUBLIC_RECORD_LIMIT:]
    dates = sorted({item["prediction_date"] for item in combined})
    legacy = [item for item in combined if item.get("legacy") is True]
    current = [item for item in combined if item.get("legacy") is not True]
    return {
        "schemaVersion": 1,
        "generatedAt": rotation.now_iso(),
        "policy": {
            "immutablePublicationSnapshots": True,
            "historicalPredictionsRecomputed": False,
            "localLedger": "gzip JSONL; forecast fields append-only; evaluations stored separately",
            "publicRecordLimit": PUBLIC_RECORD_LIMIT,
        },
        "summary": {
            "records": len(combined),
            "published": sum(item["prediction_status"] == "published" for item in combined),
            "abstained": sum(item.get("publication_status") == "abstained" for item in combined),
            "evaluated": sum(item.get("result") not in {None, "pending", "model-abstained"} for item in combined),
            "firstDate": dates[0] if dates else None,
            "lastDate": dates[-1] if dates else None,
            "legacy": {
                "records": len(legacy),
                "published": sum(item.get("publication_status") == "published" for item in legacy),
                "evaluated": sum(item.get("result") not in {None, "pending"} for item in legacy),
            },
            "currentModel": {
                "records": len(current),
                "published": sum(item.get("publication_status") == "published" for item in current),
                "abstained": sum(item.get("publication_status") == "abstained" for item in current),
                "evaluated": sum(item.get("result") not in {None, "pending", "model-abstained", "not-applicable"} for item in current),
            },
        },
        "contract": {
            "modelStateVersion": "p0-v1",
            "currentModelVersion": "2026-07-21-relative-v2",
            "legacyExcludedFromCurrentModelMetrics": True,
            "probabilityTargetsNeverFallback": True,
        },
        "records": combined,
    }


def main() -> None:
    existing = [
        normalize_record_contract(record) for record in read_jsonl_gzip(SNAPSHOT_LEDGER)
        if record.get("prediction_status") != "published"
        or record.get("top_quartile_probability") is not None
        or record.get("absolute_up_probability") is not None
    ]
    candidates = [record for snapshot in archive_rotations() for record in extract_records(snapshot)]
    records = merge_snapshots(existing, candidates)
    evaluations = update_evaluations(records, read_jsonl_gzip(EVALUATION_LEDGER))
    write_jsonl_gzip(SNAPSHOT_LEDGER, records)
    write_jsonl_gzip(EVALUATION_LEDGER, evaluations)
    rotation.write_json_atomic(PUBLIC_PATH, public_payload(records, evaluations))
    print(
        f"[prediction-history] snapshots={len(records)} evaluations={len(evaluations)} "
        f"public={PUBLIC_PATH.relative_to(rotation.ROOT)}",
        flush=True,
    )


if __name__ == "__main__":
    main()
