#!/usr/bin/env node
/**
 * Local Codex automation consistency check for the Guanchao writer/prediction tasks.
 *
 * Verifies, before any production write, that the repository config, repository docs,
 * native automation prompt, native schedule, native model and runtime path agree.
 * Any mismatch exits non-zero and prints AUTOMATION_DRIFT.
 *
 * No secrets, tokens or credentials are read or written by this script.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

const DEFAULT_AUTOMATIONS_ROOT = "C:/Users/18442/.codex/automations";
const DEFAULT_STATE = "C:/Codex-Recovery/GuanchaoWriter/automation-state.json";
const NATIVE_IDS = { prediction: "codex-3", daily: "codex", weekly: "codex-2" };
const FORBIDDEN_DOC_FRAGMENTS = [
  "publicationEnabled` 固定为 `false`",
  "publicationEnabled 固定为 false",
  "publicationEnabled` 固定为 false",
  "publicationEnabled 固定为 `false`",
  "仅 dry-run",
  "仅 dry-run 或"
];
const FORBIDDEN_PROMPT_FRAGMENTS = [
  "publicationEnabled=false",
  "publicationEnabled = false",
  "仅 dry-run",
  "不得 commit、push、merge 或部署",
  "不得 commit、push、merge 和部署",
  "不得 commit、push、merge、deploy",
  "guanchao-financial-editor-skill"
];
const REQUIRED_PROMPT_FRAGMENTS = {
  prediction: [
    "publicationEnabled=true",
    "run-prediction-publisher.mjs",
    "禁止训练",
    "禁止激活 shadow candidate",
    "no-op"
  ],
  daily: [
    "publicationEnabled=true",
    "guanchao-financial-writer",
    "WRITER_SKILL_MISSING",
    "finalize",
    "--write",
    "STALE_WRITER_PACKET",
    "chore(content): publish daily brief"
  ],
  weekly: [
    "publicationEnabled=true",
    "guanchao-financial-writer",
    "WRITER_SKILL_MISSING",
    "finalize",
    "--write",
    "chore(content): publish weekly brief"
  ]
};

function fail(message) {
  throw new Error(message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(`${label} is missing or invalid: ${file}`);
  }
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeRrule(value) {
  return [...new Set(String(value ?? "").split(";").map((part) => part.trim()).filter(Boolean).filter((part) => !part.startsWith("BYSECOND")))]
    .sort()
    .join(";");
}

function readTomlText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function parseTomlPrompt(text) {
  // Minimal TOML parsing sufficient for the Codex automation.toml prompt field
  // (a quoted string that may span lines). Returns null when not parseable.
  if (!text) return null;
  const match = text.match(/^prompt\s*=\s*('''[\s\S]*?'''|"""[\s\S]*?"""|"(?:[^"\\]|\\.)*")/m);
  if (!match) return null;
  const raw = match[1];
  if (raw.startsWith("'''")) return raw.slice(3, -3);
  if (raw.startsWith('"""')) return raw.slice(3, -3);
  let out = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index];
    if (char === "\\" && index + 1 < raw.length - 1) {
      const next = raw[index + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else if (next === "r") out += "\r";
      else out += next;
      index += 1;
    } else {
      out += char;
    }
  }
  return out;
}

function extractSimpleFields(text) {
  const fields = {};
  for (const key of ["id", "status", "rrule", "model"]) {
    const match = text?.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"));
    fields[key] = match ? match[1] : null;
  }
  const cwdsMatch = text?.match(/^cwds\s*=\s*\[([^\]]*)\]/m);
  fields.cwds = cwdsMatch
    ? [...cwdsMatch[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((item) => item[1].replace(/\\\\/g, "\\"))
    : [];
  return fields;
}

function automationDirectory(root, id) {
  return path.join(root, ...String(id).split(/[\\/]/).filter(Boolean));
}

export function checkAutomationConsistency({
  configPath = path.join(repositoryRoot, "config", "codex-writer-automation.json"),
  docsPath = path.join(repositoryRoot, "docs", "CODEX_WRITER_AUTOMATION.md"),
  automationsRoot = DEFAULT_AUTOMATIONS_ROOT,
  statePath = DEFAULT_STATE,
  skillDirectory = path.join(os.homedir(), ".codex", "skills", "guanchao-financial-writer")
} = {}) {
  const checks = [];
  const add = (name, passed, detail = "") => checks.push({ name, passed: Boolean(passed), detail });
  const config = readJson(configPath, "config");
  const docs = fs.existsSync(docsPath) ? fs.readFileSync(docsPath, "utf8") : null;
  const state = fs.existsSync(statePath) ? readJson(statePath, "automation state") : null;

  add("config.publicationEnabled", config.publicationEnabled === true, String(config.publicationEnabled));
  add("config.productionApplyRequiresExplicitWrite", config.productionApplyRequiresExplicitWrite === true, String(config.productionApplyRequiresExplicitWrite));
  add("config.schedules include prediction/daily/weekly", ["prediction", "daily", "weekly"].every((key) => config.schedules?.some((schedule) => schedule.key === key)), JSON.stringify(config.schedules?.map((schedule) => schedule.key)));
  if (docs === null) {
    add("docs exists", false, docsPath);
  } else {
    const forbidden = FORBIDDEN_DOC_FRAGMENTS.filter((fragment) => docs.includes(fragment));
    add("docs do not state fixed false", forbidden.length === 0, forbidden.join(" | "));
    add("docs state publication enabled", /publicationEnabled\s*=\s*true/.test(docs) || /publicationEnabled.{0,10}true/.test(docs), "publicationEnabled=true");
  }

  for (const schedule of config.schedules ?? []) {
    const key = schedule.key;
    if (!["prediction", "daily", "weekly"].includes(key)) continue;
    const nativeId = schedule.automationId || state?.[`${key}AutomationId`] || NATIVE_IDS[key];
    const directory = automationDirectory(automationsRoot, nativeId);
    const tomlFile = path.join(directory, "automation.toml");
    const toml = readTomlText(tomlFile);
    if (!toml) {
      add(`${key}.native automation exists`, false, tomlFile);
      continue;
    }
    const fields = extractSimpleFields(toml);
    const prompt = parseTomlPrompt(toml);
    const expectedModel = key === "prediction" ? config.prediction?.model : config.writer?.model;
    const expectedRrule = normalizeRrule(schedule.rrule);
    const actualRrule = normalizeRrule(fields.rrule);
    add(`${key}.status ACTIVE`, fields.status === "ACTIVE", String(fields.status));
    add(`${key}.native rrule matches config`, actualRrule === expectedRrule, `${actualRrule} vs ${expectedRrule}`);
    add(`${key}.native model matches config`, fields.model === expectedModel, `${String(fields.model)} vs ${String(expectedModel)}`);
    const forbidden = FORBIDDEN_PROMPT_FRAGMENTS.filter((fragment) => prompt?.includes(fragment));
    add(`${key}.prompt has no dry-run/false fragments`, forbidden.length === 0, forbidden.join(" | "));
    const missing = REQUIRED_PROMPT_FRAGMENTS[key]?.filter((fragment) => !prompt?.includes(fragment)) ?? [];
    add(`${key}.prompt has required publication markers`, missing.length === 0, missing.join(" | "));
    const runtimePath = String(config.runtime?.projectPath ?? "").replaceAll("\\", "/");
    const repositoryPath = String(config.runtime?.repositoryPath ?? "").replaceAll("\\", "/");
    const cwdOk = fields.cwds.some((cwd) => {
      const normalized = String(cwd).replaceAll("\\", "/");
      return normalized === runtimePath || normalized === repositoryPath;
    });
    add(`${key}.native cwds include runtime/repo path`, cwdOk, JSON.stringify(fields.cwds));
    if (state?.prompts?.[key]?.sha256) {
      const promptSha = prompt === null ? null : sha256Bytes(Buffer.from(prompt, "utf8"));
      add(`${key}.native prompt sha256 matches state`, promptSha === state.prompts[key].sha256, `${String(promptSha)} vs ${state.prompts[key].sha256}`);
    } else {
      add(`${key}.native prompt sha256 recorded in state`, Boolean(state?.prompts?.[key]?.sha256), "state.prompts.<key>.sha256");
    }
  }

  if (state) {
    const configSha = sha256Bytes(fs.readFileSync(configPath));
    add("state.configSha256 matches config", state.configSha256 === configSha, `${state.configSha256} vs ${configSha}`);
    add("state.enabled", state.enabled === true, String(state.enabled));
  } else {
    add("automation state exists", false, statePath);
  }

  const skillFile = path.join(skillDirectory, "SKILL.md");
  const skillInstalled = fs.existsSync(skillFile) && fs.existsSync(path.join(skillDirectory, "references")) && fs.existsSync(path.join(skillDirectory, "scripts"));
  add("writer.skill guanchao-financial-writer installed", skillInstalled, skillDirectory);
  let skillFrontmatterName = null;
  if (skillInstalled) {
    const head = fs.readFileSync(skillFile, "utf8").slice(0, 400);
    skillFrontmatterName = /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? null;
    add("writer.skill frontmatter name", skillFrontmatterName === "guanchao-financial-writer", String(skillFrontmatterName));
  }

  const passed = checks.every((check) => check.passed);
  return { schemaVersion: "automation-consistency-check-v1", consistent: passed, checkedAt: new Date().toISOString(), checks };
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) fail(`unknown positional argument: ${values[index]}`);
    const key = values[index].slice(2);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const args = parseArgs(process.argv.slice(2));
  try {
    const report = checkAutomationConsistency({
      configPath: args.config ? path.resolve(args.config) : path.join(repositoryRoot, "config", "codex-writer-automation.json"),
      docsPath: args.docs ? path.resolve(args.docs) : path.join(repositoryRoot, "docs", "CODEX_WRITER_AUTOMATION.md"),
      automationsRoot: args["automations-root"] ? path.resolve(args["automations-root"]) : DEFAULT_AUTOMATIONS_ROOT,
      statePath: args.state ? path.resolve(args.state) : DEFAULT_STATE
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.consistent) {
      if (report.checks.some((check) => check.name.startsWith("writer.skill") && !check.passed)) {
        console.error("WRITER_SKILL_MISSING");
      }
      console.error("AUTOMATION_DRIFT");
      process.exitCode = 1;
    }
  } catch (cause) {
    console.error(`AUTOMATION_DRIFT ${cause instanceof Error ? cause.message : "unexpected failure"}`);
    process.exitCode = 1;
  }
}
