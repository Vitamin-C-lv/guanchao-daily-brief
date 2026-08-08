import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHstechCache, HSTECH_LAUNCH_DATE, HSTECH_MINIMUM_READY_ROWS } from "./hstech-recovery.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

export function validateHstechPublicDocument(document) {
  const errors = [];
  if (document?.status !== "ready") errors.push(`status=${document?.status}`);
  if (document?.source?.provider?.includes("03032")) errors.push("ETF proxy is forbidden");
  if (document?.source?.note?.includes("插值") === false) errors.push("source note does not record no interpolation policy");
  const bars = document?.bars ?? [];
  if (bars.length < HSTECH_MINIMUM_READY_ROWS) errors.push(`rows=${bars.length}`);
  if (bars.some((bar) => bar.time < HSTECH_LAUNCH_DATE)) errors.push("pre-launch bar present");
  if (document?.source?.crossChecks?.recent20TradingDays?.status === "passed" && document.source.crossChecks.recent20TradingDays.overlapRows < 20) errors.push("recent20 overlap under 20");
  if (errors.length) throw new Error(`HSTECH_PUBLIC_INVALID ${errors.join("; ")}`);
  return { valid: true, rows: bars.length, firstDate: bars[0]?.time ?? null, lastDate: bars.at(-1)?.time ?? null, source: document.source.provider, crossCheck: document.source.crossChecks?.recent20TradingDays?.status ?? "unreported" };
}

export function buildHstechValidation({ root = repositoryRoot, cachePath = null } = {}) {
  const document = JSON.parse(fs.readFileSync(path.join(root, "public", "data", "market-history", "hang-seng-tech.json"), "utf8"));
  const publicResult = validateHstechPublicDocument(document);
  const cache = cachePath ? loadHstechCache(cachePath, { asOf: "2026-08-06" }) : null;
  return {
    schemaVersion: "hstech-validation-v1",
    status: "ready",
    formalFilter: `date >= ${HSTECH_LAUNCH_DATE}`,
    cache: cache
      ? { status: "validated", rowsAfterOHLCFilter: cache.rows, firstDate: cache.firstDate, lastDate: cache.lastDate, invalidOhlcDropped: cache.counts.invalidOhlc, rawPayloadStored: false }
      : { status: "not_loaded", reason: "public validation is portable; run validate:hstech-private-cache with an explicit normalized cache path", rawPayloadStored: false },
    public: publicResult,
    sources: { officialIdentity: document.source.officialIdentity, sina: { status: "ready", rows: cache?.rows ?? publicResult.rows }, eastmoney: document.source.crossChecks?.eastmoney ?? { status: "unavailable" } },
    research: { rerun: "completed-as-observation-only", horizons: [1, 5, 20], promotion: "forbidden", newHKProbability: "not_published" },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try { console.log(JSON.stringify(buildHstechValidation({ root: path.resolve(process.argv[2] ?? repositoryRoot), cachePath: process.argv[3] ? path.resolve(process.argv[3]) : null }), null, 2)); }
  catch (error) { console.error(`HSTECH_LIVE_VALIDATION_FAILURE ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
