#!/usr/bin/env python3
"""Immutable GitHub-backed prediction ledger, evaluation events and exports.

The authoritative unit is one deterministic gzip JSON document per prediction
run or evaluation event.  Indexes, monthly manifests, public shards and weekly
reviews are derived and may be rebuilt without rewriting historical events.
"""

from __future__ import annotations

import argparse
import copy
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import tempfile
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

from prediction_ledger_review import _latest_evaluations, build_weekly_review as _build_weekly_review


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LEDGER_ROOT = ROOT / "data" / "prediction-ledger"
DEFAULT_PUBLIC_ROOT = ROOT / "public" / "data" / "prediction-history"
DEFAULT_COMPATIBILITY_PATH = ROOT / "content" / "prediction-history.json"
DEFAULT_REVIEW_PATH = ROOT / "content" / "prediction-review-latest.json"
CONTRACT_VERSION = "prediction-ledger-v1"
SCHEMA_VERSION = 1
TEXT_HASH_MODE = "utf8-canonical-lf-v1"
BINARY_HASH_MODE = "raw-bytes-v1"
GZIP_HASH_MODE = "deterministic-gzip-v1"
ZERO_HASH = "0" * 64
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DATETIME_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}T")
RUN_ID_PATTERN = re.compile(r"^prun-[0-9]{8}-[a-f0-9]{20}$")
EVENT_ID_PATTERN = re.compile(r"^peval-[0-9]{8}-[a-f0-9]{20}$")
HORIZONS = (1, 5, 20)
PROBABILITY_FIELDS = (
    "rawProbability",
    "calibratedProbability",
    "absoluteUpProbability",
    "outperformanceProbability",
    "topQuartileProbability",
)
CURRENT_MODEL_VERSION = "2026-07-21-relative-v2"
MODEL_FILES = {
    "2026-07-21-relative-v2": ROOT / "models" / "sector-rotation" / "a-share-relative-probability-v2.json",
    "2026-07-20-probability-v1": ROOT / "models" / "sector-rotation" / "a-share-up-probability-v1.json",
}
A_SHARE_SECTOR_IDS = [
    "000986", "000987", "000988", "000989", "000990", "000991",
    "000992", "000993", "000994", "000995", "399967", "399970",
]


