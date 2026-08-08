import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAutomationHandover } from "./build-automation-handover.mjs";

test("automation handover reports actual native fallbacks and disabled candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-handover-"));
  const automations = path.join(root, "automations");
  const configPath = path.join(root, "config.json");
  const statePath = path.join(root, "state.json");
  const prompt = (schedule, extra = "") => `prompt = "publicationEnabled=true\\nlegacyProductionFallback=true\\nschedule=${schedule}\\n--write\\n${extra}"\nstatus = "ACTIVE"\nrrule = "${schedule.includes("Saturday") ? "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0" : schedule.includes("07:30") ? "FREQ=DAILY;BYHOUR=7;BYMINUTE=30" : "FREQ=DAILY;BYHOUR=6;BYMINUTE=45"}"\ncwds = []\n`;
  fs.mkdirSync(path.join(automations, "prediction"), { recursive: true });
  fs.mkdirSync(path.join(automations, "daily"), { recursive: true });
  fs.mkdirSync(path.join(automations, "weekly"), { recursive: true });
  fs.writeFileSync(path.join(automations, "prediction", "automation.toml"), prompt("06:45 Asia/Shanghai"));
  fs.writeFileSync(path.join(automations, "daily", "automation.toml"), prompt("07:30 Asia/Shanghai"));
  fs.writeFileSync(path.join(automations, "weekly", "automation.toml"), prompt("Saturday 10:00 Asia/Shanghai", "20D Brier calibration abstention"));
  fs.writeFileSync(configPath, JSON.stringify({
    schedules: [
      { key: "prediction", legacyAutomationId: "prediction", executor: "windows-task-scheduler", taskName: "task", enabled: false, rrule: "FREQ=DAILY;BYHOUR=18;BYMINUTE=20", timezone: "Asia/Shanghai" },
      { key: "daily", automationId: "daily", executor: "codex-automation", enabled: false, rrule: "FREQ=DAILY;BYHOUR=20;BYMINUTE=0", timezone: "Asia/Shanghai" },
      { key: "weekly", automationId: "weekly", executor: "codex-automation", enabled: false, rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0", timezone: "Asia/Shanghai" },
    ],
    handover: { activeProduction: {
      prediction: { automationId: "prediction", rrule: "FREQ=DAILY;BYHOUR=6;BYMINUTE=45", timezone: "Asia/Shanghai" },
      daily: { automationId: "daily", rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=30", timezone: "Asia/Shanghai" },
      weekly: { automationId: "weekly", rrule: "FREQ=WEEKLY;BYDAY=SA;BYHOUR=10;BYMINUTE=0", timezone: "Asia/Shanghai" },
    } },
  }));
  fs.writeFileSync(statePath, JSON.stringify({ review: { handoverStatus: "pre-merge-safe" } }));
  const result = buildAutomationHandover({
    root,
    configPath,
    automationsRoot: automations,
    statePath,
    taskReader: () => ({ exists: true, status: "Disabled", taskToRun: "powershell.exe -File run-prediction-publisher-task.ps1 -Mode DryRun", schedule: "Daily 18:20" }),
  });
  assert.equal(result.predictionLegacy.status, "ACTIVE");
  assert.equal(result.predictionLegacy.writeCapable, true);
  assert.equal(result.dailyLegacy.status, "ACTIVE");
  assert.equal(result.dailyCandidate.exists, false);
  assert.equal(result.predictionCandidate.status, "Disabled");
  assert.equal(result.predictionCandidate.writeCapable, false);
  assert.equal(result.preMergeSafety.exactlyOneWriteCapablePredictionFallback, true);
  assert.equal(result.preMergeSafety.exactlyOneWriteCapableDailyFallback, true);
  assert.equal(result.preMergeSafety.candidatesWriteCapable, false);
  fs.rmSync(root, { recursive: true, force: true });
});
