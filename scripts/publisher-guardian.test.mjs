import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { evaluatePublisherEvidence, MAX_GUARDIAN_PUBLISHER_RETRY, pushExistingPublisherHead, refreshRemoteTruth, runPublisherGuardian, safeSyncWorkspaceToRemote, validateExistingPublisherHead } from "./publisher-guardian.mjs";

const task = { exists: true, status: "Ready", lastRunTime: "2026-08-12T18:20:00+08:00", lastTaskResult: 0 };
const packet = { found: true, valid: true };

function gitFixture({ remoteBefore, fetchedRemote, runtimeHead, repositoryHead = runtimeHead, ancestors = [], ancestryFatal = false, runtimeClean = true, repositoryClean = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-guardian-git-"));
  const repositoryPath = path.join(root, "repo");
  const runtimePath = path.join(root, "runtime");
  fs.mkdirSync(repositoryPath);
  fs.mkdirSync(runtimePath);
  let fetchCount = 0;
  let currentRemote = remoteBefore;
  let currentRepository = repositoryHead;
  let currentRuntime = runtimeHead;
  const calls = [];
  const git = (cwd, args) => {
    calls.push({ cwd, args });
    if (args[0] === "status") return cwd === repositoryPath ? (repositoryClean ? "" : " M unknown.txt") : (runtimeClean ? "" : " M unknown.txt");
    if (args[0] === "fetch") { if (cwd === repositoryPath) { currentRemote = fetchedRemote[Math.min(fetchCount, fetchedRemote.length - 1)] ?? currentRemote; fetchCount += 1; } return ""; }
    if (args[0] === "rev-parse" && args[1] === "HEAD") return cwd === repositoryPath ? currentRepository : currentRuntime;
    if (args[0] === "rev-parse") return currentRemote;
    if (args[0] === "merge-base" && ancestors.includes(`${args[2]}->${args[3]}`)) return "";
    if (args[0] === "merge-base") { const error = new Error(ancestryFatal ? "unknown revision" : "not ancestor"); error.status = ancestryFatal ? 128 : 1; throw error; }
    if (args[0] === "merge" && args[1] === "--ff-only") { if (cwd === repositoryPath) currentRepository = args[2]; else currentRuntime = args[2]; return ""; }
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
  return { repositoryPath, runtimePath, git, calls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function realGit(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function existingHeadFixture({ changedPath = "content/prediction-review-latest.json" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-guardian-existing-head-"));
  realGit(root, "init");
  realGit(root, "config", "user.email", "test@example.com");
  realGit(root, "config", "user.name", "Test");
  fs.writeFileSync(path.join(root, "README.md"), "base\n", "utf8");
  realGit(root, "add", "README.md");
  realGit(root, "commit", "-m", "base");
  const base = realGit(root, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(root, path.dirname(changedPath)), { recursive: true });
  fs.writeFileSync(path.join(root, changedPath), "{}\n", "utf8");
  realGit(root, "add", ".");
  realGit(root, "commit", "-m", "chore(predictions): publish probability ranking 2026-08-12");
  const head = realGit(root, "rev-parse", "HEAD");
  return { root, base, head, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function realWorkspaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-guardian-workspace-"));
  const bare = path.join(root, "remote.git");
  const repositoryPath = path.join(root, "repository");
  const runtimePath = path.join(root, "runtime");
  fs.mkdirSync(repositoryPath);
  realGit(repositoryPath, "init");
  realGit(repositoryPath, "config", "user.email", "test@example.com");
  realGit(repositoryPath, "config", "user.name", "Test");
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "A\n", "utf8");
  realGit(repositoryPath, "add", "README.md");
  realGit(repositoryPath, "commit", "-m", "base A");
  realGit(repositoryPath, "branch", "-M", "main");
  execFileSync("git", ["init", "--bare", bare], { encoding: "utf8", windowsHide: true });
  realGit(repositoryPath, "remote", "add", "origin", bare);
  realGit(repositoryPath, "push", "-u", "origin", "HEAD:main");
  execFileSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"], { encoding: "utf8", windowsHide: true });
  execFileSync("git", ["clone", bare, runtimePath], { encoding: "utf8", windowsHide: true });
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "B\n", "utf8");
  realGit(repositoryPath, "commit", "-am", "production B");
  realGit(repositoryPath, "push", "origin", "HEAD:main");
  return { root, bare, repositoryPath, runtimePath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function detachedExistingFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-guardian-detached-existing-"));
  const bare = path.join(root, "remote.git");
  const runtimePath = path.join(root, "runtime");
  fs.mkdirSync(runtimePath);
  realGit(runtimePath, "init");
  realGit(runtimePath, "config", "user.email", "test@example.com");
  realGit(runtimePath, "config", "user.name", "Test");
  fs.writeFileSync(path.join(runtimePath, "README.md"), "A\n", "utf8");
  realGit(runtimePath, "add", "README.md");
  realGit(runtimePath, "commit", "-m", "base A");
  realGit(runtimePath, "branch", "-M", "main");
  execFileSync("git", ["init", "--bare", bare], { encoding: "utf8", windowsHide: true });
  realGit(runtimePath, "remote", "add", "origin", bare);
  realGit(runtimePath, "push", "-u", "origin", "HEAD:main");
  execFileSync("git", ["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"], { encoding: "utf8", windowsHide: true });
  const base = realGit(runtimePath, "rev-parse", "HEAD");
  realGit(runtimePath, "checkout", "--detach", base);
  fs.mkdirSync(path.join(runtimePath, "content"), { recursive: true });
  fs.writeFileSync(path.join(runtimePath, "content", "prediction-review-latest.json"), "{}\n", "utf8");
  realGit(runtimePath, "add", "content/prediction-review-latest.json");
  realGit(runtimePath, "commit", "-m", "chore(predictions): publish probability ranking 2026-08-12");
  const head = realGit(runtimePath, "rev-parse", "HEAD");
  return { root, bare, runtimePath, base, head, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
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
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["B"], repositoryHead: "B", runtimeHead: "B" });
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
  const fixture = gitFixture({ remoteBefore: "B", fetchedRemote: ["B"], repositoryHead: "B", runtimeHead: "B" });
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

test("runtime-ahead race is reclassified as workspace-behind after bounded refresh", async () => {
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["A", "B"], repositoryHead: "A", runtimeHead: "B", ancestors: ["A->B"] });
  let runs = 0;
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: truth, executionReceipt: { editionDate: "2026-08-12", status: "published" } }, repair: async () => ({ ok: true, repairs: ["sync_repository_to_fresh_origin_main"], noRecovery: true }), runPublisher: async () => { runs += 1; return { status: "published" }; } });
    assert.equal(truth.status, "REPOSITORY_BEHIND");
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
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["B"], repositoryHead: "B", runtimeHead: "B" });
  let runs = 0;
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    const result = await runPublisherGuardian({ editionDate: "2026-08-12", task, evidence: { runtimeTruth: truth, executionReceipt: { editionDate: "2026-08-12", status: "published" } }, runPublisher: async () => { runs += 1; return { status: "published" }; } });
    assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
    assert.equal(result.recoveryRunAttempted, false);
    assert.equal(runs, 0);
  } finally { fixture.cleanup(); }
});

