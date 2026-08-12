import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkAutomationConsistency, readScheduledTask } from "./check-automation-consistency.mjs";
import { isForbiddenProductionPath, resolveAutomationPaths } from "./automation-paths.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";

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
]);

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
function isAncestor(git, cwd, ancestor, descendant) {
  try { git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]); return true; } catch { return false; }
}
function waitMs(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function runtimeClassification({ repositoryPath, runtimePath, git, remoteMain, repositoryClean, runtimeClean, runtimeHead }) {
  if (isForbiddenProductionPath(repositoryPath) || isForbiddenProductionPath(runtimePath)) return { status: "FORBIDDEN_PRODUCTION_PATH", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: null };
  if (!repositoryClean) return { status: "CANONICAL_REPOSITORY_DIRTY", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: null };
  if (!runtimeClean) return { status: "CANONICAL_RUNTIME_DIRTY", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
  if (!runtimeHead || !remoteMain) return { status: "CANONICAL_RUNTIME_UNAVAILABLE", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
  if (runtimeHead === remoteMain) return { status: "HEALTHY", repairability: "NONE", runtimeReachableFromRemote: true };
  if (isAncestor(git, runtimePath, runtimeHead, remoteMain)) return { status: "RUNTIME_BEHIND", repairability: "REPAIRABLE", runtimeReachableFromRemote: true };
  if (isAncestor(git, runtimePath, remoteMain, runtimeHead)) return { status: "RUNTIME_AHEAD", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
  return { status: "CANONICAL_RUNTIME_HEAD_MISMATCH", repairability: "NON_REPAIRABLE", runtimeReachableFromRemote: false };
}

export async function refreshRemoteTruth({ repositoryPath, runtimePath, git = defaultGit, wait = waitMs, graceMs = REMOTE_REFRESH_GRACE_MS, maxAttempts = MAX_REMOTE_REFRESH_ATTEMPTS } = {}) {
  const result = {
    remoteFetchAttempted: false, remoteRefreshAttempts: 0, remoteMainBeforeFetch: readRef(git, repositoryPath, "refs/remotes/origin/main"), remoteMainAfterFetch: null,
    remoteMainAfterFirstFetch: null, repositoryHead: readRef(git, repositoryPath, "HEAD"), runtimeHead: readRef(git, runtimePath, "HEAD"), repositoryClean: false, runtimeClean: false,
    runtimeReachableFromRemote: null, remoteRefreshStatus: "NOT_ATTEMPTED", status: "REMOTE_REF_REFRESH_FAILED", repairability: "NON_REPAIRABLE", error: null,
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
    result.remoteMainAfterFetch = readRef(git, repositoryPath, "refs/remotes/origin/main");
    if (attempt === 1) result.remoteMainAfterFirstFetch = result.remoteMainAfterFetch;
    result.remoteRefreshStatus = result.remoteMainBeforeFetch !== result.remoteMainAfterFetch ? "REMOTE_REF_REFRESHED" : "REMOTE_REF_CONFIRMED";
    result.repositoryHead = readRef(git, repositoryPath, "HEAD");
    result.runtimeHead = readRef(git, runtimePath, "HEAD");
    const classification = runtimeClassification({ repositoryPath, runtimePath, git, remoteMain: result.remoteMainAfterFetch, repositoryClean: result.repositoryClean, runtimeClean: result.runtimeClean, runtimeHead: result.runtimeHead });
    Object.assign(result, classification);
    if (classification.status !== "RUNTIME_AHEAD" || attempt === maxAttempts) return result;
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
  if (runtimeTruth?.status && RUNTIME_BLOCKING_STATUSES.has(runtimeTruth.status)) finalStatus = runtimeTruth.status;
  else if (stillRunning) finalStatus = "PUBLISHER_STILL_RUNNING";
  else if (runtimeTruth?.status === "RUNTIME_AHEAD") finalStatus = "CANONICAL_RUNTIME_HEAD_MISMATCH";
  else if (runtimeTruth?.status === "RUNTIME_BEHIND") finalStatus = "RUNTIME_BEHIND";
  else if (publisherExecuted) finalStatus = "HEALTHY_NO_ACTION";
  return {
    publisherExecuted, publisherResult: receiptSuccess ? (receiptStatus === "no-op" || receiptStatus === "noop" || receiptStatus === "no_op" ? "NO_OP" : "SUCCESS") : null,
    packetState: dailyPacket?.valid || reviewPacket?.valid ? (dailyPacket?.valid && reviewPacket?.valid ? "valid" : "partial-valid") : "missing",
    finalStatus, recoveryRequired: ["RECOVERY_REQUIRED", "RUNTIME_BEHIND"].includes(finalStatus), stillRunning,
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
    remoteRefreshStatus: runtimeTruth.remoteRefreshStatus ?? "NOT_ATTEMPTED",
    runtimeHead: runtimeTruth.runtimeHead ?? null, runtimeReachableFromRemote: runtimeTruth.runtimeReachableFromRemote ?? null,
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
  if (initial.publisherExecuted) {
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
      if (repairEvidence.runtimeTruth?.status === "RUNTIME_BEHIND") {
        if (args.write !== true) return { ok: false, repairs, reason: "runtime sync requires --write" };
        const sync = safeSyncRuntimeToRemote({ runtimePath: paths.runtimePath, remoteMain: repairEvidence.runtimeTruth.remoteMainAfterFetch });
        repairs.push(...sync.repairs);
        if (!sync.ok) return { ok: false, repairs, reason: sync.reason };
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
  if (["RECOVERY_FAILED", "PREDICTION_CONFLICT", "CANONICAL_RUNTIME_HEAD_MISMATCH", "CANONICAL_RUNTIME_DIRTY", "CANONICAL_REPOSITORY_DIRTY", "REMOTE_REF_REFRESH_FAILED", "FORBIDDEN_PRODUCTION_PATH"].includes(result.finalStatus)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) runCli().catch((error) => { console.error(`${error.code ?? "PUBLISHER_GUARDIAN_FAILURE"} ${error.message}`); process.exitCode = 1; });
