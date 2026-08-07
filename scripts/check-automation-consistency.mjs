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

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DEFAULT_AUTOMATIONS_ROOT = "C:/Users/18442/.codex/automations";
const DEFAULT_STATE = "C:/Codex-Recovery/GuanchaoWriter/automation-state.json";
const DEFAULT_TASK_NAME = "Guanchao Prediction Publisher 18-20";
const REQUIRED_PROMPT_FRAGMENTS = {
  prediction: ["run-prediction-publisher.mjs", "18:20", "禁止训练", "禁止激活 shadow candidate", "AUTOMATION_DRIFT"],
  daily: ["publicationEnabled=true", "观潮每日晚报", "writerMayBrowse=true", "memory:search", "MEMORY_DELTA", "WRITER_SKILL_MISSING", "finalize", "--write", "STALE_WRITER_PACKET"],
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

export function readScheduledTask(taskName = DEFAULT_TASK_NAME) {
  try {
    const bytes = execFileSync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"], { windowsHide: true });
    const text = bytes[0] === 0xff && bytes[1] === 0xfe ? new TextDecoder("utf-16le").decode(bytes) : new TextDecoder("utf-8").decode(bytes);
    const command = text.match(/<Command>([\s\S]*?)<\/Command>/i)?.[1]?.trim() ?? null;
    const argumentsValue = text.match(/<Arguments>([\s\S]*?)<\/Arguments>/i)?.[1]?.trim() ?? "";
    const startBoundary = text.match(/<StartBoundary>([\s\S]*?)<\/StartBoundary>/i)?.[1]?.trim() ?? null;
    const enabled = text.match(/<Enabled>(true|false)<\/Enabled>/i)?.[1] !== "false";
    return { exists: true, taskName, status: enabled ? "Ready" : "Disabled", taskToRun: command ? `${command} ${argumentsValue}`.trim() : null, schedule: startBoundary ? `Daily ${startBoundary.slice(11, 16)}` : null, raw: null };
  } catch { return { exists: false, taskName, status: null, taskToRun: null, schedule: null, raw: null }; }
}

export function checkAutomationConsistency({ configPath = path.join(repositoryRoot, "config", "codex-writer-automation.json"), docsPath = path.join(repositoryRoot, "docs", "CODEX_WRITER_AUTOMATION.md"), automationsRoot = DEFAULT_AUTOMATIONS_ROOT, statePath = DEFAULT_STATE, skillDirectory = path.join(os.homedir(), ".codex", "skills", "guanchao-financial-writer"), scheduledTaskReader = readScheduledTask } = {}) {
  const checks = [];
  const add = (name, passed, detail = "") => checks.push({ name, passed: Boolean(passed), detail });
  const config = readJson(configPath, "config");
  const docs = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : null;
  const state = fs.existsSync(statePath) ? readJson(statePath, "automation state") : null;
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
      add("prediction.scheduler task enabled", task.status === "Ready" || task.status === "Running" || task.status === "就绪" || task.status === "正在运行", String(task.status));
      add("prediction.scheduler task action is deterministic", /run-prediction-publisher-task\.ps1/i.test(task.taskToRun ?? "") && !/gpt-|codex/i.test(task.taskToRun ?? ""), String(task.taskToRun));
      add("prediction.scheduler schedule 18:20", /18:20|每天/i.test(`${task.schedule ?? ""} ${schedule.rrule}`), `${task.schedule ?? "missing"} vs ${schedule.rrule}`);
      continue;
    }
    const nativeId = schedule.automationId || state?.[`${key}AutomationId`];
    const tomlFile = automationDirectory(automationsRoot, nativeId) + "\\automation.toml";
    const toml = readToml(tomlFile);
    add(`${key}.native automation exists`, toml !== null, tomlFile);
    if (!toml) continue;
    const actual = fields(toml);
    const nativePrompt = parsePrompt(toml);
    add(`${key}.status ACTIVE`, actual.status === "ACTIVE", String(actual.status));
    add(`${key}.native rrule matches config`, normalizeRrule(actual.rrule) === normalizeRrule(schedule.rrule), `${actual.rrule} vs ${schedule.rrule}`);
    const expectedModel = config.writer?.model;
    add(`${key}.native model matches config`, actual.model === expectedModel, `${actual.model} vs ${expectedModel}`);
    add(`${key}.native cwds include runtime/repo path`, actual.cwds.some((cwd) => [config.runtime.projectPath, config.runtime.repositoryPath].map((item) => String(item).replaceAll("\\", "/")).includes(String(cwd).replaceAll("\\", "/"))), JSON.stringify(actual.cwds));
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
    add("state.configSha256 matches config", state.configSha256 === sha256Bytes(fs.readFileSync(configPath)), `${state.configSha256} vs ${sha256Bytes(fs.readFileSync(configPath))}`);
    add("state.enabled", state.enabled === true, String(state.enabled));
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
