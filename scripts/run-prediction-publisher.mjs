#!/usr/bin/env node
/**
 * Deterministic Guanchao prediction publisher.
 *
 * Refreshes market data, rebuilds features, runs ONLY the frozen production model infer,
 * applies the probability-quality gate, appends immutable prediction snapshots/evaluations,
 * exports public shards, validates rotation and ledger state, verifies production model
 * files are byte-identical, then explicitly commits and pushes main when there is a real
 * business change. No training, no candidate promotion, no shadow activation.
 *
 * No new trading day or identical business bytes => status=no-op with no empty commit.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestATradingDay } from "./refresh-writer-packet.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const MODEL_FILES = [
  "models/sector-rotation/a-share-relative-probability-v2.json",
  "models/sector-rotation/a-share-relative-probability-v2.lineage.json",
  "models/sector-rotation/a-share-up-probability-v1.json",
  "models/sector-rotation/a-share-v1.json",
  "models/sector-rotation/shadow-config.json",
  "models/sector-rotation/holdout-registry.json"
];

const ALLOWED_WRITE_PREFIXES = [
  "content/sector-rotation.json",
  "data/prediction-ledger/",
  "public/data/prediction-history/",
  "content/prediction-history.json",
  "data/sector-rotation/",
  "data/rotation-model/",
  "data/market-evidence/",
  "content/writer-packets/"
];

export class PredictionPublisherError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PredictionPublisherError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PredictionPublisherError(code, message);
}

function shanghaiCalendarDate(value = new Date()) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.valueOf())) fail("FRESHNESS", `invalid time: ${String(value)}`);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(cmd, args, { cwd, allowFailure = false, env = process.env } = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 20 * 60_000, env });
  const detail = (result.stderr || result.stdout || "").trim().slice(0, 2000);
  if (result.error) {
    if (allowFailure) return { ok: false, detail: result.error.message };
    fail("COMMAND_FAILED", `${cmd} ${args.join(" ")}: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    fail("COMMAND_FAILED", `${cmd} ${args.join(" ")} failed (${result.status}): ${detail}`);
  }
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", detail };
}

function git(root, ...args) {
  return run("git", ["-C", root, ...args], { cwd: root });
}

function gitStatusShort(root) {
  const result = git(root, "status", "--porcelain", "-uall");
  return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function gitHeadBytes(root, relativePath) {
  const result = run("git", ["-C", root, "show", `HEAD:${relativePath.replaceAll("\\", "/")}`], { cwd: root, allowFailure: true });
  if (!result.ok) return null;
  return Buffer.from(result.stdout, "utf8");
}

function acquireLock(lockFile) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    fs.closeSync(fd);
    return () => {
      try { fs.unlinkSync(lockFile); } catch { /* already released */ }
    };
  } catch {
    fail("LOCK_HELD", `another prediction/daily run holds the lock: ${lockFile}`);
  }
}

const TIMESTAMP_FIELDS = new Set(["generatedAt", "requestedAt", "completedAt"]);

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (TIMESTAMP_FIELDS.has(key)) continue;
      copy[key] = stripTimestamps(item);
    }
    return copy;
  }
  return value;
}

function businessEquivalence(currentText, headText) {
  try {
    return JSON.stringify(stripTimestamps(JSON.parse(currentText))) === JSON.stringify(stripTimestamps(JSON.parse(headText)));
  } catch {
    return currentText === headText;
  }
}

function changedRelative(line) {
  return line.slice(3).trim().replaceAll("\\", "/");
}

function businessEquivalentFile(root, relative) {
  const headBytes = gitHeadBytes(root, relative);
  if (headBytes === null) return false; // untracked/new file is a real change
  const file = path.join(root, ...relative.split("/"));
  if (!fs.existsSync(file)) return false;
  return businessEquivalence(fs.readFileSync(file, "utf8"), headBytes.toString("utf8"));
}

function modelSnapshot(root) {
  const snapshot = {};
  for (const relative of MODEL_FILES) {
    const file = path.join(root, ...relative.split("/"));
    snapshot[relative] = fs.existsSync(file) ? hashBytes(fs.readFileSync(file)) : null;
  }
  return snapshot;
}

function assertModelsUnchanged(before, after) {
  const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
  if (changed.length) fail("MODEL_CHANGED", `production model files changed: ${changed.join(", ")}`);
}

function outputTypeFromRotation(payload) {
  const aShare = payload.markets?.find((market) => market.id === "a-share");
  const horizons = aShare?.horizons ?? {};
  const forecasts = ["tomorrow", "oneWeek", "oneMonth"].map((key) => horizons[key]).filter(Boolean);
  const published = forecasts.filter((horizon) => horizon.publicationStatus === "published");
  const modes = new Set(forecasts.map((horizon) => horizon.outputMode));
  if (published.length > 0) return { type: "probability", publishedCount: published.length, modes: [...modes] };
  const observation = [...modes].some((mode) => mode === "evidence_observation" || mode === "current_observation");
  return { type: observation ? "evidence_observation" : "abstained", publishedCount: 0, modes: [...modes] };
}

