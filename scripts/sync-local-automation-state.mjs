import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(moduleFile), "..");
const configPath = path.join(root, "config", "codex-writer-automation.json");
const statePath = process.argv[2] ? path.resolve(process.argv[2]) : "C:\\Codex-Recovery\\GuanchaoWriter\\automation-state.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tomlPrompt(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^prompt\s*=\s*'''([\s\S]*?)'''/m);
  if (match) return match[1];
  const quoted = text.match(/^prompt\s*=\s*("(?:[^"\\]|\\.)*")/m);
  return quoted ? JSON.parse(quoted[1]) : "";
}
const promptHash = (id) => hash(Buffer.from(tomlPrompt(`C:/Users/18442/.codex/automations/${id}/automation.toml`), "utf8"));
const schedules = Object.fromEntries(config.schedules.map((schedule) => [schedule.key, { rrule: schedule.rrule, timezone: schedule.timezone, enabled: schedule.enabled }]));
const state = {
  schemaVersion: "guanchao-automation-state-v2",
  dailyAutomationId: "codex",
  weeklyAutomationId: "codex-2",
  predictionAutomationId: "guanchao-prediction-publisher",
  predictionTaskName: "Guanchao Prediction Publisher 18-20",
  predictionExecutor: "windows-task-scheduler",
  configSha256: hash(fs.readFileSync(configPath)),
  promptSha256: hash(fs.readFileSync(path.join(root, "prompts", "codex-daily-writer.md"))),
  prompts: {
    daily: { path: "prompts/codex-daily-writer.md", sha256: promptHash("codex") },
    weekly: { path: "prompts/codex-weekly-writer.md", sha256: promptHash("codex-2") },
    prediction: { path: "prompts/codex-prediction-publisher.md", sha256: hash(fs.readFileSync(path.join(root, "prompts", "codex-prediction-publisher.md"))) }
  },
  installedAt: "2026-08-07T18:00:00+08:00",
  lastVerifiedAt: new Date().toISOString(),
  model: config.writer.model,
  enabled: true,
  schedules,
  runtime: { projectPath: "D:/Guanchao-Workspace/runtime/local-writer-runtime", repositoryPath: "D:/周报个人网站", recoveryRoot: "C:/Codex-Recovery/GuanchaoWriter" },
  review: { predictionTaskAction: "DryRun", productionApplyRequiresExternalReview: true }
};
fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ statePath, configSha256: state.configSha256, schedules: state.schedules, predictionExecutor: state.predictionExecutor }, null, 2));
