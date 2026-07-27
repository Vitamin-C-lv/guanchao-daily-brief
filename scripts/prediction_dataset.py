#!/usr/bin/env python3
"""Build, verify, inspect and diff immutable A-share prediction datasets.

This is the only module which creates supervised prediction labels.  The live
rotation pipeline remains responsible for raw CSI histories and point-in-time
price/volume features; training reads a verified snapshot produced here.
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
import shutil
import tempfile
from collections import defaultdict
from dataclasses import asdict, dataclass
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


class DatasetError(RuntimeError):
    """A deterministic dataset-contract failure."""


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


@dataclass(frozen=True)
class DatasetSourceManifest:
    schemaVersion: int
    featureFile: dict[str, Any]
    files: list[dict[str, Any]]
    marketCalendarDays: list[str]
    marketCalendarSha256: str


@dataclass(frozen=True)
class DatasetSnapshotManifest:
    schemaVersion: int
    datasetId: str
    status: str
    market: str
    createdAt: str
    codeCommit: str
    dataAsOf: str
    featureStart: str
    featureEnd: str
    taxonomy: dict[str, str]
    benchmark: dict[str, str]
    calendar: dict[str, str]
    contracts: dict[str, str]
    horizons: list[int]
    targets: list[str]
    panel: dict[str, Any]
    maturity: dict[str, Any]
    quality: dict[str, Any]
    sourceManifest: dict[str, str]
    warnings: list[str]


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


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


def contract_for_a_share(taxonomy: dict[str, Any]) -> PredictionDatasetContract:
    benchmark = BenchmarkContract(
        code="000985",
        name="中证全指",
        contractVersion=A_SHARE_BENCHMARK_CONTRACT_VERSION,
        source=rotation.CSI_API,
    )
    return PredictionDatasetContract(
        schemaVersion=DATASET_SCHEMA_VERSION,
        labelContractVersion=A_SHARE_LABEL_CONTRACT_VERSION,
        featureContractVersion=A_SHARE_FEATURE_CONTRACT_VERSION,
        market=MARKET,
        timezone=TIMEZONE,
        calendar="a-share-benchmark-trading-days-v1",
        rankedUniverse=str(taxonomy["documentVersion"]),
        benchmark=benchmark,
        horizons=HORIZONS,
        predictionCutoff="feature-date close; future returns exclude feature-date session",
        priceField="close",
        returnMethod="close-to-close simple return",
        topQuartileFraction=TOP_QUARTILE_FRACTION,
        topQuartileTieBreak=("expected_excess_desc", "sector_code_asc"),
        minimumCrossSection=MINIMUM_CROSS_SECTION,
        missingPolicy=(
            "never coerce missing values to zero; official A-share training labels require "
            "all 12 ranked sectors and benchmark start/end closes"
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
        fields.extend([
            f"targetDate{suffix}", f"horizonSessions{suffix}",
            f"sectorStartClose{suffix}", f"sectorEndClose{suffix}",
            f"benchmarkStartClose{suffix}", f"benchmarkEndClose{suffix}",
            f"sectorForwardReturn{suffix}", f"benchmarkForwardReturn{suffix}",
            f"excessForwardReturn{suffix}", f"absoluteUp{suffix}",
            f"outperformance{suffix}", f"topQuartile{suffix}",
            f"expectedExcess{suffix}", f"realizedRank{suffix}",
            f"realizedRankPercentile{suffix}",
        ])
    return fields


PANEL_COLUMNS = [*feature_columns(), *label_columns()]


def read_feature_file(path: Path, required_codes: set[str]) -> list[dict[str, Any]]:
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
            if not code or not date:
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


def load_price_histories(codes: Iterable[str]) -> tuple[dict[str, dict[str, float]], dict[str, float]]:
    histories: dict[str, dict[str, float]] = {}
    for code in codes:
        path = rotation.HISTORY_DIR / f"{code}.csv.gz"
        if not path.exists():
            raise DatasetError(f"sector price history missing: {path}")
        histories[code] = {row["date"]: float(row["close"]) for row in rotation.read_history(path)}
    if not rotation.BENCHMARK_HISTORY_PATH.exists():
        raise DatasetError(f"benchmark price history missing: {rotation.BENCHMARK_HISTORY_PATH}")
    benchmark = {row["date"]: float(row["close"]) for row in rotation.read_history(rotation.BENCHMARK_HISTORY_PATH)}
    if not benchmark:
        raise DatasetError("benchmark price history is empty")
    return histories, benchmark


def validate_feature_cross_sections(rows: list[dict[str, Any]], required_codes: set[str]) -> dict[str, list[dict[str, Any]]]:
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    keys: set[tuple[str, str]] = set()
    for row in rows:
        key = (str(row["date"]), str(row["code"]))
        if key in keys:
            raise DatasetError(f"duplicate date+code key: {key[0]} {key[1]}")
        keys.add(key)
        by_date[key[0]].append(row)
    if not by_date:
        raise DatasetError("feature file has no rows")
    for date, date_rows in by_date.items():
        codes = {str(row["code"]) for row in date_rows}
        if codes != required_codes or len(date_rows) != len(required_codes):
            missing = sorted(required_codes - codes)
            extra = sorted(codes - required_codes)
            raise DatasetError(
                f"formal A-share date {date} requires the complete 12-sector universe; "
                f"missing={missing} extra={extra} count={len(date_rows)}"
            )
    return by_date


def empty_labels(row: dict[str, Any]) -> None:
    for field in label_columns():
        row[field] = None


def create_labelled_rows(
    feature_rows: list[dict[str, Any]],
    required_codes: set[str],
    price_histories: dict[str, dict[str, float]],
    benchmark_history: dict[str, float],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Attach all A-share labels using the explicit benchmark trading-day sequence."""
    if "000985" in required_codes:
        raise DatasetError("benchmark 000985 must not enter the ranked universe")
    by_date = validate_feature_cross_sections(feature_rows, required_codes)
    for code in required_codes:
        if code not in price_histories:
            raise DatasetError(f"price history missing ranked-universe code {code}")
    # A market-session sequence is independent from a single instrument's
    # close availability. The synchronized industry histories provide the
    # session calendar; a missing benchmark close then rejects that label
    # instead of silently shortening the horizon.
    market_days = sorted(set().union(*(history.keys() for history in price_histories.values()), benchmark_history.keys()))
    day_positions = {date: index for index, date in enumerate(market_days)}
    if len(day_positions) != len(market_days):
        raise DatasetError("benchmark trading calendar contains duplicate dates")
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
                continue  # terminal data is deliberately preserved as immature/null.
            target_date = market_days[target_position]
            if not date < target_date:
                raise DatasetError(f"target date does not follow feature date: {date} h{horizon} {target_date}")
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
                continue  # this date is never a formal training label for this horizon.
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
                row.update({
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
                })
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


