#!/usr/bin/env python3
"""Bounded AKShare/Sina probe for HSTECH.

Only a normalized OHLC cache is written. Raw provider payloads are never persisted.
The daily publisher consumes the resulting cache and never installs AKShare dynamically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import date
from pathlib import Path


LAUNCH_DATE = date(2020, 7, 27)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--as-of", default=None)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    import akshare as ak  # type: ignore

    frame = ak.stock_hk_index_daily_sina(symbol="HSTECH")
    rows: list[dict[str, object]] = []
    for item in frame.to_dict(orient="records"):
        raw_date = str(item.get("date", ""))[:10]
        try:
            parsed = date.fromisoformat(raw_date)
        except ValueError:
            continue
        if parsed < LAUNCH_DATE or (args.as_of and raw_date > args.as_of):
            continue
        values: dict[str, object] = {"date": raw_date}
        for key in ("open", "high", "low", "close", "volume"):
            value = item.get(key)
            values[key] = None if value is None else float(value)
        rows.append(values)
    rows.sort(key=lambda row: str(row["date"]))
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    normalized = {
        "schemaVersion": "hstech-sina-normalized-v1",
        "source": {
            "provider": "akshare.stock_hk_index_daily_sina",
            "symbol": "HSTECH",
            "rawSha256": hashlib.sha256(payload).hexdigest(),
            "rawPayloadStored": False,
            "bounded": True,
            "retrievedAt": date.today().isoformat(),
        },
        "bars": rows,
    }
    output.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "rows": len(rows), "firstDate": rows[0]["date"] if rows else None, "lastDate": rows[-1]["date"] if rows else None, "rawPayloadStored": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
