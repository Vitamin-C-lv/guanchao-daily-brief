import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { checkAutomationConsistency } from "./check-automation-consistency.mjs";
import { generateArticleVisuals, validateVisualBundle } from "./article-visuals.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SKILL_DIR = path.join(os.homedir(), ".codex", "skills", "guanchao-financial-writer");
const LEGACY_SKILL_DIR = path.join(os.homedir(), ".codex", "skills", "guanchao-financial-editor-skill");
const AUTOMATIONS = {
  daily: "C:/Users/18442/.codex/automations/codex/automation.toml",
  weekly: "C:/Users/18442/.codex/automations/codex-2/automation.toml"
};

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

function repoTextFiles() {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (["node_modules", ".next", "out", ".git"].includes(entry.name)) continue;
        walk(file);
      } else if (/\.(md|json|mjs|js|ts|tsx|ps1|py|txt|toml|yaml|yml)$/.test(entry.name)) {
        files.push(file);
      }
    }
  };
  walk(REPO_ROOT);
  return files;
}

test("01 legacy skill directory is removed", () => {
  assert.equal(fs.existsSync(LEGACY_SKILL_DIR), false);
});

test("02 repository has no legacy skill reference", () => {
  // The consistency checker and this test file intentionally embed the legacy name
  // as a forbidden pattern; production content, prompts and docs must not.
  const exempt = new Set([
    path.join(REPO_ROOT, "scripts", "check-automation-consistency.mjs"),
    path.join(REPO_ROOT, "scripts", "skill-cleanup.test.mjs")
  ]);
  const hits = repoTextFiles()
    .filter((file) => !exempt.has(file))
    .filter((file) => {
      const text = fs.readFileSync(file, "utf8");
      return text.includes("guanchao-financial-editor-skill");
    })
    .map((file) => path.relative(REPO_ROOT, file));
  assert.deepEqual(hits, []);
});

test("03 daily automation has no legacy skill reference", () => {
  const text = fs.readFileSync(AUTOMATIONS.daily, "utf8");
  assert.equal(text.includes("guanchao-financial-editor-skill"), false);
});

test("04 weekly automation has no legacy skill reference", () => {
  const text = fs.readFileSync(AUTOMATIONS.weekly, "utf8");
  assert.equal(text.includes("guanchao-financial-editor-skill"), false);
});

