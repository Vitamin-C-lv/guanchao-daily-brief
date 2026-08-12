import fs from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluatePublisherEvidence, MAX_GUARDIAN_PUBLISHER_RETRY, refreshRemoteTruth, runPublisherGuardian } from "./publisher-guardian.mjs";

const task = { exists: true, status: "Ready", lastRunTime: "2026-08-12T18:20:00+08:00", lastTaskResult: 0 };
const packet = { found: true, valid: true };

function gitFixture({ remoteBefore, fetchedRemote, runtimeHead, ancestors = [], runtimeClean = true, repositoryClean = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-guardian-git-"));
  const repositoryPath = path.join(root, "repo");
  const runtimePath = path.join(root, "runtime");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(runtimePath);
  let fetchCount = 0;
  let currentRemote = remoteBefore;
  let currentRuntime = runtimeHead;
  const calls = [];
  const git = (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "status") return cwd === repositoryPath ? (repositoryClean ? "" : " M unknown.txt") : (runtimeClean ? "" : " M unknown.txt");
    if (args[0] === "fetch") { currentRemote = fetchedRemote[Math.min(fetchCount, fetchedRemote.length - 1)] ?? currentRemote; fetchCount += 1; return ""; }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return cwd === repositoryPath ? "repo-head" : currentRuntime;
    if (args[0] === "rev-parse") return currentRemote;
    if (args[0] === "merge-base" && ancestors.includes(`${args[2]}->${args[3]}`)) return "";
    if (args[0] === "merge" && args[1] === "--ff-only") { currentRuntime = args[2]; return ""; }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { repositoryPath, runtimePath, git, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

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

test("stale local origin/main is refreshed before comparison and becomes healthy", async () => {
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["B"], runtimeHead: "B" });
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    assert.equal(truth.status, "HEALTHY");
    assert.equal(truth.remoteRefreshStatus, "REMOTE_REF_REFRESHED");
    assert.equal(truth.remoteMainBeforeFetch, "A");
    assert.equal(truth.remoteMainAfterFetch, "B");
    assert.equal(truth.runtimeHead, "B");
    assert.equal(truth.runtimeReachableFromRemote, true);
    assert.equal(truth.remoteRefreshAttempts, 1);
  } finally { fixture.cleanup(); }
});

test("repo and runtime already at fresh origin/main are healthy", async () => {
  const fixture = gitFixture({ remoteBefore: "B", fetchedRemote: ["B"], runtimeHead: "B" });
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    assert.equal(truth.status, "HEALTHY");
    assert.equal(truth.remoteRefreshStatus, "REMOTE_REF_CONFIRMED");
    assert.equal(truth.runtimeReachableFromRemote, true);
  } finally { fixture.cleanup(); }
});

test("clean runtime behind fresh main is repairable and syncs before one recovery run", async () => {
  let runs = 0;
  let repairs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: { status: "RUNTIME_BEHIND", repairability: "REPAIRABLE", remoteMainAfterFetch: "B", runtimeHead: "A", runtimeReachableFromRemote: true } }, repair: async () => { repairs += 1; return { ok: true, repairs: ["sync_runtime_to_fresh_origin_main"] }; }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
  assert.equal(result.finalStatus, "RECOVERED");
  assert.equal(repairs, 1);
  assert.equal(runs, 1);
});

test("runtime ahead with an active Publisher never repairs concurrently", async () => {
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: { status: "RUNTIME_AHEAD", repairability: "NON_REPAIRABLE" }, publisherProcessActive: true, globalLockActive: true }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
  assert.equal(result.finalStatus, "PUBLISHER_STILL_RUNNING");
  assert.equal(runs, 0);
});

test("runtime-ahead race becomes healthy after the bounded second fetch", async () => {
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["A", "B"], runtimeHead: "B", ancestors: ["A->B"] });
  let runs = 0;
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: truth, executionReceipt: { editionDate: "2026-08-12", status: "published" } }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
    assert.equal(truth.status, "HEALTHY");
    assert.equal(truth.remoteRefreshAttempts, 2);
    assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
    assert.equal(runs, 0);
  } finally { fixture.cleanup(); }
});

test("unrelated runtime commit fails closed and still writes a receipt", async () => {
  let written = null;
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: { status: "CANONICAL_RUNTIME_HEAD_MISMATCH", repairability: "NON_REPAIRABLE", remoteMainBeforeFetch: "A", remoteMainAfterFetch: "B", runtimeHead: "C", runtimeReachableFromRemote: false } }, runPublisher: async () => { runs += 1; return { status: "published" }; }, writeReceipt: async (receipt) => { written = receipt; } });
  assert.equal(result.finalStatus, "CANONICAL_RUNTIME_HEAD_MISMATCH");
  assert.equal(written.finalStatus, "CANONICAL_RUNTIME_HEAD_MISMATCH");
  assert.equal(written.runtimeHead, "C");
  assert.equal(runs, 0);
});

test("consistency drift is a repair signal, not a preflight stop", async () => {
  let repairs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { consistencyStatus: "DRIFT", runtimeTruth: { status: "HEALTHY", repairability: "NONE" } }, repair: async () => { repairs += 1; return { ok: true, repairs: ["repair_known_scheduler_action"] }; }, runPublisher: async () => ({ status: "no-op" }) });
  assert.equal(result.finalStatus, "RECOVERED");
  assert.equal(result.consistencyStatus, "DRIFT");
  assert.equal(repairs, 1);
});

test("unrepairable recovery writes receipt without a Publisher retry", async () => {
  let written = null;
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: { status: "RUNTIME_BEHIND", repairability: "REPAIRABLE" } }, repair: async () => ({ ok: false, reason: "safe runtime sync unavailable" }), runPublisher: async () => { runs += 1; return { status: "published" }; }, writeReceipt: async (receipt) => { written = receipt; } });
  assert.equal(result.finalStatus, "RECOVERY_FAILED");
  assert.equal(written.finalStatus, "RECOVERY_FAILED");
  assert.equal(result.recoveryRunAttempted, false);
  assert.equal(runs, 0);
});

test("valid sealed Packet prevents a duplicate Publisher run", async () => {
  let runs = 0;
  const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: { status: "HEALTHY" }, dailyPacket: packet, reviewPacket: packet }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
  assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
  assert.equal(runs, 0);
});

test("Publisher success plus stale local ref is healthy with zero retries", async () => {
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["B"], runtimeHead: "B" });
  let runs = 0;
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: truth, executionReceipt: { editionDate: "2026-08-12", status: "published" } }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
    assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
    assert.equal(result.recoveryRunAttempted, false);
    assert.equal(runs, 0);
  } finally { fixture.cleanup(); }
});
