#!/usr/bin/env python3
"""Validate the private three-market cache without reading metadata as data."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
from pathlib import Path
from typing import Any


def parse_date(value: Any) -> str | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    for pattern in ("%Y-%m-%d", "%Y/%m/%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(raw[:10], pattern).date().isoformat()
        except ValueError:
            continue
    try:
        return dt.date.fromisoformat(raw[:10]).isoformat()
    except ValueError:
        return None


def payload_files(folder: Path) -> list[Path]:
    """Only payload.* is data; meta.json is lineage and must never be parsed as rows."""

    if not folder.is_dir():
        return []
    return sorted(path for path in folder.iterdir() if path.is_file() and path.name.lower().startswith("payload."))


def rows_from_payload(path: Path) -> list[dict[str, Any]]:
    if path.suffix.lower() == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            return [row for row in csv.DictReader(handle)]
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)]
    if isinstance(value, dict):
        for key in ("records", "rows", "data", "datas"):
            rows = value.get(key)
            if isinstance(rows, list):
                return [row for row in rows if isinstance(row, dict)]
    raise ValueError(f"payload contains no row list: {path}")


def row_date(row: dict[str, Any]) -> Any:
    normalized = {str(key).strip().lower(): value for key, value in row.items()}
    for key in ("date", "observation_date", "end_of_day", "end_of_date", "end_of_month"):
        if normalized.get(key):
            return normalized[key]
    return None


def validate_source(source: dict[str, Any], data_root: Path) -> dict[str, Any]:
    folder = data_root / "raw" / str(source["id"])
    payloads = payload_files(folder)
    rows: list[dict[str, Any]] = []
    errors: list[str] = []
    for payload in payloads:
        try:
            rows.extend(rows_from_payload(payload))
        except (OSError, UnicodeError, json.JSONDecodeError, csv.Error, ValueError) as exc:
            errors.append(f"invalid payload {payload.name}: {exc}")

    parsed_dates = []
    invalid_dates = 0
    for row in rows:
        value = parse_date(row_date(row))
        if value is None:
            invalid_dates += 1
        else:
            parsed_dates.append(value)
    unique_dates = len(set(parsed_dates))
    duplicate_dates = len(parsed_dates) - unique_dates
    reasons = list(errors)
    if not rows:
        reasons.append("no rows")
    if invalid_dates:
        reasons.append(f"invalid dates={invalid_dates}")
    if duplicate_dates:
        reasons.append(f"duplicate dates={duplicate_dates}")
    if parsed_dates and parsed_dates != sorted(parsed_dates):
        reasons.append("dates not monotonic ascending")
    expected = int(source.get("expectedMinRows") or 0)
    if expected and rows and len(rows) < expected:
        reasons.append(f"rows {len(rows)} < expectedMinRows {expected}")

    if not rows:
        status = "unavailable"
    elif reasons:
        status = "failed" if source.get("required") else "partial"
    else:
        status = "ready"
    return {
        "sourceId": source["id"],
        "required": bool(source.get("required")),
        "rows": len(rows),
        "uniqueDates": unique_dates,
        "duplicateDates": duplicate_dates,
        "firstDate": min(parsed_dates) if parsed_dates else None,
        "lastDate": max(parsed_dates) if parsed_dates else None,
        "status": status,
        "reasons": reasons,
        "payloadFiles": [path.name for path in payloads],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--data-root", required=True, type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    report_items = [validate_source(source, args.data_root) for source in manifest["sources"]]
    report = {
        "schemaVersion": "guanchao-three-market-validation-v2",
        "validatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "payloadOnly": True,
        "dateFormats": ["YYYY-MM-DD", "YYYY/MM/DD", "MM/DD/YYYY"],
        "sources": report_items,
    }
    output = args.data_root / "validation-report.json"
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for item in report_items:
        print(f"{item['status']:11} {item['sourceId']:36} rows={item['rows']}")
    return 1 if any(item["status"] == "failed" for item in report_items) else 0


if __name__ == "__main__":
    raise SystemExit(main())
