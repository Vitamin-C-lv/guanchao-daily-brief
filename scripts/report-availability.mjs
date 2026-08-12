import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AVAILABILITY_SCHEMA = "guanchao-report-availability-v1";
export const RECEIPT_SCHEMA = "report-availability-receipt-v1";
export const MAX_WRITER_ATTEMPTS = 2;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QUALITY = new Set(["normal", "degraded", "writer_only", "fallback", "no_report"]);
const PACKET_STATUS = new Set(["valid", "partial", "partial-valid", "missing", "invalid", "future", "unavailable"]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function dateParts(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) fail("INVALID_DATE", `invalid date: ${value}`);
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => [part.type, part.value]));
}

export function shanghaiDate(value = new Date()) {
  const parts = dateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function isShanghaiSunday(editionDate) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", `editionDate must be YYYY-MM-DD: ${editionDate}`);
  return new Date(`${editionDate}T12:00:00+08:00`).getUTCDay() === 0;
}

export function validateAvailabilityConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) fail("AVAILABILITY_CONFIG_INVALID", "config must be an object");
  if (config.schemaVersion !== AVAILABILITY_SCHEMA) fail("AVAILABILITY_CONFIG_SCHEMA", `schemaVersion must be ${AVAILABILITY_SCHEMA}`);
  if (config.enabled !== true) fail("AVAILABILITY_DISABLED", "availability-first is disabled; only an explicit manual change may disable it");
  if (config.mode !== "availability_first") fail("AVAILABILITY_MODE", "mode must be availability_first");
  if (config.manualDisableOnly !== true) fail("AVAILABILITY_MANUAL_DISABLE", "manualDisableOnly must remain true");
  for (const forbidden of ["expiresAt", "autoRestore", "timeoutDays", "automaticDisable"]) {
    if (Object.hasOwn(config, forbidden)) fail("AVAILABILITY_AUTO_EXPIRY_FORBIDDEN", `${forbidden} is not allowed`);
  }
  return config;
}

export function loadAvailabilityConfig(file = path.resolve("config/report-availability.json")) {
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch (error) { fail("AVAILABILITY_CONFIG_MISSING", `${file}: ${error instanceof Error ? error.message : String(error)}`); }
  return validateAvailabilityConfig(value);
}

function packetDate(packet, kind) {
  return kind === "review" ? packet?.asOfDate ?? null : packet?.editionDate ?? null;
}

export function classifyPacket(packet, { kind = "daily", editionDate, valid = true } = {}) {
  if (packet === null || packet === undefined) return { status: "missing", actualAsOf: null, packetId: null };
  if (!valid || typeof packet !== "object" || Array.isArray(packet)) return { status: "invalid", actualAsOf: packetDate(packet, kind), packetId: null };
  const actualAsOf = packetDate(packet, kind);
  if (typeof actualAsOf !== "string" || !DATE.test(actualAsOf)) return { status: "invalid", actualAsOf: actualAsOf ?? null, packetId: packet.packetId ?? null };
  if (editionDate && actualAsOf > editionDate) return { status: "future", actualAsOf, packetId: packet.packetId ?? null };
  if (editionDate && kind === "daily" && actualAsOf !== editionDate) return { status: "stale", actualAsOf, packetId: packet.packetId ?? null };
  const raw = packet.status === "partial" || packet.status === "partial-valid" ? "partial" : packet.status === "unavailable" ? "unavailable" : "valid";
  return { status: raw, actualAsOf, packetId: packet.packetId ?? null };
}

export function strategyAvailability(reviewStatus) {
  const status = typeof reviewStatus === "string" ? reviewStatus : reviewStatus?.status;
  return status === "valid" || status === "partial" ? { mode: "model_plus_writer", probabilityAllowed: true } : { mode: "writer_only", probabilityAllowed: false };
}

