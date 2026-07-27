#!/usr/bin/env python3
"""Low-memory CSI/Hang Seng sector rotation research pipeline.

The numerical model is intentionally small and deterministic:
* one gzip file per CSI index;
* one sector is loaded at a time while features are built;
* model fitting scans the derived gzip file and keeps only small sufficient
  statistics in memory;
* walk-forward evaluation never random-splits time series.

Daily automation should run ``refresh``: it refreshes structured inputs,
rebuilds features and applies the frozen model without fitting it. ``train``
and ``pipeline`` are explicit model-review operations.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import math
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator
from urllib.parse import urlencode, urlparse

try:
    import requests
except ImportError as exc:  # pragma: no cover - explicit runtime diagnostic
    raise SystemExit("sector_rotation.py requires the small 'requests' package") from exc


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / "models" / "sector-rotation"
DATA_DIR = ROOT / "data" / "rotation-model"
HISTORY_DIR = DATA_DIR / "history"
FEATURE_DIR = DATA_DIR / "features"
EVENT_DIR = DATA_DIR / "events"
TAXONOMY_PATH = MODEL_DIR / "taxonomy.a-core12-v2.json"
CALENDAR_PATH = MODEL_DIR / "cn-market-calendar-2026.json"
FEATURE_PATH = FEATURE_DIR / "a-share-features.csv.gz"
MODEL_PATH = MODEL_DIR / "a-share-v1.json"
PROBABILITY_MODEL_PATH = MODEL_DIR / "a-share-up-probability-v1.json"
MULTI_TARGET_MODEL_PATH = MODEL_DIR / "a-share-relative-probability-v2.json"
HOLDOUT_REGISTRY_PATH = MODEL_DIR / "holdout-registry.json"
CONTENT_PATH = ROOT / "content" / "sector-rotation.json"
MANIFEST_PATH = DATA_DIR / "manifest.json"
EVENT_PATH = EVENT_DIR / "events.jsonl.gz"
EVENT_SEED_PATH = MODEL_DIR / "long-money-events.seed.jsonl"
DAILY_BRIEF_PATH = ROOT / "content" / "daily-brief.json"
PREDICTION_HISTORY_PATH = ROOT / "content" / "prediction-history.json"

# The benchmark is deliberately separate from the ranked universe.  Focus
# sectors may receive deeper collection, but neither they nor their ETFs are
# allowed to alter this market-wide reference return.
A_SHARE_BENCHMARK = {
    "code": "000985",
    "name": "中证全指",
    "shortName": "中证全指",
    "market": "sh",
    "role": "benchmark",
    "factsheetUrl": "https://www.csindex.com.cn/zh-CN/indices/index-detail/000985",
}
BENCHMARK_HISTORY_PATH = HISTORY_DIR / f"{A_SHARE_BENCHMARK['code']}.csv.gz"

CSI_API = "https://www.csindex.com.cn/csindex-home/perf/index-perf"
CSI_REFERER = "https://www.csindex.com.cn/"
BAIDU_KLINE_API = "https://finance.pae.baidu.com/selfselect/getstockquotation"
BAIDU_REFERER = "https://gushitong.baidu.com/"
TENCENT_KLINE_API = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
# Baidu resolves some 000xxx index-looking codes as Shenzhen equities.  Keep
# this allow-list deliberately narrow instead of inferring eligibility from a
# numeric prefix or taxonomy role.
BAIDU_FALLBACK_CODES = frozenset({"399967", "399970"})
# CSI publishes OHLC rounded to 0.1 index point in a small number of rows.  A
# close/open can consequently exceed the rounded high (or undershoot the low)
# by exactly 0.1; 0.11 absorbs that representation error without accepting a
# materially inconsistent bar.
CSI_OHLC_TOLERANCE_POINTS = 0.11
HSI_CURRENT_API = "https://www.hsi.com.hk/data/eng/rt/index-series/industry/performance.do"
HSI_INDUSTRY_PAGE = "https://www.hsi.com.hk/eng/indexes/all-indexes/industry"
# China Standard Time has no daylight-saving transition; a fixed offset keeps
# the unattended Windows fallback independent of an optional tzdata package.
SHANGHAI = timezone(timedelta(hours=8), name="Asia/Shanghai")

FEATURES = [
    "momentum5",
    "momentum20",
    "momentum60",
    "reversal1",
    "volatility20",
    "drawdown60",
    "amountRatio5v20",
    "volumeRatio5v20",
    "priceVolumeAcceleration",
]
MODEL_FEATURES = [f"cs_{feature}" for feature in FEATURES]

# The live model is deliberately bounded to the latest ~2 trading years.  The
# older panel is still evaluated as a stress sample, but it cannot dilute the
# current regime fit.  These are trading-session counts, not calendar days or
# sector-row counts.
PRIMARY_WINDOW_SESSIONS = 504
SELECTION_WINDOW_SESSIONS = 504
LOCKED_HOLDOUT_SESSIONS = 252
WALK_FORWARD_BLOCK_SESSIONS = 63
MINIMUM_TRAINING_DATES = 504
HOLDOUT_PROTOCOL_ID = "a-core12-v2-rolling504-select504-holdout252-v1"

# A compact, interpretable nonlinear candidate.  It only transforms values
# already known at the as-of close; no revised fundamentals, future
# constituents or later news can enter these terms.  Candidate choice is made
# before the locked holdout is opened.
NONLINEAR_MODEL_FEATURES = [
    *MODEL_FEATURES,
    "nl_momentum_acceleration",
    "nl_medium_trend_acceleration",
    "nl_momentum5_x_amount",
    "nl_momentum20_x_volume",
    "nl_trend_x_drawdown",
    "nl_reversal_x_volatility",
    "nl_momentum5_squared",
    "nl_drawdown_squared",
]

MODEL_CANDIDATES = [
    {
        "id": "rolling-linear-ridge",
        "type": "rolling-standardized-ridge",
        "featureNames": MODEL_FEATURES,
        "ridge": 20.0,
        "complexity": "baseline",
    },
    {
        "id": "rolling-interaction-ridge",
        "type": "rolling-standardized-interaction-ridge",
        "featureNames": NONLINEAR_MODEL_FEATURES,
        "ridge": 80.0,
        "complexity": "nonlinear-candidate",
    },
]

FEATURE_DESCRIPTIONS = {
    "momentum5": "5个交易日价格动量",
    "momentum20": "20个交易日价格动量",
    "momentum60": "60个交易日价格动量",
    "reversal1": "前一交易日收益率的反向值",
    "volatility20": "20个交易日日收益波动率",
    "drawdown60": "相对60日最高收盘的回撤",
    "amountRatio5v20": "近5日平均成交额/此前20日平均成交额的对数",
    "volumeRatio5v20": "近5日平均成交量/此前20日平均成交量的对数",
    "priceVolumeAcceleration": "5日动量与成交额相对放量的交互项",
}
MODEL_FEATURE_DESCRIPTIONS = {
    f"cs_{feature}": f"当日行业横截面标准化：{description}"
    for feature, description in FEATURE_DESCRIPTIONS.items()
}
MODEL_FEATURE_DESCRIPTIONS.update(
    {
        "nl_momentum_acceleration": "5日相对动量减20日相对动量，刻画短期趋势加速度",
        "nl_medium_trend_acceleration": "20日相对动量减60日相对动量，刻画中期趋势变化",
        "nl_momentum5_x_amount": "5日相对动量与成交额活跃度的交互项",
        "nl_momentum20_x_volume": "20日相对动量与真实成交量活跃度的交互项",
        "nl_trend_x_drawdown": "20日相对动量与60日回撤的交互项",
        "nl_reversal_x_volatility": "单日反转与20日波动率的交互项",
        "nl_momentum5_squared": "5日相对动量平方项，用于检测非线性极端状态",
        "nl_drawdown_squared": "60日回撤平方项，用于检测非线性压力状态",
    }
)

HISTORY_FIELDS = [
    "date",
    "code",
    "name",
    "close",
    "change_pct",
    "trading_volume",
    "trading_value_yi",
    "constituents",
]

RAW_FEATURE_FIELDS = [
    "date",
    "code",
    "name",
    *FEATURES,
]

FEATURE_FIELDS = [
    "date",
    "code",
    "name",
    *FEATURES,
    *MODEL_FEATURES,
]

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
    return datetime.now(SHANGHAI).replace(microsecond=0).isoformat()


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def daily_brief_session(market_id: str) -> str | None:
    if not DAILY_BRIEF_PATH.exists():
        return None
    try:
        brief = read_json(DAILY_BRIEF_PATH)
    except (OSError, ValueError, TypeError):
        return None
    market = next(
        (item for item in brief.get("markets", []) if item.get("id") == market_id),
        None,
    )
    value = str(market.get("sessionDate", "")) if market else ""
    return value if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None


def write_json_atomic(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", newline="", delete=False, dir=path.parent, suffix=".tmp"
    ) as handle:
        handle.write(encoded)
        temp_name = handle.name
    os.replace(temp_name, path)


def record_holdout_opening(
    horizon: int,
    opened_dates: list[str],
    *,
    selection_end: str,
    candidate_id: str,
) -> None:
    """Append an opened holdout boundary once; never rewrite prior openings."""
    if len(opened_dates) != LOCKED_HOLDOUT_SESSIONS:
        raise RuntimeError("refusing to record a holdout that is not exactly 252 dates")
    registry = read_json(HOLDOUT_REGISTRY_PATH)
    bucket = registry.setdefault("horizons", {}).setdefault(str(horizon), {"openings": []})
    openings = bucket.setdefault("openings", [])
    if openings and opened_dates[0] <= str(openings[-1]["end"]):
        raise RuntimeError("refusing to overlap or reopen an immutable holdout")
    openings.append(
        {
            "openedAt": now_iso(),
            "start": opened_dates[0],
            "end": opened_dates[-1],
            "dates": len(opened_dates),
            "dateListSha256": canonical_json_sha256(opened_dates),
            "protocolId": HOLDOUT_PROTOCOL_ID,
            "featurePanelSha256": sha256_path(FEATURE_PATH),
            "selectionEnd": selection_end,
            "consumedBy": candidate_id,
        }
    )
    write_json_atomic(HOLDOUT_REGISTRY_PATH, registry)


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_sha256(payload: Any) -> str:
    """Hash JSON semantics, independent of indentation and line endings."""
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def valid_ohlc(
    open_value: float | None,
    high: float | None,
    low: float | None,
    close: float | None,
    *,
    tolerance: float = 0.0,
) -> bool:
    """Return whether a daily bar is internally consistent within source precision."""
    values = (open_value, high, low, close)
    if any(value is None or value <= 0 for value in values):
        return False
    assert open_value is not None and high is not None and low is not None and close is not None
    return (
        high + tolerance >= max(open_value, close)
        and low - tolerance <= min(open_value, close)
        and high + tolerance >= low
    )


def baidu_fallback_allowed(index: dict[str, Any]) -> bool:
    """Permit Baidu only for the two explicitly reviewed 399 theme indices."""
    code = str(index.get("code", ""))
    return code.startswith("399") and code in BAIDU_FALLBACK_CODES


def fmt_float(value: float | None, digits: int = 10) -> str:
    if value is None or not math.isfinite(value):
        return ""
    return f"{value:.{digits}g}"


def parse_yyyymmdd(raw: Any) -> str | None:
    text = str(raw or "")
    if not re.fullmatch(r"\d{8}", text):
        return None
    try:
        return datetime.strptime(text, "%Y%m%d").date().isoformat()
    except ValueError:
        return None


def as_of_compact(raw: Any) -> str:
    text = str(raw or "")
    return text.replace("-", "") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text) else ""


def load_manifest() -> dict[str, Any]:
    if MANIFEST_PATH.exists():
        return read_json(MANIFEST_PATH)
    return {"schemaVersion": 1, "updatedAt": None, "aShareHistory": {}}


def requests_session() -> requests.Session:
    session = requests.Session()
    # Windows GUI proxies can intermittently reset these public endpoints. Both
    # official endpoints work directly; users can opt back in via an env flag.
    session.trust_env = os.environ.get("ROTATION_USE_ENV_PROXY") == "1"
    session.headers.update(
        {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json",
        }
    )
    return session


def fetch_json_with_retry(
    session: requests.Session,
    url: str,
    *,
    params: dict[str, str] | None = None,
    headers: dict[str, str] | None = None,
    attempts: int = 4,
) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            response = session.get(url, params=params, headers=headers, timeout=(10, 45))
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict):
                raise ValueError("endpoint returned non-object JSON")
            return payload
        except (requests.RequestException, ValueError) as exc:
            last_error = exc
            if attempt + 1 < attempts:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status in {403, 429}:
                    # A public-site rate gate needs a genuine cooldown; rapid
                    # retries only prolong the block.
                    time.sleep(min(45.0, 10.0 * (2**attempt)) + random.uniform(0.5, 1.5))
                    session.close()
                    session = requests_session()
                else:
                    time.sleep(min(8.0, 0.8 * (2**attempt)) + random.uniform(0.1, 0.4))
    raise RuntimeError(f"request failed after {attempts} attempts: {last_error}")


def fetch_json_via_curl(
    url: str,
    *,
    params: dict[str, str],
    headers: dict[str, str],
) -> dict[str, Any]:
    """Alternative HTTP transport for public endpoints that fingerprint Python TLS."""
    curl = shutil.which("curl") or shutil.which("curl.exe")
    if not curl:
        raise RuntimeError("curl transport is unavailable")
    command = [curl, "--fail", "--silent", "--show-error", "--location", "--max-time", "45"]
    for name, value in headers.items():
        command.extend(["--header", f"{name}: {value}"])
    command.append(f"{url}?{urlencode(params)}")
    result = subprocess.run(command, capture_output=True, text=True, timeout=55, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"curl request failed: {result.stderr.strip()}")
    payload = json.loads(result.stdout)
    if not isinstance(payload, dict):
        raise ValueError("curl endpoint returned non-object JSON")
    return payload


def write_history(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp") as raw:
        temp_name = raw.name
    try:
        with gzip.open(temp_name, "wt", encoding="utf-8", newline="", compresslevel=6) as handle:
            writer = csv.DictWriter(handle, fieldnames=HISTORY_FIELDS)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def existing_history_rows(path: Path) -> dict[str, dict[str, Any]]:
    if not path.exists():
        return {}
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        return {row["date"]: row for row in csv.DictReader(handle) if row.get("date")}


def request_chunks(start_text: str, end_text: str) -> list[tuple[str, str]]:
    """Split into <=12 calendar-year chunks to minimize CSI WAF pressure."""
    start = date.fromisoformat(start_text)
    end = date.fromisoformat(end_text)
    chunks: list[tuple[str, str]] = []
    cursor = start
    while cursor <= end:
        chunk_end = min(end, date(min(cursor.year + 11, 9999), 12, 31))
        chunks.append((cursor.isoformat(), chunk_end.isoformat()))
        cursor = chunk_end + timedelta(days=1)
    return chunks


def parse_baidu_history(
    session: requests.Session,
    index: dict[str, Any],
    start_text: str,
    end_text: str,
) -> list[dict[str, Any]]:
    """Fetch a bounded vendor fallback with OHLC, volume and turnover amount."""
    if not baidu_fallback_allowed(index):
        raise ValueError(
            f"Baidu fallback is not permitted for {index.get('code', '')}; "
            "only explicitly reviewed 399 theme indices are eligible"
        )
    params = {
        "all": "1",
        "isIndex": "true",
        "isBk": "false",
        "isBlock": "false",
        "isFutures": "false",
        "isStock": "false",
        "newFormat": "1",
        "group": "quotation_kline_ab",
        "finClientType": "pc",
        "code": index["code"],
        "start_time": "",
        "ktype": "1",
    }
    headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/vnd.finance-web.v1+json",
        "Origin": "https://gushitong.baidu.com",
        "Referer": BAIDU_REFERER,
    }
    payload = fetch_json_with_retry(
        session,
        BAIDU_KLINE_API,
        params=params,
        headers=headers,
    )
    market_data = (payload.get("Result") or {}).get("newMarketData") or {}
    keys = market_data.get("keys") or []
    raw_text = market_data.get("marketData") or ""
    if not isinstance(keys, list) or not keys:
        payload = fetch_json_via_curl(BAIDU_KLINE_API, params=params, headers=headers)
        market_data = (payload.get("Result") or {}).get("newMarketData") or {}
        keys = market_data.get("keys") or []
        raw_text = market_data.get("marketData") or ""
    if not isinstance(keys, list) or not isinstance(raw_text, str):
        raise ValueError("unexpected Baidu K-line payload")
    positions = {str(key): position for position, key in enumerate(keys)}
    required = {"time", "open", "high", "low", "close", "volume", "amount", "preClose"}
    if not required <= set(positions):
        raise ValueError(f"Baidu K-line fields missing: {sorted(required - set(positions))}")
    rows: list[dict[str, Any]] = []
    for raw_row in raw_text.split(";"):
        values = raw_row.split(",")
        if len(values) < len(keys):
            continue
        trading_date = values[positions["time"]]
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", trading_date):
            continue
        if trading_date < start_text or trading_date > end_text:
            continue
        close = finite(values[positions["close"]])
        open_value = finite(values[positions["open"]])
        high = finite(values[positions["high"]])
        low = finite(values[positions["low"]])
        volume = finite(values[positions["volume"]])
        amount_yuan = finite(values[positions["amount"]])
        previous = finite(values[positions["preClose"]])
        if (
            close is None
            or close <= 0
            or not valid_ohlc(open_value, high, low, close)
            or volume is None
            or volume <= 0
            or amount_yuan is None
            or amount_yuan <= 0
        ):
            continue
        change_pct = (close / previous - 1) * 100 if previous is not None and previous > 0 else None
        rows.append(
            {
                "date": trading_date,
                "code": index["code"],
                "name": index["shortName"],
                "close": fmt_float(close, 12),
                "change_pct": fmt_float(change_pct, 10),
                "trading_volume": fmt_float(volume, 14),
                "trading_value_yi": fmt_float(amount_yuan / 100_000_000, 12),
                "constituents": "",
            }
        )
    rows.sort(key=lambda item: item["date"])
    return rows


def verify_latest_with_tencent(
    session: requests.Session,
    index: dict[str, Any],
    expected_date: str,
    expected_close: float,
) -> dict[str, Any]:
    """Cross-check the latest date and close without mixing vendor series."""
    symbol = f"{index.get('market', 'sh')}{index['code']}"
    payload = fetch_json_with_retry(
        session,
        TENCENT_KLINE_API,
        params={"param": f"{symbol},day,{expected_date},{expected_date},5,qfq"},
        attempts=2,
    )
    node = (payload.get("data") or {}).get(symbol) or {}
    rows = node.get("day") or node.get("qfqday") or []
    if not rows:
        raise ValueError("Tencent verification returned no row")
    latest = rows[-1]
    if len(latest) < 3:
        raise ValueError("Tencent verification row is incomplete")
    vendor_date = str(latest[0])
    vendor_close = finite(latest[2])
    if vendor_close is None or vendor_date != expected_date:
        raise ValueError(f"Tencent verification mismatch date={vendor_date}")
    relative_gap = abs(vendor_close / expected_close - 1) if expected_close else math.inf
    if relative_gap > 0.001:
        raise ValueError(f"Tencent close differs by {relative_gap * 100:.3f}%")
    return {
        "status": "matched",
        "source": TENCENT_KLINE_API,
        "date": vendor_date,
        "close": vendor_close,
        "relativeGapPct": round(relative_gap * 100, 6),
    }


def fetch_official_benchmark_history(
    args: argparse.Namespace,
    session: requests.Session,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    """Maintain a separate CSI All Share benchmark series.

    The benchmark never enters the ranked universe and has no vendor fallback:
    mixing a sector source with a different benchmark source can manufacture
    relative returns.  A failed refresh therefore preserves the last official
    cache and records a hard data state instead of substituting zero.
    """
    index = A_SHARE_BENCHMARK
    cached_by_date = existing_history_rows(BENCHMARK_HISTORY_PATH)
    by_date = {} if args.refresh else dict(cached_by_date)
    metadata = manifest.get("aShareBenchmark", {})
    if by_date and max(by_date) >= args.end:
        ordered = [by_date[key] for key in sorted(by_date)]
        if (
            len(ordered) >= 2
            and ordered[0]["date"] == args.start
            and all(
                ordered[0][field] == ordered[1][field]
                for field in ("close", "trading_volume", "trading_value_yi")
            )
        ):
            ordered.pop(0)
            write_history(BENCHMARK_HISTORY_PATH, ordered)
            by_date = {row["date"]: row for row in ordered}
            metadata = {
                **(metadata if isinstance(metadata, dict) else {}),
                "rows": len(ordered),
                "firstDate": ordered[0]["date"],
                "sha256": sha256_path(BENCHMARK_HISTORY_PATH),
                "compressedBytes": BENCHMARK_HISTORY_PATH.stat().st_size,
            }
            manifest["aShareBenchmark"] = metadata
        return metadata or {
            "code": index["code"],
            "name": index["shortName"],
            "rows": len(by_date),
            "firstDate": min(by_date),
            "lastDate": max(by_date),
            "source": CSI_API,
            "status": "ready",
        }
    fetch_start = (
        (date.fromisoformat(max(by_date)) + timedelta(days=1)).isoformat()
        if by_date
        else args.start
    )
    headers = {
        "Referer": CSI_REFERER,
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json",
    }
    try:
        for chunk_start, chunk_end in request_chunks(fetch_start, args.end):
            payload = fetch_json_with_retry(
                session,
                CSI_API,
                params={
                    "indexCode": index["code"],
                    "startDate": chunk_start.replace("-", ""),
                    "endDate": chunk_end.replace("-", ""),
                },
                headers=headers,
                attempts=2,
            )
            if str(payload.get("code")) != "200" or not isinstance(payload.get("data"), list):
                raise ValueError(f"unexpected CSI benchmark payload code={payload.get('code')!r}")
            for raw in payload["data"]:
                if not isinstance(raw, dict):
                    continue
                trading_date = parse_yyyymmdd(raw.get("tradeDate"))
                close = finite(raw.get("close"))
                open_value = finite(raw.get("open"))
                high = finite(raw.get("high"))
                low = finite(raw.get("low"))
                volume = finite(raw.get("tradingVol"))
                amount = finite(raw.get("tradingValue"))
                if (
                    not trading_date
                    or close is None
                    or close <= 0
                    or not valid_ohlc(
                        open_value,
                        high,
                        low,
                        close,
                        tolerance=CSI_OHLC_TOLERANCE_POINTS,
                    )
                    or volume is None
                    or volume <= 0
                    or amount is None
                    or amount <= 0
                ):
                    continue
                by_date[trading_date] = {
                    "date": trading_date,
                    "code": index["code"],
                    "name": index["shortName"],
                    "close": fmt_float(close, 12),
                    "change_pct": fmt_float(finite(raw.get("changePct")), 10),
                    "trading_volume": fmt_float(volume, 14),
                    "trading_value_yi": fmt_float(amount, 12),
                    "constituents": fmt_float(finite(raw.get("consNumber")), 10),
                }
            time.sleep(args.interval + random.uniform(0.05, 0.20))
        rows = [by_date[key] for key in sorted(by_date)]
        if (
            len(rows) >= 2
            and rows[0]["date"] == args.start
            and all(
                rows[0][field] == rows[1][field]
                for field in ("close", "trading_volume", "trading_value_yi")
            )
        ):
            # CSI echoes the next trading session on a non-trading start date.
            rows.pop(0)
        if len(rows) < args.min_rows or rows[-1]["date"] < args.end:
            raise ValueError(
                f"benchmark has {len(rows)} rows through {rows[-1]['date'] if rows else 'none'}"
            )
        write_history(BENCHMARK_HISTORY_PATH, rows)
        verification = verify_latest_with_tencent(
            session,
            index,
            rows[-1]["date"],
            float(rows[-1]["close"]),
        )
        result = {
            "code": index["code"],
            "name": index["shortName"],
            "rows": len(rows),
            "firstDate": rows[0]["date"],
            "lastDate": rows[-1]["date"],
            "retrievedAt": now_iso(),
            "source": CSI_API,
            "evidenceClass": "official-primary",
            "verification": verification,
            "sha256": sha256_path(BENCHMARK_HISTORY_PATH),
            "compressedBytes": BENCHMARK_HISTORY_PATH.stat().st_size,
            "status": "ready",
            "failure": None,
        }
    except Exception as exc:
        if cached_by_date:
            result = {
                **(metadata if isinstance(metadata, dict) else {}),
                "code": index["code"],
                "name": index["shortName"],
                "rows": len(cached_by_date),
                "firstDate": min(cached_by_date),
                "lastDate": max(cached_by_date),
                "source": CSI_API,
                "status": "stale",
                "failure": str(exc),
            }
        else:
            result = {
                "code": index["code"],
                "name": index["shortName"],
                "rows": 0,
                "source": CSI_API,
                "status": "failed",
                "failure": str(exc),
            }
    manifest["aShareBenchmark"] = result
    return result


def fetch_a_share_history(args: argparse.Namespace) -> dict[str, Any]:
    taxonomy = read_json(TAXONOMY_PATH)
    indices = taxonomy["indices"]
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()
    history_manifest: dict[str, Any] = manifest.setdefault("aShareHistory", {})
    session = requests_session()
    failures: list[dict[str, str]] = []
    preserved_official_cache_codes: list[str] = []
    downloaded = 0

    rate_limited = False
    for position, index in enumerate(indices, start=1):
        code = index["code"]
        path = HISTORY_DIR / f"{code}.csv.gz"
        cached_by_date = existing_history_rows(path)
        cached_metadata = history_manifest.get(code, {})
        cached_source = cached_metadata.get("source") if isinstance(cached_metadata, dict) else None
        by_date = {} if args.refresh else dict(cached_by_date)
        if by_date and max(by_date) >= args.end:
            print(f"[fetch {position:02d}/{len(indices)}] {code} current cache", flush=True)
            continue
        fetch_start = (
            (date.fromisoformat(max(by_date)) + timedelta(days=1)).isoformat()
            if by_date
            else args.start
        )
        headers = {
            "Referer": CSI_REFERER,
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json",
        }
        official_error: str | None = None
        source_used = CSI_API
        try:
            try:
                if rate_limited:
                    raise RuntimeError("CSI rate gate already detected in this run")
                for chunk_start, chunk_end in request_chunks(fetch_start, args.end):
                    # CSI returns HTTP 200 + data=[] when dashed ISO dates are used.
                    # Its public perf endpoint requires compact YYYYMMDD parameters.
                    params = {
                        "indexCode": code,
                        "startDate": chunk_start.replace("-", ""),
                        "endDate": chunk_end.replace("-", ""),
                    }
                    payload = fetch_json_with_retry(
                        session,
                        CSI_API,
                        params=params,
                        headers=headers,
                        attempts=2,
                    )
                    if str(payload.get("code")) != "200" or not isinstance(payload.get("data"), list):
                        raise ValueError(f"unexpected CSI payload code={payload.get('code')!r}")
                    chunk_rows: list[dict[str, Any]] = []
                    for raw in payload["data"]:
                        if not isinstance(raw, dict):
                            continue
                        trading_date = parse_yyyymmdd(raw.get("tradeDate"))
                        close = finite(raw.get("close"))
                        open_value = finite(raw.get("open"))
                        high = finite(raw.get("high"))
                        low = finite(raw.get("low"))
                        volume = finite(raw.get("tradingVol"))
                        amount = finite(raw.get("tradingValue"))
                        if (
                            not trading_date
                            or close is None
                            or close <= 0
                            or not valid_ohlc(
                                open_value,
                                high,
                                low,
                                close,
                                tolerance=CSI_OHLC_TOLERANCE_POINTS,
                            )
                            or volume is None
                            or volume <= 0
                            or amount is None
                            or amount <= 0
                        ):
                            # The API can prepend a metadata-like row.
                            continue
                        chunk_rows.append({
                            "date": trading_date,
                            "code": code,
                            "name": index["shortName"],
                            "close": fmt_float(close, 12),
                            "change_pct": fmt_float(finite(raw.get("changePct")), 10),
                            "trading_volume": fmt_float(volume, 14),
                            "trading_value_yi": fmt_float(amount, 12),
                            "constituents": fmt_float(finite(raw.get("consNumber")), 10),
                        })
                    chunk_rows.sort(key=lambda item: item["date"])
                    if (
                        len(chunk_rows) >= 2
                        and chunk_rows[0]["date"] == chunk_start
                        and all(
                            chunk_rows[0][field] == chunk_rows[1][field]
                            for field in ("close", "trading_volume", "trading_value_yi")
                        )
                    ):
                        # CSI can echo the next trading day's values on the query
                        # start date. Remove only the exact replicated baseline.
                        chunk_rows.pop(0)
                    for row in chunk_rows:
                        by_date[row["date"]] = row
                    time.sleep(args.interval + random.uniform(0.05, 0.20))
                official_rows = [by_date[d] for d in sorted(by_date)]
                if len(official_rows) < args.min_rows:
                    raise ValueError(f"only {len(official_rows)} valid official daily rows")
                if official_rows[-1]["date"] < args.end:
                    raise ValueError(
                        f"stale official endpoint result ends {official_rows[-1]['date']}, expected {args.end}"
                    )
            except Exception as exc:
                official_error = str(exc)
                if "403" in official_error or "429" in official_error:
                    rate_limited = True
                if cached_by_date and cached_source == CSI_API:
                    preserved_official_cache_codes.append(code)
                    raise RuntimeError(
                        f"CSI failed ({official_error}); preserved official cache "
                        f"through {max(cached_by_date)}"
                    ) from exc
                if not baidu_fallback_allowed(index):
                    raise RuntimeError(
                        f"CSI failed ({official_error}); no unambiguous vendor fallback "
                        f"is permitted for {code}"
                    ) from exc
                # Do not splice two vendors across time. The fallback replaces the
                # entire bounded series and is cross-checked against Tencent below.
                fallback_rows = parse_baidu_history(session, index, args.start, args.end)
                if len(fallback_rows) < args.min_rows:
                    raise ValueError(
                        f"CSI failed ({official_error}); Baidu fallback has only {len(fallback_rows)} rows"
                    )
                if fallback_rows[-1]["date"] < args.end:
                    raise ValueError(
                        f"CSI failed ({official_error}); Baidu fallback ends {fallback_rows[-1]['date']}"
                    )
                by_date = {row["date"]: row for row in fallback_rows}
                source_used = BAIDU_KLINE_API
            rows = [by_date[d] for d in sorted(by_date)]
            if len(rows) < args.min_rows:
                raise ValueError(f"only {len(rows)} valid daily rows")
            if rows[-1]["date"] < args.end:
                raise ValueError(f"stale endpoint result ends {rows[-1]['date']}, expected {args.end}")
            if source_used == BAIDU_KLINE_API:
                # Vendor fallback may replace a vendor cache or create a new
                # series only after an independent latest-close check succeeds.
                verification = verify_latest_with_tencent(
                    session,
                    index,
                    rows[-1]["date"],
                    float(rows[-1]["close"]),
                )
            else:
                try:
                    verification = verify_latest_with_tencent(
                        session,
                        index,
                        rows[-1]["date"],
                        float(rows[-1]["close"]),
                    )
                except Exception as exc:
                    verification = {"status": "unavailable", "error": str(exc)}
            write_history(path, rows)
            history_manifest[code] = {
                "name": rows[-1]["name"],
                "rows": len(rows),
                "firstDate": rows[0]["date"],
                "lastDate": rows[-1]["date"],
                "retrievedAt": now_iso(),
                "source": source_used,
                "evidenceClass": "official-primary" if source_used == CSI_API else "vendor-market-data",
                "officialAttemptError": official_error,
                "verification": verification,
                "sha256": sha256_path(path),
                "compressedBytes": path.stat().st_size,
            }
            downloaded += 1
            print(
                f"[fetch {position:02d}/{len(indices)}] {code} {len(rows)} rows "
                f"{rows[0]['date']}..{rows[-1]['date']} {path.stat().st_size / 1024:.0f}KiB",
                flush=True,
            )
        except Exception as exc:  # continue to preserve usable partial coverage
            failures.append({"code": code, "error": str(exc)})
            print(f"[fetch {position:02d}/{len(indices)}] {code} FAILED: {exc}", file=sys.stderr)

    benchmark = fetch_official_benchmark_history(args, session, manifest)
    manifest.update(
        {
            "schemaVersion": 1,
            "updatedAt": now_iso(),
            "aShareTaxonomy": {
                "path": str(TAXONOMY_PATH.relative_to(ROOT)).replace("\\", "/"),
                "universeCount": len(indices),
                "methodologyUrl": taxonomy["methodologyUrl"],
            },
            "aShareFetch": {
                "start": args.start,
                "end": args.end,
                "officialEndpoint": CSI_API,
                "fallbackEndpoint": BAIDU_KLINE_API,
                "fallbackEligibleCodes": sorted(BAIDU_FALLBACK_CODES),
                "verificationEndpoint": TENCENT_KLINE_API,
                "serialIntervalSeconds": args.interval,
                "downloadedThisRun": downloaded,
                "coverageCount": sum((HISTORY_DIR / f"{i['code']}.csv.gz").exists() for i in indices),
                "failures": failures,
                "preservedOfficialCacheCodes": sorted(set(preserved_official_cache_codes)),
                "stoppedForRateLimit": rate_limited,
                "benchmarkStatus": benchmark.get("status"),
            },
        }
    )
    write_json_atomic(MANIFEST_PATH, manifest)
    return manifest["aShareFetch"]


def read_history(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with gzip.open(path, "rt", encoding="utf-8", newline="") as handle:
        for raw in csv.DictReader(handle):
            close = finite(raw.get("close"))
            if close is None or close <= 0:
                continue
            rows.append(
                {
                    "date": raw["date"],
                    "code": raw["code"],
                    "name": raw["name"],
                    "close": close,
                    "volume": finite(raw.get("trading_volume")),
                    "amount": finite(raw.get("trading_value_yi")),
                }
            )
    rows.sort(key=lambda item: item["date"])
    return rows


def mean_complete(values: Iterable[float | None], expected: int) -> float | None:
    items = list(values)
    if len(items) != expected or any(value is None or not math.isfinite(value) for value in items):
        return None
    return statistics.fmean(value for value in items if value is not None)


def safe_log_ratio(numerator: float | None, denominator: float | None) -> float | None:
    if numerator is None or denominator is None or numerator <= 0 or denominator <= 0:
        return None
    return math.log(numerator / denominator)


def build_sector_feature_rows(rows: list[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    closes = [row["close"] for row in rows]
    daily_returns = [None]
    daily_returns.extend(closes[i] / closes[i - 1] - 1 for i in range(1, len(closes)))
    for i in range(60, len(rows)):
        momentum5 = closes[i] / closes[i - 5] - 1
        momentum20 = closes[i] / closes[i - 20] - 1
        momentum60 = closes[i] / closes[i - 60] - 1
        reversal1 = -(daily_returns[i] or 0.0)
        recent_returns = [value for value in daily_returns[i - 19 : i + 1] if value is not None]
        volatility20 = statistics.pstdev(recent_returns) if len(recent_returns) >= 15 else None
        drawdown60 = closes[i] / max(closes[i - 59 : i + 1]) - 1
        amount5 = mean_complete((row["amount"] for row in rows[i - 4 : i + 1]), 5)
        amount20 = mean_complete((row["amount"] for row in rows[i - 24 : i - 4]), 20)
        volume5 = mean_complete((row["volume"] for row in rows[i - 4 : i + 1]), 5)
        volume20 = mean_complete((row["volume"] for row in rows[i - 24 : i - 4]), 20)
        amount_ratio = safe_log_ratio(amount5, amount20)
        volume_ratio = safe_log_ratio(volume5, volume20)
        if volatility20 is None or amount_ratio is None or volume_ratio is None:
            continue
        yield {
            "date": rows[i]["date"],
            "code": rows[i]["code"],
            "name": rows[i]["name"],
            "momentum5": momentum5,
            "momentum20": momentum20,
            "momentum60": momentum60,
            "reversal1": reversal1,
            "volatility20": volatility20,
            "drawdown60": drawdown60,
            "amountRatio5v20": amount_ratio,
            "volumeRatio5v20": volume_ratio,
            "priceVolumeAcceleration": momentum5 * amount_ratio,
        }


def gzip_csv_writer(path: Path, fields: list[str]):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = tempfile.NamedTemporaryFile("wb", delete=False, dir=path.parent, suffix=".tmp")
    name = temp.name
    temp.close()
    handle = gzip.open(name, "wt", encoding="utf-8", newline="", compresslevel=6)
    writer = csv.DictWriter(handle, fieldnames=fields)
    writer.writeheader()
    return name, handle, writer


def build_features(_: argparse.Namespace) -> dict[str, Any]:
    taxonomy = read_json(TAXONOMY_PATH)
    FEATURE_DIR.mkdir(parents=True, exist_ok=True)
    if not BENCHMARK_HISTORY_PATH.exists():
        raise RuntimeError(
            "official CSI All Share benchmark history is missing; run rotation:fetch before features"
        )
    benchmark_history = read_history(BENCHMARK_HISTORY_PATH)
    if len(benchmark_history) < 81:
        raise RuntimeError("official CSI All Share benchmark has fewer than 81 valid sessions")
    benchmark_dates = [row["date"] for row in benchmark_history]
    available_paths: dict[str, Path] = {}
    date_counts: dict[str, int] = defaultdict(int)
    for index in taxonomy["indices"]:
        history_path = HISTORY_DIR / f"{index['code']}.csv.gz"
        if not history_path.exists():
            continue
        history = read_history(history_path)
        if len(history) < 61:
            continue
        available_paths[index["code"]] = history_path
        for trading_date in {row["date"] for row in history}:
            date_counts[trading_date] += 1
        del history
    source_coverage = len(available_paths)
    common_dates = {
        trading_date for trading_date, count in date_counts.items() if count == source_coverage
    } & set(benchmark_dates)
    if source_coverage == 0 or len(common_dates) < 61:
        raise RuntimeError("not enough synchronized sector history to build features")
    raw_path = FEATURE_DIR / "a-share-features.raw.csv.gz"
    feature_stats: dict[str, dict[str, list[float]]] = defaultdict(
        lambda: {feature: [0.0, 0.0, 0.0] for feature in FEATURES}
    )
    total_rows = 0
    coverage = 0
    temp_name, handle, writer = gzip_csv_writer(raw_path, RAW_FEATURE_FIELDS)
    try:
        for index in taxonomy["indices"]:
            history_path = available_paths.get(index["code"])
            if history_path is None:
                continue
            history = [
                row for row in read_history(history_path) if row["date"] in common_dates
            ]  # bounded: one sector only, synchronized across the available cross-section
            sector_rows = 0
            for feature in build_sector_feature_rows(history):
                out = {key: feature.get(key, "") for key in RAW_FEATURE_FIELDS}
                for key in FEATURES:
                    out[key] = fmt_float(feature.get(key), 14)
                writer.writerow(out)
                sector_rows += 1
                total_rows += 1
                for feature_name in FEATURES:
                    value = float(feature[feature_name])
                    stats = feature_stats[feature["date"]][feature_name]
                    stats[0] += value
                    stats[1] += value * value
                    stats[2] += 1
            if sector_rows:
                coverage += 1
            del history
    finally:
        handle.close()
        os.replace(temp_name, raw_path)

    feature_date_counts = {
        trading_date: int(stats[FEATURES[0]][2])
        for trading_date, stats in feature_stats.items()
    }
    complete_feature_dates = {
        trading_date
        for trading_date, count in feature_date_counts.items()
        if count == source_coverage
    }
    if not complete_feature_dates:
        raise RuntimeError("no complete feature cross-section after amount/volume window checks")

    temp_name, handle, writer = gzip_csv_writer(FEATURE_PATH, FEATURE_FIELDS)
    final_rows = 0
    try:
        with gzip.open(raw_path, "rt", encoding="utf-8", newline="") as source:
            for row in csv.DictReader(source):
                if row["date"] not in complete_feature_dates:
                    continue
                out = {key: row.get(key, "") for key in FEATURE_FIELDS}
                for feature_name in FEATURES:
                    value = float(row[feature_name])
                    total, total_sq, count = feature_stats[row["date"]][feature_name]
                    mean = total / count
                    variance = max(0.0, total_sq / count - mean * mean)
                    scale = math.sqrt(variance) or 1.0
                    out[f"cs_{feature_name}"] = fmt_float((value - mean) / scale, 14)
                writer.writerow(out)
                final_rows += 1
    finally:
        handle.close()
        os.replace(temp_name, FEATURE_PATH)
    raw_path.unlink(missing_ok=True)

    manifest = load_manifest()
    manifest["features"] = {
        "builtAt": now_iso(),
        "path": str(FEATURE_PATH.relative_to(ROOT)).replace("\\", "/"),
        "compressedBytes": FEATURE_PATH.stat().st_size,
        "sha256": sha256_path(FEATURE_PATH),
        "coverageCount": coverage,
        "sourceCoverageCount": source_coverage,
        "synchronizedCoverageCount": source_coverage,
        "synchronizedDates": len(common_dates),
        "synchronizedStart": min(common_dates),
        "synchronizedEnd": max(common_dates),
        "rawFeatureRows": total_rows,
        "rows": final_rows,
        "featurePanelDates": len(complete_feature_dates),
        "featurePanelStart": min(complete_feature_dates),
        "featurePanelEnd": max(complete_feature_dates),
        "featureDateMinCount": min(feature_date_counts[date] for date in complete_feature_dates),
        "featureDateMaxCount": max(feature_date_counts[date] for date in complete_feature_dates),
        "droppedIncompleteFeatureDates": len(feature_date_counts) - len(complete_feature_dates),
        "featurePanelComplete": (
            coverage == source_coverage
            and final_rows == len(complete_feature_dates) * source_coverage
        ),
        "benchmark": {
            "code": A_SHARE_BENCHMARK["code"],
            "name": A_SHARE_BENCHMARK["shortName"],
            "source": CSI_API,
            "firstDate": benchmark_dates[0],
            "lastDate": benchmark_dates[-1],
            "joinedDates": len(common_dates),
        },
        "streamingPolicy": "one sector in memory; prediction labels are built only by prediction_dataset.py",
    }
    manifest["updatedAt"] = now_iso()
    write_json_atomic(MANIFEST_PATH, manifest)
    print(
        f"[features] coverage={coverage} rows={final_rows} size={FEATURE_PATH.stat().st_size / 1024 / 1024:.2f}MiB",
        flush=True,
    )
    return manifest["features"]


def iter_features() -> Iterator[dict[str, Any]]:
    with gzip.open(FEATURE_PATH, "rt", encoding="utf-8", newline="") as handle:
        for raw in csv.DictReader(handle):
            try:
                row = {
                    "date": raw["date"],
                    "code": raw["code"],
                    "name": raw["name"],
                    **{feature: float(raw[feature]) for feature in FEATURES},
                    **{feature: float(raw[feature]) for feature in MODEL_FEATURES},
                }
            except (KeyError, ValueError):
                continue
            if all(math.isfinite(row[feature]) for feature in FEATURES + MODEL_FEATURES):
                yield row


class RunningStats:
    def __init__(self, size: int):
        self.n = 0
        self.mean = [0.0] * size
        self.m2 = [0.0] * size

    def add(self, values: list[float]) -> None:
        self.n += 1
        for i, value in enumerate(values):
            delta = value - self.mean[i]
            self.mean[i] += delta / self.n
            self.m2[i] += delta * (value - self.mean[i])

    def scales(self) -> list[float]:
        return [math.sqrt(value / max(1, self.n - 1)) or 1.0 for value in self.m2]


def solve_linear(matrix: list[list[float]], vector: list[float]) -> list[float]:
    size = len(vector)
    augmented = [matrix[i][:] + [vector[i]] for i in range(size)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            augmented[pivot][column] += 1e-8
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        scale = augmented[column][column]
        augmented[column] = [value / scale for value in augmented[column]]
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            if factor:
                augmented[row] = [
                    augmented[row][i] - factor * augmented[column][i] for i in range(size + 1)
                ]
    return [augmented[i][-1] for i in range(size)]


def model_feature_value(row: dict[str, Any], feature: str) -> float:
    if feature in row:
        return float(row[feature])
    values = {
        "nl_momentum_acceleration": row["cs_momentum5"] - row["cs_momentum20"],
        "nl_medium_trend_acceleration": row["cs_momentum20"] - row["cs_momentum60"],
        "nl_momentum5_x_amount": row["cs_momentum5"] * row["cs_amountRatio5v20"],
        "nl_momentum20_x_volume": row["cs_momentum20"] * row["cs_volumeRatio5v20"],
        "nl_trend_x_drawdown": row["cs_momentum20"] * row["cs_drawdown60"],
        "nl_reversal_x_volatility": row["cs_reversal1"] * row["cs_volatility20"],
        "nl_momentum5_squared": row["cs_momentum5"] ** 2,
        "nl_drawdown_squared": row["cs_drawdown60"] ** 2,
    }
    if feature not in values:
        raise KeyError(f"unknown model feature {feature}")
    return float(values[feature])


# Legacy mutable-panel label generation and ridge fitting were removed.
# Training labels now exist only in prediction_dataset.py snapshots.

def latest_rows() -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for row in iter_features():
        if row["code"] not in latest or row["date"] > latest[row["code"]]["date"]:
            latest[row["code"]] = row
    return latest


def visualization_artifact(latest: dict[str, dict[str, Any]]) -> dict[str, Any]:
    current = sorted(latest.values(), key=lambda row: row["momentum20"], reverse=True)
    selected = current[:2] + current[-2:]
    series: list[dict[str, Any]] = []
    for item in selected:
        history = read_history(HISTORY_DIR / f"{item['code']}.csv.gz")
        history = history[-60:]
        if len(history) < 21:
            continue
        base = history[0]["close"]
        series.append(
            {
                "name": item["name"],
                "code": item["code"],
                "points": [
                    {"date": row["date"], "normalizedReturnPct": round((row["close"] / base - 1) * 100, 3)}
                    for row in history
                ],
            }
        )
    amount_items = sorted(latest.values(), key=lambda row: row["amountRatio5v20"], reverse=True)[:8]
    return {
        "schemaVersion": 1,
        "note": "结构化轻量图表数据；折线最多4条×60点，柱状最多8项。本地轻量历史只保留收盘、成交量和成交额，不据此伪造K线图。",
        "normalizedPerformance60d": {
            "type": "line",
            "unit": "%（各序列相对自身起点）",
            "series": series,
        },
        "turnoverAmountRatio": {
            "type": "bar",
            "unit": "倍",
            "items": [
                {
                    "sector": row["name"],
                    "code": row["code"],
                    "value": round(math.exp(row["amountRatio5v20"]), 3),
                }
                for row in amount_items
            ],
        },
    }


def train_model(_: argparse.Namespace) -> dict[str, Any]:
    raise SystemExit(
        "legacy mutable-panel training was removed; build and verify an immutable "
        "prediction dataset, then run rotation:probability-train --dataset-snapshot <path>"
    )

def percentile_scores(items: list[tuple[str, float]]) -> dict[str, float]:
    ordered = sorted(items, key=lambda pair: pair[1], reverse=True)
    denominator = max(1, len(ordered) - 1)
    return {code: round(100 * (1 - rank / denominator), 1) for rank, (code, _) in enumerate(ordered)}


def publish_extremes(rows: list[dict[str, Any]], limit: int = 30) -> list[dict[str, Any]]:
    """Keep both tails while preserving descending order and a compact payload."""
    if len(rows) <= limit:
        return rows
    high = limit // 2
    return rows[:high] + rows[-(limit - high) :]


def z_scores(rows: list[dict[str, Any]], feature: str) -> dict[str, float]:
    values = [float(row[feature]) for row in rows]
    mean = statistics.fmean(values)
    scale = statistics.pstdev(values) or 1.0
    return {row["code"]: (float(row[feature]) - mean) / scale for row in rows}


def observed_direction(score: float) -> str:
    if score >= 80:
        return "leading"
    if score >= 60:
        return "strengthening"
    if score >= 40:
        return "neutral"
    if score >= 20:
        return "weakening"
    return "lagging"


def forecast_direction(score: float) -> str:
    if score >= 85:
        return "strong-up"
    if score >= 60:
        return "up"
    if score >= 40:
        return "range"
    if score >= 15:
        return "down"
    return "strong-down"


def upside_probability_score(model: dict[str, Any], row: dict[str, Any]) -> float:
    value = float(model["intercept"])
    for feature in model["featureNames"]:
        scale = float(model["featureScales"][feature]) or 1.0
        value += (
            (model_feature_value(row, feature) - float(model["featureMeans"][feature]))
            / scale
            * float(model["coefficients"][feature])
        )
    return value


def upside_probability(horizon_model: dict[str, Any], row: dict[str, Any]) -> tuple[float, float]:
    score = upside_probability_score(horizon_model["model"], row)
    calibrator = horizon_model["calibrator"]
    scale = float(calibrator["scoreScale"]) or 1.0
    normalized = (score - float(calibrator["scoreMean"])) / scale
    logit_value = float(calibrator["intercept"]) + float(calibrator["slope"]) * normalized
    if logit_value >= 0:
        exp_value = math.exp(-min(logit_value, 60.0))
        raw_probability = 1.0 / (1.0 + exp_value)
    else:
        exp_value = math.exp(max(logit_value, -60.0))
        raw_probability = exp_value / (1.0 + exp_value)
    base_rate = float(calibrator["baseRate"])
    blend = {
        "model-calibrated": 1.0,
        "model-shrunk": 0.35,
        "historical-base-rate": 0.0,
    }.get(horizon_model.get("deploymentTier"), 0.0)
    probability = max(0.02, min(0.98, base_rate + blend * (raw_probability - base_rate)))
    return probability, base_rate


def probability_calibration_range(horizon_model: dict[str, Any], probability: float) -> tuple[float, float]:
    bins = horizon_model.get("calibrationBins", [])
    if not bins:
        return max(0.0, probability - 0.10), min(1.0, probability + 0.10)
    nearest = min(bins, key=lambda item: abs(float(item["meanPredicted"]) - probability))
    low = min(probability, float(nearest["wilson90Low"]))
    high = max(probability, float(nearest["wilson90High"]))
    return max(0.0, low), min(1.0, high)


def probability_direction(probability: float, base_rate: float) -> str:
    edge = probability - base_rate
    if edge >= 0.08:
        return "strong-up"
    if edge >= 0.03:
        return "up"
    if edge <= -0.08:
        return "strong-down"
    if edge <= -0.03:
        return "down"
    return "range"


def relative_target_prediction(horizon_model: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    """Apply one frozen multi-target horizon without retraining or null fallback."""
    probabilities: dict[str, Any] = {}
    for target in ("absoluteUp", "outperformance", "topQuartile"):
        model = horizon_model["models"][target]
        score = upside_probability_score(model, row)
        raw_probability = 1.0 / (1.0 + math.exp(-max(-60.0, min(60.0, score))))
        audit = horizon_model["calibrations"][target]
        calibrator = audit["calibrator"]
        if audit.get("enabled"):
            scale = float(calibrator["scoreScale"]) or 1.0
            normalized = (score - float(calibrator["scoreMean"])) / scale
            calibrated = 1.0 / (
                1.0 + math.exp(-max(-60.0, min(60.0, float(calibrator["intercept"]) + float(calibrator["slope"]) * normalized)))
            )
        else:
            calibrated = raw_probability
        probabilities[target] = {
            "rawScore": score,
            "rawProbability": raw_probability,
            "calibratedProbability": calibrated,
            "calibrationApplied": bool(audit.get("enabled")),
            "historicalBaseRate": float(calibrator["baseRate"]),
        }
    return {
        "probabilities": probabilities,
        "expectedExcessReturn": upside_probability_score(horizon_model["models"]["expectedExcess"], row),
    }


def tone_for_change(value: float) -> str:
    return "positive" if value > 0 else "negative" if value < 0 else "neutral"


def trading_due_date(as_of: str, sessions: int) -> str:
    calendar = read_json(CALENDAR_PATH)
    if int(as_of[:4]) != calendar["year"]:
        raise RuntimeError(f"no official A-share holiday calendar for {as_of[:4]}")
    closed = set(calendar["closedWeekdays"])
    cursor = date.fromisoformat(as_of)
    remaining = sessions
    while remaining:
        cursor += timedelta(days=1)
        if cursor.year != calendar["year"]:
            raise RuntimeError(f"official A-share holiday calendar missing for {cursor.year}")
        text = cursor.isoformat()
        if cursor.weekday() < 5 and text not in closed:
            remaining -= 1
    return cursor.isoformat()


def immutable_forecast_id(
    artifact: dict[str, Any],
    *,
    as_of: str,
    due_date: str,
    sessions: int,
    code: str,
) -> str:
    identity = "\0".join(
        [
            str(artifact["id"]),
            str(artifact["version"]),
            "a-share",
            as_of,
            due_date,
            str(sessions),
            code,
        ]
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:12]
    return f"fr-a-{as_of.replace('-', '')}-h{sessions}-{code}-{digest}"


def calibrated_confidence(
    backtest: dict[str, Any],
    ranking_score: float,
) -> tuple[str, int, str]:
    """Return an evidence-strength grade; never interpret it as a probability."""
    bucket_index = min(4, max(0, int(min(ranking_score, 99.999) // 20)))
    calibration = backtest.get("calibration", [])
    has_bins = len(calibration) == 5
    bucket = calibration[bucket_index] if has_bins else {}
    dates = int(
        bucket.get("dates")
        if has_bins
        else backtest.get("evaluationDates", 0)
        or 0
    )
    observations = int(
        bucket.get("observations")
        if has_bins
        else backtest.get("observations", 0)
        or 0
    )
    consistency = finite(
        bucket.get("directionalConsistency")
        if has_bins
        else backtest.get("directionalHitRate")
    )
    holdout_ic = finite(
        backtest.get("lockedHoldout", {}).get("rankIc")
        if has_bins
        else backtest.get("rankIc")
    )
    positive_share = finite(backtest.get("lockedHoldout", {}).get("rankIcPositiveDateShare"))
    if positive_share is None and backtest.get("folds"):
        positive_share = sum(
            (finite(fold.get("rankIc")) or 0.0) > 0 for fold in backtest["folds"]
        ) / len(backtest["folds"])
    support_component = min(1.0, dates / 100.0)
    consistency_component = max(0.0, min(1.0, ((consistency or 0.5) - 0.5) / 0.15))
    ic_component = max(0.0, min(1.0, (holdout_ic or 0.0) / 0.12))
    stability_component = max(0.0, min(1.0, ((positive_share or 0.5) - 0.5) / 0.20))
    extremity_component = min(1.0, abs(ranking_score - 50.0) / 50.0)
    evidence_score = round(
        18
        + support_component * 8
        + consistency_component * 8
        + ic_component * 7
        + stability_component * 4
        + extremity_component * 4
    )
    # One market-data evidence class cannot be upgraded to medium regardless
    # of a strong recent backtest.  The numeric score stays available for
    # comparing similarly scoped forecasts.
    evidence_score = max(10, min(49, evidence_score))
    consistency_text = "n/a" if consistency is None else f"{consistency:.3f}"
    holdout_text = "n/a" if holdout_ic is None else f"{holdout_ic:.3f}"
    if has_bins:
        basis = (
            f"近504日walk-forward校准分箱含{dates}个独立日期/{observations}项观察，"
            f"方向一致度{consistency_text}；锁定252日保留集rank IC={holdout_text}。"
            f"{evidence_score}分只表示同一量价模型内的证据强度，不是上涨概率或胜率。"
        )
    else:
        basis = (
            f"当前冻结基线仅保存总体walk-forward汇总：{dates}个独立日期/{observations}项观察，"
            f"方向一致度{consistency_text}，rank IC={holdout_text}；未保存行业分箱校准。"
            f"{evidence_score}分只表示保守证据强度，不是上涨概率或胜率。"
        )
    return "low", evidence_score, basis


def prediction_state_contract(
    *,
    model_availability: str,
    publication_status: str,
    output_mode: str,
    calibration_status: str,
    probability_source: str,
    probability_target: str,
    model_version: str | None,
    feature_version: str | None,
    model_input_completeness: float | None,
    production_feature_coverage: float | None,
    gate_failures: list[str],
) -> dict[str, Any]:
    """Keep model existence, publication and probability lineage independent."""
    return {
        "modelAvailability": model_availability,
        "publicationStatus": publication_status,
        "outputMode": output_mode,
        "calibrationStatus": calibration_status,
        "probabilitySource": probability_source,
        "probabilityTarget": probability_target,
        "modelVersion": model_version,
        "featureVersion": feature_version,
        "modelInputCompleteness": model_input_completeness,
        "productionFeatureCoverage": production_feature_coverage,
        "gateFailures": gate_failures,
    }


def a_share_market(artifact: dict[str, Any], probability_artifact: dict[str, Any]) -> dict[str, Any]:
    taxonomy_data = read_json(TAXONOMY_PATH)
    taxonomy_hash = canonical_json_sha256(taxonomy_data)
    manifest = load_manifest()
    history_manifest = manifest.get("aShareHistory", {})
    a_sources = [
        {
            "name": "中证全指行业优选指数编制方案V1.6",
            "publisher": "中证指数有限公司",
            "url": taxonomy_data["methodologyUrl"],
            "tier": "official",
            "evidenceClass": "official-primary",
        },
        {
            "name": "2026年A股休市安排",
            "publisher": "上海证券交易所",
            "url": read_json(CALENDAR_PATH)["sourceUrl"],
            "tier": "official",
            "evidenceClass": "official-primary",
        },
    ]
    source_by_code: dict[str, list[int]] = {}
    for index in taxonomy_data["indices"]:
        official_source_index = len(a_sources)
        a_sources.append(
            {
                "name": f"{index['shortName']}指数官方详情",
                "publisher": "中证指数有限公司",
                "url": index.get("factsheetUrl") or f"https://www.csindex.com.cn/zh-CN/indices/index-detail/{index['code']}",
                "tier": "official",
                "evidenceClass": "official-primary",
            }
        )
        history_source = history_manifest.get(index["code"], {}).get("source")
        if history_source == BAIDU_KLINE_API:
            if not baidu_fallback_allowed(index):
                raise RuntimeError(
                    f"invalid Baidu source metadata for ambiguous index code {index['code']}"
                )
            data_url = (
                f"{BAIDU_KLINE_API}?all=1&isIndex=true&isBk=false&isBlock=false&"
                f"isFutures=false&isStock=false&newFormat=1&group=quotation_kline_ab&"
                f"finClientType=pc&code={index['code']}&ktype=1"
            )
            publisher = "百度股市通"
            tier = "authoritative"
            evidence_class = "vendor-market-data"
        elif history_source == CSI_API:
            data_url = (
                f"{CSI_API}?indexCode={index['code']}&"
                f"startDate={as_of_compact(artifact.get('asOf', ''))}&"
                f"endDate={as_of_compact(artifact.get('asOf', ''))}"
            )
            publisher = "中证指数有限公司"
            tier = "official"
            evidence_class = "exchange-market-data"
        else:
            raise RuntimeError(
                f"missing or unsupported history source metadata for {index['code']}: "
                f"{history_source!r}"
            )
        data_source_index = len(a_sources)
        a_sources.append(
            {
                "name": f"{index['shortName']}日频量价数据",
                "publisher": publisher,
                "url": data_url,
                "tier": tier,
                "evidenceClass": evidence_class,
            }
        )
        source_by_code[index["code"]] = [official_source_index, data_source_index]
    latest = list(latest_rows().values())
    as_of = max(row["date"] for row in latest)
    latest = [row for row in latest if row["date"] == as_of]
    # The evidence URL must describe the current snapshot, not the model artifact's
    # training/as-of date.  Keep code, window start and current market as-of together.
    for index in taxonomy_data["indices"]:
        source = a_sources[source_by_code[index["code"]][1]]
        if source["url"].startswith(CSI_API):
            source["url"] = (
                f"{CSI_API}?indexCode={index['code']}&"
                f"startDate={as_of_compact(as_of)}&endDate={as_of_compact(as_of)}"
            )
    universe_count = artifact["data"]["universeCount"]
    expected_as_of = daily_brief_session("a-share")
    fresh = expected_as_of is not None and as_of == expected_as_of
    expected_label = expected_as_of or "日报缺少可验证sessionDate"
    # A fresh comparable subset can support current observation. Forecasts still
    # require the full fixed universe and never reuse a partial cross-section.
    current_ready = len(latest) >= 3 and fresh
    artifact_ready = (
        artifact.get("schemaVersion") in {1, 2}
        and artifact.get("data", {}).get("coverageCount") == universe_count
        and artifact.get("data", {}).get("universeCount") == universe_count
        and artifact.get("data", {}).get("trainingCoverageComplete") is True
        and (
            artifact.get("schemaVersion") == 1
            or all(
                artifact.get("models", {}).get(str(sessions), {}).get("trainingDates")
                == PRIMARY_WINDOW_SESSIONS
                for sessions in (5, 20)
            )
        )
        and artifact.get("taxonomyHash") == taxonomy_hash
        and artifact.get("taxonomy") == taxonomy_data
    )
    forecast_inputs_ready = (
        current_ready
        and len(latest) == universe_count
        and artifact_ready
        and probability_artifact.get("taxonomyHash") == taxonomy_hash
        and probability_artifact.get("schemaVersion") == 2
        and all(
            probability_artifact.get("horizons", {}).get(str(sessions), {}).get("status") == "ready"
            for sessions in (1, 5, 20)
        )
    )
    current_charts: list[dict[str, Any]] = []
    if current_ready:
        visualization = visualization_artifact({row["code"]: row for row in latest})
        visual_series = visualization["normalizedPerformance60d"]["series"]
        if visual_series:
            current_charts.append(
                {
                    "type": "line",
                    "title": "近60个交易日相对走势（起点=0）",
                    "unit": "%",
                    "note": "各行业序列分别以区间首个完整交易日收盘归一为0，仅比较相对路径。",
                    "asOf": as_of,
                    "sourceIndexes": sorted(
                        {
                            source_index
                            for series in visual_series
                            for source_index in source_by_code[series["code"]]
                        }
                    ),
                    "series": [
                        {
                            "name": series["name"],
                            "points": [
                                {"date": point["date"], "value": point["normalizedReturnPct"]}
                                for point in series["points"]
                            ],
                        }
                        for series in visual_series
                    ],
                }
            )
    current_components = {
        "momentum5": (0.32, z_scores(latest, "momentum5")),
        "momentum20": (0.26, z_scores(latest, "momentum20")),
        "amountRatio5v20": (0.18, z_scores(latest, "amountRatio5v20")),
        "volumeRatio5v20": (0.12, z_scores(latest, "volumeRatio5v20")),
        "volatility20": (-0.12, z_scores(latest, "volatility20")),
    }
    raw_current = []
    for row in latest:
        value = sum(weight * scores[row["code"]] for weight, scores in current_components.values())
        raw_current.append((row["code"], value))
    current_scores = percentile_scores(raw_current)
    current_order = sorted(latest, key=lambda row: current_scores[row["code"]], reverse=True)
    current_items = []
    for rank, row in enumerate(current_order, start=1):
        score = current_scores[row["code"]]
        amount_ratio = math.exp(row["amountRatio5v20"])
        volume_ratio = math.exp(row["volumeRatio5v20"])
        current_items.append(
            {
                "sector": row["name"],
                "code": row["code"],
                "rank": rank,
                "score": score,
                "direction": observed_direction(score),
                "signal": f"截至{as_of}的量价相对强弱观察；不包含未来方向判断。",
                "metrics": [
                    {"label": "5日涨跌", "value": f"{row['momentum5'] * 100:+.2f}%", "tone": tone_for_change(row["momentum5"])},
                    {"label": "20日涨跌", "value": f"{row['momentum20'] * 100:+.2f}%", "tone": tone_for_change(row["momentum20"])},
                    {"label": "成交额比", "value": f"{amount_ratio:.2f}x", "tone": "positive" if amount_ratio >= 1.35 else "neutral"},
                    {"label": "成交量比", "value": f"{volume_ratio:.2f}x", "tone": "positive" if volume_ratio >= 1.20 else "neutral"},
                ],
                "sourceIndexes": source_by_code[row["code"]],
            }
        )

    horizons: dict[str, Any] = {}
    for key, sessions in (("tomorrow", 1), ("oneWeek", 5), ("oneMonth", 20)):
        probability_horizon = probability_artifact.get("horizons", {}).get(str(sessions), {})
        if not forecast_inputs_ready:
            horizons[key] = {
                "kind": "forecast",
                "status": "insufficient",
                "asOf": as_of,
                "sessions": sessions,
                "reason": (
                    f"当前覆盖{len(latest)}/{universe_count}，冻结训练覆盖{artifact.get('data', {}).get('coverageCount', 0)}/{universe_count}，数据截至{as_of}、页面完整交易日为{expected_label}；"
                    "多目标相对收益模型或当日完整横截面尚未就绪；不会用50%或0填补失败。"
                ),
                **prediction_state_contract(
                    model_availability="trained",
                    publication_status="insufficient_data",
                    output_mode="none",
                    calibration_status="not_applicable",
                    probability_source="none",
                    probability_target="none",
                    model_version=probability_artifact.get("version"),
                    feature_version="a-core12-v2:price-volume-cross-section-interactions",
                    model_input_completeness=0.0,
                    production_feature_coverage=float(probability_artifact.get("dataDiagnostics", {}).get("productionFeatureCoverage", 0.0)),
                    gate_failures=["model_input_missing"],
                ),
            }
            continue
        due_date = trading_due_date(as_of, sessions)
        daily_predictions = [
            (row, relative_target_prediction(probability_horizon, row)) for row in latest
        ]
        daily_top = [
            float(prediction["probabilities"]["topQuartile"]["calibratedProbability"])
            for _, prediction in daily_predictions
        ]
        daily_outperformance = [
            float(prediction["probabilities"]["outperformance"]["calibratedProbability"])
            for _, prediction in daily_predictions
        ]
        daily_reasons = list(probability_horizon.get("abstainReasons", []))
        if daily_top and max(daily_top) - min(daily_top) < 0.03:
            daily_reasons.append("当日最高与最低进入前25%概率差小于3个百分点")
        if daily_top and statistics.pstdev(daily_top) < 0.01:
            daily_reasons.append("当日横截面预测标准差低于1个百分点")
        if daily_outperformance and all(0.47 <= value <= 0.53 for value in daily_outperformance):
            daily_reasons.append("当日全部跑赢基准概率落在47%—53%区间")
        daily_reasons = list(dict.fromkeys(daily_reasons))
        if probability_horizon.get("publicationStatus") != "published" or daily_reasons:
            diagnostic = probability_horizon.get("audit", {}).get("rankingMetrics", {})
            horizons[key] = {
                "kind": "forecast",
                "status": "abstained",
                "asOf": as_of,
                "dueDate": due_date,
                "sessions": sessions,
                "reason": "当前没有可靠的板块轮动概率信号，暂不发布概率排名。",
                "abstainReasons": daily_reasons or ["样本外质量闸门未通过"],
                "note": "基于资金可得性、相对强度与流动性证据排序；当前概率模型未通过样本外质量检验。观察分不是上涨概率。",
                "observationItems": current_items,
                "availableEvidence": [
                    f"12项中证固定观察池的同日量价横截面完整，基准为{A_SHARE_BENCHMARK['shortName']}。",
                    (
                        f"样本外RankIC={float(diagnostic.get('rankIc') or 0):.3f}，"
                        f"Top-Bottom扣费后收益差={float(diagnostic.get('topBottomSpreadAfterCosts') or 0) * 100:+.2f}%。"
                    ),
                ],
                "nextWatch": [
                    "ETF申赎、市场广度、融资与机构行为完成两年同口径回填后，生产级特征完整度需达到80%。",
                    "Brier Skill、RankIC、扣费后Top-Bottom收益差及多数walk-forward窗口必须同时为正。",
                ],
                "diagnostics": {
                    "modelVersion": probability_artifact.get("version"),
                    "modelInputCompleteness": float(probability_artifact.get("dataDiagnostics", {}).get("modelInputCompleteness", 1.0)),
                    "productionFeatureCoverage": float(probability_artifact.get("dataDiagnostics", {}).get("productionFeatureCoverage", probability_artifact.get("dataDiagnostics", {}).get("enhancedFeatureGroups", {}).get("completeness", 0))),
                    "rankIc": diagnostic.get("rankIc"),
                    "topBottomSpreadAfterCosts": diagnostic.get("topBottomSpreadAfterCosts"),
                    "predictionCrossSectionStd": diagnostic.get("predictionCrossSectionStd"),
                },
                **prediction_state_contract(
                    model_availability="trained",
                    publication_status="abstained",
                    output_mode="evidence_observation",
                    calibration_status="enabled" if probability_horizon.get("calibrations", {}).get("topQuartile", {}).get("enabled") else "disabled",
                    probability_source="raw_model",
                    probability_target="top_quartile",
                    model_version=probability_artifact.get("version"),
                    feature_version="a-core12-v2:price-volume-cross-section-interactions",
                    model_input_completeness=float(probability_artifact.get("dataDiagnostics", {}).get("modelInputCompleteness", 1.0)),
                    production_feature_coverage=float(probability_artifact.get("dataDiagnostics", {}).get("productionFeatureCoverage", probability_artifact.get("dataDiagnostics", {}).get("enhancedFeatureGroups", {}).get("completeness", 0))),
                    gate_failures=daily_reasons or ["quality_gate_failed"],
                ),
            }
            continue
        probability_rows = daily_predictions
        ordered = sorted(
            probability_rows,
            key=lambda item: (
                float(item[1]["probabilities"]["topQuartile"]["calibratedProbability"]),
                float(item[1]["expectedExcessReturn"]),
            ),
            reverse=True,
        )
        items = []
        for rank, (row, prediction) in enumerate(ordered, start=1):
            probabilities = prediction["probabilities"]
            top_quartile = probabilities["topQuartile"]
            outperformance = probabilities["outperformance"]
            absolute = probabilities["absoluteUp"]
            probability = float(top_quartile["calibratedProbability"])
            base_rate = float(top_quartile["historicalBaseRate"])
            direction = probability_direction(probability, base_rate)
            probability_pct = round(probability * 100, 1)
            base_rate_pct = round(base_rate * 100, 1)
            edge_pct = round((probability - base_rate) * 100, 1)
            expected_excess_pct = round(float(prediction["expectedExcessReturn"]) * 100, 2)
            audit = probability_horizon["audit"]
            metrics = audit["rankingMetrics"]
            calibration_basis = (
                f"滚动两年训练，{audit['evaluationDates']}个独立样本外日期/"
                f"{audit['evaluationObservations']}项评估；RankIC={float(metrics['rankIc']):.3f}，"
                f"扣费后Top-Bottom={float(metrics['topBottomSpreadAfterCosts']) * 100:+.2f}%。"
            )
            amount_ratio = math.exp(row["amountRatio5v20"])
            volume_ratio = math.exp(row["volumeRatio5v20"])
            if edge_pct >= 3:
                claim = f"{row['name']}未来{sessions}个交易日进入观察池前25%的概率为{probability_pct:.1f}%，跑赢中证全指概率为{float(outperformance['calibratedProbability']) * 100:.1f}%，预期相对收益{expected_excess_pct:+.2f}%。"
                trigger = "5日动量保持为正，且近5日成交额/此前20日均值不低于1.0倍。"
                invalidation = "5日动量转负且成交额比低于0.85倍，或行业相对强弱跌出横截面后40%。"
            elif edge_pct <= -3:
                claim = f"{row['name']}未来{sessions}个交易日进入观察池前25%的概率为{probability_pct:.1f}%，低于历史基准{abs(edge_pct):.1f}个百分点，预期相对收益{expected_excess_pct:+.2f}%。"
                trigger = "5日动量维持为负，且相对排名未回到横截面前60%。"
                invalidation = "5日动量转正并伴随成交额比升至1.20倍以上，或相对排名回到前40%。"
            else:
                claim = f"{row['name']}未来{sessions}个交易日进入观察池前25%的概率为{probability_pct:.1f}%，接近历史基准{base_rate_pct:.1f}%，预期相对收益{expected_excess_pct:+.2f}%。"
                trigger = "5日与20日动量方向分化，且成交额比维持0.85–1.20倍。"
                invalidation = "动量同向并伴随成交额比突破1.20倍或跌破0.85倍。"
            items.append(
                {
                    "forecastId": immutable_forecast_id(
                        probability_artifact,
                        as_of=as_of,
                        due_date=due_date,
                        sessions=sessions,
                        code=row["code"],
                    ),
                    "sector": row["name"],
                    "code": row["code"],
                    "rank": rank,
                    "rankingTarget": "top-quartile",
                    "topQuartileProbability": probability_pct,
                    "outperformanceProbability": round(float(outperformance["calibratedProbability"]) * 100, 1),
                    "absoluteUpProbability": round(float(absolute["calibratedProbability"]) * 100, 1),
                    "expectedExcessReturn": expected_excess_pct,
                    "rawScore": float(top_quartile["rawScore"]),
                    "rawProbability": round(float(top_quartile["rawProbability"]) * 100, 4),
                    "calibratedProbability": round(float(top_quartile["calibratedProbability"]) * 100, 4),
                    "historicalBaseRate": base_rate_pct,
                    "effectiveEdge": edge_pct,
                    "probabilityTier": "model-calibrated",
                    "direction": direction,
                    "confidence": "low",
                    "calibrationBasis": calibration_basis,
                    "claim": claim,
                    "evidence": [
                        {
                            "label": "趋势",
                            "observation": f"5日{row['momentum5'] * 100:+.2f}% / 20日{row['momentum20'] * 100:+.2f}%",
                            "sourceIndexes": source_by_code[row["code"]],
                        },
                        {
                            "label": "活跃度",
                            "observation": f"成交额比{amount_ratio:.2f}x，成交量比{volume_ratio:.2f}x",
                            "sourceIndexes": source_by_code[row["code"]],
                        },
                    ],
                    "counterEvidence": [
                        {
                            "label": "反向风险",
                            "observation": f"20日波动率{row['volatility20'] * 100:.2f}%，60日回撤{row['drawdown60'] * 100:.2f}%",
                            "sourceIndexes": source_by_code[row["code"]],
                        }
                    ],
                    "trigger": trigger,
                    "invalidation": invalidation,
                    "dueDate": due_date,
                }
            )
        horizons[key] = {
            "kind": "forecast",
            "status": "ready",
            "asOf": as_of,
            "dueDate": due_date,
            "sessions": sessions,
            "note": "主榜按进入固定观察池前25%的样本外校准概率排序；同时展示跑赢中证全指概率、绝对上涨概率和预期相对收益。",
            "items": items,
            **prediction_state_contract(
                model_availability="trained",
                publication_status="published",
                output_mode="probability",
                calibration_status="enabled" if probability_horizon.get("calibrations", {}).get("topQuartile", {}).get("enabled") else "disabled",
                probability_source="calibrated_model" if probability_horizon.get("calibrations", {}).get("topQuartile", {}).get("enabled") else "raw_model",
                probability_target="top_quartile",
                model_version=probability_artifact.get("version"),
                feature_version="a-core12-v2:price-volume-cross-section-interactions",
                model_input_completeness=float(probability_artifact.get("dataDiagnostics", {}).get("modelInputCompleteness", 1.0)),
                production_feature_coverage=float(probability_artifact.get("dataDiagnostics", {}).get("productionFeatureCoverage", probability_artifact.get("dataDiagnostics", {}).get("enhancedFeatureGroups", {}).get("completeness", 0))),
                gate_failures=[],
            ),
        }

    return {
        "id": "a-share",
        "label": "A股",
        "mode": "industry",
        "asOf": as_of,
        "status": "ready" if current_ready else "insufficient",
        "taxonomy": {
            "owner": "中证指数有限公司",
            "name": "A股核心行业与重点主题固定观察池（12项）",
            "version": "a-core12-v2",
            "effectiveDate": "2026-07-18",
        },
        "note": "固定12项精简观察池；医疗、军工、互联网只提升采集与解释深度，不参与加分。预测以中证全指为基准并受严格弃权门禁约束。",
        "reason": None if current_ready else (
            f"最新同日可比数据仅{len(latest)}/{universe_count}项，数据截至{as_of}，"
            f"页面完整交易日为{expected_label}；少于3项时不生成横截面排序。"
        ),
        "sources": a_sources,
        "horizons": {
            "current": {
                "kind": "observed",
                "status": "ready" if current_ready else "insufficient",
                "asOf": as_of,
                **prediction_state_contract(
                    model_availability="trained",
                    publication_status="not_applicable",
                    output_mode="evidence_observation",
                    calibration_status="not_applicable",
                    probability_source="none",
                    probability_target="none",
                    model_version=probability_artifact.get("version"),
                    feature_version="a-core12-v2:price-volume-cross-section-interactions",
                    model_input_completeness=float(probability_artifact.get("dataDiagnostics", {}).get("modelInputCompleteness", 1.0)),
                    production_feature_coverage=float(probability_artifact.get("dataDiagnostics", {}).get("productionFeatureCoverage", probability_artifact.get("dataDiagnostics", {}).get("enhancedFeatureGroups", {}).get("completeness", 0))),
                    gate_failures=[],
                ),
                **(
                    {
                        "note": f"当前score只在同日可用的{len(latest)}/{universe_count}项固定观察池内比较，不预测未来；成交额比/成交量比按近5日均值除以前20日均值计算。",
                        "items": current_items,
                        **({"charts": current_charts} if current_charts else {}),
                    }
                    if current_ready
                    else {
                        "reason": (
                            f"同日可比数据少于3项：{len(latest)}/{universe_count}。"
                            if len(latest) < 3
                            else f"数据日{as_of}未与日报完整交易日{expected_label}严格对齐。"
                        )
                    }
                ),
            },
            **horizons,
        },
    }


def fetch_hk_current() -> tuple[str, list[dict[str, Any]]]:
    session = requests_session()
    payload = fetch_json_with_retry(
        session,
        HSI_CURRENT_API,
        headers={"Referer": HSI_INDUSTRY_PAGE, "Accept": "application/json"},
    )
    index_lists = [
        series.get("indexList") or [] for series in payload.get("indexSeriesList") or [] if isinstance(series, dict)
    ]
    raw_items = next((items for items in index_lists if items), [])
    items: list[dict[str, Any]] = []
    dates: list[str] = []
    for raw in raw_items:
        code = str(raw.get("indexCode") or "")
        if code not in HSI_CODE_NAMES:
            continue
        change = finite(str(raw.get("changePercentage") or "").replace("+", ""))
        value = finite(raw.get("indexValue"))
        update = str(raw.get("lastUpdate") or "")
        as_of = update[:10]
        if change is None or value is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", as_of):
            continue
        dates.append(as_of)
        items.append({"code": code, "name": HSI_CODE_NAMES[code], "change": change, "value": value})
    if len(items) != len(HSI_CODE_NAMES) or len(set(dates)) != 1:
        raise RuntimeError(f"Hang Seng current coverage incomplete: {len(items)}/12, dates={sorted(set(dates))}")
    return dates[0], items


def hk_market() -> dict[str, Any]:
    expected_as_of = daily_brief_session("hk")
    try:
        as_of, items = fetch_hk_current()
        if expected_as_of is None:
            raise RuntimeError("daily brief is missing the verified HK sessionDate")
        if as_of != expected_as_of:
            raise RuntimeError(f"official snapshot date {as_of} does not match daily brief sessionDate {expected_as_of}")
        scores = percentile_scores([(item["code"], item["change"]) for item in items])
        items.sort(key=lambda item: scores[item["code"]], reverse=True)
        current = [
            {
                "sector": item["name"],
                "code": item["code"],
                "rank": rank,
                "score": scores[item["code"]],
                "direction": observed_direction(scores[item["code"]]),
                "signal": f"{as_of}恒生综合行业指数单日相对表现，仅为当前观察。",
                "metrics": [
                    {"label": "指数点位", "value": f"{item['value']:,.2f}"},
                    {"label": "当日涨跌", "value": f"{item['change']:+.2f}%", "tone": tone_for_change(item["change"])},
                ],
                "sourceIndexes": [0, 1],
            }
            for rank, item in enumerate(items, start=1)
        ]
        current_horizon: dict[str, Any] = {
            "kind": "observed",
            "status": "ready",
            "asOf": as_of,
            "note": "当前score按12个恒生综合行业指数当日涨跌做横截面排序，不预测未来。",
            "items": current,
            **prediction_state_contract(
                model_availability="not_trained",
                publication_status="not_applicable",
                output_mode="current_observation",
                calibration_status="not_applicable",
                probability_source="none",
                probability_target="none",
                model_version=None,
                feature_version=None,
                model_input_completeness=None,
                production_feature_coverage=None,
                gate_failures=[],
            ),
        }
        market_status = "ready"
        reason = "官方实时行业快照可用；官方历史接口当前未稳定返回，因此一周/月预测保持insufficient。"
    except Exception as exc:
        as_of = expected_as_of or datetime.now(SHANGHAI).date().isoformat()
        current_horizon = {
            "kind": "observed",
            "status": "insufficient",
            "asOf": as_of,
            "reason": f"恒生官方当前行业快照不可用：{exc}",
            **prediction_state_contract(
                model_availability="not_trained",
                publication_status="not_applicable",
                output_mode="none",
                calibration_status="not_applicable",
                probability_source="none",
                probability_target="none",
                model_version=None,
                feature_version=None,
                model_input_completeness=None,
                production_feature_coverage=None,
                gate_failures=["current_observation_unavailable"],
            ),
        }
        market_status = "insufficient"
        reason = current_horizon["reason"]
    if current_horizon["status"] == "ready":
        hk_forecasts = {
            key: {
                "kind": "forecast",
                "status": "insufficient",
                "asOf": as_of,
                "sessions": sessions,
                "reason": "港股概率模型尚未建设，当前仅展示当日市场结构观察。",
                **prediction_state_contract(
                    model_availability="not_trained",
                    publication_status="not_applicable",
                    output_mode="current_observation",
                    calibration_status="not_applicable",
                    probability_source="none",
                    probability_target="none",
                    model_version=None,
                    feature_version=None,
                    model_input_completeness=None,
                    production_feature_coverage=None,
                    gate_failures=["model_not_trained"],
                ),
            }
            for key, sessions in (("tomorrow", 1), ("oneWeek", 5), ("oneMonth", 20))
        }
    else:
        hk_forecasts = {
            key: {
                "kind": "forecast",
                "status": "insufficient",
                "asOf": as_of,
                "sessions": sessions,
                "reason": "恒生官方当前行业快照不可用，无法生成可复核观察榜。",
                **prediction_state_contract(
                    model_availability="not_trained",
                    publication_status="not_applicable",
                    output_mode="none",
                    calibration_status="not_applicable",
                    probability_source="none",
                    probability_target="none",
                    model_version=None,
                    feature_version=None,
                    model_input_completeness=None,
                    production_feature_coverage=None,
                    gate_failures=["model_not_trained", "current_observation_unavailable"],
                ),
            }
            for key, sessions in (("tomorrow", 1), ("oneWeek", 5), ("oneMonth", 20))
        }
    return {
        "id": "hk",
        "label": "港股",
        "mode": "industry",
        "asOf": as_of,
        "status": market_status,
        "taxonomy": {
            "owner": "恒生指数有限公司",
            "name": "恒生综合指数行业指数（一级行业）",
            "version": "HSICS current",
            "effectiveDate": as_of,
        },
        "note": "以12个恒生综合行业指数为固定当前层；不使用第三方板块冒充官方历史。",
        "reason": reason,
        "sources": [
            {
                "name": "Hang Seng Composite Industry Indexes",
                "publisher": "Hang Seng Indexes Company Limited",
                "url": HSI_INDUSTRY_PAGE,
                "tier": "official",
                "evidenceClass": "official-primary",
            },
            {
                "name": "Hang Seng industry performance snapshot",
                "publisher": "Hang Seng Indexes Company Limited",
                "url": HSI_CURRENT_API,
                "tier": "official",
                "evidenceClass": "exchange-market-data",
            },
        ],
        "horizons": {
            "current": current_horizon,
            **hk_forecasts,
        },
    }


def us_market() -> dict[str, Any]:
    as_of = datetime.now(SHANGHAI).date().isoformat()
    current: dict[str, Any] = {
        "kind": "observed",
        "status": "insufficient",
        "asOf": as_of,
        "reason": "本行业轮动模型不训练美股；当前三大指数等待日报完整交易日数据。",
        **prediction_state_contract(
            model_availability="not_implemented",
            publication_status="not_applicable",
            output_mode="none",
            calibration_status="not_applicable",
            probability_source="none",
            probability_target="none",
            model_version=None,
            feature_version=None,
            model_input_completeness=None,
            production_feature_coverage=None,
            gate_failures=["current_observation_unavailable"],
        ),
    }
    sources: list[dict[str, Any]] = []
    if DAILY_BRIEF_PATH.exists():
        brief = read_json(DAILY_BRIEF_PATH)
        market = next((item for item in brief.get("markets", []) if item.get("id") == "us"), None)
        raw_expected_as_of = str(market.get("sessionDate", "")) if market else ""
        expected_as_of = raw_expected_as_of if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw_expected_as_of) else ""
        if market and len(market.get("indices", [])) == 3:
            rows = market["indices"]
            row_dates = {str(item.get("date", "")) for item in rows}
            if len(row_dates) != 1 or expected_as_of not in row_dates:
                return {
                    "id": "us",
                    "label": "美股三大指数",
                    "mode": "major-index",
                    "asOf": expected_as_of or as_of,
                    "status": "insufficient",
                    "taxonomy": {
                        "owner": "观潮日报引用的指数发布方/市场数据来源",
                        "name": "纳斯达克、道琼斯、标普500三大指数（非行业分类）",
                        "version": "daily-brief",
                        "effectiveDate": expected_as_of or as_of,
                    },
                    "note": "不扩建美股行业模型；只保留三大指数当前状态。",
                    "reason": "三大指数日期未与日报完整交易日严格对齐。",
                    "sources": [],
                    "horizons": {
                        "current": {"kind": "observed", "status": "insufficient", "asOf": expected_as_of or as_of, "reason": "三大指数日期不一致或sessionDate缺失。", **prediction_state_contract(model_availability="not_implemented", publication_status="not_applicable", output_mode="none", calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None, feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["current_observation_unavailable"])},
                        "tomorrow": {"kind": "forecast", "status": "insufficient", "asOf": expected_as_of or as_of, "sessions": 1, "reason": "美股预测模型尚未实现，当前仅展示三大指数市场状态。", **prediction_state_contract(model_availability="not_implemented", publication_status="not_applicable", output_mode="current_observation", calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None, feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["model_not_implemented"])},
                        "oneWeek": {"kind": "forecast", "status": "insufficient", "asOf": expected_as_of or as_of, "sessions": 5, "reason": "美股预测模型尚未实现，当前仅展示三大指数市场状态。", **prediction_state_contract(model_availability="not_implemented", publication_status="not_applicable", output_mode="current_observation", calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None, feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["model_not_implemented"])},
                        "oneMonth": {"kind": "forecast", "status": "insufficient", "asOf": expected_as_of or as_of, "sessions": 20, "reason": "美股预测模型尚未实现，当前仅展示三大指数市场状态。", **prediction_state_contract(model_availability="not_implemented", publication_status="not_applicable", output_mode="current_observation", calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None, feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["model_not_implemented"])},
                    },
                }
            as_of = expected_as_of
            scores = percentile_scores([(str(i), float(item["change"])) for i, item in enumerate(rows)])
            ordered = sorted(enumerate(rows), key=lambda pair: scores[str(pair[0])], reverse=True)
            current = {
                "kind": "observed",
                "status": "ready",
                "asOf": as_of,
                "note": "仅展示纳斯达克、道琼斯、标普500三大指数当前状态；不称为行业轮动。",
                "items": [
                    {
                        "sector": item["name"],
                        "rank": rank,
                        "score": scores[str(original)],
                        "direction": observed_direction(scores[str(original)]),
                        "signal": f"{item['date']}完整交易日指数表现。",
                        "metrics": [
                            {"label": "点位", "value": item["value"]},
                            {"label": "当日涨跌", "value": f"{float(item['change']):+.2f}%", "tone": tone_for_change(float(item["change"]))},
                        ],
                        "sourceIndexes": list(range(len(market.get("sources", [])))),
                    }
                    for rank, (original, item) in enumerate(ordered, start=1)
                ],
                **prediction_state_contract(
                    model_availability="not_implemented",
                    publication_status="not_applicable",
                    output_mode="current_observation",
                    calibration_status="not_applicable",
                    probability_source="none",
                    probability_target="none",
                    model_version=None,
                    feature_version=None,
                    model_input_completeness=None,
                    production_feature_coverage=None,
                    gate_failures=[],
                ),
            }
            sources = market.get("sources", [])
    return {
        "id": "us",
        "label": "美股三大指数",
        "mode": "major-index",
        "asOf": as_of,
        "status": "ready" if current["status"] == "ready" else "insufficient",
        "taxonomy": {
            "owner": "观潮日报引用的指数发布方/市场数据来源",
            "name": "纳斯达克、道琼斯、标普500三大指数（非行业分类）",
            "version": "daily-brief",
            "effectiveDate": as_of,
        },
        "note": "不扩建美股行业模型；只保留三大指数当前状态。",
        "reason": "本次没有经同口径历史回测的美股三大指数条件模型。",
        "sources": sources,
        "horizons": {
            "current": current,
            "tomorrow": {
                "kind": "forecast",
                "status": "insufficient",
                "asOf": as_of,
                "sessions": 1,
                "reason": "未训练并样本外校准三大指数明日上涨概率。",
                **prediction_state_contract(
                    model_availability="not_implemented", publication_status="not_applicable", output_mode="current_observation",
                    calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None,
                    feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["model_not_implemented"],
                ),
            },
            "oneWeek": {
                "kind": "forecast",
                "status": "insufficient",
                "asOf": as_of,
                "sessions": 5,
                "reason": "未训练并样本外验证三大指数条件模型，不发布一周方向排序。",
                **prediction_state_contract(
                    model_availability="not_implemented", publication_status="not_applicable", output_mode="current_observation",
                    calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None,
                    feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["model_not_implemented"],
                ),
            },
            "oneMonth": {
                "kind": "forecast",
                "status": "insufficient",
                "asOf": as_of,
                "sessions": 20,
                "reason": "未训练并样本外验证三大指数条件模型，不发布一月方向排序。",
                **prediction_state_contract(
                    model_availability="not_implemented", publication_status="not_applicable", output_mode="current_observation",
                    calibration_status="not_applicable", probability_source="none", probability_target="none", model_version=None,
                    feature_version=None, model_input_completeness=None, production_feature_coverage=None, gate_failures=["model_not_implemented"],
                ),
            },
        },
    }


def infer(_: argparse.Namespace) -> dict[str, Any]:
    if not MODEL_PATH.exists():
        raise SystemExit("frozen model missing; run 'pipeline' once")
    if not MULTI_TARGET_MODEL_PATH.exists():
        raise SystemExit("relative multi-target model missing; run 'rotation:probability-train' once")
    try:
        ensure_event_memory()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"event memory initialization failed: {exc}") from exc
    artifact = read_json(MODEL_PATH)
    probability_artifact = read_json(MULTI_TARGET_MODEL_PATH)
    metrics = []
    for sessions in (1, 5, 20):
        result = probability_artifact["horizons"][str(sessions)]
        audit = result["audit"]["rankingMetrics"]
        top_audit = result["calibrations"]["topQuartile"]
        probability_audit = top_audit["calibratedMetrics" if top_audit["enabled"] else "rawMetrics"]
        metrics.append(
            f"{sessions}日 {result['publicationStatus']}（Brier Skill {probability_audit['brierSkill']:.3f}，"
            f"AUC {probability_audit['auc']:.3f}，RankIC {audit['rankIc']:.3f}）"
        )
    payload = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "model": {
            "id": probability_artifact["id"],
            "version": probability_artifact["version"],
            "trainedAt": probability_artifact["trainedAt"],
            "trainingStart": probability_artifact["trainingStart"],
            "trainingEnd": probability_artifact["trainingEnd"],
            "method": "冻结的1/5/20交易日多目标模型；分别估计绝对上涨、跑赢中证全指、进入前25%和预期相对收益。使用purged walk-forward与embargo；质量不足时弃权并展示非概率观察榜。",
            "features": probability_artifact["features"],
            "backtest": {
                "status": "limited" if any(result["publicationStatus"] == "abstained" for result in probability_artifact["horizons"].values()) else "passed",
                "summary": "；".join(metrics) + "。未通过闸门的周期不会发布概率排名。",
            },
        },
        "markets": [a_share_market(artifact, probability_artifact), hk_market(), us_market()],
    }
    # Avoid serializing null reason fields when a market is ready.
    for market in payload["markets"]:
        if market.get("reason") is None:
            market.pop("reason", None)
    write_json_atomic(CONTENT_PATH, payload)
    print(f"[infer] wrote {CONTENT_PATH.relative_to(ROOT)}", flush=True)
    history_script = ROOT / "scripts" / "prediction_history.py"
    if history_script.exists():
        result = subprocess.run(
            [sys.executable, str(history_script)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"prediction history update failed: {result.stderr.strip()}")
        if result.stdout.strip():
            print(result.stdout.strip(), flush=True)
    return payload


def canonical_event_hash(event: dict[str, Any]) -> str:
    text = "\0".join(
        str(event.get(key, "")) for key in ("date", "sourceUrl", "eventType", "factSummary")
    )
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


EVENT_KEYS = {
    "schemaVersion", "date", "title", "sourceUrl", "corroboratingSourceUrls",
    "sourceTier", "evidenceClass", "sectorTags", "eventType", "factSummary",
    "knownAt", "truthAt", "truthSourceUrl", "scenario", "capitalActor",
    "observationMode", "alternativeExplanations", "invalidation",
    "proxyEvaluation", "extraction", "forward5dOutcome", "forward20dOutcome",
    "contentHash",
}
SOURCE_TIERS = {"official", "authoritative", "major-media"}
EVIDENCE_CLASSES = {
    "official-primary", "company-filing", "primary-research",
    "exchange-market-data", "vendor-market-data", "vendor-estimate",
    "major-media", "proxy",
}
EVENT_TYPES = {
    "policy", "macro", "earnings", "guidance", "regulation",
    "corporate-action", "institution-view", "market-structure",
    "long-term-capital-disclosure", "other",
}


def event_error(message: str) -> None:
    raise ValueError(message)


def require_event_text(value: Any, label: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or not minimum <= len(value) <= maximum:
        event_error(f"{label} must contain {minimum}-{maximum} characters")
    return value


def require_https(value: Any, label: str) -> str:
    text = require_event_text(value, label, 1, 600)
    parsed = urlparse(text)
    if parsed.scheme != "https" or not parsed.netloc:
        event_error(f"{label} must be a direct HTTPS URL")
    if parsed.hostname and parsed.hostname.lower().startswith("google.") and "/search" in parsed.path:
        event_error(f"{label} cannot be a search result URL")
    return text


def require_iso_time(value: Any, label: str) -> datetime:
    text = require_event_text(value, label, 1, 80)
    if not re.search(r"(Z|[+-]\d{2}:\d{2})$", text):
        event_error(f"{label} must include an explicit timezone")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO datetime") from exc
    if parsed.tzinfo is None:
        event_error(f"{label} must include an explicit timezone")
    return parsed


def validate_event_array(
    value: Any,
    label: str,
    minimum: int,
    maximum: int,
    item_minimum: int,
    item_maximum: int,
) -> list[str]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        event_error(f"{label} must contain {minimum}-{maximum} items")
    result = [require_event_text(item, f"{label}[{index}]", item_minimum, item_maximum) for index, item in enumerate(value)]
    if len({item.strip().lower() for item in result}) != len(result):
        event_error(f"{label} contains duplicate items")
    return result


def validate_event_outcome(outcome: Any, known_at: datetime, sessions: int, label: str) -> None:
    if outcome is None:
        return
    if not isinstance(outcome, dict):
        event_error(f"{label} must be null or an object")
    allowed = {
        "baseDate", "dueDate", "sessions", "tradingDates", "calendarSourceUrl", "calendarSha256",
        "market", "targetCode", "benchmarkCode", "returnType", "startClose",
        "endClose", "benchmarkStartClose", "benchmarkEndClose",
        "relativeReturnPct", "priceSourceUrls", "inputSha256", "measuredAt", "status",
    }
    if set(outcome) != allowed:
        event_error(f"{label} fields must be exactly {sorted(allowed)}")
    if outcome["sessions"] != sessions:
        event_error(f"{label}.sessions must be {sessions}")
    try:
        base_date = date.fromisoformat(str(outcome["baseDate"]))
        due_date = date.fromisoformat(str(outcome["dueDate"]))
    except ValueError as exc:
        raise ValueError(f"{label}.dueDate must be YYYY-MM-DD") from exc
    if base_date > known_at.astimezone(SHANGHAI).date():
        event_error(f"{label}.baseDate cannot be later than knownAt")
    trading_dates = outcome["tradingDates"]
    if not isinstance(trading_dates, list) or len(trading_dates) != sessions:
        event_error(f"{label}.tradingDates must list exactly {sessions} complete sessions")
    parsed_dates: list[date] = []
    for index, value in enumerate(trading_dates):
        try:
            parsed = date.fromisoformat(str(value))
        except ValueError as exc:
            raise ValueError(f"{label}.tradingDates[{index}] must be YYYY-MM-DD") from exc
        if parsed <= known_at.astimezone(SHANGHAI).date():
            event_error(f"{label}.tradingDates[{index}] must be after knownAt")
        if parsed.weekday() >= 5:
            event_error(f"{label}.tradingDates[{index}] cannot be a weekend")
        if parsed_dates and parsed <= parsed_dates[-1]:
            event_error(f"{label}.tradingDates must be strictly increasing")
        parsed_dates.append(parsed)
    if parsed_dates[-1] != due_date:
        event_error(f"{label}.dueDate must equal the final tradingDates entry")
    require_https(outcome["calendarSourceUrl"], f"{label}.calendarSourceUrl")
    if not isinstance(outcome["calendarSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", outcome["calendarSha256"]):
        event_error(f"{label}.calendarSha256 must be a lowercase SHA-256")
    if outcome["market"] != "a-share":
        event_error(f"{label}.market must be a-share until a versioned HKEX calendar artifact exists")
    calendar = read_json(CALENDAR_PATH)
    calendar_hash = sha256_path(CALENDAR_PATH)
    if outcome["calendarSha256"] != calendar_hash:
        event_error(f"{label}.calendarSha256 does not match the versioned A-share calendar artifact")
    if outcome["calendarSourceUrl"] != calendar.get("sourceUrl"):
        event_error(f"{label}.calendarSourceUrl does not match the versioned A-share calendar artifact")
    if calendar.get("market") != "A-share" or calendar.get("timezone") != "Asia/Shanghai":
        event_error(f"{label}: A-share calendar artifact metadata is invalid")
    known_date = known_at.astimezone(SHANGHAI).date()
    if known_date.year != calendar.get("year"):
        event_error(f"{label}.knownAt is outside the versioned A-share calendar year")
    closed_weekdays = {date.fromisoformat(value) for value in calendar.get("closedWeekdays", [])}
    expected_dates: list[date] = []
    cursor = known_date + timedelta(days=1)
    while len(expected_dates) < sessions:
        if cursor.year != calendar.get("year"):
            event_error(f"{label}: versioned A-share calendar does not cover the complete outcome horizon")
        if cursor.weekday() < 5 and cursor not in closed_weekdays:
            expected_dates.append(cursor)
        cursor += timedelta(days=1)
    if parsed_dates != expected_dates:
        event_error(f"{label}.tradingDates do not match the next {sessions} sessions in the versioned calendar")
    require_event_text(outcome["targetCode"], f"{label}.targetCode", 1, 30)
    require_event_text(outcome["benchmarkCode"], f"{label}.benchmarkCode", 1, 30)
    if outcome["returnType"] != "simple-close-relative":
        event_error(f"{label}.returnType must be simple-close-relative")
    prices: dict[str, float] = {}
    for field in ("startClose", "endClose", "benchmarkStartClose", "benchmarkEndClose"):
        value = finite(outcome[field])
        if value is None or value <= 0:
            event_error(f"{label}.{field} must be a positive finite close")
        prices[field] = value
    relative_return = finite(outcome["relativeReturnPct"])
    if relative_return is None:
        event_error(f"{label}.relativeReturnPct must be finite")
    recomputed = (
        (prices["endClose"] / prices["startClose"] - 1)
        - (prices["benchmarkEndClose"] / prices["benchmarkStartClose"] - 1)
    ) * 100
    if abs(relative_return - recomputed) > 0.011:
        event_error(f"{label}.relativeReturnPct does not match the four close inputs")
    price_sources = outcome["priceSourceUrls"]
    if not isinstance(price_sources, list) or not 1 <= len(price_sources) <= 3 or len(set(price_sources)) != len(price_sources):
        event_error(f"{label}.priceSourceUrls must contain 1-3 unique URLs")
    for index, value in enumerate(price_sources):
        require_https(value, f"{label}.priceSourceUrls[{index}]")
    if not isinstance(outcome["inputSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", outcome["inputSha256"]):
        event_error(f"{label}.inputSha256 must be a lowercase SHA-256")
    measured_at = require_iso_time(outcome["measuredAt"], f"{label}.measuredAt")
    if measured_at < datetime.combine(due_date, datetime.min.time(), SHANGHAI):
        event_error(f"{label}.measuredAt cannot be earlier than dueDate")
    if outcome["status"] not in {"confirmed", "partial", "invalidated", "neutral"}:
        event_error(f"{label}.status is invalid")


def validate_event_record(event: dict[str, Any]) -> None:
    if not isinstance(event, dict):
        event_error("event must be a JSON object")
    extras = set(event) - EVENT_KEYS
    if extras:
        event_error(f"event contains undefined fields: {sorted(extras)}")
    required = {
        "schemaVersion", "date", "title", "sourceUrl", "sourceTier",
        "evidenceClass", "sectorTags", "eventType", "factSummary", "knownAt",
        "scenario", "forward5dOutcome", "forward20dOutcome", "contentHash",
    }
    missing = required - set(event)
    if missing:
        event_error(f"event missing required fields: {sorted(missing)}")
    if event["schemaVersion"] != 1:
        event_error("schemaVersion must be 1")
    try:
        event_date = date.fromisoformat(str(event["date"]))
    except ValueError as exc:
        raise ValueError("event.date must be YYYY-MM-DD") from exc
    require_event_text(event["title"], "title", 4, 120)
    require_https(event["sourceUrl"], "sourceUrl")
    corroborating = event.get("corroboratingSourceUrls")
    if corroborating is not None:
        urls = validate_event_array(corroborating, "corroboratingSourceUrls", 0, 5, 1, 600)
        for index, value in enumerate(urls):
            require_https(value, f"corroboratingSourceUrls[{index}]")
    if event["sourceTier"] not in SOURCE_TIERS:
        event_error("sourceTier is invalid")
    if event["evidenceClass"] not in EVIDENCE_CLASSES:
        event_error("evidenceClass is invalid")
    validate_event_array(event["sectorTags"], "sectorTags", 1, 12, 1, 30)
    if event["eventType"] not in EVENT_TYPES:
        event_error("eventType is invalid")
    require_event_text(event["factSummary"], "factSummary", 60, 220)
    known_at = require_iso_time(event["knownAt"], "knownAt")
    if known_at.astimezone(SHANGHAI).date() < event_date:
        event_error("knownAt cannot be earlier than event.date")
    if event["scenario"] not in {"positive", "negative", "mixed", "neutral"}:
        event_error("scenario is invalid")
    truth_at_value = event.get("truthAt")
    truth_source = event.get("truthSourceUrl")
    if (truth_at_value is None) != (truth_source is None):
        event_error("truthAt and truthSourceUrl must appear together")
    if truth_at_value is not None:
        truth_at = require_iso_time(truth_at_value, "truthAt")
        require_https(truth_source, "truthSourceUrl")
        if truth_at < known_at:
            event_error("truthAt cannot be earlier than knownAt")
    if event.get("capitalActor") not in {
        None, "central-huijin", "csf", "national-social-security-fund",
        "basic-pension-fund",
    }:
        event_error("capitalActor is invalid")
    observation_mode = event.get("observationMode")
    if observation_mode not in {None, "disclosed-fact", "retrospective-label", "inference-proxy"}:
        event_error("observationMode is invalid")
    if event["eventType"] == "long-term-capital-disclosure" and (
        event.get("capitalActor") is None or observation_mode is None
    ):
        event_error("long-term-capital-disclosure requires capitalActor and observationMode")
    if event["eventType"] != "long-term-capital-disclosure" and (
        event.get("capitalActor") is not None
        or observation_mode is not None
        or event.get("proxyEvaluation") is not None
    ):
        event_error("non-long-term events cannot contain capitalActor, observationMode or proxyEvaluation")
    alternatives = event.get("alternativeExplanations")
    if alternatives is not None:
        validate_event_array(alternatives, "alternativeExplanations", 1, 5, 4, 120)
    if event.get("invalidation") is not None:
        require_event_text(event["invalidation"], "invalidation", 1, 180)
    if observation_mode == "inference-proxy":
        if not alternatives:
            event_error("inference-proxy requires alternativeExplanations")
        require_event_text(event.get("invalidation"), "invalidation", 1, 180)
        if re.search(r"已买入|正在买入|偷偷买入|确定买入|确认流入", f"{event['title']}{event['factSummary']}"):
            event_error("inference-proxy cannot claim that long-term capital has bought")
    extraction = event.get("extraction")
    if extraction is not None:
        if not isinstance(extraction, dict) or set(extraction) - {"mode", "confidence", "sourceUrl", "unit", "scope", "period"}:
            event_error("extraction contains invalid fields")
        if not {"mode", "confidence"} <= set(extraction):
            event_error("extraction requires mode and confidence")
        if extraction["mode"] not in {"html-structured", "manual-verified", "ocr-structured"}:
            event_error("extraction.mode is invalid")
        confidence = finite(extraction["confidence"])
        if confidence is None or not 0 <= confidence <= 1:
            event_error("extraction.confidence must be 0-1")
        if extraction["mode"] == "ocr-structured" and confidence < 0.90:
            event_error("OCR extraction confidence below 0.90")
        if extraction.get("sourceUrl") is not None:
            require_https(extraction["sourceUrl"], "extraction.sourceUrl")
        for key, maximum in (("unit", 40), ("scope", 160), ("period", 80)):
            if extraction.get(key) is not None:
                require_event_text(extraction[key], f"extraction.{key}", 1, maximum)
    proxy = event.get("proxyEvaluation")
    if proxy is not None:
        allowed = {"status", "signals", "leadTradingDays", "note"}
        if not isinstance(proxy, dict) or set(proxy) - allowed or not {"status", "signals", "note"} <= set(proxy):
            event_error("proxyEvaluation has invalid or missing fields")
        if proxy["status"] not in {"hit", "false-positive", "partial", "not-evaluable"}:
            event_error("proxyEvaluation.status is invalid")
        signals = validate_event_array(proxy["signals"], "proxyEvaluation.signals", 1, 4, 1, 60)
        valid_signals = {
            "etf-subscription-redemption", "broad-index-turnover-share",
            "heavyweight-relative-strength", "closing-auction-concentration",
        }
        if any(signal not in valid_signals for signal in signals):
            event_error("proxyEvaluation.signals contains an invalid signal")
        lead = proxy.get("leadTradingDays")
        if lead is not None and (not isinstance(lead, int) or not 0 <= lead <= 250):
            event_error("proxyEvaluation.leadTradingDays must be 0-250")
        require_event_text(proxy["note"], "proxyEvaluation.note", 4, 180)
        if proxy["status"] in {"hit", "partial"} and truth_at_value is None:
            event_error("hit/partial proxyEvaluation requires truthAt and truthSourceUrl")
    validate_event_outcome(event["forward5dOutcome"], known_at, 5, "forward5dOutcome")
    validate_event_outcome(event["forward20dOutcome"], known_at, 20, "forward20dOutcome")
    expected_hash = canonical_event_hash(event)
    if event["contentHash"] != expected_hash:
        event_error("contentHash does not match canonical event fields")


def event_store_state() -> tuple[set[str], set[str], int, int]:
    hashes: set[str] = set()
    keys: set[str] = set()
    count = 0
    decompressed = 0
    if not EVENT_PATH.exists():
        return hashes, keys, count, decompressed
    if EVENT_PATH.stat().st_size > 32 * 1024 * 1024:
        event_error("event memory exceeds the 32MB compressed hard limit")
    with gzip.open(EVENT_PATH, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            encoded = line.encode("utf-8")
            decompressed += len(encoded)
            count += 1
            if len(encoded) > 8 * 1024:
                event_error("existing event line exceeds 8KB")
            if decompressed > 128 * 1024 * 1024 or count > 15_000:
                event_error("existing event memory exceeds streaming limits")
            event = json.loads(line)
            validate_event_record(event)
            content_hash = event["contentHash"]
            event_key = "\0".join((event["date"], event["sourceUrl"].split("?", 1)[0].split("#", 1)[0], event["eventType"])).lower()
            if content_hash in hashes or event_key in keys:
                event_error("existing event memory contains duplicates")
            hashes.add(content_hash)
            keys.add(event_key)
    return hashes, keys, count, decompressed


def ensure_event_memory() -> None:
    if EVENT_PATH.exists():
        return
    if not EVENT_SEED_PATH.exists():
        event_error("long-money event seed is missing")
    records: list[dict[str, Any]] = []
    hashes: set[str] = set()
    with EVENT_SEED_PATH.open("r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            if len(line.encode("utf-8")) > 8 * 1024:
                event_error("seed event line exceeds 8KB")
            record = json.loads(line)
            validate_event_record(record)
            if record["contentHash"] in hashes:
                event_error("seed event memory contains duplicate hashes")
            hashes.add(record["contentHash"])
            records.append(record)
    if len(records) > 15_000:
        event_error("seed event memory exceeds 15,000 events")
    EVENT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=EVENT_DIR, suffix=".tmp") as raw:
        temp_name = raw.name
    try:
        with gzip.open(temp_name, "wt", encoding="utf-8", compresslevel=6) as handle:
            for record in records:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        os.replace(temp_name, EVENT_PATH)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)
    print(f"[events] initialized {len(records)} curated seed events", flush=True)


def rewrite_event_memory(
    excluded_hashes: set[str] | None = None,
    appended_event: dict[str, Any] | None = None,
) -> int:
    excluded_hashes = excluded_hashes or set()
    EVENT_DIR.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("wb", delete=False, dir=EVENT_DIR, suffix=".tmp") as raw:
        temp_name = raw.name
    try:
        with gzip.open(temp_name, "wt", encoding="utf-8", compresslevel=6) as target:
            if EVENT_PATH.exists():
                with gzip.open(EVENT_PATH, "rt", encoding="utf-8") as source:
                    for line in source:
                        if not line.strip():
                            continue
                        record = json.loads(line)
                        if record.get("contentHash") not in excluded_hashes:
                            target.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
            if appended_event is not None:
                target.write(json.dumps(appended_event, ensure_ascii=False, separators=(",", ":")) + "\n")
        size = os.path.getsize(temp_name)
        if size > 32 * 1024 * 1024:
            raise ValueError("rewritten event memory would exceed the exact 32MB compressed limit")
        os.replace(temp_name, EVENT_PATH)
        return size
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def prune_event_memory(_: argparse.Namespace | None = None) -> int:
    ensure_event_memory()
    current_size = EVENT_PATH.stat().st_size
    if current_size < 28 * 1024 * 1024:
        print(f"[events] prune not needed size={current_size}B", flush=True)
        return 0
    completed: list[tuple[str, str]] = []
    with gzip.open(EVENT_PATH, "rt", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("forward5dOutcome") is not None and record.get("forward20dOutcome") is not None:
                completed.append((str(record.get("date", "")), str(record.get("contentHash", ""))))
    completed.sort()
    if not completed:
        raise SystemExit("event memory is above 28MB but has no fully evaluated old events safe to prune")
    target_size = 26 * 1024 * 1024
    step = max(1, math.ceil(len(completed) * 0.10))
    remove_count = step
    final_size = current_size
    while remove_count <= len(completed):
        removed = {content_hash for _, content_hash in completed[:remove_count]}
        final_size = rewrite_event_memory(excluded_hashes=removed)
        if final_size <= target_size or remove_count == len(completed):
            print(f"[events] pruned={remove_count} size={current_size}B->{final_size}B", flush=True)
            return remove_count
        # The previous rewrite is already valid and smaller; continue from it,
        # removing an additional deterministic batch on the next pass.
        completed = completed[remove_count:]
        current_size = final_size
        if not completed:
            break
        remove_count = min(step, len(completed))
    return 0


def append_event(args: argparse.Namespace) -> None:
    event = read_json(Path(args.input))
    event.setdefault("schemaVersion", 1)
    event.setdefault("scenario", "neutral")
    event.setdefault("forward5dOutcome", None)
    event.setdefault("forward20dOutcome", None)
    event["contentHash"] = canonical_event_hash(event)
    try:
        validate_event_record(event)
        ensure_event_memory()
        hashes, keys, count, decompressed = event_store_state()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"event rejected: {exc}") from exc
    event_key = "\0".join((event["date"], event["sourceUrl"].split("?", 1)[0].split("#", 1)[0], event["eventType"])).lower()
    if event["contentHash"] in hashes or event_key in keys:
        print("[events] duplicate contentHash; no append")
        return
    compressed_bytes = EVENT_PATH.stat().st_size if EVENT_PATH.exists() else 0
    prune_at = 28 * 1024 * 1024
    encoded = (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    encoded_bytes = len(encoded)
    if encoded_bytes > 8 * 1024:
        raise SystemExit("event would exceed the 8KB decompressed line limit")
    if count + 1 > 15_000 or decompressed + encoded_bytes > 128 * 1024 * 1024:
        raise SystemExit("event memory would exceed the count/decompressed streaming limit")
    if compressed_bytes >= prune_at:
        prune_event_memory()
        hashes, keys, count, decompressed = event_store_state()
        if event["contentHash"] in hashes or event_key in keys:
            print("[events] duplicate contentHash after prune; no append")
            return
    try:
        rewrite_event_memory(appended_event=event)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(f"event append aborted atomically: {exc}") from exc
    print(f"[events] appended {event['contentHash'][:12]} size={EVENT_PATH.stat().st_size}B")


def pipeline(args: argparse.Namespace) -> None:
    if bool(getattr(args, "promote", False)):
        raise SystemExit(
            "direct --promote is disabled: pipeline may create an audit candidate but never publish it"
        )
    fetch_args = argparse.Namespace(
        start=args.start,
        end=args.end,
        interval=args.interval,
        min_rows=args.min_rows,
        refresh=args.refresh,
    )
    fetch_a_share_history(fetch_args)
    build_features(args)
    train_model(args)
    infer(args)


def refresh_and_infer(args: argparse.Namespace) -> None:
    """Refresh structured inputs, rebuild features, then apply the frozen model."""
    fetch_a_share_history(args)
    build_features(args)
    infer(args)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    fetch = commands.add_parser("fetch", help="download compressed official CSI histories")
    fetch.add_argument("--start", default="2016-01-01")
    fetch.add_argument("--end", default=datetime.now(SHANGHAI).date().isoformat())
    fetch.add_argument("--interval", type=float, default=0.65)
    fetch.add_argument("--min-rows", type=int, default=250)
    fetch.add_argument("--refresh", action="store_true")
    fetch.set_defaults(func=fetch_a_share_history)

    features = commands.add_parser("features", help="build streaming cross-sectional features")
    features.set_defaults(func=build_features)

    train = commands.add_parser("train", help="walk-forward research and write an isolated audit candidate")
    train.add_argument("--ridge", type=float, default=20.0)
    train.add_argument(
        "--candidate-output",
        help="write an isolated artifact under models/sector-rotation/candidates for audit only",
    )
    train.add_argument("--version", help="explicit artifact version (recommended for audited candidates)")
    train.add_argument(
        "--promote",
        action="store_true",
        help="disabled safety trap; training is never allowed to replace the frozen baseline",
    )
    train.set_defaults(func=train_model)

    inference = commands.add_parser("infer", help="apply frozen model only")
    inference.set_defaults(func=infer)

    refresh = commands.add_parser(
        "refresh",
        help="refresh official inputs and features, then apply the frozen model without training",
    )
    refresh.add_argument("--start", default="2016-01-01")
    refresh.add_argument(
        "--end",
        default=daily_brief_session("a-share") or datetime.now(SHANGHAI).date().isoformat(),
    )
    refresh.add_argument("--interval", type=float, default=0.65)
    refresh.add_argument("--min-rows", type=int, default=250)
    refresh.add_argument("--refresh", action="store_true")
    refresh.set_defaults(func=refresh_and_infer)

    events = commands.add_parser("events-append", help="append one compressed, deduplicated event")
    events.add_argument("--input", required=True)
    events.set_defaults(func=append_event)

    event_prune = commands.add_parser("events-prune", help="prune oldest fully evaluated events above 28MB")
    event_prune.set_defaults(func=prune_event_memory)

    full = commands.add_parser("pipeline", help="fetch, feature, train, infer")
    full.add_argument("--start", default="2016-01-01")
    full.add_argument("--end", default=datetime.now(SHANGHAI).date().isoformat())
    full.add_argument("--interval", type=float, default=0.65)
    full.add_argument("--min-rows", type=int, default=250)
    full.add_argument("--refresh", action="store_true")
    full.add_argument("--ridge", type=float, default=20.0)
    full.add_argument(
        "--candidate-output",
        help="write an audit-only artifact under models/sector-rotation/candidates",
    )
    full.add_argument("--version", help="explicit audited candidate version")
    full.add_argument(
        "--promote",
        action="store_true",
        help="disabled safety trap; pipeline is never allowed to replace the frozen baseline",
    )
    full.set_defaults(func=pipeline)
    return root


def main() -> None:
    args = parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
