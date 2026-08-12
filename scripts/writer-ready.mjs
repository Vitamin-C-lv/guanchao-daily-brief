import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAutomationConsistency } from "./check-automation-consistency.mjs";
import { resolveAutomationPaths } from "./automation-paths.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";
import { validatePacket } from "./validate-writer-packet.mjs";
import { runWriterProductionPreflight } from "./writer-production-preflight.mjs";
import { assessReportAvailability, buildDegradedWriterContext, loadAvailabilityConfig } from "./report-availability.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function dateInShanghai(now) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now)
    .filter((part) => ["year", "month", "day"].includes(part.type));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isSunday(editionDate) {
  return new Date(`${editionDate}T12:00:00+08:00`).getUTCDay() === 0;
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(code, `${file} is missing or invalid`); }
}

function packetPaths(paths, editionDate) {
  const root = path.join(paths.eveningPacketsRoot, editionDate);
  return {
    marketPacket: path.join(root, "DAILY_MARKET_PACKET.json"),
    reviewPacket: path.join(root, "PREDICTION_REVIEW_PACKET.json"),
  };
}

function validateSameDayInputs({ root, edition, editionDate, paths }) {
  const packets = packetPaths(paths, editionDate);
  const market = readJson(packets.marketPacket, "WRITER_PACKET_MISSING");
  const review = readJson(packets.reviewPacket, "WRITER_PACKET_MISSING");
  validateEveningPacket(market, "DAILY_MARKET_PACKET.json");
  validateEveningPacket(review, "PREDICTION_REVIEW_PACKET.json");
  if (market.editionDate !== editionDate) fail("WRITER_PACKET_STALE", "daily market packet does not match the requested edition date");
  if (review.asOfDate > editionDate) fail("WRITER_PACKET_FUTURE", "prediction review packet is from the future");
  const writerInput = path.join(root, "content", "writer-packets", `${edition}-latest.json`);
  const input = readJson(writerInput, "WRITER_INPUT_MISSING");
  validatePacket(input);
  if (input.edition !== edition) fail("WRITER_INPUT_INVALID", "writer input edition does not match");
  return { marketPacket: packets.marketPacket, reviewPacket: packets.reviewPacket, writerInput };
}