export function assessReportAvailability({ editionDate, reportType = "daily", dailyPacket = null, reviewPacket = null, dailyPacketValid = true, reviewPacketValid = true, writerStatus = "succeeded", publisherStatus = "unknown", sourceHealth = null, knownGaps = [] } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", `editionDate must be YYYY-MM-DD: ${editionDate}`);
  if (!["daily", "weekly"].includes(reportType)) fail("INVALID_REPORT_TYPE", "reportType must be daily or weekly");
  if (isShanghaiSunday(editionDate)) return {
    editionDate, reportType, publicationQuality: "no_report", strategy: { mode: "writer_only", probabilityAllowed: false },
    dailyStatus: "unavailable", reviewStatus: "unavailable", writerStatus: "not-run", publisherStatus: "sunday_no_run",
    degradationReasons: ["SUNDAY_NO_REPORT"], sourceHealth: sourceHealth ?? { status: "unavailable", reason: "Sunday has no report" }, knownGaps: [...knownGaps],
  };
  const daily = classifyPacket(dailyPacket, { kind: "daily", editionDate, valid: dailyPacketValid });
  const review = classifyPacket(reviewPacket, { kind: "review", editionDate, valid: reviewPacketValid });
  const reasons = [];
  if (daily.status !== "valid") reasons.push(`DAILY_PACKET_${daily.status.toUpperCase()}`);
  if (review.status !== "valid") reasons.push(`REVIEW_PACKET_${review.status.toUpperCase()}`);
  const strategy = strategyAvailability(review.status);
  let publicationQuality = "normal";
  if (writerStatus === "fallback") publicationQuality = "fallback";
  else if (daily.status !== "valid") publicationQuality = "degraded";
  else if (strategy.mode === "writer_only") publicationQuality = "writer_only";
  if (writerStatus === "failed") publicationQuality = "fallback";
  return {
    editionDate, reportType, publicationQuality, strategy, dailyStatus: daily.status, reviewStatus: review.status,
    dailyAsOf: daily.actualAsOf, reviewAsOf: review.actualAsOf, writerStatus, publisherStatus,
    sourceHealth: sourceHealth ?? dailyPacket?.sourceHealth ?? { status: "unavailable", reason: "source health not supplied" },
    knownGaps: [...knownGaps], degradationReasons: [...new Set(reasons)],
  };
}

function sourceSummary(sourceHealth) {
  if (!sourceHealth || typeof sourceHealth !== "object") return { status: "unavailable", reason: "source health not supplied" };
  return structuredClone(sourceHealth);
}

export function buildDegradedWriterContext({ editionDate, reportType = "daily", dailyPacket = null, reviewPacket = null, latestMarketHistory = [], previousArticle = null, sourceHealth = null, knownGaps = [] } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", `editionDate must be YYYY-MM-DD: ${editionDate}`);
  const assessment = assessReportAvailability({ editionDate, reportType, dailyPacket, reviewPacket, sourceHealth, knownGaps });
  return {
    schemaVersion: "degraded-writer-context-v1", editionDate, reportType, mode: "availability_first",
    packetStatus: { daily: assessment.dailyStatus, review: assessment.reviewStatus },
    strategy: { mode: "writer_only", probability: null, reason: "Review Packet is unavailable or not valid" },
    sourceHealth: sourceSummary(sourceHealth ?? dailyPacket?.sourceHealth),
    availableFacts: Array.isArray(dailyPacket?.facts) ? structuredClone(dailyPacket.facts) : [],
    latestMarketHistory: Array.isArray(latestMarketHistory) ? latestMarketHistory.map((item) => ({ ...structuredClone(item), asOf: item?.asOf ?? item?.date ?? null })) : [],
    previousArticle: previousArticle && typeof previousArticle === "object" ? { id: previousArticle.id ?? null, title: previousArticle.title ?? null, asOf: previousArticle.editionDate ?? previousArticle.asOf ?? null } : null,
    knownGaps: [...new Set([...knownGaps, ...assessment.degradationReasons])],
    hardGates: { probability: "unchanged", immutableLedger: "unchanged", futureReview: "reject", staleValues: "show_actual_as_of" },
  };
}

function section(title, text) { return { title, text }; }
function textOr(text, fallback) { return typeof text === "string" && text.trim() ? text.trim() : fallback; }

