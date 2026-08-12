import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAutomationConsistency, readScheduledTask } from "./check-automation-consistency.mjs";
import { isForbiddenProductionPath, resolveAutomationPaths } from "./automation-paths.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";
import { pushCurrentHeadToMain } from "./publisher-git-sync.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_GUARDIAN_PUBLISHER_RETRY = 1;
export const MAX_REMOTE_REFRESH_ATTEMPTS = 2;
export const REMOTE_REFRESH_GRACE_MS = 2_000;
export const GUARDIAN_RECEIPT_SCHEMA = "publisher-guardian-receipt-v1";
const SUCCESS_STATUSES = new Set(["published", "success", "no-op", "noop", "NO_OP"]);
const ACTIVE_TASK_STATUSES = new Set(["Ready", "Running", "就绪", "正在运行"]);
const RUNTIME_BLOCKING_STATUSES = new Set([
  "FORBIDDEN_PRODUCTION_PATH",
  "CANONICAL_REPOSITORY_DIRTY",
  "CANONICAL_RUNTIME_DIRTY",
  "CANONICAL_RUNTIME_UNAVAILABLE",
  "CANONICAL_RUNTIME_HEAD_MISMATCH",
  "REMOTE_REF_REFRESH_FAILED",
  "ANCESTRY_UNAVAILABLE",
  "NON_REPAIRABLE",
]);
const PUBLISHER_ALLOWED_WRITE_PREFIXES = [
  "content/sector-rotation.json",
  "content/prediction-diagnostics.json",
  "content/prediction-review-latest.json",
  "content/prediction-review/",
  "public/data/predictions/",
  "data/prediction-ledger/",
  "public/data/prediction-history/",
  "content/prediction-history.json",
  "data/sector-rotation/",
  "data/rotation-model/",
  "data/market-evidence/",
  "content/writer-packets/",
];
const WORKSPACE_REPAIRABLE_STATUSES = new Set(["RUNTIME_AHEAD", "WORKSPACE_BEHIND", "REPOSITORY_BEHIND", "RUNTIME_BEHIND"]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function dateAtNoon(date) { return new Date(`${date}T12:00:00+08:00`); }
function isSunday(date) { return dateAtNoon(date).getUTCDay() === 0; }
function processActive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function defaultGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function errorText(error) { return String(error?.stderr || error?.stdout || error?.message || error).trim().slice(0, 500); }
function gitText(git, cwd, args) { return String(git(cwd, args) ?? "").trim(); }
function readRef(git, cwd, ref) { try { return gitText(git, cwd, ["rev-parse", ref]); } catch { return null; } }
function readClean(git, cwd) { return gitText(git, cwd, ["status", "--porcelain=v1", "-uall"]) === ""; }
function waitMs(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function pathAllowed(relative) { return PUBLISHER_ALLOWED_WRITE_PREFIXES.some((prefix) => relative === prefix || relative.startsWith(prefix)); }
function changedCommitPaths(git, runtimePath, runtimeHead) {
  try {
    const parent = gitText(git, runtimePath, ["rev-parse", `${runtimeHead}^`]);
    return gitText(git, runtimePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", parent, runtimeHead]).split(/\r?\n/).filter(Boolean).map((value) => value.replaceAll("\\", "/"));
  } catch { return null; }
}

function gitAncestorRelation(git, root, ancestor, descendant) {
  if (ancestor === descendant) return "same";
  try {
    git(root, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return "ancestor";
  } catch (error) {
    return Number(error?.status) === 1 ? "not-ancestor" : "unavailable";
  }
}

function runtimeClassification({ repositoryPath, runtimePath, git, remoteMain, repositoryHead, repositoryClean, runtimeClean, runtimeHead }) {
  const base = {
    repositoryHead, runtimeHead, remoteMain,
    repositoryMatchesRemote: repositoryHead === remoteMain,
    runtimeMatchesRemote: runtimeHead === remoteMain,
    workspaceConverged: repositoryHead === remoteMain && runtimeHead === remoteMain,
  };
  if (isForbiddenProductionPath(repositoryPath) || isForbiddenProductionPath(runtimePath)) return { status: "FORBIDDEN_PRODUCTION_PATH", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: null };
  if (!repositoryClean) return { status: "CANONICAL_REPOSITORY_DIRTY", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: null };
  if (!runtimeClean) return { status: "CANONICAL_RUNTIME_DIRTY", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
  if (!repositoryHead || !runtimeHead || !remoteMain) return { ...base, status: "CANONICAL_RUNTIME_UNAVAILABLE", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
  const repositoryToRemote = gitAncestorRelation(git, repositoryPath, repositoryHead, remoteMain);
  const remoteToRepository = gitAncestorRelation(git, repositoryPath, remoteMain, repositoryHead);
  const runtimeToRemote = gitAncestorRelation(git, runtimePath, runtimeHead, remoteMain);
  const remoteToRuntime = gitAncestorRelation(git, runtimePath, remoteMain, runtimeHead);
  if ([repositoryToRemote, remoteToRepository, runtimeToRemote, remoteToRuntime].includes("unavailable")) return { ...base, status: "ANCESTRY_UNAVAILABLE", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
  const repositoryBehind = repositoryToRemote === "ancestor";
  const repositoryAhead = remoteToRepository === "ancestor";
  const runtimeBehind = runtimeToRemote === "ancestor";
  const runtimeAhead = remoteToRuntime === "ancestor";
  const runtimeReachableFromRemote = runtimeBehind || runtimeAhead || runtimeHead === remoteMain;
  if (base.workspaceConverged) return { ...base, status: "HEALTHY", repairability: "NONE", runtimeReachableFromRemote: true };
  if ((repositoryBehind || repositoryHead === remoteMain) && runtimeAhead) return { ...base, status: "RUNTIME_AHEAD", repairability: "REPAIRABLE", runtimeReachableFromRemote };
  if (repositoryBehind && runtimeBehind) return { ...base, status: "WORKSPACE_BEHIND", repairability: "REPAIRABLE", runtimeReachableFromRemote };
  if (repositoryBehind && runtimeHead === remoteMain) return { ...base, status: "REPOSITORY_BEHIND", repairability: "REPAIRABLE", runtimeReachableFromRemote: true };
  if (repositoryHead === remoteMain && runtimeBehind) return { ...base, status: "RUNTIME_BEHIND", repairability: "REPAIRABLE", runtimeReachableFromRemote };
  return { ...base, status: "CANONICAL_RUNTIME_HEAD_MISMATCH", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote };
}

export async function refreshRemoteTruth({ repositoryPath, runtimePath, git = defaultGit, wait = waitMs, graceMs = REMOTE_REFRESH_GRACE_MS, maxAttempts = MAX_REMOTE_REFRESH_ATTEMPTS } = {}) {
  const result = {
    remoteFetchAttempted: false, remoteRefreshAttempts: 0, remoteMainBeforeFetch: readRef(git, repositoryPath, "refs/remotes/origin/main"), remoteMainAfterFetch: null, runtimeRemoteMainAfterFetch: null,
    remoteMainAfterFirstFetch: null, repositoryHead: readRef(git, repositoryPath, "HEAD"), runtimeHead: readRef(git, runtimePath, "HEAD"), repositoryClean: false, runtimeClean: false,
    repositoryMatchesRemote: false, runtimeMatchesRemote: false, workspaceConverged: false, runtimeReachableFromRemote: null,
    remoteRefreshStatus: "NOT_ATTEMPTED", status: "REMOTE_REF_REFRESH_FAILED", repairability: "NON_REPAIRABLE", error: null,
  };
  if (isForbiddenProductionPath(repositoryPath) || isForbiddenProductionPath(runtimePath)) return { ...result, status: "FORBIDDEN_PRODUCTION_PATH", error: "configured path is forbidden" };
  if (!fs.existsSync(repositoryPath) || !fs.existsSync(runtimePath)) return { ...result, status: "CANONICAL_RUNTIME_UNAVAILABLE", error: "canonical repository/runtime is missing" };
  try {
    result.repositoryClean = readClean(git, repositoryPath);
    result.runtimeClean = readClean(git, runtimePath);
  } catch (error) {
    return { ...result, error: errorText(error) };
  }
  if (!result.repositoryClean) return { ...result, status: "CANONICAL_REPOSITORY_DIRTY", error: "canonical repository has unknown changes" };
  if (!result.runtimeClean) return { ...result, status: "CANONICAL_RUNTIME_DIRTY", runtimeReachableFromRemote: false, error: "runtime has unknown changes" };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result.remoteFetchAttempted = true;
    result.remoteRefreshAttempts = attempt;
    try { git(repositoryPath, ["fetch", "origin", "main"]); } catch (error) { return { ...result, status: "REMOTE_REF_REFRESH_FAILED", error: errorText(error) }; }
    try { git(runtimePath, ["fetch", "origin", "main"]); } catch (error) {
      return { ...result, status: "ANCESTRY_UNAVAILABLE", repairability: "NON_REPAIRABLE", error: `runtime origin/main fetch failed: ${errorText(error)}` };
    }
    result.remoteMainAfterFetch = readRef(git, repositoryPath, "refs/remotes/origin/main");
    result.runtimeRemoteMainAfterFetch = readRef(git, runtimePath, "refs/remotes/origin/main");
    if (attempt === 1) result.remoteMainAfterFirstFetch = result.remoteMainAfterFetch;
    if (!result.remoteMainAfterFetch || result.runtimeRemoteMainAfterFetch !== result.remoteMainAfterFetch) {
      result.remoteRefreshStatus = "REMOTE_REF_MISMATCH";
      result.error = `repository/runtime origin/main mismatch: repo=${result.remoteMainAfterFetch ?? "missing"} runtime=${result.runtimeRemoteMainAfterFetch ?? "missing"}`;
      if (attempt === maxAttempts) return { ...result, status: "REMOTE_REF_REFRESH_FAILED", repairability: "NON_REPAIRABLE" };
      await wait(graceMs);
      continue;
    }
    result.remoteRefreshStatus = result.remoteMainBeforeFetch !== result.remoteMainAfterFetch ? "REMOTE_REF_REFRESHED" : "REMOTE_REF_CONFIRMED";
    result.repositoryHead = readRef(git, repositoryPath, "HEAD");
    result.runtimeHead = readRef(git, runtimePath, "HEAD");
    const classification = runtimeClassification({ repositoryPath, runtimePath, git, remoteMain: result.remoteMainAfterFetch, repositoryHead: result.repositoryHead, repositoryClean: result.repositoryClean, runtimeClean: result.runtimeClean, runtimeHead: result.runtimeHead });
    Object.assign(result, classification);
    if (!["RUNTIME_AHEAD", "ANCESTRY_UNAVAILABLE"].includes(classification.status) || attempt === maxAttempts) return result;
    await wait(graceMs);
  }
  return result;
}

export function safeSyncRuntimeToRemote({ runtimePath, remoteMain, git = defaultGit } = {}) {
  if (!runtimePath || !remoteMain) return { ok: false, repairs: [], reason: "runtime or remote main is unavailable" };
  try {
    if (!readClean(git, runtimePath)) return { ok: false, repairs: [], reason: "runtime is dirty" };
    git(runtimePath, ["fetch", "origin", "main"]);
    git(runtimePath, ["merge", "--ff-only", remoteMain]);
    const runtimeHead = readRef(git, runtimePath, "HEAD");
    if (runtimeHead !== remoteMain) return { ok: false, repairs: [], reason: `runtime did not reach ${remoteMain}` };
    return { ok: true, repairs: ["sync_runtime_to_fresh_origin_main"], runtimeHead };
  } catch (error) {
    return { ok: false, repairs: [], reason: errorText(error) };
  }
}

export function safeSyncWorkspaceToRemote({ repositoryPath, runtimePath, remoteMain, git = defaultGit } = {}) {
  if (!repositoryPath || !runtimePath || !remoteMain) return { ok: false, repairs: [], reason: "workspace or remote main is unavailable" };
  const repairs = [];
  try {
    if (!readClean(git, repositoryPath)) return { ok: false, repairs, reason: "canonical repository is dirty" };
    if (!readClean(git, runtimePath)) return { ok: false, repairs, reason: "runtime is dirty" };
    if (readRef(git, repositoryPath, "HEAD") !== remoteMain) {
      git(repositoryPath, ["fetch", "origin", "main"]);
      git(repositoryPath, ["merge", "--ff-only", remoteMain]);
      repairs.push("sync_repository_to_fresh_origin_main");
    }
    if (readRef(git, runtimePath, "HEAD") !== remoteMain) {
      git(runtimePath, ["fetch", "origin", "main"]);
      git(runtimePath, ["merge", "--ff-only", remoteMain]);
      repairs.push("sync_runtime_to_fresh_origin_main");
    }
    const repositoryHead = readRef(git, repositoryPath, "HEAD");
    const runtimeHead = readRef(git, runtimePath, "HEAD");
    if (repositoryHead !== remoteMain || runtimeHead !== remoteMain) return { ok: false, repairs, reason: `workspace did not converge: repo=${repositoryHead} runtime=${runtimeHead} remote=${remoteMain}` };
    return { ok: true, repairs, repositoryHead, runtimeHead, remoteMain };
  } catch (error) { return { ok: false, repairs, reason: errorText(error) }; }
}

function runLedgerValidation(runtimePath) {
  try {
    execFileSync(process.execPath, [path.join(runtimePath, "scripts", "validate-prediction-ledger.mjs")], { cwd: runtimePath, encoding: "utf8", windowsHide: true, timeout: 5 * 60_000, stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch { return false; }
}

export function validateExistingPublisherHead({ editionDate, runtimePath, runtimeHead, remoteMain = null, executionReceipt, dailyPacket, reviewPacket, publisherProcessActive = false, globalLockActive = false, git = defaultGit, ledgerValidation = null } = {}) {
  const checks = { noActivePublisher: !publisherProcessActive && !globalLockActive, receipt: false, packets: false, lineage: false, commit: false, paths: false, ledger: false };
  if (!checks.noActivePublisher) return { ok: false, reason: "active Publisher or global lock remains", checks };
  checks.receipt = executionReceipt?.editionDate === editionDate && executionReceipt.writeApplied === true && executionReceipt.commit?.ok === true && executionReceipt.status === "failed" && /push/i.test(String(executionReceipt.error ?? executionReceipt.errorCode ?? ""));
  checks.packets = Boolean(dailyPacket?.found && dailyPacket.valid && reviewPacket?.found && reviewPacket.valid);
  if (!runtimePath || !runtimeHead || !checks.receipt || !checks.packets) return { ok: false, reason: "existing Publisher receipt or sealed packets are invalid", checks };
  const commitMessage = (() => { try { return gitText(git, runtimePath, ["log", "-1", "--format=%s", runtimeHead]); } catch { return null; } })();
  const reportedSha = executionReceipt.commit?.sha ?? null;
  checks.lineage = !remoteMain || gitAncestorRelation(git, runtimePath, remoteMain, runtimeHead) === "ancestor" || remoteMain === runtimeHead;
  checks.commit = Boolean(commitMessage && commitMessage.includes(editionDate) && /publish/i.test(commitMessage) && (!reportedSha || reportedSha === runtimeHead));
  const paths = changedCommitPaths(git, runtimePath, runtimeHead);
  checks.paths = Array.isArray(paths) && paths.length > 0 && paths.every(pathAllowed);
  const ledgerResult = typeof ledgerValidation === "function" ? ledgerValidation() : ledgerValidation;
  checks.ledger = ledgerResult === null ? runLedgerValidation(runtimePath) : ledgerResult === true || ledgerResult?.ok === true;
  return { ok: Object.values(checks).every(Boolean), reason: Object.values(checks).every(Boolean) ? null : "existing Publisher HEAD validation failed", checks, paths, commitMessage };
}

export function pushExistingPublisherHead({ editionDate, runtimePath, runtimeHead, remoteMain = null, executionReceipt, dailyPacket, reviewPacket, publisherProcessActive = false, globalLockActive = false, git = defaultGit, ledgerValidation = null, command, env = process.env } = {}) {
  const validation = validateExistingPublisherHead({ editionDate, runtimePath, runtimeHead, remoteMain, executionReceipt, dailyPacket, reviewPacket, publisherProcessActive, globalLockActive, git, ledgerValidation });
  if (!validation.ok) return { ok: false, repairs: [], reason: validation.reason, validation };
  const push = pushCurrentHeadToMain({ root: runtimePath, command, env });
  if (!push.ok) return { ok: false, repairs: [], reason: `${push.errorCode}: ${push.detail}`, validation, push };
  return { ok: true, repairs: ["PUBLISH_EXISTING_PRODUCTION_HEAD"], validation, push };
}

function mergeRuntimeTruthIntoReceipt(receipt, runtimeTruth = {}) {
  receipt.remoteFetchAttempted = Boolean(runtimeTruth.remoteFetchAttempted);
  receipt.remoteRefreshAttempts = runtimeTruth.remoteRefreshAttempts ?? 0;
  receipt.remoteMainBeforeFetch = runtimeTruth.remoteMainBeforeFetch ?? null;
  receipt.remoteMainAfterFetch = runtimeTruth.remoteMainAfterFetch ?? null;
  receipt.runtimeRemoteMainAfterFetch = runtimeTruth.runtimeRemoteMainAfterFetch ?? null;
  receipt.remoteRefreshStatus = runtimeTruth.remoteRefreshStatus ?? "NOT_ATTEMPTED";
  receipt.repositoryHead = runtimeTruth.repositoryHead ?? null;
  receipt.repositoryMatchesRemote = runtimeTruth.repositoryMatchesRemote ?? false;
  receipt.runtimeHead = runtimeTruth.runtimeHead ?? null;
  receipt.runtimeMatchesRemote = runtimeTruth.runtimeMatchesRemote ?? false;
  receipt.workspaceConverged = runtimeTruth.workspaceConverged ?? false;
  receipt.runtimeReachableFromRemote = runtimeTruth.runtimeReachableFromRemote ?? null;
  receipt.repairability = runtimeTruth.repairability ?? "UNKNOWN";
}

function packetEvidence(file, name, editionDate, validator = validateEveningPacket) {
  if (!file || !fs.existsSync(file)) return { found: false, valid: false, path: file ?? null, packet: null, error: "missing" };
  const packet = readJson(file);
  if (!packet) return { found: true, valid: false, path: file, packet: null, error: "invalid_json" };
  try {
    validator(packet, name);
    if (name === "DAILY_MARKET_PACKET.json" && packet.editionDate !== editionDate) throw new Error("edition mismatch");
    if (name === "PREDICTION_REVIEW_PACKET.json" && packet.asOfDate > editionDate) throw new Error("future review");
    return { found: true, valid: true, path: file, packet, error: null };
  } catch (error) { return { found: true, valid: false, path: file, packet, error: error instanceof Error ? error.message : String(error) }; }
}

export function evaluatePublisherEvidence({ editionDate, task = {}, executionReceipt = null, dailyPacket = null, reviewPacket = null, publisherProcessActive = false, globalLockActive = false, runtimeTruth = null } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", "editionDate must be YYYY-MM-DD");
  const receiptStatus = executionReceipt?.editionDate === editionDate ? String(executionReceipt.status ?? executionReceipt.publisherStatus ?? "").toLowerCase() : "";
  const receiptSuccess = executionReceipt?.editionDate === editionDate && (SUCCESS_STATUSES.has(receiptStatus) || executionReceipt.writeApplied === true) && executionReceipt.status !== "failed";
  const packetSuccess = (dailyPacket?.found && dailyPacket.valid) || (reviewPacket?.found && reviewPacket.valid);
  const publisherExecuted = receiptSuccess || packetSuccess;
  const stillRunning = Boolean(publisherProcessActive || globalLockActive);
  let finalStatus = "RECOVERY_REQUIRED";
  if (stillRunning) finalStatus = "PUBLISHER_STILL_RUNNING";
  else if (runtimeTruth?.status && RUNTIME_BLOCKING_STATUSES.has(runtimeTruth.status)) finalStatus = runtimeTruth.status;
  else if (runtimeTruth?.status && WORKSPACE_REPAIRABLE_STATUSES.has(runtimeTruth.status)) finalStatus = runtimeTruth.status;
  else if (publisherExecuted) finalStatus = "HEALTHY_NO_ACTION";
  return {
    publisherExecuted, publisherResult: receiptSuccess ? (receiptStatus === "no-op" || receiptStatus === "noop" || receiptStatus === "no_op" ? "NO_OP" : "SUCCESS") : null,
    packetState: dailyPacket?.valid || reviewPacket?.valid ? (dailyPacket?.valid && reviewPacket?.valid ? "valid" : "partial-valid") : "missing",
    finalStatus, recoveryRequired: finalStatus === "RECOVERY_REQUIRED" || WORKSPACE_REPAIRABLE_STATUSES.has(finalStatus), stillRunning,
    taskExists: task.exists === true, taskEnabled: ACTIVE_TASK_STATUSES.has(task.status),
  };
}

function receiptBase({ editionDate, checkedAt, scheduledRunExpectedAt, task, evidence, finalStatus = "RECOVERY_FAILED" }) {
  const runtimeTruth = evidence?.runtimeTruth ?? {};
  return {
    schemaVersion: GUARDIAN_RECEIPT_SCHEMA, editionDate, checkedAt, scheduledRunExpectedAt,
    taskExists: Boolean(task?.exists), taskEnabled: ACTIVE_TASK_STATUSES.has(task?.status),
    lastRunTime: task?.lastRunTime ?? null, lastTaskResult: task?.lastTaskResult ?? null,
    publisherProcessActive: Boolean(evidence?.publisherProcessActive), publisherReceiptFound: Boolean(evidence?.executionReceipt),
    dailyPacketFound: Boolean(evidence?.dailyPacket?.found && evidence.dailyPacket.valid), reviewPacketFound: Boolean(evidence?.reviewPacket?.found && evidence.reviewPacket.valid),
    publisherStatus: evidence?.publisherResult ?? (evidence?.publisherExecuted ? "SUCCESS" : "NOT_EXECUTED"), repairAttempted: false, repairs: [], recoveryRunAttempted: false, recoveryRunResult: null,
    remoteFetchAttempted: Boolean(runtimeTruth.remoteFetchAttempted), remoteRefreshAttempts: runtimeTruth.remoteRefreshAttempts ?? 0,
    remoteMainBeforeFetch: runtimeTruth.remoteMainBeforeFetch ?? null, remoteMainAfterFetch: runtimeTruth.remoteMainAfterFetch ?? null,
    runtimeRemoteMainAfterFetch: runtimeTruth.runtimeRemoteMainAfterFetch ?? null,
    remoteRefreshStatus: runtimeTruth.remoteRefreshStatus ?? "NOT_ATTEMPTED",
    repositoryHead: runtimeTruth.repositoryHead ?? null, repositoryMatchesRemote: runtimeTruth.repositoryMatchesRemote ?? false,
    runtimeHead: runtimeTruth.runtimeHead ?? null, runtimeMatchesRemote: runtimeTruth.runtimeMatchesRemote ?? false,
    workspaceConverged: runtimeTruth.workspaceConverged ?? false, runtimeReachableFromRemote: runtimeTruth.runtimeReachableFromRemote ?? null,
    consistencyStatus: evidence?.consistencyStatus ?? "NOT_CHECKED", repairability: runtimeTruth.repairability ?? "UNKNOWN",
    finalStatus,
  };
}

async function persistReceipt(writeReceipt, receipt) {
  if (typeof writeReceipt !== "function") return;
  await writeReceipt(receipt);
}

export async function runPublisherGuardian({ editionDate, checkedAt = new Date().toISOString(), scheduledRunExpectedAt = null, task = {}, evidence = {}, repair = async () => ({ ok: false, repairs: [], reason: "no repair handler" }), runPublisher = async () => ({ status: "failed", error: "no publisher handler" }), writeReceipt = null } = {}) {
  let initial;
  try {
    initial = evaluatePublisherEvidence({ editionDate, task, ...evidence });
  } catch (error) {
    const receipt = receiptBase({ editionDate, checkedAt, scheduledRunExpectedAt, task, evidence, finalStatus: error.code ?? "RECOVERY_FAILED" });
    receipt.error = errorText(error);
    await persistReceipt(writeReceipt, receipt);
    return receipt;
  }
  const receipt = receiptBase({ editionDate, checkedAt, scheduledRunExpectedAt, task, evidence: { ...evidence, ...initial }, finalStatus: initial.finalStatus });
  if (isSunday(editionDate)) {
    receipt.publisherStatus = "SUNDAY_NO_RUN";
    receipt.finalStatus = "HEALTHY_NO_ACTION";
    await persistReceipt(writeReceipt, receipt);
    return receipt;
  }
  if (initial.finalStatus === "PUBLISHER_STILL_RUNNING" || initial.finalStatus === "HEALTHY_NO_ACTION") {
    await persistReceipt(writeReceipt, receipt);
    return receipt;
  }
  if (RUNTIME_BLOCKING_STATUSES.has(initial.finalStatus)) {
    await persistReceipt(writeReceipt, receipt);
    return receipt;
  }

  receipt.repairAttempted = true;
  let repairResult;
  try { repairResult = await repair({ editionDate, task, evidence, maxAttempts: MAX_GUARDIAN_PUBLISHER_RETRY }); } catch (error) { repairResult = { ok: false, repairs: [], reason: errorText(error) }; }
  receipt.repairs = Array.isArray(repairResult?.repairs) ? repairResult.repairs : [];
  if (!repairResult?.ok) {
    receipt.finalStatus = "RECOVERY_FAILED";
    receipt.recoveryRunResult = "repair_failed";
    receipt.error = repairResult?.reason ?? "repair failed";
    await persistReceipt(writeReceipt, receipt);
    return receipt;
  }
  if (repairResult?.finalEvidence?.runtimeTruth) mergeRuntimeTruthIntoReceipt(receipt, repairResult.finalEvidence.runtimeTruth);
  if (initial.publisherExecuted || repairResult?.publisherAlreadySucceeded === true || repairResult?.noRecovery === true) {
    receipt.finalStatus = "HEALTHY_NO_ACTION";
    receipt.recoveryRunResult = "not_required";
    await persistReceipt(writeReceipt, receipt);
    return receipt;
  }
  receipt.recoveryRunAttempted = true;
  let recovery;
  try { recovery = await runPublisher({ editionDate, attempt: 1, maxAttempts: MAX_GUARDIAN_PUBLISHER_RETRY }); } catch (error) { recovery = { status: "failed", error: errorText(error) }; }
  receipt.recoveryRunResult = recovery?.status ?? "failed";
  if (String(recovery?.status ?? "").toLowerCase() === "immutable_conflict" || recovery?.errorCode === "EVENING_PACKET_IMMUTABLE_CONFLICT" || recovery?.errorCode === "IMMUTABLE_CONFLICT") receipt.finalStatus = "PREDICTION_CONFLICT";
  else if (SUCCESS_STATUSES.has(String(recovery?.status ?? "").toLowerCase())) receipt.finalStatus = "RECOVERED";
  else receipt.finalStatus = "RECOVERY_FAILED";
  if (recovery?.error) receipt.error = recovery.error;
  await persistReceipt(writeReceipt, receipt);
  return receipt;
}

export function readPublisherEvidence({ editionDate, paths = resolveAutomationPaths(), taskName = "Guanchao Prediction Publisher 18-20" } = {}) {
  const runDirectory = path.join(paths.runsRoot, editionDate, "prediction");
  const packets = path.join(paths.eveningPacketsRoot, editionDate);
  const lockFile = path.join(paths.runsRoot, "..", ".guanchao-automation.lock");
  const lock = readJson(lockFile);
  const executionFile = path.join(runDirectory, "prediction-publisher-report.json");
  const executionReceipt = readJson(executionFile);
  const dailyPacket = packetEvidence(path.join(packets, "DAILY_MARKET_PACKET.json"), "DAILY_MARKET_PACKET.json", editionDate);
  const reviewPacket = packetEvidence(path.join(packets, "PREDICTION_REVIEW_PACKET.json"), "PREDICTION_REVIEW_PACKET.json", editionDate);
  return { task: readScheduledTask(taskName), executionReceipt, executionReceiptPath: executionFile, dailyPacket, reviewPacket, publisherProcessActive: processActive(lock?.pid), globalLockActive: processActive(lock?.pid) };
}

export function readConsistencyDiagnostic({ checker = checkAutomationConsistency } = {}) {
  try {
    const report = checker({ runProductionPreflight: false });
    return { status: report?.consistent === true ? "PASS" : "DRIFT", failedChecks: Array.isArray(report?.checks) ? report.checks.filter((check) => !check.passed).map((check) => check.name) : [] };
  } catch (error) { return { status: "UNAVAILABLE", failedChecks: [], error: errorText(error) }; }
}

export function writeGuardianReceipt(file, receipt) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
  return target;
}

function runPublisherOnce({ editionDate, paths }) {
  const output = execFileSync(process.execPath, [path.join(paths.runtimePath, "scripts", "run-prediction-publisher.mjs"), "--edition-date", editionDate, "--write"], { cwd: paths.runtimePath, encoding: "utf8", windowsHide: true, timeout: 20 * 60_000 });
  const start = output.lastIndexOf("{");
  return start >= 0 ? JSON.parse(output.slice(start)) : { status: "failed", error: "publisher output was not JSON" };
}

async function runCli() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => { if (value.startsWith("--")) pairs.push([value.slice(2), values[index + 1] && !values[index + 1].startsWith("--") ? values[index + 1] : true]); return pairs; }, []));
  const paths = resolveAutomationPaths({ env: { ...process.env, ...(args["guanchao-home"] ? { GUANCHAO_HOME: args["guanchao-home"] } : {}) } });
  const editionDate = args["edition-date"] ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const receiptDirectory = DATE.test(String(editionDate)) ? editionDate : "invalid-edition";
  const receiptPath = path.resolve(args.receipt ?? path.join(paths.runsRoot, receiptDirectory, "guardian", "PUBLISHER_GUARDIAN_RECEIPT.json"));
  let result;
  try {
    if (!DATE.test(String(editionDate))) fail("INVALID_EDITION_DATE", "editionDate must be YYYY-MM-DD");
    const runtimeTruth = await refreshRemoteTruth({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath });
    const consistency = readConsistencyDiagnostic();
    const current = readPublisherEvidence({ editionDate, paths, taskName: args["task-name"] ?? "Guanchao Prediction Publisher 18-20" });
    const evidence = { ...current, runtimeTruth, consistencyStatus: consistency.status };
    result = await runPublisherGuardian({ editionDate, scheduledRunExpectedAt: `${editionDate}T18:20:00+08:00`, task: current.task, evidence, repair: async ({ task, evidence: repairEvidence }) => {
      const repairs = [];
      const runtimeTruth = repairEvidence.runtimeTruth ?? {};
      const workspaceRepairable = WORKSPACE_REPAIRABLE_STATUSES.has(runtimeTruth.status);
      let repairRemoteMain = runtimeTruth.remoteMainAfterFetch;
      if (runtimeTruth.status === "RUNTIME_AHEAD") {
        if (args.write !== true) return { ok: false, repairs, reason: "existing production HEAD recovery requires --write" };
        const existing = pushExistingPublisherHead({
          editionDate, runtimePath: paths.runtimePath, runtimeHead: runtimeTruth.runtimeHead,
          remoteMain: runtimeTruth.remoteMainAfterFetch,
          executionReceipt: repairEvidence.executionReceipt, dailyPacket: repairEvidence.dailyPacket, reviewPacket: repairEvidence.reviewPacket,
          publisherProcessActive: repairEvidence.publisherProcessActive, globalLockActive: repairEvidence.globalLockActive,
        });
        if (!existing.ok) return { ok: false, repairs, reason: `existing production HEAD is not recoverable: ${existing.reason}` };
        repairs.push(...existing.repairs);
        repairRemoteMain = existing.push.remoteMainAfterPush;
      }
      if (workspaceRepairable) {
        if (args.write !== true) return { ok: false, repairs, reason: "workspace convergence requires --write" };
        const sync = safeSyncWorkspaceToRemote({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath, remoteMain: repairRemoteMain });
        repairs.push(...sync.repairs);
        if (!sync.ok) return { ok: false, repairs, reason: sync.reason };
        const finalRuntimeTruth = await refreshRemoteTruth({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath });
        const finalCurrent = readPublisherEvidence({ editionDate, paths, taskName: args["task-name"] ?? "Guanchao Prediction Publisher 18-20" });
        const finalEvidence = { ...finalCurrent, runtimeTruth: finalRuntimeTruth, consistencyStatus: consistency.status };
        const finalEvaluation = evaluatePublisherEvidence({ editionDate, task: finalCurrent.task, ...finalEvidence });
        return { ok: true, repairs, noRecovery: finalEvaluation.publisherExecuted, publisherAlreadySucceeded: finalEvaluation.publisherExecuted, finalEvidence };
      }
      if (!task.exists) return { ok: false, repairs, reason: "prediction task missing; no safe repair target" };
      if (task.status === "Disabled" && args.write === true) { execFileSync("schtasks.exe", ["/Change", "/TN", task.taskName, "/ENABLE"], { windowsHide: true }); repairs.push("enabled_prediction_task"); }
      fs.mkdirSync(path.dirname(current.executionReceiptPath), { recursive: true });
      fs.mkdirSync(path.join(paths.runsRoot, editionDate, "guardian"), { recursive: true });
      return { ok: true, repairs };
    }, runPublisher: async () => args.write === true ? runPublisherOnce({ editionDate, paths }) : ({ status: "dry-run" }), writeReceipt: async (value) => writeGuardianReceipt(receiptPath, value) });
  } catch (error) {
    const receipt = receiptBase({ editionDate, checkedAt: new Date().toISOString(), scheduledRunExpectedAt: `${editionDate}T18:20:00+08:00`, task: {}, evidence: {}, finalStatus: error.code ?? "RECOVERY_FAILED" });
    receipt.error = errorText(error);
    writeGuardianReceipt(receiptPath, receipt);
    result = receipt;
  }
  console.log(JSON.stringify({ ...result, receiptPath }, null, 2));
  if (["RECOVERY_FAILED", "PREDICTION_CONFLICT", "CANONICAL_RUNTIME_HEAD_MISMATCH", "CANONICAL_RUNTIME_UNAVAILABLE", "CANONICAL_RUNTIME_DIRTY", "CANONICAL_REPOSITORY_DIRTY", "REMOTE_REF_REFRESH_FAILED", "ANCESTRY_UNAVAILABLE", "FORBIDDEN_PRODUCTION_PATH"].includes(result.finalStatus)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) runCli().catch((error) => { console.error(`${error.code ?? "PUBLISHER_GUARDIAN_FAILURE"} ${error.message}`); process.exitCode = 1; });
