#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readScheduledTask } from "./check-automation-consistency.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalizeRrule(value) {
  return [...new Set(String(value ?? "").split(";").filter(Boolean).filter((part) => !part.startsWith("BYSECOND")).map((part) => part.trim()))].sort().join(";");
}

function parseToml(text) {
  const get = (key) => text?.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
  const promptMatch = text?.match(/^prompt\s*=\s*('''[\s\S]*?'''|"""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/m);
  let prompt = null;
  if (promptMatch) {
    const raw = promptMatch[1];
    prompt = raw.startsWith("'''") ? raw.slice(3, -3) : raw.startsWith('"""') ? raw.slice(3, -3) : JSON.parse(raw);
  }
  const cwds = [...(text?.match(/^cwds\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => item[1].replaceAll("\\\\", "\\"));
  return { id: get("id"), status: get("status"), rrule: get("rrule"), model: get("model"), cwds, prompt };
}

function sanitizePath(value, { codexHome, guanchaoHome, recoveryRoot, featureWorktree } = {}) {
  if (value === null || value === undefined) return value;
  let result = String(value).replaceAll("\\", "/");
  const replacements = [
    [codexHome, "${CODEX_HOME}"],
    [guanchaoHome, "${GUANCHAO_HOME}"],
    [recoveryRoot, "${GUANCHAO_RECOVERY_ROOT}"],
    [featureWorktree, "${FEATURE_WORKTREE}"],
    ["C:/Users/18442", "${CODEX_HOME_USER}"],
  ];
  for (const [source, target] of replacements) {
    if (source) result = result.replaceAll(String(source).replaceAll("\\", "/"), target);
  }
  return result;
}

function sanitizeValue(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, replacements));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, replacements)]));
  return typeof value === "string" ? sanitizePath(value, replacements) : value;
}

function nativeRecord({ id, file, configSchedule, role, replacements }) {
  const exists = fs.existsSync(file);
  const actual = exists ? parseToml(fs.readFileSync(file, "utf8")) : null;
  const prompt = actual?.prompt ?? "";
  const writeCapable = actual?.status === "ACTIVE" && prompt.includes("publicationEnabled=true") && prompt.includes("legacyProductionFallback=true") && /(?:--write|explicit finalize --write)/i.test(prompt);
  return {
    role,
    id,
    exists,
    status: actual?.status ?? "not_installed",
    enabled: actual?.status === "ACTIVE",
    schedule: actual?.rrule ?? configSchedule?.rrule ?? null,
    configuredSchedule: configSchedule?.rrule ?? null,
    timezone: configSchedule?.timezone ?? "Asia/Shanghai",
    executor: role === "predictionLegacy" ? "deterministic-script" : "codex-automation",
    writeCapable,
    resolvedPath: sanitizePath(file, replacements),
    evidenceSource: [sanitizePath(file, replacements), "native automation.toml"],
    promptMarkers: {
      publicationEnabled: prompt.includes("publicationEnabled=true"),
      legacyProductionFallback: prompt.includes("legacyProductionFallback=true"),
      explicitWrite: /(?:--write|explicit finalize --write)/i.test(prompt),
    },
    cwds: sanitizeValue(actual?.cwds ?? [], replacements),
  };
}

