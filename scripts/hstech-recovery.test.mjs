import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeHstechBars, validateHstechCache } from "./hstech-recovery.mjs";
import { validateHstechPublicDocument } from "./validate-hstech-live.mjs";
import { buildHstechPrivateCacheValidation } from "./validate-hstech-private-cache.mjs";

test("HSTECH fixture filters launch date and invalid OHLC without interpolation", () => {
  const result = normalizeHstechBars([{ date: "2020-07-26", open: 1, high: 2, low: 1, close: 2 }, { date: "2020-07-27", open: 1, high: 2, low: 1, close: 2 }, { date: "2020-07-28", open: 2, high: 1, low: 2, close: 1 }]);
  assert.equal(result.rows, 1);
  assert.equal(result.preLaunch, undefined);
  assert.equal(result.counts.preLaunch, 1);
  assert.equal(result.counts.invalidOhlc, 1);
});

test("HSTECH public validation rejects pre-launch and short history", () => {
  assert.throws(() => validateHstechPublicDocument({ status: "partial", bars: [{ time: "2020-07-26" }], source: { provider: "ETF 03032", note: "插值" } }), /HSTECH_PUBLIC_INVALID/);
});

test("normalized cache requires bounded Sina source", () => {
  assert.throws(() => validateHstechCache({ schemaVersion: "hstech-sina-normalized-v1", source: { provider: "other" }, bars: [] }), /HSTECH cache source/);
});

test("private cache validation requires an explicit path", () => {
  assert.throws(() => buildHstechPrivateCacheValidation(null), /HSTECH_PRIVATE_CACHE_PATH_REQUIRED/);
});