test("workspace convergence repairs both clean canonical workspaces before recovery", () => {
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["B"], repositoryHead: "A", runtimeHead: "A", ancestors: ["A->B"] });
  try {
    const sync = safeSyncWorkspaceToRemote({ ...fixture, remoteMain: "B" });
    assert.equal(sync.ok, true);
    assert.deepEqual(sync.repairs, ["sync_repository_to_fresh_origin_main", "sync_runtime_to_fresh_origin_main"]);
    assert.equal(sync.repositoryHead, "B");
    assert.equal(sync.runtimeHead, "B");
  } finally { fixture.cleanup(); }
});

test("Publisher success does not bypass repository/runtime convergence repair", async () => {
  let repairs = 0;
  let runs = 0;
  const result = await runPublisherGuardian({
    editionDate: "2026-08-12", task,
    evidence: { runtimeTruth: { status: "REPOSITORY_BEHIND", repairability: "REPAIRABLE", workspaceConverged: false }, executionReceipt: { editionDate: "2026-08-12", status: "published" } },
    repair: async () => { repairs += 1; return { ok: true, repairs: ["sync_repository_to_fresh_origin_main"], noRecovery: true }; },
    runPublisher: async () => { runs += 1; return { status: "published" }; },
  });
  assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
  assert.equal(repairs, 1);
  assert.equal(runs, 0);
});

test("fatal ancestry errors remain unavailable after one bounded retry", async () => {
  const fixture = gitFixture({ remoteBefore: "A", fetchedRemote: ["B", "B"], repositoryHead: "B", runtimeHead: "C", ancestryFatal: true });
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    assert.equal(truth.status, "ANCESTRY_UNAVAILABLE");
    assert.equal(truth.remoteRefreshAttempts, 2);
  } finally { fixture.cleanup(); }
});

