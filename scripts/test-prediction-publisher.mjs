import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runPredictionPublisher } from "./run-prediction-publisher.mjs";

function write(root, relative, text) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === "string" ? text : `${JSON.stringify(text, null, 2)}\n`, "utf8");
  return file;
}

function git(root, ...args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function rotationPayload(asOf, publicationStatus = "published", outputMode = "probability") {
  return {
    schemaVersion: 1,
    generatedAt: `${asOf}T20:00:00+08:00`,
    model: { id: "guanchao-a-share-sector-relative-probability", version: "2026-07-21-relative-v2" },
    markets: [{
      id: "a-share",
      asOf,
      horizons: {
        current: { kind: "observed", status: "ready", asOf, outputMode: "current_observation", publicationStatus: "not_applicable" },
        tomorrow: { kind: "forecast", status: publicationStatus === "published" ? "ready" : "insufficient", asOf, sessions: 1, publicationStatus, outputMode, modelAvailability: "trained" },
        oneWeek: { kind: "forecast", status: publicationStatus === "published" ? "ready" : "insufficient", asOf, sessions: 5, publicationStatus, outputMode, modelAvailability: "trained" },
        oneMonth: { kind: "forecast", status: publicationStatus === "published" ? "ready" : "insufficient", asOf, sessions: 20, publicationStatus, outputMode, modelAvailability: "trained" }
      }
    }]
  };
}

function rotationStub() {
  return `import fs from "node:fs";
const args = process.argv.slice(2);
const cmd = args[0];
fs.appendFileSync(process.env.CALL_LOG || "call-log.jsonl", JSON.stringify({ cmd, args }) + "\\n");
if (cmd === "fetch" || cmd === "features") { console.log(cmd + " ok"); process.exit(0); }
if (cmd === "refresh" || cmd === "infer") {
  const asOf = process.env.ROTATION_AS_OF || "2026-08-03";
  const status = process.env.ROTATION_STATUS || "published";
  const mode = process.env.ROTATION_MODE || "probability";
  let payload = JSON.parse(fs.readFileSync(process.env.ROTATION_SOURCE || "fixture-rotation.json", "utf8"));
  payload.generatedAt = new Date().toISOString();
  payload.markets[0].asOf = asOf;
  for (const key of ["tomorrow", "oneWeek", "oneMonth"]) payload.markets[0].horizons[key].publicationStatus = status;
  for (const key of ["tomorrow", "oneWeek", "oneMonth"]) payload.markets[0].horizons[key].outputMode = mode;
  if (process.env.ROTATION_TOUCH_MODEL) {
    fs.writeFileSync("models/sector-rotation/a-share-v1.json", "changed");
  }
  if (process.env.ROTATION_TOUCH_FORBIDDEN) {
    fs.writeFileSync("content/daily-brief.json", "changed");
  }
  fs.writeFileSync("content/sector-rotation.json", JSON.stringify(payload, null, 2) + "\\n");
  console.log("infer ok");
  process.exit(0);
}
console.error("unknown command " + cmd);
process.exit(2);
`;
}

function ledgerStub() {
  return `import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
fs.mkdirSync(path.join(root, "data", "prediction-ledger"), { recursive: true });
const index = path.join(root, "data", "prediction-ledger", "index.json");
const report = JSON.parse(process.env.LEDGER_REPORT || "{\\"ok\\":true,\\"mode\\":\\"daily\\",\\"snapshot\\":{\\"written\\":true},\\"evaluations\\":{\\"appended\\":0},\\"public\\":{\\"recordCount\\":324}}");
if (process.env.LEDGER_NO_WRITE !== "1") {
  const before = fs.existsSync(index) ? fs.readFileSync(index, "utf8") : null;
  const next = JSON.stringify({ lastPredictionDate: process.env.ROTATION_AS_OF || "2026-08-03" }, null, 2) + "\\n";
  if (before !== next) fs.writeFileSync(index, next, "utf8");
}
console.log(JSON.stringify(report));
`;
}

function marketStub() {
  return `import fs from "node:fs";
const args = process.argv.slice(2);
const edition = args[args.indexOf("--edition") + 1];
const asOf = args[args.indexOf("--as-of") + 1];
fs.mkdirSync("content/writer-packets", { recursive: true });
fs.writeFileSync("content/writer-packets/" + edition + "-latest.json", JSON.stringify({ edition, asOf, generatedAt: new Date().toISOString() }) + "\\n");
console.log("market ok");
`;
}

function fixture({ rotationStatus = "published", rotationMode = "probability", asOf = "2026-08-04", ledgerNoWrite = false, ledgerWritten = true, touchModel = false, touchForbidden = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-publisher-"));
  fs.mkdirSync(path.join(root, "content"), { recursive: true });
  fs.mkdirSync(path.join(root, "content", "writer-packets"), { recursive: true });
  fs.mkdirSync(path.join(root, "models", "sector-rotation"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  write(root, "content/sector-rotation.json", rotationPayload("2026-08-03", rotationStatus, rotationMode));
  write(root, "fixture-rotation.json", rotationPayload("2026-08-03", rotationStatus, rotationMode));
  write(root, "content/writer-packets/daily-latest.json", JSON.stringify({ edition: "daily", asOf: "2026-08-03", generatedAt: "2026-08-03T20:00:00+08:00" }));
  write(root, "models/sector-rotation/a-share-v1.json", { frozen: true });
  write(root, "scripts/stub-rotation.mjs", rotationStub());
  write(root, "scripts/stub-ledger.mjs", ledgerStub());
  write(root, "scripts/stub-market.mjs", marketStub());
  write(root, "scripts/validate-sector-rotation.mjs", `console.log("fixture rotation validation ok");`);
  write(root, "scripts/validate-prediction-ledger.mjs", `console.log("fixture ledger validation ok");`);
  git(root, "init");
  git(root, "branch", "-M", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "-m", "initial");
  const bare = path.join(root, "..", `${path.basename(root)}-bare.git`);
  spawnSync("git", ["init", "--bare", bare], { encoding: "utf8" });
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-u", "origin", "HEAD:main");
  const runs = path.join(root, "runs");
  const lock = path.join(root, "..", `${path.basename(root)}-lock`);
  const env = {
    ...process.env,
    CALL_LOG: path.join(root, "..", `${path.basename(root)}-calls.jsonl`),
    ROTATION_AS_OF: asOf,
    ROTATION_STATUS: rotationStatus,
    ROTATION_MODE: rotationMode,
    ROTATION_SOURCE: path.join(root, "fixture-rotation.json"),
    LEDGER_NO_WRITE: ledgerNoWrite ? "1" : "0",
    LEDGER_REPORT: JSON.stringify({ ok: true, mode: "daily", snapshot: { written: ledgerWritten }, evaluations: { appended: 0 }, public: { recordCount: 324 } })
  };
  if (touchModel) env.ROTATION_TOUCH_MODEL = "1";
  if (touchForbidden) env.ROTATION_TOUCH_FORBIDDEN = "1";
  return {
    root,
    runs,
    lock,
    bare,
    env,
    options: {
      root,
      runsRoot: runs,
      lockFile: lock,
      marketRunner: "scripts/stub-market.mjs",
      rotationRunner: "scripts/stub-rotation.mjs",
      ledgerCommand: ["node", path.join(root, "scripts", "stub-ledger.mjs")],
      skipVercel: true,
      editionDate: "2026-08-04",
      now: new Date("2026-08-04T02:00:00Z")
    },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  };
}

test("prediction publisher publishes a probability ranking and pushes main", async () => {
  const value = fixture();
  try {
    const report = await runPredictionPublisher({ ...value.options, write: true, env: value.env });
    assert.equal(report.status, "published");
    assert.match(report.commit.message, /chore\(predictions\): publish probability ranking 2026-08-04/);
    assert.equal(report.push.ok, true);
    const remoteRef = git(value.bare, "show-ref", "--verify", "refs/heads/main");
    assert.match(remoteRef.stdout, /refs\/heads\/main/);
    const calls = fs.readFileSync(value.env.CALL_LOG, "utf8");
    assert.ok(!calls.includes("probability-train"));
    assert.ok(!calls.includes("model-research"));
  } finally {
    value.cleanup();
  }
});

test("abstention publishes the evidence observation board", async () => {
  const value = fixture({ rotationStatus: "abstained", rotationMode: "evidence_observation" });
  try {
    const report = await runPredictionPublisher({ ...value.options, write: true, env: value.env });
    assert.equal(report.status, "published");
    assert.match(report.commit.message, /evidence observation board 2026-08-04/);
    const observation = report.steps.find((item) => item.name === "observation-board");
    assert.equal(observation.ok, true);
  } finally {
    value.cleanup();
  }
});

test("no new trading day yields no-op without an empty commit", async () => {
  const value = fixture({ asOf: "2026-08-03", ledgerNoWrite: true, ledgerWritten: false });
  try {
    const before = git(value.root, "rev-parse", "HEAD").stdout.trim();
    const report = await runPredictionPublisher({ ...value.options, write: true, env: value.env });
    assert.equal(report.status, "no-op");
    assert.equal(report.commit, null);
    const after = git(value.root, "rev-parse", "HEAD").stdout.trim();
    assert.equal(after, before);
    assert.equal(git(value.root, "status", "--short").stdout.trim(), "");
  } finally {
    value.cleanup();
  }
});

test("prediction publisher never trains and never activates candidates", async () => {
  const value = fixture();
  try {
    await runPredictionPublisher({ ...value.options, write: true, env: value.env });
    const calls = fs.readFileSync(value.env.CALL_LOG, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    for (const call of calls) {
      assert.ok(!call.cmd.includes("train") && !call.cmd.includes("probability-train"), `forbidden command invoked: ${call.cmd}`);
      assert.ok(!call.args.some((arg) => arg.includes("train") || arg.includes("promotion") || arg.includes("shadow")), `forbidden argument invoked: ${JSON.stringify(call.args)}`);
    }
  } finally {
    value.cleanup();
  }
});

test("production model file changes fail the run", async () => {
  const value = fixture({ touchModel: true });
  try {
    const report = await runPredictionPublisher({ ...value.options, write: true, env: value.env });
    assert.equal(report.status, "failed");
    assert.match(report.error, /MODEL_CHANGED/);
  } finally {
    value.cleanup();
  }
});

test("writes outside the allowed scope fail the run", async () => {
  const value = fixture({ touchForbidden: true });
  try {
    const report = await runPredictionPublisher({ ...value.options, write: true, env: value.env });
    assert.equal(report.status, "failed");
    assert.match(report.error, /WRITE_BOUNDARY/);
  } finally {
    value.cleanup();
  }
});

test("dry-run computes but does not commit or push", async () => {
  const value = fixture();
  try {
    const before = git(value.root, "rev-parse", "HEAD").stdout.trim();
    const remoteBefore = git(value.bare, "show-ref", "--verify", "refs/heads/main").stdout.trim();
    const report = await runPredictionPublisher({ ...value.options, dryRun: true, env: value.env });
    assert.equal(report.status, "dry-run");
    assert.equal(report.commit, null);
    assert.equal(git(value.root, "rev-parse", "HEAD").stdout.trim(), before);
    assert.equal(git(value.bare, "show-ref", "--verify", "refs/heads/main").stdout.trim(), remoteBefore);
  } finally {
    value.cleanup();
  }
});
