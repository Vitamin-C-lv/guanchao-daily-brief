#!/usr/bin/env python3
"""Build and validate the private three-market research core.

The command is deliberately offline after the fetch step.  It consumes the
explicit private cache produced by the supplied acquisition package, creates
content-addressed normalized panels, derives prior-only features and labels,
and evaluates small regularized logistic models with purged walk-forward
splits.  It never writes production content, production models, or the
prediction ledger.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any, Iterable

try:
    import numpy as np
except ImportError as exc:  # pragma: no cover - the project runner supplies numpy
    raise SystemExit("numpy is required; run through uv with --with numpy") from exc


ROOT = Path(__file__).resolve().parents[1]
HORIZONS = (1, 5, 20)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SHA_RE = re.compile(r"^[a-f0-9]{64}$")
PANEL_SCHEMA = "three-market-panel-v1"
MANIFEST_SCHEMA = "three-market-panel-manifest-v1"
FEATURE_SCHEMA = "three-market-features-v1"
LABEL_SCHEMA = "three-market-labels-v1"

PRICE_FEATURES = (
    "return_1d",
    "return_5d",
    "return_20d",
    "volatility_20d",
    "distance_ma20",
    "distance_ma60",
    "drawdown_60d",
)
HK_FEATURES = PRICE_FEATURES + (
    "relative_return_1d",
    "relative_return_5d",
    "relative_return_20d",
    "hibor_overnight",
    "hibor_1m",
    "hibor_overnight_change_1d",
    "hibor_1m_change_1d",
    "usd_hkd",
    "usd_hkd_change_1d",
    "us2y",
    "us10y",
    "curve_2s10s",
    "us2y_change_1d",
    "us10y_change_1d",
)
US_FEATURES = PRICE_FEATURES + (
    "us2y",
    "us10y",
    "curve_2s10s",
    "vix",
    "vix_change_1d",
    "semiconductor_relative_return_20d",
    "us2y_change_1d",
    "us10y_change_1d",
)


class ThreeMarketError(RuntimeError):
    """A fail-closed data, identity, or model-core error."""


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def pretty_json(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_path(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def iso_now() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="strict")


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ThreeMarketError(f"invalid JSON: {path}: {exc}") from exc


def require_date(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ThreeMarketError(f"{label} must be YYYY-MM-DD")
    raw = value.strip()
    candidate = raw[:10]
    if "/" in raw:
        for pattern in ("%m/%d/%Y", "%Y/%m/%d"):
            try:
                candidate = dt.datetime.strptime(raw[:10], pattern).date().isoformat()
                break
            except ValueError:
                continue
    if not DATE_RE.fullmatch(candidate):
        raise ThreeMarketError(f"{label} must be YYYY-MM-DD: {value}")
    try:
        parsed = dt.date.fromisoformat(candidate)
    except ValueError as exc:
        raise ThreeMarketError(f"{label} is not a real date: {value}") from exc
    if parsed.isoformat() != candidate:
        raise ThreeMarketError(f"{label} is not canonical: {value}")
    return candidate


def finite_number(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in {".", "NA", "N/A", "null", "None", "-"}:
        return None
    try:
        number = float(text.replace(",", ""))
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def positive_number(value: Any) -> float | None:
    number = finite_number(value)
    if number is None:
        return None
    return number if number > 0 else None


def source_map(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ThreeMarketError("source manifest has no sources")
    result = {}
    for source in sources:
        source_id = source.get("id")
        if not isinstance(source_id, str) or not source_id:
            raise ThreeMarketError("source manifest contains an invalid source id")
        if source_id in result:
            raise ThreeMarketError(f"duplicate source id: {source_id}")
        result[source_id] = source
    return result


def payload_path(cache: Path, source_id: str) -> Path | None:
    folder = cache / "raw" / source_id
    if not folder.is_dir():
        return None
    candidates = sorted(path for path in folder.iterdir() if path.is_file() and path.name != "meta.json")
    return candidates[0] if candidates else None


def load_cache_metadata(cache: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"fetch": {}, "validation": {}, "meta": {}}
    fetch_path = cache / "fetch-results.json"
    if fetch_path.is_file():
        fetch = read_json(fetch_path)
        for item in fetch.get("results", []):
            result["fetch"][item.get("sourceId")] = item
    validation_path = cache / "validation-report.json"
    if validation_path.is_file():
        validation = read_json(validation_path)
        for item in validation.get("sources", []):
            result["validation"][item.get("sourceId")] = item
    for meta_path in sorted((cache / "raw").glob("*/meta.json")) if (cache / "raw").is_dir() else []:
        meta = read_json(meta_path)
        result["meta"][meta.get("sourceId")] = meta
    return result


def read_csv_rows(path: Path) -> list[dict[str, str]]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            return list(csv.DictReader(handle))
    except (OSError, UnicodeError, csv.Error) as exc:
        raise ThreeMarketError(f"invalid CSV payload: {path}: {exc}") from exc


def read_json_rows(path: Path) -> list[dict[str, Any]]:
    value = read_json(path)
    if isinstance(value, dict):
        for key in ("records", "rows", "data", "datas"):
            rows = value.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    raise ThreeMarketError(f"JSON payload contains no row list: {path}")


def row_value(row: dict[str, Any], keys: Iterable[str]) -> Any:
    normalized = {str(key).strip().lower(): value for key, value in row.items()}
    for key in keys:
        if key.lower() in normalized:
            return normalized[key.lower()]
    return None


def series_from_payload(source: dict[str, Any], payload: Path, *, field_keys: tuple[str, ...] = ()) -> dict[str, float]:
    source_id = str(source["id"])
    values: dict[str, float] = {}
    if source.get("format") == "yahoo_chart_json":
        value = read_json(payload)
        rows = value.get("rows", []) if isinstance(value, dict) else []
        for index, row in enumerate(rows, start=1):
            if not isinstance(row, dict):
                continue
            date_value = row.get("date")
            close = row.get("close")
            if date_value is None:
                continue
            date_value = require_date(str(date_value), f"{source_id} row {index} date")
            number = positive_number(close)
            if number is not None:
                if date_value in values:
                    raise ThreeMarketError(f"duplicate {source_id} date: {date_value}")
                values[date_value] = number
    elif source.get("format") == "json_paginated":
        for index, row in enumerate(read_json_rows(payload), start=1):
            date_value = row_value(row, ("date", "end_of_day", "end_of_date", "end_of_month"))
            if date_value is None:
                continue
            date_value = require_date(str(date_value), f"{source_id} row {index} date")
            raw_value = row_value(row, field_keys)
            number = finite_number(raw_value)
            if number is not None:
                if date_value in values:
                    raise ThreeMarketError(f"duplicate {source_id} date: {date_value}")
                values[date_value] = number
    else:
        for index, row in enumerate(read_csv_rows(payload), start=1):
            date_value = row_value(row, ("date", "observation_date"))
            if date_value is None:
                continue
            date_value = require_date(str(date_value), f"{source_id} row {index} date")
            keys = field_keys or ("value", "close", "adjclose")
            raw_value = row_value(row, keys)
            if raw_value is None:
                # FRED series use observation_date plus the series id as the
                # value column (for example DGS2), while Cboe uses CLOSE.
                for key, candidate in row.items():
                    if str(key).strip().lower() not in {"date", "observation_date"} and finite_number(candidate) is not None:
                        raw_value = candidate
                        break
            number = finite_number(raw_value)
            if number is not None:
                if date_value in values:
                    raise ThreeMarketError(f"duplicate {source_id} date: {date_value}")
                values[date_value] = number
    start = source.get("startDate")
    if start:
        start = require_date(start, f"{source_id} startDate")
        values = {date: value for date, value in values.items() if date >= start}
    return dict(sorted(values.items()))


def raw_row_count(source: dict[str, Any], payload: Path | None) -> int:
    if payload is None:
        return 0
    try:
        if source.get("format") == "csv":
            return len(read_csv_rows(payload))
        return len(read_json_rows(payload))
    except ThreeMarketError:
        return 0


def source_date_range(source: dict[str, Any], payload: Path | None) -> tuple[str | None, str | None]:
    if payload is None:
        return None, None
    dates: list[str] = []
    try:
        if source.get("format") == "csv":
            rows = read_csv_rows(payload)
        elif source.get("format") == "yahoo_chart_json":
            rows = read_json(payload).get("rows", [])
        else:
            rows = read_json_rows(payload)
        for row in rows:
            value = row_value(row, ("date", "observation_date", "end_of_day", "end_of_date"))
            if value:
                try:
                    dates.append(require_date(str(value), f"{source['id']} date"))
                except ThreeMarketError:
                    continue
    except ThreeMarketError:
        return None, None
    return (min(dates), max(dates)) if dates else (None, None)


def build_source_audit(manifest: dict[str, Any], cache: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    sources = source_map(manifest)
    metadata = load_cache_metadata(cache)
    audit: list[dict[str, Any]] = []
    for source_id, source in sources.items():
        payload = payload_path(cache, source_id)
        fetch_item = metadata["fetch"].get(source_id, {})
        validation_item = metadata["validation"].get(source_id, {})
        meta = metadata["meta"].get(source_id, {})
        status = fetch_item.get("status") or ("ready" if payload else "unavailable")
        if payload and status != "ready":
            status = "ready" if not fetch_item else status
        first_date, last_date = source_date_range(source, payload)
        parsed_rows = raw_row_count(source, payload)
        rows = parsed_rows if payload and parsed_rows > 0 else validation_item.get("rows")
        if not isinstance(rows, int):
            rows = 0
        item = {
            "sourceId": source_id,
            "market": source.get("market"),
            "role": source.get("role"),
            "provider": source.get("provider"),
            "tier": source.get("tier"),
            "required": bool(source.get("required")),
            "status": status,
            "rows": rows,
            "firstDate": first_date or validation_item.get("firstDate"),
            "lastDate": last_date or validation_item.get("lastDate"),
            "expectedMinRows": source.get("expectedMinRows"),
            "rawSha256": meta.get("sha256") or fetch_item.get("sha256"),
            "rawBytes": meta.get("bytes") or fetch_item.get("bytes"),
            "licenseNote": source.get("licenseNote"),
            "url": source.get("url") or source.get("urlTemplate"),
            "error": fetch_item.get("error") if status != "ready" else None,
            "packageValidationStatus": validation_item.get("status"),
            "packageValidationReasons": validation_item.get("reasons", []),
        }
        audit.append(item)
    required_failures = [item["sourceId"] for item in audit if item["required"] and item["status"] != "ready"]
    return audit, {
        "schemaVersion": "three-market-source-audit-v1",
        "manifestSchemaVersion": manifest.get("schemaVersion"),
        "manifestGeneratedAt": manifest.get("generatedAt"),
        "privateResearchOnly": bool(manifest.get("privateResearchOnly")),
        "rawDataCommitPolicy": manifest.get("rawDataCommitPolicy"),
        "sources": audit,
        "requiredFailures": required_failures,
        "rawHistoryPackaged": False,
    }


def load_series(source: dict[str, Any], cache: Path, *, field_keys: tuple[str, ...] = ()) -> dict[str, float]:
    payload = payload_path(cache, str(source["id"]))
    if payload is None:
        return {}
    return series_from_payload(source, payload, field_keys=field_keys)


def previous_value(series: dict[str, float], date_value: str) -> float | None:
    dates = sorted(date for date in series if date < date_value)
    return series[dates[-1]] if dates else None


def change_1d(series: dict[str, float], date_value: str) -> float | None:
    current = series.get(date_value)
    previous = previous_value(series, date_value)
    if current is None or previous is None or previous == 0:
        return None
    return current / previous - 1.0


def return_at(values: list[float], index: int, horizon: int) -> float | None:
    if index < horizon:
        return None
    previous = values[index - horizon]
    current = values[index]
    if previous <= 0 or current <= 0:
        return None
    return current / previous - 1.0


def derive_price_rows(
    market: str,
    object_id: str,
    object_kind: str,
    series: dict[str, float],
    benchmark: dict[str, float] | None = None,
) -> list[dict[str, Any]]:
    dates = sorted(series)
    values = [series[date_value] for date_value in dates]
    benchmark_values = [benchmark.get(date_value) if benchmark else None for date_value in dates]
    rows: list[dict[str, Any]] = []
    for index, date_value in enumerate(dates):
        close = values[index]
        row: dict[str, Any] = {
            "market": market,
            "objectId": object_id,
            "objectKind": object_kind,
            "date": date_value,
            "sessionIndex": index,
            "close": close,
        }
        for horizon in HORIZONS:
            row[f"return_{horizon}d"] = return_at(values, index, horizon)
            benchmark_return = None
            if benchmark and index >= horizon and benchmark_values[index] is not None and benchmark_values[index - horizon] is not None:
                benchmark_return = benchmark_values[index] / benchmark_values[index - horizon] - 1.0
            row[f"relative_return_{horizon}d"] = (
                row[f"return_{horizon}d"] - benchmark_return
                if row[f"return_{horizon}d"] is not None and benchmark_return is not None
                else None
            )
            target_index = index + horizon
            if target_index < len(values):
                target_close = values[target_index]
                target_return = target_close / close - 1.0 if close > 0 else None
                row[f"targetDate{horizon}"] = dates[target_index]
                row[f"expectedReturn{horizon}"] = target_return
                row[f"absoluteUp{horizon}"] = 1 if target_return is not None and target_return > 0 else 0 if target_return is not None else None
                row[f"relativeOutperformance{horizon}"] = (
                    1 if target_return is not None and benchmark and dates[target_index] in benchmark and benchmark.get(date_value, 0) > 0 and benchmark.get(dates[target_index], 0) > 0 and target_return > benchmark[dates[target_index]] / benchmark[date_value] - 1.0
                    else 0 if target_return is not None and benchmark and dates[target_index] in benchmark and benchmark.get(date_value, 0) > 0 and benchmark.get(dates[target_index], 0) > 0
                    else None
                )
            else:
                row[f"targetDate{horizon}"] = None
                row[f"expectedReturn{horizon}"] = None
                row[f"absoluteUp{horizon}"] = None
                row[f"relativeOutperformance{horizon}"] = None
        row["return_1d"] = row["return_1d"]
        row["return_5d"] = row["return_5d"]
        row["return_20d"] = row["return_20d"]
        returns_20: list[float] = []
        if index >= 20:
            for position in range(index - 19, index + 1):
                previous = values[position - 1]
                current = values[position]
                if previous <= 0 or current <= 0:
                    returns_20 = []
                    break
                returns_20.append(current / previous - 1.0)
        row["volatility_20d"] = float(np.std(returns_20, ddof=0)) if len(returns_20) == 20 else None
        for window in (20, 60):
            row[f"distance_ma{window}"] = (
                close / float(np.mean(values[index - window + 1 : index + 1])) - 1.0
                if index >= window - 1 and all(value > 0 for value in values[index - window + 1 : index + 1])
                else None
            )
        window_values = values[max(0, index - 59) : index + 1]
        row["drawdown_60d"] = close / max(window_values) - 1.0 if window_values and max(window_values) > 0 else None
        rows.append(row)
    return rows


def add_exact_macro(row: dict[str, Any], name: str, series: dict[str, float]) -> None:
    value = series.get(str(row["date"]))
    row[name] = value
    row[f"{name}_change_1d"] = change_1d(series, str(row["date"]))


def build_hk_panels(sources: dict[str, dict[str, Any]], cache: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    hsi = load_series(sources["yahoo_hsi"], cache)
    hstech = load_series(sources["yahoo_hstech"], cache)
    hibor_overnight = load_series(sources["hkma_hibor_fixing"], cache, field_keys=("ir_overnight", "hibor_overnight"))
    hibor_1m = load_series(sources["hkma_hibor_fixing"], cache, field_keys=("ir_1m", "hibor_1m"))
    usd_hkd = load_series(sources["fred_dexhkus"], cache)
    us2y = load_series(sources["fred_dgs2"], cache)
    us10y = load_series(sources["fred_dgs10"], cache)
    rows: list[dict[str, Any]] = []
    for object_id, object_kind, series in (("hsi", "index", hsi), ("hstech", "index", hstech)):
        if object_id == "hstech":
            launch = require_date(sources["yahoo_hstech"].get("startDate", "2020-07-27"), "HSTECH launch date")
            series = {date_value: value for date_value, value in series.items() if date_value >= launch}
        object_rows = derive_price_rows("HK", object_id, object_kind, series, hsi if object_id != "hsi" else None)
        for row in object_rows:
            add_exact_macro(row, "hibor_overnight", hibor_overnight)
            add_exact_macro(row, "hibor_1m", hibor_1m)
            add_exact_macro(row, "usd_hkd", usd_hkd)
            add_exact_macro(row, "us2y", us2y)
            add_exact_macro(row, "us10y", us10y)
            row["curve_2s10s"] = row["us10y"] - row["us2y"] if row["us10y"] is not None and row["us2y"] is not None else None
            row["curve_2s10s_change_1d"] = (
                row["us10y_change_1d"] - row["us2y_change_1d"]
                if row["us10y_change_1d"] is not None and row["us2y_change_1d"] is not None
                else None
            )
        rows.extend(object_rows)
    statuses = {
        "hsi": "ready" if any(row["objectId"] == "hsi" for row in rows) else "unavailable",
        "hstech": "ready" if any(row["objectId"] == "hstech" for row in rows) else "unavailable",
        "hk_innovative_drug": "unavailable",
        "hk_tech_internet": "unavailable",
    }
    return rows, {
        "market": "HK",
        "objects": statuses,
        "themeUnavailableReason": "合法、稳定、可追溯的主题历史未包含在冻结来源清单中；不静默替换为代理。",
        "featureSources": ["yahoo_hsi", "yahoo_hstech", "hkma_hibor_fixing", "hkma_interbank_liquidity", "fred_dexhkus", "fred_dgs2", "fred_dgs10"],
    }


def build_us_panels(sources: dict[str, dict[str, Any]], cache: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    nasdaq = load_series(sources["fred_nasdaqcom"], cache)
    sox = load_series(sources["yahoo_sox"], cache)
    us2y = load_series(sources["fred_dgs2"], cache)
    us10y = load_series(sources["fred_dgs10"], cache)
    vix = load_series(sources["cboe_vix"], cache, field_keys=("close", "vix", "value"))
    rows = derive_price_rows("US_NASDAQ", "nasdaq_composite", "index", nasdaq)
    for row in rows:
        add_exact_macro(row, "us2y", us2y)
        add_exact_macro(row, "us10y", us10y)
        add_exact_macro(row, "vix", vix)
        row["curve_2s10s"] = row["us10y"] - row["us2y"] if row["us10y"] is not None and row["us2y"] is not None else None
        row["curve_2s10s_change_1d"] = (
            row["us10y_change_1d"] - row["us2y_change_1d"]
            if row["us10y_change_1d"] is not None and row["us2y_change_1d"] is not None
            else None
        )
        sox_current = sox.get(str(row["date"]))
        sox_previous = None
        if sox_current is not None:
            sox_dates = sorted(date_value for date_value in sox if date_value < row["date"])
            if len(sox_dates) >= 20:
                sox_previous = sox[sox_dates[-20]]
        nasdaq_return = row.get("return_20d")
        row["semiconductor_relative_return_20d"] = (
            sox_current / sox_previous - 1.0 - nasdaq_return
            if sox_current is not None and sox_previous and nasdaq_return is not None
            else None
        )
    return rows, {
        "market": "US_NASDAQ",
        "objects": {"nasdaq_composite": "ready" if rows else "unavailable"},
        "featureSources": ["fred_nasdaqcom", "fred_dgs2", "fred_dgs10", "cboe_vix", "yahoo_sox"],
    }


def private_panel_columns(market: str) -> tuple[str, ...]:
    features = HK_FEATURES if market == "HK" else US_FEATURES
    columns = ["market", "objectId", "objectKind", "date", "sessionIndex", "close", *features]
    for horizon in HORIZONS:
        columns.extend([f"targetDate{horizon}", f"expectedReturn{horizon}", f"absoluteUp{horizon}"])
        if market == "HK":
            columns.append(f"relativeOutperformance{horizon}")
    return tuple(columns)


def stable_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (float, np.floating)):
        if not math.isfinite(float(value)):
            return ""
        return format(float(value), ".12g")
    return str(value)


def serialize_panel(rows: list[dict[str, Any]], market: str) -> bytes:
    columns = private_panel_columns(market)
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    for row in sorted(rows, key=lambda item: (str(item["date"]), str(item["objectId"]))):
        writer.writerow([stable_cell(row.get(column)) for column in columns])
    return buffer.getvalue().encode("utf-8")


def gzip_bytes(value: bytes) -> bytes:
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as handle:
        handle.write(value)
    return buffer.getvalue()


def panel_statistics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_object: dict[str, list[str]] = {}
    for row in rows:
        by_object.setdefault(str(row["objectId"]), []).append(str(row["date"]))
    objects = {}
    all_dates: list[str] = []
    for object_id, dates in sorted(by_object.items()):
        ordered = sorted(set(dates))
        objects[object_id] = {"rows": len(dates), "sessions": len(ordered), "firstDate": ordered[0], "lastDate": ordered[-1]}
        all_dates.extend(ordered)
    return {
        "rows": len(rows),
        "objects": len(objects),
        "objectStats": objects,
        "firstDate": min(all_dates) if all_dates else None,
        "lastDate": max(all_dates) if all_dates else None,
    }


def raw_lineage(source_ids: Iterable[str], sources: dict[str, dict[str, Any]], cache: Path) -> tuple[dict[str, Any], str]:
    metadata = load_cache_metadata(cache)
    entries = []
    for source_id in sorted(set(source_ids)):
        source = sources.get(source_id, {})
        meta = metadata["meta"].get(source_id, {})
        entries.append({
            "sourceId": source_id,
            "rawSha256": meta.get("sha256"),
            "provider": source.get("provider"),
            "tier": source.get("tier"),
            "licenseNote": source.get("licenseNote"),
        })
    return {"sources": entries, "hashBasis": "canonical-source-lineage-v1"}, sha256_bytes(canonical_json(entries))


def build_manifest(
    market: str,
    rows: list[dict[str, Any]],
    source_ids: Iterable[str],
    sources: dict[str, dict[str, Any]],
    cache: Path,
    panel_path: Path,
    object_status: dict[str, str],
    notes: list[str],
) -> dict[str, Any]:
    panel_csv = serialize_panel(rows, market)
    panel_gzip = gzip_bytes(panel_csv)
    panel_sha = sha256_bytes(panel_gzip)
    raw_lineage_value, raw_identity_sha = raw_lineage(source_ids, sources, cache)
    stats = panel_statistics(rows)
    features = list(HK_FEATURES if market == "HK" else US_FEATURES)
    labels = [f"absoluteUp{horizon}" for horizon in HORIZONS]
    normalized_identity = {
        "market": market,
        "panelSchemaVersion": PANEL_SCHEMA,
        "featureSchemaVersion": FEATURE_SCHEMA,
        "labelSchemaVersion": LABEL_SCHEMA,
        "features": features,
        "labels": labels,
        "horizons": list(HORIZONS),
        "panelSha256": panel_sha,
        "rows": stats["rows"],
        "objects": sorted(stats["objectStats"]),
        "firstDate": stats["firstDate"],
        "lastDate": stats["lastDate"],
    }
    normalized_identity_sha = sha256_bytes(canonical_json(normalized_identity))
    dataset_id = f"{market.lower().replace('_', '-')}-panel-{normalized_identity_sha[:12]}" if rows else None
    return {
        "schemaVersion": MANIFEST_SCHEMA,
        "market": market,
        "status": "ready" if rows else "unavailable",
        "datasetId": dataset_id,
        "rawSnapshotIdentitySha256": raw_identity_sha,
        "rawSnapshotIdentity": raw_lineage_value,
        "normalizedPanelIdentitySha256": normalized_identity_sha,
        "normalizedPanelIdentity": normalized_identity,
        "panel": {
            "path": f"private-panel://stage2-three-market-model-core/{market.lower()}.panel.csv.gz",
            "privatePath": str(panel_path),
            "sha256": panel_sha,
            "uncompressedSha256": sha256_bytes(panel_csv),
            "hashBasis": "deterministic-gzip-mtime-zero-v1",
            "columns": list(private_panel_columns(market)),
            **stats,
        },
        "objects": [{"objectId": object_id, "status": status} for object_id, status in sorted(object_status.items())],
        "features": {"schemaVersion": FEATURE_SCHEMA, "ids": features, "missingPolicy": "preserve-null-never-zero", "priorOnly": True},
        "labels": {"schemaVersion": LABEL_SCHEMA, "horizons": list(HORIZONS), "futureReturnsExcludeFeatureDate": True},
        "sourceLineage": {"rawSnapshotAndNormalizedPanelIdentityAreSeparate": True, "sourceIds": sorted(set(source_ids))},
        "license": {"privateResearchOnly": True, "rawHistoryCommitted": False, "rawHistoryPackaged": False},
        "warnings": notes,
    }


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pretty_json(value))


def write_immutable(path: Path, content: bytes, *, identity: str | None = None) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        existing = path.read_bytes()
        if existing == content:
            return False
        if identity is not None:
            try:
                value = json.loads(existing.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                value = None
            if isinstance(value, dict) and value.get("normalizedPanelIdentitySha256") == identity:
                raise ThreeMarketError(f"immutable identity conflict: {path}")
        raise ThreeMarketError(f"immutable artifact differs: {path}")
    path.write_bytes(content)
    return True


def logistic_fit(x_values: list[list[float]], y_values: list[int], ridge: float = 4.0) -> dict[str, Any] | None:
    if len(x_values) < 20 or len(set(y_values)) < 2:
        return None
    x = np.asarray(x_values, dtype=float)
    y = np.asarray(y_values, dtype=float)
    means = np.mean(x, axis=0)
    scales = np.std(x, axis=0)
    scales = np.where(scales > 1e-12, scales, 1.0)
    scaled = (x - means) / scales
    design = np.column_stack([np.ones(len(scaled)), scaled])
    weights = np.zeros(design.shape[1], dtype=float)
    penalty = np.eye(design.shape[1], dtype=float) * ridge
    penalty[0, 0] = 0.0
    for _ in range(80):
        logits = np.clip(design @ weights, -30.0, 30.0)
        probabilities = 1.0 / (1.0 + np.exp(-logits))
        variance = np.maximum(probabilities * (1.0 - probabilities), 1e-6)
        hessian = design.T @ (variance[:, None] * design) + penalty
        gradient = design.T @ (probabilities - y) + penalty @ weights
        try:
            step = np.linalg.solve(hessian, gradient)
        except np.linalg.LinAlgError:
            return None
        next_weights = weights - step
        if float(np.max(np.abs(next_weights - weights))) < 1e-8:
            weights = next_weights
            break
        weights = next_weights
    return {"weights": weights.tolist(), "means": means.tolist(), "scales": scales.tolist(), "ridge": ridge}


def logistic_predict(model: dict[str, Any], row: dict[str, Any], features: tuple[str, ...]) -> float:
    values = np.asarray([float(row[feature]) for feature in features], dtype=float)
    means = np.asarray(model["means"], dtype=float)
    scales = np.asarray(model["scales"], dtype=float)
    weights = np.asarray(model["weights"], dtype=float)
    values = (values - means) / scales
    logit = float(np.clip(np.r_[1.0, values] @ weights, -30.0, 30.0))
    return float(1.0 / (1.0 + math.exp(-logit)))


def auc_score(pairs: list[tuple[float, int]]) -> float | None:
    positives = sum(label for _, label in pairs)
    negatives = len(pairs) - positives
    if positives == 0 or negatives == 0:
        return None
    ordered = sorted(pairs, key=lambda item: item[0])
    rank_sum = 0.0
    index = 0
    while index < len(ordered):
        end = index + 1
        while end < len(ordered) and ordered[end][0] == ordered[index][0]:
            end += 1
        average_rank = (index + 1 + end) / 2.0
        rank_sum += average_rank * sum(label for _, label in ordered[index:end])
        index = end
    return float((rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives))


def probability_metrics(predictions: list[tuple[float, int]], baseline: list[float]) -> dict[str, Any]:
    if not predictions:
        return {"sampleCount": 0, "brier": None, "baselineBrier": None, "brierSkill": None, "logLoss": None, "auc": None, "dispersion": None}
    probabilities = [min(max(float(probability), 1e-8), 1.0 - 1e-8) for probability, _ in predictions]
    labels = [int(label) for _, label in predictions]
    brier = float(np.mean([(probability - label) ** 2 for probability, label in zip(probabilities, labels)]))
    base_brier = float(np.mean([(probability - label) ** 2 for probability, label in zip(baseline, labels)])) if baseline else None
    return {
        "sampleCount": len(predictions),
        "brier": brier,
        "baselineBrier": base_brier,
        "brierSkill": 1.0 - brier / base_brier if base_brier and base_brier > 0 else None,
        "logLoss": float(np.mean([-(label * math.log(probability) + (1 - label) * math.log(1 - probability)) for probability, label in zip(probabilities, labels)])),
        "auc": auc_score(predictions),
        "dispersion": float(np.std(probabilities, ddof=0)),
    }


def oos_evaluate(rows: list[dict[str, Any]], features: tuple[str, ...], horizon: int) -> dict[str, Any]:
    ordered = sorted(rows, key=lambda item: str(item["date"]))
    total_rows = len(ordered)
    complete = [row for row in ordered if row.get(f"absoluteUp{horizon}") is not None and all(row.get(feature) is not None for feature in features)]
    min_train = 252
    fold_size = 63
    fold_count = 5
    starts = [max(min_train, len(ordered) - fold_size * (fold_count - offset)) for offset in range(fold_count)]
    starts = sorted(set(start for start in starts if start < len(ordered)))
    predictions: list[tuple[float, int]] = []
    baseline_predictions: list[float] = []
    folds: list[dict[str, Any]] = []
    feature_missing = {feature: 1.0 - sum(row.get(feature) is not None for row in ordered) / total_rows if total_rows else 1.0 for feature in features}
    for start in starts:
        end = min(start + fold_size, len(ordered))
        test_window = ordered[start:end]
        train_window = [
            row for index, row in enumerate(ordered[:start])
            if int(row.get("sessionIndex", index)) + horizon < start
            and row.get(f"absoluteUp{horizon}") is not None
            and all(row.get(feature) is not None for feature in features)
        ]
        test_rows = [row for row in test_window if row.get(f"absoluteUp{horizon}") is not None and all(row.get(feature) is not None for feature in features)]
        if len(train_window) < 50 or len(test_rows) < 5:
            continue
        labels = [int(row[f"absoluteUp{horizon}"]) for row in train_window]
        base_rate = float(np.mean(labels))
        model = logistic_fit([[float(row[feature]) for feature in features] for row in train_window], labels)
        fold_predictions: list[tuple[float, int]] = []
        for row in test_rows:
            probability = logistic_predict(model, row, features) if model else base_rate
            pair = (probability, int(row[f"absoluteUp{horizon}"]))
            predictions.append(pair)
            baseline_predictions.append(base_rate)
            fold_predictions.append(pair)
        folds.append({
            "evaluationStart": str(test_rows[0]["date"]),
            "evaluationEnd": str(test_rows[-1]["date"]),
            "trainingRows": len(train_window),
            "evaluationRows": len(test_rows),
            "embargoSessions": horizon,
            "purgeRule": "training target session index < evaluation start index",
            "metrics": probability_metrics(fold_predictions, [base_rate] * len(fold_predictions)),
        })
    metrics = probability_metrics(predictions, baseline_predictions)
    coverage = len(predictions) / max(1, sum(min(fold_size, len(ordered) - start) for start in starts))
    return {
        "trainSampleCount": max((fold["trainingRows"] for fold in folds), default=0),
        "oosSampleCount": len(predictions),
        "oosWindowCount": len(folds),
        "folds": folds,
        "metrics": metrics,
        "coverage": float(coverage),
        "abstentionRate": float(1.0 - coverage),
        "featureMissingRates": feature_missing,
        "zeroVarianceFeatures": [feature for feature in features if len({row.get(feature) for row in complete if row.get(feature) is not None}) <= 1],
        "strictOos": True,
        "calibrationStatus": "disabled",
    }


def usable_features(rows: list[dict[str, Any]], requested: tuple[str, ...]) -> tuple[tuple[str, ...], list[str]]:
    """Exclude all-null source groups without turning missing values into zeros."""
    if not rows:
        return tuple(), list(requested)
    available: list[str] = []
    excluded: list[str] = []
    minimum = max(20, int(len(rows) * 0.02))
    for feature in requested:
        present = sum(row.get(feature) is not None for row in rows)
        if present >= minimum:
            available.append(feature)
        else:
            excluded.append(feature)
    return tuple(available), excluded


def model_card(market: str, object_id: str, object_status: str, dataset: dict[str, Any], evaluation: dict[str, Any] | None, features: tuple[str, ...], reason: str | None = None) -> dict[str, Any]:
    metrics = evaluation.get("metrics", {}) if evaluation else {}
    trained = bool(evaluation and evaluation.get("oosWindowCount", 0) >= 3 and evaluation.get("oosSampleCount", 0) >= 100)
    return {
        "schemaVersion": "three-market-model-card-v1",
        "market": market,
        "objectId": object_id,
        "datasetId": dataset.get("datasetId"),
        "datasetStatus": dataset.get("status"),
        "featureSetId": f"{market.lower()}-prior-only-v1",
        "featureSchemaVersion": FEATURE_SCHEMA,
        "modelVersion": f"{market.lower()}-regularized-logistic-shadow-v1",
        "trainingWindow": {"protocol": "expanding-walk-forward", "minimumTrainingSessions": 252, "foldSizeSessions": 63, "purge": "targetDate before evaluation start", "embargoSessions": list(HORIZONS)},
        "folds": evaluation.get("folds", []) if evaluation else [],
        "metrics": {
            "brier": metrics.get("brier"),
            "brierSkill": metrics.get("brierSkill"),
            "logLoss": metrics.get("logLoss"),
            "auc": metrics.get("auc"),
            "coverage": evaluation.get("coverage") if evaluation else 0.0,
            "abstentionRate": evaluation.get("abstentionRate") if evaluation else 1.0,
            "oosWindowCount": evaluation.get("oosWindowCount", 0) if evaluation else 0,
            "oosSampleCount": evaluation.get("oosSampleCount", 0) if evaluation else 0,
            "predictionDispersion": metrics.get("dispersion"),
        },
        "features": list(features),
        "excludedAllNullFeatures": evaluation.get("excludedAllNullFeatures", []) if evaluation else list(features),
        "featureMissingRates": evaluation.get("featureMissingRates", {}) if evaluation else {},
        "labelHorizons": list(HORIZONS),
        "modelAvailability": "trained" if trained else "not_trained",
        "publicationStatus": "abstained" if trained else "insufficient_data",
        "outputMode": "none",
        "calibrationStatus": "disabled" if evaluation else "not_applicable",
        "probabilitySource": "none",
        "probabilityTarget": "none",
        "candidateStatus": "shadow",
        "promotionRecommendation": "keep-shadow",
        "reason": reason or ("OOS model trained for research only; no public probability." if trained else "不足以形成三个有效 OOS fold；保持 abstained。"),
        "productionBoundary": {"contentWritten": False, "predictionLedgerWritten": False, "productionModelWritten": False, "probabilityPublished": False, "championReplaced": False},
    }


def production_boundary() -> dict[str, Any]:
    model_paths = [
        ROOT / "models" / "sector-rotation" / "a-share-v1.json",
        ROOT / "models" / "sector-rotation" / "a-share-up-probability-v1.json",
        ROOT / "models" / "sector-rotation" / "a-share-relative-probability-v2.json",
    ]
    content_root = ROOT / "content"
    ledger_root = ROOT / "data" / "prediction-ledger"

    def directory_sha(path: Path) -> str | None:
        if not path.is_dir():
            return None
        entries = [{"path": item.relative_to(path).as_posix(), "sha256": sha256_path(item)} for item in sorted(path.rglob("*")) if item.is_file()]
        return sha256_bytes(canonical_json(entries))

    return {
        "models": {path.relative_to(ROOT).as_posix(): sha256_path(path) for path in model_paths},
        "contentSha256": directory_sha(content_root),
        "predictionLedgerSha256": directory_sha(ledger_root),
    }


def a_share_dataset() -> dict[str, Any]:
    path = ROOT / "models" / "sector-rotation" / "datasets" / "a-share" / "a-share-2026-07-21-3448b55c8ae4" / "manifest.json"
    if not path.is_file():
        return {"market": "A_SHARE", "status": "unavailable", "datasetId": None, "reason": "frozen A-share dataset manifest missing"}
    manifest = read_json(path)
    return {
        "market": "A_SHARE",
        "status": "ready" if manifest.get("status") == "candidate" and manifest.get("panel", {}).get("rows", 0) > 0 else "unavailable",
        "datasetId": manifest.get("datasetId"),
        "manifestSha256": sha256_path(path),
        "panelSha256": manifest.get("panel", {}).get("sha256"),
        "rows": manifest.get("panel", {}).get("rows"),
        "firstDate": manifest.get("calendar", {}).get("firstDate"),
        "lastDate": manifest.get("calendar", {}).get("lastDate"),
        "sourceManifestSha256": manifest.get("sourceManifest", {}).get("sha256"),
        "productionChampionPreserved": True,
    }


def a_share_manifest(dataset: dict[str, Any]) -> dict[str, Any]:
    """Project the existing immutable A-share snapshot into the unified manifest shape."""
    snapshot = ROOT / "models" / "sector-rotation" / "datasets" / "a-share" / "a-share-2026-07-21-3448b55c8ae4"
    source_manifest = snapshot / "source-manifest.json"
    diagnostics = snapshot / "label-diagnostics.json"
    panel = snapshot / "panel.csv.gz"
    panel_sha = sha256_path(panel) if panel.is_file() else dataset.get("panelSha256")
    normalized = {
        "market": "A_SHARE",
        "panelSchemaVersion": "prediction-dataset-v1",
        "featureSchemaVersion": "a-share-price-volume-v2",
        "labelSchemaVersion": "a-share-labels-v1",
        "features": "existing frozen A-share contract",
        "labels": ["absoluteUp1", "absoluteUp5", "absoluteUp20"],
        "horizons": list(HORIZONS),
        "panelSha256": panel_sha,
        "rows": dataset.get("rows", 0),
        "firstDate": dataset.get("firstDate"),
        "lastDate": dataset.get("lastDate"),
    }
    normalized_sha = sha256_bytes(canonical_json(normalized))
    return {
        "schemaVersion": MANIFEST_SCHEMA,
        "market": "A_SHARE",
        "status": dataset.get("status"),
        "datasetId": dataset.get("datasetId"),
        "rawSnapshotIdentitySha256": sha256_bytes(canonical_json({"existingPanelUncompressedSha256": read_json(snapshot / "manifest.json").get("panel", {}).get("uncompressedSha256")})),
        "rawSnapshotIdentity": {"source": "frozen-repository-dataset", "panelUncompressedSha256": read_json(snapshot / "manifest.json").get("panel", {}).get("uncompressedSha256")},
        "normalizedPanelIdentitySha256": normalized_sha,
        "normalizedPanelIdentity": normalized,
        "panel": {
            "path": "models/sector-rotation/datasets/a-share/a-share-2026-07-21-3448b55c8ae4/panel.csv.gz",
            "privatePath": str(panel),
            "sha256": panel_sha,
            "uncompressedSha256": read_json(snapshot / "manifest.json").get("panel", {}).get("uncompressedSha256"),
            "hashBasis": "existing-prediction-dataset-contract-v1",
            "columns": read_json(snapshot / "manifest.json").get("panel", {}).get("columns", []),
            "rows": dataset.get("rows", 0),
            "objects": read_json(snapshot / "manifest.json").get("panel", {}).get("sectors", 0),
            "firstDate": dataset.get("firstDate"),
            "lastDate": dataset.get("lastDate"),
        },
        "objects": [{"objectId": "a-share-sector-rotation", "status": dataset.get("status")}],
        "features": {"schemaVersion": "a-share-price-volume-v2", "ids": "existing frozen contract", "missingPolicy": "preserve-null-never-zero", "priorOnly": True},
        "labels": {"schemaVersion": "a-share-labels-v1", "horizons": list(HORIZONS), "futureReturnsExcludeFeatureDate": True},
        "sourceLineage": {"rawSnapshotAndNormalizedPanelIdentityAreSeparate": True, "sourceManifestSha256": sha256_path(source_manifest) if source_manifest.is_file() else None, "labelDiagnosticsSha256": sha256_path(diagnostics) if diagnostics.is_file() else None},
        "license": {"privateResearchOnly": False, "rawHistoryCommitted": False, "rawHistoryPackaged": False},
        "warnings": ["A-share manifest is a projection of the existing frozen candidate snapshot; current champion remains separate."],
    }


def a_share_model_card(research_output: Path | None, dataset: dict[str, Any]) -> dict[str, Any]:
    training_run = read_json(research_output / "TRAINING_RUN.json") if research_output and (research_output / "TRAINING_RUN.json").is_file() else {}
    decision = read_json(research_output / "PROMOTION_DECISION.json") if research_output and (research_output / "PROMOTION_DECISION.json").is_file() else {}
    trained = training_run.get("trainingExecuted") is True
    return {
        "schemaVersion": "three-market-model-card-v1",
        "market": "A_SHARE",
        "objectId": "a-share-sector-rotation",
        "datasetId": dataset.get("datasetId"),
        "datasetStatus": dataset.get("status"),
        "featureSetId": "a-share-existing-contract-v2",
        "modelVersion": "a-share-challenger-research-v1" if trained else "a-share-challenger-not-run",
        "modelAvailability": "trained" if trained else "not_trained",
        "publicationStatus": "abstained",
        "outputMode": "none",
        "candidateStatus": "shadow",
        "promotionRecommendation": decision.get("decision", "keep-champion"),
        "candidateCount": training_run.get("candidateCount", 0),
        "oosWindowCount": 3 if trained else 0,
        "productionChampionPreserved": True,
        "productionBoundary": {"contentWritten": False, "predictionLedgerWritten": False, "productionModelWritten": False, "probabilityPublished": False, "championReplaced": False},
        "researchOutputPath": str(research_output) if research_output else None,
        "reason": "A 股 challenger 只生成 promotion recommendation；当前 champion 不自动替换。" if trained else "A 股 challenger 研究输出未完成。",
    }


def run_pipeline(cache: Path, source_manifest_path: Path, output: Path, private_panel_root: Path, a_research_output: Path | None = None) -> dict[str, Any]:
    if not cache.is_dir():
        raise ThreeMarketError(f"private data cache missing: {cache}")
    manifest = read_json(source_manifest_path)
    sources = source_map(manifest)
    source_audit, source_audit_payload = build_source_audit(manifest, cache)
    source_audit_payload["sourceManifestSha256"] = sha256_path(source_manifest_path)
    hk_rows, hk_meta = build_hk_panels(sources, cache)
    us_rows, us_meta = build_us_panels(sources, cache)
    private_panel_root.mkdir(parents=True, exist_ok=True)
    datasets: dict[str, dict[str, Any]] = {"A_SHARE": a_share_dataset()}
    market_rows = {"HK": hk_rows, "US_NASDAQ": us_rows}
    market_meta = {"HK": hk_meta, "US_NASDAQ": us_meta}
    dataset_manifests: dict[str, dict[str, Any]] = {}
    evaluations: dict[str, Any] = {}
    cards: dict[str, Any] = {}
    feature_sets = {
        "schemaVersion": FEATURE_SCHEMA,
        "HK": {"featureSetId": "hk-prior-only-v1", "features": list(HK_FEATURES), "priorOnly": True},
        "US_NASDAQ": {"featureSetId": "us-nasdaq-prior-only-v1", "features": list(US_FEATURES), "priorOnly": True},
        "A_SHARE": {"featureSetId": "a-share-existing-contract-v2", "features": "existing frozen contract", "priorOnly": True},
    }
    for market, rows in market_rows.items():
        panel_csv = serialize_panel(rows, market)
        panel_path = private_panel_root / f"{market.lower()}.panel.csv.gz"
        write_immutable(panel_path, gzip_bytes(panel_csv))
        object_status = dict(market_meta[market]["objects"])
        source_ids = market_meta[market]["featureSources"]
        notes = []
        if not rows:
            notes.append("no non-null price rows were available from the frozen sources")
        if market == "HK":
            notes.append("theme objects remain unavailable because no legal stable history was in the frozen source manifest")
        dataset_manifest = build_manifest(market, rows, source_ids, sources, cache, panel_path, object_status, notes)
        dataset_manifests[market] = dataset_manifest
        datasets[market] = {"market": market, "status": dataset_manifest["status"], "datasetId": dataset_manifest["datasetId"], "panelSha256": dataset_manifest["panel"]["sha256"], **panel_statistics(rows), "objects": object_status}
        requested_features = tuple(HK_FEATURES if market == "HK" else US_FEATURES)
        for object_id, status in sorted(object_status.items()):
            object_rows = [row for row in rows if row["objectId"] == object_id]
            features, excluded_features = usable_features(object_rows, requested_features)
            for horizon in HORIZONS:
                key = f"{market}/{object_id}/{horizon}"
                if status != "ready" or not object_rows:
                    evaluations[key] = {"market": market, "objectId": object_id, "horizon": horizon, "status": "unavailable", "reason": "object has no legal non-empty panel", "oosWindowCount": 0, "oosSampleCount": 0, "metrics": {}, "featuresUsed": list(features), "excludedAllNullFeatures": excluded_features}
                    cards[f"{market}_{object_id}_{horizon}"] = model_card(market, object_id, status, dataset_manifest, None, features, "主题对象没有合法稳定的历史 panel；保持 unavailable，不静默替代。")
                    continue
                evaluation = oos_evaluate(object_rows, features, horizon) if features else {"oosWindowCount": 0, "oosSampleCount": 0, "metrics": {}, "coverage": 0.0, "abstentionRate": 1.0, "folds": [], "featureMissingRates": {}, "zeroVarianceFeatures": [], "strictOos": True, "calibrationStatus": "not_applicable"}
                evaluation["featuresUsed"] = list(features)
                evaluation["excludedAllNullFeatures"] = excluded_features
                evaluation.update({"market": market, "objectId": object_id, "horizon": horizon, "status": "trained" if evaluation["oosWindowCount"] >= 3 and evaluation["oosSampleCount"] >= 100 else "insufficient-data"})
                evaluations[key] = evaluation
                cards[f"{market}_{object_id}_{horizon}"] = model_card(market, object_id, status, dataset_manifest, evaluation, features)
    datasets["A_SHARE"] = a_share_dataset()
    dataset_manifests["A_SHARE"] = a_share_manifest(datasets["A_SHARE"])
    cards["A_SHARE_a-share-sector-rotation"] = a_share_model_card(a_research_output, datasets["A_SHARE"])
    before = production_boundary()
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "DATA_INVENTORY.json", {
        "schemaVersion": "three-market-data-inventory-v1",
        "generatedAt": iso_now(),
        "cachePath": str(cache),
        "sourceManifestSha256": sha256_path(source_manifest_path),
        "markets": datasets,
        "sourceSummary": [{"sourceId": item["sourceId"], "status": item["status"], "rows": item["rows"], "firstDate": item["firstDate"], "lastDate": item["lastDate"]} for item in source_audit],
        "rawHistoryExcluded": True,
    })
    write_json(output / "SOURCE_AUDIT.json", source_audit_payload)
    write_json(output / "FEATURE_SETS.json", feature_sets)
    write_json(output / "OOS_METRICS.json", {"schemaVersion": "three-market-oos-metrics-v1", "strictOos": True, "markets": evaluations})
    write_json(output / "GATE_RESULTS.json", {
        "schemaVersion": "three-market-gate-results-v1",
        "A_SHARE": {"decision": cards["A_SHARE_a-share-sector-rotation"]["promotionRecommendation"], "productionReplacement": False, "productionChampionPreserved": True},
        "HK": {"decision": "keep-shadow", "publicationStatus": "abstained", "objectStatuses": hk_meta["objects"]},
        "US_NASDAQ": {"decision": "keep-shadow", "publicationStatus": "abstained", "objectStatuses": us_meta["objects"]},
        "global": {"probabilitiesPublished": False, "predictionLedgerAppended": False, "contentWritten": False, "uiChanged": False, "automationChanged": False},
    })
    write_json(output / "LEDGER_DRY_RUN.json", {
        "schemaVersion": "prediction-ledger-dry-run-v1",
        "appendAttempted": False,
        "productionApply": {"applied": False, "reason": "research artifact only"},
        "markets": {market: {"datasetId": item.get("datasetId"), "status": item.get("status"), "records": []} for market, item in datasets.items()},
        "productionBoundary": {"predictionLedgerWritten": False, "probabilityPublished": False},
    })
    write_json(output / "MODEL_CARDS.json", {"schemaVersion": "three-market-model-cards-index-v1", "cards": sorted(cards), "cardData": cards})
    manifest_dir = output / "DATASET_MANIFESTS"
    for market, dataset_manifest in dataset_manifests.items():
        write_json(manifest_dir / f"{market}.json", dataset_manifest)
    after = production_boundary()
    result = {
        "schemaVersion": "three-market-run-result-v1",
        "status": "completed",
        "generatedAt": iso_now(),
        "sourceAudit": source_audit_payload,
        "datasets": datasets,
        "marketMeta": market_meta,
        "evaluationCount": len(evaluations),
        "modelCardCount": len(cards),
        "productionBoundaryBefore": before,
        "productionBoundaryAfter": after,
        "productionBoundaryByteInvariant": before == after,
        "productionApply": {"applied": False, "contentWritten": False, "predictionLedgerWritten": False, "productionModelWritten": False},
    }
    write_json(output / "RUN_RESULT.json", result)
    if before != after:
        raise ThreeMarketError("production boundary changed during three-market run")
    return result


def validate_output(output: Path) -> dict[str, Any]:
    required = ["DATA_INVENTORY.json", "SOURCE_AUDIT.json", "FEATURE_SETS.json", "OOS_METRICS.json", "GATE_RESULTS.json", "LEDGER_DRY_RUN.json", "MODEL_CARDS.json", "RUN_RESULT.json"]
    missing = [name for name in required if not (output / name).is_file()]
    if missing:
        raise ThreeMarketError(f"output files missing: {missing}")
    inventory = read_json(output / "DATA_INVENTORY.json")
    source_audit = read_json(output / "SOURCE_AUDIT.json")
    metrics = read_json(output / "OOS_METRICS.json")
    gates = read_json(output / "GATE_RESULTS.json")
    ledger = read_json(output / "LEDGER_DRY_RUN.json")
    cards = read_json(output / "MODEL_CARDS.json")
    result = read_json(output / "RUN_RESULT.json")
    if result.get("productionBoundaryByteInvariant") is not True:
        raise ThreeMarketError("production boundary invariant failed")
    if ledger.get("appendAttempted") is not False or ledger.get("productionApply", {}).get("applied") is not False:
        raise ThreeMarketError("ledger dry-run boundary failed")
    if gates.get("global", {}).get("probabilitiesPublished") is not False:
        raise ThreeMarketError("probability publication boundary failed")
    if source_audit.get("rawHistoryPackaged") is not False or inventory.get("rawHistoryExcluded") is not True:
        raise ThreeMarketError("raw history packaging boundary failed")
    for path in sorted((output / "DATASET_MANIFESTS").glob("*.json")):
        manifest = read_json(path)
        if manifest.get("schemaVersion") != MANIFEST_SCHEMA:
            raise ThreeMarketError(f"dataset manifest schema mismatch: {path}")
        normalized_sha = manifest.get("normalizedPanelIdentitySha256")
        if normalized_sha and sha256_bytes(canonical_json(manifest.get("normalizedPanelIdentity"))) != normalized_sha:
            raise ThreeMarketError(f"dataset manifest identity mismatch: {path}")
        private_path = Path(manifest.get("panel", {}).get("privatePath", ""))
        if manifest.get("status") == "ready":
            if not private_path.is_file() or sha256_path(private_path) != manifest.get("panel", {}).get("sha256"):
                raise ThreeMarketError(f"private panel hash mismatch: {path}")
    return {"status": "valid", "output": str(output), "markets": list(inventory.get("markets", {})), "sourceCount": len(source_audit.get("sources", [])), "metricCount": len(metrics.get("markets", {})), "modelCardCount": len(cards.get("cards", []))}


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run")
    run.add_argument("--cache", type=Path, required=True)
    run.add_argument("--source-manifest", type=Path, required=True)
    run.add_argument("--output", type=Path, required=True)
    run.add_argument("--private-panel-root", type=Path, required=True)
    run.add_argument("--a-research-output", type=Path)
    validate = commands.add_parser("validate")
    validate.add_argument("--output", type=Path, required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    args = parser().parse_args(argv)
    try:
        if args.command == "run":
            result = run_pipeline(args.cache.resolve(), args.source_manifest.resolve(), args.output.resolve(), args.private_panel_root.resolve(), args.a_research_output.resolve() if args.a_research_output else None)
        else:
            result = validate_output(args.output.resolve())
    except ThreeMarketError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
