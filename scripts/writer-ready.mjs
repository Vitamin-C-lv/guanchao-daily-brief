import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAutomationConsistency } from "./check-automation-consistency.mjs";
import { resolveAutomationPaths } from "./automation-paths.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";
import { validatePacket } from "./validate-writer-packet.mjs";
import { runWriterProductionPreflight } from "./writer-production-preflight.mjs";

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
    const production = preflight({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath, dailyPacketPath: edition === "daily" ? packet.marketPacket : null, predictionReviewPacketPath: edition === "daily" ? packet.reviewPacket : null, editionDate: date });
    if (production.status !== "READY") fail(production.errorCode ?? "WRITER_PRODUCTION_BLOCKED", "writer production preflight is not ready");
    const consistency = automationCheck({ productionPreflight: production, runProductionPreflight: false });
    if (!consistency.consistent) fail("AUTOMATION_DRIFT", "automation consistency is not ready");
    const inputs = edition === "daily" ? validateSameDayInputs({ root, edition, editionDate: date, paths }) : { marketPacket: null, reviewPacket: null, writerInput: path.join(root, "content", "writer-packets", "weekly-latest.json") };
    if (edition === "weekly" && !fs.existsSync(inputs.writerInput)) fail("WRITER_INPUT_MISSING", "weekly writer input is missing");
    const compact = { ready: true, edition, editionDate: date, marketPacket: inputs.marketPacket, reviewPacket: inputs.reviewPacket, writerInput: inputs.writerInput, memoryContext: path.join(paths.runtimePath, "memory"), researchBundle: path.join(paths.runtimePath, "research-bundles", date) };
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
    console.log("WRITER_READY");
    console.log(JSON.stringify(result));
  }
}
