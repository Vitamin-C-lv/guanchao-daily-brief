import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readScheduledTask } from "./check-automation-consistency.mjs";
import { resolveAutomationPaths } from "./automation-paths.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_GUARDIAN_PUBLISHER_RETRY = 1;
export const GUARDIAN_RECEIPT_SCHEMA = "publisher-guardian-receipt-v1";
const SUCCESS_STATUSES = new Set(["published", "success", "no-op", "noop", "NO_OP"]);

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function dateAtNoon(date) { return new Date(`${date}T12:00:00+08:00`); }
function isSunday(date) { return dateAtNoon(date).getUTCDay() === 0; }
function processActive(pid) { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
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

export function evaluatePublisherEvidence({ editionDate, task = {}, executionReceipt = null, dailyPacket = null, reviewPacket = null, publisherProcessActive = false, globalLockActive = false } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", "editionDate must be YYYY-MM-DD");
  const receiptStatus = executionReceipt?.editionDate === editionDate ? String(executionReceipt.status ?? executionReceipt.publisherStatus ?? "").toLowerCase() : "";
  const receiptSuccess = executionReceipt?.editionDate === editionDate && (SUCCESS_STATUSES.has(receiptStatus) || executionReceipt.writeApplied === true) && executionReceipt.status !== "failed";
  const packetSuccess = (dailyPacket?.found && dailyPacket.valid) || (reviewPacket?.found && reviewPacket.valid);
  const publisherExecuted = receiptSuccess || packetSuccess;
  const stillRunning = Boolean(publisherProcessActive || globalLockActive);
  let finalStatus = "RECOVERY_REQUIRED";
  if (stillRunning) finalStatus = "PUBLISHER_STILL_RUNNING";
  else if (publisherExecuted) finalStatus = "HEALTHY_NO_ACTION";
  return {
    publisherExecuted, publisherResult: receiptSuccess ? (receiptStatus === "no-op" || receiptStatus === "noop" || receiptStatus === "no_op" ? "NO_OP" : "SUCCESS") : null,
    packetState: dailyPacket?.valid || reviewPacket?.valid ? (dailyPacket?.valid && reviewPacket?.valid ? "valid" : "partial-valid") : "missing",
    finalStatus, recoveryRequired: finalStatus === "RECOVERY_REQUIRED", stillRunning,
    taskExists: task.exists === true, taskEnabled: task.status === "Ready" || task.status === "Running" || task.status === "就绪" || task.status === "正在运行",
  };
}

function receiptBase({ editionDate, checkedAt, scheduledRunExpectedAt, task, evidence }) {
  return {
    schemaVersion: GUARDIAN_RECEIPT_SCHEMA, editionDate, checkedAt, scheduledRunExpectedAt,
    taskExists: Boolean(task?.exists), taskEnabled: task?.status === "Ready" || task?.status === "Running" || task?.status === "就绪" || task?.status === "正在运行",
    lastRunTime: task?.lastRunTime ?? null, lastTaskResult: task?.lastTaskResult ?? null,
    publisherProcessActive: Boolean(evidence?.publisherProcessActive), publisherReceiptFound: Boolean(evidence?.executionReceipt),
    dailyPacketFound: Boolean(evidence?.dailyPacket?.found && evidence.dailyPacket.valid), reviewPacketFound: Boolean(evidence?.reviewPacket?.found && evidence.reviewPacket.valid),
    publisherStatus: evidence?.publisherResult ?? (evidence?.publisherExecuted ? "SUCCESS" : "NOT_EXECUTED"), repairAttempted: false, repairs: [], recoveryRunAttempted: false, recoveryRunResult: null,
    finalStatus: evidence?.finalStatus ?? "RECOVERY_FAILED",
  };
}

export async function runPublisherGuardian({ editionDate, checkedAt = new Date().toISOString(), scheduledRunExpectedAt = null, task = {}, evidence = {}, repair = async () => ({ ok: false, repairs: [], reason: "no repair handler" }), runPublisher = async () => ({ status: "failed", error: "no publisher handler" }), writeReceipt = null } = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("INVALID_EDITION_DATE", "editionDate must be YYYY-MM-DD");
  const initial = evaluatePublisherEvidence({ editionDate, task, ...evidence });
  const receipt = receiptBase({ editionDate, checkedAt, scheduledRunExpectedAt, task, evidence: { ...evidence, ...initial } });
  if (isSunday(editionDate) || initial.finalStatus === "HEALTHY_NO_ACTION" || initial.finalStatus === "PUBLISHER_STILL_RUNNING") {
    if (isSunday(editionDate)) {
      receipt.publisherStatus = "SUNDAY_NO_RUN";
      receipt.finalStatus = "HEALTHY_NO_ACTION";
    }
    if (typeof writeReceipt === "function") await writeReceipt(receipt);
    return receipt;
  }
  receipt.repairAttempted = true;
  let repairResult;
  try { repairResult = await repair({ editionDate, task, evidence, maxAttempts: MAX_GUARDIAN_PUBLISHER_RETRY }); } catch (error) { repairResult = { ok: false, repairs: [], reason: String(error?.message ?? error) }; }
  receipt.repairs = Array.isArray(repairResult?.repairs) ? repairResult.repairs : [];
  if (!repairResult?.ok) {
    receipt.finalStatus = "RECOVERY_FAILED";
    receipt.recoveryRunResult = "repair_failed";
    if (typeof writeReceipt === "function") await writeReceipt(receipt);
    return receipt;
  }
  receipt.recoveryRunAttempted = true;
  let recovery;
  try { recovery = await runPublisher({ editionDate, attempt: 1, maxAttempts: MAX_GUARDIAN_PUBLISHER_RETRY }); } catch (error) { recovery = { status: "failed", error: String(error?.message ?? error) }; }
  receipt.recoveryRunResult = recovery?.status ?? "failed";
  if (String(recovery?.status ?? "").toLowerCase() === "immutable_conflict" || recovery?.errorCode === "EVENING_PACKET_IMMUTABLE_CONFLICT" || recovery?.errorCode === "IMMUTABLE_CONFLICT") receipt.finalStatus = "PREDICTION_CONFLICT";
  else if (SUCCESS_STATUSES.has(String(recovery?.status ?? "").toLowerCase())) receipt.finalStatus = "RECOVERED";
  else receipt.finalStatus = "RECOVERY_FAILED";
  if (typeof writeReceipt === "function") await writeReceipt(receipt);
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
  const current = readPublisherEvidence({ editionDate, paths, taskName: args["task-name"] ?? "Guanchao Prediction Publisher 18-20" });
  const receiptPath = path.resolve(args.receipt ?? path.join(paths.runsRoot, editionDate, "guardian", "PUBLISHER_GUARDIAN_RECEIPT.json"));
  const result = await runPublisherGuardian({ editionDate, scheduledRunExpectedAt: `${editionDate}T18:20:00+08:00`, task: current.task, evidence: current, repair: async ({ task }) => {
    const repairs = [];
    if (!task.exists) return { ok: false, repairs, reason: "prediction task missing; no safe repair target" };
    if (task.status === "Disabled" && args.write === true) { execFileSync("schtasks.exe", ["/Change", "/TN", task.taskName, "/ENABLE"], { windowsHide: true }); repairs.push("enabled_prediction_task"); }
    fs.mkdirSync(path.dirname(current.executionReceiptPath), { recursive: true });
    fs.mkdirSync(path.join(paths.runsRoot, editionDate, "guardian"), { recursive: true });
    return { ok: true, repairs };
  }, runPublisher: async () => args.write === true ? runPublisherOnce({ editionDate, paths }) : ({ status: "dry-run" }), writeReceipt: async (value) => { if (args["dry-run"] === true || args.write === true) writeGuardianReceipt(receiptPath, value); } });
  console.log(JSON.stringify({ ...result, receiptPath }, null, 2));
  if (["RECOVERY_FAILED", "PREDICTION_CONFLICT"].includes(result.finalStatus)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) runCli().catch((error) => { console.error(`${error.code ?? "PUBLISHER_GUARDIAN_FAILURE"} ${error.message}`); process.exitCode = 1; });