export function buildAutomationHandover({
  root = repositoryRoot,
  configPath = path.join(root, "config", "codex-writer-automation.json"),
  automationsRoot = path.join(os.homedir(), ".codex", "automations"),
  statePath = path.join("C:", "Codex-Recovery", "GuanchaoWriter", "automation-state.json"),
  taskReader = readScheduledTask,
  taskName = "Guanchao Prediction Publisher 18-20",
  featureWorktree = root,
} = {}) {
  const config = readJson(configPath);
  const state = fs.existsSync(statePath) ? readJson(statePath) : null;
  const schedules = Object.fromEntries((config.schedules ?? []).map((schedule) => [schedule.key, schedule]));
  const replacements = {
    codexHome: path.join(os.homedir(), ".codex"),
    guanchaoHome: "D:/Guanchao-Workspace",
    recoveryRoot: "C:/Codex-Recovery/GuanchaoWriter",
    featureWorktree,
  };
  const nativeFile = (id) => path.join(automationsRoot, ...String(id).split(/[\\/]/).filter(Boolean), "automation.toml");
  const activeProduction = config.handover?.activeProduction ?? {};
  const predictionLegacyId = activeProduction.prediction?.automationId ?? "guanchao-prediction-publisher";
  const dailyLegacyId = activeProduction.daily?.automationId ?? "codex";
  const weeklyId = activeProduction.weekly?.automationId ?? "codex-2";
  const predictionLegacy = nativeRecord({ id: predictionLegacyId, file: nativeFile(predictionLegacyId), configSchedule: activeProduction.prediction, role: "predictionLegacy", replacements });
  const dailyLegacy = nativeRecord({ id: dailyLegacyId, file: nativeFile(dailyLegacyId), configSchedule: activeProduction.daily, role: "dailyLegacy", replacements });
  const weekly = nativeRecord({ id: weeklyId, file: nativeFile(weeklyId), configSchedule: activeProduction.weekly, role: "weekly", replacements });
  const task = taskReader(taskName);
  const candidateTaskWriteCapable = task.exists && ["Ready", "Running", "就绪", "正在运行"].includes(task.status) && !/-Mode\s+DryRun/i.test(task.taskToRun ?? "") && /run-prediction-publisher-task\.ps1/i.test(task.taskToRun ?? "");
  const predictionCandidate = {
    role: "predictionCandidate",
    id: schedules.prediction?.legacyAutomationId ?? predictionLegacyId,
    exists: task.exists,
    status: task.status ?? "not_installed",
    enabled: task.status === "Ready" || task.status === "Running" || task.status === "就绪" || task.status === "正在运行",
    schedule: schedules.prediction?.rrule ?? null,
    timezone: schedules.prediction?.timezone ?? "Asia/Shanghai",
    executor: schedules.prediction?.executor ?? "windows-task-scheduler",
    taskName,
    writeCapable: candidateTaskWriteCapable,
    resolvedPath: sanitizePath(task.taskToRun, replacements),
    evidenceSource: ["Windows Task Scheduler XML", "config/codex-writer-automation.json"],
    dryRun: /-Mode\s+DryRun/i.test(task.taskToRun ?? ""),
  };
  const dailyCandidateMatchesNative = normalizeRrule(dailyLegacy.schedule) === normalizeRrule(schedules.daily?.rrule);
  const dailyCandidate = {
    role: "dailyCandidate",
    id: schedules.daily?.automationId ?? dailyLegacyId,
    exists: dailyLegacy.exists && dailyCandidateMatchesNative,
    status: dailyCandidateMatchesNative ? dailyLegacy.status : "not_installed",
    enabled: dailyCandidateMatchesNative && dailyLegacy.enabled,
    schedule: schedules.daily?.rrule ?? null,
    timezone: schedules.daily?.timezone ?? "Asia/Shanghai",
    executor: schedules.daily?.executor ?? "codex-automation",
    writeCapable: dailyCandidateMatchesNative && dailyLegacy.writeCapable,
    resolvedPath: dailyCandidateMatchesNative ? dailyLegacy.resolvedPath : null,
    evidenceSource: [dailyLegacy.resolvedPath, "config/codex-writer-automation.json", "native schedule mismatch means 20:00 candidate is not installed"].filter(Boolean),
  };
  const stateReview = state?.review ?? null;
  const candidatesWriteCapable = [predictionCandidate, dailyCandidate].some((item) => item.writeCapable);
  return {
    schemaVersion: "automation-handover-v1",
    status: "ready",
    generatedFrom: ["config/codex-writer-automation.json", "native automation.toml", "Windows Task Scheduler XML", "automation-state.json"],
    predictionLegacy,
    predictionCandidate,
    dailyLegacy,
    dailyCandidate,
    weekly,
    stateReview: sanitizeValue(stateReview, replacements),
    preMergeSafety: {
      exactlyOneWriteCapablePredictionFallback: [predictionLegacy].filter((item) => item.writeCapable).length === 1,
      exactlyOneWriteCapableDailyFallback: [dailyLegacy].filter((item) => item.writeCapable).length === 1,
      candidatesWriteCapable: candidatesWriteCapable,
      weeklyUnchanged: weekly.writeCapable && normalizeRrule(weekly.schedule) === normalizeRrule(activeProduction.weekly?.rrule),
      finalSwitch: "merge-only; no final switch executed",
      productionWritesDuringReview: false,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    console.log(JSON.stringify(buildAutomationHandover(), null, 2));
  } catch (error) {
    console.error(`AUTOMATION_HANDOVER_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
