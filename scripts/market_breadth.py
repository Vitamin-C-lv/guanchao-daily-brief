#!/usr/bin/env python3
"""Immutable current-session A-share market breadth snapshots.

The collector uses the official CSI constituent files already used by the
market-evidence path plus Tencent's existing public market-data estate for
daily K-lines.  It intentionally rejects historical requests: a constituent
file retrieved today is a current relationship, not evidence for a past one.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import gzip
import hashlib
import io
import json
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests

ROOT = Path(__file__).resolve().parents[1]
TAXONOMY_PATH = ROOT / "models" / "sector-rotation" / "taxonomy.a-core12-v2.json"
STORE_ROOT = ROOT / "data" / "feature-store" / "a-share" / "market-breadth" / "v1"
CONTRACT_VERSION = "a-share-market-breadth-v1"
SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")
TENCENT_KLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
TENCENT_PROVIDER_PAGE = "https://gu.qq.com/"
MAX_WORKERS = 8


def canonical_bytes(payload: Any) -> bytes:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = canonical_bytes(payload) + b"\n"
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as handle:
        handle.write(encoded)
        temporary = handle.name
    try:
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def deterministic_gzip(payload: Any) -> bytes:
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=6) as handle:
        handle.write(canonical_bytes(payload))
    return out.getvalue()


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def iso_today() -> str:
    return datetime.now(SHANGHAI).date().isoformat()


def source_qualification() -> dict[str, Any]:
    return {
        "contractVersion": CONTRACT_VERSION,
        "selection": "CSI official constituents plus existing Tencent public daily K-line path",
        "candidates": [
            {
                "provider": "CSI constituent workbook",
                "officialOrSupplemental": "official",
                "authentication": "none",
                "rateLimit": "one workbook per 12-index universe refresh; retry bounded by existing collector",
                "historicalDepth": "current composition only; no verified point-in-time archive selected",
                "fields": ["effectiveDate", "security code", "exchange", "sector-index membership"],
                "stability": "already used by scripts/market_evidence.py",
                "licenseOrUsageNotes": "public index constituent file; retained only as hashed derived snapshot",
                "WindowsCompatibility": "requests + xlrd through existing Windows-first collector",
                "maintenanceRisk": "medium",
                "selected": True,
                "rejectionReason": None,
            },
            {
                "provider": "Tencent fqkline public endpoint",
                "officialOrSupplemental": "supplemental",
                "authentication": "none",
                "rateLimit": "bounded concurrent current-session requests (8 workers); no historical bulk backfill",
                "historicalDepth": "recent daily prices sufficient for 1d, 5d and 20-session calculations",
                "fields": ["date", "close", "volume"],
                "stability": "Tencent already supplies the repository's batch quote path",
                "licenseOrUsageNotes": "public market-data endpoint; snapshot retains only ratios and response hashes",
                "WindowsCompatibility": "requests on Windows",
                "maintenanceRisk": "medium",
                "selected": True,
                "rejectionReason": None,
            },
            {
                "provider": "Tencent batch quote endpoint",
                "officialOrSupplemental": "supplemental",
                "authentication": "none",
                "rateLimit": "existing batched quote collector",
                "historicalDepth": "single completed close",
                "fields": ["current", "previousClose", "amount"],
                "stability": "already used by scripts/market_evidence.py",
                "licenseOrUsageNotes": "public market-data endpoint",
                "WindowsCompatibility": "requests on Windows",
                "maintenanceRisk": "low",
                "selected": False,
                "rejectionReason": "cannot calculate 5-day return or 20-session moving-average breadth",
            },
        ],
        "pointInTimePolicy": "collect only the current Shanghai session after close; reject historical asOf requests until immutable membership snapshots have accumulated",
        "trainingReady": False,
    }


def fetch_constituents(session: requests.Session, index_code: str, as_of: str) -> dict[str, Any]:
    """Fetch one current official composition and require it to predate asOf."""
    # xlrd is only needed for the collection command, not snapshot reads or
    # production inference.  Keep the daily frozen-model path lightweight.
    import market_evidence

    source_url = market_evidence.csi_constituent_url(session, index_code)
    response = market_evidence.request_with_retry(
        session,
        source_url,
        headers={"Referer": market_evidence.CSI_INDEX_PAGE.format(code=index_code)},
        attempts=2,
        timeout=(5, 20),
    )
    parsed = market_evidence.parse_constituent_workbook(response.content, source_url)
    effective = parsed.get("effectiveDate")
    if not isinstance(effective, str) or effective > as_of:
        raise ValueError(f"CSI constituent effectiveDate invalid for {index_code}: {effective!r} > {as_of}")
    return parsed


def parse_kline(symbol: str, body: bytes, as_of: str) -> tuple[list[dict[str, Any]], str | None]:
    payload = json.loads(body.decode("utf-8"))
    data = payload.get("data", {}).get(symbol, {})
    rows = data.get("qfqday") or data.get("day") or []
    parsed: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, list) or len(row) < 6:
            continue
        day = str(row[0])
        close = finite(row[2])
        volume = finite(row[5])
        if len(day) == 10 and day <= as_of and close is not None and close > 0:
            parsed.append({"date": day, "close": close, "volume": volume})
    parsed.sort(key=lambda item: item["date"])
    return parsed, None if parsed else "no valid daily price rows"


def fetch_tencent_kline(symbol: str, as_of: str) -> dict[str, Any]:
    start = (datetime.fromisoformat(as_of) - timedelta(days=50)).date().isoformat()
    params = {"param": f"{symbol},day,{start},{as_of},35,qfq"}
    try:
        response = requests.get(
            TENCENT_KLINE,
            params=params,
            headers={"Referer": TENCENT_PROVIDER_PAGE, "User-Agent": "Mozilla/5.0"},
            timeout=(5, 18),
        )
        response.raise_for_status()
        rows, warning = parse_kline(symbol, response.content, as_of)
        return {"symbol": symbol, "rows": rows, "rawSha256": sha256_bytes(response.content), "warning": warning}
    except Exception as exc:  # a failed provider must stay null, never become a down stock
        return {"symbol": symbol, "rows": [], "rawSha256": None, "warning": f"Tencent K-line failed: {exc}"}


def member_metrics(rows: list[dict[str, Any]], as_of: str) -> tuple[dict[str, float] | None, str | None]:
    if not rows or rows[-1]["date"] != as_of:
        latest = rows[-1]["date"] if rows else "unavailable"
        return None, f"stale price data: latest {latest}, expected {as_of}"
    if rows[-1].get("volume") is None or float(rows[-1]["volume"]) <= 0:
        return None, "suspended or zero-volume current session excluded"
    if len(rows) < 20:
        return None, f"only {len(rows)}/20 valid price sessions"
    current = float(rows[-1]["close"])
    previous = float(rows[-2]["close"])
    prior_5 = float(rows[-6]["close"])
    ma20 = sum(float(row["close"]) for row in rows[-20:]) / 20
    if previous <= 0 or prior_5 <= 0 or ma20 <= 0:
        return None, "non-positive historical close excluded"
    return {
        "advance": 1.0 if current > previous else 0.0,
        "positive5d": 1.0 if current > prior_5 else 0.0,
        "aboveMa20": 1.0 if current > ma20 else 0.0,
    }, None


def sector_result(
    index: dict[str, Any],
    constituents: dict[str, Any],
    prices: dict[str, dict[str, Any]],
    as_of: str,
) -> dict[str, Any]:
    items = constituents.get("items", [])
    warnings: list[str] = []
    valid: list[dict[str, float]] = []
    stale_count = 0
    for member in items:
        result = prices.get(member["symbol"], {"rows": [], "warning": "missing provider result"})
        metrics, warning = member_metrics(result.get("rows", []), as_of)
        if metrics is not None:
            valid.append(metrics)
        elif warning:
            if warning.startswith("stale"):
                stale_count += 1
            warnings.append(warning)
    total = len(items)
    valid_count = len(valid)
    valid_ratio = valid_count / total if total else 0.0
    metrics_ready = valid_count > 0
    advance = sum(item["advance"] for item in valid) / valid_count if metrics_ready else None
    positive5 = sum(item["positive5d"] for item in valid) / valid_count if metrics_ready else None
    above_ma20 = sum(item["aboveMa20"] for item in valid) / valid_count if metrics_ready else None
    membership_effective = constituents.get("effectiveDate")
    if not total:
        status = "unavailable"
    elif membership_effective is None or membership_effective > as_of:
        status = "unavailable"
        warnings.append("constituent relationship is not effective for asOf")
    elif stale_count == total:
        status = "stale"
    elif valid_count >= 10 and valid_ratio >= 0.80 and all(value is not None and math.isfinite(value) for value in (advance, positive5, above_ma20)):
        status = "ready"
    else:
        status = "partial"
    if valid_count < 10:
        warnings.append(f"valid constituents {valid_count}/10 minimum")
    if valid_ratio < 0.80:
        warnings.append(f"valid constituent ratio {valid_ratio:.3f} below 0.80")
    return {
        "sectorId": index["code"],
        "sectorName": index["shortName"],
        "asOf": as_of,
        "constituentEffectiveDate": membership_effective,
        "totalConstituents": total,
        "validConstituents": valid_count,
        "validConstituentRatio": valid_ratio,
        "advanceRatio1d": advance,
        "positiveReturnRatio5d": positive5,
        "aboveMa20Ratio": above_ma20,
        "status": status,
        "warnings": sorted(set(warnings))[:12],
        "sourceRefs": [
            {"provider": "CSI", "sourceType": "official-constituent-file", "sourceHash": constituents.get("sha256"), "url": constituents.get("sourceUrl")},
            {"provider": "Tencent", "sourceType": "daily-kline", "sourceHash": None, "url": TENCENT_KLINE},
        ],
    }


def summarize(sectors: list[dict[str, Any]]) -> dict[str, Any]:
    if len(sectors) != 12:
        raise ValueError("market breadth requires all 12 A-share sectors")
    ready = [sector for sector in sectors if sector["status"] == "ready"]
    valid_fraction = sum(
        sector["validConstituentRatio"]
        for sector in sectors
        if all(sector[key] is not None for key in ("advanceRatio1d", "positiveReturnRatio5d", "aboveMa20Ratio"))
        and sector["status"] not in {"stale", "unavailable"}
    ) / len(sectors)
    if len(ready) == len(sectors):
        status = "ready"
    elif any(sector["status"] in {"ready", "partial"} for sector in sectors):
        status = "partial"
    elif all(sector["status"] == "stale" for sector in sectors):
        status = "stale"
    else:
        status = "unavailable"
    return {
        "status": status,
        "readySectorCount": len(ready),
        "sectorCount": len(sectors),
        "groupCoverage": min(1.0, max(0.0, valid_fraction)),
        "productionReady": len(ready) == len(sectors),
        "trainingReady": False,
    }


def build_snapshot(
    *,
    as_of: str,
    taxonomy: dict[str, Any],
    constituent_by_sector: dict[str, dict[str, Any]],
    prices: dict[str, dict[str, Any]],
    price_failures: list[str],
) -> dict[str, Any]:
    sectors = [sector_result(index, constituent_by_sector[index["code"]], prices, as_of) for index in taxonomy["indices"]]
    source_hashes = {
        "constituents": sha256_bytes(canonical_bytes({code: constituent_by_sector[code].get("sha256") for code in sorted(constituent_by_sector)})),
        "prices": sha256_bytes(canonical_bytes({symbol: prices[symbol].get("rawSha256") for symbol in sorted(prices)})),
    }
    for sector in sectors:
        sector["sourceRefs"][1]["sourceHash"] = source_hashes["prices"]
    summary = summarize(sectors)
    payload = {
        "schemaVersion": 1,
        "contractVersion": CONTRACT_VERSION,
        "market": "A_SHARE",
        "asOf": as_of,
        "constituentPointInTimePolicy": "current-session-only; no current membership historical backfill",
        "sourceStatus": {
            "constituents": {"provider": "CSI", "status": "ready", "sourceHash": source_hashes["constituents"]},
            "prices": {"provider": "Tencent", "status": "ready" if not price_failures else "partial", "sourceHash": source_hashes["prices"], "failures": sorted(price_failures)[:80]},
        },
        "sourceHashes": source_hashes,
        "summary": summary,
        "sectors": sectors,
    }
    payload["contentHash"] = sha256_bytes(canonical_bytes(payload))
    verify_snapshot_payload(payload)
    return payload


def verify_snapshot_payload(payload: dict[str, Any]) -> None:
    required = {"schemaVersion", "contractVersion", "market", "asOf", "constituentPointInTimePolicy", "sourceStatus", "sourceHashes", "summary", "sectors", "contentHash"}
    if set(payload) != required or payload.get("schemaVersion") != 1 or payload.get("contractVersion") != CONTRACT_VERSION:
        raise ValueError("invalid market breadth snapshot schema")
    if payload.get("market") != "A_SHARE" or len(payload.get("sectors", [])) != 12:
        raise ValueError("market breadth snapshot must cover A_SHARE and 12 sectors")
    expected_hash = sha256_bytes(canonical_bytes({key: value for key, value in payload.items() if key != "contentHash"}))
    if payload.get("contentHash") != expected_hash:
        raise ValueError("market breadth snapshot content hash mismatch")
    for sector in payload["sectors"]:
        required_sector = {"sectorId", "sectorName", "asOf", "constituentEffectiveDate", "totalConstituents", "validConstituents", "validConstituentRatio", "advanceRatio1d", "positiveReturnRatio5d", "aboveMa20Ratio", "status", "warnings", "sourceRefs"}
        if set(sector) != required_sector or sector["asOf"] != payload["asOf"]:
            raise ValueError("invalid sector breadth shape")
        if sector["constituentEffectiveDate"] is None or sector["constituentEffectiveDate"] > payload["asOf"]:
            raise ValueError("invalid point-in-time constituent relationship")
        if not 0 <= finite(sector["validConstituentRatio"]) <= 1:
            raise ValueError("invalid valid constituent ratio")
        for key in ("advanceRatio1d", "positiveReturnRatio5d", "aboveMa20Ratio"):
            value = sector[key]
            if value is not None and not 0 <= finite(value) <= 1:
                raise ValueError(f"invalid {key}")
        if sector["status"] == "ready" and (sector["validConstituents"] < 10 or sector["validConstituentRatio"] < 0.80):
            raise ValueError("ready sector violates breadth quality threshold")


def snapshot_path(root: Path, as_of: str) -> Path:
    year, month, _ = as_of.split("-")
    return root / year / month / f"{as_of}.json.gz"


def write_snapshot(root: Path, payload: dict[str, Any]) -> tuple[Path, bool]:
    verify_snapshot_payload(payload)
    path = snapshot_path(root, payload["asOf"])
    if path.exists():
        existing = read_gzip_json(path)
        verify_snapshot_payload(existing)
        if existing["contentHash"] == payload["contentHash"]:
            return path, False
        raise FileExistsError(f"immutable snapshot conflict for {payload['asOf']}; revision mechanism required")
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = deterministic_gzip(payload)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as handle:
        handle.write(encoded)
        temporary = handle.name
    try:
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    rebuild_index(root)
    return path, True


def rebuild_index(root: Path) -> dict[str, Any]:
    records: dict[str, str] = {}
    for path in sorted(root.glob("????/??/????-??-??.json.gz")):
        snapshot = read_gzip_json(path)
        verify_snapshot_payload(snapshot)
        records[snapshot["asOf"]] = snapshot["contentHash"]
    dates = sorted(records)
    index = {
        "schemaVersion": 1,
        "contractVersion": CONTRACT_VERSION,
        "availableDates": dates,
        "latestAsOf": dates[-1] if dates else None,
        "snapshotHashes": {date: records[date] for date in dates},
    }
    write_json_atomic(root / "index.json", index)
    return index


def collect(as_of: str, root: Path = STORE_ROOT) -> dict[str, Any]:
    now = datetime.now(SHANGHAI)
    if as_of != now.date().isoformat():
        raise ValueError("current CSI membership may only create a snapshot for today's Shanghai session; historical requests are rejected")
    if (now.hour, now.minute) < (15, 5):
        raise ValueError("market breadth snapshot requires a completed Shanghai close at or after 15:05; intraday K-lines are rejected")
    taxonomy = read_json(TAXONOMY_PATH)
    import market_evidence
    with market_evidence.requests_session() as session:
        memberships = {index["code"]: fetch_constituents(session, index["code"], as_of) for index in taxonomy["indices"]}
    symbols = sorted({member["symbol"] for membership in memberships.values() for member in membership["items"]})
    prices: dict[str, dict[str, Any]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        for result in executor.map(lambda symbol: fetch_tencent_kline(symbol, as_of), symbols):
            prices[result["symbol"]] = result
    failures = [f"{symbol}: {item['warning']}" for symbol, item in prices.items() if item.get("warning", "").startswith("Tencent K-line failed")]
    payload = build_snapshot(as_of=as_of, taxonomy=taxonomy, constituent_by_sector=memberships, prices=prices, price_failures=failures)
    path, created = write_snapshot(root, payload)
    return {"path": str(path.relative_to(ROOT)).replace("\\", "/"), "created": created, "summary": payload["summary"], "contentHash": payload["contentHash"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    collect_parser = commands.add_parser("collect", help="collect one current-session immutable breadth snapshot")
    collect_parser.add_argument("--as-of", default=iso_today())
    collect_parser.add_argument("--root", type=Path, default=STORE_ROOT)
    verify = commands.add_parser("verify", help="verify snapshots and rebuildable index")
    verify.add_argument("--root", type=Path, default=STORE_ROOT)
    rebuild = commands.add_parser("rebuild-index", help="rebuild market breadth index")
    rebuild.add_argument("--root", type=Path, default=STORE_ROOT)
    commands.add_parser("source-qualification", help="print bounded provider qualification")
    args = parser.parse_args()
    if args.command == "collect":
        print(json.dumps(collect(args.as_of, args.root), ensure_ascii=False, sort_keys=True))
    elif args.command == "verify":
        print(json.dumps(rebuild_index(args.root), ensure_ascii=False, sort_keys=True))
    elif args.command == "rebuild-index":
        print(json.dumps(rebuild_index(args.root), ensure_ascii=False, sort_keys=True))
    else:
        print(json.dumps(source_qualification(), ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
