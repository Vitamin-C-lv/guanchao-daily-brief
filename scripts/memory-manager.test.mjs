import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sanitizeText, validateMemoryDelta, validateMemoryTree } from "./memory-manager.mjs";
import { buildWeeklyCompaction } from "./weekly-memory-compaction.mjs";

test("memory sanitizer rejects credentials, network identifiers and raw provider payload", () => {
  assert.throws(() => sanitizeText("authorization: Bearer abcdefghijkl", "negative"), /MEMORY_SENSITIVE_DATA/);
  assert.throws(() => sanitizeText("10.0.0.1", "negative"), /MEMORY_SENSITIVE_DATA/);
  assert.throws(() => sanitizeText('{"rawPayload":{"x":1}}', "negative"), /MEMORY_SENSITIVE_DATA/);
  assert.equal(sanitizeText("path=${GUANCHAO_HOME}/runtime", "positive"), "path=${GUANCHAO_HOME}/runtime");
});

test("memory bootstrap validates and weekly compaction retains required layers", () => {
  const root = process.cwd();
  const report = validateMemoryTree(path.join(root, "memory"));
  assert.equal(report.valid, true);
  const compacted = buildWeeklyCompaction({ root, asOf: "2026-08-07" });
  assert.equal(compacted.status, "ready");
  assert.equal(compacted.rules.noEarlyForgetting, true);
  assert.equal(compacted.rules.weeklyReviewIncludesBrier, true);
});

test("memory delta contract fails closed on missing evidence", () => {
  assert.throws(() => validateMemoryDelta({ schemaVersion: "memory-delta-v1", editionDate: "2026-08-07", generatedAt: "2026-08-07T00:00:00Z", entries: [{ id: "x", type: "lesson", summary: "x", sourceIds: [] }] }), /MEMORY_DELTA_EVIDENCE/);
});
