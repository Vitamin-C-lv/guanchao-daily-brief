#!/usr/bin/env python3
"""Collect compact official macro signals required by the HK rotation model.

This collector is deliberately separate from model publication.  It preserves
nulls, records endpoint failures, and never turns a failed request into a zero
or a 50% forecast.  The output is a small gzip CSV in the local data folder.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import os
import tempfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import requests

import sector_rotation as rotation


SIGNAL_DIR = rotation.DATA_DIR / "signals"
OUTPUT_PATH = SIGNAL_DIR / "hk-macro-daily.csv.gz"
FIELDS = [
    "date", "hibor_overnight", "hibor_1m", "aggregate_balance_hkd_m",
    "usd_hkd", "cny_hkd", "usd_cny_cross", "us_2y_treasury",
]
HKMA_LIQUIDITY = "https://api.hkma.gov.hk/public/market-data-and-statistics/daily-monetary-statistics/daily-figures-interbank-liquidity"
HKMA_EXCHANGE = "https://api.hkma.gov.hk/public/market-data-and-statistics/monthly-statistical-bulletin/er-ir/er-eeri-daily"
TREASURY_YIELD_XML = "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"


def read_existing() -> dict[str, dict[str, Any]]:
    if not OUTPUT_PATH.exists():
        return {}
    with gzip.open(OUTPUT_PATH, "rt", encoding="utf-8", newline="") as handle:
        return {row["date"]: row for row in csv.DictReader(handle) if row.get("date")}


def write_rows(rows: list[dict[str, Any]]) -> None:
    SIGNAL_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=SIGNAL_DIR, suffix=".tmp") as raw:
        temp_name = raw.name
    try:
        with gzip.open(temp_name, "wt", encoding="utf-8", newline="", compresslevel=6) as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS)
            writer.writeheader()
            for row in rows:
                writer.writerow({key: "" if row.get(key) is None else row.get(key) for key in FIELDS})
        os.replace(temp_name, OUTPUT_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def hkma_pages(session: requests.Session, url: str, date_key: str, start: str, end: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    offset = 0
    while offset < 2500:
        payload = rotation.fetch_json_with_retry(
            session,
            url,
            params={"offset": str(offset), "pagesize": "100"},
            headers={"Accept": "application/json", "Referer": "https://www.hkma.gov.hk/"},
            attempts=3,
        )
        records = payload.get("result", {}).get("records") or []
        if not records:
            break
        for record in records:
            day = str(record.get(date_key, ""))
            if start <= day <= end:
                output.append(record)
        oldest = min((str(record.get(date_key, "9999-99-99")) for record in records), default="9999-99-99")
        if oldest < start or len(records) < 100:
            break
        offset += len(records)
    return output


def treasury_rows(session: requests.Session, start: str, end: str) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    namespaces = {
        "m": "http://schemas.microsoft.com/ado/2007/08/dataservices/metadata",
        "d": "http://schemas.microsoft.com/ado/2007/08/dataservices",
    }
    for year in range(int(start[:4]), int(end[:4]) + 1):
        response = session.get(
            TREASURY_YIELD_XML,
            params={"data": "daily_treasury_yield_curve", "field_tdr_date_value": str(year)},
            headers={"User-Agent": "GuanchaoMarketResearch/2.0", "Accept": "application/xml"},
            timeout=45,
        )
        response.raise_for_status()
        root = ET.fromstring(response.content)
        for properties in root.findall(".//m:properties", namespaces):
            day_node = properties.find("d:NEW_DATE", namespaces)
            yield_node = properties.find("d:BC_2YEAR", namespaces)
            day = (day_node.text or "")[:10] if day_node is not None else ""
            if start <= day <= end and yield_node is not None:
                output.append({"date": day, "value": yield_node.text})
    return output


def collect(args: argparse.Namespace) -> None:
    start = args.start or (date.today() - timedelta(days=800)).isoformat()
    end = args.end or date.today().isoformat()
    if start > end:
        raise SystemExit("--start cannot be after --end")
    session = rotation.requests_session()
    merged = read_existing()
    failures: list[dict[str, str]] = []
    source_rows: dict[str, int] = {}

    try:
        records = hkma_pages(session, HKMA_LIQUIDITY, "end_of_date", start, end)
        source_rows["hkmaLiquidity"] = len(records)
        for record in records:
            day = str(record["end_of_date"])
            row = merged.setdefault(day, {"date": day})
            row["hibor_overnight"] = rotation.finite(record.get("hibor_overnight"))
            row["hibor_1m"] = rotation.finite(record.get("hibor_fixing_1m"))
            row["aggregate_balance_hkd_m"] = rotation.finite(record.get("closing_balance"))
    except Exception as exc:  # endpoint state belongs in the manifest, not a fabricated number
        failures.append({"source": HKMA_LIQUIDITY, "error": str(exc)[:240]})

    try:
        records = hkma_pages(session, HKMA_EXCHANGE, "end_of_day", start, end)
        source_rows["hkmaExchange"] = len(records)
        for record in records:
            day = str(record["end_of_day"])
            row = merged.setdefault(day, {"date": day})
            usd = rotation.finite(record.get("usd"))
            cny = rotation.finite(record.get("cny"))
            row["usd_hkd"] = usd
            row["cny_hkd"] = cny
            row["usd_cny_cross"] = usd / cny if usd is not None and cny not in {None, 0} else None
    except Exception as exc:
        failures.append({"source": HKMA_EXCHANGE, "error": str(exc)[:240]})

    try:
        records = treasury_rows(session, start, end)
        source_rows["usTreasury2y"] = len(records)
        for record in records:
            day = str(record.get("date") or "")
            if not day or not start <= day <= end:
                continue
            row = merged.setdefault(day, {"date": day})
            row["us_2y_treasury"] = rotation.finite(record.get("value"))
    except Exception as exc:
        failures.append({"source": TREASURY_YIELD_XML, "error": str(exc)[:240]})

    # Keep the compact historical cache append-only across short daily refresh
    # windows.  A recent refresh must never truncate the two-year backfill.
    rows = [merged[key] for key in sorted(merged)]
    if rows:
        write_rows(rows)

    completeness = {
        field: sum(rotation.finite(row.get(field)) is not None for row in rows) / len(rows)
        for field in FIELDS if field != "date"
    } if rows else {field: 0.0 for field in FIELDS if field != "date"}
    manifest = rotation.load_manifest()
    manifest["hkRotationSignals"] = {
        "updatedAt": rotation.now_iso(),
        "status": "ready" if rows else "failed",
        "start": rows[0]["date"] if rows else start,
        "end": rows[-1]["date"] if rows else end,
        "rows": len(rows),
        "compressedBytes": OUTPUT_PATH.stat().st_size if OUTPUT_PATH.exists() else 0,
        "sourceRows": source_rows,
        "fieldCompleteness": completeness,
        "failures": failures,
        "nullPolicy": "preserve-null-never-zero",
        "usdCnhStatus": "missing; USD/CNY cross is retained under a different field and is never relabelled CNH",
        "modelStatus": "research input only until joined to a point-in-time HK sector panel and walk-forward validated",
    }
    rotation.write_json_atomic(rotation.MANIFEST_PATH, manifest)
    latest = rows[-1]["date"] if rows else "none"
    size = OUTPUT_PATH.stat().st_size if OUTPUT_PATH.exists() else 0
    print(f"[rotation-signals] rows={len(rows)} latest={latest} size={size} failures={len(failures)}", flush=True)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("--start")
    root.add_argument("--end")
    return root


if __name__ == "__main__":
    collect(parser().parse_args())
