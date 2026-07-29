#!/usr/bin/env python3
"""Deterministic market-input collector for 观潮 daily and weekly briefs.

The writing model should not be responsible for discovering quantitative
fields in arbitrary web pages.  This collector turns stable public endpoints
and the local rotation cache into a small, versioned writer packet:

* CSI index history supplies 25-session price, turnover amount and real volume;
* CSI All Share supplies the same-provider turnover-share denominator;
* CSI constituent workbooks plus Tencent batch quotes supply breadth and
  top-three turnover concentration for the target close;
* Hang Seng's public industry snapshot supplies the current 12-industry layer;
* the frozen rotation output is attached without training or changing scores.

No article text, PDF, workbook or raw HTTP response is retained.  Snapshots are
gzip-compressed and pruned by count and total size.
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
import random
import re
import shutil
import statistics
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

try:
    import requests
except ImportError as exc:  # pragma: no cover - runtime diagnostic
    raise SystemExit("market_evidence.py requires requests") from exc

try:
    import xlrd
except ImportError as exc:  # pragma: no cover - runtime diagnostic
    raise SystemExit("market_evidence.py requires xlrd for official CSI .xls files") from exc


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "market-evidence"
SNAPSHOT_DIR = DATA_DIR / "snapshots"
CONSTITUENT_DIR = DATA_DIR / "constituents"
BENCHMARK_DIR = DATA_DIR / "benchmarks"
LATEST_PATH = DATA_DIR / "latest.json"
WEEKLY_PATH = DATA_DIR / "weekly.json"
HEALTH_PATH = DATA_DIR / "health.json"
ROTATION_DATA_DIR = ROOT / "data" / "rotation-model"
ROTATION_HISTORY_DIR = ROTATION_DATA_DIR / "history"
ROTATION_MANIFEST_PATH = ROTATION_DATA_DIR / "manifest.json"
TAXONOMY_PATH = ROOT / "models" / "sector-rotation" / "taxonomy.a-core12-v2.json"
DAILY_BRIEF_PATH = ROOT / "content" / "daily-brief.json"
ROTATION_OUTPUT_PATH = ROOT / "content" / "sector-rotation.json"

SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")
CSI_API = "https://www.csindex.com.cn/csindex-home/perf/index-perf"
CSI_MATERIAL_API = "https://www.csindex.com.cn/csindex-home/indexInfo/index-details-data"
CSI_INDEX_PAGE = "https://www.csindex.com.cn/zh-CN/indices/index-detail/{code}"
CSI_ALL_SHARE_CODE = "000985"
CSI_ALL_SHARE_PAGE = CSI_INDEX_PAGE.format(code=CSI_ALL_SHARE_CODE)
TENCENT_QUOTES_API = "https://qt.gtimg.cn/q="
TENCENT_PROVIDER_PAGE = "https://gu.qq.com/"
HSI_CURRENT_API = "https://www.hsi.com.hk/data/eng/rt/index-series/industry/performance.do"
HSI_INDUSTRY_PAGE = "https://www.hsi.com.hk/eng/indexes/all-indexes/industry"
HSI_DATA_AVAILABILITY = (
    "https://www.hsi.com.hk/static/uploads/contents/en/products/data_subscription/pdf_eng.pdf"
)

HISTORY_SESSIONS = 25
RECENT_SESSIONS = 5
BASELINE_SESSIONS = 20
QUOTE_BATCH_SIZE = 60
MIN_QUOTE_COVERAGE_PCT = 90.0
MAX_SNAPSHOTS = 560
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_CONSTITUENT_VERSIONS = 6

HSI_CODE_NAMES = {
    "00011.01": "能源",
    "00011.02": "原材料",
    "00011.03": "工业",
    "00011.06": "电讯业",
    "00011.07": "公用事业",
    "00011.08": "金融业",
    "00011.09": "地产建筑业",
    "00011.10": "资讯科技业",
    "00011.11": "综合企业",
    "00011.12": "非必需性消费",
    "00011.13": "必需性消费",
    "00011.14": "医疗保健业",
}


def now_iso() -> str:
    return datetime.now(SHANGHAI).isoformat(timespec="seconds")


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", delete=False, dir=path.parent, suffix=".tmp", encoding="utf-8", newline="\n"
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temp_name = handle.name
    try:
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def write_gzip_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as handle:
        temp_name = handle.name
    try:
        with gzip.open(temp_name, "wt", encoding="utf-8", compresslevel=6) as zipped:
            json.dump(payload, zipped, ensure_ascii=False, separators=(",", ":"))
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def read_gzip_json(path: Path) -> Any:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def finite(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def mean_complete(values: Iterable[float | None], expected: int) -> float | None:
    items = list(values)
    if len(items) != expected or any(value is None or value <= 0 for value in items):
        return None
    return statistics.fmean(value for value in items if value is not None)


def ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None or numerator <= 0 or denominator <= 0:
        return None
    return numerator / denominator


def round_or_none(value: float | None, digits: int = 4) -> float | None:
    return None if value is None else round(value, digits)


def requests_session() -> requests.Session:
    session = requests.Session()
    session.trust_env = os.environ.get("MARKET_DATA_USE_ENV_PROXY") == "1"
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json,text/plain,*/*",
        }
    )
    return session


def request_with_retry(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    attempts: int = 4,
    timeout: tuple[float, float] = (10, 45),
) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            response = session.get(url, params=params, headers=headers, timeout=timeout)
            response.raise_for_status()
            return response
        except requests.RequestException as exc:
            last_error = exc
            if attempt + 1 < attempts:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                base = 8.0 if status in {403, 429} else 0.8
                time.sleep(min(30.0, base * (2**attempt)) + random.uniform(0.1, 0.8))
    raise RuntimeError(f"request failed after {attempts} attempts: {last_error}")


def request_json(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    attempts: int = 4,
    timeout: tuple[float, float] = (10, 45),
) -> dict[str, Any]:
    response = request_with_retry(
        session, url, params=params, headers=headers, attempts=attempts, timeout=timeout
    )
    payload = response.json()
    if not isinstance(payload, dict):
        raise ValueError("endpoint returned non-object JSON")
    return payload


def session_dates() -> dict[str, str | None]:
    if not DAILY_BRIEF_PATH.exists():
        return {"a-share": None, "hk": None, "us": None}
    brief = read_json(DAILY_BRIEF_PATH)
    result = {"a-share": None, "hk": None, "us": None}
    for market in brief.get("markets", []):
        market_id = str(market.get("id", ""))
        value = str(market.get("sessionDate", ""))
        if market_id in result and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            result[market_id] = value
    return result


def read_local_history(code: str, through: str) -> list[dict[str, Any]]:
    path = ROTATION_HISTORY_DIR / f"{code}.csv.gz"
    if not path.exists():
        return []
    rows: list[dict[str, Any]] = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for raw in csv.DictReader(handle):
            trading_date = str(raw.get("date", ""))
            if not trading_date or trading_date > through:
                continue
            close = finite(raw.get("close"))
            amount = finite(raw.get("trading_value_yi"))
            volume = finite(raw.get("trading_volume"))
            if close is None or amount is None or volume is None:
                continue
            rows.append(
                {
                    "date": trading_date,
                    "close": close,
                    "amountYi": amount,
                    "volume": volume,
                }
            )
    rows.sort(key=lambda item: item["date"])
    return rows


def fetch_csi_history(
    session: requests.Session, code: str, start: str, end: str
) -> list[dict[str, Any]]:
    payload = request_json(
        session,
        CSI_API,
        params={
            "indexCode": code,
            "startDate": start.replace("-", ""),
            "endDate": end.replace("-", ""),
        },
        headers={"Referer": "https://www.csindex.com.cn/", "X-Requested-With": "XMLHttpRequest"},
        attempts=3,
        timeout=(5, 20),
    )
    if str(payload.get("code")) != "200" or not isinstance(payload.get("data"), list):
        raise ValueError(f"unexpected CSI history payload code={payload.get('code')!r}")
    rows: list[dict[str, Any]] = []
    for raw in payload["data"]:
        if not isinstance(raw, dict):
            continue
        compact = str(raw.get("tradeDate", ""))
        if not re.fullmatch(r"\d{8}", compact):
            continue
        close = finite(raw.get("close"))
        amount = finite(raw.get("tradingValue"))
        volume = finite(raw.get("tradingVol"))
        if close is None or amount is None or volume is None or min(close, amount, volume) <= 0:
            continue
        rows.append(
            {
                "date": f"{compact[:4]}-{compact[4:6]}-{compact[6:]}",
                "close": close,
                "amountYi": amount,
                "volume": volume,
                "constituents": finite(raw.get("consNumber")),
            }
        )
    rows.sort(key=lambda item: item["date"])
    return rows


def load_benchmark_history(
    session: requests.Session, target_date: str, start: str
) -> tuple[list[dict[str, Any]], list[str]]:
    path = BENCHMARK_DIR / f"{CSI_ALL_SHARE_CODE}.json.gz"
    diagnostics: list[str] = []
    cached: list[dict[str, Any]] = read_gzip_json(path) if path.exists() else []
    if cached and cached[-1].get("date") == target_date and len(cached) >= HISTORY_SESSIONS:
        diagnostics.append("reused exact-date CSI All Share cache")
        return cached, diagnostics
    try:
        rows = fetch_csi_history(session, CSI_ALL_SHARE_CODE, start, target_date)
        if len(rows) < HISTORY_SESSIONS or rows[-1]["date"] != target_date:
            raise ValueError(
                f"benchmark ends {rows[-1]['date'] if rows else 'empty'}, target {target_date}"
            )
        write_gzip_json_atomic(path, rows)
        diagnostics.append("refreshed CSI All Share official history")
        return rows, diagnostics
    except Exception as exc:
        diagnostics.append(f"benchmark refresh failed: {exc}")
        if cached:
            diagnostics.append(f"using cache through {cached[-1].get('date')}")
            return cached, diagnostics
        return [], diagnostics


def csi_constituent_url(session: requests.Session, code: str) -> str:
    payload = request_json(
        session,
        CSI_MATERIAL_API,
        params={"fileLang": "2", "indexCode": code},
        headers={"Referer": "https://www.csindex.com.cn/"},
        attempts=2,
        timeout=(5, 18),
    )
    if str(payload.get("code")) != "200" or not isinstance(payload.get("data"), dict):
        raise ValueError(f"CSI materials unavailable for {code}")
    candidates = payload["data"].get("样本列表") or []
    for candidate in candidates:
        if isinstance(candidate, dict) and str(candidate.get("filePath", "")).startswith("https://"):
            return str(candidate["filePath"])
    raise ValueError(f"CSI constituent workbook missing for {code}")


def excel_code(value: Any) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value)).zfill(6)
    text = str(value or "").strip()
    if re.fullmatch(r"\d+(?:\.0+)?", text):
        text = text.split(".")[0]
    return text.zfill(6) if text.isdigit() and len(text) <= 6 else text


def market_prefix(code: str, exchange: str) -> str | None:
    if "上海" in exchange or code.startswith(("5", "6", "9")):
        return "sh"
    if "深圳" in exchange or code.startswith(("0", "1", "2", "3")):
        return "sz"
    if "北京" in exchange or code.startswith(("4", "8")):
        return "bj"
    return None


def parse_constituent_workbook(payload: bytes, source_url: str) -> dict[str, Any]:
    workbook = xlrd.open_workbook(file_contents=payload)
    sheet = workbook.sheet_by_index(0)
    if sheet.nrows < 2 or sheet.ncols < 8:
        raise ValueError("CSI constituent workbook is empty or incomplete")
    rows: list[dict[str, str]] = []
    effective_dates: set[str] = set()
    for row_index in range(1, sheet.nrows):
        compact = excel_code(sheet.cell_value(row_index, 0)).zfill(8)
        code = excel_code(sheet.cell_value(row_index, 4))
        name = str(sheet.cell_value(row_index, 5) or "").strip()
        exchange = str(sheet.cell_value(row_index, 7) or "").strip()
        prefix = market_prefix(code, exchange)
        if not re.fullmatch(r"\d{6}", code) or prefix is None:
            continue
        if re.fullmatch(r"\d{8}", compact):
            effective_dates.add(f"{compact[:4]}-{compact[4:6]}-{compact[6:]}")
        rows.append(
            {
                "code": code,
                "symbol": f"{prefix}{code}",
                "name": name,
                "exchange": exchange,
            }
        )
    if not rows:
        raise ValueError("CSI constituent workbook yielded no valid securities")
    rows.sort(key=lambda item: item["symbol"])
    return {
        "effectiveDate": max(effective_dates) if effective_dates else None,
        "sourceUrl": source_url,
        "sha256": sha256_bytes(payload),
        "count": len(rows),
        "items": rows,
    }


def store_constituent_snapshot(code: str, snapshot: dict[str, Any]) -> Path:
    effective = str(snapshot.get("effectiveDate") or "unknown")
    digest = str(snapshot["sha256"])[:12]
    path = CONSTITUENT_DIR / f"{code}-{effective}-{digest}.json.gz"
    if not path.exists():
        write_gzip_json_atomic(path, snapshot)
    versions = sorted(CONSTITUENT_DIR.glob(f"{code}-*.json.gz"), key=lambda item: item.stat().st_mtime)
    for stale in versions[:-MAX_CONSTITUENT_VERSIONS]:
        stale.unlink(missing_ok=True)
    return path


def load_csi_constituents(
    session: requests.Session, code: str, target_date: str
) -> tuple[dict[str, Any], list[str]]:
    diagnostics: list[str] = []
    cached = sorted(
        CONSTITUENT_DIR.glob(f"{code}-*.json.gz"), key=lambda item: item.stat().st_mtime
    )
    if cached:
        snapshot = read_gzip_json(cached[-1])
        if snapshot.get("effectiveDate") == target_date:
            diagnostics.append(f"reused exact-date official constituent snapshot {cached[-1].name}")
            return snapshot, diagnostics
    try:
        source_url = csi_constituent_url(session, code)
        response = request_with_retry(
            session,
            source_url,
            headers={"Referer": CSI_INDEX_PAGE.format(code=code)},
            attempts=2,
            timeout=(5, 18),
        )
        snapshot = parse_constituent_workbook(response.content, source_url)
        store_constituent_snapshot(code, snapshot)
        return snapshot, diagnostics
    except Exception as exc:
        diagnostics.append(f"official constituent refresh failed: {exc}")
        if not cached:
            raise
        snapshot = read_gzip_json(cached[-1])
        diagnostics.append(f"using cached constituent snapshot {cached[-1].name}")
        return snapshot, diagnostics


def parse_tencent_quote_line(symbol: str, body: str) -> dict[str, Any] | None:
    fields = body.split("~")
    if len(fields) <= 37:
        return None
    current = finite(fields[3])
    previous = finite(fields[4])
    volume_lots = finite(fields[36])
    amount_wan = finite(fields[37])
    timestamp = fields[30].strip()
    if current is None or previous is None or current <= 0 or previous <= 0:
        return None
    return {
        "symbol": symbol,
        "name": fields[1].strip(),
        "date": f"{timestamp[:4]}-{timestamp[4:6]}-{timestamp[6:8]}"
        if re.fullmatch(r"\d{14}", timestamp)
        else None,
        "timestamp": timestamp if re.fullmatch(r"\d{14}", timestamp) else None,
        "current": current,
        "previousClose": previous,
        "changePct": (current / previous - 1) * 100,
        "volumeLots": volume_lots,
        "amountYuan": amount_wan * 10_000 if amount_wan is not None else None,
    }


def quote_is_complete_close(target_date: str, quote: dict[str, Any]) -> bool:
    """Reject a live intraday quote even when its calendar date matches."""
    timestamp = str(quote.get("timestamp") or "")
    return (
        quote.get("date") == target_date
        and re.fullmatch(r"\d{14}", timestamp) is not None
        and timestamp[8:] >= "145700"
    )


def chunks(items: list[str], size: int) -> Iterable[list[str]]:
    for offset in range(0, len(items), size):
        yield items[offset : offset + size]


def fetch_tencent_quotes(
    session: requests.Session, symbols: list[str]
) -> tuple[dict[str, dict[str, Any]], list[str]]:
    quotes: dict[str, dict[str, Any]] = {}
    failures: list[str] = []
    for group in chunks(sorted(set(symbols)), QUOTE_BATCH_SIZE):
        try:
            response = request_with_retry(
                session,
                TENCENT_QUOTES_API + ",".join(group),
                headers={"Referer": TENCENT_PROVIDER_PAGE},
                attempts=3,
                timeout=(5, 15),
            )
            text = response.content.decode("gb18030", errors="replace")
            for symbol, body in re.findall(r'v_([a-z0-9]+)="(.*?)";', text, flags=re.DOTALL):
                parsed = parse_tencent_quote_line(symbol, body)
                if parsed:
                    quotes[symbol] = parsed
        except Exception as exc:
            failures.append(f"{group[0]}..{group[-1]}: {exc}")
        time.sleep(0.12 + random.uniform(0.02, 0.08))
    return quotes, failures


def metric(
    value: float | None,
    *,
    unit: str,
    source_keys: list[str],
    definition: str,
    reason: str | None = None,
    coverage_pct: float | None = None,
) -> dict[str, Any]:
    status = "verified" if value is not None else "insufficient"
    result: dict[str, Any] = {
        "status": status,
        "value": round_or_none(value),
        "unit": unit,
        "definition": definition,
        "sourceKeys": source_keys,
    }
    if reason:
        result["reason"] = reason
    if coverage_pct is not None:
        result["coveragePct"] = round(coverage_pct, 2)
    return result


def aligned_window(
    sector_rows: list[dict[str, Any]], benchmark_rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    benchmark_by_date = {row["date"]: row for row in benchmark_rows}
    aligned_sector = [row for row in sector_rows if row["date"] in benchmark_by_date]
    aligned_sector = aligned_sector[-HISTORY_SESSIONS:]
    aligned_benchmark = [benchmark_by_date[row["date"]] for row in aligned_sector]
    return aligned_sector, aligned_benchmark


def history_metrics(
    sector_rows: list[dict[str, Any]], benchmark_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    sector, benchmark = aligned_window(sector_rows, benchmark_rows)
    sessions = len(sector)
    if sessions != HISTORY_SESSIONS:
        reason = f"only {sessions}/{HISTORY_SESSIONS} aligned complete sessions"
        return {
            "historySessions": sessions,
            "turnoverAmountRatio20d": metric(
                None,
                unit="ratio",
                source_keys=["csi-sector-history"],
                definition="近5日行业日均成交额/此前20日行业日均成交额",
                reason=reason,
            ),
            "tradingVolumeRatio20d": metric(
                None,
                unit="ratio",
                source_keys=["csi-sector-history"],
                definition="近5日行业日均真实成交量/此前20日行业日均真实成交量",
                reason=reason,
            ),
            "turnoverShareRatio20d": metric(
                None,
                unit="ratio",
                source_keys=["csi-sector-history", "csi-all-share-history"],
                definition="近5日行业成交额/中证全指成交额日均份额÷此前20日同口径份额",
                reason=reason,
            ),
            "relativeReturn5d": metric(
                None,
                unit="pct",
                source_keys=["csi-sector-history", "csi-all-share-history"],
                definition="行业5日收益率减中证全指同期收益率",
                reason=reason,
            ),
        }

    recent_sector = sector[-RECENT_SESSIONS:]
    baseline_sector = sector[:BASELINE_SESSIONS]
    recent_benchmark = benchmark[-RECENT_SESSIONS:]
    baseline_benchmark = benchmark[:BASELINE_SESSIONS]

    recent_amount = mean_complete((row["amountYi"] for row in recent_sector), RECENT_SESSIONS)
    baseline_amount = mean_complete(
        (row["amountYi"] for row in baseline_sector), BASELINE_SESSIONS
    )
    recent_volume = mean_complete((row["volume"] for row in recent_sector), RECENT_SESSIONS)
    baseline_volume = mean_complete(
        (row["volume"] for row in baseline_sector), BASELINE_SESSIONS
    )
    recent_shares = [
        ratio(sector_row["amountYi"], benchmark_row["amountYi"])
        for sector_row, benchmark_row in zip(recent_sector, recent_benchmark)
    ]
    baseline_shares = [
        ratio(sector_row["amountYi"], benchmark_row["amountYi"])
        for sector_row, benchmark_row in zip(baseline_sector, baseline_benchmark)
    ]
    recent_share = (
        statistics.fmean(value for value in recent_shares if value is not None)
        if all(value is not None for value in recent_shares)
        else None
    )
    baseline_share = (
        statistics.fmean(value for value in baseline_shares if value is not None)
        if all(value is not None for value in baseline_shares)
        else None
    )
    relative_return = (
        ((sector[-1]["close"] / sector[-6]["close"] - 1)
         - (benchmark[-1]["close"] / benchmark[-6]["close"] - 1))
        * 100
    )
    return {
        "historySessions": sessions,
        "historyStart": sector[0]["date"],
        "historyEnd": sector[-1]["date"],
        "turnoverAmountRatio20d": metric(
            ratio(recent_amount, baseline_amount),
            unit="ratio",
            source_keys=["csi-sector-history"],
            definition="近5日行业日均成交额/此前20日行业日均成交额",
        ),
        "tradingVolumeRatio20d": metric(
            ratio(recent_volume, baseline_volume),
            unit="ratio",
            source_keys=["csi-sector-history"],
            definition="近5日行业日均真实成交量/此前20日行业日均真实成交量",
        ),
        "turnoverShareRatio20d": metric(
            ratio(recent_share, baseline_share),
            unit="ratio",
            source_keys=["csi-sector-history", "csi-all-share-history"],
            definition="近5日行业成交额/中证全指成交额日均份额÷此前20日同口径份额",
        ),
        "relativeReturn5d": metric(
            relative_return,
            unit="pct",
            source_keys=["csi-sector-history", "csi-all-share-history"],
            definition="行业5日收益率减中证全指同期收益率",
        ),
    }


def constituent_metrics(
    target_date: str,
    constituents: list[dict[str, str]],
    quotes: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    matching: list[dict[str, Any]] = []
    price_valid = 0
    advancers = 0
    for constituent in constituents:
        quote = quotes.get(constituent["symbol"])
        if not quote or not quote_is_complete_close(target_date, quote):
            continue
        price_valid += 1
        if quote["current"] > quote["previousClose"]:
            advancers += 1
        amount = finite(quote.get("amountYuan"))
        if amount is not None and amount > 0:
            matching.append(quote)
    count = len(constituents)
    price_coverage = price_valid / count * 100 if count else 0.0
    amount_coverage = len(matching) / count * 100 if count else 0.0
    breadth = advancers / price_valid * 100 if price_valid else None
    total_amount = sum(float(item["amountYuan"]) for item in matching)
    top3 = sorted((float(item["amountYuan"]) for item in matching), reverse=True)[:3]
    concentration = sum(top3) / total_amount * 100 if total_amount > 0 and len(top3) == 3 else None

    breadth_ready = breadth is not None and price_coverage >= MIN_QUOTE_COVERAGE_PCT
    concentration_ready = (
        concentration is not None and amount_coverage >= MIN_QUOTE_COVERAGE_PCT
    )
    date_counts: dict[str, int] = defaultdict(int)
    for symbol in (item["symbol"] for item in constituents):
        quote = quotes.get(symbol)
        if quote and quote.get("date"):
            date_counts[str(quote["date"])] += 1
    observed_dates = sorted(date_counts.items(), key=lambda item: item[1], reverse=True)
    mismatch_reason = (
        None
        if price_coverage >= MIN_QUOTE_COVERAGE_PCT
        else (
            f"target completed close {target_date}; dominant quote date "
            f"{observed_dates[0][0] if observed_dates else 'unavailable'} "
            f"(intraday timestamps are rejected); "
            f"coverage {price_coverage:.1f}%"
        )
    )
    return {
        "constituentCount": count,
        "quoteDateCounts": dict(observed_dates[:4]),
        "priceCoveragePct": round(price_coverage, 2),
        "amountCoveragePct": round(amount_coverage, 2),
        "breadthPct": metric(
            breadth if breadth_ready else None,
            unit="pct",
            source_keys=["csi-constituents", "tencent-batch-quotes"],
            definition="目标收盘日上涨成分股数/可比成分股数",
            reason=mismatch_reason if not breadth_ready else None,
            coverage_pct=price_coverage,
        ),
        "top3ConcentrationPct": metric(
            concentration if concentration_ready else None,
            unit="pct",
            source_keys=["csi-constituents", "tencent-batch-quotes"],
            definition="目标收盘日成交额最高三只成分股成交额/全部可比成分股成交额",
            reason=mismatch_reason if not concentration_ready else None,
            coverage_pct=amount_coverage,
        ),
    }


def publication_state(metrics: dict[str, Any]) -> dict[str, Any]:
    required = [
        "turnoverAmountRatio20d",
        "tradingVolumeRatio20d",
        "turnoverShareRatio20d",
        "breadthPct",
        "relativeReturn5d",
        "top3ConcentrationPct",
    ]
    missing = [
        name for name in required if metrics.get(name, {}).get("status") != "verified"
    ]
    gates = {
        "turnoverAmountRatio20d": 1.35,
        "tradingVolumeRatio20d": 1.20,
        "turnoverShareRatio20d": 1.15,
    }
    passed = {
        name: (
            metrics.get(name, {}).get("status") == "verified"
            and float(metrics[name]["value"]) >= threshold
        )
        for name, threshold in gates.items()
    }
    if missing:
        status = "insufficient"
    elif all(passed.values()):
        status = "verified"
    else:
        status = "none"
    return {
        "volumeStatus": status,
        "strictPublicationEligible": not missing,
        "missingFields": missing,
        "thresholds": gates,
        "thresholdPass": passed,
    }


def source_catalog() -> dict[str, dict[str, Any]]:
    return {
        "csi-sector-history": {
            "name": "中证观察指数日频量价",
            "publisher": "中证指数有限公司",
            "urlTemplate": CSI_INDEX_PAGE,
            "tier": "official",
            "evidenceClass": "exchange-market-data",
            "acquisitionRoute": "CSI public index-perf JSON; serial, cached and retried",
        },
        "csi-all-share-history": {
            "name": "中证全指日频量价",
            "publisher": "中证指数有限公司",
            "url": CSI_ALL_SHARE_PAGE,
            "tier": "official",
            "evidenceClass": "exchange-market-data",
            "acquisitionRoute": "CSI public index-perf JSON; code 000985",
            "denominatorBoundary": "中证全指样本，不冒充沪深京所有上市证券全口径",
        },
        "csi-constituents": {
            "name": "中证指数样本列表",
            "publisher": "中证指数有限公司",
            "urlTemplate": CSI_INDEX_PAGE,
            "tier": "official",
            "evidenceClass": "official-primary",
            "acquisitionRoute": "official current constituent workbook; workbook discarded after parsing",
        },
        "tencent-batch-quotes": {
            "name": "腾讯证券成分股收盘行情",
            "publisher": "腾讯证券",
            "url": TENCENT_PROVIDER_PAGE,
            "tier": "authoritative",
            "evidenceClass": "vendor-market-data",
            "acquisitionRoute": "batch quote endpoint; target date and coverage are mandatory",
        },
        "hsi-industry-current": {
            "name": "Hang Seng Composite Industry Indexes",
            "publisher": "Hang Seng Indexes Company Limited",
            "url": HSI_INDUSTRY_PAGE,
            "tier": "official",
            "evidenceClass": "official-primary",
            "acquisitionRoute": "official current industry performance snapshot",
        },
        "hsi-history-boundary": {
            "name": "Notes on Data Availability",
            "publisher": "Hang Seng Indexes Company Limited",
            "url": HSI_DATA_AVAILABILITY,
            "tier": "official",
            "evidenceClass": "official-primary",
            "acquisitionRoute": "documents the boundary between public and licensed history",
        },
    }


def collect_hsi_current(session: requests.Session, target_date: str | None) -> dict[str, Any]:
    try:
        payload = request_json(
            session,
            HSI_CURRENT_API,
            headers={"Referer": HSI_INDUSTRY_PAGE, "Accept": "application/json"},
            attempts=3,
            timeout=(5, 20),
        )
        lists = [
            series.get("indexList") or []
            for series in payload.get("indexSeriesList") or []
            if isinstance(series, dict)
        ]
        raw_items = next((items for items in lists if items), [])
        items: list[dict[str, Any]] = []
        dates: list[str] = []
        for raw in raw_items:
            code = str(raw.get("indexCode") or "")
            if code not in HSI_CODE_NAMES:
                continue
            value = finite(raw.get("indexValue"))
            change = finite(str(raw.get("changePercentage") or "").replace("+", ""))
            as_of = str(raw.get("lastUpdate") or "")[:10]
            if value is None or change is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", as_of):
                continue
            dates.append(as_of)
            items.append(
                {
                    "code": code,
                    "name": HSI_CODE_NAMES[code],
                    "indexValue": round(value, 2),
                    "changePct": round(change, 4),
                }
            )
        current_date = dates[0] if len(set(dates)) == 1 and dates else None
        ready = (
            len(items) == len(HSI_CODE_NAMES)
            and current_date is not None
            and (target_date is None or current_date == target_date)
        )
        return {
            "status": "ready" if ready else "partial",
            "asOf": current_date or target_date,
            "targetDate": target_date,
            "coverage": f"{len(items)}/{len(HSI_CODE_NAMES)}",
            "reason": None
            if ready
            else f"official current snapshot date={current_date}, target={target_date}, coverage={len(items)}/12",
            "items": sorted(items, key=lambda item: item["changePct"], reverse=True),
            "history": {
                "status": "licensed-boundary",
                "reason": "官方公开页可稳定取得当前12行业快照；可回测的连续历史量价不由该公开接口稳定提供，不能让写作模型补值。",
                "sourceKeys": ["hsi-history-boundary"],
            },
            "sourceKeys": ["hsi-industry-current", "hsi-history-boundary"],
        }
    except Exception as exc:
        return {
            "status": "insufficient",
            "asOf": target_date,
            "targetDate": target_date,
            "coverage": "0/12",
            "reason": f"HSI current snapshot failed: {exc}",
            "items": [],
            "history": {
                "status": "licensed-boundary",
                "reason": "连续历史量价不由公开接口稳定提供。",
                "sourceKeys": ["hsi-history-boundary"],
            },
            "sourceKeys": ["hsi-history-boundary"],
        }


def load_rotation_horizons() -> dict[str, Any]:
    if not ROTATION_OUTPUT_PATH.exists():
        return {}
    payload = read_json(ROTATION_OUTPUT_PATH)
    result: dict[str, Any] = {}
    for market in payload.get("markets", []):
        market_id = str(market.get("id", ""))
        if market_id not in {"a-share", "hk", "us"}:
            continue
        horizons = market.get("horizons", {})
        result[market_id] = {
            "asOf": market.get("asOf"),
            "status": market.get("status"),
            "current": horizons.get("current"),
            "oneWeek": horizons.get("oneWeek"),
            "oneMonth": horizons.get("oneMonth"),
        }
    return result


def volume_leader_entry(sector: dict[str, Any]) -> dict[str, Any]:
    metrics = sector["metrics"]
    amount = float(metrics["turnoverAmountRatio20d"]["value"])
    volume = float(metrics["tradingVolumeRatio20d"]["value"])
    share = float(metrics["turnoverShareRatio20d"]["value"])
    breadth = float(metrics["breadthPct"]["value"])
    relative = float(metrics["relativeReturn5d"]["value"])
    concentration = float(metrics["top3ConcentrationPct"]["value"])
    if relative > 0 and breadth >= 50:
        stage = "acceleration"
    elif relative > 0:
        stage = "divergence"
    elif amount >= 1.6 and breadth < 50:
        stage = "distribution"
    else:
        stage = "early"
    return {
        "sector": sector["name"],
        "code": sector["code"],
        "stage": stage,
        "historySessions": sector["historySessions"],
        "turnoverAmountRatio20d": amount,
        "tradingVolumeRatio20d": volume,
        "turnoverShareRatio20d": share,
        "breadthPct": breadth,
        "relativeReturn5d": relative,
        "top3ConcentrationPct": concentration,
        "sourceKeys": sorted(
            {
                key
                for metric_payload in metrics.values()
                if isinstance(metric_payload, dict)
                for key in metric_payload.get("sourceKeys", [])
            }
        ),
    }


def collect_a_share(session: requests.Session, target_date: str) -> dict[str, Any]:
    taxonomy = read_json(TAXONOMY_PATH)
    start = (datetime.fromisoformat(target_date) - timedelta(days=75)).date().isoformat()
    benchmark_rows, benchmark_diagnostics = load_benchmark_history(
        session, target_date, start
    )

    constituent_by_code: dict[str, dict[str, Any]] = {}
    constituent_diagnostics: dict[str, list[str]] = {}
    symbols: list[str] = []
    for position, index in enumerate(taxonomy["indices"], start=1):
        code = index["code"]
        try:
            snapshot, diagnostics = load_csi_constituents(session, code, target_date)
            constituent_by_code[code] = snapshot
            constituent_diagnostics[code] = diagnostics
            symbols.extend(item["symbol"] for item in snapshot["items"])
        except Exception as exc:
            constituent_diagnostics[code] = [f"constituents unavailable: {exc}"]
        print(
            f"[market-data constituents {position:02d}/{len(taxonomy['indices'])}] "
            f"{code} {constituent_by_code.get(code, {}).get('count', 0)}",
            flush=True,
        )
        time.sleep(0.18 + random.uniform(0.02, 0.10))

    quotes, quote_failures = fetch_tencent_quotes(session, symbols)
    sectors: list[dict[str, Any]] = []
    for index in taxonomy["indices"]:
        code = index["code"]
        history = history_metrics(read_local_history(code, target_date), benchmark_rows)
        snapshot = constituent_by_code.get(code)
        if snapshot:
            current = constituent_metrics(target_date, snapshot["items"], quotes)
        else:
            reason = "; ".join(constituent_diagnostics.get(code, [])) or "constituents unavailable"
            current = {
                "constituentCount": 0,
                "quoteDateCounts": {},
                "priceCoveragePct": 0.0,
                "amountCoveragePct": 0.0,
                "breadthPct": metric(
                    None,
                    unit="pct",
                    source_keys=["csi-constituents", "tencent-batch-quotes"],
                    definition="目标收盘日上涨成分股数/可比成分股数",
                    reason=reason,
                    coverage_pct=0.0,
                ),
                "top3ConcentrationPct": metric(
                    None,
                    unit="pct",
                    source_keys=["csi-constituents", "tencent-batch-quotes"],
                    definition="目标收盘日成交额最高三只成分股成交额/全部可比成分股成交额",
                    reason=reason,
                    coverage_pct=0.0,
                ),
            }
        metrics = {
            "turnoverAmountRatio20d": history["turnoverAmountRatio20d"],
            "tradingVolumeRatio20d": history["tradingVolumeRatio20d"],
            "turnoverShareRatio20d": history["turnoverShareRatio20d"],
            "breadthPct": current["breadthPct"],
            "relativeReturn5d": history["relativeReturn5d"],
            "top3ConcentrationPct": current["top3ConcentrationPct"],
        }
        sector = {
            "code": code,
            "name": index["shortName"],
            "role": index.get("role"),
            "focusTag": index.get("focusTag"),
            "asOf": target_date,
            "historySessions": history["historySessions"],
            "historyStart": history.get("historyStart"),
            "historyEnd": history.get("historyEnd"),
            "constituentSnapshot": {
                "status": "ready" if snapshot else "insufficient",
                "effectiveDate": snapshot.get("effectiveDate") if snapshot else None,
                "count": snapshot.get("count") if snapshot else 0,
                "sha256": snapshot.get("sha256") if snapshot else None,
                "sourceUrl": snapshot.get("sourceUrl") if snapshot else None,
                "diagnostics": constituent_diagnostics.get(code, []),
            },
            "quoteCoverage": {
                "pricePct": current["priceCoveragePct"],
                "amountPct": current["amountCoveragePct"],
                "dates": current["quoteDateCounts"],
            },
            "metrics": metrics,
        }
        sector["publication"] = publication_state(metrics)
        sectors.append(sector)

    verified = [
        volume_leader_entry(sector)
        for sector in sectors
        if sector["publication"]["volumeStatus"] == "verified"
    ]
    verified.sort(
        key=lambda item: (
            item["turnoverAmountRatio20d"]
            * item["tradingVolumeRatio20d"]
            * item["turnoverShareRatio20d"]
        ),
        reverse=True,
    )
    eligible_count = sum(
        sector["publication"]["strictPublicationEligible"] for sector in sectors
    )
    if verified:
        overall_volume_status = "verified"
    elif eligible_count == len(sectors):
        overall_volume_status = "none"
    else:
        overall_volume_status = "insufficient"

    field_coverage = {
        field: sum(
            sector["metrics"][field]["status"] == "verified" for sector in sectors
        )
        for field in (
            "turnoverAmountRatio20d",
            "tradingVolumeRatio20d",
            "turnoverShareRatio20d",
            "breadthPct",
            "relativeReturn5d",
            "top3ConcentrationPct",
        )
    }
    missing_fields = [
        f"{field}: {count}/{len(sectors)}"
        for field, count in field_coverage.items()
        if count < len(sectors)
    ]
    status = "ready" if eligible_count == len(sectors) else "partial"
    history_current_count = 0
    for index in taxonomy["indices"]:
        local_rows = read_local_history(index["code"], target_date)
        if local_rows and local_rows[-1]["date"] == target_date:
            history_current_count += 1
    return {
        "status": status,
        "asOf": target_date,
        "universe": {
            "id": taxonomy["documentVersion"],
            "name": taxonomy["name"],
            "count": len(taxonomy["indices"]),
            "taxonomyPath": str(TAXONOMY_PATH.relative_to(ROOT)).replace("\\", "/"),
        },
        "benchmark": {
            "code": CSI_ALL_SHARE_CODE,
            "name": "中证全指",
            "status": "ready"
            if len(benchmark_rows) >= HISTORY_SESSIONS
            and benchmark_rows[-1]["date"] == target_date
            else "insufficient",
            "sessions": len(benchmark_rows),
            "lastDate": benchmark_rows[-1]["date"] if benchmark_rows else None,
            "diagnostics": benchmark_diagnostics,
            "sourceKeys": ["csi-all-share-history"],
        },
        "collection": {
            "sectorHistoryCoverage": f"{history_current_count}/{len(taxonomy['indices'])}",
            "constituentCoverage": f"{len(constituent_by_code)}/{len(taxonomy['indices'])}",
            "uniqueQuoteSymbols": len(set(symbols)),
            "quotesReturned": len(quotes),
            "quoteBatchFailures": quote_failures,
            "fieldCoverage": field_coverage,
        },
        "publicationSummary": {
            "volumeStatus": overall_volume_status,
            "eligibleSectors": eligible_count,
            "volumeLeaders": verified[:4],
            "missingFields": missing_fields,
            "note": (
                "只有三项量比、广度、5日相对收益和前三成交集中度都通过目标日期与覆盖率校验时，"
                "该行业才有资格写入文章的 verified/none 判定。"
            ),
        },
        "sectors": sectors,
        "sourceKeys": [
            "csi-sector-history",
            "csi-all-share-history",
            "csi-constituents",
            "tencent-batch-quotes",
        ],
    }


def writer_packet(payload: dict[str, Any]) -> dict[str, Any]:
    a_share = payload["markets"]["a-share"]
    hk = payload["markets"]["hk"]
    rotations = payload.get("rotationModel", {})
    return {
        "rules": [
            "先读取本文件，再做新闻检索；不得让写作模型从搜索摘要重算这里已有的数值。",
            "article.rotationAnalysis.volumeStatus 与 volumeLeaders 优先采用 a-share.publicationSummary；引用要映射 sourceKeys 到文章 sources。",
            "预测可用性以 rotationModel 对应窗口为准；ready 窗口不得仅因写作检索未找到新闻而改成 insufficient。",
            "数据状态逐字段表达；一个字段缺失不能抹掉其他已经验证的字段。",
            "港股连续行业历史属于独立采集边界；当前快照 ready 不等于一周/月回测 ready。",
        ],
        "aShare": {
            "asOf": a_share["asOf"],
            "status": a_share["status"],
            "volume": a_share["publicationSummary"],
            "forecastAvailability": rotations.get("a-share", {}),
        },
        "hk": {
            "asOf": hk.get("asOf"),
            "status": hk.get("status"),
            "currentIndustryCoverage": hk.get("coverage"),
            "history": hk.get("history"),
            "forecastAvailability": rotations.get("hk", {}),
        },
    }


def prune_storage() -> dict[str, Any]:
    SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
    snapshots = sorted(SNAPSHOT_DIR.glob("*.json.gz"), key=lambda item: item.stat().st_mtime)
    removed: list[str] = []
    while len(snapshots) > MAX_SNAPSHOTS:
        stale = snapshots.pop(0)
        removed.append(stale.name)
        stale.unlink(missing_ok=True)
    constituent_files = list(CONSTITUENT_DIR.glob("*.json.gz")) if CONSTITUENT_DIR.exists() else []
    all_files = snapshots + constituent_files
    total = sum(path.stat().st_size for path in all_files if path.exists())
    while snapshots and total > MAX_TOTAL_BYTES:
        stale = snapshots.pop(0)
        size = stale.stat().st_size
        removed.append(stale.name)
        stale.unlink(missing_ok=True)
        total -= size
    constituent_files = list(CONSTITUENT_DIR.glob("*.json.gz")) if CONSTITUENT_DIR.exists() else []
    total = sum(path.stat().st_size for path in snapshots + constituent_files if path.exists())
    return {
        "compressedBytes": total,
        "maxBytes": MAX_TOTAL_BYTES,
        "snapshotCount": len(snapshots),
        "constituentSnapshotCount": len(constituent_files),
        "removed": removed,
    }


def collect_daily(args: argparse.Namespace) -> dict[str, Any]:
    sessions = session_dates()
    target_a = args.a_share_date or sessions["a-share"]
    target_hk = args.hk_date or sessions["hk"]
    if not target_a:
        raise RuntimeError("daily-brief.json is missing A-share sessionDate")
    phase = args.phase or ("morning" if datetime.now(SHANGHAI).hour < 12 else "close")
    if LATEST_PATH.exists() and not args.force:
        existing = read_json(LATEST_PATH)
        targets = existing.get("targetSessions", {})
        if (
            existing.get("phase") == phase
            and targets.get("a-share") == target_a
            and targets.get("hk") == target_hk
        ):
            print(
                f"[market-data] reused idempotent {target_a}-{phase} packet; pass --force to refresh",
                flush=True,
            )
            return existing
    session = requests_session()
    a_share = collect_a_share(session, target_a)
    hk = collect_hsi_current(session, target_hk)
    payload: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "mode": "daily",
        "phase": phase,
        "targetSessions": sessions | {"a-share": target_a, "hk": target_hk},
        "sourceCatalog": source_catalog(),
        "markets": {"a-share": a_share, "hk": hk},
        "rotationModel": load_rotation_horizons(),
        "storagePolicy": {
            "rawPagesStored": False,
            "rawWorkbooksStored": False,
            "compressedSnapshots": True,
            "maxTotalBytes": MAX_TOTAL_BYTES,
            "maxSnapshots": MAX_SNAPSHOTS,
        },
    }
    payload["writerPacket"] = writer_packet(payload)
    write_json_atomic(LATEST_PATH, payload)
    snapshot_path = SNAPSHOT_DIR / f"{target_a}-{phase}.json.gz"
    write_gzip_json_atomic(snapshot_path, payload)
    payload["storage"] = prune_storage()
    write_json_atomic(LATEST_PATH, payload)
    print(
        f"[market-data] A={a_share['status']} volume={a_share['publicationSummary']['volumeStatus']} "
        f"eligible={a_share['publicationSummary']['eligibleSectors']}/{a_share['universe']['count']} "
        f"HK={hk['status']} output={LATEST_PATH.relative_to(ROOT)}",
        flush=True,
    )
    return payload


def weekly_context(_: argparse.Namespace) -> dict[str, Any]:
    if not LATEST_PATH.exists():
        raise RuntimeError("latest market evidence is missing; run daily first")
    candidates = sorted(SNAPSHOT_DIR.glob("*.json.gz"), key=lambda item: item.stat().st_mtime)
    by_date: dict[str, Path] = {}
    for path in candidates:
        match = re.match(r"(\d{4}-\d{2}-\d{2})-", path.name)
        if match:
            by_date[match.group(1)] = path
    selected = [by_date[key] for key in sorted(by_date)[-5:]]
    snapshots = [read_gzip_json(path) for path in selected]
    sectors: dict[str, dict[str, Any]] = {}
    for snapshot in snapshots:
        for sector in snapshot.get("markets", {}).get("a-share", {}).get("sectors", []):
            entry = sectors.setdefault(
                sector["code"], {"code": sector["code"], "name": sector["name"], "sessions": []}
            )
            entry["sessions"].append(
                {
                    "date": sector["asOf"],
                    "volumeStatus": sector["publication"]["volumeStatus"],
                    "turnoverAmountRatio20d": sector["metrics"]["turnoverAmountRatio20d"]["value"],
                    "tradingVolumeRatio20d": sector["metrics"]["tradingVolumeRatio20d"]["value"],
                    "turnoverShareRatio20d": sector["metrics"]["turnoverShareRatio20d"]["value"],
                    "breadthPct": sector["metrics"]["breadthPct"]["value"],
                    "relativeReturn5d": sector["metrics"]["relativeReturn5d"]["value"],
                }
            )
    for entry in sectors.values():
        entry["verifiedDays"] = sum(
            session["volumeStatus"] == "verified" for session in entry["sessions"]
        )
        entry["completeDays"] = sum(
            all(
                session[field] is not None
                for field in (
                    "turnoverAmountRatio20d",
                    "tradingVolumeRatio20d",
                    "turnoverShareRatio20d",
                    "breadthPct",
                    "relativeReturn5d",
                )
            )
            for session in entry["sessions"]
        )
    payload = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "mode": "weekly",
        "sessionCount": len(snapshots),
        "sessionDates": [snapshot["markets"]["a-share"]["asOf"] for snapshot in snapshots],
        "status": "ready" if len(snapshots) >= 5 else "accumulating",
        "reason": None
        if len(snapshots) >= 5
        else f"本地仅有{len(snapshots)}/5个不同交易日的结构化快照；不回填网页全文。",
        "aShareSectors": sorted(sectors.values(), key=lambda item: item["code"]),
        "latestWriterPacket": read_json(LATEST_PATH).get("writerPacket"),
    }
    write_json_atomic(WEEKLY_PATH, payload)
    print(
        f"[market-data weekly] sessions={len(snapshots)}/5 output={WEEKLY_PATH.relative_to(ROOT)}",
        flush=True,
    )
    return payload


def directory_bytes(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def health_report(_: argparse.Namespace) -> dict[str, Any]:
    sessions = session_dates()
    manifest = read_json(ROTATION_MANIFEST_PATH) if ROTATION_MANIFEST_PATH.exists() else {}
    latest = read_json(LATEST_PATH) if LATEST_PATH.exists() else None
    taxonomy = read_json(TAXONOMY_PATH)
    history_dates: dict[str, str | None] = {}
    for index in taxonomy["indices"]:
        rows = read_local_history(index["code"], "9999-12-31")
        history_dates[index["code"]] = rows[-1]["date"] if rows else None
    payload = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "targetSessions": sessions,
        "rotationHistory": {
            "coverage": f"{sum(value is not None for value in history_dates.values())}/{len(history_dates)}",
            "dates": history_dates,
            "manifestUpdatedAt": manifest.get("updatedAt"),
        },
        "latestEvidence": {
            "exists": latest is not None,
            "generatedAt": latest.get("generatedAt") if latest else None,
            "aShareAsOf": latest.get("markets", {}).get("a-share", {}).get("asOf") if latest else None,
            "aShareStatus": latest.get("markets", {}).get("a-share", {}).get("status") if latest else None,
            "hkStatus": latest.get("markets", {}).get("hk", {}).get("status") if latest else None,
        },
        "storage": {
            "bytes": directory_bytes(DATA_DIR),
            "maxBytes": MAX_TOTAL_BYTES,
        },
        "providerBoundaries": {
            "aShare": "official history + official constituents + dated vendor close; deterministic",
            "hk": "official current industry snapshot; continuous public history remains a licensed-data boundary",
        },
    }
    write_json_atomic(HEALTH_PATH, payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    daily = commands.add_parser("daily", help="collect the deterministic daily writer packet")
    daily.add_argument("--phase", choices=["morning", "close"])
    daily.add_argument("--a-share-date")
    daily.add_argument("--hk-date")
    daily.add_argument("--force", action="store_true")
    daily.set_defaults(func=collect_daily)

    weekly = commands.add_parser("weekly", help="aggregate the last five compact daily snapshots")
    weekly.set_defaults(func=weekly_context)

    health = commands.add_parser("health", help="inspect local coverage without network access")
    health.set_defaults(func=health_report)
    run = commands.add_parser("run", help="P1-E immutable writer-packet run")
    run.add_argument("--edition", choices=["daily", "weekly"], required=True)
    run.add_argument("--as-of", default="auto")
    run.add_argument("--dry-run", action="store_true")
    def run_pipeline(args: argparse.Namespace) -> dict[str, Any]:
        from market_evidence_sources import collect_sources
        from market_evidence_packet import persist
        as_of = datetime.now(SHANGHAI).date().isoformat() if args.as_of == "auto" else args.as_of
        sources, treasury = collect_sources(args.edition, as_of)
        result = persist(args.edition, as_of, treasury, sources, None, args.dry_run)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return result
    run.set_defaults(func=run_pipeline)
    return root


def main() -> None:
    args = parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
