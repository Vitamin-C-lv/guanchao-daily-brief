import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkAutomationConsistency } from "./check-automation-consistency.mjs";

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

const CONFIG = {
  schemaVersion: "codex-writer-automation-v1",
  publicationEnabled: true,
  productionApplyRequiresExplicitWrite: true,
  runtime: {
    projectPath: "D:/周报个人网站-local-writer-runtime",
    repositoryPath: "D:/周报个人网站",
    recoveryRoot: "C:/Codex-Recovery/GuanchaoWriter"
  },
  writer: { model: "gpt-5.6-luna" },
  prediction: { model: "gpt-5.6-luna" },
  schedules: [
    { key: "prediction", automationId: null, enabled: true, rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=45", timezone: "Asia/Shanghai" },
    { key: "daily", automationId: null, enabled: true, rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=30", timezone: "Asia/Shanghai" },
    { key: "weekly", automationId: null, enabled: true, rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0", timezone: "Asia/Shanghai" }
  ]
};

const GOOD_DOCS = `# 本机 Codex Writer 与预测发布自动化
publicationEnabled=true，productionApplyRequiresExplicitWrite=true。
日报/周报通过 codex-writer-finalize.mjs --write 显式发布；预测通过 run-prediction-publisher.mjs --write 显式发布。
任一不一致时安全失败并输出 AUTOMATION_DRIFT。`;

const DAILY_PROMPT = `publicationEnabled=true
productionApplyRequiresExplicitWrite=true
运行观潮本机 Codex 日报写手。先 refresh writer packet；STALE_WRITER_PACKET 时停止。
正式写手 guanchao-financial-writer；缺少 Skill 时 WRITER_SKILL_MISSING 并停止。
prepare --edition daily --write；finalize --dry-run 后 finalize --write；
pnpm validate:brief；pnpm validate:weekly；pnpm validate:prediction-ledger；pnpm typecheck；pnpm build。
commit chore(content): publish daily brief YYYY-MM-DD；push main；验证 Vercel。`;

const WEEKLY_PROMPT = `publicationEnabled=true
productionApplyRequiresExplicitWrite=true
运行观潮本机 Codex 周报写手。正式写手 guanchao-financial-writer；缺少 Skill 时 WRITER_SKILL_MISSING 并停止。
prepare --edition weekly --write；finalize --dry-run 后 finalize --write；
commit chore(content): publish weekly brief YYYY-Www；push main；验证 Vercel。`;

const PREDICTION_PROMPT = `publicationEnabled=true
运行观潮预测发布任务。node scripts/run-prediction-publisher.mjs --edition-date YYYY-MM-DD --write；
禁止训练；禁止激活 shadow candidate；没有新交易日时 status=no-op。`;

function toml(id, name, rrule, model, prompt, cwds = ["D:/周报个人网站"]) {
  return `version = 1
id = "${id}"
kind = "cron"
name = "${name}"
prompt = '''${prompt}'''
status = "ACTIVE"
rrule = "${rrule}"
model = "${model}"
reasoning_effort = "xhigh"
execution_environment = "local"
target = { type = "project", project_id = "local-test" }
cwds = [${cwds.map((cwd) => `"${cwd}"`).join(", ")}]
`;
}

function fixture({ docs = GOOD_DOCS, dailyPrompt = DAILY_PROMPT, promptShaMismatch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automation-consistency-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(path.join(repo, "config"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
  fs.writeFileSync(path.join(repo, "config", "codex-writer-automation.json"), `${JSON.stringify(CONFIG, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(repo, "docs", "CODEX_WRITER_AUTOMATION.md"), docs, "utf8");
  const automations = path.join(root, "automations");
  for (const [id, name, rrule, prompt] of [
    ["codex", "观潮本机 Codex 日报写手", "FREQ=DAILY;BYHOUR=7;BYMINUTE=30;BYSECOND=0", dailyPrompt],
    ["codex-2", "观潮本机 Codex 周报写手", "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0;BYSECOND=0", WEEKLY_PROMPT],
    ["codex-3", "Guanchao Prediction Publisher", "FREQ=DAILY;BYHOUR=6;BYMINUTE=45;BYSECOND=0", PREDICTION_PROMPT]
  ]) {
    fs.mkdirSync(path.join(automations, id), { recursive: true });
    fs.writeFileSync(path.join(automations, id, "automation.toml"), toml(id, name, rrule, "gpt-5.6-luna", prompt), "utf8");
  }
  const state = {
    schemaVersion: "guanchao-automation-state-v1",
    dailyAutomationId: "codex",
    weeklyAutomationId: "codex-2",
    predictionAutomationId: "codex-3",
    configSha256: sha256(`${JSON.stringify(CONFIG, null, 2)}\n`),
    prompts: {
      daily: { sha256: sha256(DAILY_PROMPT) },
      weekly: { sha256: sha256(WEEKLY_PROMPT) },
      prediction: { sha256: sha256(PREDICTION_PROMPT) }
    },
    enabled: true
  };
  if (promptShaMismatch) state.prompts.daily.sha256 = "a".repeat(64);
  const stateFile = path.join(root, "automation-state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const skillDirectory = path.join(root, "skills", "guanchao-financial-writer");
  fs.mkdirSync(path.join(skillDirectory, "references"), { recursive: true });
  fs.mkdirSync(path.join(skillDirectory, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillDirectory, "SKILL.md"), "---\nname: guanchao-financial-writer\n---\n", "utf8");
  return { root, repo, automations, stateFile, skillDirectory, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function check(value) {
  return checkAutomationConsistency({
    configPath: path.join(value.repo, "config", "codex-writer-automation.json"),
    docsPath: path.join(value.repo, "docs", "CODEX_WRITER_AUTOMATION.md"),
    automationsRoot: value.automations,
    statePath: value.stateFile,
    skillDirectory: value.skillDirectory
  });
}

test("consistent fixture uses an explicit skill directory, not runner HOME", () => {
  const value = fixture();
  try {
    const report = check(value);
    assert.equal(report.consistent, true);
    assert.equal(report.checks.length > 10, true);
    assert.equal(report.checks.find((item) => item.name === "writer.skill guanchao-financial-writer installed").detail, value.skillDirectory);
    assert.equal(report.checks.find((item) => item.name === "writer.skill frontmatter name").passed, true);
  } finally {
    value.cleanup();
  }
});

test("missing required skill fixture file fails closed", () => {
  const value = fixture();
  try {
    fs.rmSync(path.join(value.skillDirectory, "SKILL.md"));
    const report = check(value);
    assert.equal(report.consistent, false);
    assert.equal(report.checks.find((item) => item.name === "writer.skill guanchao-financial-writer installed").passed, false);
  } finally {
    value.cleanup();
  }
});

test("config=true but native prompt=false fails with AUTOMATION_DRIFT", () => {
  const value = fixture({ dailyPrompt: "publicationEnabled=false\n仅 dry-run\n不得 commit、push、merge 或部署。" });
  try {
    const report = check(value);
    assert.equal(report.consistent, false);
    const promptCheck = report.checks.find((item) => item.name === "daily.prompt has no dry-run/false fragments");
    assert.equal(promptCheck.passed, false);
  } finally {
    value.cleanup();
  }
});

test("docs disagreeing with config fail", () => {
  const value = fixture({ docs: "publicationEnabled 固定为 false。任务只做 dry-run，不发布。" });
  try {
    const report = check(value);
    assert.equal(report.consistent, false);
    const docsCheck = report.checks.find((item) => item.name === "docs do not state fixed false");
    assert.equal(docsCheck.passed, false);
  } finally {
    value.cleanup();
  }
});

test("native prompt SHA drift fails", () => {
  const value = fixture({ promptShaMismatch: true });
  try {
    const report = check(value);
    assert.equal(report.consistent, false);
    const shaCheck = report.checks.find((item) => item.name === "daily.native prompt sha256 matches state");
    assert.equal(shaCheck.passed, false);
  } finally {
    value.cleanup();
  }
});

test("native schedule mismatch fails", () => {
  const value = fixture();
  try {
    const file = path.join(value.automations, "codex", "automation.toml");
    const text = fs.readFileSync(file, "utf8").replace("FREQ=DAILY;BYHOUR=7;BYMINUTE=30", "FREQ=DAILY;BYHOUR=8;BYMINUTE=0");
    fs.writeFileSync(file, text, "utf8");
    const report = check(value);
    assert.equal(report.consistent, false);
    const scheduleCheck = report.checks.find((item) => item.name === "daily.native rrule matches config");
    assert.equal(scheduleCheck.passed, false);
  } finally {
    value.cleanup();
  }
});

test("native model mismatch fails", () => {
  const value = fixture();
  try {
    const file = path.join(value.automations, "codex-2", "automation.toml");
    const text = fs.readFileSync(file, "utf8").replace('model = "gpt-5.6-luna"', 'model = "gpt-4.1"');
    fs.writeFileSync(file, text, "utf8");
    const report = check(value);
    assert.equal(report.consistent, false);
    const modelCheck = report.checks.find((item) => item.name === "weekly.native model matches config");
    assert.equal(modelCheck.passed, false);
  } finally {
    value.cleanup();
  }
});
