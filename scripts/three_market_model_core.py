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
    "hk_liquidity_overnight",
    "hk_liquidity_1m",
    "hk_liquidity_opening_balance",
    "hk_liquidity_closing_balance",
    "hk_liquidity_twi",
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
    candidates = sorted(path for path in folder.iterdir() if path.is_file() and path.name.lower().startswith("payload."))
    return candidates[0] if candidates else None


def load_cache_metadata(cache: Path) -> dict[str, Any]:
    result: dict[str, Any] = {"fetch": {}, "validation": {}, "meta": {}}
    for fetch_path in (cache / "fetch-results.json", cache / "fallback-fetch-results.json"):
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
        first_date, last_date = source_date_range(source, payload)
        parsed_rows = raw_row_count(source, payload)
        validation_status = validation_item.get("status")
        validation_reasons = list(validation_item.get("reasons", []))
        expected_min_rows = source.get("expectedMinRows")
        if isinstance(expected_min_rows, int) and expected_min_rows > 0 and 0 < parsed_rows < expected_min_rows:
            reason = f"rows {parsed_rows} < expectedMinRows {expected_min_rows}"
            if reason not in validation_reasons:
                validation_reasons.append(reason)
        if parsed_rows == 0:
            status = "unavailable"
        elif validation_status in {"failed", "partial"} or validation_reasons:
            status = "partial"
        else:
            status = fetch_item.get("status") or "ready"
            if status not in {"ready", "partial", "unavailable"}:
                status = "ready"
        error = fetch_item.get("error")
        if status == "partial" and validation_reasons:
            error = "; ".join(str(reason) for reason in validation_reasons)
        if status == "unavailable" and not error and validation_reasons:
            error = "; ".join(str(reason) for reason in validation_reasons)
        item = {
            "sourceId": source_id,
            "market": source.get("market"),
            "role": source.get("role"),
            "provider": source.get("provider"),
            "tier": source.get("tier"),
            "required": bool(source.get("required")),
            "status": status,
            "rows": parsed_rows,
            "firstDate": first_date or validation_item.get("firstDate"),
            "lastDate": last_date or validation_item.get("lastDate"),
            "expectedMinRows": source.get("expectedMinRows"),
            "rawSha256": meta.get("sha256") or fetch_item.get("sha256"),
            "rawBytes": meta.get("bytes") or fetch_item.get("bytes"),
            "licenseNote": source.get("licenseNote"),
            "url": source.get("url") or source.get("urlTemplate"),
            "error": error if status != "ready" else None,
            "packageValidationStatus": validation_status or "not_run",
            "packageValidationReasons": validation_reasons,
            "validationConsistent": not (status == "ready" and validation_status in {"failed", "partial"}),
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


def source_candidates(sources: dict[str, dict[str, Any]], ids: Iterable[str] = (), role_prefixes: Iterable[str] = ()) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for source_id in ids:
        source = sources.get(source_id)
        if source and source_id not in seen:
            result.append(source)
            seen.add(source_id)
    prefixes = tuple(role_prefixes)
    for source_id, source in sources.items():
        role = str(source.get("role") or "")
        if prefixes and any(role == prefix or role.startswith(prefix) for prefix in prefixes) and source_id not in seen:
            result.append(source)
            seen.add(source_id)
    return result


def resolved_series(
    sources: dict[str, dict[str, Any]],
    cache: Path,
    *,
    ids: Iterable[str] = (),
    role_prefixes: Iterable[str] = (),
    field_keys: tuple[str, ...] = (),
) -> tuple[dict[str, float], str | None]:
    first_source_id: str | None = None
    for source in source_candidates(sources, ids, role_prefixes):
        source_id = str(source["id"])
        if first_source_id is None:
            first_source_id = source_id
        series = load_series(source, cache, field_keys=field_keys)
        if series:
            return series, source_id
    return {}, first_source_id


def source_quality(source: dict[str, Any] | None, cache: Path, series: dict[str, float]) -> str:
    if source is None or not series:
        return "unavailable"
    expected = source.get("expectedMinRows")
    raw_rows = raw_row_count(source, payload_path(cache, str(source["id"])))
    if isinstance(expected, int) and expected > 0 and raw_rows < expected:
        return "partial"
    return "ready"


def source_by_id(sources: dict[str, dict[str, Any]], source_id: str | None) -> dict[str, Any] | None:
    return sources.get(source_id) if source_id else None


def crosscheck_series(
    primary: dict[str, float],
    primary_source_id: str | None,
    cross_source: dict[str, Any] | None,
    cache: Path,
    field_keys: tuple[str, ...] = (),
) -> dict[str, Any]:
    if not primary or not primary_source_id or cross_source is None or str(cross_source.get("id")) == primary_source_id:
        return {"status": "not_run", "overlapRows": 0, "mismatchRows": 0, "maxAbsDifference": None}
    cross = load_series(cross_source, cache, field_keys=field_keys)
    overlap = sorted(set(primary) & set(cross))
    differences = [abs(primary[date_value] - cross[date_value]) for date_value in overlap]
    mismatches = sum(difference > 1e-7 for difference in differences)
    return {
        "status": "passed" if overlap and mismatches == 0 else "mismatch" if overlap else "not_run",
        "primarySourceId": primary_source_id,
        "crossSourceId": cross_source.get("id"),
        "overlapRows": len(overlap),
        "mismatchRows": mismatches,
        "maxAbsDifference": max(differences) if differences else None,
    }


def load_hstech_normalized_override(path: Path) -> tuple[dict[str, float], dict[str, Any]]:
    value = read_json(path)
    if value.get("schemaVersion") != "hstech-sina-normalized-v1":
        raise ThreeMarketError("HSTECH normalized adapter requires hstech-sina-normalized-v1")
    if value.get("source", {}).get("provider") != "akshare.stock_hk_index_daily_sina":
        raise ThreeMarketError("HSTECH normalized adapter requires bounded AKShare Sina source")
    launch_date = "2020-07-27"
    raw_bars = value.get("bars", [])
    if not isinstance(raw_bars, list):
        raise ThreeMarketError("HSTECH normalized adapter bars must be a list")
    series: dict[str, float] = {}
    invalid_ohlc_rows = 0
    for row in raw_bars:
        date_value = require_date(row.get("date") or row.get("time"), "HSTECH normalized adapter date")
        if date_value < launch_date:
            raise ThreeMarketError("HSTECH normalized adapter contains pre-launch row")
        open_value = positive_number(row.get("open"))
        high_value = positive_number(row.get("high"))
        low_value = positive_number(row.get("low"))
        close = positive_number(row.get("close"))
        if (
            any(value is None for value in (open_value, high_value, low_value, close))
            or high_value < max(open_value, close, low_value)
            or low_value > min(open_value, close, high_value)
        ):
            invalid_ohlc_rows += 1
            continue
        if date_value in series:
            raise ThreeMarketError(f"HSTECH normalized adapter duplicate date: {date_value}")
        series[date_value] = close
    if len(series) < 252:
        raise ThreeMarketError(f"HSTECH normalized adapter rows {len(series)} < 252")
    source = {
        "id": "akshare_sina_hstech",
        "market": "HK",
        "role": "hstech_ohlcv_normalized_adapter",
        "provider": "AKShare stock_hk_index_daily_sina（稳定标准化缓存 adapter）",
        "tier": "bounded_primary_market_data",
        "required": True,
        "expectedMinRows": 252,
        "startDate": launch_date,
        "url": value.get("source", {}).get("url"),
        "licenseNote": "标准化私有研究缓存；不提交原始 provider payload。",
        "normalizedCachePath": str(path),
        "normalizedCacheSha256": sha256_path(path),
        "providerInputRows": len(raw_bars),
        "invalidOhlcRows": invalid_ohlc_rows,
        "validHstechRows": len(series),
        "actualHstechObservationRows": len(series),
        "firstDate": min(series) if series else None,
        "lastDate": max(series) if series else None,
    }
    return series, source


def build_hk_panels(sources: dict[str, dict[str, Any]], cache: Path, hstech_normalized_cache: Path | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    hsi, hsi_source_id = resolved_series(sources, cache, ids=("yahoo_hsi",), role_prefixes=("hsi_ohlcv",))
    hstech_adapter = None
    if hstech_normalized_cache is not None:
        hstech, hstech_source = load_hstech_normalized_override(hstech_normalized_cache)
        hstech_source_id = str(hstech_source["id"])
        sources[hstech_source_id] = hstech_source
        hstech_adapter = {
            "providerInputRows": hstech_source["providerInputRows"],
            "invalidOhlcRows": hstech_source["invalidOhlcRows"],
            "validHstechRows": hstech_source["validHstechRows"],
            "actualHstechObservationRows": hstech_source["actualHstechObservationRows"],
            "firstDate": hstech_source["firstDate"],
            "lastDate": hstech_source["lastDate"],
        }
    else:
        hstech, hstech_source_id = resolved_series(sources, cache, ids=("yahoo_hstech",), role_prefixes=("hstech_ohlcv",))
    hibor_overnight, hibor_source_id = resolved_series(
        sources,
        cache,
        ids=("hkma_hibor_fixing_chunked", "hkma_hibor_fixing"),
        role_prefixes=("hibor_fixing",),
        field_keys=("ir_overnight", "hibor_overnight"),
    )
    hibor_1m, hibor_1m_source_id = resolved_series(
        sources,
        cache,
        ids=("hkma_hibor_fixing_chunked", "hkma_hibor_fixing"),
        role_prefixes=("hibor_fixing",),
        field_keys=("ir_1m", "hibor_1m"),
    )
    liquidity_source = source_candidates(sources, ("hkma_interbank_liquidity_chunked", "hkma_interbank_liquidity"), ("hk_liquidity",))
    liquidity_source_id = str(liquidity_source[0]["id"]) if liquidity_source else None
    liquidity_overnight, _ = resolved_series(
        sources, cache, ids=("hkma_interbank_liquidity_chunked", "hkma_interbank_liquidity"), role_prefixes=("hk_liquidity",), field_keys=("hibor_overnight",)
    )
    liquidity_1m, _ = resolved_series(
        sources, cache, ids=("hkma_interbank_liquidity_chunked", "hkma_interbank_liquidity"), role_prefixes=("hk_liquidity",), field_keys=("hibor_fixing_1m",)
    )
    liquidity_opening, _ = resolved_series(
        sources, cache, ids=("hkma_interbank_liquidity_chunked", "hkma_interbank_liquidity"), role_prefixes=("hk_liquidity",), field_keys=("opening_balance",)
    )
    liquidity_closing, _ = resolved_series(
        sources, cache, ids=("hkma_interbank_liquidity_chunked", "hkma_interbank_liquidity"), role_prefixes=("hk_liquidity",), field_keys=("closing_balance",)
    )
    liquidity_twi, _ = resolved_series(
        sources, cache, ids=("hkma_interbank_liquidity_chunked", "hkma_interbank_liquidity"), role_prefixes=("hk_liquidity",), field_keys=("twi",)
    )
    if not hibor_overnight:
        hibor_overnight = liquidity_overnight
        hibor_source_id = liquidity_source_id
    if not hibor_1m:
        hibor_1m = liquidity_1m
        hibor_1m_source_id = liquidity_source_id
    usd_hkd, usd_hkd_source_id = resolved_series(sources, cache, ids=("yahoo_usd_hkd", "fred_dexhkus"), role_prefixes=("usd_hkd",), field_keys=())
    us2y, us2y_source_id = resolved_series(sources, cache, ids=("treasury_yield_curve", "fred_dgs2"), role_prefixes=("us_2y_yield",), field_keys=("us2y",))
    us10y, us10y_source_id = resolved_series(sources, cache, ids=("treasury_yield_curve", "fred_dgs10"), role_prefixes=("us_10y_yield",), field_keys=("us10y",))
    rows: list[dict[str, Any]] = []
    hstech_launch = require_date(sources.get(hstech_source_id, {}).get("startDate", "2020-07-27"), "HSTECH launch date")
    hstech_prelaunch_rows = sum(1 for date_value in hstech if date_value < hstech_launch)
    for object_id, object_kind, series in (("hsi", "index", hsi), ("hstech", "index", hstech)):
        if object_id == "hstech":
            series = {date_value: value for date_value, value in series.items() if date_value >= hstech_launch}
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
            row["hk_liquidity_overnight"] = liquidity_overnight.get(str(row["date"]))
            row["hk_liquidity_1m"] = liquidity_1m.get(str(row["date"]))
            row["hk_liquidity_opening_balance"] = liquidity_opening.get(str(row["date"]))
            row["hk_liquidity_closing_balance"] = liquidity_closing.get(str(row["date"]))
            row["hk_liquidity_twi"] = liquidity_twi.get(str(row["date"]))
        rows.extend(object_rows)
    hsi_status = source_quality(source_by_id(sources, hsi_source_id), cache, hsi)
    hstech_status = "ready" if hstech_normalized_cache is not None and len(hstech) >= 252 else source_quality(source_by_id(sources, hstech_source_id), cache, hstech)
    hibor_endpoint = source_by_id(sources, "hkma_hibor_fixing_chunked") or source_by_id(sources, "hkma_hibor_fixing")
    liquidity_status = source_quality(source_by_id(sources, liquidity_source_id), cache, liquidity_overnight)
    macro_status = "ready" if all((hibor_endpoint and payload_path(cache, str(hibor_endpoint["id"])), liquidity_status == "ready", usd_hkd, us2y, us10y)) else "partial"
    dataset_status = "ready" if hsi_status == "ready" and hstech_status == "ready" and macro_status == "ready" else "partial" if hsi or hstech else "unavailable"
    statuses = {
        "hsi": hsi_status,
        "hstech": hstech_status,
        "hk_innovative_drug": "unavailable",
        "hk_tech_internet": "unavailable",
    }
    return rows, {
        "market": "HK",
        "objects": statuses,
        "datasetStatus": dataset_status,
        "macroStatus": macro_status,
        "hstechHistoryFilter": {"launchDate": hstech_launch, "rawRows": len(hstech), "droppedPreLaunchRows": hstech_prelaunch_rows, "rule": "retain actual observations on or after launch date only", "adapter": hstech_normalized_cache is not None, "sourceId": hstech_source_id, "adapterAudit": hstech_adapter},
        "macroResolution": {
            "hiborEndpointStatus": source_quality(hibor_endpoint, cache, load_series(hibor_endpoint, cache, field_keys=("ir_overnight", "hibor_overnight"))) if hibor_endpoint else "unavailable",
            "hiborFeatureSource": hibor_source_id,
            "hibor1mFeatureSource": hibor_1m_source_id,
            "liquiditySource": liquidity_source_id,
            "usdHkdSource": usd_hkd_source_id,
            "us2ySource": us2y_source_id,
            "us10ySource": us10y_source_id,
        },
        "crossChecks": {
            "us2y": crosscheck_series(us2y, us2y_source_id, source_by_id(sources, "fred_dgs2"), cache, ("us2y",)),
            "us10y": crosscheck_series(us10y, us10y_source_id, source_by_id(sources, "fred_dgs10"), cache, ("us10y",)),
            "usdHkd": crosscheck_series(usd_hkd, usd_hkd_source_id, source_by_id(sources, "fred_dexhkus"), cache),
        },
        "themeUnavailableReason": "合法、稳定、可追溯的主题历史未包含在冻结来源清单中；不静默替换为代理。",
        "featureSources": sorted({source_id for source_id in (hsi_source_id, hstech_source_id, hibor_source_id, hibor_1m_source_id, liquidity_source_id, usd_hkd_source_id, us2y_source_id, us10y_source_id) if source_id}),
        "crossCheckSources": [source_id for source_id in ("fred_dgs2", "fred_dgs10", "fred_dexhkus") if source_id in sources],
    }


def build_us_panels(sources: dict[str, dict[str, Any]], cache: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    nasdaq, nasdaq_source_id = resolved_series(sources, cache, ids=("yahoo_nasdaq_composite", "fred_nasdaqcom"), role_prefixes=("nasdaq_composite",), field_keys=())
    sox, sox_source_id = resolved_series(sources, cache, ids=("yahoo_sox",), role_prefixes=("sox_ohlcv",), field_keys=())
    us2y, us2y_source_id = resolved_series(sources, cache, ids=("treasury_yield_curve", "fred_dgs2"), role_prefixes=("us_2y_yield",), field_keys=("us2y",))
    us10y, us10y_source_id = resolved_series(sources, cache, ids=("treasury_yield_curve", "fred_dgs10"), role_prefixes=("us_10y_yield",), field_keys=("us10y",))
    vix, vix_source_id = resolved_series(sources, cache, ids=("cboe_vix",), role_prefixes=("vix_close",), field_keys=("close", "vix", "value"))
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
    nasdaq_status = source_quality(source_by_id(sources, nasdaq_source_id), cache, nasdaq)
    macro_status = "ready" if all((us2y, us10y, vix, sox)) else "partial"
    dataset_status = "ready" if nasdaq_status == "ready" and macro_status == "ready" else "partial" if rows else "unavailable"
    return rows, {
        "market": "US_NASDAQ",
        "objects": {"nasdaq_composite": nasdaq_status},
        "datasetStatus": dataset_status,
        "macroStatus": macro_status,
        "crossChecks": {
            "us2y": crosscheck_series(us2y, us2y_source_id, source_by_id(sources, "fred_dgs2"), cache, ("us2y",)),
            "us10y": crosscheck_series(us10y, us10y_source_id, source_by_id(sources, "fred_dgs10"), cache, ("us10y",)),
        },
        "featureSources": sorted({source_id for source_id in (nasdaq_source_id, us2y_source_id, us10y_source_id, vix_source_id, sox_source_id) if source_id}),
        "crossCheckSources": [source_id for source_id in ("fred_dgs2", "fred_dgs10") if source_id in sources],
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
    dataset_status: str | None = None,
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
    resolved_status = dataset_status or ("ready" if rows else "unavailable")
    return {
        "schemaVersion": MANIFEST_SCHEMA,
        "market": market,
        "status": resolved_status,
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
            "trainingStart": str(train_window[0]["date"]) if train_window else None,
            "trainingEnd": str(train_window[-1]["date"]) if train_window else None,
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


def model_card(
    market: str,
    object_id: str,
    object_status: str,
    dataset: dict[str, Any],
    evaluation: dict[str, Any] | None,
    features: tuple[str, ...],
    reason: str | None = None,
    horizon: int | None = None,
) -> dict[str, Any]:
    metrics = evaluation.get("metrics", {}) if evaluation else {}
    trained = bool(evaluation and evaluation.get("oosWindowCount", 0) >= 3 and evaluation.get("oosSampleCount", 0) >= 100)
    availability = "trained" if trained else "insufficient_data" if evaluation else "not_trained"
    default_reason = (
        "US Nasdaq object has no sufficient legal panel; remain unavailable without theme-object substitution."
        if market == "US_NASDAQ"
        else "HK object has no sufficient legal panel; remain unavailable without theme-object substitution."
        if market == "HK"
        else "不足以形成三个有效 OOS fold；保持 abstained。"
    )
    return {
        "schemaVersion": "three-market-model-card-v1",
        "market": market,
        "objectId": object_id,
        "datasetId": dataset.get("datasetId"),
        "datasetStatus": dataset.get("status"),
        "objectDatasetStatus": object_status,
        "horizon": horizon,
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
        "modelAvailability": availability,
        "publicationStatus": "abstained" if trained else "insufficient_data",
        "outputMode": "none",
        "calibrationStatus": "disabled" if evaluation else "not_applicable",
        "probabilitySource": "none",
        "probabilityTarget": "none",
        "candidateStatus": "shadow",
        "promotionRecommendation": "keep-shadow",
        "reason": reason or ("OOS model trained for research only; no public probability." if trained else default_reason),
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


def metric_snapshot(value: dict[str, Any] | None) -> dict[str, Any]:
    value = value or {}
    return {
        "sampleCount": value.get("observations"),
        "dates": value.get("dates"),
        "brier": value.get("brier"),
        "baselineBrier": value.get("baselineBrier"),
        "brierSkill": value.get("brierSkill"),
        "logLoss": value.get("logLoss"),
        "auc": value.get("rocAuc"),
        "probabilityDispersion": value.get("crossSectionProbabilityStd"),
    }


def a_share_research_summary(research_output: Path | None) -> dict[str, Any]:
    if research_output is None or not (research_output / "TRAINING_RUN.json").is_file():
        return {
            "status": "not_run",
            "championModelVersion": None,
            "challengerModelVersion": None,
            "horizonMetrics": {},
            "gateResults": {},
            "reason": "A 股 challenger 研究输出未完成。",
        }
    training_run = read_json(research_output / "TRAINING_RUN.json")
    decision = read_json(research_output / "PROMOTION_DECISION.json") if (research_output / "PROMOTION_DECISION.json").is_file() else {}
    candidate_table = read_json(research_output / "CANDIDATE_TABLE.json") if (research_output / "CANDIDATE_TABLE.json").is_file() else {}
    if training_run.get("trainingExecuted") is not True:
        return {
            "status": "not_run",
            "championModelVersion": None,
            "challengerModelVersion": None,
            "horizonMetrics": {},
            "gateResults": decision.get("horizonGates", {}),
            "reason": "A 股 challenger 训练未执行。",
        }
    champion_id = str(candidate_table.get("championCandidateId") or training_run.get("championReplay", {}).get("championCandidateId") or "")
    challenger_id = str(candidate_table.get("recommendedCandidateId") or training_run.get("recommendedCandidateId") or decision.get("recommendedChallengerId") or "")
    candidate_metrics: dict[str, dict[str, Any]] = {}
    for label, candidate_id in (("champion", champion_id), ("challenger", challenger_id)):
        path = research_output / "metrics" / f"{candidate_id}.json"
        candidate_metrics[label] = read_json(path) if candidate_id and path.is_file() else {}
    horizon_metrics: dict[str, Any] = {}
    for horizon in HORIZONS:
        horizon_key = str(horizon)
        target_metrics: dict[str, Any] = {}
        for target in ("absoluteUp", "outperformance", "topQuartile"):
            target_entry: dict[str, Any] = {}
            for label in ("champion", "challenger"):
                entry = candidate_metrics[label].get("horizons", {}).get(horizon_key, {})
                selection = entry.get("selectionEvaluation", {})
                holdout = entry.get("holdoutEvaluation", {})
                target_entry[label] = {
                    "selection": metric_snapshot(selection.get("probabilityMetrics", {}).get(target)),
                    "holdout": metric_snapshot(holdout.get("probabilityMetrics", {}).get(target)),
                }
            target_metrics[target] = target_entry
        champion_entry = candidate_metrics["champion"].get("horizons", {}).get(horizon_key, {})
        challenger_entry = candidate_metrics["challenger"].get("horizons", {}).get(horizon_key, {})
        champion_selection = champion_entry.get("selectionEvaluation", {})
        challenger_selection = challenger_entry.get("selectionEvaluation", {})
        champion_holdout = champion_entry.get("holdoutEvaluation", {})
        challenger_holdout = challenger_entry.get("holdoutEvaluation", {})
        horizon_metrics[horizon_key] = {
            "targets": target_metrics,
            "oosSampleCount": {
                "champion": {
                    "selection": champion_selection.get("observations"),
                    "holdout": champion_holdout.get("observations"),
                },
                "challenger": {
                    "selection": challenger_selection.get("observations"),
                    "holdout": challenger_holdout.get("observations"),
                },
            },
            "foldCount": {
                "selection": len(champion_selection.get("rankingReturnMetrics", {}).get("blocks", [])),
                "holdout": len(champion_holdout.get("rankingReturnMetrics", {}).get("blocks", [])),
            },
            "gate": decision.get("horizonGates", {}).get(horizon_key, {}),
            "comparison": {
                "championAfterCostSpread": champion_selection.get("rankingReturnMetrics", {}).get("afterCostSpread"),
                "challengerAfterCostSpread": challenger_selection.get("rankingReturnMetrics", {}).get("afterCostSpread"),
                "championRankIc": champion_selection.get("rankingReturnMetrics", {}).get("rankIc"),
                "challengerRankIc": challenger_selection.get("rankingReturnMetrics", {}).get("rankIc"),
                "championTopQuartileBrier": metric_snapshot(champion_selection.get("probabilityMetrics", {}).get("topQuartile")).get("brier"),
                "challengerTopQuartileBrier": metric_snapshot(challenger_selection.get("probabilityMetrics", {}).get("topQuartile")).get("brier"),
            },
        }
    gate_failures = []
    for horizon, gates in decision.get("horizonGates", {}).items():
        for gate, passed in gates.items():
            if passed is False:
                gate_failures.append(f"h{horizon}:{gate}")
    champion_versions = {
        "a-share-up-probability-v1": "2026-07-20-probability-v1",
        "a-share-relative-probability-v2": "2026-07-21-relative-v2",
    }
    return {
        "status": "compared",
        "championCandidateId": champion_id,
        "challengerCandidateId": challenger_id,
        "championModelVersion": champion_versions,
        "challengerModelVersion": f"a-share-research-candidate-{challenger_id}" if challenger_id else None,
        "horizonMetrics": horizon_metrics,
        "gateResults": decision.get("horizonGates", {}),
        "foldCount": {horizon: item["foldCount"] for horizon, item in horizon_metrics.items()},
        "promotionDecision": decision.get("decision", training_run.get("promotionDecision", "keep-champion")),
        "exactChampionReplayPassed": decision.get("exactChampionReplayPassed"),
        "statisticalNonInferiorityPassed": decision.get("statisticalNonInferiorityPassed"),
        "gateFailures": gate_failures,
        "reason": (
            f"keep-champion: exactChampionReplayPassed={decision.get('exactChampionReplayPassed')}; "
            f"statisticalNonInferiorityPassed={decision.get('statisticalNonInferiorityPassed')}; "
            f"failedGates={','.join(gate_failures) or 'none'}; challenger remains shadow and production champion is preserved."
        ),
    }


def a_share_model_card(research_output: Path | None, dataset: dict[str, Any]) -> dict[str, Any]:
    training_run = read_json(research_output / "TRAINING_RUN.json") if research_output and (research_output / "TRAINING_RUN.json").is_file() else {}
    decision = read_json(research_output / "PROMOTION_DECISION.json") if research_output and (research_output / "PROMOTION_DECISION.json").is_file() else {}
    trained = training_run.get("trainingExecuted") is True
    comparison = a_share_research_summary(research_output)
    return {
        "schemaVersion": "three-market-model-card-v1",
        "market": "A_SHARE",
        "objectId": "a-share-sector-rotation",
        "datasetId": dataset.get("datasetId"),
        "datasetStatus": dataset.get("status"),
        "featureSetId": "a-share-existing-contract-v2",
        "modelVersion": comparison.get("challengerModelVersion") or ("a-share-challenger-not-run" if not trained else "a-share-challenger-research-v1"),
        "championModelVersion": comparison.get("championModelVersion"),
        "challengerModelVersion": comparison.get("challengerModelVersion"),
        "modelAvailability": "trained" if trained else "not_trained",
        "publicationStatus": "abstained",
        "outputMode": "none",
        "candidateStatus": "shadow",
        "promotionRecommendation": decision.get("decision", "keep-champion"),
        "candidateCount": training_run.get("candidateCount", 0),
        "oosWindowCount": max((item.get("foldCount", {}).get("holdout", 0) for item in comparison.get("horizonMetrics", {}).values()), default=0),
        "horizonMetrics": comparison.get("horizonMetrics", {}),
        "gateResults": comparison.get("gateResults", decision.get("horizonGates", {})),
        "oosComparison": comparison,
        "productionChampionPreserved": True,
        "productionBoundary": {"contentWritten": False, "predictionLedgerWritten": False, "productionModelWritten": False, "probabilityPublished": False, "championReplaced": False},
        "researchOutputPath": str(research_output) if research_output else None,
        "reason": comparison.get("reason") if trained else "A 股 challenger 研究输出未完成。",
    }


def run_pipeline(cache: Path, source_manifest_path: Path, output: Path, private_panel_root: Path, a_research_output: Path | None = None, hstech_normalized_cache: Path | None = None) -> dict[str, Any]:
    if not cache.is_dir():
        raise ThreeMarketError(f"private data cache missing: {cache}")
    manifest = read_json(source_manifest_path)
    sources = source_map(manifest)
    source_audit, source_audit_payload = build_source_audit(manifest, cache)
    source_audit_payload["sourceManifestSha256"] = sha256_path(source_manifest_path)
    hk_rows, hk_meta = build_hk_panels(sources, cache, hstech_normalized_cache)
    if hstech_normalized_cache is not None:
        adapter_audit = hk_meta.get("hstechHistoryFilter", {}).get("adapterAudit") or {}
        source_audit_payload["hstechNormalizedAdapter"] = {"path": str(hstech_normalized_cache), "sha256": sha256_path(hstech_normalized_cache), "sourceId": "akshare_sina_hstech", "applied": True, "productionBoundary": "research-only", **adapter_audit}
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
            if market_meta[market].get("macroStatus") != "ready":
                notes.append("HK macro coverage is partial; unavailable direct HIBOR remains null and no zero-fill is applied")
        if market == "US_NASDAQ" and market_meta[market].get("macroStatus") != "ready":
            notes.append("US required macro feature coverage is partial; missing values remain null")
        dataset_manifest = build_manifest(
            market,
            rows,
            source_ids,
            sources,
            cache,
            panel_path,
            object_status,
            notes,
            market_meta[market].get("datasetStatus"),
        )
        dataset_manifests[market] = dataset_manifest
        datasets[market] = {"market": market, "status": dataset_manifest["status"], "datasetId": dataset_manifest["datasetId"], "panelSha256": dataset_manifest["panel"]["sha256"], **panel_statistics(rows), "objects": object_status, "macroStatus": market_meta[market].get("macroStatus")}
        requested_features = tuple(HK_FEATURES if market == "HK" else US_FEATURES)
        for object_id, status in sorted(object_status.items()):
            object_rows = [row for row in rows if row["objectId"] == object_id]
            features, excluded_features = usable_features(object_rows, requested_features)
            for horizon in HORIZONS:
                key = f"{market}/{object_id}/{horizon}"
                if status != "ready" or not object_rows:
                    reason = (
                        "US Nasdaq object panel is partial or unavailable; keep shadow without publishing a probability."
                        if market == "US_NASDAQ"
                        else "HK object panel is partial or unavailable; keep shadow without substituting an unmarked proxy."
                    )
                    blocked_status = "insufficient-data" if object_rows else "unavailable"
                    blocked_evaluation = {"market": market, "objectId": object_id, "horizon": horizon, "status": blocked_status, "reason": reason, "oosWindowCount": 0, "oosSampleCount": 0, "metrics": {}, "featuresUsed": list(features), "excludedAllNullFeatures": excluded_features}
                    evaluations[key] = blocked_evaluation
                    cards[f"{market}_{object_id}_{horizon}"] = model_card(market, object_id, status, dataset_manifest, blocked_evaluation if object_rows else None, features, reason, horizon)
                    continue
                evaluation = oos_evaluate(object_rows, features, horizon) if features else {"oosWindowCount": 0, "oosSampleCount": 0, "metrics": {}, "coverage": 0.0, "abstentionRate": 1.0, "folds": [], "featureMissingRates": {}, "zeroVarianceFeatures": [], "strictOos": True, "calibrationStatus": "not_applicable"}
                evaluation["featuresUsed"] = list(features)
                evaluation["excludedAllNullFeatures"] = excluded_features
                evaluation.update({"market": market, "objectId": object_id, "horizon": horizon, "status": "trained" if evaluation["oosWindowCount"] >= 3 and evaluation["oosSampleCount"] >= 100 else "insufficient-data"})
                evaluations[key] = evaluation
                cards[f"{market}_{object_id}_{horizon}"] = model_card(market, object_id, status, dataset_manifest, evaluation, features, horizon=horizon)
    datasets["A_SHARE"] = a_share_dataset()
    dataset_manifests["A_SHARE"] = a_share_manifest(datasets["A_SHARE"])
    cards["A_SHARE_a-share-sector-rotation"] = a_share_model_card(a_research_output, datasets["A_SHARE"])
    evaluations["A_SHARE/a-share-sector-rotation"] = {
        "market": "A_SHARE",
        "objectId": "a-share-sector-rotation",
        "status": cards["A_SHARE_a-share-sector-rotation"].get("oosComparison", {}).get("status", "not_run"),
        "modelVersion": cards["A_SHARE_a-share-sector-rotation"].get("modelVersion"),
        "championModelVersion": cards["A_SHARE_a-share-sector-rotation"].get("championModelVersion"),
        "challengerModelVersion": cards["A_SHARE_a-share-sector-rotation"].get("challengerModelVersion"),
        "horizonMetrics": cards["A_SHARE_a-share-sector-rotation"].get("horizonMetrics", {}),
        "gateResults": cards["A_SHARE_a-share-sector-rotation"].get("gateResults", {}),
        "reason": cards["A_SHARE_a-share-sector-rotation"].get("reason"),
    }
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
    a_share_card = cards["A_SHARE_a-share-sector-rotation"]
    write_json(output / "GATE_RESULTS.json", {
        "schemaVersion": "three-market-gate-results-v1",
        "A_SHARE": {"decision": a_share_card["promotionRecommendation"], "productionReplacement": False, "productionChampionPreserved": True, "championModelVersion": a_share_card.get("championModelVersion"), "challengerModelVersion": a_share_card.get("challengerModelVersion"), "horizonGates": a_share_card.get("gateResults", {}), "comparison": a_share_card.get("oosComparison", {})},
        "HK": {"decision": "keep-shadow", "publicationStatus": "abstained", "datasetStatus": hk_meta.get("datasetStatus"), "macroStatus": hk_meta.get("macroStatus"), "objectStatuses": hk_meta["objects"]},
        "US_NASDAQ": {"decision": "keep-shadow", "publicationStatus": "abstained", "datasetStatus": us_meta.get("datasetStatus"), "macroStatus": us_meta.get("macroStatus"), "objectStatuses": us_meta["objects"]},
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
        objects = manifest.get("objects", [])
        object_ids = [item.get("objectId") for item in objects if isinstance(item, dict)]
        if len(object_ids) != len(set(object_ids)):
            raise ThreeMarketError(f"dataset manifest duplicate object: {path}")
        if manifest.get("status") == "ready" and any(item.get("status") != "ready" for item in objects if isinstance(item, dict)):
            raise ThreeMarketError(f"dataset manifest ready/object status contradiction: {path}")
        if manifest.get("status") in {"ready", "partial"} and manifest.get("panel", {}).get("rows", 0) > 0:
            if not private_path.is_file() or sha256_path(private_path) != manifest.get("panel", {}).get("sha256"):
                raise ThreeMarketError(f"private panel hash mismatch: {path}")
    for item in source_audit.get("sources", []):
        if item.get("status") == "ready" and item.get("packageValidationStatus") in {"failed", "partial"}:
            raise ThreeMarketError(f"source validation contradiction: {item.get('sourceId')}")
    for card in cards.get("cardData", {}).values():
        if card.get("objectDatasetStatus") == "unavailable" and card.get("modelAvailability") == "trained":
            raise ThreeMarketError(f"unavailable object marked trained: {card.get('market')}/{card.get('objectId')}")
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
    run.add_argument("--hstech-normalized-cache", type=Path)
    validate = commands.add_parser("validate")
    validate.add_argument("--output", type=Path, required=True)
    return root


def main(argv: list[str] | None = None) -> int:
    configure_stdio()
    args = parser().parse_args(argv)
    try:
        if args.command == "run":
            result = run_pipeline(args.cache.resolve(), args.source_manifest.resolve(), args.output.resolve(), args.private_panel_root.resolve(), args.a_research_output.resolve() if args.a_research_output else None, args.hstech_normalized_cache.resolve() if args.hstech_normalized_cache else None)
        else:
            result = validate_output(args.output.resolve())
    except ThreeMarketError as exc:
        print(json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False, sort_keys=True))
        return 2
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