class LedgerError(RuntimeError):
    """A deterministic prediction-ledger contract failure."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_text_bytes(value: bytes | Path, *, artifact: str = "text artifact") -> bytes:
    raw = value.read_bytes() if isinstance(value, Path) else value
    if raw.startswith(b"\xef\xbb\xbf"):
        raise LedgerError(f"UTF-8 BOM is not allowed [artifact={artifact} hashMode={TEXT_HASH_MODE}]")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise LedgerError(f"invalid UTF-8 [artifact={artifact} hashMode={TEXT_HASH_MODE}]") from exc
    return (text.replace("\r\n", "\n").replace("\r", "\n").rstrip("\n") + "\n").encode("utf-8")


def sha256_canonical_text(value: bytes | Path, *, artifact: str = "text artifact") -> str:
    return sha256_bytes(canonical_text_bytes(value, artifact=artifact))


def deterministic_gzip_bytes(value: bytes) -> bytes:
    output = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, compresslevel=9, mtime=0) as handle:
        handle.write(value)
    return output.getvalue()


def _hash_base(document: dict[str, Any]) -> dict[str, Any]:
    base = copy.deepcopy(document)
    integrity = base.setdefault("integrity", {})
    integrity["payloadSha256"] = ZERO_HASH
    integrity["compressedSha256"] = ZERO_HASH
    return base


def finalize_document(document: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(document)
    integrity = result.setdefault("integrity", {})
    integrity.update({
        "contractVersion": CONTRACT_VERSION,
        "hashMode": {
            "text": TEXT_HASH_MODE,
            "binary": BINARY_HASH_MODE,
            "gzip": GZIP_HASH_MODE,
            "selfHashExclusion": "integrity-digests-zeroed-v1",
        },
        "payloadSha256": ZERO_HASH,
        "compressedSha256": ZERO_HASH,
    })
    base = _hash_base(result)
    payload = canonical_json_bytes(base)
    integrity["payloadSha256"] = sha256_bytes(payload)
    integrity["compressedSha256"] = sha256_bytes(deterministic_gzip_bytes(payload))
    return result


def deterministic_gzip_json(document: dict[str, Any]) -> bytes:
    return deterministic_gzip_bytes(canonical_json_bytes(finalize_document(document)))


def require_date(value: Any, label: str) -> str:
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise LedgerError(f"{label} must be YYYY-MM-DD")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise LedgerError(f"{label} is not a calendar date") from exc
    return value


def require_datetime(value: Any, label: str) -> str:
    if not isinstance(value, str) or not DATETIME_PATTERN.match(value):
        raise LedgerError(f"{label} must be an ISO date-time")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise LedgerError(f"{label} is not an ISO date-time") from exc
    return value


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise LedgerError(f"{label} must be a lowercase SHA-256")
    return value


def _finite_or_none(value: Any) -> bool:
    return value is None or (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)))


def _sort_models(models: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted((copy.deepcopy(item) for item in models), key=lambda item: (str(item.get("market")), str(item.get("modelVersion"))))


def prediction_immutable_core(record: dict[str, Any]) -> dict[str, Any]:
    """Every publication-time prediction field is immutable."""
    return copy.deepcopy(record)


def _prediction_payload_hash(predictions: Sequence[dict[str, Any]]) -> str:
    ordered = sorted((prediction_immutable_core(item) for item in predictions), key=lambda item: item["predictionId"])
    return sha256_bytes(canonical_json_bytes(ordered))


def _state_payload_hash(states: Sequence[dict[str, Any]]) -> str:
    ordered = sorted((prediction_immutable_core(item) for item in states), key=lambda item: item["stateId"])
    return sha256_bytes(canonical_json_bytes(ordered))


def _snapshot_identity_components(document: dict[str, Any]) -> dict[str, Any]:
    predictions = document.get("predictions", [])
    identity = {
        "markets": sorted(str(item) for item in document.get("markets", [])),
        "dataAsOf": document.get("dataAsOf"),
        "publicationEdition": document.get("edition"),
        "publicationVersion": document.get("createdAt"),
        "models": _sort_models(document.get("models", [])),
        "horizons": sorted({int(item["horizonSessions"]) for item in predictions}),
        "predictionPayloadSha256": _prediction_payload_hash(predictions),
    }
    states = document.get("states", [])
    if states:
        identity["statePayloadSha256"] = _state_payload_hash(states)
    return identity


def _run_id(identity: dict[str, Any]) -> str:
    digest = sha256_bytes(canonical_json_bytes(identity))
    return f"prun-{str(identity['dataAsOf']).replace('-', '')}-{digest[:20]}"


def validate_prediction(record: dict[str, Any]) -> None:
    required = {
        "predictionId", "predictionDate", "market", "sectorId", "sectorName", "horizonSessions", "dueDate",
        "modelVersion", "modelAvailability", "publicationStatus", "outputMode", "calibrationStatus",
        "probabilitySource", "probabilityTarget", "rawScore", "rawProbability", "calibratedProbability",
        "absoluteUpProbability", "outperformanceProbability", "topQuartileProbability", "expectedExcessReturn",
        "historicalBaseRate", "effectiveEdge", "observationScore", "abstainReasons", "dataAsOf", "createdAt",
        "modelInputCompleteness", "productionFeatureCoverage", "claim", "evidence", "counterEvidence", "trigger",
        "invalidation", "sourceUrls", "legacy", "benchmark", "universe",
    }
    missing = sorted(required - set(record))
    if missing:
        raise LedgerError(f"prediction missing fields: {missing}")
    extra = sorted(set(record) - required)
    if extra:
        raise LedgerError(f"prediction must NOT have additional properties: {extra}")
    if not isinstance(record["predictionId"], str) or len(record["predictionId"]) < 8:
        raise LedgerError("invalid predictionId")
    require_date(record["predictionDate"], "predictionDate")
    require_date(record["dataAsOf"], "dataAsOf")
    require_datetime(record["createdAt"], "createdAt")
    if record["dueDate"] is not None:
        require_date(record["dueDate"], "dueDate")
        if record["dueDate"] <= record["predictionDate"]:
            raise LedgerError("dueDate must be after predictionDate")
    if record["horizonSessions"] not in HORIZONS:
        raise LedgerError("horizonSessions must be 1, 5 or 20")
    if record["modelAvailability"] not in {"trained", "not_trained", "not_implemented"}:
        raise LedgerError("invalid model availability")
    if record["publicationStatus"] not in {"published", "abstained", "insufficient_data", "not_applicable", "unavailable"}:
        raise LedgerError("invalid publication status")
    if record["probabilityTarget"] not in {"absolute_up", "relative_outperformance", "top_quartile", "none"}:
        raise LedgerError("invalid probability target")
    for key in (
        "rawScore", *PROBABILITY_FIELDS, "expectedExcessReturn", "historicalBaseRate", "effectiveEdge",
        "observationScore", "modelInputCompleteness", "productionFeatureCoverage",
    ):
        if not _finite_or_none(record[key]):
            raise LedgerError(f"{key} must be finite or null")
    for key in ("abstainReasons", "evidence", "counterEvidence", "sourceUrls"):
        if not isinstance(record[key], list):
            raise LedgerError(f"{key} must be an array")
    if any(not isinstance(url, str) or not url.startswith("https://") for url in record["sourceUrls"]):
        raise LedgerError("sourceUrls must contain direct HTTPS URLs")
    probabilities = [record[key] for key in PROBABILITY_FIELDS]
    if any(value is not None and not 0.0 <= float(value) <= 100.0 for value in probabilities):
        raise LedgerError("probabilities must use percentage points in [0, 100]")
    status = record["publicationStatus"]
    if status == "published":
        if record["modelAvailability"] != "trained" or record["outputMode"] != "probability":
            raise LedgerError("published prediction must use a trained probability model")
        target_field = {
            "absolute_up": "absoluteUpProbability",
            "relative_outperformance": "outperformanceProbability",
            "top_quartile": "topQuartileProbability",
        }.get(record["probabilityTarget"])
        if target_field is None or record[target_field] is None:
            raise LedgerError("published prediction lacks target probability")
        if record["probabilitySource"] not in {"raw_model", "calibrated_model", "historical_base_rate", "legacy_unknown"}:
            raise LedgerError("published prediction has invalid probability lineage")
        if record["observationScore"] is not None:
            raise LedgerError("published probability cannot include observation score")
    elif status == "abstained":
        if record["modelAvailability"] != "trained" or record["outputMode"] != "evidence_observation":
            raise LedgerError("abstained prediction must remain a trained-model observation")
        if any(value is not None for value in probabilities):
            raise LedgerError("abstained prediction cannot expose probabilities")
        if not record["abstainReasons"]:
            raise LedgerError("abstained prediction must preserve reasons")
    elif status == "not_applicable":
        if record["modelAvailability"] == "trained":
            raise LedgerError("trained model cannot use not_applicable")
        if record["probabilitySource"] != "none" or record["probabilityTarget"] != "none":
            raise LedgerError("unbuilt models cannot expose probability lineage")
        if any(value is not None for value in probabilities):
            raise LedgerError("unbuilt models cannot expose probabilities")
    elif status == "insufficient_data":
        if any(value is not None for value in probabilities):
            raise LedgerError("insufficient data cannot expose probabilities")
    elif status == "unavailable":
        if record["modelAvailability"] == "trained":
            raise LedgerError("unavailable cannot carry a trained model")
        if record["outputMode"] != "none":
            raise LedgerError("unavailable must use outputMode none")
        if record["probabilitySource"] != "none" or record["probabilityTarget"] != "none":
            raise LedgerError("unavailable cannot expose probability lineage")
        if any(value is not None for value in probabilities):
            raise LedgerError("unavailable cannot expose probabilities")
        if record["calibrationStatus"] != "not_applicable":
            raise LedgerError("unavailable must use not_applicable calibration")
    if record["legacy"]:
        if record["probabilityTarget"] != "absolute_up":
            raise LedgerError("legacy predictions must keep the absolute_up target")
        if record["topQuartileProbability"] is not None or record["outperformanceProbability"] is not None:
            raise LedgerError("legacy absolute-up probability leaked into current targets")
        if record["probabilitySource"] not in {"historical_base_rate", "legacy_unknown"}:
            raise LedgerError("legacy probability lineage is invalid")


def build_snapshot(
    *,
    predictions: Sequence[dict[str, Any]],
    created_at: str,
    data_as_of: str,
    edition: str,
    code_commit: str,
    models: Sequence[dict[str, Any]],
    migration: dict[str, Any] | None = None,
) -> dict[str, Any]:
    require_datetime(created_at, "createdAt")
    require_date(data_as_of, "dataAsOf")
    if edition not in {"daily", "closing", "manual", "migration"}:
        raise LedgerError("edition must be daily, closing, manual or migration")
    if not re.fullmatch(r"[a-f0-9]{40}", code_commit):
        raise LedgerError("codeCommit must be a 40-character Git SHA")
    ordered = sorted((copy.deepcopy(item) for item in predictions), key=lambda item: item["predictionId"])
    if not ordered:
        raise LedgerError("snapshot requires at least one prediction or model-state record")
    ids: set[str] = set()
    for item in ordered:
        validate_prediction(item)
        if item["predictionId"] in ids:
            raise LedgerError(f"duplicate predictionId in snapshot: {item['predictionId']}")
        ids.add(item["predictionId"])
    document: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": "",
        "createdAt": created_at,
        "dataAsOf": data_as_of,
        "edition": edition,
        "codeCommit": code_commit,
        "markets": sorted({str(item["market"]) for item in ordered}),
        "models": _sort_models(models),
        "predictions": ordered,
    }
    if migration is not None:
        document["migration"] = copy.deepcopy(migration)
    identity = _snapshot_identity_components(document)
    document["runId"] = _run_id(identity)
    document["identity"] = identity
    return finalize_document(document)


STATE_REQUIRED = {
    "stateId", "recordDate", "market", "objectId", "objectLabel", "horizonSessions", "target",
    "modelVersion", "modelAvailability", "datasetId", "datasetStatus", "publicationStatus",
    "outputMode", "probability", "expectedReturn", "probabilitySource", "probabilityTarget",
    "calibrationStatus", "abstainReasons", "statusReason", "asOf", "dueDate", "sourceUrls", "legacy",
}


def validate_state_record(record: dict[str, Any]) -> None:
    missing = sorted(STATE_REQUIRED - set(record))
    if missing:
        raise LedgerError(f"state record missing fields: {missing}")
    extra = sorted(set(record) - STATE_REQUIRED)
    if extra:
        raise LedgerError(f"state record must NOT have additional properties: {extra}")
    if not isinstance(record["stateId"], str) or len(record["stateId"]) < 8:
        raise LedgerError("invalid stateId")
    require_date(record["recordDate"], "recordDate")
    require_date(record["asOf"], "asOf")
    if record["dueDate"] is not None:
        require_date(record["dueDate"], "dueDate")
    if record["horizonSessions"] not in HORIZONS:
        raise LedgerError("state horizonSessions must be 1, 5 or 20")
    if record["modelAvailability"] not in {"trained", "not_trained", "not_implemented"}:
        raise LedgerError("invalid state model availability")
    if record["publicationStatus"] not in {"abstained", "insufficient_data", "not_applicable", "unavailable"}:
        raise LedgerError("state publicationStatus must be a non-published status")
    if record["probability"] is not None or record["expectedReturn"] is not None:
        raise LedgerError("state records never carry probability or expected return")
    if record["probabilitySource"] != "none" or record["probabilityTarget"] != "none":
        raise LedgerError("state records cannot expose probability lineage")
    if record["outputMode"] != "none":
        raise LedgerError("state records must use outputMode none")
    if record["modelAvailability"] == "trained" and record["publicationStatus"] in {"unavailable", "not_applicable"}:
        raise LedgerError("trained states cannot use unavailable/not_applicable")
    if record["publicationStatus"] == "unavailable" and record["calibrationStatus"] != "not_applicable":
        raise LedgerError("unavailable state must use not_applicable calibration")
    if record["publicationStatus"] == "abstained":
        if record["modelAvailability"] != "trained":
            raise LedgerError("abstained state must be trained")
        if not record["abstainReasons"]:
            raise LedgerError("abstained state must preserve gate reasons")
    if not isinstance(record["abstainReasons"], list) or not isinstance(record["sourceUrls"], list):
        raise LedgerError("state abstainReasons/sourceUrls must be arrays")
    if any(not isinstance(url, str) or not url.startswith("https://") for url in record["sourceUrls"]):
        raise LedgerError("state sourceUrls must contain direct HTTPS URLs")
    if record["legacy"] is not False:
        raise LedgerError("state records must be current, never legacy")


def build_state_snapshot(
    *,
    states: Sequence[dict[str, Any]],
    created_at: str,
    data_as_of: str,
    edition: str,
    code_commit: str,
    models: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    require_datetime(created_at, "createdAt")
    require_date(data_as_of, "dataAsOf")
    if edition not in {"daily", "closing", "manual", "migration"}:
        raise LedgerError("edition must be daily, closing, manual or migration")
    if not re.fullmatch(r"[a-f0-9]{40}", code_commit):
        raise LedgerError("codeCommit must be a 40-character Git SHA")
    ordered = sorted((copy.deepcopy(item) for item in states), key=lambda item: item["stateId"])
    if not ordered:
        raise LedgerError("state snapshot requires at least one state record")
    ids: set[str] = set()
    for item in ordered:
        validate_state_record(item)
        if item["stateId"] in ids:
            raise LedgerError(f"duplicate stateId in snapshot: {item['stateId']}")
        ids.add(item["stateId"])
    document: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": "",
        "createdAt": created_at,
        "dataAsOf": data_as_of,
        "edition": edition,
        "codeCommit": code_commit,
        "markets": sorted({str(item["market"]) for item in ordered}),
        "models": _sort_models(models),
        "predictions": [],
        "states": ordered,
    }
    identity = _snapshot_identity_components(document)
    document["runId"] = _run_id(identity)
    document["identity"] = identity
    return finalize_document(document)


def _evaluation_identity(document: dict[str, Any]) -> dict[str, Any]:
    return {
        "predictionId": document.get("predictionId"),
        "evaluationDataAsOf": document.get("evaluationDataAsOf"),
        "horizonSessions": document.get("horizonSessions"),
        "eventType": document.get("eventType"),
        "result": document.get("result"),
        "sourceHashes": document.get("sourceHashes"),
        "supersedesEventId": document.get("supersedesEventId"),
    }


def build_evaluation_event(
    *,
    prediction_id: str,
    evaluated_at: str,
    evaluation_data_as_of: str,
    horizon_sessions: int,
    realized_absolute_return: float | None,
    realized_benchmark_return: float | None,
    realized_excess_return: float | None,
    realized_sector_rank: int | None,
    realized_sector_count: int | None,
    realized_top_quartile: bool | None,
    target_outcome: bool | None,
    result: str,
    source_hashes: dict[str, str],
    code_commit: str,
    evaluation_event_id: str | None = None,
    event_type: str = "evaluation",
    supersedes_event_id: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    require_datetime(evaluated_at, "evaluatedAt")
    require_date(evaluation_data_as_of, "evaluationDataAsOf")
    if horizon_sessions not in HORIZONS:
        raise LedgerError("evaluation horizonSessions must be 1, 5 or 20")
    if result not in {"correct", "wrong", "near_neutral", "data_insufficient", "model_abstained", "not_applicable"}:
        raise LedgerError("invalid evaluation result")
    if event_type not in {"evaluation", "revision"}:
        raise LedgerError("eventType must be evaluation or revision")
    if event_type == "revision" and (not supersedes_event_id or not reason):
        raise LedgerError("revision requires supersedesEventId and reason")
    if event_type == "evaluation" and (supersedes_event_id is not None or reason is not None):
        raise LedgerError("initial evaluation cannot supersede another event")
    for key, value in source_hashes.items():
        if not key or not SHA256_PATTERN.fullmatch(value):
            raise LedgerError("sourceHashes values must be SHA-256 digests")
    document: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "evaluationEventId": "",
        "eventType": event_type,
        "predictionId": prediction_id,
        "evaluatedAt": evaluated_at,
        "evaluationDataAsOf": evaluation_data_as_of,
        "horizonSessions": horizon_sessions,
        "realizedAbsoluteReturn": realized_absolute_return,
        "realizedBenchmarkReturn": realized_benchmark_return,
        "realizedExcessReturn": realized_excess_return,
        "realizedSectorRank": realized_sector_rank,
        "realizedSectorCount": realized_sector_count,
        "realizedTopQuartile": realized_top_quartile,
        "targetOutcome": target_outcome,
        "result": result,
        "sourceHashes": dict(sorted(source_hashes.items())),
        "codeCommit": code_commit,
        "supersedesEventId": supersedes_event_id,
        "reason": reason,
    }
    identity = _evaluation_identity(document)
    generated_id = f"peval-{evaluation_data_as_of.replace('-', '')}-{sha256_bytes(canonical_json_bytes(identity))[:20]}"
    document["evaluationEventId"] = evaluation_event_id or generated_id
    document["identity"] = identity
    return finalize_document(document)


def snapshot_relative_path(document: dict[str, Any]) -> str:
    date_text = require_date(document.get("dataAsOf"), "snapshot.dataAsOf")
    return f"snapshots/{date_text[:4]}/{date_text[5:7]}/{document['runId']}.json.gz"


def evaluation_relative_path(document: dict[str, Any]) -> str:
    date_text = require_date(document.get("evaluationDataAsOf"), "evaluation.evaluationDataAsOf")
    return f"evaluations/{date_text[:4]}/{date_text[5:7]}/{document['evaluationEventId']}.json.gz"


def write_json_atomic(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as handle:
        temporary = Path(handle.name)
        handle.write(json_bytes(value))
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _write_immutable_gzip(path: Path, document: dict[str, Any], *, kind: str) -> bool:
    payload = deterministic_gzip_json(document)
    if path.exists():
        if path.read_bytes() == payload:
            return False
        raise LedgerError(f"immutable {kind} path conflict: {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as handle:
        temporary = Path(handle.name)
        handle.write(payload)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return True


def _verify_integrity(document: dict[str, Any], compressed: bytes, *, label: str) -> None:
    integrity = document.get("integrity")
    if not isinstance(integrity, dict):
        raise LedgerError(f"{label} lacks integrity")
    if integrity.get("contractVersion") != CONTRACT_VERSION:
        raise LedgerError(f"{label} contract version mismatch")
    base = _hash_base(document)
    payload = canonical_json_bytes(base)
    if integrity.get("payloadSha256") != sha256_bytes(payload):
        raise LedgerError(f"{label} payload hash mismatch")
    if integrity.get("compressedSha256") != sha256_bytes(deterministic_gzip_bytes(payload)):
        raise LedgerError(f"{label} compressed hash mismatch")
    if len(compressed) < 10 or compressed[3] & 0x08 or int.from_bytes(compressed[4:8], "little") != 0:
        raise LedgerError(f"{label} gzip is nondeterministic")
    if compressed != deterministic_gzip_bytes(canonical_json_bytes(document)):
        raise LedgerError(f"{label} gzip bytes are not canonical")


def read_gzip_document(path: Path) -> dict[str, Any]:
    compressed = path.read_bytes()
    try:
        raw = gzip.decompress(compressed)
        document = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LedgerError(f"invalid gzip JSON: {path}") from exc
    if not isinstance(document, dict):
        raise LedgerError(f"gzip JSON document must be an object: {path}")
    _verify_integrity(document, compressed, label=path.name)
    return document


def contract_document() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "authority": "Git repository immutable event files",
        "hashModes": {
            "text": TEXT_HASH_MODE,
            "binary": BINARY_HASH_MODE,
            "gzip": GZIP_HASH_MODE,
            "selfHashExclusion": "integrity.payloadSha256 and integrity.compressedSha256 are zeroed before both embedded digests are computed",
            "manifestFileSha256": "raw compressed artifact bytes",
        },
        "snapshotIdentity": [
            "markets", "dataAsOf", "publicationEdition", "publicationVersion", "models", "horizons", "predictionPayloadSha256",
        ],
        "immutableRules": {
            "snapshotFilesAppendOnly": True,
            "evaluationFilesAppendOnly": True,
            "predictionAndEvaluationSeparated": True,
            "revisionEventsSupersedeWithoutOverwrite": True,
            "sameRunIdSameBytesIsIdempotent": True,
            "samePredictionIdDifferentCoreFails": True,
            "legacyExcludedFromCurrentMetrics": True,
            "publicLimitsNeverDeleteAuthority": True,
        },
        "probabilityUnit": "percentage_points_0_to_100",
        "returnUnit": "percentage_points",
        "benchmark": {
            "aShare": {
                "code": "000985",
                "name": "中证全指",
                "contractVersion": "a-share-benchmark-csi-all-share-v1",
            }
        },
        "topQuartileTieBreak": ["expected_excess_desc", "sector_id_asc"],
        "schemas": {
            "contract": "schemas/prediction-ledger-contract.schema.json",
            "index": "schemas/prediction-ledger-index.schema.json",
            "snapshot": "schemas/prediction-snapshot.schema.json",
            "evaluation": "schemas/prediction-evaluation.schema.json",
            "weeklyReview": "schemas/prediction-weekly-review.schema.json",
            "publicShard": "schemas/prediction-public-shard.schema.json",
        },
    }


def initialize_ledger(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for relative in ("snapshots", "evaluations", "reviews", "manifests"):
        (root / relative).mkdir(parents=True, exist_ok=True)
    contract_path = root / "contract.json"
    expected = contract_document()
    if contract_path.exists():
        try:
            current = json.loads(canonical_text_bytes(contract_path, artifact=str(contract_path)).decode("utf-8"))
        except (json.JSONDecodeError, LedgerError) as exc:
            raise LedgerError("ledger contract is invalid") from exc
        if current != expected:
            raise LedgerError("ledger contract differs from code contract")
    else:
        write_json_atomic(contract_path, expected)
    if not (root / "index.json").exists():
        rebuild_index(root)


def collect_snapshot_documents(root: Path) -> list[dict[str, Any]]:
    documents = []
    for path in sorted(root.glob("snapshots/**/*.json.gz")):
        document = read_gzip_document(path)
        expected = root / snapshot_relative_path(document)
        if path.resolve() != expected.resolve() or path.stem.replace(".json", "") != document.get("runId"):
            raise LedgerError(f"snapshot month path or runId mismatch: {path.relative_to(root)}")
        validate_snapshot_document(document)
        documents.append(document)
    return documents


def collect_evaluation_documents(root: Path) -> list[dict[str, Any]]:
    documents = []
    for path in sorted(root.glob("evaluations/**/*.json.gz")):
        document = read_gzip_document(path)
        expected = root / evaluation_relative_path(document)
        if path.resolve() != expected.resolve() or path.stem.replace(".json", "") != document.get("evaluationEventId"):
            raise LedgerError(f"evaluation month path or eventId mismatch: {path.relative_to(root)}")
        validate_evaluation_document(document)
        documents.append(document)
    return documents


def validate_snapshot_document(document: dict[str, Any]) -> None:
    allowed = {"schemaVersion", "runId", "createdAt", "dataAsOf", "edition", "codeCommit", "markets", "models", "predictions", "states", "migration", "identity", "integrity"}
    extra = sorted(set(document) - allowed)
    if extra:
        raise LedgerError(f"snapshot must NOT have additional properties: {extra}")
    if document.get("schemaVersion") != SCHEMA_VERSION or not RUN_ID_PATTERN.fullmatch(str(document.get("runId", ""))):
        raise LedgerError("snapshot schemaVersion or runId is invalid")
    require_datetime(document.get("createdAt"), "snapshot.createdAt")
    require_date(document.get("dataAsOf"), "snapshot.dataAsOf")
    if document.get("identity") != _snapshot_identity_components(document):
        raise LedgerError("snapshot identity components mismatch")
    if document.get("runId") != _run_id(document["identity"]):
        raise LedgerError("snapshot runId mismatch")
    predictions = document.get("predictions")
    states = document.get("states", [])
    if not isinstance(predictions, list) or not isinstance(states, list):
        raise LedgerError("snapshot predictions/states must be arrays")
    if not predictions and not states:
        raise LedgerError("snapshot requires at least one prediction or state record")
    ids: set[str] = set()
    for record in predictions:
        validate_prediction(record)
        if record["predictionId"] in ids:
            raise LedgerError("snapshot contains duplicate predictionId")
        ids.add(record["predictionId"])
    state_ids: set[str] = set()
    for record in states:
        validate_state_record(record)
        if record["stateId"] in state_ids:
            raise LedgerError("snapshot contains duplicate stateId")
        state_ids.add(record["stateId"])


def validate_evaluation_document(document: dict[str, Any]) -> None:
    allowed = {"schemaVersion", "evaluationEventId", "eventType", "predictionId", "evaluatedAt", "evaluationDataAsOf", "horizonSessions", "realizedAbsoluteReturn", "realizedBenchmarkReturn", "realizedExcessReturn", "realizedSectorRank", "realizedSectorCount", "realizedTopQuartile", "targetOutcome", "result", "sourceHashes", "codeCommit", "supersedesEventId", "reason", "identity", "integrity"}
    extra = sorted(set(document) - allowed)
    if extra:
        raise LedgerError(f"evaluation must NOT have additional properties: {extra}")
    if document.get("schemaVersion") != SCHEMA_VERSION or not EVENT_ID_PATTERN.fullmatch(str(document.get("evaluationEventId", ""))):
        raise LedgerError("evaluation schemaVersion or evaluationEventId is invalid")
    require_datetime(document.get("evaluatedAt"), "evaluation.evaluatedAt")
    require_date(document.get("evaluationDataAsOf"), "evaluation.evaluationDataAsOf")
    if document.get("horizonSessions") not in HORIZONS:
        raise LedgerError("evaluation horizon is invalid")
    if document.get("identity") != _evaluation_identity(document):
        raise LedgerError("evaluation identity mismatch")
    for key in ("realizedAbsoluteReturn", "realizedBenchmarkReturn", "realizedExcessReturn"):
        if not _finite_or_none(document.get(key)):
            raise LedgerError(f"evaluation {key} must be finite or null")
    if document.get("eventType") == "revision":
        if not document.get("supersedesEventId") or not document.get("reason"):
            raise LedgerError("invalid revision chain")
    elif document.get("eventType") != "evaluation" or document.get("supersedesEventId") is not None:
        raise LedgerError("invalid initial evaluation event")


def unique_predictions_from_snapshots(documents: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for document in documents:
        for record in document["predictions"]:
            previous = by_id.get(record["predictionId"])
            if previous is None:
                by_id[record["predictionId"]] = copy.deepcopy(record)
            elif prediction_immutable_core(previous) != prediction_immutable_core(record):
                raise LedgerError(f"immutable prediction conflict: {record['predictionId']}")
    return sorted(by_id.values(), key=lambda item: (item["predictionDate"], item["market"], item["horizonSessions"], item["sectorId"], item["predictionId"]))


def unique_states_from_snapshots(documents: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for document in documents:
        for record in document.get("states", []):
            previous = by_id.get(record["stateId"])
            if previous is None:
                by_id[record["stateId"]] = copy.deepcopy(record)
            elif prediction_immutable_core(previous) != prediction_immutable_core(record):
                raise LedgerError(f"immutable state conflict: {record['stateId']}")
    return sorted(by_id.values(), key=lambda item: (item["recordDate"], item["market"], item["horizonSessions"], item["objectId"], item["stateId"]))


def collect_predictions(root: Path) -> list[dict[str, Any]]:
    return unique_predictions_from_snapshots(collect_snapshot_documents(root))


def collect_states(root: Path) -> list[dict[str, Any]]:
    return unique_states_from_snapshots(collect_snapshot_documents(root))


def collect_evaluations(root: Path) -> list[dict[str, Any]]:
    return sorted(collect_evaluation_documents(root), key=lambda item: (item["predictionId"], item["evaluatedAt"], item["evaluationEventId"]))


def append_snapshot(root: Path, document: dict[str, Any]) -> bool:
    validate_snapshot_document(document)
    path = root / snapshot_relative_path(document)
    if path.exists():
        return _write_immutable_gzip(path, document, kind="snapshot")
    existing = collect_snapshot_documents(root)
    unique_predictions_from_snapshots([*existing, document])
    return _write_immutable_gzip(path, document, kind="snapshot")


def append_state_snapshot(root: Path, document: dict[str, Any]) -> bool:
    validate_snapshot_document(document)
    path = root / snapshot_relative_path(document)
    if path.exists():
        return _write_immutable_gzip(path, document, kind="snapshot")
    existing = collect_snapshot_documents(root)
    unique_states_from_snapshots([*existing, document])
    return _write_immutable_gzip(path, document, kind="snapshot")


def _validate_evaluation_links(predictions: Sequence[dict[str, Any]], evaluations: Sequence[dict[str, Any]]) -> None:
    prediction_by_id = {item["predictionId"]: item for item in predictions}
    event_by_id: dict[str, dict[str, Any]] = {}
    initial_by_prediction: dict[str, dict[str, Any]] = {}
    for event in sorted(evaluations, key=lambda item: (item["evaluatedAt"], item["evaluationEventId"])):
        if event["predictionId"] not in prediction_by_id:
            raise LedgerError(f"missing prediction reference: {event['predictionId']}")
        prediction_record = prediction_by_id[event["predictionId"]]
        if event["horizonSessions"] != prediction_record["horizonSessions"]:
            raise LedgerError("evaluation horizon differs from prediction")
        if event["evaluationEventId"] in event_by_id:
            raise LedgerError("duplicate evaluationEventId")
        if event["eventType"] == "evaluation":
            previous = initial_by_prediction.get(event["predictionId"])
            if previous is not None and previous != event:
                raise LedgerError(f"prediction already has an initial evaluation: {event['predictionId']}")
            initial_by_prediction[event["predictionId"]] = event
        else:
            superseded = event_by_id.get(event["supersedesEventId"])
            if superseded is None or superseded["predictionId"] != event["predictionId"]:
                raise LedgerError("invalid revision chain")
            if event["evaluatedAt"] < superseded["evaluatedAt"]:
                raise LedgerError("revision precedes superseded evaluation")
        event_by_id[event["evaluationEventId"]] = event


def append_evaluation(root: Path, document: dict[str, Any]) -> bool:
    validate_evaluation_document(document)
    predictions = collect_predictions(root)
    path = root / evaluation_relative_path(document)
    if path.exists():
        return _write_immutable_gzip(path, document, kind="evaluation")
    existing = collect_evaluation_documents(root)
    _validate_evaluation_links(predictions, [*existing, document])
    return _write_immutable_gzip(path, document, kind="evaluation")


def merge_snapshot_documents(left: Sequence[dict[str, Any]], right: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    by_run: dict[str, dict[str, Any]] = {}
    for document in [*left, *right]:
        previous = by_run.get(document["runId"])
        if previous is not None and canonical_json_bytes(previous) != canonical_json_bytes(document):
            raise LedgerError(f"runId conflict during merge: {document['runId']}")
        by_run[document["runId"]] = copy.deepcopy(document)
    merged = sorted(by_run.values(), key=lambda item: (item["dataAsOf"], item["createdAt"], item["runId"]))
    unique_predictions_from_snapshots(merged)
    return merged


def retry_push(runner: Callable[[int], bool], *, maximum_attempts: int = 3) -> bool:
    if maximum_attempts < 1 or maximum_attempts > 3:
        raise LedgerError("push retry count must be between 1 and 3")
    for attempt in range(1, maximum_attempts + 1):
        if runner(attempt):
            return True
    return False


def require_restored_ledger(root: Path, *, expected_snapshot_count: int) -> None:
    actual = len(list(root.glob("snapshots/**/*.json.gz")))
    if expected_snapshot_count > 0 and actual == 0:
        raise LedgerError("empty ledger would overwrite non-empty remote history")
    if actual < expected_snapshot_count:
        raise LedgerError(f"restored ledger is incomplete: expected at least {expected_snapshot_count}, found {actual}")


def _month_entry(root: Path, path: Path, document: dict[str, Any], kind: str) -> dict[str, Any]:
    data_as_of = document["dataAsOf"] if kind == "snapshot" else document["evaluationDataAsOf"]
    models = sorted({item["modelVersion"] for item in [*document.get("predictions", []), *document.get("states", [])]})
    return {
        "path": path.relative_to(root).as_posix(),
        "kind": kind,
        "runId": document.get("runId"),
        "eventId": document.get("evaluationEventId"),
        "size": path.stat().st_size,
        "sha256": sha256_bytes(path.read_bytes()),
        "createdAt": document.get("createdAt") or document.get("evaluatedAt"),
        "dataAsOf": data_as_of,
        "modelVersions": models,
    }


def _derive_manifests_and_index(root: Path) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    snapshots = collect_snapshot_documents(root)
    evaluations = collect_evaluation_documents(root)
    predictions = unique_predictions_from_snapshots(snapshots)
    states = unique_states_from_snapshots(snapshots)
    _validate_evaluation_links(predictions, evaluations)
    entries_by_month: dict[str, list[dict[str, Any]]] = defaultdict(list)
    snapshot_by_id = {item["runId"]: item for item in snapshots}
    evaluation_by_id = {item["evaluationEventId"]: item for item in evaluations}
    prediction_by_id = {item["predictionId"]: item for item in predictions}
    for path in sorted(root.glob("snapshots/**/*.json.gz")):
        document = snapshot_by_id[path.stem.replace(".json", "")]
        entries_by_month[document["dataAsOf"][:7]].append(_month_entry(root, path, document, "snapshot"))
    for path in sorted(root.glob("evaluations/**/*.json.gz")):
        document = evaluation_by_id[path.stem.replace(".json", "")]
        entry = _month_entry(root, path, document, "evaluation")
        entry["modelVersions"] = [prediction_by_id[document["predictionId"]]["modelVersion"]]
        entries_by_month[document["evaluationDataAsOf"][:7]].append(entry)
    manifests: dict[str, dict[str, Any]] = {}
    months = []
    for month in sorted(entries_by_month):
        entries = sorted(entries_by_month[month], key=lambda item: (item["kind"], item["path"]))
        manifest = {
            "schemaVersion": SCHEMA_VERSION,
            "contractVersion": CONTRACT_VERSION,
            "yearMonth": month,
            "entries": entries,
        }
        relative = f"manifests/{month[:4]}/{month[5:7]}.json"
        manifests[relative] = manifest
        month_predictions = [item for item in predictions if item["predictionDate"].startswith(month)]
        month_states = [item for item in states if item["recordDate"].startswith(month)]
        month_evaluations = [item for item in evaluations if item["evaluationDataAsOf"].startswith(month)]
        months.append({
            "month": month,
            "snapshotCount": sum(item["kind"] == "snapshot" for item in entries),
            "evaluationCount": sum(item["kind"] == "evaluation" for item in entries),
            "recordCount": len(month_predictions),
            "stateCount": len(month_states),
            "evaluationEventCount": len(month_evaluations),
            "manifestPath": relative,
            "manifestSha256": sha256_bytes(json_bytes(manifest)),
        })
    dates = sorted({item["predictionDate"] for item in predictions})
    reviews = []
    for path in sorted(root.glob("reviews/**/*.json")):
        payload = json.loads(canonical_text_bytes(path, artifact=str(path)).decode("utf-8"))
        reviews.append({
            "week": payload["isoWeek"],
            "path": path.relative_to(root).as_posix(),
            "sha256": sha256_canonical_text(path, artifact=str(path)),
        })
    status_summary = Counter(item["publicationStatus"] for item in [*predictions, *states])
    index = {
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "snapshotCount": len(snapshots),
        "predictionRecordCount": len(predictions),
        "stateRecordCount": len(states),
        "evaluationEventCount": len(evaluations),
        "firstPredictionDate": dates[0] if dates else None,
        "lastPredictionDate": dates[-1] if dates else None,
        "markets": sorted({item["market"] for item in [*predictions, *states]}),
        "modelVersions": sorted({item["modelVersion"] for item in [*predictions, *states]}),
        "statusSummary": {key: status_summary.get(key, 0) for key in ("published", "abstained", "insufficient_data", "not_applicable", "unavailable")},
        "legacyRecordCount": sum(bool(item["legacy"]) for item in predictions),
        "currentRecordCount": sum(not bool(item["legacy"]) for item in predictions),
        "months": months,
        "reviews": reviews,
    }
    return manifests, index


def rebuild_index(root: Path) -> dict[str, Any]:
    manifests, index = _derive_manifests_and_index(root)
    for relative, manifest in manifests.items():
        write_json_atomic(root / relative, manifest)
    write_json_atomic(root / "index.json", index)
    return index


SNAKE_TO_CAMEL = {
    "prediction_id": "predictionId",
    "prediction_date": "predictionDate",
    "sector_id": "sectorId",
    "sector_name": "sectorName",
    "horizon": "horizonSessions",
    "due_date": "dueDate",
    "model_version": "modelVersion",
    "model_availability": "modelAvailability",
    "publication_status": "publicationStatus",
    "output_mode": "outputMode",
    "calibration_status": "calibrationStatus",
    "probability_source": "probabilitySource",
    "probability_target": "probabilityTarget",
    "raw_score": "rawScore",
    "raw_probability": "rawProbability",
    "calibrated_probability": "calibratedProbability",
    "absolute_up_probability": "absoluteUpProbability",
    "relative_outperformance_probability": "outperformanceProbability",
    "top_quartile_probability": "topQuartileProbability",
    "expected_excess_return": "expectedExcessReturn",
    "historical_base": "historicalBaseRate",
    "effective_edge": "effectiveEdge",
    "observation_score": "observationScore",
    "abstain_reason": "abstainReasons",
    "data_as_of": "dataAsOf",
    "created_at": "createdAt",
    "model_input_completeness": "modelInputCompleteness",
    "production_feature_coverage": "productionFeatureCoverage",
    "counter_evidence": "counterEvidence",
    "source_urls": "sourceUrls",
}
CAMEL_TO_SNAKE = {value: key for key, value in SNAKE_TO_CAMEL.items()}


def _model_artifact_sha256(model_version: str) -> str | None:
    path = MODEL_FILES.get(model_version)
    return sha256_bytes(path.read_bytes()) if path is not None and path.exists() else None


def _legacy_benchmark(market: str) -> dict[str, Any] | None:
    if market != "a-share":
        return None
    return {
        "code": "000985",
        "name": "中证全指",
        "contractVersion": "a-share-benchmark-csi-all-share-v1",
    }


def _legacy_universe(market: str) -> dict[str, Any]:
    if market == "a-share":
        return {
            "id": "a-core12-v2",
            "sectorIds": A_SHARE_SECTOR_IDS,
            "topQuartileFraction": 0.25,
            "tieBreak": ["expected_excess_desc", "sector_id_asc"],
        }
    return {
        "id": "legacy_unknown",
        "sectorIds": [],
        "topQuartileFraction": None,
        "tieBreak": [],
    }


def normalize_legacy_prediction(raw: dict[str, Any]) -> dict[str, Any]:
    if "predictionId" in raw:
        result = copy.deepcopy(raw)
        validate_prediction(result)
        return result
    value = {SNAKE_TO_CAMEL.get(key, key): copy.deepcopy(item) for key, item in raw.items()}
    model_version = str(value.get("modelVersion") or "legacy_unknown")
    market = str(value.get("market") or "legacy_unknown")
    ranking_target = str(raw.get("ranking_target") or "")
    legacy = bool(raw.get("legacy")) or ranking_target == "absolute-up-legacy" or "probability-v1" in model_version
    original_status = str(raw.get("prediction_status") or "")
    if legacy:
        availability = "trained"
        publication = "published"
        output_mode = "probability"
        calibration = "legacy_unknown"
        absolute_probability = value.get("absoluteUpProbability")
        historical_base = value.get("historicalBaseRate")
        source = "historical_base_rate" if absolute_probability is not None and absolute_probability == historical_base else "legacy_unknown"
        target = "absolute_up"
        value["topQuartileProbability"] = None
        value["outperformanceProbability"] = None
    elif market == "hk":
        availability = "not_trained"
        publication = "not_applicable"
        output_mode = "current_observation"
        calibration = "not_applicable"
        source = "none"
        target = "none"
        for key in PROBABILITY_FIELDS:
            value[key] = None
        value["expectedExcessReturn"] = None
        value["historicalBaseRate"] = None
        value["effectiveEdge"] = None
    else:
        availability = "trained"
        publication = "published" if original_status == "published" and value.get("topQuartileProbability") is not None else "abstained"
        output_mode = "probability" if publication == "published" else "evidence_observation"
        calibration = str(raw.get("calibration_status") or ("enabled" if publication == "published" else "disabled"))
        source = str(raw.get("probability_source") or ("calibrated_model" if publication == "published" else "raw_model"))
        target = "top_quartile"
        if publication == "abstained":
            for key in PROBABILITY_FIELDS:
                value[key] = None
            value["expectedExcessReturn"] = None
            value["historicalBaseRate"] = None
            value["effectiveEdge"] = None
    prediction_date = str(value.get("predictionDate") or value.get("dataAsOf"))
    created_at = str(value.get("createdAt") or f"{prediction_date}T00:00:00+08:00")
    result = {
        "predictionId": str(value.get("predictionId")),
        "predictionDate": prediction_date,
        "market": market,
        "sectorId": str(value.get("sectorId") or "legacy_unknown"),
        "sectorName": str(value.get("sectorName") or "legacy unknown"),
        "horizonSessions": int(value.get("horizonSessions") or 1),
        "dueDate": value.get("dueDate"),
        "modelVersion": model_version,
        "modelAvailability": str(raw.get("model_availability") or availability),
        "publicationStatus": str(raw.get("publication_status") or publication),
        "outputMode": str(raw.get("output_mode") or output_mode),
        "calibrationStatus": str(raw.get("calibration_status") or calibration),
        "probabilitySource": source if legacy else str(raw.get("probability_source") or source),
        "probabilityTarget": str(raw.get("probability_target") or target),
        "rawScore": value.get("rawScore"),
        "rawProbability": value.get("rawProbability"),
        "calibratedProbability": value.get("calibratedProbability"),
        "absoluteUpProbability": value.get("absoluteUpProbability"),
        "outperformanceProbability": value.get("outperformanceProbability"),
        "topQuartileProbability": value.get("topQuartileProbability"),
        "expectedExcessReturn": value.get("expectedExcessReturn"),
        "historicalBaseRate": value.get("historicalBaseRate"),
        "effectiveEdge": value.get("effectiveEdge"),
        "observationScore": value.get("observationScore"),
        "abstainReasons": list(value.get("abstainReasons") or ([] if publication == "published" else ["legacy_unknown"])),
        "dataAsOf": str(value.get("dataAsOf") or prediction_date),
        "createdAt": created_at,
        "modelInputCompleteness": (
            raw.get("model_input_completeness")
            if "model_input_completeness" in raw
            else (None if market == "hk" else (1.0 if not legacy else raw.get("data_completeness")))
        ),
        "productionFeatureCoverage": (
            raw.get("production_feature_coverage")
            if "production_feature_coverage" in raw
            else (None if market == "hk" or legacy else raw.get("data_completeness"))
        ),
        "claim": str(value.get("claim") or "legacy_unknown"),
        "evidence": list(value.get("evidence") or []),
        "counterEvidence": list(value.get("counterEvidence") or []),
        "trigger": str(value.get("trigger") or "legacy_unknown"),
        "invalidation": str(value.get("invalidation") or "legacy_unknown"),
        "sourceUrls": sorted({str(url) for url in (value.get("sourceUrls") or []) if isinstance(url, str) and url.startswith("https://")}),
        "legacy": legacy,
        "benchmark": _legacy_benchmark(market),
        "universe": _legacy_universe(market),
    }
    if result["publicationStatus"] == "not_applicable":
        result["modelInputCompleteness"] = None
        result["productionFeatureCoverage"] = None
    validate_prediction(result)
    return result


def to_legacy_snake_case(record: dict[str, Any]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    for key, value in record.items():
        if key in {"benchmark", "universe"}:
            continue
        output[CAMEL_TO_SNAKE.get(key, key)] = copy.deepcopy(value)
    output["ranking_target"] = "absolute-up-legacy" if record["legacy"] else (
        "top-quartile" if record["publicationStatus"] == "published" else "evidence-observation"
    )
    output["prediction_status"] = (
        "published" if record["publicationStatus"] == "published"
        else "not_applicable" if record["publicationStatus"] == "not_applicable"
        else "model-abstained"
    )
    output["data_completeness"] = record.get("productionFeatureCoverage")
    return output


def read_jsonl_gzip(path: Path | None) -> list[dict[str, Any]]:
    if path is None or not path.exists():
        return []
    try:
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            records = [json.loads(line) for line in handle if line.strip()]
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise LedgerError(f"invalid migration gzip JSONL: {path.name}") from exc
    if not all(isinstance(item, dict) for item in records):
        raise LedgerError("migration JSONL records must be objects")
    return records


def migrate_local_ledgers(
    root: Path,
    snapshot_ledger: Path,
    evaluation_ledger: Path | None,
    *,
    code_commit: str,
) -> dict[str, Any]:
    require_sha256(sha256_bytes(snapshot_ledger.read_bytes()), "snapshot migration source hash")
    raw_predictions = read_jsonl_gzip(snapshot_ledger)
    normalized = [normalize_legacy_prediction(item) for item in raw_predictions]
    source_hash = sha256_bytes(snapshot_ledger.read_bytes())
    groups: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for record in normalized:
        groups[(record["predictionDate"], record["modelVersion"], record["createdAt"])].append(record)
    written_snapshots = 0
    for (prediction_date, model_version, created_at), records in sorted(groups.items()):
        availability = records[0]["modelAvailability"]
        document = build_snapshot(
            predictions=records,
            created_at=created_at,
            data_as_of=prediction_date,
            edition="migration",
            code_commit=code_commit,
            models=[{
                "market": records[0]["market"],
                "modelVersion": model_version,
                "artifactSha256": _model_artifact_sha256(model_version),
                "availability": availability,
            }],
            migration={
                "sourceKind": "local-gzip-jsonl",
                "sourceSha256": source_hash,
                "grouping": "prediction_date+model_version+created_at",
                "lineage": "legacy_unknown" if records[0]["legacy"] else "recovered_local_ledger",
            },
        )
        written_snapshots += int(append_snapshot(root, document))
    predictions = collect_predictions(root)
    prediction_by_id = {item["predictionId"]: item for item in predictions}
    evaluation_source_hash = sha256_bytes(evaluation_ledger.read_bytes()) if evaluation_ledger and evaluation_ledger.exists() else None
    written_evaluations = 0
    for raw in read_jsonl_gzip(evaluation_ledger):
        prediction_id = str(raw.get("prediction_id") or "")
        record = prediction_by_id.get(prediction_id)
        if record is None:
            raise LedgerError(f"migration evaluation references missing prediction: {prediction_id}")
        if record["modelAvailability"] != "trained":
            result = "not_applicable"
        elif record["publicationStatus"] == "abstained":
            result = "model_abstained"
        else:
            result = str(raw.get("result") or "data-insufficient").replace("-", "_")
        realized_top = raw.get("realized_top_quartile")
        if record["probabilityTarget"] == "top_quartile":
            outcome = realized_top
        elif record["probabilityTarget"] == "absolute_up" and raw.get("realized_absolute_return") is not None:
            outcome = float(raw["realized_absolute_return"]) > 0
        elif record["probabilityTarget"] == "relative_outperformance" and raw.get("realized_excess_return") is not None:
            outcome = float(raw["realized_excess_return"]) > 0
        else:
            outcome = None
        event = build_evaluation_event(
            prediction_id=prediction_id,
            evaluated_at=str(raw.get("evaluated_at") or record["createdAt"]),
            evaluation_data_as_of=str(record.get("dueDate") or record["predictionDate"]),
            horizon_sessions=record["horizonSessions"],
            realized_absolute_return=raw.get("realized_absolute_return"),
            realized_benchmark_return=raw.get("realized_benchmark_return"),
            realized_excess_return=raw.get("realized_excess_return"),
            realized_sector_rank=raw.get("realized_sector_rank"),
            realized_sector_count=raw.get("realized_sector_count"),
            realized_top_quartile=realized_top,
            target_outcome=outcome,
            result=result,
            source_hashes={"migrationSourceSha256": evaluation_source_hash or source_hash},
            code_commit=code_commit,
        )
        written_evaluations += int(append_evaluation(root, event))
    index = rebuild_index(root)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "sourceSnapshotSha256": source_hash,
        "sourceEvaluationSha256": evaluation_source_hash,
        "sourcePredictionRecords": len(raw_predictions),
        "sourceEvaluationRecords": len(read_jsonl_gzip(evaluation_ledger)),
        "migrationGroups": len(groups),
        "snapshotsWritten": written_snapshots,
        "evaluationsWritten": written_evaluations,
        "ledgerSnapshotCount": index["snapshotCount"],
        "ledgerPredictionRecordCount": index["predictionRecordCount"],
        "ledgerEvaluationEventCount": index["evaluationEventCount"],
        "unrecoveredGaps": [],
    }


def due_date_for_sessions(start_date: str, horizon: int, calendar: Sequence[str]) -> str | None:
    """Return the horizon-th strictly later exchange session."""
    require_date(start_date, "startDate")
    if horizon not in HORIZONS:
        raise LedgerError("horizon must be 1, 5 or 20 sessions")
    sessions = [require_date(item, "calendar session") for item in calendar]
    if sessions != sorted(set(sessions)):
        raise LedgerError("calendar sessions must be unique and ascending")
    later = [item for item in sessions if item > start_date]
    return later[horizon - 1] if len(later) >= horizon else None


def rank_sector_returns(returns: dict[str, float]) -> list[str]:
    if not returns or any(not _finite_or_none(value) or value is None for value in returns.values()):
        raise LedgerError("sector returns must be a non-empty finite mapping")
    return sorted(returns, key=lambda sector_id: (-float(returns[sector_id]), str(sector_id)))


def evaluate_prediction_from_returns(
    record: dict[str, Any],
    sector_returns: dict[str, float],
    *,
    benchmark_return: float,
    evaluated_at: str,
    source_hashes: dict[str, str],
    code_commit: str,
) -> dict[str, Any]:
    """Create an immutable evaluation using decimal input returns.

    Stored returns use percentage points, matching the recovered historical
    ledger.  Ranking ties are resolved by sector id ascending.
    """
    validate_prediction(record)
    if record["publicationStatus"] != "published" or record["modelAvailability"] != "trained":
        raise LedgerError("only published trained-model predictions are evaluated from returns")
    sector_id = record["sectorId"]
    if sector_id not in sector_returns or not _finite_or_none(benchmark_return):
        raise LedgerError("evaluation data is missing the sector or benchmark return")
    ranked = rank_sector_returns(sector_returns)
    rank = ranked.index(sector_id) + 1
    count = len(ranked)
    top_count = max(1, math.ceil(count * float(record["universe"].get("topQuartileFraction", 0.25))))
    absolute = float(sector_returns[sector_id])
    benchmark = float(benchmark_return)
    excess = absolute - benchmark
    top_quartile = rank <= top_count
    target = record["probabilityTarget"]
    if target == "top_quartile":
        outcome = top_quartile
        probability = record["topQuartileProbability"]
    elif target == "relative_outperformance":
        outcome = excess > 0
        probability = record["outperformanceProbability"]
    elif target == "absolute_up":
        outcome = absolute > 0
        probability = record["absoluteUpProbability"]
    else:
        raise LedgerError("published prediction has no evaluable probability target")
    if probability is None:
        raise LedgerError("target probability is unavailable")
    edge = float(probability) - (float(record["historicalBaseRate"]) if record["historicalBaseRate"] is not None else 50.0)
    neutral_band = 3.0 if target == "top_quartile" else 1.0
    result = "near_neutral" if abs(edge) < neutral_band else ("correct" if bool(outcome) == (edge > 0) else "wrong")
    return build_evaluation_event(
        prediction_id=record["predictionId"],
        evaluated_at=evaluated_at,
        evaluation_data_as_of=str(record["dueDate"]),
        horizon_sessions=record["horizonSessions"],
        realized_absolute_return=absolute * 100.0,
        realized_benchmark_return=benchmark * 100.0,
        realized_excess_return=excess * 100.0,
        realized_sector_rank=rank,
        realized_sector_count=count,
        realized_top_quartile=top_quartile,
        target_outcome=outcome,
        result=result,
        source_hashes=source_hashes,
        code_commit=code_commit,
    )


def append_mature_evaluations(
    root: Path,
    evaluation_input: dict[str, Any],
    *,
    code_commit: str,
) -> dict[str, Any]:
    """Append evaluations from an explicit, hash-addressed return payload."""
    data_as_of = require_date(evaluation_input.get("dataAsOf"), "evaluation input dataAsOf")
    evaluated_at = require_datetime(evaluation_input.get("evaluatedAt"), "evaluation input evaluatedAt")
    source_hashes = evaluation_input.get("sourceHashes") or {}
    for key, value in source_hashes.items():
        require_sha256(value, f"sourceHashes.{key}")
    by_horizon = evaluation_input.get("returnsByHorizon") or {}
    predictions = collect_predictions(root)
    existing_ids = {item["predictionId"] for item in collect_evaluations(root) if item["eventType"] == "evaluation"}
    appended = pending = skipped = insufficient = 0
    for record in predictions:
        if record["legacy"] or record["publicationStatus"] != "published" or record["modelAvailability"] != "trained":
            skipped += 1
            continue
        if record["predictionId"] in existing_ids:
            skipped += 1
            continue
        if record["dueDate"] is None or record["dueDate"] > data_as_of:
            pending += 1
            continue
        horizon_payload = by_horizon.get(str(record["horizonSessions"])) or {}
        sector_returns = horizon_payload.get("sectorReturns") or {}
        benchmark_return = horizon_payload.get("benchmarkReturn")
        if record["sectorId"] not in sector_returns or benchmark_return is None:
            event = build_evaluation_event(
                prediction_id=record["predictionId"], evaluated_at=evaluated_at,
                evaluation_data_as_of=data_as_of, horizon_sessions=record["horizonSessions"],
                realized_absolute_return=None, realized_benchmark_return=None, realized_excess_return=None,
                realized_sector_rank=None, realized_sector_count=None, realized_top_quartile=None,
                target_outcome=None, result="data_insufficient", source_hashes=source_hashes,
                code_commit=code_commit,
            )
            insufficient += 1
        else:
            event = evaluate_prediction_from_returns(
                record, {str(key): float(value) for key, value in sector_returns.items()},
                benchmark_return=float(benchmark_return), evaluated_at=evaluated_at,
                source_hashes=source_hashes, code_commit=code_commit,
            )
        appended += int(append_evaluation(root, event))
    rebuild_index(root)
    return {"appended": appended, "pending": pending, "skipped": skipped, "dataInsufficient": insufficient}


def build_weekly_review(
    predictions: Sequence[dict[str, Any]],
    evaluations: Sequence[dict[str, Any]],
    iso_week: str,
) -> dict[str, Any]:
    return _build_weekly_review(
        predictions, evaluations, iso_week,
        schema_version=SCHEMA_VERSION, contract_version=CONTRACT_VERSION, error_type=LedgerError,
    )


def write_weekly_review(root: Path, iso_week: str, *, output_path: Path | None = None) -> dict[str, Any]:
    review = build_weekly_review(collect_predictions(root), collect_evaluations(root), iso_week)
    ledger_path = root / "reviews" / iso_week[:4] / f"{iso_week}.json"
    write_json_atomic(ledger_path, review)
    if output_path is not None:
        write_json_atomic(output_path, review)
    rebuild_index(root)
    return review


def validate_weekly_review_semantics(
    review: dict[str, Any], predictions: Sequence[dict[str, Any]], evaluations: Sequence[dict[str, Any]],
) -> None:
    expected = build_weekly_review(predictions, evaluations, str(review.get("isoWeek")))
    policy = review.get("policy") or {}
    if not policy.get("legacyExcludedFromCurrentMetrics"):
        raise LedgerError("legacy leaked into current metrics")
    if not policy.get("pendingAndAbstainedNeverCountedAsWrong"):
        raise LedgerError("pending or abstention counted as wrong")
    if not policy.get("probabilityTargetsNeverMixed"):
        raise LedgerError("probability targets mixed")
    actual_counts = review.get("counts") or {}
    if actual_counts.get("pending") != expected["counts"]["pending"]:
        raise LedgerError("pending counted as wrong")
    if actual_counts.get("abstained") != expected["counts"]["abstained"]:
        raise LedgerError("abstention counted as wrong")
    if set((review.get("targetMetrics") or {})) != set(expected["targetMetrics"]):
        raise LedgerError("probability targets mixed")
    if review != expected:
        raise LedgerError("weekly review differs from deterministic derivation")


PUBLIC_PREDICTION_FIELDS = (
    "predictionId", "predictionDate", "market", "sectorId", "sectorName", "horizonSessions", "dueDate",
    "modelVersion", "modelAvailability", "publicationStatus", "outputMode", "calibrationStatus",
    "probabilitySource", "probabilityTarget", "rawScore", "rawProbability", "calibratedProbability",
    "absoluteUpProbability", "outperformanceProbability", "topQuartileProbability", "expectedExcessReturn",
    "historicalBaseRate", "effectiveEdge", "observationScore", "abstainReasons", "dataAsOf", "createdAt",
    "modelInputCompleteness", "productionFeatureCoverage", "claim", "evidence", "counterEvidence", "trigger",
    "invalidation", "sourceUrls", "legacy", "benchmark", "universe",
)
PUBLIC_EVALUATION_FIELDS = (
    "evaluationEventId", "eventType", "evaluatedAt", "evaluationDataAsOf", "realizedAbsoluteReturn",
    "realizedBenchmarkReturn", "realizedExcessReturn", "realizedSectorRank", "realizedSectorCount",
    "realizedTopQuartile", "targetOutcome", "result", "supersedesEventId", "reason",
)


def public_record(record: dict[str, Any], evaluation: dict[str, Any] | None) -> dict[str, Any]:
    result = {key: copy.deepcopy(record.get(key)) for key in PUBLIC_PREDICTION_FIELDS}
    result["evaluation"] = None if evaluation is None else {key: copy.deepcopy(evaluation.get(key)) for key in PUBLIC_EVALUATION_FIELDS}
    serialized = json.dumps(result, ensure_ascii=False)
    for forbidden in ("codeCommit", "integrity", "localPath", "sourceHashes"):
        if forbidden in serialized:
            raise LedgerError(f"public export leaks internal field: {forbidden}")
    return result


def public_state_record(state: dict[str, Any]) -> dict[str, Any]:
    result = {
        "predictionId": state["stateId"],
        "predictionDate": state["recordDate"],
        "market": state["market"],
        "sectorId": state["objectId"],
        "sectorName": state["objectLabel"],
        "horizonSessions": state["horizonSessions"],
        "dueDate": None,
        "modelVersion": state["modelVersion"],
        "modelAvailability": state["modelAvailability"],
        "publicationStatus": state["publicationStatus"],
        "outputMode": "none",
        "calibrationStatus": state["calibrationStatus"],
        "probabilitySource": "none",
        "probabilityTarget": "none",
        "rawScore": None,
        "rawProbability": None,
        "calibratedProbability": None,
        "absoluteUpProbability": None,
        "outperformanceProbability": None,
        "topQuartileProbability": None,
        "expectedExcessReturn": None,
        "historicalBaseRate": None,
        "effectiveEdge": None,
        "observationScore": None,
        "abstainReasons": list(state["abstainReasons"]),
        "dataAsOf": state["asOf"],
        "createdAt": f"{state['recordDate']}T00:00:00+08:00",
        "modelInputCompleteness": None,
        "productionFeatureCoverage": None,
        "claim": state["statusReason"],
        "evidence": [],
        "counterEvidence": [],
        "trigger": "not_applicable",
        "invalidation": "not_applicable",
        "sourceUrls": sorted(set(state["sourceUrls"])),
        "legacy": False,
        "benchmark": None,
        "universe": {"id": "stage3-state", "sectorIds": [], "topQuartileFraction": None, "tieBreak": []},
        "evaluation": None,
        "objectId": state["objectId"],
        "datasetId": state.get("datasetId"),
    }
    serialized = json.dumps(result, ensure_ascii=False)
    for forbidden in ("codeCommit", "integrity", "localPath", "sourceHashes"):
        if forbidden in serialized:
            raise LedgerError(f"public export leaks internal field: {forbidden}")
    return result


def export_public(
    root: Path,
    public_root: Path,
    *,
    compatibility_path: Path | None = None,
    review_path: Path | None = None,
) -> dict[str, Any]:
    predictions = collect_predictions(root)
    states = collect_states(root)
    latest = _latest_evaluations(collect_evaluations(root))
    records = [*[public_record(record, latest.get(record["predictionId"])) for record in predictions], *[public_state_record(state) for state in states]]
    by_month: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        by_month[record["predictionDate"][:7]].append(record)
    public_root.mkdir(parents=True, exist_ok=True)
    files = []
    for month, month_records in sorted(by_month.items()):
        relative = f"{month}.json"
        path = public_root / relative
        month_statuses = Counter(item["publicationStatus"] for item in month_records)
        payload = {
            "schemaVersion": SCHEMA_VERSION,
            "contractVersion": CONTRACT_VERSION,
            "yearMonth": month,
            "summary": {
                "recordCount": len(month_records),
                "markets": sorted({item["market"] for item in month_records}),
                "modelVersions": sorted({item["modelVersion"] for item in month_records}),
                "statusSummary": {key: month_statuses.get(key, 0) for key in ("published", "abstained", "insufficient_data", "not_applicable", "unavailable")},
                "legacyRecordCount": sum(bool(item["legacy"]) for item in month_records),
                "currentRecordCount": sum(not bool(item["legacy"]) for item in month_records),
                "evaluatedRecordCount": sum(item["evaluation"] is not None for item in month_records),
                "pendingRecordCount": sum(item["publicationStatus"] == "published" and item["evaluation"] is None for item in month_records),
            },
            "contract": {
                "authoritativeLedger": "data/prediction-ledger",
                "legacyExcludedFromCurrentMetrics": True,
                "probabilityTargetsNeverMixed": True,
                "internalFieldsExcluded": True,
            },
            "records": month_records,
        }
        write_json_atomic(path, payload)
        files.append({"yearMonth": month, "path": relative, "recordCount": len(month_records), "sha256": sha256_canonical_text(path, artifact=str(path))})
    current_files = {str((public_root / item["path"]).resolve()) for item in files}
    for stale in public_root.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].json"):
        if str(stale.resolve()) not in current_files:
            stale.unlink()
    reviews = sorted(root.glob("reviews/**/*.json"))
    latest_review = None
    if reviews:
        review_payload = json.loads(canonical_text_bytes(reviews[-1], artifact=str(reviews[-1])))
        review_relative = f"reviews/{review_payload['isoWeek']}.json"
        write_json_atomic(public_root / review_relative, review_payload)
        latest_review = {
            "isoWeek": review_payload["isoWeek"], "path": review_relative,
            "sha256": sha256_canonical_text(public_root / review_relative, artifact=review_relative),
        }
    statuses = Counter(item["publicationStatus"] for item in records)
    generation_candidates = [record["createdAt"] for record in records if record["createdAt"] is not None]
    generation_candidates.extend(item["evaluation"]["evaluatedAt"] for item in records if item["evaluation"] is not None)
    generated_at = max(generation_candidates) if generation_candidates else "1970-01-01T00:00:00Z"
    record_dates = sorted(item["predictionDate"] for item in records)
    index = {
        "schemaVersion": SCHEMA_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "generatedAt": generated_at,
        "recordCount": len(records),
        "firstDate": record_dates[0] if record_dates else None,
        "lastDate": record_dates[-1] if record_dates else None,
        "files": files,
        "availableMonths": sorted(by_month),
        "markets": sorted({item["market"] for item in records}),
        "modelVersions": sorted({item["modelVersion"] for item in records}),
        "statusSummary": {key: statuses.get(key, 0) for key in ("published", "abstained", "insufficient_data", "not_applicable", "unavailable")},
        "legacyRecordCount": sum(bool(item["legacy"]) for item in records),
        "currentRecordCount": sum(not bool(item["legacy"]) for item in records),
        "evaluatedRecordCount": sum(item["evaluation"] is not None for item in records),
        "pendingRecordCount": sum(item["publicationStatus"] == "published" and item["evaluation"] is None for item in records),
        "latestReview": latest_review,
        "policy": {"completeAuthorityExport": True, "recordLimit": None, "internalFieldsExcluded": True},
    }
    write_json_atomic(public_root / "index.json", index)
    if compatibility_path is not None:
        compatibility_records = []
        for record in predictions:
            item = to_legacy_snake_case(record)
            event = latest.get(record["predictionId"])
            item.update({
                "realized_absolute_return": None,
                "realized_benchmark_return": None,
                "realized_excess_return": None,
                "realized_sector_rank": None,
                "realized_sector_count": None,
                "realized_top_quartile": None,
            })
            if event is None:
                result = "model-abstained" if record["publicationStatus"] == "abstained" else "not-applicable" if record["modelAvailability"] != "trained" else "pending"
            else:
                result = str(event["result"]).replace("_", "-")
                item.update({
                    "evaluated_at": event["evaluatedAt"],
                    "realized_absolute_return": event["realizedAbsoluteReturn"],
                    "realized_benchmark_return": event["realizedBenchmarkReturn"],
                    "realized_excess_return": event["realizedExcessReturn"],
                    "realized_sector_rank": event["realizedSectorRank"],
                    "realized_sector_count": event["realizedSectorCount"],
                    "realized_top_quartile": event["realizedTopQuartile"],
                })
            item["result"] = result
            compatibility_records.append(item)
        compatibility_legacy = [item for item in compatibility_records if item["legacy"]]
        compatibility_current = [item for item in compatibility_records if not item["legacy"]]
        evaluated = sum(item["result"] not in {"pending", "model-abstained", "not-applicable"} for item in compatibility_records)
        compatibility = {
            "schemaVersion": 1,
            "generatedAt": index["generatedAt"],
            "policy": {
                "immutablePublicationSnapshots": True,
                "historicalPredictionsRecomputed": False,
                "localLedger": "deprecated; authoritative source is data/prediction-ledger immutable Git events",
                "publicRecordLimit": None,
            },
            "summary": {
                "records": len(compatibility_records), "published": sum(item["prediction_status"] == "published" for item in compatibility_records),
                "abstained": sum(item["publication_status"] == "abstained" for item in compatibility_records), "evaluated": evaluated,
                "firstDate": index["firstDate"], "lastDate": index["lastDate"],
                "legacy": {
                    "records": len(compatibility_legacy),
                    "published": sum(item["publication_status"] == "published" for item in compatibility_legacy),
                    "evaluated": sum(item["result"] != "pending" for item in compatibility_legacy),
                },
                "currentModel": {
                    "records": len(compatibility_current),
                    "published": sum(item["publication_status"] == "published" for item in compatibility_current),
                    "abstained": sum(item["publication_status"] == "abstained" for item in compatibility_current),
                    "evaluated": sum(item["result"] not in {"pending", "model-abstained", "not-applicable"} for item in compatibility_current),
                },
            },
            "records": compatibility_records,
            "contract": {
                "modelStateVersion": "p0-v1", "currentModelVersion": CURRENT_MODEL_VERSION,
                "legacyExcludedFromCurrentModelMetrics": True, "probabilityTargetsNeverFallback": True,
                "authoritativeLedger": "data/prediction-ledger", "publicShardIndex": "/data/prediction-history/index.json",
            },
        }
        write_json_atomic(compatibility_path, compatibility)
    if review_path is not None:
        if reviews:
            review_path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(reviews[-1], review_path)
    return index


def verify_ledger(root: Path, *, public_root: Path | None = None) -> dict[str, Any]:
    expected_contract = contract_document()
    contract_path = root / "contract.json"
    if not contract_path.exists() or json.loads(canonical_text_bytes(contract_path, artifact=str(contract_path))) != expected_contract:
        raise LedgerError("ledger contract differs from code contract")
    manifests, expected_index = _derive_manifests_and_index(root)
    for relative, manifest in manifests.items():
        path = root / relative
        if not path.exists() or json.loads(canonical_text_bytes(path, artifact=str(path))) != manifest:
            raise LedgerError(f"manifest mismatch: {relative}")
    index_path = root / "index.json"
    if not index_path.exists() or json.loads(canonical_text_bytes(index_path, artifact=str(index_path))) != expected_index:
        raise LedgerError("index count or content mismatch")
    predictions = collect_predictions(root)
    evaluations = collect_evaluations(root)
    _validate_evaluation_links(predictions, evaluations)
    for review_file in root.glob("reviews/**/*.json"):
        review = json.loads(canonical_text_bytes(review_file, artifact=str(review_file)))
        validate_weekly_review_semantics(review, predictions, evaluations)
    if public_root is not None and (public_root / "index.json").exists():
        public_index = json.loads(canonical_text_bytes(public_root / "index.json", artifact="public index"))
        states = collect_states(root)
        if public_index.get("recordCount") != len(predictions) + len(states):
            raise LedgerError("public index count mismatch or history truncation")
        state_months = {item["recordDate"][:7] for item in states}
        prediction_months = {item["predictionDate"][:7] for item in predictions}
        if public_index.get("availableMonths") != sorted(prediction_months | state_months):
            raise LedgerError("public index month mismatch")
        if public_index.get("modelVersions") != sorted({item["modelVersion"] for item in [*predictions, *states]}):
            raise LedgerError("public index model-version mismatch")
        for entry in public_index.get("files", []):
            path = public_root / entry["path"]
            if not path.exists() or sha256_canonical_text(path, artifact=str(path)) != entry["sha256"]:
                raise LedgerError("public shard hash mismatch")
            payload = json.loads(canonical_text_bytes(path, artifact=str(path)))
            if payload.get("summary", {}).get("recordCount") != len(payload.get("records", [])):
                raise LedgerError("public shard summary mismatch")
            serialized = json.dumps(payload, ensure_ascii=False)
            if any(field in serialized for field in ("codeCommit", "sourceHashes", "integrity", "localPath")):
                raise LedgerError("public internal field leak")
        latest_review = public_index.get("latestReview")
        if latest_review:
            path = public_root / latest_review["path"]
            if not path.exists() or sha256_canonical_text(path, artifact=str(path)) != latest_review["sha256"]:
                raise LedgerError("public weekly review hash mismatch")
    return {
        "ok": True,
        "contractVersion": CONTRACT_VERSION,
        "snapshotCount": expected_index["snapshotCount"],
        "predictionRecordCount": expected_index["predictionRecordCount"],
        "evaluationEventCount": expected_index["evaluationEventCount"],
        "manifestCount": len(manifests),
        "publicVerified": bool(public_root is not None and (public_root / "index.json").exists()),
    }


def tree_hash(root: Path) -> str:
    entries = []
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        if path.name in {"index.json"} or "manifests" in path.parts:
            continue
        entries.append({"path": path.relative_to(root).as_posix(), "sha256": sha256_bytes(path.read_bytes())})
    return sha256_bytes(canonical_json_bytes(entries))


def inspect_ledger(root: Path) -> dict[str, Any]:
    index = json.loads(canonical_text_bytes(root / "index.json", artifact="ledger index"))
    return {**index, "treeSha256": tree_hash(root), "root": str(root.resolve())}


def diff_ledgers(left: Path, right: Path) -> dict[str, Any]:
    left_files = {path.relative_to(left).as_posix(): sha256_bytes(path.read_bytes()) for path in left.rglob("*") if path.is_file()}
    right_files = {path.relative_to(right).as_posix(): sha256_bytes(path.read_bytes()) for path in right.rglob("*") if path.is_file()}
    return {
        "onlyLeft": sorted(set(left_files) - set(right_files)),
        "onlyRight": sorted(set(right_files) - set(left_files)),
        "different": sorted(path for path in set(left_files) & set(right_files) if left_files[path] != right_files[path]),
        "identical": left_files == right_files,
    }


def _prediction_id_for_state(data_as_of: str, market: str, horizon: int, sector_id: str, model_version: str) -> str:
    identity = {"dataAsOf": data_as_of, "market": market, "horizon": horizon, "sectorId": sector_id, "modelVersion": model_version}
    return f"state-{market}-{data_as_of.replace('-', '')}-h{horizon}-{sector_id}-{sha256_bytes(canonical_json_bytes(identity))[:12]}"


def snapshot_from_rotation_payload(payload: dict[str, Any], *, edition: str, code_commit: str) -> dict[str, Any]:
    """Convert the website's frozen-model payload into one ledger snapshot."""
    data_as_of = str(payload.get("dataAsOf") or payload.get("asOf") or payload.get("generatedAt", "")[:10])
    created_at = str(payload.get("generatedAt") or f"{data_as_of}T20:00:00+08:00")
    require_date(data_as_of, "rotation dataAsOf")
    # Reuse the already validated P0 extractor for the live A/H payload shape;
    # normalization below upgrades its snake_case contract into ledger v1.
    try:
        import prediction_history as legacy_history
        extracted = legacy_history.extract_records(payload)
    except (ImportError, AttributeError, KeyError, TypeError, ValueError):
        extracted = []
    if extracted:
        records = [normalize_legacy_prediction(item) for item in extracted]
        for market_payload in payload.get("markets", []):
            market_id = str(market_payload.get("id"))
            if market_id not in {"hk", "us"}:
                continue
            for horizon_key, sessions in (("tomorrow", 1), ("oneWeek", 5), ("oneMonth", 20)):
                if any(item["market"] == market_id and item["horizonSessions"] == sessions for item in records):
                    continue
                horizon = market_payload.get("horizons", {}).get(horizon_key, {})
                availability = "not_trained" if market_id == "hk" else "not_implemented"
                version = str(horizon.get("modelVersion") or f"{market_id}-model-{'not-trained' if market_id == 'hk' else 'not-implemented'}")
                sources = [item.get("url") for item in market_payload.get("sources", []) if isinstance(item.get("url"), str) and item["url"].startswith("https://")]
                record = {
                    "predictionId": _prediction_id_for_state(data_as_of, market_id, sessions, f"{market_id}-model-state", version),
                    "predictionDate": data_as_of, "market": market_id, "sectorId": f"{market_id}-model-state", "sectorName": f"{market_id.upper()} model state",
                    "horizonSessions": sessions, "dueDate": horizon.get("dueDate"), "modelVersion": version,
                    "modelAvailability": availability, "publicationStatus": "not_applicable",
                    "outputMode": "current_observation", "calibrationStatus": "not_applicable",
                    "probabilitySource": "none", "probabilityTarget": "none", "rawScore": None,
                    "rawProbability": None, "calibratedProbability": None, "absoluteUpProbability": None,
                    "outperformanceProbability": None, "topQuartileProbability": None, "expectedExcessReturn": None,
                    "historicalBaseRate": None, "effectiveEdge": None, "observationScore": None,
                    "abstainReasons": list(horizon.get("gateFailures") or ["model_not_implemented"]),
                    "dataAsOf": data_as_of, "createdAt": created_at, "modelInputCompleteness": None,
                    "productionFeatureCoverage": None, "claim": str(horizon.get("reason") or "Probability model is unavailable."),
                    "evidence": [], "counterEvidence": [], "trigger": "not_applicable", "invalidation": "not_applicable",
                    "sourceUrls": sorted(set(sources)), "legacy": False, "benchmark": None, "universe": _legacy_universe(market_id),
                }
                validate_prediction(record)
                records.append(record)
        models_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        for record in records:
            key = (record["market"], record["modelVersion"])
            models_by_key[key] = {
                "market": record["market"], "modelVersion": record["modelVersion"],
                "artifactSha256": _model_artifact_sha256(record["modelVersion"]),
                "availability": record["modelAvailability"],
            }
        return build_snapshot(
            predictions=records, created_at=created_at, data_as_of=data_as_of, edition=edition,
            code_commit=code_commit, models=list(models_by_key.values()),
        )
    markets_payload = payload.get("markets")
    if isinstance(markets_payload, dict):
        market_entries = [(key, value) for key, value in markets_payload.items()]
    else:
        market_entries = [(str(item.get("market")), item) for item in (markets_payload or [])]
    records: list[dict[str, Any]] = []
    models: list[dict[str, Any]] = []
    for market, market_payload in market_entries:
        model = market_payload.get("model") or {}
        availability_raw = str(model.get("availability") or market_payload.get("modelAvailability") or market_payload.get("state") or "not_implemented")
        availability = availability_raw if availability_raw in {"trained", "not_trained", "not_implemented"} else ("trained" if market == "a-share" else "not_trained" if market == "hk" else "not_implemented")
        version = str(model.get("version") or market_payload.get("modelVersion") or (CURRENT_MODEL_VERSION if market == "a-share" else f"{market}-model-unavailable-v1"))
        models.append({"market": market, "modelVersion": version, "artifactSha256": model.get("artifactSha256") or _model_artifact_sha256(version), "availability": availability})
        candidates = market_payload.get("predictions") or market_payload.get("sectors") or []
        if not candidates:
            candidates = [{"sectorId": market, "sectorName": f"{market} model state", "horizonSessions": 1}]
        for candidate in candidates:
            horizon = int(candidate.get("horizonSessions") or candidate.get("horizon") or 1)
            sector_id = str(candidate.get("sectorId") or candidate.get("sector_id") or market)
            status = str(candidate.get("publicationStatus") or candidate.get("publication_status") or ("not_applicable" if availability != "trained" else "abstained"))
            status = status.replace("model-abstained", "abstained")
            if status not in {"published", "abstained", "insufficient_data", "not_applicable"}:
                status = "abstained" if availability == "trained" else "not_applicable"
            source = "none" if availability != "trained" else str(candidate.get("probabilitySource") or candidate.get("probability_source") or ("calibrated_model" if status == "published" else "raw_model"))
            target = "none" if availability != "trained" else str(candidate.get("probabilityTarget") or candidate.get("probability_target") or "top_quartile")
            probability = candidate.get("topQuartileProbability", candidate.get("top_quartile_probability")) if status == "published" else None
            record = {
                "predictionId": str(candidate.get("predictionId") or candidate.get("prediction_id") or _prediction_id_for_state(data_as_of, market, horizon, sector_id, version)),
                "predictionDate": data_as_of, "market": market, "sectorId": sector_id,
                "sectorName": str(candidate.get("sectorName") or candidate.get("sector_name") or sector_id),
                "horizonSessions": horizon, "dueDate": candidate.get("dueDate") or candidate.get("due_date"),
                "modelVersion": version, "modelAvailability": availability, "publicationStatus": status,
                "outputMode": "probability" if status == "published" else "current_observation" if availability != "trained" else "evidence_observation",
                "calibrationStatus": str(candidate.get("calibrationStatus") or candidate.get("calibration_status") or ("enabled" if status == "published" else "not_applicable" if availability != "trained" else "disabled")),
                "probabilitySource": source, "probabilityTarget": target,
                "rawScore": candidate.get("rawScore", candidate.get("raw_score")) if availability == "trained" else None,
                "rawProbability": candidate.get("rawProbability", candidate.get("raw_probability")) if status == "published" else None,
                "calibratedProbability": candidate.get("calibratedProbability", candidate.get("calibrated_probability")) if status == "published" else None,
                "absoluteUpProbability": candidate.get("absoluteUpProbability", candidate.get("absolute_up_probability")) if status == "published" else None,
                "outperformanceProbability": candidate.get("outperformanceProbability", candidate.get("relative_outperformance_probability")) if status == "published" else None,
                "topQuartileProbability": probability,
                "expectedExcessReturn": candidate.get("expectedExcessReturn", candidate.get("expected_excess_return")) if status == "published" else None,
                "historicalBaseRate": candidate.get("historicalBaseRate", candidate.get("historical_base")) if status == "published" else None,
                "effectiveEdge": candidate.get("effectiveEdge", candidate.get("effective_edge")) if status == "published" else None,
                "observationScore": candidate.get("observationScore", candidate.get("observation_score")) if status != "published" else None,
                "abstainReasons": list(candidate.get("abstainReasons") or candidate.get("abstain_reason") or (["model_unavailable"] if availability != "trained" else ["quality_gate_failed"] if status != "published" else [])),
                "dataAsOf": data_as_of, "createdAt": created_at,
                "modelInputCompleteness": candidate.get("modelInputCompleteness", candidate.get("model_input_completeness")) if availability == "trained" else None,
                "productionFeatureCoverage": candidate.get("productionFeatureCoverage", candidate.get("production_feature_coverage")) if availability == "trained" else None,
                "claim": str(candidate.get("claim") or "No probability claim is published for this state."),
                "evidence": list(candidate.get("evidence") or []), "counterEvidence": list(candidate.get("counterEvidence") or candidate.get("counter_evidence") or []),
                "trigger": str(candidate.get("trigger") or "not_applicable"), "invalidation": str(candidate.get("invalidation") or "not_applicable"),
                "sourceUrls": sorted({url for url in (candidate.get("sourceUrls") or candidate.get("source_urls") or []) if isinstance(url, str) and url.startswith("https://")}),
                "legacy": False, "benchmark": _legacy_benchmark(market), "universe": _legacy_universe(market),
            }
            if status == "insufficient_data":
                record["probabilitySource"] = source if source != "none" else "raw_model"
            validate_prediction(record)
            records.append(record)
    if not records:
        raise LedgerError("rotation payload contains no market state")
    return build_snapshot(predictions=records, created_at=created_at, data_as_of=data_as_of, edition=edition, code_commit=code_commit, models=models)


