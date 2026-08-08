import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildHstechSource, HSTECH_LAUNCH_DATE, loadHstechCache } from "./hstech-recovery.mjs";

const SCHEMA_VERSION = "public-market-history-v1";
const MINIMUM_READY_ROWS = 252;
const DEFAULT_SOURCE_CACHE = path.resolve(process.cwd(), "..", "..", "temp", "market-history-source-cache-20260807");
const DEFAULT_RESEARCH_CACHE = "D:\\Guanchao-Workspace\\temp\\stage2-data-cache";
const DEFAULT_HSTECH_CACHE = "D:\\Guanchao-Workspace\\runtime\\market-history-cache\\hstech\\sina-normalized.json";

const instruments = [
  { id: "sse-composite", market: "a-share", slug: "sse-composite", label: "上证指数", currency: "点", timezone: "Asia/Shanghai", sourceType: "tencent", sourceId: "tencent_sse_composite", providerSymbol: "sh000001" },
  { id: "szse-component", market: "a-share", slug: "szse-component", label: "深证成指", currency: "点", timezone: "Asia/Shanghai", sourceType: "tencent", sourceId: "tencent_szse_component", providerSymbol: "sz399001" },
  { id: "chinext", market: "a-share", slug: "chinext", label: "创业板指", currency: "点", timezone: "Asia/Shanghai", sourceType: "tencent", sourceId: "tencent_chinext", providerSymbol: "sz399006" },
  { id: "hang-seng", market: "hk", slug: "hang-seng", label: "恒生指数", currency: "点", timezone: "Asia/Hong_Kong", sourceType: "yahoo", sourceId: "yahoo_hsi", providerSymbol: "^HSI" },
  { id: "hang-seng-china-enterprises", market: "hk", slug: "hang-seng-china-enterprises", label: "国企指数", currency: "点", timezone: "Asia/Hong_Kong", sourceType: "yahoo", sourceId: "yahoo_hscei", providerSymbol: "^HSCE" },
  { id: "hang-seng-tech", market: "hk", slug: "hang-seng-tech", label: "恒生科技", currency: "点", timezone: "Asia/Hong_Kong", sourceType: "hstech-sina-cache", sourceId: "akshare_sina_hstech", providerSymbol: "HSTECH" },
  { id: "sp500", market: "us", slug: "sp500", label: "标普500", currency: "点", timezone: "America/New_York", sourceType: "yahoo", sourceId: "yahoo_sp500", providerSymbol: "^GSPC" },
  { id: "nasdaq-composite", market: "us", slug: "nasdaq-composite", label: "纳斯达克综合", currency: "点", timezone: "America/New_York", sourceType: "yahoo", sourceId: "yahoo_nasdaq_composite", providerSymbol: "^IXIC" },
  { id: "dow-jones", market: "us", slug: "dow-jones", label: "道琼斯", currency: "点", timezone: "America/New_York", sourceType: "yahoo", sourceId: "yahoo_dow_jones", providerSymbol: "^DJI" },
];

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

const sourceCache = path.resolve(argument("--source-cache", DEFAULT_SOURCE_CACHE));
const researchCache = argument("--research-cache", DEFAULT_RESEARCH_CACHE);
const hstechCache = path.resolve(argument("--hstech-cache", DEFAULT_HSTECH_CACHE));
const outputRoot = path.resolve(argument("--output-root", path.resolve(process.cwd(), "public", "data", "market-history")));
const shouldWrite = process.argv.includes("--write");
const shouldFetch = process.argv.includes("--fetch");
const only = argument("--only");
const generatedAt = argument("--generated-at", "2026-08-07T00:00:00+08:00");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "" || value === "--" || value === "-") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dateFromTimestamp(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp * 1000));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function sourceFileCandidates(base, sourceId) {
  return [
    path.join(base, "raw", sourceId, "payload.json"),
    path.join(base, "raw", sourceId, "payload.txt"),
  ];
}