export function buildDeterministicDailyFallback({ editionDate, context = {}, reviewStatus = "missing", sourceHealth = null, knownGaps = [], nextObservation = "等待下一次可验证数据闭合。" } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", `editionDate must be YYYY-MM-DD: ${editionDate}`);
  return {
    schemaVersion: "deterministic-daily-fallback-v1", editionDate, title: `观潮每日晚报｜${editionDate}`, mode: "fallback",
    sections: [
      section("今日状态", textOr(context.todayStatus, "当前仅组织已验证事实；普通数据源异常未被写成确定性判断。")),
      section("A股最近可验证状态", textOr(context.aShare, "A股：暂无可验证的新状态。")),
      section("港股最近可验证状态", textOr(context.hk, "港股：暂无可验证的新状态。")),
      section("美股最近可验证状态", textOr(context.us, "美股：暂无可验证的新状态。")),
      section("当前已确认的重要事件", textOr(context.events, "暂无可确认的新事件。")),
      section("模型状态", reviewStatus === "valid" ? "本期模型 Review 可用；本回退渲染不重新计算 probability。" : "本期无可发布模型 Review；维持 writer_only，probability=null。"),
      section("数据缺口", [...new Set(knownGaps)].length ? [...new Set(knownGaps)].join("；") : "部分数据源暂不可用。"),
      section("下一交易日观察", nextObservation),
    ],
    modelStatus: { reviewStatus, probability: null, note: reviewStatus === "valid" ? "probability remains sourced from sealed Review Packet" : "本期无可发布模型 Review。" },
    sourceHealth: sourceHealth ?? { status: "unavailable", reason: "fallback input did not include source health" },
    dataGaps: [...new Set(knownGaps)],
  };
}

export function buildDeterministicWeeklyFallback({ weekStart, weekEnd, context = {}, reviewStatus = "missing", sourceHealth = null, knownGaps = [] } = {}) {
  if (!DATE.test(String(weekStart ?? "")) || !DATE.test(String(weekEnd ?? ""))) fail("INVALID_WEEK_RANGE", "weekStart/weekEnd must be YYYY-MM-DD");
  return {
    schemaVersion: "deterministic-weekly-fallback-v1", weekStart, weekEnd, title: `观潮周报｜${weekStart}至${weekEnd}`, mode: "fallback",
    sections: [
      section("本周结论", textOr(context.verdict, "本周仅整理已验证事实，未把数据缺口写成确定性结论。")),
      section("本周市场状态", textOr(context.market, "本周市场状态：暂无完整可验证汇总。")),
      section("A/H/US", textOr(context.markets, "A/H/US：分别保留各自实际 asOf，缺失部分标记 unavailable。")),
      section("政策主线", textOr(context.policy, "暂无可确认的新政策主线。")),
      section("Prediction Review 状态", reviewStatus === "valid" ? "Review 可用；本回退渲染不重新计算 probability。" : "本周无可发布模型 Review。"),
      section("数据缺口", [...new Set(knownGaps)].length ? [...new Set(knownGaps)].join("；") : "部分数据源暂不可用。"),
      section("下周观察", textOr(context.nextWatch, "等待下一次可验证数据闭合。")),
    ],
    modelStatus: { reviewStatus, probability: null }, sourceHealth: sourceHealth ?? { status: "unavailable" }, dataGaps: [...new Set(knownGaps)],
  };
}

