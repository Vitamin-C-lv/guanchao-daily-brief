"""P1-E's small, explicit catalog-driven public data collectors."""
from __future__ import annotations

import hashlib
import json
import math
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import requests

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "config" / "market-evidence-sources.json"
UTC = timezone.utc
VALID_STATUS = {"ready", "partial", "stale", "unavailable", "rate_limited", "schema_changed"}

# Treasury follows the SIFMA recommendation for these observed U.S. holidays.
US_CLOSED_2026 = {
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19",
    "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25",
}


def now_utc() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _tag(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def load_catalog(path: Path = CATALOG_PATH) -> list[dict[str, Any]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if raw.get("schemaVersion") != 1 or not isinstance(raw.get("sources"), list):
        raise ValueError("market evidence source catalog schemaVersion=1 and sources are required")
    required = {"sourceId", "datasetId", "market", "primaryUrl", "sourceClass", "official", "requiredForDaily", "requiredForWeekly", "freshnessCalendar", "maxTradingSessionLag", "parserVersion", "normalizerVersion", "enabled"}
    seen: set[str] = set()
    enabled: list[dict[str, Any]] = []
    for source in raw["sources"]:
        if not isinstance(source, dict) or not required.issubset(source):
            raise ValueError("market evidence source catalog has a malformed source")
        identifier = source["sourceId"]
        if not isinstance(identifier, str) or not identifier or identifier in seen:
            raise ValueError(f"duplicate or invalid sourceId: {identifier!r}")
        seen.add(identifier)
        if bool(source["enabled"]):
            enabled.append(source)
    return enabled


def is_us_trading_day(value: str) -> bool:
    parsed = date.fromisoformat(value)
    return parsed.weekday() < 5 and value not in US_CLOSED_2026


def latest_us_trading_day(value: str) -> str:
    current = date.fromisoformat(value)
    while not is_us_trading_day(current.isoformat()):
        current -= timedelta(days=1)
    return current.isoformat()


def trading_lag(as_of: str, requested_as_of: str, calendar: str) -> int:
    if calendar != "US_TRADING":
        return 0 if as_of >= requested_as_of else 99
    cursor = date.fromisoformat(as_of)
    target = date.fromisoformat(latest_us_trading_day(requested_as_of))
    lag = 0
    while cursor < target:
        cursor += timedelta(days=1)
        if is_us_trading_day(cursor.isoformat()):
            lag += 1
    return lag


def _xml_rows(body: bytes, fields: tuple[str, ...]) -> list[dict[str, Any]]:
    root = ET.fromstring(body)
    records: list[dict[str, Any]] = []
    for entry in root.iter():
        if _tag(entry) != "entry":
            continue
        row = {_tag(item): (item.text or "").strip() for item in entry.iter() if item is not entry}
        raw_date = row.get("NEW_DATE", "")[:10]
        if len(raw_date) != 10:
            continue
        values = {field: _number(row.get(field)) for field in fields}
        records.append({"date": raw_date, "values": values})
    return sorted(records, key=lambda item: item["date"])


def _base_result(source: dict[str, Any], requested_at: str) -> dict[str, Any]:
    return {
        "sourceId": source["sourceId"], "datasetId": source["datasetId"], "sourceClass": source["sourceClass"],
        "official": bool(source["official"]), "requestedAt": requested_at, "completedAt": now_utc(),
        "asOf": None, "releasedAt": None, "status": "unavailable", "sourceUrl": source["primaryUrl"],
        "rawSha256": None, "recordCount": 0, "parserVersion": source["parserVersion"],
        "normalizerVersion": source["normalizerVersion"], "warnings": [], "errorClass": None, "records": [],
    }


def _collect_treasury(source: dict[str, Any], requested_as_of: str, fields: tuple[str, ...], get: Callable[..., Any] = requests.get) -> dict[str, Any]:
    requested_at = now_utc()
    result = _base_result(source, requested_at)
    url = source["primaryUrl"].format(year=requested_as_of[:4])
    result["sourceUrl"] = url
    try:
        response = None
        last_error: Exception | None = None
        for attempt in range(3):
            try:
                candidate = get(url, headers={"Accept": "application/atom+xml,application/xml"}, timeout=(8, 20))
                if candidate.status_code == 200:
                    response = candidate
                    break
                last_error = RuntimeError(f"HTTP {candidate.status_code}")
            except requests.RequestException as exc:
                last_error = exc
            if attempt < 2:
                time.sleep(0.5 * (attempt + 1))
        if response is None:
            result["errorClass"] = "network_error" if isinstance(last_error, requests.RequestException) else "http_error"
            result["warnings"].append(f"Treasury XML failed after 3 attempts: {type(last_error).__name__ if last_error else 'unknown'}")
            return result
        body = response.content
        result["rawSha256"] = hashlib.sha256(body).hexdigest()
        rows = [row for row in _xml_rows(body, fields) if row["date"] <= requested_as_of]
        if not rows:
            result["errorClass"] = "no_valid_records"
            result["warnings"].append("Treasury XML contained no valid record on or before requestedAsOf")
            return result
        result["records"] = rows
        result["recordCount"] = len(rows)
        result["asOf"] = rows[-1]["date"]
        result["releasedAt"] = rows[-1]["date"]
        result["status"] = "ready"
        return result
    except ET.ParseError:
        result["errorClass"] = "xml_parse_error"
        result["warnings"].append("Treasury response was not parseable XML")
    except requests.RequestException as exc:
        result["errorClass"] = "network_error"
        result["warnings"].append(f"Treasury request failed: {type(exc).__name__}")
    return result


def collect_nominal_treasury(source: dict[str, Any], requested_as_of: str) -> dict[str, Any]:
    return _collect_treasury(source, requested_as_of, ("BC_2YEAR", "BC_10YEAR", "BC_30YEAR"))


def collect_real_treasury(source: dict[str, Any], requested_as_of: str) -> dict[str, Any]:
    return _collect_treasury(source, requested_as_of, ("TC_10YEAR",))


def collect_csi_constituents(source: dict[str, Any], requested_as_of: str) -> dict[str, Any]:
    # P1-D established that CSI serves WAF/403 responses in this environment.  Do not retry
    # this optional source inside every daily run or mistake an HTML challenge for constituents.
    result = _base_result(source, now_utc())
    result["errorClass"] = "provider_waf_known"
    result["warnings"].append("CSI constituent public endpoint remains unavailable; breadth is not backfilled")
    return result


SOURCE_HANDLERS: dict[str, Callable[[dict[str, Any], str], dict[str, Any]]] = {
    "us-treasury-nominal-xml": collect_nominal_treasury,
    "us-treasury-real-xml": collect_real_treasury,
    "csi-constituents": collect_csi_constituents,
}


def collect_sources(edition: str, requested_as_of: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if edition not in {"daily", "weekly"}:
        raise ValueError("edition must be daily or weekly")
    sources: list[dict[str, Any]] = []
    for source in load_catalog():
        handler = SOURCE_HANDLERS.get(source["sourceId"])
        if handler is None:
            raise ValueError(f"enabled sourceId has no explicit handler: {source['sourceId']}")
        result = handler(source, requested_as_of)
        result["required"] = bool(source["requiredForDaily"] if edition == "daily" else source["requiredForWeekly"])
        result["freshnessCalendar"] = source["freshnessCalendar"]
        result["maxTradingSessionLag"] = int(source["maxTradingSessionLag"])
        if result["status"] not in VALID_STATUS:
            raise ValueError(f"invalid source status for {source['sourceId']}")
        sources.append(result)
    by_id = {source["sourceId"]: source for source in sources}
    return sources, build_treasury(by_id, requested_as_of)


def _changes(values: list[float | None], multiplier: float = 100.0) -> dict[str, float | None]:
    current = values[-1] if values else None
    return {str(days) + "d": None if current is None or len(values) <= days or values[-1 - days] is None else round((current - values[-1 - days]) * multiplier, 2) for days in (1, 5, 20)}


def build_treasury(by_id: dict[str, dict[str, Any]], requested_as_of: str) -> dict[str, Any]:
    nominal, real = by_id.get("us-treasury-nominal-xml"), by_id.get("us-treasury-real-xml")
    empty = {"asOf": None, "releasedAt": None, "nominal2y": None, "nominal10y": None, "nominal30y": None, "real10y": None, "spread2s10sBp": None, "changesBp": {}, "status": "unavailable", "curveRegime": "unavailable", "causeAssessment": "insufficient_data", "outputMode": "evidence_observation", "notProbability": True, "includedInProductionModel": False, "includedInPublicationGate": False, "warnings": ["Treasury sources unavailable"], "nominalSource": _lineage(nominal), "realSource": _lineage(real)}
    if not nominal or nominal["status"] != "ready":
        return empty
    if not real or real["status"] != "ready":
        latest = nominal["records"][-1]
        values = latest["values"]
        empty.update({"asOf": latest["date"], "releasedAt": latest["date"], "nominal2y": values["BC_2YEAR"], "nominal10y": values["BC_10YEAR"], "nominal30y": values["BC_30YEAR"], "status": "partial", "curveRegime": "mixed", "warnings": ["real 10Y Treasury curve is unavailable"]})
        return empty
    n_by_date = {item["date"]: item["values"] for item in nominal["records"]}
    r_by_date = {item["date"]: item["values"] for item in real["records"]}
    common = sorted(set(n_by_date) & set(r_by_date))
    if not common:
        empty["status"] = "partial"; empty["curveRegime"] = "mixed"; empty["warnings"] = ["nominal and real Treasury curves have no common date"]
        return empty
    as_of = common[-1]
    lag = max(trading_lag(as_of, requested_as_of, nominal.get("freshnessCalendar", "US_TRADING")), trading_lag(as_of, requested_as_of, real.get("freshnessCalendar", "US_TRADING")))
    n = n_by_date[as_of]; r = r_by_date[as_of]
    histories = {
        "nominal2y": [n_by_date[item]["BC_2YEAR"] for item in common],
        "nominal10y": [n_by_date[item]["BC_10YEAR"] for item in common],
        "nominal30y": [n_by_date[item]["BC_30YEAR"] for item in common],
        "real10y": [r_by_date[item]["TC_10YEAR"] for item in common],
    }
    spread = [None if a is None or b is None else (b - a) * 100 for a, b in zip(histories["nominal2y"], histories["nominal10y"])]
    changes = {key: _changes(values) for key, values in histories.items()} | {"spread2s10sBp": _changes(spread, 1.0)}
    values = {"nominal2y": n["BC_2YEAR"], "nominal10y": n["BC_10YEAR"], "nominal30y": n["BC_30YEAR"], "real10y": r["TC_10YEAR"], "spread2s10sBp": None if spread[-1] is None else round(spread[-1], 2)}
    complete = all(value is not None for value in values.values()) and all(change is not None for group in changes.values() for change in group.values())
    max_lag = max(int(nominal.get("maxTradingSessionLag", 1)), int(real.get("maxTradingSessionLag", 1)))
    mismatched_latest_date = nominal.get("asOf") != real.get("asOf")
    status = "stale" if lag > max_lag else ("ready" if complete and not mismatched_latest_date else "partial")
    warnings = [] if status == "ready" else ([f"Treasury data lags latest US trading day by {lag} sessions"] if status == "stale" else (["nominal and real Treasury source dates differ"] if mismatched_latest_date else ["Treasury history is insufficient for one or more 1/5/20-day changes"]))
    regime = "stale" if status == "stale" else ("mixed" if status == "partial" else "mixed")
    return {"asOf": as_of, "releasedAt": as_of, **values, "changesBp": changes, "status": status, "curveRegime": regime, "causeAssessment": "insufficient_data", "outputMode": "evidence_observation", "notProbability": True, "includedInProductionModel": False, "includedInPublicationGate": False, "warnings": warnings, "nominalSource": _lineage(nominal), "realSource": _lineage(real), "freshnessLagSessions": lag}


def _lineage(source: dict[str, Any] | None) -> dict[str, Any]:
    source = source or {}
    return {key: source.get(key) for key in ("sourceId", "sourceUrl", "rawSha256", "asOf", "requestedAt", "status")}
