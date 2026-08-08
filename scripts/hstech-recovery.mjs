import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HSTECH_LAUNCH_DATE = "2020-07-27";
export const HSTECH_MINIMUM_READY_ROWS = 252;
export const HSTECH_SINA_URL = "https://finance.sina.com.cn/stock/hkstock/HSTECH/klc2_kl.js?d=2023_5_01";
export const HSTECH_OFFICIAL_URL = "https://www.hsi.com.hk/eng/indexes/all-indexes/hstech";
export const HSTECH_FACTSHEET_URL = "https://www.hsi.com.hk/static/uploads/contents/en/dl_centre/factsheets/hsteche.pdf";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || value === "--" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validDate(value) {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeHstechBars(rows, { launchDate = HSTECH_LAUNCH_DATE, asOf = null } = {}) {
  const byDate = new Map();
  let invalidDate = 0;
  let preLaunch = 0;
  let invalidOhlc = 0;
  let future = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date ?? row?.time ?? "").slice(0, 10);
    if (!validDate(date)) {
      invalidDate += 1;
      continue;
    }
    if (date < launchDate) {
      preLaunch += 1;
      continue;
    }
    if (asOf && date > asOf) {
      future += 1;
      continue;
    }
    const open = numberOrNull(row?.open);
    const high = numberOrNull(row?.high);
    const low = numberOrNull(row?.low);
    const close = numberOrNull(row?.close);
    const volume = numberOrNull(row?.volume);
    if ([open, high, low, close].some((value) => value === null) || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      invalidOhlc += 1;
      continue;
    }
    byDate.set(date, { time: date, open, high, low, close, volume });
  }
  const bars = [...byDate.values()].sort((left, right) => left.time.localeCompare(right.time));
  return {
    bars,
    counts: { input: Array.isArray(rows) ? rows.length : 0, invalidDate, preLaunch, invalidOhlc, future, duplicates: Math.max(0, (Array.isArray(rows) ? rows.length : 0) - invalidDate - preLaunch - invalidOhlc - future - bars.length) },
    firstDate: bars[0]?.time ?? null,
    lastDate: bars.at(-1)?.time ?? null,
    rows: bars.length,
    status: bars.length >= HSTECH_MINIMUM_READY_ROWS ? "ready" : bars.length ? "partial" : "unavailable",
  };
}

export function validateHstechCache(value, { launchDate = HSTECH_LAUNCH_DATE, asOf = null } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HSTECH cache must be an object");
  if (value.schemaVersion !== "hstech-sina-normalized-v1") throw new Error("HSTECH cache schemaVersion mismatch");
  if (!Array.isArray(value.bars)) throw new Error("HSTECH cache bars must be an array");
  if (value.source?.provider !== "akshare.stock_hk_index_daily_sina") throw new Error("HSTECH cache source must be bounded AKShare Sina");
  if (value.source?.rawPayloadStored === true) throw new Error("raw provider payload must not be stored in normalized cache");
  const normalized = normalizeHstechBars(value.bars, { launchDate, asOf });
  if (!normalized.rows) throw new Error("HSTECH cache has no valid post-launch bars");
  return { ...normalized, source: value.source, sourceFileSha256: sha256(JSON.stringify(value)) };
}

export function loadHstechCache(file, options = {}) {
  const text = fs.readFileSync(file, "utf8");
  const value = JSON.parse(text);
  return { ...validateHstechCache(value, options), file: path.resolve(file) };
}

export function buildHstechSource(cache) {
  return {
    provider: "AKShare stock_hk_index_daily_sina（标准化缓存）",
    sourceId: "akshare_sina_hstech",
    url: HSTECH_SINA_URL,
    delayed: true,
    rawSha256: cache.source?.rawSha256 ?? null,
    normalizedCacheSha256: cache.sourceFileSha256,
    officialIdentity: {
      provider: "Hang Seng Indexes",
      url: HSTECH_OFFICIAL_URL,
      factsheetUrl: HSTECH_FACTSHEET_URL,
      launchDate: HSTECH_LAUNCH_DATE,
      preLaunchBacktestExcluded: true,
      latestCrossCheck: "official identity/launch reference; latest OHLC remains from bounded Sina source",
    },
    crossChecks: {
      eastmoney: { status: "unavailable", sourceId: "eastmoney_124.HSTECH", note: "bounded probe exhausted after two RemoteDisconnected responses; no fallback payload was fabricated" },
      recent20TradingDays: { status: "not_run_provider_unavailable", overlapRows: null },
    },
    note: "仅保留 >= 2020-07-27 的真实 post-launch OHLC；未使用 ETF 03032、插值、成分股重建或 launch 前回测。AKShare 仅用于有界获取，生产路径读取稳定私有标准化缓存，不每日动态安装。",
  };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const moduleFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const file = argument("--cache");
    if (!file) throw new Error("usage: node scripts/hstech-recovery.mjs --cache <normalized-cache.json>");
    const result = loadHstechCache(path.resolve(file), { asOf: argument("--as-of") });
    console.log(JSON.stringify({ schemaVersion: "hstech-recovery-validation-v1", file: result.file, rows: result.rows, firstDate: result.firstDate, lastDate: result.lastDate, status: result.status, counts: result.counts, source: buildHstechSource(result) }, null, 2));
    if (result.status !== "ready") process.exitCode = 1;
  } catch (error) {
    console.error(`HSTECH_RECOVERY_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