export async function runWriterWithAvailability({ edition, writer, fallback, input = {}, maxAttempts = MAX_WRITER_ATTEMPTS } = {}) {
  if (!["daily", "weekly"].includes(edition)) fail("INVALID_REPORT_TYPE", "edition must be daily or weekly");
  if (typeof writer !== "function" || typeof fallback !== "function") fail("WRITER_RUNNER_REQUIRED", "writer and fallback functions are required");
  if (maxAttempts !== MAX_WRITER_ATTEMPTS) fail("WRITER_RETRY_BOUND", `maxAttempts must remain ${MAX_WRITER_ATTEMPTS}`);
  const errors = [];
  for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt += 1) {
    try {
      const result = await writer({ ...input, attempt });
      return { status: "writer_succeeded", writerAttemptCount: attempt, writerSucceeded: true, fallbackRendererUsed: false, retryCount: attempt - 1, result, errors };
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }
  const result = await fallback({ ...input, attempts: MAX_WRITER_ATTEMPTS, errors: [...errors] });
  return { status: "fallback", writerAttemptCount: MAX_WRITER_ATTEMPTS, writerSucceeded: false, fallbackRendererUsed: true, retryCount: 1, result, errors };
}

export function buildReportAvailabilityReceipt({ editionDate, reportType, publicationQuality, guardianStatus = "UNKNOWN", packetStatus = "unknown", reviewStatus = "unknown", writerAttemptCount = 0, writerSucceeded = false, fallbackRendererUsed = false, publicationRetryCount = 0, published = false, degradationReasons = [] } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", "editionDate must be YYYY-MM-DD");
  if (!["daily", "weekly"].includes(reportType)) fail("INVALID_REPORT_TYPE", "reportType must be daily or weekly");
  if (!QUALITY.has(publicationQuality)) fail("INVALID_PUBLICATION_QUALITY", `unsupported quality: ${publicationQuality}`);
  if (typeof packetStatus !== "string" || typeof reviewStatus !== "string") fail("INVALID_RECEIPT_STATUS", "packetStatus/reviewStatus must be strings");
  if (!Number.isInteger(writerAttemptCount) || writerAttemptCount < 0 || writerAttemptCount > MAX_WRITER_ATTEMPTS) fail("WRITER_RETRY_BOUND", "writerAttemptCount must be 0..2");
  if (!Number.isInteger(publicationRetryCount) || publicationRetryCount < 0) fail("PUBLICATION_RETRY_INVALID", "publicationRetryCount must be non-negative");
  return {
    schemaVersion: RECEIPT_SCHEMA, editionDate, reportType, publicationQuality, guardianStatus, packetStatus, reviewStatus,
    writerAttemptCount, writerSucceeded: Boolean(writerSucceeded), fallbackRendererUsed: Boolean(fallbackRendererUsed), publicationRetryCount,
    published: Boolean(published), degradationReasons: [...new Set(degradationReasons.map(String))],
  };
}

export function writeReportAvailabilityReceipt(file, receipt) {
  const validated = buildReportAvailabilityReceipt(receipt);
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) fail("CLI_ARGUMENT", `unknown argument: ${values[index]}`);
    const key = values[index].slice(2);
    parsed[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return parsed;
}

const moduleFile = fileURLToPath(import.meta.url);

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args["validate-config"] !== undefined) console.log(JSON.stringify(loadAvailabilityConfig(args.config ? path.resolve(args.config) : path.resolve("config/report-availability.json")), null, 2));
    else if (args.receipt) {
      const receipt = buildReportAvailabilityReceipt({ editionDate: args["edition-date"], reportType: args["report-type"] ?? "daily", publicationQuality: args.quality ?? "degraded", guardianStatus: args["guardian-status"] ?? "UNKNOWN", packetStatus: args["packet-status"] ?? "unknown", reviewStatus: args["review-status"] ?? "unknown", writerAttemptCount: Number(args["writer-attempts"] ?? 0), writerSucceeded: args["writer-succeeded"] === true, fallbackRendererUsed: args.fallback === true, publicationRetryCount: Number(args["publication-retries"] ?? 0), published: args.published === true, degradationReasons: args.reason ? String(args.reason).split(",") : [] });
      console.log(JSON.stringify({ receiptPath: writeReportAvailabilityReceipt(path.resolve(args.receipt), receipt), receipt }, null, 2));
    } else fail("CLI_ARGUMENT", "use --validate-config or --receipt");
  } catch (error) { console.error(`${error.code ?? "REPORT_AVAILABILITY_FAILURE"} ${error.message}`); process.exitCode = 1; }
}
