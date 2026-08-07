import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAutomationPaths, resolveConfiguredPath, toConfigPath } from "./automation-paths.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(moduleFile), "..");
const configPath = path.join(root, "config", "codex-writer-automation.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const paths = resolveAutomationPaths();
const configuredStatePath = config.runtime?.automationStatePath
  ? resolveConfiguredPath(config.runtime.automationStatePath)
  : path.join(paths.recoveryRoot, "automation-state.json");
const statePath = process.argv[2] ? path.resolve(process.argv[2]) : configuredStatePath;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function tomlPrompt(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^prompt\s*=\s*'''([\s\S]*?)'''/m);
  if (match) return match[1];
  const quoted = text.match(/^prompt\s*=\s*("(?:[^"\\]|\\.)*")/m);
  return quoted ? JSON.parse(quoted[1]) : "";
}
const promptHash = (id) => {
  const file = path.join(paths.automationsRoot, id, "automation.toml");
  const prompt = tomlPrompt(file);
  if (!prompt) throw new Error(`AUTOMATION_PROMPT_MISSING ${file}`);
  return hash(Buffer.from(prompt, "utf8"));
};
const schedules = Object.fromEntries(config.schedules.map((schedule) => [schedule.key, { rrule: schedule.rrule, timezone: schedule.timezone, enabled: schedule.enabled }]));
const state = {
  schemaVersion: "guanchao-automation-state-v3",
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
  activeProduction: config.handover?.activeProduction ?? null,
  runtime: {
    projectPath: toConfigPath(resolveConfiguredPath(config.runtime.projectPath)),
    repositoryPath: toConfigPath(resolveConfiguredPath(config.runtime.repositoryPath)),
    recoveryRoot: toConfigPath(paths.recoveryRoot),
  },
  review: {
    handoverStatus: config.handover?.status ?? "unknown",
    predictionTaskAction: config.schedules.find((schedule) => schedule.key === "prediction")?.enabled === false ? "DisabledDryRun" : "Write",
    productionApplyRequiresExternalReview: true,
  }
};
fs.mkdirSync(path.dirname(statePath), { recursive: true });
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ statePath, configSha256: state.configSha256, schedules: state.schedules, predictionExecutor: state.predictionExecutor }, null, 2));