async function readFirstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      return { path: candidate, text: await readFile(candidate, "utf8") };
    } catch {
      // Try the next explicitly provided cache location.
    }
  }
  return null;
}

async function cacheFetched(sourceId, url) {
  const target = path.join(sourceCache, "raw", sourceId, "payload.json");
  const existing = await readFirstExisting([target]);
  if (existing) return existing;
  if (!shouldFetch) return null;
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 GuanchaoMarketHistory/1.0", Accept: "application/json" } });
  if (!response.ok) throw new Error(`${sourceId} HTTP ${response.status}`);
  const text = await response.text();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
  return { path: target, text };
}

async function loadSource(sourceId, url) {
  return (await readFirstExisting(sourceFileCandidates(sourceCache, sourceId)))
    ?? (await readFirstExisting(sourceFileCandidates(researchCache, sourceId)))
    ?? (await cacheFetched(sourceId, url));
}

async function loadBaidu(instrument) {
  const url = `https://finance.pae.baidu.com/selfselect/getstockquotation?all=1&isIndex=true&isBk=false&isBlock=false&isFutures=false&isStock=false&newFormat=1&group=quotation_kline_ab&finClientType=pc&code=${instrument.providerSymbol}&start_time=&ktype=1`;
  const cached = await loadSource(instrument.sourceId, url);
  if (!cached) throw new Error(`${instrument.sourceId} 缺少缓存；使用 --fetch 获取公开日K源`);
  const raw = JSON.parse(cached.text);
  const market = raw?.Result?.newMarketData;
  const keys = Array.isArray(market?.keys) ? market.keys : [];
  const rows = typeof market?.marketData === "string" ? market.marketData.split(";").filter(Boolean) : [];
  const indexByKey = new Map(keys.map((key, index) => [key, index]));
  const bars = rows.map((row) => row.split(",")).map((values) => ({
    time: values[indexByKey.get("time")] ?? "",
    open: numberOrNull(values[indexByKey.get("open")]),
    high: numberOrNull(values[indexByKey.get("high")]),
    low: numberOrNull(values[indexByKey.get("low")]),
    close: numberOrNull(values[indexByKey.get("close")]),
    volume: numberOrNull(values[indexByKey.get("volume")]),
  }));
  return { bars, rawSha256: sha256(cached.text), url, provider: "百度股市通公开指数日K", note: "公开收盘日K接口；页面只使用标准化派生数据，原始 provider payload 保留在 worktree 外私有缓存。" };
}

async function loadTencent(instrument) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${instrument.providerSymbol},day,2023-01-01,2026-08-07,600,qfq`;
  const cached = await loadSource(instrument.sourceId, url);
  if (!cached) throw new Error(`${instrument.sourceId} 缺少缓存；使用 --fetch 获取公开日K源`);
  const raw = JSON.parse(cached.text);
  const rows = raw?.data?.[instrument.providerSymbol]?.day ?? [];
  return {
    bars: rows.map((row) => ({ time: row[0], open: numberOrNull(row[1]), close: numberOrNull(row[2]), high: numberOrNull(row[3]), low: numberOrNull(row[4]), volume: numberOrNull(row[5]) })),
    rawSha256: sha256(cached.text),
    url,
    provider: "腾讯财经历史日K",
    note: "公开收盘日K接口；页面只使用标准化派生数据，原始 provider payload 保留在 worktree 外私有缓存。",
  };
}

async function loadYahoo(instrument) {
  const encodedSymbol = encodeURIComponent(instrument.providerSymbol);
  const period1 = Math.floor(Date.parse("2023-01-01T00:00:00Z") / 1000);
  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?period1=${period1}&period2=${period2}&interval=1d&events=history`;
  const cached = await loadSource(instrument.sourceId, url);
  if (!cached) throw new Error(`${instrument.sourceId} 缺少缓存；使用 --fetch 获取研究源`);
  const raw = JSON.parse(cached.text);
  if (Array.isArray(raw?.rows)) {
    return {
      bars: raw.rows.map((row) => ({ time: row.date, open: numberOrNull(row.open), high: numberOrNull(row.high), low: numberOrNull(row.low), close: numberOrNull(row.close), volume: numberOrNull(row.volume) })),
      rawSha256: sha256(cached.text),
      url,
      provider: "Yahoo Finance chart API（研究缓存派生）",
      note: instrument.id === "hang-seng-tech" ? "仅保留来源实际返回的 post-launch 观测；未做历史回填，少于一年时明确降级。" : "原始 provider payload 仅留在 worktree 外私有研究缓存；Git 仅保留标准化派生行情面板。",
    };
  }
  const result = raw?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const bars = timestamps.map((timestamp, index) => ({
    time: dateFromTimestamp(timestamp, instrument.timezone),
    open: numberOrNull(quote.open?.[index]),
    high: numberOrNull(quote.high?.[index]),
    low: numberOrNull(quote.low?.[index]),
    close: numberOrNull(quote.close?.[index]),
    volume: numberOrNull(quote.volume?.[index]),
  }));
  return { bars, rawSha256: sha256(cached.text), url, provider: "Yahoo Finance chart API（研究缓存派生）", note: instrument.id === "hang-seng-tech" ? "仅保留来源实际返回的 post-launch 观测；未做历史回填，少于一年时明确降级。" : "原始 provider payload 仅留在 worktree 外私有研究缓存；Git 仅保留标准化派生行情面板。" };
}

