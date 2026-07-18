import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const schemaPath = path.resolve(root, "models", "sector-rotation", "event-memory.schema.json");
const samplePath = path.resolve(root, "models", "sector-rotation", "event-memory.sample.jsonl");
const seedPath = path.resolve(root, "models", "sector-rotation", "long-money-events.seed.jsonl");
const calendarPath = path.resolve(root, "models", "sector-rotation", "cn-market-calendar-2026.json");
const eventPath = path.resolve(root, "data", "rotation-model", "events", "events.jsonl.gz");
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const PRUNE_AT_BYTES = 28 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024;
const MAX_EVENTS = 15_000;
const errors = [];
const seenHashes = new Set();
const seenEventKeys = new Set();
let aShareCalendar = null;
let aShareCalendarSha256 = null;
const sourceTiers = new Set(["official", "authoritative", "major-media"]);
const evidenceClasses = new Set([
  "official-primary",
  "company-filing",
  "primary-research",
  "exchange-market-data",
  "vendor-market-data",
  "vendor-estimate",
  "major-media",
  "proxy",
]);
const eventTypes = new Set([
  "policy",
  "macro",
  "earnings",
  "guidance",
  "regulation",
  "corporate-action",
  "institution-view",
  "market-structure",
  "long-term-capital-disclosure",
  "other",
]);
const eventKeys = new Set([
  "schemaVersion",
  "date",
  "title",
  "sourceUrl",
  "corroboratingSourceUrls",
  "sourceTier",
  "evidenceClass",
  "sectorTags",
  "eventType",
  "factSummary",
  "knownAt",
  "truthAt",
  "truthSourceUrl",
  "scenario",
  "capitalActor",
  "observationMode",
  "alternativeExplanations",
  "invalidation",
  "proxyEvaluation",
  "extraction",
  "forward5dOutcome",
  "forward20dOutcome",
  "contentHash",
]);

function fail(message) {
  errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isObject(value)) return false;
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) fail(`${label} 含未定义字段：${extras.join(", ")}`);
  return extras.length === 0;
}