def source_file_record(path: Path, kind: str) -> dict[str, Any]:
    if not path.exists():
        raise DatasetError(f"source missing: {path}")
    return {
        "kind": kind,
        "path": str(path.relative_to(rotation.ROOT)).replace("\\", "/") if path.is_relative_to(rotation.ROOT) else path.name,
        "sha256": sha256_path(path),
        "bytes": path.stat().st_size,
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
            "firstTargetDate": min((rows[0][f"targetDate{suffix}"] for rows in by_date.values() if rows[0].get(f"targetDate{suffix}")), default=None),
            "lastTargetDate": max((rows[0][f"targetDate{suffix}"] for rows in by_date.values() if rows[0].get(f"targetDate{suffix}")), default=None),
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
            "absoluteUpPositiveRate": (sum(int(row[f"absoluteUp{suffix}"]) for row in mature) / len(mature)) if mature else None,
            "outperformancePositiveRate": (sum(int(row[f"outperformance{suffix}"]) for row in mature) / len(mature)) if mature else None,
            "topQuartilePositiveRate": (sum(int(row[f"topQuartile{suffix}"]) for row in mature) / len(mature)) if mature else None,
            "crossSectionSizeMin": min((len(by_date[date]) for date in mature_dates), default=0),
            "crossSectionSizeMax": max((len(by_date[date]) for date in mature_dates), default=0),
        }
    return {"schemaVersion": DATASET_SCHEMA_VERSION, "horizons": horizons}