async function loadHstechSina(instrument) {
  const cache = loadHstechCache(hstechCache, { asOf: generatedAt.slice(0, 10) });
  return {
    bars: cache.bars,
    rawSha256: cache.source?.rawSha256 ?? cache.sourceFileSha256,
    url: "https://finance.sina.com.cn/stock/hkstock/HSTECH/klc2_kl.js?d=2023_5_01",
    provider: "AKShare stock_hk_index_daily_sina（标准化缓存）",
    source: buildHstechSource(cache),
    note: `真实 post-launch HSTECH 日K；正式过滤日期 >= ${HSTECH_LAUNCH_DATE}，生产路径不动态安装 AKShare。`,
  };
}

function normalizeBars(bars) {
  const byDate = new Map();
  bars.forEach((bar) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.time)) return;
    if ([bar.open, bar.high, bar.low, bar.close].some((value) => value === null || !Number.isFinite(value))) return;
    if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) return;
    byDate.set(bar.time, { time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume === null || Number.isFinite(bar.volume) ? bar.volume : null });
  });
  return [...byDate.values()].sort((left, right) => left.time.localeCompare(right.time));
}

function publicInstrument(instrument) {
  return { id: instrument.id, market: instrument.market, slug: instrument.slug, label: instrument.label, currency: instrument.currency, timezone: instrument.timezone };
}

function documentFor(instrument, source) {
  const bars = normalizeBars(source?.bars ?? []);
  const status = source?.status ?? (bars.length >= MINIMUM_READY_ROWS ? "ready" : bars.length ? "partial" : "unavailable");
  return {
    schemaVersion: SCHEMA_VERSION,
    instrument: publicInstrument(instrument),
    status,
    asOf: bars.at(-1)?.time ?? null,
    source: source?.source ?? { provider: "暂无可用来源", url: null, delayed: true, note: "来源失败或尚未注册；没有使用 fixture、零值或未经标记的回填。" },
    bars,
  };
}

