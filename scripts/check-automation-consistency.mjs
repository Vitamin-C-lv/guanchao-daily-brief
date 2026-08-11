#!/usr/bin/env node
/**
 * Pre-write consistency gate. Prediction is a Windows Task Scheduler task;
 * Daily/Weekly remain local Codex automations. Any mismatch is AUTOMATION_DRIFT.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isForbiddenProductionPath, resolveAutomationPaths, resolveConfiguredPath, toConfigPath } from "./automation-paths.mjs";
import { sha256AutomationConfigBytes } from "./automation-config-hash.mjs";
import { PRODUCTION_REPOSITORY_REMOTE, runWriterProductionPreflight } from "./writer-production-preflight.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DEFAULT_PATHS = resolveAutomationPaths();
const DEFAULT_AUTOMATIONS_ROOT = DEFAULT_PATHS.automationsRoot;
const DEFAULT_STATE = path.join(DEFAULT_PATHS.recoveryRoot, "automation-state.json");
const DEFAULT_TASK_NAME = "Guanchao Prediction Publisher 18-20";
const REQUIRED_PROMPT_FRAGMENTS = {
  prediction: ["run-prediction-publisher.mjs", "18:20", "禁止训练", "禁止激活 shadow candidate", "SUNDAY_NO_RUN", "AUTOMATION_DRIFT"],
  daily: ["publicationEnabled=true", "观潮每日晚报", "writerMayBrowse=true", "memory:search", "MEMORY_DELTA", "WRITER_SKILL_MISSING", "finalize", "--write", "STALE_WRITER_PACKET", "SUNDAY_NO_REPORT"],
  weekly: ["publicationEnabled=true", "writerMayBrowse=true", "20D", "Brier", "calibration", "abstention", "MEMORY_DELTA", "WRITER_SKILL_MISSING", "finalize", "--write"]
};
const FORBIDDEN_PROMPT_FRAGMENTS = ["publicationEnabled=false", "仅 dry-run", "Writer 禁止浏览", "禁止浏览、搜索", "LUNA_API_KEY"];

function fail(message) { throw new Error(message); }
function readJson(file, label) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { fail(`${label} is missing or invalid: ${file}`); } }
function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function normalizeRrule(value) { return [...new Set(String(value ?? "").split(";").filter(Boolean).filter((part) => !part.startsWith("BYSECOND")).map((part) => part.trim()))].sort().join(";"); }
function readToml(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }
function parsePrompt(text) { const match = text?.match(/^prompt\s*=\s*('''[\s\S]*?'''|"""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/m); if (!match) return null; const raw = match[1]; if (raw.startsWith("'''")) return raw.slice(3, -3); if (raw.startsWith('"""')) return raw.slice(3, -3); return JSON.parse(raw); }
function fields(text) {
  const values = {};
  for (const key of ["id", "status", "rrule", "model"]) values[key] = text?.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? null;
  values.cwds = [...(text?.match(/^cwds\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => item[1].replaceAll("\\\\", "\\"));
  return values;
}
function automationDirectory(root, id) { return path.join(root, ...String(id).split(/[\\/]/).filter(Boolean)); }
function normalizedPath(value) { return toConfigPath(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase(); }
function pathIsConfigured(value, expected) { return normalizedPath(value) === normalizedPath(expected); }
function hasForbiddenPath(values) { return values.some((value) => isForbiddenProductionPath(value)); }

export function readScheduledTask(taskName = DEFAULT_TASK_NAME) {
  try {
    const bytes = execFileSync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"], { windowsHide: true });
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder("utf-16le").decode(bytes) : new TextDecoder("utf-8").decode(bytes);
    const command = text.match(/<Command>([\s\S]*?)<\/Command>/i)?.[1]?.trim() ?? null;
    const argumentsValue = text.match(/<Arguments>([\s\S]*?)<\/Arguments>/i)?.[1]?.trim() ?? "";
    const startBoundary = text.match(/<StartBoundary>([\s\S]*?)<\/StartBoundary>/i)?.[1]?.trim() ?? null;
    const enabled = text.match(/<Enabled>(true|false)<\/Enabled>/i)?.[1] !== "false";
    const weekBody = text.match(/<ScheduleByWeek>[\s\S]*?<DaysOfWeek>([\s\S]*?)<\/DaysOfWeek>[\s\S]*?<\/ScheduleByWeek>/i)?.[1] ?? "";
    const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    const shortDays = dayNames.filter((day) => new RegExp(`<${day}\\s*/>`, "i").test(weekBody)).map((day) => day.slice(0, 3));
    const time = startBoundary ? startBoundary.slice(11, 16) : null;
    const schedule = shortDays.length ? `Weekly ${shortDays.join(",")} ${time ?? ""}`.trim() : time ? `Daily ${time}` : null;
    return { exists: true, taskName, status: enabled ? "Ready" : "Disabled", taskToRun: command ? `${command} ${argumentsValue}`.trim() : null, schedule, raw: null };
  } catch { return { exists: false, taskName, status: null, taskToRun: null, schedule: null, raw: null }; }
}

export function checkAutomationConsistency({ configPath = path.join(repositoryRoot, "config", "codex-writer-automation.json"), docsPath = path.join(repositoryRoot, "docs", "CODEX_WRITER_AUTOMATION.md"), automationsRoot = DEFAULT_AUTOMATIONS_ROOT, statePath = DEFAULT_STATE, skillDirectory = path.join(os.homedir(), ".codex", "skills", "guanchao-financial-writer"), scheduledTaskReader = readScheduledTask, productionPreflight = null, runProductionPreflight = true } = {}) {
  const checks = [];
  const add = (name, passed, detail = "") => checks.push({ name, passed: Boolean(passed), detail });
  const config = readJson(configPath, "config");
  const docs = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : null;
  const state = fs.existsSync(statePath) ? readJson(statePath, "automation state") : null;
  const handoverStatus = config.handover?.status;
  const handover = handoverStatus === "pre-merge-safe";
  const productionActive = handoverStatus === "production-cutover-active";
  const runtimePaths = [config.runtime?.projectPath, config.runtime?.repositoryPath].filter(Boolean);
  let configuredPaths = null;
  add("config.runtime uses canonical paths", runtimePaths.length === 2 && runtimePaths.every((value) => !isForbiddenProductionPath(value)), JSON.stringify(runtimePaths));
  try {
    const configuredPathPairs = ["projectPath", "repositoryPath", "recoveryRoot", "runsRoot", "automationStatePath", "nativeAutomationsRoot"]
      .map((key) => [key, resolveConfiguredPath(config.runtime?.[key], { baseDirectory: path.dirname(configPath) })]);
    configuredPaths = Object.fromEntries(configuredPathPairs);
    add("config path templates resolve", configuredPathPairs.every(([, value]) => !String(value).includes("${") && !isForbiddenProductionPath(value)), JSON.stringify(configuredPathPairs));
  } catch (error) {
    add("config path templates resolve", false, error instanceof Error ? error.message : String(error));
  }
  if (runProductionPreflight && configuredPaths?.projectPath && configuredPaths?.repositoryPath) {
    let preflight;
    try {
      preflight = typeof productionPreflight === "function"
        ? productionPreflight({ repositoryPath: configuredPaths.repositoryPath, runtimePath: configuredPaths.projectPath, expectedRemote: config.runtime?.repositoryRemote ?? PRODUCTION_REPOSITORY_REMOTE })
        : runWriterProductionPreflight({ repositoryPath: configuredPaths.repositoryPath, runtimePath: configuredPaths.projectPath, expectedRemote: config.runtime?.repositoryRemote ?? PRODUCTION_REPOSITORY_REMOTE });
    } catch (error) {
      preflight = { status: "ERROR", errorCode: "PREFLIGHT_EXCEPTION", error: error instanceof Error ? error.message : String(error) };
    }
    add("writer production preflight", preflight.status === "READY", JSON.stringify({ status: preflight.status, errorCode: preflight.errorCode ?? null, productionHead: preflight.productionHead ?? null, repository: preflight.repository ?? null, runtime: preflight.runtime ?? null }));
  } else if (runProductionPreflight) {
    add("writer production preflight", false, "configured canonical paths are unavailable");
  }
  add("config has no forbidden production path", !hasForbiddenPath([...(config.handover?.forbiddenProductionPaths ?? [])].filter((value) => value !== "D:/周报个人网站")), JSON.stringify(config.handover?.forbiddenProductionPaths ?? []));
  add("handover status accepted", handover || productionActive, String(handoverStatus));
  add("handover activation flag matches status", handover ? config.handover?.candidateSchedulesAreNotProductionActive === true : productionActive && config.handover?.candidateSchedulesAreNotProductionActive === false, JSON.stringify({ status: handoverStatus, candidateSchedulesAreNotProductionActive: config.handover?.candidateSchedulesAreNotProductionActive }));
  add("config.publicationEnabled", config.publicationEnabled === true, String(config.publicationEnabled));
  add("config.productionApplyRequiresExplicitWrite", config.productionApplyRequiresExplicitWrite === true, String(config.productionApplyRequiresExplicitWrite));
  add("config.prediction.normalPathUsesLlm=false", config.prediction?.normalPathUsesLlm === false && config.prediction?.normalPathLlmTokens === 0, JSON.stringify({ usesLlm: config.prediction?.normalPathUsesLlm, tokens: config.prediction?.normalPathLlmTokens }));
  add("config.schedules include prediction/daily/weekly", ["prediction", "daily", "weekly"].every((key) => config.schedules?.some((schedule) => schedule.key === key)), JSON.stringify(config.schedules?.map((schedule) => schedule.key)));
  if (docs === null) add("docs exists", false, docsPath);
  else {
    add("docs do not state fixed false", !/publicationEnabled\s*(?:=|固定为)\s*`?false/.test(docs) && !/仅 dry-run/.test(docs), "false/dry-run fragments");
    add("docs state publication enabled", /publicationEnabled\s*=\s*true/.test(docs), "publicationEnabled=true");
    add("docs state 18:20/20:00", docs.includes("18:20") && docs.includes("20:00"), "schedule");
  }
  for (const schedule of config.schedules ?? []) {
    if (!["prediction", "daily", "weekly"].includes(schedule.key)) continue;
    const key = schedule.key;
    const promptPath = path.join(path.dirname(configPath), "..", ...String(schedule.promptFile).split("/"));
    const prompt = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8") : null;
    const forbidden = FORBIDDEN_PROMPT_FRAGMENTS.filter((fragment) => prompt?.includes(fragment));
    add(`${key}.prompt exists`, prompt !== null, promptPath);
    add(`${key}.prompt has no forbidden fragments`, forbidden.length === 0, forbidden.join(" | "));
    const missing = (REQUIRED_PROMPT_FRAGMENTS[key] ?? []).filter((fragment) => !prompt?.includes(fragment));
    add(`${key}.prompt has required markers`, missing.length === 0, missing.join(" | "));
    if (key === "prediction" && schedule.executor === "windows-task-scheduler") {
      const task = scheduledTaskReader(schedule.taskName ?? DEFAULT_TASK_NAME);
      add("prediction.scheduler task exists", task.exists, task.taskName);
      const candidateDisabled = handover && schedule.enabled === false;
      add("prediction.scheduler task state matches handover", candidateDisabled ? task.status === "Disabled" : task.status === "Ready" || task.status === "Running" || task.status === "就绪" || task.status === "正在运行", `${task.status} candidateDisabled=${candidateDisabled}`);
      add("prediction.scheduler task action is deterministic", /run-prediction-publisher-task\.ps1/i.test(task.taskToRun ?? "") && !/gpt-|codex/i.test(task.taskToRun ?? ""), String(task.taskToRun));
      add("prediction.scheduler dry-run before merge", candidateDisabled ? /-Mode\s+DryRun/i.test(task.taskToRun ?? "") : true, String(task.taskToRun));
      const expectedMonSat = /FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA;BYHOUR=18;BYMINUTE=20/i.test(schedule.rrule ?? "");
      const actualMonSat = /weekly/i.test(task.schedule ?? "") && ["mon", "tue", "wed", "thu", "fri", "sat"].every((day) => String(task.schedule ?? "").toLowerCase().includes(day)) && !String(task.schedule ?? "").toLowerCase().includes("sun");
      add("prediction.scheduler schedule Mon-Sat 18:20", /18:20/i.test(`${task.schedule ?? ""} ${schedule.rrule}`) && expectedMonSat && actualMonSat, `${task.schedule ?? "missing"} vs ${schedule.rrule}`);
      continue;
    }
    const nativeId = schedule.automationId || state?.[`${key}AutomationId`];
    const nativeSchedule = handover || productionActive ? config.handover?.activeProduction?.[key] : schedule;
    const nativeExpectedRrule = nativeSchedule?.rrule ?? schedule.rrule;
    const tomlFile = automationDirectory(automationsRoot, nativeId) + "\\automation.toml";
    const toml = readToml(tomlFile);
    add(`${key}.native automation exists`, toml !== null, tomlFile);
    if (!toml) continue;
    const actual = fields(toml);
    const nativePrompt = parsePrompt(toml);
    add(`${key}.status ACTIVE`, actual.status === "ACTIVE", String(actual.status));
    add(`${key}.native rrule matches config`, normalizeRrule(actual.rrule) === normalizeRrule(nativeExpectedRrule), `${actual.rrule} vs ${nativeExpectedRrule}`);
    const expectedModel = config.writer?.model;
    add(`${key}.native model matches config`, actual.model === expectedModel, `${actual.model} vs ${expectedModel}`);
    add(`${key}.native cwds use canonical runtime/repo paths`, actual.cwds.length >= 2 && [config.runtime.projectPath, config.runtime.repositoryPath].every((expected) => actual.cwds.some((cwd) => pathIsConfigured(cwd, resolveConfiguredPath(expected)))), `${JSON.stringify(actual.cwds)} vs ${JSON.stringify(runtimePaths)}`);
    add(`${key}.native cwds have no forbidden path`, !hasForbiddenPath(actual.cwds), JSON.stringify(actual.cwds));
    if (nativePrompt !== null) {
      const nativeMissing = (REQUIRED_PROMPT_FRAGMENTS[key] ?? []).filter((fragment) => !nativePrompt.includes(fragment));
      add(`${key}.native prompt markers`, nativeMissing.length === 0, nativeMissing.join(" | "));
      const nativeForbidden = FORBIDDEN_PROMPT_FRAGMENTS.filter((fragment) => nativePrompt.includes(fragment));
      add(`${key}.native prompt no forbidden fragments`, nativeForbidden.length === 0, nativeForbidden.join(" | "));
      const stateSha = state?.prompts?.[key]?.sha256;
      add(`${key}.native prompt sha256 matches state`, Boolean(stateSha) && sha256Bytes(Buffer.from(nativePrompt, "utf8")) === stateSha, `${sha256Bytes(Buffer.from(nativePrompt, "utf8"))} vs ${stateSha}`);
    }
  }
  if (state) {
    const configSha256 = sha256AutomationConfigBytes(fs.readFileSync(configPath));
    add("state.configSha256 matches config", state.configSha256 === configSha256, `${state.configSha256} vs ${configSha256}`);
    add("state.enabled", state.enabled === true, String(state.enabled));
    add("state.runtime has no forbidden path", !hasForbiddenPath([state.runtime?.projectPath, state.runtime?.repositoryPath].filter(Boolean)), JSON.stringify(state.runtime));
    add("state.handover matches config", state.review?.handoverStatus === (config.handover?.status ?? "unknown"), `${state.review?.handoverStatus} vs ${config.handover?.status}`);
  } else add("automation state exists", false, statePath);
  const skillFile = path.join(skillDirectory, "SKILL.md");
  const installed = fs.existsSync(skillFile) && fs.existsSync(path.join(skillDirectory, "references")) && fs.existsSync(path.join(skillDirectory, "scripts"));
  add("writer.skill guanchao-financial-writer installed", installed, skillDirectory);
  if (installed) add("writer.skill frontmatter name", /^name:\s*guanchao-financial-writer$/m.test(fs.readFileSync(skillFile, "utf8").slice(0, 400)), skillFile);
  return { schemaVersion: "automation-consistency-check-v2", consistent: checks.every((check) => check.passed), checkedAt: new Date().toISOString(), checks };
}

function args(values) { const result = {}; for (let index = 0; index < values.length; index += 1) { if (!values[index].startsWith("--")) fail(`unknown argument ${values[index]}`); const key = values[index].slice(2); result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true; } return result; }

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const parsed = args(process.argv.slice(2));
    const report = checkAutomationConsistency({ configPath: parsed.config ? path.resolve(parsed.config) : undefined, docsPath: parsed.docs ? path.resolve(parsed.docs) : undefined, automationsRoot: parsed["automations-root"] ? path.resolve(parsed["automations-root"]) : undefined, statePath: parsed.state ? path.resolve(parsed.state) : undefined });
    console.log(JSON.stringify(report, null, 2));
    if (!report.consistent) { if (report.checks.some((item) => item.name.startsWith("writer.skill") && !item.passed)) console.error("WRITER_SKILL_MISSING"); console.error("AUTOMATION_DRIFT"); process.exitCode = 1; }
  } catch (error) { console.error(`AUTOMATION_DRIFT ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