def json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


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


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DatasetError(f"invalid JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DatasetError(f"JSON object required: {path}")
    return value


def write_index(root: Path, entry: dict[str, Any]) -> None:
    path = root / INDEX_NAME
    existing = read_json(path) if path.exists() else {"schemaVersion": DATASET_SCHEMA_VERSION, "datasets": [], "legacyProduction": []}
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


def build_snapshot(
    feature_file: Path,
    output_root: Path,
    code_commit: str,
    status: str = "candidate",
    created_at: str | None = None,
) -> dict[str, Any]:
    if status not in {"active", "candidate", "legacy_recovered", "reproduction_unavailable"}:
        raise DatasetError(f"invalid snapshot status: {status}")
    taxonomy_path = rotation.TAXONOMY_PATH
    taxonomy = read_json(taxonomy_path)
    contract = contract_for_a_share(taxonomy)
    codes = {str(item["code"]) for item in taxonomy["indices"]}
    if len(codes) != 12:
        raise DatasetError("A-share contract requires exactly 12 ranked sectors")
    feature_rows = read_feature_file(feature_file, codes)
    price_histories, benchmark_history = load_price_histories(codes)
    rows, market_days = create_labelled_rows(feature_rows, codes, price_histories, benchmark_history)
    raw_panel, compressed_panel = panel_bytes(rows)
    panel_sha = sha256_bytes(compressed_panel)
    dataset_id = f"a-share-{max(str(row['date']) for row in rows)}-{panel_sha[:12]}"
    snapshot_dir = output_root / "a-share" / dataset_id
    if snapshot_dir.exists():
        manifest = verify_snapshot(snapshot_dir)
        if manifest["panel"]["sha256"] != panel_sha:
            raise DatasetError(f"existing dataset id has different panel content: {dataset_id}")
        return {"datasetId": dataset_id, "snapshot": str(snapshot_dir), "reusedExisting": True, "manifest": manifest}
    source_files = [source_file_record(feature_file, "feature-panel"), source_file_record(taxonomy_path, "taxonomy")]
    calendar_path = rotation.CALENDAR_PATH
    source_files.append(source_file_record(calendar_path, "holiday-calendar"))
    source_files.append(source_file_record(rotation.BENCHMARK_HISTORY_PATH, "benchmark-history"))
    for code in sorted(codes):
        source_files.append(source_file_record(rotation.HISTORY_DIR / f"{code}.csv.gz", "sector-history"))
    source = DatasetSourceManifest(
        schemaVersion=DATASET_SCHEMA_VERSION,
        featureFile=source_files[0],
        files=source_files,
        marketCalendarDays=market_days,
        marketCalendarSha256=sha256_bytes(canonical_json(market_days)),
    )
    source_bytes = json_bytes(asdict(source))
    diagnostics = label_diagnostics(rows)
    diagnostics_bytes = json_bytes(diagnostics)
    maturity, missing_labels = maturity_summary(rows)
    taxonomy_sha = sha256_bytes(canonical_json(taxonomy))
    calendar = read_json(calendar_path)
    calendar_sha = sha256_bytes(canonical_json(calendar))
    date_groups = defaultdict(int)
    for row in rows:
        date_groups[str(row["date"])] += 1
    manifest = DatasetSnapshotManifest(
        schemaVersion=DATASET_SCHEMA_VERSION,
        datasetId=dataset_id,
        status=status,
        market=MARKET,
        createdAt=created_at or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        codeCommit=code_commit,
        dataAsOf=max(str(row["date"]) for row in rows),
        featureStart=min(str(row["date"]) for row in rows),
        featureEnd=max(str(row["date"]) for row in rows),
        taxonomy={"id": str(taxonomy["documentVersion"]), "sha256": taxonomy_sha},
        benchmark={"code": contract.benchmark.code, "name": contract.benchmark.name, "contractVersion": contract.benchmark.contractVersion, "source": contract.benchmark.source},
        calendar={"id": contract.calendar, "sha256": calendar_sha},
        contracts={"dataset": str(DATASET_SCHEMA_VERSION), "features": A_SHARE_FEATURE_CONTRACT_VERSION, "labels": A_SHARE_LABEL_CONTRACT_VERSION, "benchmark": A_SHARE_BENCHMARK_CONTRACT_VERSION},
        horizons=list(HORIZONS),
        targets=["absolute_up", "outperformance", "top_quartile", "expected_excess"],
        panel={"path": SNAPSHOT_PANEL_NAME, "sha256": panel_sha, "uncompressedSha256": sha256_bytes(raw_panel), "rows": len(rows), "dates": len(date_groups), "sectors": len(codes), "columns": PANEL_COLUMNS, "compressedBytes": len(compressed_panel), "uncompressedBytes": len(raw_panel)},
        maturity=maturity,
        quality={"missingFeatureValues": 0, "missingLabelValuesByHorizon": missing_labels, "duplicateKeys": 0, "invalidTargetDates": 0, "crossSectionSizeMin": min(date_groups.values()), "crossSectionSizeMax": max(date_groups.values())},
        sourceManifest={"path": SOURCE_MANIFEST_NAME, "sha256": sha256_bytes(source_bytes)},
        warnings=["candidate snapshot: frozen production featureDataSha256 83d693e8f4c01dc7f50cd53f53aae66a860a428dac1449617aea0ad8a54432be was not recovered"],
    )
    manifest_bytes = json_bytes(asdict(manifest))
    write_new_snapshot(snapshot_dir, {SNAPSHOT_PANEL_NAME: compressed_panel, SOURCE_MANIFEST_NAME: source_bytes, LABEL_DIAGNOSTICS_NAME: diagnostics_bytes, SNAPSHOT_MANIFEST_NAME: manifest_bytes})
    manifest_sha = sha256_bytes(manifest_bytes)
    write_index(output_root, {"datasetId": dataset_id, "market": MARKET, "status": status, "path": f"a-share/{dataset_id}", "panelSha256": panel_sha, "manifestSha256": manifest_sha})
    return {"datasetId": dataset_id, "snapshot": str(snapshot_dir), "reusedExisting": False, "manifest": asdict(manifest), "manifestSha256": manifest_sha}


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


def verify_rows(rows: list[dict[str, Any]], manifest: dict[str, Any], source: dict[str, Any]) -> None:
    if not rows:
        raise DatasetError("snapshot panel has no rows")
    expected_codes = {str(item["code"]) for item in read_json(rotation.TAXONOMY_PATH)["indices"]}
    by_date = validate_feature_cross_sections(rows, expected_codes)
    ordered_keys = [(str(row["date"]), str(row["code"])) for row in rows]
    if ordered_keys != sorted(ordered_keys):
        raise DatasetError("snapshot panel is not in stable date/code order")
    market_days = source.get("marketCalendarDays")
    if not isinstance(market_days, list) or source.get("marketCalendarSha256") != sha256_bytes(canonical_json(market_days)):
        raise DatasetError("source manifest market trading calendar hash mismatch")
    positions = {str(date): index for index, date in enumerate(market_days)}
    for date, date_rows in by_date.items():
        if date not in positions:
            raise DatasetError(f"feature date is absent from source calendar: {date}")
        for horizon in HORIZONS:
            suffix = str(horizon)
            target = date_rows[0].get(f"targetDate{suffix}")
            values = [row.get(f"targetDate{suffix}") for row in date_rows]
            if any(value != target for value in values):
                raise DatasetError(f"target date differs within cross-section: {date} h{horizon}")
            if target is None:
                for field in [f"absoluteUp{suffix}", f"outperformance{suffix}", f"topQuartile{suffix}", f"expectedExcess{suffix}"]:
                    if any(row.get(field) is not None for row in date_rows):
                        raise DatasetError(f"immature label is not null: {date} {field}")
                continue
            if not isinstance(target, str) or target <= date:
                raise DatasetError(f"targetDate must strictly follow featureDate: {date} h{horizon}")
            if positions.get(target) != positions[date] + horizon:
                raise DatasetError(f"targetDate does not advance exactly {horizon} trading sessions: {date}")
            ranked: list[tuple[float, str, dict[str, Any]]] = []
            for row in date_rows:
                for field in [f"sectorStartClose{suffix}", f"sectorEndClose{suffix}", f"benchmarkStartClose{suffix}", f"benchmarkEndClose{suffix}", f"sectorForwardReturn{suffix}", f"benchmarkForwardReturn{suffix}", f"excessForwardReturn{suffix}", f"absoluteUp{suffix}", f"outperformance{suffix}", f"topQuartile{suffix}", f"expectedExcess{suffix}", f"realizedRank{suffix}", f"realizedRankPercentile{suffix}"]:
                    if row.get(field) is None:
                        raise DatasetError(f"mature label field is null: {date} {field}")
                sector_return = float(row[f"sectorEndClose{suffix}"]) / float(row[f"sectorStartClose{suffix}"]) - 1
                benchmark_return = float(row[f"benchmarkEndClose{suffix}"]) / float(row[f"benchmarkStartClose{suffix}"]) - 1
                excess = sector_return - benchmark_return
                tolerance = 1e-12
                if abs(float(row[f"sectorForwardReturn{suffix}"]) - sector_return) > tolerance or abs(float(row[f"benchmarkForwardReturn{suffix}"]) - benchmark_return) > tolerance or abs(float(row[f"excessForwardReturn{suffix}"]) - excess) > tolerance or abs(float(row[f"expectedExcess{suffix}"]) - excess) > tolerance:
                    raise DatasetError(f"return/excess label mismatch: {date} {row['code']} h{horizon}")
                if int(row[f"absoluteUp{suffix}"]) != int(sector_return > 0):
                    raise DatasetError(f"absoluteUp label mismatch: {date} {row['code']} h{horizon}")
                if int(row[f"outperformance{suffix}"]) != int(excess > 0):
                    raise DatasetError(f"outperformance label mismatch: {date} {row['code']} h{horizon}")
                ranked.append((excess, str(row["code"]), row))
            ranked.sort(key=lambda item: (-item[0], item[1]))
            top_count = math.ceil(len(ranked) * TOP_QUARTILE_FRACTION)
            for rank, (_excess, _code, row) in enumerate(ranked, start=1):
                if int(row[f"realizedRank{suffix}"]) != rank or int(row[f"topQuartile{suffix}"]) != int(rank <= top_count):
                    raise DatasetError(f"topQuartile/rank tie-break mismatch: {date} {row['code']} h{horizon}")


def verify_snapshot(snapshot: Path) -> dict[str, Any]:
    manifest = read_json(snapshot / SNAPSHOT_MANIFEST_NAME)
    required = {"schemaVersion", "datasetId", "market", "panel", "contracts", "sourceManifest", "quality", "maturity"}
    if not required.issubset(manifest) or manifest.get("schemaVersion") != DATASET_SCHEMA_VERSION or manifest.get("market") != MARKET:
        raise DatasetError("snapshot manifest does not satisfy prediction dataset schema")
    if snapshot.name != manifest["datasetId"]:
        raise DatasetError("snapshot directory and manifest datasetId differ")
    panel_path = snapshot / str(manifest["panel"].get("path"))
    if sha256_path(panel_path) != manifest["panel"].get("sha256"):
        raise DatasetError("snapshot panel hash mismatch")
    compressed = panel_path.read_bytes()
    raw = gzip.decompress(compressed)
    if sha256_bytes(raw) != manifest["panel"].get("uncompressedSha256"):
        raise DatasetError("snapshot uncompressed panel hash mismatch")
    source_path = snapshot / str(manifest["sourceManifest"].get("path"))
    if sha256_path(source_path) != manifest["sourceManifest"].get("sha256"):
        raise DatasetError("source manifest hash mismatch")
    source = read_json(source_path)
    if not isinstance(source.get("files"), list) or not all(item.get("sha256") for item in source["files"] if isinstance(item, dict)):
        raise DatasetError("source manifest has incomplete source hashes")
    rows = parse_snapshot_panel(panel_path)
    verify_rows(rows, manifest, source)
    if manifest["panel"].get("rows") != len(rows):
        raise DatasetError("manifest panel row count mismatch")
    return manifest


def load_verified_snapshot(snapshot: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    manifest = verify_snapshot(snapshot)
    return manifest, parse_snapshot_panel(snapshot / SNAPSHOT_PANEL_NAME)


def inspect_snapshot(snapshot: Path) -> dict[str, Any]:
    manifest, rows = load_verified_snapshot(snapshot)
    diagnostics = read_json(snapshot / LABEL_DIAGNOSTICS_NAME)
    return {"datasetId": manifest["datasetId"], "dataAsOf": manifest["dataAsOf"], "rows": len(rows), "dates": manifest["panel"]["dates"], "sectors": manifest["panel"]["sectors"], "panelSha256": manifest["panel"]["sha256"], "maturity": manifest["maturity"], "quality": manifest["quality"], "labelDiagnostics": diagnostics}


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
    result = {"left": {"datasetId": left_manifest["datasetId"], "panelSha256": left_manifest["panel"]["sha256"]}, "right": {"datasetId": right_manifest["datasetId"], "panelSha256": right_manifest["panel"]["sha256"]}, "addedDates": sorted(right_dates - left_dates), "removedDates": sorted(left_dates - right_dates), "addedKeys": len(set(right_by_key) - set(left_by_key)), "removedKeys": len(set(left_by_key) - set(right_by_key)), "changedFields": changed_fields, "labelChanges": label_changes, "contractVersionChanges": {key: [left_manifest["contracts"].get(key), right_manifest["contracts"].get(key)] for key in sorted(set(left_manifest["contracts"]) | set(right_manifest["contracts"])) if left_manifest["contracts"].get(key) != right_manifest["contracts"].get(key)}}
    result["identical"] = not result["addedDates"] and not result["removedDates"] and not result["addedKeys"] and not result["removedKeys"] and not changed_fields and not result["contractVersionChanges"]
    return result


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    build = commands.add_parser("build")
    build.add_argument("--market", required=True, choices=["a-share"])
    build.add_argument("--feature-file", required=True)
    build.add_argument("--output-root", default="models/sector-rotation/datasets")
    build.add_argument("--code-commit", required=True)
    build.add_argument("--status", choices=["active", "candidate", "legacy_recovered"], default="candidate")
    verify = commands.add_parser("verify")
    verify.add_argument("--snapshot", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("--snapshot", required=True)
    diff = commands.add_parser("diff")
    diff.add_argument("--left", required=True)
    diff.add_argument("--right", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        if args.command == "build":
            result = build_snapshot(Path(args.feature_file).resolve(), Path(args.output_root).resolve(), args.code_commit, args.status)
        elif args.command == "verify":
            manifest = verify_snapshot(Path(args.snapshot).resolve())
            result = {"datasetId": manifest["datasetId"], "verified": True}
        elif args.command == "inspect":
            result = inspect_snapshot(Path(args.snapshot).resolve())
        else:
            result = diff_snapshots(Path(args.left).resolve(), Path(args.right).resolve())
    except DatasetError as exc:
        raise SystemExit(f"prediction dataset error: {exc}") from exc
    print(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2))


if __name__ == "__main__":
    main()