test("05 missing writer skill fails the consistency gate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cleanup-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "config"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    const config = {
      schemaVersion: "codex-writer-automation-v1",
      publicationEnabled: true,
      productionApplyRequiresExplicitWrite: true,
      runtime: { projectPath: "D:/周报个人网站-local-writer-runtime", repositoryPath: "D:/周报个人网站", recoveryRoot: "C:/Codex-Recovery/GuanchaoWriter" },
      writer: { model: "gpt-5.6-luna" },
      prediction: { model: "gpt-5.6-luna" },
      schedules: [
        { key: "prediction", enabled: true, rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=45", timezone: "Asia/Shanghai" },
        { key: "daily", enabled: true, rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=30", timezone: "Asia/Shanghai" },
        { key: "weekly", enabled: true, rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0", timezone: "Asia/Shanghai" }
      ]
    };
    const docs = "publicationEnabled=true，productionApplyRequiresExplicitWrite=true。";
    fs.writeFileSync(path.join(repo, "config", "codex-writer-automation.json"), `${JSON.stringify(config, null, 2)}\n`);
    fs.writeFileSync(path.join(repo, "docs", "CODEX_WRITER_AUTOMATION.md"), docs, "utf8");
    const automations = path.join(root, "automations");
    const promptDaily = "publicationEnabled=true\nguanchao-financial-writer\nWRITER_SKILL_MISSING\nfinalize\n--write\nSTALE_WRITER_PACKET\nchore(content): publish daily brief";
    const promptWeekly = "publicationEnabled=true\nguanchao-financial-writer\nWRITER_SKILL_MISSING\nfinalize\n--write\nchore(content): publish weekly brief";
    const promptPrediction = "publicationEnabled=true\nrun-prediction-publisher.mjs\n禁止训练\n禁止激活 shadow candidate\nno-op";
    for (const [id, prompt] of [["codex", promptDaily], ["codex-2", promptWeekly], ["codex-3", promptPrediction]]) {
      fs.mkdirSync(path.join(automations, id), { recursive: true });
      fs.writeFileSync(path.join(automations, id, "automation.toml"), `version = 1\nid = "${id}"\nkind = "cron"\nprompt = '''${prompt}'''\nstatus = "ACTIVE"\nrrule = "FREQ=DAILY;BYHOUR=7;BYMINUTE=30;BYSECOND=0"\nmodel = "gpt-5.6-luna"\ncwds = ["D:\\\\周报个人网站"]\n`, "utf8");
    }
    const state = {
      schemaVersion: "guanchao-automation-state-v1",
      dailyAutomationId: "codex",
      weeklyAutomationId: "codex-2",
      predictionAutomationId: "codex-3",
      configSha256: sha256(`${JSON.stringify(config, null, 2)}\n`),
      prompts: {
        daily: { sha256: sha256(promptDaily) },
        weekly: { sha256: sha256(promptWeekly) },
        prediction: { sha256: sha256(promptPrediction) }
      },
      enabled: true
    };
    fs.writeFileSync(path.join(root, "automation-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
    const report = checkAutomationConsistency({
      configPath: path.join(repo, "config", "codex-writer-automation.json"),
      docsPath: path.join(repo, "docs", "CODEX_WRITER_AUTOMATION.md"),
      automationsRoot: automations,
      statePath: path.join(root, "automation-state.json"),
      skillDirectory: path.join(root, "missing-skill")
    });
    assert.equal(report.consistent, false);
    const skillChecks = report.checks.filter((check) => check.name.startsWith("writer.skill"));
    assert.ok(skillChecks.length > 0);
    assert.ok(skillChecks.some((check) => !check.passed));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makePacket() {
  const facts = [
    { factId: "treasury-nominal2y-2026-08-03", label: "US Treasury 2Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 4.25, asOf: "2026-08-03" },
    { factId: "treasury-nominal10y-2026-08-03", label: "US Treasury 10Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 4.7, asOf: "2026-08-03" },
    { factId: "treasury-nominal30y-2026-08-03", label: "US Treasury 30Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 5.23, asOf: "2026-08-03" },
    { factId: "treasury-real10y-2026-08-03", label: "US Treasury real 10Y", market: "US", topic: "treasury", sourceId: "us-treasury-real-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 2.43, asOf: "2026-08-03" },
    { factId: "treasury-spread2s10sBp-2026-08-03", label: "US Treasury 2s10s spread", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "bp", value: 45, asOf: "2026-08-03" }
  ];
  return { facts, marketDates: { us: "2026-08-03", aShare: "2026-08-03" } };
}

function bundle() {
  const research = { facts: [{ subject: "S&P 500 close", claimText: "S&P 500 rose 1.5% on 2026-08-03 to 7,600.50." }, { subject: "Shanghai Composite close", claimText: "Shanghai Composite fell 0.59% on 2026-08-03 to 3,809.66." }, { subject: "Hang Seng Index close", claimText: "Hang Seng Index rose 0.48% on 2026-08-03 to 26,009.40." }] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cleanup-visual-"));
  const bundleValue = generateArticleVisuals({ edition: "daily", packet: makePacket(), research, rotation: { markets: [] }, root, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  fs.rmSync(root, { recursive: true, force: true });
  return bundleValue;
}

function codeOf(action) {
  try {
    action();
    return null;
  } catch (cause) {
    return cause.code ?? cause.message;
  }
}

test("06 visual generation never mutates model, ledger or history files", () => {
  const target = path.join(os.tmpdir(), `skill-cleanup-files-${Date.now()}`);
  fs.mkdirSync(target, { recursive: true });
  const probe = path.join(target, "data", "prediction-ledger", "index.json");
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  fs.writeFileSync(probe, JSON.stringify({ marker: "ledger" }));
  try {
    generateArticleVisuals({ edition: "daily", packet: makePacket(), research: { facts: [] }, rotation: { markets: [] }, root: target, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
    assert.equal(fs.readFileSync(probe, "utf8"), JSON.stringify({ marker: "ledger" }));
  } catch {
    // no visuals is acceptable for this governance probe; the important part is the file stayed unchanged
    assert.equal(fs.readFileSync(probe, "utf8"), JSON.stringify({ marker: "ledger" }));
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test("07 changing chart sources breaks the frozen hash", () => {
  const value = bundle();
  const tampered = { ...value, visuals: [{ ...value.visuals[0], sourceIndexes: [9], contentSha256: value.visuals[0].contentSha256 }], integrity: value.integrity };
  assert.equal(codeOf(() => validateVisualBundle(tampered)), "VISUAL_HASH");
});

test("08 changing chart date breaks the frozen hash", () => {
  const value = bundle();
  const tampered = { ...value, visuals: [{ ...value.visuals[0], dataThrough: "2026-08-01", contentSha256: value.visuals[0].contentSha256 }], integrity: value.integrity };
  assert.equal(codeOf(() => validateVisualBundle(tampered)), "VISUAL_HASH");
});

test("09 changing chart numbers breaks the frozen hash", () => {
  const value = bundle();
  const tampered = { ...value, visuals: [{ ...value.visuals[0], points: value.visuals[0].points.map((point) => ({ ...point, y: point.y === null ? null : point.y + 1 })), contentSha256: value.visuals[0].contentSha256 }], integrity: value.integrity };
  assert.equal(codeOf(() => validateVisualBundle(tampered)), "VISUAL_HASH");
});