function requireString(value, label, { min = 1, max = Infinity } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} 必须是非空字符串`);
    return false;
  }
  if (value.length < min || value.length > max) fail(`${label} 长度必须为 ${min}–${max} 字符`);
  return true;
}

function requireDate(value, label) {
  const parsed = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : null;
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}$/.test(value)
    || !parsed
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    fail(`${label} 必须是 YYYY-MM-DD 日期`);
    return false;
  }
  return true;
}

function requireIso(value, label) {
  if (!requireString(value, label) || Number.isNaN(Date.parse(value))) {
    fail(`${label} 必须是带时区的 ISO 时间`);
    return false;
  }
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(value)) fail(`${label} 必须显式带时区`);
  const match = typeof value === "string" ? value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/) : null;
  if (!match || !requireDate(match[1], `${label} 日期部分`) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    fail(`${label} 含不可能的日期或时间分量`);
    return false;
  }
  return true;
}

function validateHttps(value, label) {
  if (!requireString(value, label, { max: 600 })) return;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") fail(`${label} 必须是 HTTPS 直达页`);
    if (/google\.[^/]+$/i.test(url.hostname) && url.pathname.includes("/search")) fail(`${label} 不能是搜索结果页`);
  } catch {
    fail(`${label} 不是有效网址`);
  }
}

function shanghaiDate(value) {
  const instant = typeof value === "string" ? new Date(value) : null;
  if (!instant || Number.isNaN(instant.getTime())) return "";
  // China Standard Time has no DST; adding eight hours before slicing keeps
  // this validator deterministic even when the host timezone changes.
  return new Date(instant.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function validateOutcome(outcome, knownAt, expectedSessions, label) {
  if (outcome === null) return;
  if (!isObject(outcome)) {
    fail(`${label} 必须是 null 或后验对象`);
    return;
  }
  exactKeys(outcome, new Set(["baseDate", "dueDate", "sessions", "tradingDates", "calendarSourceUrl", "calendarSha256", "market", "targetCode", "benchmarkCode", "returnType", "startClose", "endClose", "benchmarkStartClose", "benchmarkEndClose", "relativeReturnPct", "priceSourceUrls", "inputSha256", "measuredAt", "status"]), label);
  requireDate(outcome.baseDate, `${label}.baseDate`);
  requireDate(outcome.dueDate, `${label}.dueDate`);
  const knownDate = shanghaiDate(knownAt);
  if (typeof outcome.baseDate === "string" && outcome.baseDate > knownDate) fail(`${label}.baseDate 不得晚于公众已知日期`);
  if (typeof outcome.dueDate === "string" && outcome.dueDate <= knownDate) fail(`${label}.dueDate 必须晚于公众已知日期`);
  if (outcome.sessions !== expectedSessions) fail(`${label}.sessions 必须是 ${expectedSessions}`);
  if (!Array.isArray(outcome.tradingDates) || outcome.tradingDates.length !== expectedSessions) {
    fail(`${label}.tradingDates 必须逐项列出恰好 ${expectedSessions} 个官方完整交易日`);
  } else {
    outcome.tradingDates.forEach((tradingDate, index) => {
      requireDate(tradingDate, `${label}.tradingDates[${index}]`);
      if (typeof tradingDate === "string" && tradingDate <= knownDate) fail(`${label}.tradingDates[${index}] 必须晚于公众已知日期`);
      if (typeof tradingDate === "string" && [0, 6].includes(new Date(`${tradingDate}T00:00:00Z`).getUTCDay())) fail(`${label}.tradingDates[${index}] 不得是周末`);
      if (index > 0 && tradingDate <= outcome.tradingDates[index - 1]) fail(`${label}.tradingDates 必须严格升序且不得重复`);
    });
    if (outcome.tradingDates.at(-1) !== outcome.dueDate) fail(`${label}.dueDate 必须等于第 ${expectedSessions} 个 tradingDates`);
  }
  validateHttps(outcome.calendarSourceUrl, `${label}.calendarSourceUrl`);
  if (typeof outcome.calendarSha256 !== "string" || !/^[a-f0-9]{64}$/.test(outcome.calendarSha256)) fail(`${label}.calendarSha256 必须是 64 位小写 SHA-256`);
  if (outcome.market !== "a-share") fail(`${label}.market 目前必须是 a-share；港股需先提供版本化港交所日历`);
  if (outcome.market === "a-share" && aShareCalendar) {
    if (outcome.calendarSha256 !== aShareCalendarSha256) fail(`${label}.calendarSha256 与版本化 A 股交易日历不一致`);
    if (outcome.calendarSourceUrl !== aShareCalendar.sourceUrl) fail(`${label}.calendarSourceUrl 与版本化 A 股交易日历来源不一致`);
    if (aShareCalendar.market !== "A-share" || aShareCalendar.timezone !== "Asia/Shanghai") fail(`${label} 使用的 A 股交易日历元数据非法`);
    if (Number(knownDate.slice(0, 4)) !== aShareCalendar.year) {
      fail(`${label}.knownAt 不在当前版本化 A 股交易日历年份内`);
    } else {
      const closedWeekdays = new Set(aShareCalendar.closedWeekdays ?? []);
      const expected = [];
      const cursor = new Date(`${knownDate}T00:00:00Z`);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      while (expected.length < expectedSessions && cursor.getUTCFullYear() === aShareCalendar.year) {
        const day = cursor.getUTCDay();
        const value = cursor.toISOString().slice(0, 10);
        if (day !== 0 && day !== 6 && !closedWeekdays.has(value)) expected.push(value);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      if (expected.length !== expectedSessions || JSON.stringify(outcome.tradingDates) !== JSON.stringify(expected)) {
        fail(`${label}.tradingDates 与版本化日历中的后续 ${expectedSessions} 个交易日不一致`);
      }
    }
  }
  requireString(outcome.targetCode, `${label}.targetCode`, { max: 30 });
  requireString(outcome.benchmarkCode, `${label}.benchmarkCode`, { max: 30 });
  if (outcome.returnType !== "simple-close-relative") fail(`${label}.returnType 必须是 simple-close-relative`);
  for (const field of ["startClose", "endClose", "benchmarkStartClose", "benchmarkEndClose"]) {
    if (!Number.isFinite(outcome[field]) || outcome[field] <= 0) fail(`${label}.${field} 必须是正的有限收盘值`);
  }
  if (!Number.isFinite(outcome.relativeReturnPct)) fail(`${label}.relativeReturnPct 必须是有限数值`);
  if (["startClose", "endClose", "benchmarkStartClose", "benchmarkEndClose"].every((field) => Number.isFinite(outcome[field]) && outcome[field] > 0)) {
    const recomputed = ((outcome.endClose / outcome.startClose - 1) - (outcome.benchmarkEndClose / outcome.benchmarkStartClose - 1)) * 100;
    if (!Number.isFinite(outcome.relativeReturnPct) || Math.abs(outcome.relativeReturnPct - recomputed) > 0.011) fail(`${label}.relativeReturnPct 与四个收盘值重算结果不一致`);
  }
  if (!Array.isArray(outcome.priceSourceUrls) || outcome.priceSourceUrls.length < 1 || outcome.priceSourceUrls.length > 3 || new Set(outcome.priceSourceUrls).size !== outcome.priceSourceUrls.length) {
    fail(`${label}.priceSourceUrls 必须包含 1–3 个不重复直达来源`);
  } else outcome.priceSourceUrls.forEach((url, index) => validateHttps(url, `${label}.priceSourceUrls[${index}]`));
  if (typeof outcome.inputSha256 !== "string" || !/^[a-f0-9]{64}$/.test(outcome.inputSha256)) fail(`${label}.inputSha256 必须是 64 位小写 SHA-256`);
  requireIso(outcome.measuredAt, `${label}.measuredAt`);
  if (
    typeof outcome.dueDate === "string"
    && typeof outcome.measuredAt === "string"
    && !Number.isNaN(Date.parse(outcome.measuredAt))
    && Date.parse(outcome.measuredAt) < Date.parse(`${outcome.dueDate}T00:00:00+08:00`)
  ) fail(`${label}.measuredAt 不得早于 dueDate`);
  if (!["confirmed", "partial", "invalidated", "neutral"].includes(outcome.status)) fail(`${label}.status 非法`);
}

function canonicalEventHash(event) {
  const canonical = [event.date, event.sourceUrl, event.eventType, event.factSummary].join("\u0000");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validateStringArray(value, label, { min = 0, max, itemMax }) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    fail(`${label} 必须包含 ${min}–${max} 项`);
    return;
  }
  const unique = new Set();
  value.forEach((item, index) => {
    requireString(item, `${label}[${index}]`, { max: itemMax });
    if (typeof item === "string") {
      const key = item.trim().toLowerCase();
      if (unique.has(key)) fail(`${label} 含重复项 ${item}`);
      unique.add(key);
    }
  });
}

function validateEvent(event, label) {
  if (!isObject(event)) {
    fail(`${label} 必须是 JSON 对象`);
    return;
  }
  exactKeys(event, eventKeys, label);
  if (event.schemaVersion !== 1) fail(`${label}.schemaVersion 必须是 1`);
  requireDate(event.date, `${label}.date`);
  requireString(event.title, `${label}.title`, { min: 4, max: 120 });
  validateHttps(event.sourceUrl, `${label}.sourceUrl`);
  if (event.corroboratingSourceUrls !== undefined) {
    if (!Array.isArray(event.corroboratingSourceUrls) || event.corroboratingSourceUrls.length > 5) fail(`${label}.corroboratingSourceUrls 最多 5 项`);
    else {
      const links = new Set();
      event.corroboratingSourceUrls.forEach((url, index) => {
        validateHttps(url, `${label}.corroboratingSourceUrls[${index}]`);
        if (links.has(url)) fail(`${label}.corroboratingSourceUrls 含重复链接`);
        links.add(url);
      });
    }
  }
  if (!sourceTiers.has(event.sourceTier)) fail(`${label}.sourceTier 非法`);
  if (!evidenceClasses.has(event.evidenceClass)) fail(`${label}.evidenceClass 非法`);
  validateStringArray(event.sectorTags, `${label}.sectorTags`, { min: 1, max: 12, itemMax: 30 });
  if (!eventTypes.has(event.eventType)) fail(`${label}.eventType 非法`);
  // 目标是 100–200 字；给标点、英文与已有迁移样本保留小幅边界，但拒绝短句和长文。
  requireString(event.factSummary, `${label}.factSummary`, { min: 60, max: 220 });
  requireIso(event.knownAt, `${label}.knownAt`);
  if (
    typeof event.date === "string"
    && typeof event.knownAt === "string"
    && !Number.isNaN(Date.parse(event.knownAt))
    && Date.parse(event.knownAt) < Date.parse(`${event.date}T00:00:00+08:00`)
  ) fail(`${label}.knownAt 不得早于事件日期`);
  if (!["positive", "negative", "mixed", "neutral"].includes(event.scenario)) fail(`${label}.scenario 非法`);
  if (event.truthAt !== undefined) {
    requireIso(event.truthAt, `${label}.truthAt`);
    if (
      typeof event.knownAt === "string"
      && !Number.isNaN(Date.parse(event.knownAt))
      && !Number.isNaN(Date.parse(event.truthAt))
      && Date.parse(event.truthAt) < Date.parse(event.knownAt)
    ) fail(`${label}.truthAt 不得早于 knownAt，防止事后真值穿越`);
  }
  if (event.truthSourceUrl !== undefined) validateHttps(event.truthSourceUrl, `${label}.truthSourceUrl`);
  if ((event.truthAt === undefined) !== (event.truthSourceUrl === undefined)) fail(`${label}.truthAt 与 truthSourceUrl 必须成对出现`);

  if (event.capitalActor !== undefined && ![
    "central-huijin",
    "csf",
    "national-social-security-fund",
    "basic-pension-fund",
  ].includes(event.capitalActor)) fail(`${label}.capitalActor 非法`);
  if (event.observationMode !== undefined && !["disclosed-fact", "retrospective-label", "inference-proxy"].includes(event.observationMode)) fail(`${label}.observationMode 非法`);
  if (event.eventType === "long-term-capital-disclosure" && (event.capitalActor === undefined || event.observationMode === undefined)) fail(`${label} 长期资金事件必须填写 capitalActor 与 observationMode`);
  if (event.eventType !== "long-term-capital-disclosure" && (event.capitalActor !== undefined || event.observationMode !== undefined || event.proxyEvaluation !== undefined)) fail(`${label} 非长期资金事件不得填写 capitalActor、observationMode 或 proxyEvaluation`);
  if (event.alternativeExplanations !== undefined) validateStringArray(event.alternativeExplanations, `${label}.alternativeExplanations`, { min: 1, max: 5, itemMax: 120 });
  if (event.invalidation !== undefined) requireString(event.invalidation, `${label}.invalidation`, { max: 180 });
  if (event.observationMode === "inference-proxy") {
    if (!Array.isArray(event.alternativeExplanations) || event.alternativeExplanations.length < 1) fail(`${label} 长期资金代理必须写 alternativeExplanations`);
    requireString(event.invalidation, `${label}.invalidation`, { max: 180 });
    if (/(已买入|正在买入|偷偷买入|确定买入|确认流入)/.test(`${event.title}${event.factSummary}`)) fail(`${label} 代理线索不得写成长期资金已买入事实`);
  }

  if (event.proxyEvaluation !== undefined) {
    if (!isObject(event.proxyEvaluation)) fail(`${label}.proxyEvaluation 必须是对象`);
    else {
      exactKeys(event.proxyEvaluation, new Set(["status", "signals", "leadTradingDays", "note"]), `${label}.proxyEvaluation`);
      if (!["hit", "false-positive", "partial", "not-evaluable"].includes(event.proxyEvaluation.status)) fail(`${label}.proxyEvaluation.status 非法`);
      const proxySignals = new Set(["etf-subscription-redemption", "broad-index-turnover-share", "heavyweight-relative-strength", "closing-auction-concentration"]);
      if (!Array.isArray(event.proxyEvaluation.signals) || event.proxyEvaluation.signals.length < 1 || event.proxyEvaluation.signals.length > 4) fail(`${label}.proxyEvaluation.signals 必须包含 1–4 项`);
      else {
        if (new Set(event.proxyEvaluation.signals).size !== event.proxyEvaluation.signals.length) fail(`${label}.proxyEvaluation.signals 不得重复`);
        event.proxyEvaluation.signals.forEach((signal) => { if (!proxySignals.has(signal)) fail(`${label}.proxyEvaluation.signals 含非法代理 ${signal}`); });
      }
      if (event.proxyEvaluation.leadTradingDays !== undefined && (!Number.isInteger(event.proxyEvaluation.leadTradingDays) || event.proxyEvaluation.leadTradingDays < 0 || event.proxyEvaluation.leadTradingDays > 250)) fail(`${label}.proxyEvaluation.leadTradingDays 必须是 0–250 的交易日整数`);
      requireString(event.proxyEvaluation.note, `${label}.proxyEvaluation.note`, { min: 4, max: 180 });
      if (["hit", "partial"].includes(event.proxyEvaluation.status) && (event.truthAt === undefined || event.truthSourceUrl === undefined)) fail(`${label} 命中/部分命中必须保留 truthAt 与 truthSourceUrl`);
    }
  }

  if (event.extraction !== undefined) {
    if (!isObject(event.extraction)) fail(`${label}.extraction 必须是对象`);
    else {
      exactKeys(event.extraction, new Set(["mode", "confidence", "sourceUrl", "unit", "scope", "period"]), `${label}.extraction`);
      if (!["html-structured", "manual-verified", "ocr-structured"].includes(event.extraction.mode)) fail(`${label}.extraction.mode 非法`);
      if (!Number.isFinite(event.extraction.confidence) || event.extraction.confidence < 0 || event.extraction.confidence > 1) fail(`${label}.extraction.confidence 必须在 0–1`);
      if (event.extraction.mode === "ocr-structured" && event.extraction.confidence < 0.9) fail(`${label} 低于 0.90 的 OCR 数字不得进入轮动事件记忆`);
      if (event.extraction.sourceUrl !== undefined) validateHttps(event.extraction.sourceUrl, `${label}.extraction.sourceUrl`);
      if (event.extraction.unit !== undefined) requireString(event.extraction.unit, `${label}.extraction.unit`, { max: 40 });
      if (event.extraction.scope !== undefined) requireString(event.extraction.scope, `${label}.extraction.scope`, { max: 160 });
      if (event.extraction.period !== undefined) requireString(event.extraction.period, `${label}.extraction.period`, { max: 80 });
    }
  }

  validateOutcome(event.forward5dOutcome, event.knownAt, 5, `${label}.forward5dOutcome`);
  validateOutcome(event.forward20dOutcome, event.knownAt, 20, `${label}.forward20dOutcome`);
  if (typeof event.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(event.contentHash)) fail(`${label}.contentHash 必须是 64 位小写 SHA-256`);
  else if (event.contentHash !== canonicalEventHash(event)) fail(`${label}.contentHash 与规范化事实字段不一致`);
  else if (seenHashes.has(event.contentHash)) fail(`${label} 与已有事件 contentHash 重复`);
  else seenHashes.add(event.contentHash);

  if (typeof event.date === "string" && typeof event.sourceUrl === "string" && typeof event.eventType === "string") {
    const eventKey = `${event.date}\u0000${event.sourceUrl.replace(/[?#].*$/, "")}\u0000${event.eventType}`.toLowerCase();
    if (seenEventKeys.has(eventKey)) fail(`${label} 与已有事件的日期、规范化 URL、事件分类重复`);
    else seenEventKeys.add(eventKey);
  }
}

async function validateJsonLines(filePath, { gzip, optional, label }) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (optional && error.code === "ENOENT") return { count: 0, bytes: 0, missing: true };
    throw error;
  }
  if (gzip && info.size > MAX_COMPRESSED_BYTES) fail(`${label} 压缩体积 ${info.size} 字节超过 32 MB 硬上限`);
  const input = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const stream = gzip ? input.pipe(createGunzip({ chunkSize: 64 * 1024 })) : input;
  let decompressedBytes = 0;
  let count = 0;
  stream.on("data", (chunk) => {
    decompressedBytes += chunk.length;
    if (decompressedBytes > MAX_DECOMPRESSED_BYTES) stream.destroy(new Error("解压后事件库超过 128 MB 上限"));
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    count += 1;
    if (count > MAX_EVENTS) {
      fail(`${label} 超过 ${MAX_EVENTS} 条事件上限`);
      break;
    }
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      fail(`${label}:${count} 单条解压后超过 8 KB`);
      continue;
    }
    try {
      validateEvent(JSON.parse(line), `${label}:${count}`);
    } catch (error) {
      fail(`${label}:${count} JSON 解析失败：${error.message}`);
    }
  }
  return { count, bytes: info.size, missing: false };
}