function assertAllowedWrites(root, changes) {
  const forbidden = changes.filter((line) => !ALLOWED_WRITE_PREFIXES.some((prefix) => {
    const relative = changedRelative(line);
    return relative === prefix || relative.startsWith(prefix);
  }));
  if (forbidden.length) fail("WRITE_BOUNDARY", `changes outside the allowed prediction write scope: ${forbidden.join(", ")}`);
}

function ledgerReportFromJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function runPredictionPublisher({
  editionDate = null,
  dryRun = false,
  write = false,
  root = repositoryRoot,
  runsRoot = null,
  lockFile = null,
  marketRunner = "scripts/run-market-evidence.mjs",
  rotationRunner = "scripts/run-sector-rotation.mjs",
  ledgerCommand = null,
  skipVercel = false,
  env = process.env,
  now = new Date()
} = {}) {
  if (dryRun === write) fail("MODE", "exactly one of dryRun or write is required");
  const effectiveEditionDate = editionDate ?? shanghaiCalendarDate(now);
  if (!DATE.test(effectiveEditionDate)) fail("FRESHNESS", `edition date must be YYYY-MM-DD: ${effectiveEditionDate}`);
  const effectiveRunsRoot = runsRoot ?? "C:/Codex-Recovery/GuanchaoWriter/runs";
  const runDirectory = path.join(effectiveRunsRoot, effectiveEditionDate, "prediction");
  fs.mkdirSync(runDirectory, { recursive: true });
  const release = acquireLock(lockFile ?? path.join(effectiveRunsRoot, "..", ".guanchao-automation.lock"));
  const report = { schemaVersion: "prediction-publisher-report-v1", editionDate: effectiveEditionDate, dryRun, status: "pending", steps: [] };
  const step = (name, value) => report.steps.push({ name, ...value });
  try {
    // 2. runtime pull --ff-only (runtime must be clean before pull)
    const dirtyBefore = gitStatusShort(root);
    if (dirtyBefore.length) fail("RUNTIME_DIRTY", `stable runtime is not clean before pull: ${dirtyBefore.join(", ")}`);
    git(root, "fetch", "origin");
    const pull = run("git", ["-C", root, "pull", "--ff-only", "origin", "main"], { cwd: root, allowFailure: true, env });
    step("runtime-pull", { ok: pull.ok, detail: pull.detail.slice(0, 500) });

    // 3. refresh market data (official sources + writer packet) and rotation history
    const marketFile = path.resolve(root, ...String(marketRunner).split("/"));
    const marketAsOf = latestATradingDay(effectiveEditionDate, root, now);
    const refresh = run("node", [marketFile, "run", "--edition", "daily", "--as-of", marketAsOf], { cwd: root, allowFailure: true, env });
    step("market-data-refresh", { ok: refresh.ok, detail: refresh.detail.slice(0, 800) });
    const rotationFile = path.resolve(root, ...String(rotationRunner).split("/"));
    // 4-5. structured rotation refresh (fetch official history through the latest complete
    // trading day, breadth, features) then frozen production model infer only (never train).
    const modelsBefore = modelSnapshot(root);
    const refreshResult = run("node", [rotationFile, "refresh", "--end", marketAsOf], { cwd: root, allowFailure: true, env });
    if (!refreshResult.ok) fail("INFER_FAILED", `rotation refresh/infer failed through ${marketAsOf}: ${refreshResult.detail.slice(0, 1500)}`);
    step("model-infer", { ok: true, asOf: marketAsOf });

    // 16. model files must remain byte-identical after infer
    assertModelsUnchanged(modelsBefore, modelSnapshot(root));
    step("model-sha", { ok: true, files: MODEL_FILES.length });

    // 6-8. probability-quality gate and output type
    const rotationPath = path.join(root, "content", "sector-rotation.json");
    const rotationPayload = JSON.parse(fs.readFileSync(rotationPath, "utf8"));
    const output = outputTypeFromRotation(rotationPayload);
    step("probability-gate", { ok: true, outputType: output.type, publishedCount: output.publishedCount, modes: output.modes });
    if (output.type === "evidence_observation" || output.type === "abstained") {
      step("observation-board", { ok: true, note: "规则观察分，不是概率" });
    }

    // 11-14. immutable ledger snapshot/evaluations/review/public export
    let ledgerReport = null;
    if (ledgerCommand) {
      const ledgerResult = run(ledgerCommand[0], ledgerCommand.slice(1), { cwd: root, allowFailure: true, env });
      ledgerReport = ledgerReportFromJson(ledgerResult.stdout);
      step("ledger-automation", { ok: ledgerResult.ok, detail: ledgerResult.detail.slice(0, 1200), report: ledgerReport });
    } else {
      // Windows zoneinfo needs the tzdata package for Asia/Shanghai.
      const uvLedger = run("uv", ["run", "--no-project", "--python", "3.12", "--with", "requests", "--with", "tzdata", "python", "scripts/prediction_ledger_automation.py", "--mode", "daily"], { cwd: root, allowFailure: true, env });
      ledgerReport = ledgerReportFromJson(uvLedger.stdout);
      step("ledger-automation", { ok: uvLedger.ok, detail: uvLedger.detail.slice(0, 1200), report: ledgerReport });
    }

    // 15. rotation and ledger validation
    const validateRotation = run("node", [path.join(root, "scripts", "validate-sector-rotation.mjs")], { cwd: root, allowFailure: true, env });
    const validateLedger = run("node", [path.join(root, "scripts", "validate-prediction-ledger.mjs")], { cwd: root, allowFailure: true, env });
    step("validate-rotation", { ok: validateRotation.ok, detail: validateRotation.detail.slice(0, 500) });
    step("validate-ledger", { ok: validateLedger.ok, detail: validateLedger.detail.slice(0, 500) });
    if (!validateRotation.ok || !validateLedger.ok) fail("VALIDATION_FAILED", `rotation/ledger validation failed (rotation=${validateRotation.ok}, ledger=${validateLedger.ok})`);

    // 17. explicit write scope
    const changes = gitStatusShort(root);
    assertAllowedWrites(root, changes);
    step("write-scope", { ok: true, changedFiles: changes.length });

    // no-op detection: every changed file is business-equivalent (only timestamps moved)
    const realChanges = changes.filter((line) => !businessEquivalentFile(root, changedRelative(line)));
    const noOp = realChanges.length === 0;
    if (noOp) {
      // Restore timestamp-only diffs so the stable runtime stays clean.
      for (const line of changes) {
        const relative = changedRelative(line);
        const headBytes = gitHeadBytes(root, relative);
        if (headBytes !== null) fs.writeFileSync(path.join(root, ...relative.split("/")), headBytes);
      }
      report.status = "no-op";
      report.commit = null;
      report.push = null;
      step("no-op", { ok: true, reason: "no new trading day or identical business bytes" });
      return report;
    }

    if (dryRun) {
      report.status = "dry-run";
      report.commit = null;
      report.push = null;
      return report;
    }

    // 18. commit
    const commitMessage = `chore(predictions): publish ${output.type === "probability" ? "probability ranking" : "evidence observation board"} ${effectiveEditionDate}`;
    git(root, "add", "--", ...changes.map(changedRelative));
    const commit = run("git", ["-C", root, "commit", "-m", commitMessage], { cwd: root, allowFailure: true, env });
    if (!commit.ok) fail("COMMIT_FAILED", commit.detail.slice(0, 1200));
    report.commit = { message: commitMessage, ok: true };
    step("commit", { ok: true, message: commitMessage });

    // 19. push main (never force)
    const push = run("git", ["-C", root, "push", "origin", "main"], { cwd: root, allowFailure: true, env });
    if (!push.ok) fail("PUSH_FAILED", push.detail.slice(0, 1200));
    report.push = { ok: true, remote: "origin/main" };
    step("push", { ok: true });

    // 20. Vercel verification (failure writes a report but does not repeat the commit)
    report.status = "published";
    if (!skipVercel) {
      try {
        const response = await fetch("https://guanchao-daily-brief.vercel.app/", { signal: AbortSignal.timeout(60_000) });
        report.vercel = { ok: response.ok, status: response.status, url: "https://guanchao-daily-brief.vercel.app/" };
        step("vercel", { ok: response.ok, status: response.status });
        if (!response.ok) report.vercelWarning = `Vercel returned ${response.status}; the commit was already pushed.`;
      } catch (cause) {
        report.vercel = { ok: false, error: cause instanceof Error ? cause.message.slice(0, 500) : "unknown" };
        report.vercelWarning = "Vercel verification failed; the commit was already pushed and no repeat commit was created.";
        step("vercel", { ok: false, detail: report.vercel.error });
      }
    }
    return report;
  } catch (cause) {
    report.status = "failed";
    report.error = cause instanceof Error ? `${cause.code ?? "PREDICTION_PUBLISHER_FAILURE"} ${cause.message}` : "unexpected failure";
    report.steps.push({ name: "failure", ok: false, detail: report.error });
    return report;
  } finally {
    release();
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) fail("CLI_ARGUMENT", `unknown positional argument: ${values[index]}`);
    const key = values[index].slice(2);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const args = parseArgs(process.argv.slice(2));
  if (args["dry-run"] !== true && args.write !== true || args["dry-run"] === true && args.write === true) {
    console.error("MODE exactly one of --dry-run or --write is required");
    process.exitCode = 2;
  } else {
    const report = await runPredictionPublisher({
      editionDate: args["edition-date"] ?? null,
      dryRun: args["dry-run"] === true,
      write: args.write === true,
      root: args.root ? path.resolve(args.root) : repositoryRoot,
      runsRoot: args["runs-root"] ? path.resolve(args["runs-root"]) : null,
      lockFile: args["lock-file"] ? path.resolve(args["lock-file"]) : null,
      marketRunner: args["market-runner"] ?? "scripts/run-market-evidence.mjs",
      rotationRunner: args["rotation-runner"] ?? "scripts/run-sector-rotation.mjs",
      ledgerCommand: args["ledger-command"] ? JSON.parse(args["ledger-command"]) : null,
      skipVercel: args["skip-vercel"] === true
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "failed") process.exitCode = 1;
  }
}
