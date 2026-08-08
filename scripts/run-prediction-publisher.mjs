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
import { buildAllPackets, writePackets } from "./build-market-packets.mjs";
import { checkAutomationConsistency } from "./check-automation-consistency.mjs";

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
  "content/prediction-diagnostics.json",
  "content/prediction-review-latest.json",
  "content/prediction-review/",
  "public/data/predictions/",
  "data/prediction-ledger/",
  "public/data/prediction-history/",
  "content/prediction-history.json",
  "data/sector-rotation/",
  "data/rotation-model/",
  "data/market-evidence/",
  "content/writer-packets/"
];

// Machine-local stage-2 private research outputs consumed by the HK/US
// publication gate.  The stable path lives under the automation runtime
// (D:/Guanchao-Workspace/runtime/model-research/stage2-three-market) and
// never enters the public DTO.  Override via --research-output or
// GUANCHAO_STAGE2_RESEARCH_OUTPUT; the temp fallback is no longer used.
const DEFAULT_RESEARCH_OUTPUT = "D:/Guanchao-Workspace/runtime/model-research/stage2-three-market";

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

function gitHead(root) {
  const result = git(root, "rev-parse", "HEAD");
  return result.stdout.trim();
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

/**
 * Precise workspace restore for dry-run and pre-commit failures.
 *
 * - Restores every modified/deleted tracked path with `git restore` on the
 *   exact path (never git clean / reset --hard / stash).
 * - Removes exactly the untracked files created during this run.  The runtime
 *   is verified clean before the run, so any untracked path is ours.
 * - Never touches paths outside the repository.
 */
function restoreWorkspace(root) {
  const cleanup = { cleanupAttempted: true, restoredTracked: [], removedUntracked: [], remainingChanges: [] };
  const rootPath = path.resolve(root);
  const changes = gitStatusShort(root);
  for (const line of changes) {
    const status = line.slice(0, 2).trim();
    const relative = changedRelative(line);
    if (status === "??") {
      const file = path.join(rootPath, ...relative.split("/"));
      try {
        fs.rmSync(file, { recursive: true, force: true });
        cleanup.removedUntracked.push(relative);
        let dir = path.dirname(file);
        while (dir.startsWith(rootPath) && dir !== rootPath) {
          try {
            fs.rmdirSync(dir);
          } catch {
            break;
          }
          dir = path.dirname(dir);
        }
      } catch {
        cleanup.remainingChanges.push(`?? ${relative}`);
      }
    } else {
      const restored = run("git", ["-C", root, "restore", "--", relative], { cwd: root, allowFailure: true });
      if (restored.ok) {
        cleanup.restoredTracked.push(relative);
      } else {
        cleanup.remainingChanges.push(line);
      }
    }
  }
  cleanup.remainingChanges = [...cleanup.remainingChanges, ...gitStatusShort(root)];
  cleanup.cleanupSucceeded = cleanup.remainingChanges.length === 0;
  return cleanup;
}

function applyCleanupReport(report, cleanup, root, headBefore) {
  report.cleanupAttempted = cleanup.cleanupAttempted;
  report.cleanupSucceeded = cleanup.cleanupSucceeded;
  report.remainingChanges = cleanup.remainingChanges;
  report.restoredTracked = cleanup.restoredTracked;
  report.removedUntracked = cleanup.removedUntracked;
  report.workspaceRestored = cleanup.cleanupSucceeded;
  report.headUnchanged = headBefore === null || gitHead(root) === headBefore;
  return report;
}

export async function runPredictionPublisher({
  editionDate = null,
  dryRun = false,
  write = false,
  researchOutput = null,
  root = repositoryRoot,
  runsRoot = null,
  lockFile = null,
  marketRunner = "scripts/run-market-evidence.mjs",
  rotationRunner = "scripts/run-sector-rotation.mjs",
  ledgerCommand = null,
  skipVercel = false,
  consistencyCheck = root === repositoryRoot,
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
  const report = { schemaVersion: "prediction-publisher-report-v1", editionDate: effectiveEditionDate, dryRun, status: "pending", writeApplied: false, steps: [] };
  const step = (name, value) => report.steps.push({ name, ...value });
  let headBefore = null;
  let cleanup = null;
  try {
    if (consistencyCheck) {
      const consistency = checkAutomationConsistency({ configPath: path.join(root, "config", "codex-writer-automation.json"), docsPath: path.join(root, "docs", "CODEX_WRITER_AUTOMATION.md") });
      if (!consistency.consistent) fail("AUTOMATION_DRIFT", "automation config/native task/prompt mismatch");
      report.automationConsistency = { schemaVersion: consistency.schemaVersion, consistent: true };
      step("automation-consistency", { ok: true });
    }
    // 2. runtime pull --ff-only (runtime must be clean before pull)
    const dirtyBefore = gitStatusShort(root);
    if (dirtyBefore.length) fail("RUNTIME_DIRTY", `stable runtime is not clean before pull: ${dirtyBefore.join(", ")}`);
    git(root, "fetch", "origin");
    const pull = run("git", ["-C", root, "pull", "--ff-only", "origin", "main"], { cwd: root, allowFailure: true, env });
    step("runtime-pull", { ok: pull.ok, detail: pull.detail.slice(0, 500) });
    // Record the run baseline (HEAD + clean workspace) before any modification.
    headBefore = gitHead(root);
    const statusBefore = gitStatusShort(root);
    if (statusBefore.length) fail("RUNTIME_DIRTY", `stable runtime is not clean after pull: ${statusBefore.join(", ")}`);

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

    // 6b. HK/US publication gate (stage3).  The gate reads the frozen stage-2
    // private research outputs; every HK/US horizon must remain blocked now.
    const effectiveResearchOutput = researchOutput ?? process.env.GUANCHAO_STAGE2_RESEARCH_OUTPUT ?? DEFAULT_RESEARCH_OUTPUT;
    if (!fs.existsSync(path.join(effectiveResearchOutput, "RUN_RESULT.json"))) {
      fail("PRIVATE_OUTPUT_MISSING", `stage2 private research output is required: ${effectiveResearchOutput}`);
    }
    const gateFile = path.join(runDirectory, "publication-gate-results.json");
    const statesFile = path.join(runDirectory, "ledger-states.json");
    const gateRun = run("node", [
      "scripts/prediction-publication-gate.mjs",
      "--research-output", effectiveResearchOutput,
      "--rotation", "content/sector-rotation.json",
      "--states-output", statesFile,
      "--output", gateFile,
      "--forbid-published",
    ], { cwd: root, allowFailure: true, env });
    const gateReport = ledgerReportFromJson(gateRun.stdout);
    if (!gateRun.ok || !gateReport?.summary) fail("GATE_FAILED", `publication gate failed: ${gateRun.detail.slice(0, 800)}`);
    report.publicationGate = gateReport.summary;
    step("publication-gate", { ok: true, summary: gateReport.summary });

    // 6c. Build and validate the public current-prediction DTO.
    const dtoRun = run("node", [
      "scripts/build-public-prediction-view.mjs",
      "--research-output", effectiveResearchOutput,
      "--rotation", "content/sector-rotation.json",
      "--history", "public/data/prediction-history/index.json",
      "--output", "public/data/predictions/current.json",
      "--now", `${effectiveEditionDate}T12:00:00+08:00`,
    ], { cwd: root, allowFailure: true, env });
    const dtoReport = ledgerReportFromJson(dtoRun.stdout);
    if (!dtoRun.ok || !dtoReport) fail("DTO_BUILD_FAILED", `public DTO build failed: ${dtoRun.detail.slice(0, 800)}`);
    report.publicDto = { ok: true, shouldWrite: dtoReport.shouldWrite ?? null };
    step("public-dto", { ok: true, shouldWrite: dtoReport.shouldWrite ?? null });
    const dtoValidate = run("node", ["scripts/validate-public-prediction-view.mjs"], { cwd: root, allowFailure: true, env });
    if (!dtoValidate.ok) fail("DTO_INVALID", `public DTO validation failed: ${dtoValidate.detail.slice(0, 800)}`);
    step("validate-public-dto", { ok: true });

    // 11-14. immutable ledger snapshot/evaluations/review/public export
    let ledgerReport = null;
    if (ledgerCommand) {
      const ledgerResult = run(ledgerCommand[0], [...ledgerCommand.slice(1), "--states", statesFile], { cwd: root, allowFailure: true, env });
      ledgerReport = ledgerReportFromJson(ledgerResult.stdout);
      step("ledger-automation", { ok: ledgerResult.ok, detail: ledgerResult.detail.slice(0, 1200), report: ledgerReport });
      if (!ledgerResult.ok) fail("LEDGER_FAILED", `ledger automation failed: ${ledgerResult.detail.slice(0, 800)}`);
    } else {
      // Windows zoneinfo needs the tzdata package for Asia/Shanghai.
      const uvLedger = run("uv", ["run", "--no-project", "--python", "3.12", "--with", "requests", "--with", "tzdata", "python", "scripts/prediction_ledger_automation.py", "--mode", "daily", "--states", statesFile], { cwd: root, allowFailure: true, env });
      ledgerReport = ledgerReportFromJson(uvLedger.stdout);
      step("ledger-automation", { ok: uvLedger.ok, detail: uvLedger.detail.slice(0, 1200), report: ledgerReport });
      if (!uvLedger.ok) fail("LEDGER_FAILED", `ledger automation failed: ${uvLedger.detail.slice(0, 800)}`);
    }

    // A refresh can rewrite timestamped tracked projections even when the
    // immutable ledger correctly reports that the business publication is
    // already represented. Restore those projections before validators run;
    // otherwise validate-prediction-ledger compares a fresh generatedAt with
    // the existing immutable snapshot and rejects a legitimate no-op.
    const ledgerNoOp = ledgerReport?.snapshot?.result === "NO_OP"
      && ledgerReport?.states?.result === "IDEMPOTENT_NO_OP";
    if (ledgerNoOp) {
      const noOpCleanup = restoreWorkspace(root);
      if (!noOpCleanup.cleanupSucceeded) {
        fail("NO_OP_RESTORE_FAILED", "prediction projections", `could not restore no-op projections: ${noOpCleanup.remainingChanges.join(", ")}`);
      }
      step("ledger-no-op-restore", { ok: true, restoredTracked: noOpCleanup.restoredTracked });
    }

    // 15. rotation and ledger validation
    const validateRotation = run("node", [path.join(root, "scripts", "validate-sector-rotation.mjs")], { cwd: root, allowFailure: true, env });
    const validateLedger = run("node", [path.join(root, "scripts", "validate-prediction-ledger.mjs")], { cwd: root, allowFailure: true, env });
    step("validate-rotation", { ok: validateRotation.ok, detail: validateRotation.detail.slice(0, 500) });
    step("validate-ledger", { ok: validateLedger.ok, detail: validateLedger.detail.slice(0, 500) });
    if (!validateRotation.ok || !validateLedger.ok) fail("VALIDATION_FAILED", `rotation/ledger validation failed (rotation=${validateRotation.ok}, ledger=${validateLedger.ok})`);

    // Packets are external run artifacts. They give Writer a verified fact base
    // without adding an LLM step or changing the immutable production ledger.
    const packets = buildAllPackets({ root, asOf: effectiveEditionDate, generatedAt: now.toISOString() });
    writePackets(runDirectory, packets);
    report.packets = { daily: { schemaVersion: packets.daily.schemaVersion, packetId: packets.daily.packetId, status: packets.daily.status }, review: { schemaVersion: packets.review.schemaVersion, packetId: packets.review.packetId, status: packets.review.status } };
    step("writer-packets", { ok: true, externalOnly: true, llmTokens: 0 });

    // 17. explicit write scope
    const changes = gitStatusShort(root);
    assertAllowedWrites(root, changes);
    step("write-scope", { ok: true, changedFiles: changes.length });

    // no-op detection: every changed file is business-equivalent (only timestamps moved)
    const realChanges = changes.filter((line) => !businessEquivalentFile(root, changedRelative(line)));
    const noOp = realChanges.length === 0;
    if (noOp) {
      // Precise restore keeps the stable runtime clean without git clean/reset/stash.
      cleanup = restoreWorkspace(root);
      applyCleanupReport(report, cleanup, root, headBefore);
      report.status = "no-op";
      report.commit = null;
      report.push = null;
      step("no-op", { ok: true, reason: "no new trading day or identical business bytes" });
      return report;
    }

    if (dryRun) {
      cleanup = restoreWorkspace(root);
      applyCleanupReport(report, cleanup, root, headBefore);
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
    report.writeApplied = true;
    report.workspaceRestored = false;
    report.headUnchanged = false;
    report.cleanupAttempted = false;
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
    if (!report.commit && headBefore !== null) {
      cleanup = restoreWorkspace(root);
      applyCleanupReport(report, cleanup, root, headBefore);
    } else {
      // A commit already exists (push/Vercel failures) must never be rolled back.
      report.cleanupAttempted = false;
      report.workspaceRestored = false;
      report.headUnchanged = headBefore === null || gitHead(root) === headBefore;
    }
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
      researchOutput: args["research-output"] ? path.resolve(args["research-output"]) : null,
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