let sampleResult;
let seedResult;
let eventResult;
try {
  JSON.parse(await readFile(schemaPath, "utf8"));
  const calendarRaw = await readFile(calendarPath);
  aShareCalendar = JSON.parse(calendarRaw.toString("utf8"));
  aShareCalendarSha256 = createHash("sha256").update(calendarRaw).digest("hex");
  sampleResult = await validateJsonLines(samplePath, { gzip: false, optional: false, label: "event-memory.sample.jsonl" });
  // 每个分发文件独立校验去重；seed 与本机初始化内容可以相同。
  seenHashes.clear();
  seenEventKeys.clear();
  seedResult = await validateJsonLines(seedPath, { gzip: false, optional: false, label: "long-money-events.seed.jsonl" });
  seenHashes.clear();
  seenEventKeys.clear();
  eventResult = await validateJsonLines(eventPath, { gzip: true, optional: true, label: "events.jsonl.gz" });
} catch (error) {
  console.error(`事件记忆无法读取或流式校验：${error.message}`);
  process.exit(1);
}

if (eventResult.bytes >= PRUNE_AT_BYTES) {
  console.warn(`事件记忆已达到 ${(eventResult.bytes / 1024 / 1024).toFixed(1)} MB，应先按最旧且已完成后验的记录清理，再继续追加。`);
}

if (errors.length) {
  console.error(`\n轮动事件记忆校验失败（${errors.length} 项）：`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

console.log(`轮动事件记忆校验通过：样例 ${sampleResult.count} 条；长期资金种子 ${seedResult.count} 条；本机事件 ${eventResult.missing ? "未初始化" : `${eventResult.count} 条 / ${(eventResult.bytes / 1024 / 1024).toFixed(2)} MB`}。`);
