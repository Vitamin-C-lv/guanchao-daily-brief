import assert from "node:assert/strict";
import test from "node:test";

import { evaluatePublisherEvidence, MAX_GUARDIAN_PUBLISHER_RETRY, runPublisherGuardian } from "./publisher-guardian.mjs";

const task = { exists: true, status: "Ready", lastRunTime: "2026-08-12T18:20:00+08:00", lastTaskResult: 0 };
const packet = { found: true, valid: true };

test("successful Publisher produces a healthy Guardian no-op without rerun", async () => {
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { executionReceipt: { editionDate: "2026-08-12", status: "published" }, dailyPacket: packet, reviewPacket: packet, publisherProcessActive: false, globalLockActive: false }, repair: async () => { throw new Error("must not repair"); }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
  assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
  assert.equal(runs, 0);
});

test("Publisher NO_OP is also a healthy no-op", () => {
  const result = evaluatePublisherEvidence({ editionDate: "2026-08-12", task, executionReceipt: { editionDate: "2026-08-12", status: "no-op" }, dailyPacket: packet });
  assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
  assert.equal(result.publisherResult, "NO_OP");
});

test("missing Publisher evidence repairs and runs exactly once", async () => {
  let repairCount = 0;
  let runCount = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { executionReceipt: null, dailyPacket: { found: false, valid: false }, reviewPacket: { found: false, valid: false } }, repair: async ({ maxAttempts }) => { repairCount += 1; assert.equal(maxAttempts, 1); return { ok: true, repairs: ["restore_recovery_directory"] }; }, runPublisher: async ({ attempt, maxAttempts }) => { runCount += 1; assert.equal(attempt, 1); assert.equal(maxAttempts, 1); return { status: "published" }; } });
  assert.equal(result.finalStatus, "RECOVERED");
  assert.equal(repairCount, 1);
  assert.equal(runCount, 1);
  assert.equal(result.recoveryRunAttempted, true);
});

test("Node failure repair success still has one recovery run", async () => {
  let runCount = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task: { ...task, taskToRun: "node missing" }, evidence: { executionReceipt: { editionDate: "2026-08-12", status: "failed" }, dailyPacket: { found: false, valid: false }, reviewPacket: { found: false, valid: false } }, repair: async () => ({ ok: true, repairs: ["repair_node_resolution"] }), runPublisher: async () => { runCount += 1; return { status: "no-op" }; } });
  assert.equal(result.finalStatus, "RECOVERED");
  assert.equal(runCount, 1);
});

test("active Publisher never runs concurrently", async () => {
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { executionReceipt: null, dailyPacket: { found: false, valid: false }, reviewPacket: { found: false, valid: false }, publisherProcessActive: true, globalLockActive: true }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
  assert.equal(result.finalStatus, "PUBLISHER_STILL_RUNNING");
  assert.equal(runs, 0);
});

test("failed recovery and immutable conflict stop after the single allowed attempt", async () => {
  let runCount = 0;
  const failed = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { dailyPacket: { found: false, valid: false }, reviewPacket: { found: false, valid: false } }, repair: async () => ({ ok: true, repairs: [] }), runPublisher: async () => { runCount += 1; return { status: "failed" }; } });
  assert.equal(failed.finalStatus, "RECOVERY_FAILED");
  const conflict = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { dailyPacket: { found: false, valid: false }, reviewPacket: { found: false, valid: false } }, repair: async () => ({ ok: true, repairs: [] }), runPublisher: async () => ({ status: "immutable_conflict" }) });
  assert.equal(conflict.finalStatus, "PREDICTION_CONFLICT");
  assert.equal(runCount, 1);
  assert.equal(MAX_GUARDIAN_PUBLISHER_RETRY, 1);
});

test("Sunday is not a Publisher recovery day", async () => {
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-09", task, evidence: {}, runPublisher: async () => { runs += 1; return { status: "published" }; } });
  assert.equal(result.publisherStatus, "SUNDAY_NO_RUN");
  assert.equal(runs, 0);
});
