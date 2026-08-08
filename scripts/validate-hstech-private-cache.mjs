import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHstechCache } from "./hstech-recovery.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

export function buildHstechPrivateCacheValidation(cachePath) {
  if (!cachePath) throw new Error("HSTECH_PRIVATE_CACHE_PATH_REQUIRED explicit normalized cache path is required");
  const cache = loadHstechCache(path.resolve(cachePath), { asOf: "2026-08-06" });
  return {
    schemaVersion: "hstech-private-cache-validation-v1",
    status: "ready",
    cachePath: path.resolve(cachePath),
    rowsAfterOHLCFilter: cache.rows,
    firstDate: cache.firstDate,
    lastDate: cache.lastDate,
    invalidOhlcDropped: cache.counts.invalidOhlc,
    rawPayloadStored: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const cachePath = process.argv.slice(2).find((value) => value !== "--") ?? null;
    console.log(JSON.stringify(buildHstechPrivateCacheValidation(cachePath), null, 2));
  } catch (error) {
    console.error(`HSTECH_PRIVATE_CACHE_VALIDATION_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
