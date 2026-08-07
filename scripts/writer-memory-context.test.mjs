import assert from "node:assert/strict";
import test from "node:test";
import { buildWriterMemoryContext } from "./build-writer-memory-context.mjs";

test("writer memory bootstrap is rich but excludes operations by default", () => {
  const context = buildWriterMemoryContext({ root: process.cwd(), editionDate: "2026-08-07" });
  assert.equal(context.schemaVersion, "writer-memory-context-v1");
  assert.equal(context.writerMayBrowse, true);
  assert.equal(context.operationsMemoryLoaded, false);
  assert.equal(context.counts.recentDailyFull, 2);
  assert.equal(context.counts.recentWeeklyFull, 2);
  assert.ok(context.counts.openThreads >= 8);
  assert.equal(context.boundaries.noNullToZero, true);
});
