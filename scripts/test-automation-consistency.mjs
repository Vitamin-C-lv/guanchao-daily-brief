import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkAutomationConsistency } from "./check-automation-consistency.mjs";

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
const DAILY = "publicationEnabled=true\n观潮每日晚报\nwriterMayBrowse=true\nmemory:search\nMEMORY_DELTA\nWRITER_SKILL_MISSING\nfinalize\n--write\nSTALE_WRITER_PACKET";
const WEEKLY = "publicationEnabled=true\nwriterMayBrowse=true\n20D Brier calibration abstention\nMEMORY_DELTA\nWRITER_SKILL_MISSING\nfinalize\n--write";
const PREDICTION = "run-prediction-publisher.mjs 18:20 禁止训练 禁止激活 shadow candidate AUTOMATION_DRIFT";

function toml(id, rrule, prompt) {
  return `id = "${id}"\nstatus = "ACTIVE"\nrrule = "${rrule}"\nmodel = "gpt-5.6-luna"\nprompt = '''${prompt}'''\ncwds = ["D:/周报个人网站-local-writer-runtime", "D:/周报个人网站"]\n`;
}

function fixture({ scheduler = null, dailyRrule = "FREQ=DAILY;BYHOUR=20;BYMINUTE=0", nativeDailyRrule = dailyRrule, dailyPrompt = DAILY, skill = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automation-consistency-v2-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "config"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  const config = { schemaVersion: "codex-writer-automation-v2", publicationEnabled: true, productionApplyRequiresExplicitWrite: true, runtime: { projectPath: "D:/周报个人网站-local-writer-runtime", repositoryPath: "D:/周报个人网站" }, writer: { model: "gpt-5.6-luna" }, prediction: { model: null, normalPathUsesLlm: false, normalPathLlmTokens: 0 }, schedules: [{ key: "prediction", executor: "windows-task-scheduler", taskName: "Guanchao Prediction Publisher 18-20", rrule: "FREQ=DAILY;BYHOUR=18;BYMINUTE=20", promptFile: "prompts/codex-prediction-publisher.md" }, { key: "daily", executor: "codex-automation", automationId: "codex", rrule: dailyRrule, promptFile: "prompts/codex-daily-writer.md" }, { key: "weekly", executor: "codex-automation", automationId: "codex-2", rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0", promptFile: "prompts/codex-weekly-writer.md" }] };
  fs.writeFileSync(path.join(repo, "config", "codex-writer-automation.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(repo, "docs", "CODEX_WRITER_AUTOMATION.md"), "publicationEnabled=true\n18:20\n20:00\n", "utf8");
  fs.mkdirSync(path.join(repo, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(repo, "prompts", "codex-prediction-publisher.md"), PREDICTION, "utf8");
  fs.writeFileSync(path.join(repo, "prompts", "codex-daily-writer.md"), dailyPrompt, "utf8");
  fs.writeFileSync(path.join(repo, "prompts", "codex-weekly-writer.md"), WEEKLY, "utf8");
  const automations = path.join(root, "automations");
  for (const [id, rule, prompt] of [["codex", nativeDailyRrule, dailyPrompt], ["codex-2", "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0", WEEKLY]]) { fs.mkdirSync(path.join(automations, id), { recursive: true }); fs.writeFileSync(path.join(automations, id, "automation.toml"), toml(id, rule, prompt), "utf8"); }
  const state = { dailyAutomationId: "codex", weeklyAutomationId: "codex-2", configSha256: sha256(fs.readFileSync(path.join(repo, "config", "codex-writer-automation.json"))), prompts: { daily: { sha256: sha256(dailyPrompt) }, weekly: { sha256: sha256(WEEKLY) } }, enabled: true };
  const stateFile = path.join(root, "automation-state.json"); fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const skillDirectory = path.join(root, "skills", "guanchao-financial-writer");
  if (skill) { fs.mkdirSync(path.join(skillDirectory, "references"), { recursive: true }); fs.mkdirSync(path.join(skillDirectory, "scripts"), { recursive: true }); fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: guanchao-financial-writer\n---\n", "utf8"); }
  return { repo, automations, stateFile, skillDirectory, scheduler: scheduler ?? (() => ({ exists: true, taskName: "Guanchao Prediction Publisher 18-20", status: "Ready", taskToRun: "powershell run-prediction-publisher-task.ps1 -Mode DryRun", schedule: "Daily 18:20" })), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function check(value) { return checkAutomationConsistency({ configPath: path.join(value.repo, "config", "codex-writer-automation.json"), docsPath: path.join(value.repo, "docs", "CODEX_WRITER_AUTOMATION.md"), automationsRoot: value.automations, statePath: value.stateFile, skillDirectory: value.skillDirectory, scheduledTaskReader: () => value.scheduler() }); }

test("consistent fixture passes with scheduler prediction and Codex writers", () => { const value = fixture(); try { assert.equal(check(value).consistent, true); } finally { value.cleanup(); } });
test("prediction scheduler action mismatch fails closed", () => { const value = fixture({ scheduler: () => ({ exists: true, taskName: "Guanchao Prediction Publisher (18:20)", status: "Ready", taskToRun: "powershell invoke-agent.ps1", schedule: "Daily 18:20" }) }); try { assert.equal(check(value).consistent, false); assert.equal(check(value).checks.find((item) => item.name === "prediction.scheduler task action is deterministic").passed, false); } finally { value.cleanup(); } });
test("daily schedule mismatch fails closed", () => { const value = fixture({ nativeDailyRrule: "FREQ=DAILY;BYHOUR=19;BYMINUTE=0" }); try { assert.equal(check(value).consistent, false); } finally { value.cleanup(); } });
test("missing skill fails closed", () => { const value = fixture({ skill: false }); try { assert.equal(check(value).consistent, false); } finally { value.cleanup(); } });
test("forbidden writer browse boundary fails closed", () => { const value = fixture({ dailyPrompt: `${DAILY}\nWriter 禁止浏览` }); try { assert.equal(check(value).consistent, false); } finally { value.cleanup(); } });
