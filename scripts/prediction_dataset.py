#!/usr/bin/env python3
"""Build, verify, inspect and diff immutable A-share prediction datasets.

This is the only module that creates supervised prediction labels.  The live
sector-rotation module owns source histories and point-in-time features; the
probability trainer only consumes a verified snapshot written here.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import shutil
import tempfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import sector_rotation as rotation


DATASET_SCHEMA_VERSION = 1
A_SHARE_LABEL_CONTRACT_VERSION = "a-share-labels-v1"
A_SHARE_FEATURE_CONTRACT_VERSION = "a-share-price-volume-v2"
A_SHARE_BENCHMARK_CONTRACT_VERSION = "a-share-benchmark-csi-all-share-v1"
MARKET = "A_SHARE"
TIMEZONE = "Asia/Shanghai"
HORIZONS = (1, 5, 20)
TOP_QUARTILE_FRACTION = 0.25
MINIMUM_CROSS_SECTION = 4
SNAPSHOT_PANEL_NAME = "panel.csv.gz"
SNAPSHOT_MANIFEST_NAME = "manifest.json"
SOURCE_MANIFEST_NAME = "source-manifest.json"
LABEL_DIAGNOSTICS_NAME = "label-diagnostics.json"
INDEX_NAME = "index.json"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class DatasetError(RuntimeError):
    """A deterministic prediction-dataset contract failure."""


@dataclass(frozen=True)
class BenchmarkContract:
    code: str
    name: str
    contractVersion: str
    source: str


@dataclass(frozen=True)
class PredictionTargetContract:
    absoluteUp: str
    outperformance: str
    topQuartile: str
    expectedExcess: str


@dataclass(frozen=True)
class PredictionDatasetContract:
    schemaVersion: int
    labelContractVersion: str
    featureContractVersion: str
    benchmarkContractVersion: str
    market: str
    timezone: str
    calendar: str
    rankedUniverse: str
    benchmark: BenchmarkContract
    horizons: tuple[int, ...]
    predictionCutoff: str
    priceField: str
    returnMethod: str
    topQuartileFraction: float
    topQuartileTieBreak: tuple[str, ...]
    minimumCrossSection: int
    missingPolicy: str
    targetDefinitions: PredictionTargetContract


def canonical_json(value: Any) -> bytes:
    """Serialize content-addressed values without paths, clocks or whitespace."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_number(value: float | int | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    numeric = float(value)
    if not math.isfinite(numeric):
        raise DatasetError("non-finite values cannot enter a dataset snapshot")
    if numeric == 0:
        return "0"
    return format(numeric, ".17g")


def maybe_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except ValueError as exc:
        raise DatasetError(f"invalid numeric value: {value!r}") from exc
    if not math.isfinite(parsed):
        raise DatasetError(f"non-finite numeric value: {value!r}")
    return parsed


def require_sha256(value: Any, label: str) -> str:
    if not isinstance(value, str) or not SHA256_PATTERN.fullmatch(value):
        raise DatasetError(f"{label} must be a 64-character SHA-256")
    return value


def require_date(value: Any, label: str) -> str:
    if not isinstance(value, str) or not DATE_PATTERN.fullmatch(value):
        raise DatasetError(f"{label} must be YYYY-MM-DD")
    return value


def contract_for_a_share(
    taxonomy: dict[str, Any],
    *,
    label_contract_version: str = A_SHARE_LABEL_CONTRACT_VERSION,
    feature_contract_version: str = A_SHARE_FEATURE_CONTRACT_VERSION,
    benchmark_contract_version: str = A_SHARE_BENCHMARK_CONTRACT_VERSION,
) -> PredictionDatasetContract:
    benchmark = BenchmarkContract(
        code="000985",
        name="中证全指",
        contractVersion=benchmark_contract_version,
        source=rotation.CSI_API,
    )
    return PredictionDatasetContract(
        schemaVersion=DATASET_SCHEMA_VERSION,
        labelContractVersion=label_contract_version,
        featureContractVersion=feature_contract_version,
        benchmarkContractVersion=benchmark_contract_version,
        market=MARKET,
        timezone=TIMEZONE,
        calendar="a-share-benchmark-session-calendar-v1",
        rankedUniverse=str(taxonomy["documentVersion"]),
        benchmark=benchmark,
        horizons=HORIZONS,
        predictionCutoff="feature-date close; future returns exclude the feature-date session",
        priceField="close",
        returnMethod="close-to-close simple return",
        topQuartileFraction=TOP_QUARTILE_FRACTION,
        topQuartileTieBreak=("expected_excess_desc", "sector_code_asc"),
        minimumCrossSection=MINIMUM_CROSS_SECTION,
        missingPolicy=(
            "never coerce missing values to zero; formal A-share labels require all 12 "
            "ranked sectors and benchmark closes at both dates"
        ),
        targetDefinitions=PredictionTargetContract(
            absoluteUp="1 iff sectorForwardReturn > 0, otherwise 0",
            outperformance="1 iff sectorForwardReturn - benchmarkForwardReturn > 0, otherwise 0",
            topQuartile="top ceil(validSectorCount * 0.25) by expectedExcess, ties by sector code asc",
            expectedExcess="sectorForwardReturn - benchmarkForwardReturn",
        ),
    )


def feature_columns() -> list[str]:
    return ["date", "code", "name", *rotation.FEATURES, *rotation.MODEL_FEATURES]


def label_columns() -> list[str]:
    fields: list[str] = []
    for horizon in HORIZONS:
        suffix = str(horizon)
        fields.extend(
            [
                f"targetDate{suffix}",
                f"horizonSessions{suffix}",
                f"sectorStartClose{suffix}",
                f"sectorEndClose{suffix}",
                f"benchmarkStartClose{suffix}",
                f"benchmarkEndClose{suffix}",
                f"sectorForwardReturn{suffix}",
                f"benchmarkForwardReturn{suffix}",
                f"excessForwardReturn{suffix}",
                f"absoluteUp{suffix}",
                f"outperformance{suffix}",
                f"topQuartile{suffix}",
                f"expectedExcess{suffix}",
                f"realizedRank{suffix}",
                f"realizedRankPercentile{suffix}",
            ]
        )
    return fields