test("existing Publisher HEAD recovery accepts only allowed paths and passed ledger", () => {
  const fixture = existingHeadFixture();
  try {
    const result = validateExistingPublisherHead({
      editionDate: "2026-08-12", runtimePath: fixture.root, runtimeHead: fixture.head, remoteMain: fixture.base,
      executionReceipt: { editionDate: "2026-08-12", status: "failed", writeApplied: true, error: "PUSH_FAILED", commit: { ok: true, sha: fixture.head } },
      dailyPacket: packet, reviewPacket: packet, ledgerValidation: true,
    });
    assert.equal(result.ok, true);
  } finally { fixture.cleanup(); }
});

test("existing Publisher HEAD recovery rejects model changes", () => {
  const fixture = existingHeadFixture({ changedPath: "models/sector-rotation/a-share-v1.json" });
  try {
    const result = validateExistingPublisherHead({
      editionDate: "2026-08-12", runtimePath: fixture.root, runtimeHead: fixture.head, remoteMain: fixture.base,
      executionReceipt: { editionDate: "2026-08-12", status: "failed", writeApplied: true, error: "PUSH_FAILED", commit: { ok: true, sha: fixture.head } },
      dailyPacket: packet, reviewPacket: packet, ledgerValidation: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.checks.paths, false);
  } finally { fixture.cleanup(); }
});

test("runtime fetch supplies the missing remote object before ancestry and convergence", async () => {
  const fixture = realWorkspaceFixture();
  try {
    const remoteHead = realGit(fixture.repositoryPath, "rev-parse", "HEAD");
    assert.throws(() => realGit(fixture.runtimePath, "cat-file", "-e", `${remoteHead}^{commit}`));
    const truth = await refreshRemoteTruth({ repositoryPath: fixture.repositoryPath, runtimePath: fixture.runtimePath, wait: async () => {}, graceMs: 0 });
    assert.equal(truth.status, "RUNTIME_BEHIND");
    assert.equal(truth.repositoryMatchesRemote, true);
    assert.equal(truth.runtimeMatchesRemote, false);
    assert.equal(truth.workspaceConverged, false);
    const sync = safeSyncWorkspaceToRemote({ repositoryPath: fixture.repositoryPath, runtimePath: fixture.runtimePath, remoteMain: truth.remoteMainAfterFetch });
    assert.equal(sync.ok, true);
    const finalTruth = await refreshRemoteTruth({ repositoryPath: fixture.repositoryPath, runtimePath: fixture.runtimePath, wait: async () => {}, graceMs: 0 });
    assert.equal(finalTruth.status, "HEALTHY");
    assert.equal(finalTruth.workspaceConverged, true);
  } finally { fixture.cleanup(); }
});

test("repository behind runtime is not healthy before canonical convergence", async () => {
  const fixture = gitFixture({ remoteBefore: "B", fetchedRemote: ["B"], repositoryHead: "A", runtimeHead: "B", ancestors: ["A->B"] });
  try {
    const truth = await refreshRemoteTruth({ ...fixture, wait: async () => {}, graceMs: 0 });
    assert.equal(truth.status, "REPOSITORY_BEHIND");
    assert.equal(truth.workspaceConverged, false);
  } finally { fixture.cleanup(); }
});

test("valid existing detached Publisher HEAD is pushed once without rerun", async () => {
  const fixture = detachedExistingFixture();
  let runs = 0;
  const executionReceipt = { editionDate: "2026-08-12", status: "failed", writeApplied: true, error: "PUSH_FAILED", commit: { ok: true, sha: fixture.head } };
  try {
    const result = await runPublisherGuardian({
      editionDate: "2026-08-12", task,
      evidence: { runtimeTruth: { status: "RUNTIME_AHEAD", remoteMainAfterFetch: fixture.base, runtimeHead: fixture.head }, executionReceipt, dailyPacket: packet, reviewPacket: packet },
      repair: async ({ evidence }) => {
        const push = pushExistingPublisherHead({ editionDate: "2026-08-12", runtimePath: fixture.runtimePath, runtimeHead: fixture.head, remoteMain: fixture.base, executionReceipt, dailyPacket: evidence.dailyPacket, reviewPacket: evidence.reviewPacket, ledgerValidation: true });
        return { ok: push.ok, repairs: push.repairs, noRecovery: push.ok };
      },
      runPublisher: async () => { runs += 1; return { status: "published" }; },
    });
    assert.equal(result.finalStatus, "HEALTHY_NO_ACTION");
    assert.equal(result.repairs.includes("PUBLISH_EXISTING_PRODUCTION_HEAD"), true);
    assert.equal(runs, 0);
    assert.equal(realGit(fixture.bare, "rev-parse", "refs/heads/main"), fixture.head);
  } finally { fixture.cleanup(); }
});