def _git_head(root: Path = ROOT) -> str:
    completed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, text=True, capture_output=True, check=False)
    if completed.returncode != 0 or not re.fullmatch(r"[a-f0-9]{40}", completed.stdout.strip()):
        raise LedgerError("unable to resolve Git HEAD")
    return completed.stdout.strip()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_LEDGER_ROOT)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("init")
    migrate = subparsers.add_parser("migrate-local")
    migrate.add_argument("--snapshots", type=Path, required=True)
    migrate.add_argument("--evaluations", type=Path)
    migrate.add_argument("--code-commit", default=None)
    migrate.add_argument("--dry-run", action="store_true")
    append = subparsers.add_parser("append-snapshot")
    append.add_argument("--document", type=Path)
    append.add_argument("--rotation", type=Path)
    append.add_argument("--edition", choices=("daily", "closing", "manual"), default="manual")
    append.add_argument("--code-commit", default=None)
    append_state = subparsers.add_parser("append-state")
    append_state.add_argument("--states", type=Path, required=True)
    append_state.add_argument("--data-as-of", default=None)
    append_state.add_argument("--edition", choices=("daily", "closing", "manual"), default="manual")
    append_state.add_argument("--code-commit", default=None)
    append_state.add_argument("--created-at", default=None)
    evaluate = subparsers.add_parser("append-evaluations")
    evaluate.add_argument("--input", type=Path, required=True)
    evaluate.add_argument("--code-commit", default=None)
    subparsers.add_parser("rebuild-index")
    verify = subparsers.add_parser("verify")
    verify.add_argument("--public-root", type=Path)
    export = subparsers.add_parser("export-public")
    export.add_argument("--public-root", type=Path, default=DEFAULT_PUBLIC_ROOT)
    export.add_argument("--compatibility", type=Path, default=DEFAULT_COMPATIBILITY_PATH)
    export.add_argument("--review", type=Path, default=DEFAULT_REVIEW_PATH)
    review = subparsers.add_parser("build-weekly-review")
    review.add_argument("--week", required=True)
    review.add_argument("--output", type=Path, default=DEFAULT_REVIEW_PATH)
    subparsers.add_parser("inspect")
    diff = subparsers.add_parser("diff")
    diff.add_argument("--other", type=Path, required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _build_parser().parse_args(argv)
    root = arguments.root.resolve()
    try:
        if arguments.command == "init":
            initialize_ledger(root)
            output: Any = inspect_ledger(root)
        elif arguments.command == "migrate-local":
            commit = arguments.code_commit or _git_head()
            if arguments.dry_run:
                with tempfile.TemporaryDirectory() as directory:
                    dry_root = Path(directory) / "prediction-ledger"
                    initialize_ledger(dry_root)
                    output = migrate_local_ledgers(dry_root, arguments.snapshots, arguments.evaluations, code_commit=commit)
                    output["dryRunTreeSha256"] = tree_hash(dry_root)
                    output["dryRun"] = True
            else:
                initialize_ledger(root)
                output = migrate_local_ledgers(root, arguments.snapshots, arguments.evaluations, code_commit=commit)
        elif arguments.command == "append-snapshot":
            initialize_ledger(root)
            if bool(arguments.document) == bool(arguments.rotation):
                raise LedgerError("provide exactly one of --document or --rotation")
            if arguments.document:
                document = json.loads(canonical_text_bytes(arguments.document, artifact=str(arguments.document)))
            else:
                payload = json.loads(canonical_text_bytes(arguments.rotation, artifact=str(arguments.rotation)))
                document = snapshot_from_rotation_payload(payload, edition=arguments.edition, code_commit=arguments.code_commit or _git_head())
            output = {"written": append_snapshot(root, document), "runId": document["runId"], "path": snapshot_relative_path(document)}
            rebuild_index(root)
        elif arguments.command == "append-state":
            initialize_ledger(root)
            payload = json.loads(canonical_text_bytes(arguments.states, artifact=str(arguments.states)))
            states = payload.get("states") if isinstance(payload, dict) else payload
            if not isinstance(states, list) or not states:
                raise LedgerError("states file must contain a non-empty states array")
            models: list[dict[str, Any]] = []
            seen_models: set[tuple[str, str]] = set()
            for state in states:
                key = (str(state["market"]), str(state["modelVersion"]))
                if key in seen_models:
                    continue
                seen_models.add(key)
                models.append({
                    "market": state["market"],
                    "modelVersion": state["modelVersion"],
                    "artifactSha256": None,
                    "availability": state["modelAvailability"],
                })
            data_as_of = arguments.data_as_of or max(str(state["recordDate"]) for state in states)
            created_at = arguments.created_at or f"{data_as_of}T20:00:00+08:00"
            document = build_state_snapshot(
                states=states,
                created_at=created_at,
                data_as_of=data_as_of,
                edition=arguments.edition,
                code_commit=arguments.code_commit or _git_head(),
                models=models,
            )
            output = {
                "written": append_state_snapshot(root, document),
                "runId": document["runId"],
                "path": snapshot_relative_path(document),
                "stateCount": len(states),
            }
            rebuild_index(root)
        elif arguments.command == "append-evaluations":
            initialize_ledger(root)
            payload = json.loads(canonical_text_bytes(arguments.input, artifact=str(arguments.input)))
            output = append_mature_evaluations(root, payload, code_commit=arguments.code_commit or _git_head())
        elif arguments.command == "rebuild-index":
            output = rebuild_index(root)
        elif arguments.command == "verify":
            output = verify_ledger(root, public_root=arguments.public_root)
        elif arguments.command == "export-public":
            output = export_public(root, arguments.public_root, compatibility_path=arguments.compatibility, review_path=arguments.review)
        elif arguments.command == "build-weekly-review":
            output = write_weekly_review(root, arguments.week, output_path=arguments.output)
        elif arguments.command == "inspect":
            output = inspect_ledger(root)
        elif arguments.command == "diff":
            output = diff_ledgers(root, arguments.other.resolve())
        else:
            raise LedgerError(f"unsupported command: {arguments.command}")
    except (LedgerError, OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, sort_keys=True))
        return 1
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