PANEL_COLUMNS = [*feature_columns(), *label_columns()]


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DatasetError(f"invalid JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DatasetError(f"JSON object required: {path}")
    return value


def read_feature_file(path: Path, required_codes: set[str], as_of: str | None = None) -> list[dict[str, Any]]:
    if not path.exists():
        raise DatasetError(f"feature file not found: {path}")
    opener = gzip.open if path.suffix == ".gz" else open
    rows: list[dict[str, Any]] = []
    with opener(path, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise DatasetError("feature file has no header")
        missing = [field for field in feature_columns() if field not in reader.fieldnames]
        if missing:
            raise DatasetError(f"feature file is missing required columns: {', '.join(missing)}")
        for raw in reader:
            code = str(raw.get("code") or "")
            date = str(raw.get("date") or "")
            require_date(date, "feature date")
            if as_of is not None and date > as_of:
                continue
            if not code:
                raise DatasetError("feature file contains blank date or code")
            if code not in required_codes:
                raise DatasetError(f"feature file includes code outside ranked universe: {code}")
            row: dict[str, Any] = {"date": date, "code": code, "name": str(raw.get("name") or "")}
            for field in rotation.FEATURES + rotation.MODEL_FEATURES:
                parsed = maybe_float(raw.get(field))
                if parsed is None:
                    raise DatasetError(f"missing feature {field} at {date} {code}")
                row[field] = parsed
            rows.append(row)
    return rows


def validate_feature_cross_sections(rows: list[dict[str, Any]], required_codes: set[str]) -> dict[str, list[dict[str, Any]]]:
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    keys: set[tuple[str, str]] = set()
    for row in rows:
        date = str(row["date"])
        code = str(row["code"])
        key = (date, code)
        if key in keys:
            raise DatasetError(f"duplicate date+code key: {date} {code}")
        keys.add(key)
        by_date[date].append(row)
    if not by_date:
        raise DatasetError("feature file has no rows")
    for date, date_rows in by_date.items():
        codes = {str(row["code"]) for row in date_rows}
        if codes != required_codes or len(date_rows) != len(required_codes):
            missing = sorted(required_codes - codes)
            extra = sorted(codes - required_codes)
            raise DatasetError(
                f"formal date has incomplete ranked universe: {date}; "
                f"missing={missing} extra={extra} count={len(date_rows)}"
            )
    return by_date


def _read_history_until(path: Path, as_of: str) -> list[dict[str, Any]]:
    if not path.exists():
        raise DatasetError(f"source history missing: {path}")
    result: list[dict[str, Any]] = []
    previous: str | None = None
    for row in rotation.read_history(path):
        date = require_date(str(row.get("date") or ""), f"history date in {path.name}")
        if previous is not None and date <= previous:
            raise DatasetError(f"history dates are not strictly increasing: {path.name} {date}")
        previous = date
        if date > as_of:
            continue
        try:
            close = float(row["close"])
        except (KeyError, TypeError, ValueError) as exc:
            raise DatasetError(f"invalid close in {path.name} {date}") from exc
        if not math.isfinite(close) or close <= 0:
            raise DatasetError(f"invalid close in {path.name} {date}")
        result.append(dict(row))
    if not result:
        raise DatasetError(f"source history has no rows on or before {as_of}: {path}")
    return result


def load_price_histories(
    codes: Iterable[str],
    *,
    history_dir: Path,
    benchmark_history_path: Path,
    as_of: str,
) -> tuple[dict[str, dict[str, float]], dict[str, float], dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    histories: dict[str, dict[str, float]] = {}
    source_rows: dict[str, list[dict[str, Any]]] = {}
    for code in sorted(codes):
        path = history_dir / f"{code}.csv.gz"
        rows = _read_history_until(path, as_of)
        histories[code] = {str(row["date"]): float(row["close"]) for row in rows}
        source_rows[code] = rows
    benchmark_rows = _read_history_until(benchmark_history_path, as_of)
    benchmark = {str(row["date"]): float(row["close"]) for row in benchmark_rows}
    return histories, benchmark, source_rows, benchmark_rows


def empty_labels(row: dict[str, Any]) -> None:
    for field in label_columns():
        row[field] = None


def create_labelled_rows(
    feature_rows: list[dict[str, Any]],
    required_codes: set[str],
    price_histories: dict[str, dict[str, float]],
    benchmark_history: dict[str, float],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Attach labels using only the 000985 benchmark session sequence.

    A missing sector close at the true target session leaves the whole horizon
    null.  It never changes the target session or fills missing returns with
    zero.
    """
    if "000985" in required_codes:
        raise DatasetError("benchmark entered ranked universe")
    by_date = validate_feature_cross_sections(feature_rows, required_codes)
    for code in required_codes:
        if code not in price_histories:
            raise DatasetError(f"price history missing ranked-universe code {code}")
    market_days = sorted(benchmark_history.keys())
    if not market_days:
        raise DatasetError("benchmark trading calendar is empty")
    if len(market_days) != len(set(market_days)):
        raise DatasetError("benchmark trading calendar contains duplicate dates")
    day_positions = {date: index for index, date in enumerate(market_days)}
    labelled: list[dict[str, Any]] = []
    for date in sorted(by_date):
        date_rows = [dict(row) for row in by_date[date]]
        for row in date_rows:
            empty_labels(row)
        if date not in day_positions:
            raise DatasetError(f"feature date absent from benchmark trading calendar: {date}")
        position = day_positions[date]
        for horizon in HORIZONS:
            target_position = position + horizon
            if target_position >= len(market_days):
                continue
            target_date = market_days[target_position]
            if not date < target_date:
                raise DatasetError(f"wrong target-date trading-session advance for {date} h{horizon}")
            benchmark_start = benchmark_history.get(date)
            benchmark_end = benchmark_history.get(target_date)
            complete = benchmark_start is not None and benchmark_end is not None
            sector_prices: dict[str, tuple[float, float]] = {}
            for row in date_rows:
                code = str(row["code"])
                start = price_histories[code].get(date)
                end = price_histories[code].get(target_date)
                if start is None or end is None:
                    complete = False
                    break
                sector_prices[code] = (start, end)
            if not complete:
                continue
            benchmark_return = float(benchmark_end / benchmark_start - 1)
            ranked: list[tuple[float, str, dict[str, Any], float, float, float]] = []
            for row in date_rows:
                start, end = sector_prices[str(row["code"])]
                sector_return = end / start - 1
                excess = sector_return - benchmark_return
                ranked.append((excess, str(row["code"]), row, start, end, sector_return))
            ranked.sort(key=lambda item: (-item[0], item[1]))
            top_count = math.ceil(len(ranked) * TOP_QUARTILE_FRACTION)
            for rank, (excess, _code, row, start, end, sector_return) in enumerate(ranked, start=1):
                suffix = str(horizon)
                row.update(
                    {
                        f"targetDate{suffix}": target_date,
                        f"horizonSessions{suffix}": horizon,
                        f"sectorStartClose{suffix}": start,
                        f"sectorEndClose{suffix}": end,
                        f"benchmarkStartClose{suffix}": benchmark_start,
                        f"benchmarkEndClose{suffix}": benchmark_end,
                        f"sectorForwardReturn{suffix}": sector_return,
                        f"benchmarkForwardReturn{suffix}": benchmark_return,
                        f"excessForwardReturn{suffix}": excess,
                        f"absoluteUp{suffix}": int(sector_return > 0),
                        f"outperformance{suffix}": int(excess > 0),
                        f"topQuartile{suffix}": int(rank <= top_count),
                        f"expectedExcess{suffix}": excess,
                        f"realizedRank{suffix}": rank,
                        f"realizedRankPercentile{suffix}": 1 - (rank - 1) / max(1, len(ranked) - 1),
                    }
                )
        labelled.extend(date_rows)
    labelled.sort(key=lambda row: (str(row["date"]), str(row["code"])))
    return labelled, market_days


def panel_bytes(rows: list[dict[str, Any]]) -> tuple[bytes, bytes]:
    ordered = sorted(rows, key=lambda row: (str(row["date"]), str(row["code"])))
    text = io.StringIO(newline="")
    writer = csv.DictWriter(text, fieldnames=PANEL_COLUMNS, lineterminator="\n", extrasaction="raise")
    writer.writeheader()
    for row in ordered:
        output: dict[str, str] = {}
        for field in PANEL_COLUMNS:
            value = row.get(field)
            if field in {"date", "code", "name"} or field.startswith("targetDate"):
                output[field] = "" if value is None else str(value)
            else:
                output[field] = stable_number(value)
        writer.writerow(output)
    raw = text.getvalue().encode("utf-8")
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, compresslevel=9, mtime=0) as handle:
        handle.write(raw)
    return raw, compressed.getvalue()


def _relative_source_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(rotation.ROOT.resolve())).replace("\\", "/")
    except ValueError:
        return path.name


def source_file_record(
    path: Path,
    kind: str,
    *,
    used_rows: list[dict[str, Any]] | None = None,
    used_content: bytes | None = None,
) -> dict[str, Any]:
    if not path.exists():
        raise DatasetError(f"source missing: {path}")
    if used_rows is not None:
        used_content = canonical_json(used_rows)
        dates = [str(row["date"]) for row in used_rows if isinstance(row, dict) and row.get("date")]
        used_rows_count = len(used_rows)
        used_start = min(dates) if dates else None
        used_end = max(dates) if dates else None
    else:
        used_content = path.read_bytes() if used_content is None else used_content
        used_rows_count = 0
        used_start = None
        used_end = None
    full_hash = sha256_path(path)
    return {
        "kind": kind,
        "path": _relative_source_path(path),
        "bytes": path.stat().st_size,
        "sha256": full_hash,
        "fullFileSha256": full_hash,
        "usedContentSha256": sha256_bytes(used_content),
        "usedRows": used_rows_count,
        "usedStart": used_start,
        "usedEnd": used_end,
    }


def maturity_summary(rows: list[dict[str, Any]]) -> tuple[dict[str, Any], dict[str, Any]]:
    maturity: dict[str, Any] = {}
    missing: dict[str, int] = {}
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_date[str(row["date"])].append(row)
    for horizon in HORIZONS:
        suffix = str(horizon)
        mature_dates = [date for date, date_rows in by_date.items() if date_rows[0].get(f"targetDate{suffix}") is not None]
        mature_rows = sum(len(by_date[date]) for date in mature_dates)
        positive = sum(int(row[f"topQuartile{suffix}"]) for row in rows if row.get(f"topQuartile{suffix}") is not None)
        maturity[suffix] = {
            "matureDates": len(mature_dates),
            "matureRows": mature_rows,
            "immatureDates": len(by_date) - len(mature_dates),
            "firstTargetDate": min((by_date[date][0][f"targetDate{suffix}"] for date in mature_dates), default=None),
            "lastTargetDate": max((by_date[date][0][f"targetDate{suffix}"] for date in mature_dates), default=None),
            "topQuartilePositiveRate": positive / mature_rows if mature_rows else None,
        }
        missing[suffix] = len(rows) - mature_rows
    return maturity, missing


def label_diagnostics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_date[str(row["date"])].append(row)
    horizons: dict[str, Any] = {}
    for horizon in HORIZONS:
        suffix = str(horizon)
        mature = [row for row in rows if row.get(f"targetDate{suffix}") is not None]
        mature_dates = [date for date, items in by_date.items() if items[0].get(f"targetDate{suffix}") is not None]
        horizons[suffix] = {
            "matureRows": len(mature),
            "matureDates": len(mature_dates),
            "absoluteUpPositiveRate": sum(int(row[f"absoluteUp{suffix}"]) for row in mature) / len(mature) if mature else None,
            "outperformancePositiveRate": sum(int(row[f"outperformance{suffix}"]) for row in mature) / len(mature) if mature else None,
            "topQuartilePositiveRate": sum(int(row[f"topQuartile{suffix}"]) for row in mature) / len(mature) if mature else None,
            "crossSectionSizeMin": min((len(by_date[date]) for date in mature_dates), default=0),
            "crossSectionSizeMax": max((len(by_date[date]) for date in mature_dates), default=0),
        }
    return {"schemaVersion": DATASET_SCHEMA_VERSION, "horizons": horizons}


def write_new_snapshot(directory: Path, files: dict[str, bytes]) -> None:
    if directory.exists():
        raise DatasetError(f"immutable snapshot already exists and cannot be overwritten: {directory}")
    directory.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{directory.name}.", dir=directory.parent))
    try:
        for name, data in files.items():
            (temporary / name).write_bytes(data)
        os.replace(temporary, directory)
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def _new_index() -> dict[str, Any]:
    return {"schemaVersion": DATASET_SCHEMA_VERSION, "datasets": [], "legacyProduction": []}


def write_index(root: Path, entry: dict[str, Any]) -> None:
    path = root / INDEX_NAME
    existing = read_json(path) if path.exists() else _new_index()
    if existing.get("schemaVersion") != DATASET_SCHEMA_VERSION or not isinstance(existing.get("datasets"), list):
        raise DatasetError("dataset index has invalid structure")
    old = next((item for item in existing["datasets"] if item.get("datasetId") == entry["datasetId"]), None)
    if old is not None:
        if old != entry:
            raise DatasetError(f"dataset index entry would mutate immutable record: {entry['datasetId']}")
        return
    existing["datasets"].append(entry)
    existing["datasets"].sort(key=lambda item: str(item["datasetId"]))
    temp = path.with_suffix(".tmp")
    temp.write_bytes(json_bytes(existing))
    os.replace(temp, path)


def set_dataset_status(root: Path, dataset_id: str, status: str, reason: str, code_commit: str) -> dict[str, Any]:
    if status not in {"active", "superseded", "retired"}:
        raise DatasetError("set-status only accepts active, superseded or retired")
    if not reason or not reason.strip():
        raise DatasetError("set-status requires a non-empty --reason")
    if not re.fullmatch(r"[a-f0-9]{40}", code_commit):
        raise DatasetError("set-status requires a 40-character --code-commit")
    index_path = root / INDEX_NAME
    index = read_json(index_path)
    entry = next((item for item in index.get("datasets", []) if item.get("datasetId") == dataset_id), None)
    if entry is None:
        raise DatasetError(f"dataset not registered: {dataset_id}")
    current = entry.get("lifecycleStatus")
    transitions = {"candidate": {"active", "superseded"}, "active": {"retired"}}
    if status not in transitions.get(current, set()):
        raise DatasetError(f"illegal lifecycle transition: {current} -> {status}")
    history = entry.get("statusHistory")
    if not isinstance(history, list) or not history:
        raise DatasetError("dataset statusHistory must be retained")
    history.append(
        {
            "from": current,
            "to": status,
            "changedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
            "codeCommit": code_commit,
            "reason": reason.strip(),
        }
    )
    entry["lifecycleStatus"] = status
    temp = index_path.with_suffix(".tmp")
    temp.write_bytes(json_bytes(index))
    os.replace(temp, index_path)
    return entry


def identity_components(
    *,
    data_as_of: str,
    panel_uncompressed_sha256: str,
    label_contract_version: str,
    feature_contract_version: str,
    benchmark_contract_version: str,
    taxonomy_sha256: str,
    calendar_sha256: str,
) -> dict[str, Any]:
    return {
        "market": MARKET,
        "dataAsOf": data_as_of,
        "panelUncompressedSha256": panel_uncompressed_sha256,
        "datasetSchemaVersion": DATASET_SCHEMA_VERSION,
        "labelContractVersion": label_contract_version,
        "featureContractVersion": feature_contract_version,
        "benchmarkContractVersion": benchmark_contract_version,
        "benchmarkCode": "000985",
        "taxonomySha256": taxonomy_sha256,
        "calendarSha256": calendar_sha256,
    }


def build_snapshot(
    feature_file: Path,
    output_root: Path,
    code_commit: str,
    status: str = "candidate",
    created_at: str | None = None,
    *,
    as_of: str,
    history_dir: Path | None = None,
    benchmark_history_file: Path | None = None,
    taxonomy_path: Path | None = None,
    calendar_path: Path | None = None,
    label_contract_version: str = A_SHARE_LABEL_CONTRACT_VERSION,
) -> dict[str, Any]:
    if status not in {"active", "candidate", "legacy_recovered"}:
        raise DatasetError(f"invalid snapshot status: {status}")
    require_date(as_of, "as-of")
    if not re.fullmatch(r"[a-f0-9]{40}", code_commit):
        raise DatasetError("build requires a 40-character code commit")
    taxonomy_path = (taxonomy_path or rotation.TAXONOMY_PATH).resolve()
    calendar_path = (calendar_path or rotation.CALENDAR_PATH).resolve()
    history_dir = (history_dir or rotation.HISTORY_DIR).resolve()
    benchmark_history_file = (benchmark_history_file or history_dir / "000985.csv.gz").resolve()
    taxonomy = read_json(taxonomy_path)
    contract = contract_for_a_share(taxonomy, label_contract_version=label_contract_version)
    codes = {str(item["code"]) for item in taxonomy.get("indices", [])}
    if len(codes) != 12:
        raise DatasetError("A-share contract requires exactly 12 ranked sectors")
    if contract.benchmark.code in codes:
        raise DatasetError("benchmark entered ranked universe")
    feature_rows = read_feature_file(feature_file, codes, as_of)
    price_histories, benchmark_history, sector_history_rows, benchmark_rows = load_price_histories(
        codes,
        history_dir=history_dir,
        benchmark_history_path=benchmark_history_file,
        as_of=as_of,
    )
    rows, market_days = create_labelled_rows(feature_rows, codes, price_histories, benchmark_history)
    if not rows:
        raise DatasetError("no rows remain in the snapshot after the as-of cutoff")
    raw_panel, compressed_panel = panel_bytes(rows)
    panel_sha = sha256_bytes(compressed_panel)
    panel_uncompressed_sha = sha256_bytes(raw_panel)
    taxonomy_canonical_sha = sha256_bytes(canonical_json(taxonomy))
    taxonomy_source_sha = sha256_path(taxonomy_path)
    holiday_source_sha = sha256_path(calendar_path)
    session_calendar_sha = sha256_bytes(canonical_json(market_days))
    components = identity_components(
        data_as_of=as_of,
        panel_uncompressed_sha256=panel_uncompressed_sha,
        label_contract_version=contract.labelContractVersion,
        feature_contract_version=contract.featureContractVersion,
        benchmark_contract_version=contract.benchmarkContractVersion,
        taxonomy_sha256=taxonomy_canonical_sha,
        calendar_sha256=session_calendar_sha,
    )
    identity_sha = sha256_bytes(canonical_json(components))
    dataset_id = f"a-share-{as_of}-{identity_sha[:12]}"
    snapshot_dir = output_root / "a-share" / dataset_id
    if snapshot_dir.exists():
        manifest = verify_snapshot(snapshot_dir)
        if manifest.get("identitySha256") != identity_sha:
            raise DatasetError(f"existing dataset id has different identity content: {dataset_id}")
        return {"datasetId": dataset_id, "snapshot": str(snapshot_dir), "reusedExisting": True, "manifest": manifest}

    feature_record = source_file_record(feature_file, "feature-panel", used_rows=feature_rows)
    taxonomy_record = source_file_record(taxonomy_path, "taxonomy", used_content=canonical_json(taxonomy))
    holiday_record = source_file_record(calendar_path, "holiday-calendar")
    benchmark_record = source_file_record(benchmark_history_file, "benchmark-history", used_rows=benchmark_rows)
    source_files = [feature_record, taxonomy_record, holiday_record, benchmark_record]
    for code in sorted(codes):
        source_files.append(
            source_file_record(history_dir / f"{code}.csv.gz", "sector-history", used_rows=sector_history_rows[code])
        )
    source = {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "featureFile": feature_record,
        "files": source_files,
        "rankedUniverse": {"taxonomyId": str(taxonomy["documentVersion"]), "codes": sorted(codes)},
        "marketCalendarDays": market_days,
        "marketCalendarSha256": session_calendar_sha,
    }
    source_bytes = json_bytes(source)
    diagnostics = label_diagnostics(rows)
    diagnostics_bytes = json_bytes(diagnostics)
    maturity, missing_labels = maturity_summary(rows)
    date_groups: dict[str, int] = defaultdict(int)
    for row in rows:
        date_groups[str(row["date"])] += 1
    manifest = {
        "schemaVersion": DATASET_SCHEMA_VERSION,
        "datasetId": dataset_id,
        "identitySha256": identity_sha,
        "identityComponents": components,
        "status": status,
        "market": MARKET,
        "createdAt": created_at or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "codeCommit": code_commit,
        "dataAsOf": as_of,
        "featureStart": min(str(row["date"]) for row in rows),
        "featureEnd": max(str(row["date"]) for row in rows),
        "taxonomy": {
            "id": str(taxonomy["documentVersion"]),
            "canonicalSha256": taxonomy_canonical_sha,
            "sourceFileSha256": taxonomy_source_sha,
        },
        "benchmark": {
            "code": contract.benchmark.code,
            "name": contract.benchmark.name,
            "contractVersion": contract.benchmark.contractVersion,
            "source": contract.benchmark.source,
        },
        "calendar": {
            "id": contract.calendar,
            "source": "benchmark-history",
            "sha256": session_calendar_sha,
            "sessionCalendarSha256": session_calendar_sha,
            "sessions": len(market_days),
            "firstDate": market_days[0],
            "lastDate": market_days[-1],
            "holidayArtifact": {"path": _relative_source_path(calendar_path), "sha256": holiday_source_sha},
            "holidayArtifactSha256": holiday_source_sha,
        },
        "contracts": {
            "dataset": str(DATASET_SCHEMA_VERSION),
            "features": contract.featureContractVersion,
            "labels": contract.labelContractVersion,
            "benchmark": contract.benchmarkContractVersion,
        },
        "horizons": list(HORIZONS),
        "targets": ["absolute_up", "outperformance", "top_quartile", "expected_excess"],
        "panel": {
            "path": SNAPSHOT_PANEL_NAME,
            "sha256": panel_sha,
            "uncompressedSha256": panel_uncompressed_sha,
            "rows": len(rows),
            "dates": len(date_groups),
            "sectors": len(codes),
            "columns": PANEL_COLUMNS,
            "compressedBytes": len(compressed_panel),
            "uncompressedBytes": len(raw_panel),
        },
        "maturity": maturity,
        "quality": {
            "missingFeatureValues": 0,
            "missingLabelValuesByHorizon": missing_labels,
            "duplicateKeys": 0,
            "invalidTargetDates": 0,
            "crossSectionSizeMin": min(date_groups.values()),
            "crossSectionSizeMax": max(date_groups.values()),
        },
        "sourceManifest": {"path": SOURCE_MANIFEST_NAME, "sha256": sha256_bytes(source_bytes)},
        "labelDiagnostics": {"path": LABEL_DIAGNOSTICS_NAME, "sha256": sha256_bytes(diagnostics_bytes)},
        "warnings": (
            []
            if status == "legacy_recovered"
            else [
                "candidate snapshot: frozen production featureDataSha256 "
                "83d693e8f4c01dc7f50cd53f53aae66a860a428dac1449617aea0ad8a54432be was not recovered"
            ]
        ),
    }
    manifest_bytes = json_bytes(manifest)
    write_new_snapshot(
        snapshot_dir,
        {
            SNAPSHOT_PANEL_NAME: compressed_panel,
            SOURCE_MANIFEST_NAME: source_bytes,
            LABEL_DIAGNOSTICS_NAME: diagnostics_bytes,
            SNAPSHOT_MANIFEST_NAME: manifest_bytes,
        },
    )
    manifest_sha = sha256_bytes(manifest_bytes)
    lifecycle_status = status
    entry = {
        "datasetId": dataset_id,
        "market": MARKET,
        "creationStatus": status,
        "lifecycleStatus": lifecycle_status,
        "statusHistory": [
            {
                "from": None,
                "to": lifecycle_status,
                "changedAt": manifest["createdAt"],
                "codeCommit": code_commit,
                "reason": "initial registration",
            }
        ],
        "path": f"a-share/{dataset_id}",
        "panelSha256": panel_sha,
        "manifestSha256": manifest_sha,
    }
    write_index(output_root, entry)
    return {
        "datasetId": dataset_id,
        "snapshot": str(snapshot_dir),
        "reusedExisting": False,
        "manifest": manifest,
        "manifestSha256": manifest_sha,
    }


def parse_snapshot_panel(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        raise DatasetError(f"snapshot panel missing: {path}")
    rows: list[dict[str, Any]] = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != PANEL_COLUMNS:
            raise DatasetError("snapshot panel columns do not match the versioned contract")
        for raw in reader:
            row: dict[str, Any] = {}
            for field in PANEL_COLUMNS:
                value = raw.get(field)
                if field in {"date", "code", "name"} or field.startswith("targetDate"):
                    row[field] = value or None
                elif field.startswith(("horizonSessions", "absoluteUp", "outperformance", "topQuartile", "realizedRank")):
                    numeric = maybe_float(value)
                    row[field] = None if numeric is None else int(numeric)
                else:
                    row[field] = maybe_float(value)
            rows.append(row)
    return rows


def _verify_source_files(source: dict[str, Any]) -> None:
    files = source.get("files")
    if not isinstance(files, list) or not files:
        raise DatasetError("source manifest files must be a non-empty list")
    seen: set[tuple[str, str]] = set()
    for record in files:
        if not isinstance(record, dict):
            raise DatasetError("source manifest file record must be an object")
        kind = record.get("kind")
        path = record.get("path")
        if not isinstance(kind, str) or not kind or not isinstance(path, str) or not path:
            raise DatasetError("source manifest file path/kind invalid")
        key = (kind, path)
        if key in seen:
            raise DatasetError("source manifest contains duplicate path/kind entries")
        seen.add(key)
        require_sha256(record.get("sha256"), "source sha256")
        if record.get("fullFileSha256") != record.get("sha256"):
            raise DatasetError("source manifest fullFileSha256 mismatch")
        require_sha256(record.get("usedContentSha256"), "source usedContentSha256")
        if not isinstance(record.get("bytes"), int) or record["bytes"] < 0:
            raise DatasetError("source manifest bytes invalid")
        if not isinstance(record.get("usedRows"), int) or record["usedRows"] < 0:
            raise DatasetError("source manifest usedRows invalid")
        for field in ("usedStart", "usedEnd"):
            if record.get(field) is not None:
                require_date(record[field], f"source {field}")
    feature_file = source.get("featureFile")
    if not isinstance(feature_file, dict) or sum(1 for record in files if record == feature_file) != 1:
        raise DatasetError("sourceManifest.featureFile does not match exactly one files record")
    if feature_file.get("kind") != "feature-panel":
        raise DatasetError("sourceManifest.featureFile must be the feature-panel record")


def _identity_from_manifest(manifest: dict[str, Any]) -> dict[str, Any]:
    taxonomy = manifest.get("taxonomy", {})
    calendar = manifest.get("calendar", {})
    panel = manifest.get("panel", {})
    contracts = manifest.get("contracts", {})
    benchmark = manifest.get("benchmark", {})
    return {
        "market": manifest.get("market"),
        "dataAsOf": manifest.get("dataAsOf"),
        "panelUncompressedSha256": panel.get("uncompressedSha256"),
        "datasetSchemaVersion": manifest.get("schemaVersion"),
        "labelContractVersion": contracts.get("labels"),
        "featureContractVersion": contracts.get("features"),
        "benchmarkContractVersion": contracts.get("benchmark"),
        "benchmarkCode": benchmark.get("code"),
        "taxonomySha256": taxonomy.get("canonicalSha256"),
        "calendarSha256": calendar.get("sessionCalendarSha256"),
    }


def verify_rows(rows: list[dict[str, Any]], manifest: dict[str, Any], source: dict[str, Any]) -> None:
    if not rows:
        raise DatasetError("snapshot panel has no rows")
    taxonomy = read_json(rotation.TAXONOMY_PATH)
    expected_codes = {str(item["code"]) for item in taxonomy["indices"]}
    ranked_universe = source.get("rankedUniverse")
    if not isinstance(ranked_universe, dict) or not isinstance(ranked_universe.get("codes"), list):
        raise DatasetError("source manifest ranked universe is invalid")
    benchmark_code = manifest.get("benchmark", {}).get("code")
    if benchmark_code in ranked_universe["codes"]:
        raise DatasetError("benchmark entered ranked universe")
    if set(str(code) for code in ranked_universe["codes"]) != expected_codes:
        raise DatasetError("source ranked universe does not match taxonomy")
    by_date = validate_feature_cross_sections(rows, expected_codes)
    ordered_keys = [(str(row["date"]), str(row["code"])) for row in rows]
    if ordered_keys != sorted(ordered_keys):
        raise DatasetError("panel is not stably sorted by date/code")
    market_days = source.get("marketCalendarDays")
    if not isinstance(market_days, list) or not all(isinstance(date, str) for date in market_days):
        raise DatasetError("source manifest market calendar is invalid")
    if market_days != sorted(market_days) or len(market_days) != len(set(market_days)):
        raise DatasetError("source manifest market calendar must be unique and sorted")
    if source.get("marketCalendarSha256") != sha256_bytes(canonical_json(market_days)):
        raise DatasetError("source manifest market calendar hash mismatch")
    positions = {date: index for index, date in enumerate(market_days)}
    for date, date_rows in by_date.items():
        if date not in positions:
            raise DatasetError(f"feature date is absent from source calendar: {date}")
        for horizon in HORIZONS:
            suffix = str(horizon)
            target = date_rows[0].get(f"targetDate{suffix}")
            values = [row.get(f"targetDate{suffix}") for row in date_rows]
            if any(value != target for value in values):
                raise DatasetError(f"target date differs within cross-section: {date} h{horizon}")
            horizon_fields = [field for field in label_columns() if field.endswith(suffix)]
            if target is None:
                if any(row.get(field) is not None for row in date_rows for field in horizon_fields):
                    raise DatasetError(f"immature label is not null: {date} h{horizon}")
                continue
            if not isinstance(target, str) or target <= date or positions.get(target) != positions[date] + horizon:
                raise DatasetError(f"wrong target-date trading-session advance for {date} h{horizon}")
            ranked: list[tuple[float, str, dict[str, Any]]] = []
            for row in date_rows:
                for field in horizon_fields:
                    if row.get(field) is None:
                        raise DatasetError(f"mature label field is null: {date} {field}")
                if int(row[f"horizonSessions{suffix}"]) != horizon:
                    raise DatasetError(f"wrong horizon session count: {date} h{horizon}")
                sector_return = float(row[f"sectorEndClose{suffix}"]) / float(row[f"sectorStartClose{suffix}"]) - 1
                benchmark_return = float(row[f"benchmarkEndClose{suffix}"]) / float(row[f"benchmarkStartClose{suffix}"]) - 1
                excess = sector_return - benchmark_return
                tolerance = 1e-12
                if (
                    abs(float(row[f"sectorForwardReturn{suffix}"]) - sector_return) > tolerance
                    or abs(float(row[f"benchmarkForwardReturn{suffix}"]) - benchmark_return) > tolerance
                    or abs(float(row[f"excessForwardReturn{suffix}"]) - excess) > tolerance
                    or abs(float(row[f"expectedExcess{suffix}"]) - excess) > tolerance
                ):
                    raise DatasetError(f"wrong return/excess label: {date} {row['code']} h{horizon}")
                if int(row[f"absoluteUp{suffix}"]) != int(sector_return > 0):
                    raise DatasetError(f"wrong absolute label: {date} {row['code']} h{horizon}")
                if int(row[f"outperformance{suffix}"]) != int(excess > 0):
                    raise DatasetError(f"wrong outperformance label: {date} {row['code']} h{horizon}")
                ranked.append((excess, str(row["code"]), row))
            ranked.sort(key=lambda item: (-item[0], item[1]))
            top_count = math.ceil(len(ranked) * TOP_QUARTILE_FRACTION)
            for rank, (_excess, _code, row) in enumerate(ranked, start=1):
                if int(row[f"realizedRank{suffix}"]) != rank or int(row[f"topQuartile{suffix}"]) != int(rank <= top_count):
                    raise DatasetError(f"wrong top-quartile tie-break or rank: {date} {row['code']} h{horizon}")
                expected_percentile = 1 - (rank - 1) / max(1, len(ranked) - 1)
                if abs(float(row[f"realizedRankPercentile{suffix}"]) - expected_percentile) > 1e-12:
                    raise DatasetError(f"wrong realized rank percentile: {date} {row['code']} h{horizon}")


def _verify_index_entry(snapshot: Path, manifest: dict[str, Any]) -> None:
    index_path = snapshot.parents[1] / INDEX_NAME
    if not index_path.exists():
        return
    index = read_json(index_path)
    entries = index.get("datasets")
    if not isinstance(entries, list):
        raise DatasetError("dataset index has invalid datasets array")
    entry = next((item for item in entries if item.get("datasetId") == manifest.get("datasetId")), None)
    if entry is None:
        raise DatasetError("snapshot is missing from dataset index")
    if entry.get("path") != f"a-share/{manifest['datasetId']}":
        raise DatasetError("dataset index path mismatch")
    if entry.get("manifestSha256") != sha256_path(snapshot / SNAPSHOT_MANIFEST_NAME):
        raise DatasetError("index manifest hash mismatch")
    if entry.get("panelSha256") != manifest.get("panel", {}).get("sha256"):
        raise DatasetError("index panel hash mismatch")


def verify_snapshot(snapshot: Path) -> dict[str, Any]:
    manifest_path = snapshot / SNAPSHOT_MANIFEST_NAME
    manifest = read_json(manifest_path)
    required = {
        "schemaVersion", "datasetId", "identitySha256", "identityComponents", "status", "market", "createdAt",
        "codeCommit", "dataAsOf", "taxonomy", "benchmark", "calendar", "contracts", "panel", "maturity",
        "quality", "sourceManifest", "labelDiagnostics", "warnings",
    }
    if not required.issubset(manifest) or manifest.get("schemaVersion") != DATASET_SCHEMA_VERSION or manifest.get("market") != MARKET:
        raise DatasetError("snapshot manifest does not satisfy prediction dataset schema")
    if snapshot.name != manifest["datasetId"]:
        raise DatasetError("snapshot directory and manifest datasetId differ")
    require_date(manifest["dataAsOf"], "manifest.dataAsOf")
    require_sha256(manifest["identitySha256"], "manifest.identitySha256")
    panel = manifest.get("panel", {})
    panel_path = snapshot / str(panel.get("path"))
    compressed = panel_path.read_bytes() if panel_path.exists() else b""
    if len(compressed) < 10 or compressed[3] & 0x08 or int.from_bytes(compressed[4:8], "little") != 0:
        raise DatasetError("snapshot gzip must use mtime=0 and an empty filename")
    if sha256_bytes(compressed) != panel.get("sha256"):
        raise DatasetError("snapshot panel hash mismatch")
    try:
        raw = gzip.decompress(compressed)
    except OSError as exc:
        raise DatasetError("snapshot panel gzip is invalid") from exc
    if sha256_bytes(raw) != panel.get("uncompressedSha256"):
        raise DatasetError("snapshot uncompressed panel hash mismatch")
    if panel.get("compressedBytes") != len(compressed) or panel.get("uncompressedBytes") != len(raw):
        raise DatasetError("snapshot panel byte count mismatch")
    source_ref = manifest.get("sourceManifest", {})
    source_path = snapshot / str(source_ref.get("path"))
    if not source_path.exists() or sha256_path(source_path) != source_ref.get("sha256"):
        raise DatasetError("source manifest hash mismatch")
    diagnostics_ref = manifest.get("labelDiagnostics", {})
    diagnostics_path = snapshot / str(diagnostics_ref.get("path"))
    if not diagnostics_path.exists() or sha256_path(diagnostics_path) != diagnostics_ref.get("sha256"):
        raise DatasetError("label diagnostics hash mismatch")
    source = read_json(source_path)
    _verify_source_files(source)
    market_days = source.get("marketCalendarDays")
    calendar = manifest.get("calendar", {})
    session_hash = sha256_bytes(canonical_json(market_days)) if isinstance(market_days, list) else None
    if (
        calendar.get("id") != "a-share-benchmark-session-calendar-v1"
        or calendar.get("source") != "benchmark-history"
        or calendar.get("sha256") != session_hash
        or calendar.get("sessionCalendarSha256") != session_hash
        or source.get("marketCalendarSha256") != session_hash
        or calendar.get("sessions") != len(market_days or [])
        or calendar.get("firstDate") != (market_days[0] if market_days else None)
        or calendar.get("lastDate") != (market_days[-1] if market_days else None)
    ):
        raise DatasetError("calendar hash or benchmark session lineage mismatch")
    holiday = calendar.get("holidayArtifact", {})
    if holiday.get("sha256") != calendar.get("holidayArtifactSha256"):
        raise DatasetError("holiday calendar artifact hash mismatch")
    if holiday.get("path") != _relative_source_path(rotation.CALENDAR_PATH) or holiday.get("sha256") != sha256_path(rotation.CALENDAR_PATH):
        raise DatasetError("holiday calendar artifact lineage mismatch")
    taxonomy = read_json(rotation.TAXONOMY_PATH)
    taxonomy_meta = manifest.get("taxonomy", {})
    if taxonomy_meta.get("canonicalSha256") != sha256_bytes(canonical_json(taxonomy)):
        raise DatasetError("taxonomy canonical hash mismatch")
    if taxonomy_meta.get("sourceFileSha256") != sha256_path(rotation.TAXONOMY_PATH):
        raise DatasetError("taxonomy source file hash mismatch")
    if manifest.get("benchmark", {}).get("code") != "000985":
        raise DatasetError("benchmark contract code mismatch")
    identity = _identity_from_manifest(manifest)
    if manifest.get("identityComponents") != identity or sha256_bytes(canonical_json(identity)) != manifest.get("identitySha256"):
        raise DatasetError("dataset identity mismatch")
    expected_dataset_id = f"a-share-{manifest['dataAsOf']}-{manifest['identitySha256'][:12]}"
    if manifest["datasetId"] != expected_dataset_id:
        raise DatasetError("dataset identity mismatch")
    rows = parse_snapshot_panel(panel_path)
    if panel.get("rows") != len(rows) or panel.get("dates") != len({str(row["date"]) for row in rows}) or panel.get("sectors") != 12:
        raise DatasetError("manifest panel dimensions mismatch")
    if panel.get("columns") != PANEL_COLUMNS:
        raise DatasetError("manifest panel column contract mismatch")
    verify_rows(rows, manifest, source)
    diagnostics = read_json(diagnostics_path)
    if diagnostics != label_diagnostics(rows):
        raise DatasetError("label diagnostics content mismatch")
    maturity, missing_labels = maturity_summary(rows)
    if manifest.get("maturity") != maturity or manifest.get("quality", {}).get("missingLabelValuesByHorizon") != missing_labels:
        raise DatasetError("manifest maturity summary mismatch")
    _verify_index_entry(snapshot, manifest)
    return manifest


def load_verified_snapshot(snapshot: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = verify_snapshot(snapshot)
    return manifest, parse_snapshot_panel(snapshot / SNAPSHOT_PANEL_NAME)


def inspect_snapshot(snapshot: Path) -> dict[str, Any]:
    manifest, rows = load_verified_snapshot(snapshot)
    return {
        "datasetId": manifest["datasetId"],
        "identitySha256": manifest["identitySha256"],
        "dataAsOf": manifest["dataAsOf"],
        "rows": len(rows),
        "dates": manifest["panel"]["dates"],
        "sectors": manifest["panel"]["sectors"],
        "panelSha256": manifest["panel"]["sha256"],
        "maturity": manifest["maturity"],
        "quality": manifest["quality"],
        "labelDiagnostics": read_json(snapshot / LABEL_DIAGNOSTICS_NAME),
    }


def diff_snapshots(left: Path, right: Path) -> dict[str, Any]:
    left_manifest, left_rows = load_verified_snapshot(left)
    right_manifest, right_rows = load_verified_snapshot(right)
    left_by_key = {(str(row["date"]), str(row["code"])): row for row in left_rows}
    right_by_key = {(str(row["date"]), str(row["code"])): row for row in right_rows}
    shared = sorted(set(left_by_key) & set(right_by_key))
    changed_fields: dict[str, dict[str, Any]] = {}
    label_changes = 0
    for field in PANEL_COLUMNS:
        changed = 0
        max_abs = 0.0
        for key in shared:
            a, b = left_by_key[key].get(field), right_by_key[key].get(field)
            if a != b:
                changed += 1
                if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                    max_abs = max(max_abs, abs(float(a) - float(b)))
        if changed:
            changed_fields[field] = {"changedRows": changed, "maxAbsoluteDifference": max_abs}
            if field in label_columns():
                label_changes += changed
    left_dates = {row["date"] for row in left_rows}
    right_dates = {row["date"] for row in right_rows}
    result = {
        "left": {"datasetId": left_manifest["datasetId"], "panelSha256": left_manifest["panel"]["sha256"]},
        "right": {"datasetId": right_manifest["datasetId"], "panelSha256": right_manifest["panel"]["sha256"]},
        "addedDates": sorted(right_dates - left_dates),
        "removedDates": sorted(left_dates - right_dates),
        "addedKeys": len(set(right_by_key) - set(left_by_key)),
        "removedKeys": len(set(left_by_key) - set(right_by_key)),
        "changedFields": changed_fields,
        "labelChanges": label_changes,
        "contractVersionChanges": {
            key: [left_manifest["contracts"].get(key), right_manifest["contracts"].get(key)]
            for key in sorted(set(left_manifest["contracts"]) | set(right_manifest["contracts"]))
            if left_manifest["contracts"].get(key) != right_manifest["contracts"].get(key)
        },
    }
    result["identical"] = (
        not result["addedDates"]
        and not result["removedDates"]
        and not result["addedKeys"]
        and not result["removedKeys"]
        and not changed_fields
        and not result["contractVersionChanges"]
    )
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--market", required=True, choices=["a-share"])
    build.add_argument("--feature-file", required=True)
    build.add_argument("--history-dir", required=True)
    build.add_argument("--benchmark-history", required=True)
    build.add_argument("--as-of", required=True)
    build.add_argument("--output-root", default="models/sector-rotation/datasets")
    build.add_argument("--code-commit", required=True)
    build.add_argument("--status", choices=["active", "candidate", "legacy_recovered"], default="candidate")
    build.add_argument("--label-contract-version", default=A_SHARE_LABEL_CONTRACT_VERSION)
    verify = commands.add_parser("verify")
    verify.add_argument("--snapshot", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--snapshot", required=True)
    diff = commands.add_parser("diff")
    diff.add_argument("--left", required=True)
    diff.add_argument("--right", required=True)
    set_status = commands.add_parser("set-status")
    set_status.add_argument("--output-root", default="models/sector-rotation/datasets")
    set_status.add_argument("--dataset-id", required=True)
    set_status.add_argument("--status", required=True, choices=["active", "superseded", "retired"])
    set_status.add_argument("--reason", required=True)
    set_status.add_argument("--code-commit", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "build":
            result = build_snapshot(
                Path(args.feature_file).resolve(),
                Path(args.output_root).resolve(),
                args.code_commit,
                args.status,
                as_of=args.as_of,
                history_dir=Path(args.history_dir).resolve(),
                benchmark_history_file=Path(args.benchmark_history).resolve(),
                label_contract_version=args.label_contract_version,
            )
        elif args.command == "verify":
            manifest = verify_snapshot(Path(args.snapshot).resolve())
            result = {"datasetId": manifest["datasetId"], "verified": True}
        elif args.command == "inspect":
            result = inspect_snapshot(Path(args.snapshot).resolve())
        elif args.command == "diff":
            result = diff_snapshots(Path(args.left).resolve(), Path(args.right).resolve())
        else:
            result = set_dataset_status(
                Path(args.output_root).resolve(), args.dataset_id, args.status, args.reason, args.code_commit
            )
    except DatasetError as exc:
        raise SystemExit(f"prediction dataset error: {exc}") from exc
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