function optionalPacket(file, kind, editionDate) {
  if (!fs.existsSync(file)) return { file, packet: null, valid: false, status: "missing", error: "missing" };
  try {
    const packet = JSON.parse(fs.readFileSync(file, "utf8"));
    validateEveningPacket(packet, kind);
    if (kind === "DAILY_MARKET_PACKET.json" && packet.editionDate !== editionDate) return { file, packet, valid: false, status: "stale", error: "stale daily packet" };
    if (kind === "PREDICTION_REVIEW_PACKET.json" && packet.asOfDate > editionDate) return { file, packet, valid: false, status: "future", error: "future review" };
    return { file, packet, valid: true, status: packet.status === "partial" ? "partial" : "valid", error: null };
  } catch (error) {
    return { file, packet: null, valid: false, status: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
}

function diagnosticPath(paths, editionDate, edition) {
  return path.join(paths.recoveryRoot, "logs", "writer-ready", editionDate, `${edition}.json`);
}

function writeDiagnostic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function writerReady({ edition, editionDate = null, root = repositoryRoot, paths = resolveAutomationPaths(), now = new Date(), preflight = runWriterProductionPreflight, automationCheck = checkAutomationConsistency, writeDiagnostics = true } = {}) {
  if (!new Set(["daily", "weekly"]).has(edition)) fail("WRITER_EDITION", "daily or weekly edition required");
  const date = editionDate ?? dateInShanghai(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("WRITER_DATE", "edition date must be YYYY-MM-DD");
  const logFile = diagnosticPath(paths, date, edition);
  try {
    if (edition === "daily" && isSunday(date)) fail("SUNDAY_NO_REPORT", "Sunday Daily editions are not published");
    const packet = packetPaths(paths, date);
    const availability = loadAvailabilityConfig(path.join(root, "config", "report-availability.json"));
    const production = preflight({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath, dailyPacketPath: edition === "daily" ? packet.marketPacket : null, predictionReviewPacketPath: edition === "daily" ? packet.reviewPacket : null, editionDate: date, allowMissingDailyPacket: availability.enabled, allowMissingReviewPacket: availability.enabled, allowInvalidDailyPacket: availability.enabled, allowInvalidReviewPacket: availability.enabled });
    if (production.status !== "READY" && !["PACKET_MISSING", "PACKET_INVALID"].includes(production.errorCode)) fail(production.errorCode ?? "WRITER_PRODUCTION_BLOCKED", "writer production preflight is not ready");
    const consistency = automationCheck({ productionPreflight: production, runProductionPreflight: false });
    if (!consistency.consistent) fail("AUTOMATION_DRIFT", "automation consistency is not ready");
    const inputs = edition === "daily"
      ? { market: optionalPacket(packet.marketPacket, "DAILY_MARKET_PACKET.json", date), review: optionalPacket(packet.reviewPacket, "PREDICTION_REVIEW_PACKET.json", date), writerInput: path.join(root, "content", "writer-packets", "daily-latest.json") }
      : { market: { packet: null, valid: false, status: "unavailable" }, review: { packet: null, valid: false, status: "missing" }, writerInput: path.join(root, "content", "writer-packets", "weekly-latest.json") };
    const writerInputExists = fs.existsSync(inputs.writerInput);
    if (edition === "daily" && inputs.market.valid && inputs.review.valid && writerInputExists) {
      const normal = validateSameDayInputs({ root, edition, editionDate: date, paths });
      const compact = { ready: true, availability: "normal", edition, editionDate: date, marketPacket: normal.marketPacket, reviewPacket: normal.reviewPacket, writerInput: normal.writerInput, memoryContext: path.join(paths.runtimePath, "memory"), researchBundle: path.join(paths.runtimePath, "research-bundles", date) };
      if (writeDiagnostics) writeDiagnostic(logFile, { ...compact, production, consistency: { consistent: true } });
      return compact;
    }
    const assessment = assessReportAvailability({ editionDate: date, reportType: edition, dailyPacket: inputs.market.packet, reviewPacket: inputs.review.packet, dailyPacketValid: inputs.market.valid, reviewPacketValid: inputs.review.valid });
    const degradedContextPath = path.join(paths.recoveryRoot, "runs", date, edition, "DEGRADED_WRITER_CONTEXT.json");
    const degradedContext = buildDegradedWriterContext({ editionDate: date, reportType: edition, dailyPacket: inputs.market.packet, reviewPacket: inputs.review.packet, sourceHealth: inputs.market.packet?.sourceHealth, knownGaps: [inputs.market.status, inputs.review.status, ...(writerInputExists ? [] : ["WRITER_INPUT_MISSING"])] });
    writeDiagnostic(degradedContextPath, degradedContext);
    const compact = { ready: true, availability: assessment.publicationQuality === "writer_only" ? "writer_only" : "degraded", edition, editionDate: date, marketPacket: inputs.market.valid ? inputs.market.file : null, reviewPacket: inputs.review.valid ? inputs.review.file : null, writerInput: writerInputExists ? inputs.writerInput : null, degradedContext: degradedContextPath, memoryContext: path.join(paths.runtimePath, "memory"), researchBundle: path.join(paths.runtimePath, "research-bundles", date), packetStatus: { daily: inputs.market.status, review: inputs.review.status } };
    if (writeDiagnostics) writeDiagnostic(logFile, { ...compact, production, consistency: { consistent: true } });
    return compact;
  } catch (cause) {
    const code = cause?.code ?? "WRITER_BLOCKED";
    if (writeDiagnostics) writeDiagnostic(logFile, { ready: false, edition, editionDate: date, code, message: cause instanceof Error ? cause.message : "unexpected failure" });
    return { ready: false, code, edition, editionDate: date };
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) fail("CLI_ARGUMENT", "unknown positional argument");
    const key = args[index].slice(2);
    parsed[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const args = parseArgs(process.argv.slice(2));
  const result = writerReady({ edition: args.edition, editionDate: args["edition-date"] ?? null, root: args.root ? path.resolve(args.root) : repositoryRoot });
  if (!result.ready) {
    console.log(`WRITER_BLOCKED ${result.code}`);
    process.exitCode = 1;
  } else {
    console.log(result.availability === "normal" ? "WRITER_READY" : result.availability === "writer_only" ? "WRITER_ONLY" : "WRITER_DEGRADED");
    console.log(JSON.stringify(result));
  }
}