async function buildDocument(instrument) {
  if (instrument.sourceType === "unavailable") return documentFor(instrument, { source: { provider: "暂无可用来源", url: null, delayed: true, note: "恒生综合没有经过来源审计的可用历史接口；页面保留真实 unavailable 状态，不用其他指数替代。" }, status: "unavailable" });
  try {
    const loaded = instrument.sourceType === "tencent" ? await loadTencent(instrument) : instrument.sourceType === "baidu" ? await loadBaidu(instrument) : instrument.sourceType === "hstech-sina-cache" ? await loadHstechSina(instrument) : await loadYahoo(instrument);
    return documentFor(instrument, { bars: loaded.bars, source: loaded.source ?? { provider: loaded.provider, url: loaded.url, delayed: true, note: loaded.note, rawSha256: loaded.rawSha256 } });
  } catch (error) {
    const provider = instrument.sourceType === "tencent" ? "腾讯财经历史日K" : instrument.sourceType === "baidu" ? "百度股市通公开指数日K" : instrument.sourceType === "hstech-sina-cache" ? "AKShare stock_hk_index_daily_sina（标准化缓存）" : "Yahoo Finance chart API（研究源）";
    const url = instrument.sourceType === "hstech-sina-cache" ? "https://finance.sina.com.cn/stock/hkstock/HSTECH/klc2_kl.js?d=2023_5_01" : instrument.providerSymbol ? instrument.sourceType === "tencent" ? `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${instrument.providerSymbol},day` : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(instrument.providerSymbol)}` : null;
    return documentFor(instrument, { source: { provider, url, delayed: true, note: `来源失败，已真实降级为 unavailable：${error instanceof Error ? error.message : String(error)}` }, status: "unavailable" });
  }
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function readExistingDocument(instrument) {
  try {
    return JSON.parse(await readFile(path.join(outputRoot, `${instrument.id}.json`), "utf8"));
  } catch {
    return null;
  }
}

function retainPriorHistoryOnFailure(document, previous) {
  if (document.bars.length > 0 || !Array.isArray(previous?.bars) || previous.bars.length === 0) return document;
  return {
    ...previous,
    status: "stale",
    source: {
      ...document.source,
      note: `${document.source.note ?? "来源失败。"} 本次刷新未获得有效结果，已保留上一份已验证历史并标记 stale。`,
    },
  };
}

async function writeIfChanged(target, contents) {
  try {
    if (await readFile(target, "utf8") === contents) return false;
  } catch {
    // The target does not exist yet.
  }
  await writeFile(target, contents, "utf8");
  return true;
}

async function main() {
  const selectedInstruments = only ? instruments.filter((instrument) => instrument.id === only || instrument.slug === only) : instruments;
  if (only && selectedInstruments.length === 0) throw new Error(`unknown instrument for --only: ${only}`);
  const documentById = new Map();
  for (const instrument of instruments) {
    const previous = await readExistingDocument(instrument);
    if (!selectedInstruments.includes(instrument)) {
      if (previous) documentById.set(instrument.id, previous);
      continue;
    }
    const document = await buildDocument(instrument);
    documentById.set(instrument.id, retainPriorHistoryOnFailure(document, previous));
  }
  const documents = instruments.map((instrument) => documentById.get(instrument.id)).filter(Boolean);
  const index = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt,
    targetYears: 3,
    minimumReadyRows: MINIMUM_READY_ROWS,
    instruments: documents.map((document) => ({
      instrument: document.instrument,
      path: `${document.instrument.id}.json`,
      status: document.status,
      asOf: document.asOf,
      source: document.source,
      rowCount: document.bars.length,
      firstDate: document.bars[0]?.time ?? null,
      lastDate: document.bars.at(-1)?.time ?? null,
    })),
  };
  console.log(JSON.stringify({ mode: shouldWrite ? "write" : "dry-run", only, sourceCache, researchCache, hstechCache, outputRoot, instruments: index.instruments.map((entry) => ({ id: entry.instrument.id, rows: entry.rowCount, firstDate: entry.firstDate, lastDate: entry.lastDate, status: entry.status })) }, null, 2));
  if (!shouldWrite) return;
  await mkdir(outputRoot, { recursive: true });
  await writeIfChanged(path.join(outputRoot, "index.json"), json(index));
  await Promise.all(selectedInstruments.map((instrument) => writeIfChanged(path.join(outputRoot, `${instrument.id}.json`), json(documentById.get(instrument.id)))));
}

await main();
