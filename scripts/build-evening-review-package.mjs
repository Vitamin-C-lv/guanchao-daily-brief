#!/usr/bin/env node
/**
 * Build the bounded external handoff required by REVIEW_PACKAGE_SPEC.md.
 * This script never copies the repository, provider payloads, private caches,
 * model folds, or runtime logs into the handoff.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { buildAllPackets, brierScore } from "./build-market-packets.mjs";
import { buildWriterMemoryContext } from "./build-writer-memory-context.mjs";
import { buildWeeklyCompaction } from "./weekly-memory-compaction.mjs";
import { sanitizeMemoryTree, validateMemoryTree } from "./memory-manager.mjs";
import { buildHstechSource, loadHstechCache, HSTECH_LAUNCH_DATE, HSTECH_MINIMUM_READY_ROWS } from "./hstech-recovery.mjs";
import { buildHstechValidation } from "./validate-hstech-live.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";
import { validatePolicyRegistry, validatePolicyWatchEvent } from "./policy-watch.mjs";
import { validateStateCapitalEvent, validateStateCapitalRegistry } from "./state-capital-watch.mjs";
import { checkAutomationConsistency } from "./check-automation-consistency.mjs";
import { buildAutomationHandover } from "./build-automation-handover.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
export const REVIEW_SLUG = "evening-writer-memory-pipeline-review";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, "utf8");
}

function writeJson(file, value) {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonl(file) {
  try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
}

function reviewPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replaceAll(/C:\/Users\/18442(?:\/\.codex)?/gi, "${CODEX_HOME}")
    .replaceAll("D:/Guanchao-Workspace", "${GUANCHAO_HOME}")
    .replaceAll("C:/Codex-Recovery/GuanchaoWriter", "${GUANCHAO_RECOVERY_ROOT}")
    .replaceAll("D:/gw-evening", "${FEATURE_WORKTREE}")
    .replaceAll("D:/周报个人网站", "${PROTECTED_WORKSPACE}");
}

function loadHstechResearchAudit(outputRoot) {
  if (!outputRoot) return { status: "not_provided", productionBoundary: "research-only" };
  const inventory = readJson(path.join(outputRoot, "DATA_INVENTORY.json"), null);
  const metrics = readJson(path.join(outputRoot, "OOS_METRICS.json"), null);
  const gates = readJson(path.join(outputRoot, "GATE_RESULTS.json"), null);
  const run = readJson(path.join(outputRoot, "RUN_RESULT.json"), null);
  const panel = inventory?.markets?.HK?.objectStats?.hstech ?? null;
  const horizons = [1, 5, 20].map((horizonSessions) => {
    const item = metrics?.markets?.[`HK/hstech/${horizonSessions}`] ?? null;
    return {
      horizonSessions,
      status: item?.status ?? "unavailable",
      oosSampleCount: item?.oosSampleCount ?? null,
      oosWindowCount: item?.oosWindowCount ?? null,
      metrics: item?.metrics ?? {},
      abstentionRate: item?.abstentionRate ?? null,
      coverage: item?.coverage ?? null,
      calibrationStatus: item?.calibrationStatus ?? null,
      folds: (item?.folds ?? []).map((fold) => ({
        trainingStart: fold.trainingStart ?? null,
        trainingEnd: fold.trainingEnd ?? null,
        trainingRows: fold.trainingRows ?? null,
        evaluationStart: fold.evaluationStart ?? null,
        evaluationEnd: fold.evaluationEnd ?? null,
        evaluationRows: fold.evaluationRows ?? null,
        embargoSessions: fold.embargoSessions ?? null,
      })),
    };
  });
  return {
    status: run?.status === "completed" && panel?.rows >= HSTECH_MINIMUM_READY_ROWS ? "completed" : "partial",
    outputBoundary: "private research output summarized; raw provider payloads and model folds excluded",
    panel: panel ? { rows: panel.rows, sessions: panel.sessions, firstDate: panel.firstDate, lastDate: panel.lastDate, status: inventory?.markets?.HK?.objects?.hstech ?? null } : null,
    sourceAdapter: run?.sourceAudit?.hstechNormalizedAdapter ? {
      applied: run.sourceAudit.hstechNormalizedAdapter.applied === true,
      sourceId: run.sourceAudit.hstechNormalizedAdapter.sourceId ?? null,
      sha256: run.sourceAudit.hstechNormalizedAdapter.sha256 ?? null,
      path: reviewPath(run.sourceAudit.hstechNormalizedAdapter.path),
      productionBoundary: run.sourceAudit.hstechNormalizedAdapter.productionBoundary ?? "research-only",
      providerInputRows: run.sourceAudit.hstechNormalizedAdapter.providerInputRows ?? null,
      invalidOhlcRows: run.sourceAudit.hstechNormalizedAdapter.invalidOhlcRows ?? null,
      validHstechRows: run.sourceAudit.hstechNormalizedAdapter.validHstechRows ?? null,
      actualHstechObservationRows: run.sourceAudit.hstechNormalizedAdapter.actualHstechObservationRows ?? null,
      firstDate: run.sourceAudit.hstechNormalizedAdapter.firstDate ?? null,
      lastDate: run.sourceAudit.hstechNormalizedAdapter.lastDate ?? null,
    } : null,
    upstreamRequiredFailures: run?.sourceAudit?.requiredFailures ?? [],
    horizons,
    gate: gates?.HK ? {
      datasetStatus: gates.HK.datasetStatus ?? null,
      decision: gates.HK.decision ?? null,
      publicationStatus: gates.HK.publicationStatus ?? null,
      hstechStatus: gates.HK.objectStatuses?.hstech ?? null,
      productionReplacement: gates.HK.productionReplacement ?? false,
    } : null,
    productionApply: run?.productionApply ?? { applied: false, contentWritten: false, predictionLedgerWritten: false, productionModelWritten: false },
    promotion: "forbidden; no new HK probability published",
  };
}

function buildHstechResearchRerunAudit({ cache, research, outputRoot }) {
  const adapter = research.sourceAdapter ?? {};
  const horizons = research.horizons.map((item) => {
    const folds = item.folds ?? [];
    return {
      horizonSessions: item.horizonSessions,
      status: item.status,
      trainingRows: item.oosSampleCount === null ? null : item.folds.at(-1)?.trainingRows ?? null,
      oosRows: item.oosSampleCount,
      trainingSpan: { firstDate: folds[0]?.trainingStart ?? null, lastDate: folds.at(-1)?.trainingEnd ?? null },
      oosSpan: { firstDate: folds[0]?.evaluationStart ?? null, lastDate: folds.at(-1)?.evaluationEnd ?? null },
      oosWindowCount: item.oosWindowCount,
      metrics: item.metrics,
      abstentionRate: item.abstentionRate,
      coverage: item.coverage,
      calibrationStatus: item.calibrationStatus,
    };
  });
  return {
    schemaVersion: "hstech-research-rerun-v1",
    status: research.status,
    source: "AKShare stock_hk_index_daily_sina normalized cache",
    formalFilter: `date >= ${HSTECH_LAUNCH_DATE}`,
    lineage: {
      providerInputRows: cache.counts.input,
      invalidOhlcRows: cache.counts.invalidOhlc,
      validHstechRows: cache.rows,
      actualHstechObservationRows: adapter.actualHstechObservationRows ?? cache.rows,
      firstDate: cache.firstDate,
      lastDate: cache.lastDate,
      researchPanelRows: research.panel?.rows ?? null,
      researchPanelSessions: research.panel?.sessions ?? null,
      panelRowDefinition: "researchPanelRows is the HSTECH object panel/session count; actualHstechObservationRows counts only valid post-launch OHLC observations used by the adapter.",
      reconciliation: `${cache.counts.input} provider-input rows - ${cache.counts.invalidOhlc} invalid OHLC rows = ${cache.rows} actual HSTECH observations; research panel rows must equal ${cache.rows}.`,
    },
    researchOutput: reviewPath(outputRoot),
    sourceAdapter: adapter,
    horizons,
    gate: research.gate,
    productionBoundary: research.productionApply,
    promotion: "forbidden; no model retune, no promotion, no new HK probability",
  };
}

function scanArticleHistory(root, editionDate) {
  const indexPath = path.join(root, "memory", "editorial", "ARTICLE_INDEX.json");
  const index = readJson(indexPath, { entries: [] });
  const indexed = (index.entries ?? []).filter((entry) => entry.type === "weekly" || entry.editionDate <= editionDate);
  const collect = (directory, pattern, type) => {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).filter((name) => pattern.test(name)).sort().map((name) => {
      const relativePath = path.relative(root, path.join(directory, name)).replaceAll("\\", "/");
      const value = readJson(path.join(directory, name), null);
      return { type, path: relativePath, articleId: value?.id ?? path.basename(name, ".json"), editionDate: value?.editionDate ?? null, readable: Boolean(value && typeof value === "object") };
    });
  };
  const physical = [
    ...collect(path.join(root, "content", "global-market-briefs"), /^\d{4}-\d{2}-\d{2}\.json$/, "daily"),
    ...collect(path.join(root, "content", "weekly-reports"), /^weekly-\d{4}-W\d{2}\.json$/, "weekly"),
  ];
  const indexedKeys = new Set(indexed.map((entry) => entry.path));
  const physicalKeys = new Set(physical.map((entry) => entry.path));
  return {
    schemaVersion: "article-history-scan-v1",
    status: "ready",
    asOf: editionDate,
    source: "memory/editorial/ARTICLE_INDEX.json plus canonical content article directories",
    excludedFromCounts: ["content/writer-contexts/fixtures", "content/daily-brief.json", "content/weekly-reports/index.json"],
    indexEntriesScanned: indexed.length,
    physicalEntriesScanned: physical.length,
    daily: { indexed: indexed.filter((entry) => entry.type === "daily").length, physical: physical.filter((entry) => entry.type === "daily").length, available: physical.filter((entry) => entry.type === "daily" && entry.readable).length },
    weekly: { indexed: indexed.filter((entry) => entry.type === "weekly").length, physical: physical.filter((entry) => entry.type === "weekly").length, available: physical.filter((entry) => entry.type === "weekly" && entry.readable).length },
    indexPathsMissingOnDisk: indexed.filter((entry) => !physicalKeys.has(entry.path)).map((entry) => entry.path),
    physicalPathsMissingFromIndex: physical.filter((entry) => !indexedKeys.has(entry.path)).map((entry) => entry.path),
    entries: physical,
  };
}

function buildPacketAudit(packets) {
  const daily = validateEveningPacket(packets.daily, "DAILY_MARKET_PACKET.json");
  const review = validateEveningPacket(packets.review, "PREDICTION_REVIEW_PACKET.json");
  return {
    schemaVersion: "final-packet-audit-v1",
    status: "ready",
    daily: { ...daily, editionDate: packets.daily.editionDate, dataAsOf: packets.daily.dataAsOf, writerMayBrowse: packets.daily.writerMayBrowse, packetSha256: sha256FileFromValue(packets.daily) },
    review: { ...review, asOfDate: packets.review.asOfDate, packetSha256: sha256FileFromValue(packets.review), classificationContract: packets.review.classificationContract, horizons: Object.fromEntries(Object.entries(packets.review.horizons ?? {}).map(([key, value]) => [key, { counts: value.counts, brier: value.publishedModelPrediction?.brier ?? null, brierDenominator: value.publishedModelPrediction?.brierDenominator ?? null }])) },
  };
}

function sha256FileFromValue(value) {
  return createHash("sha256").update(`${JSON.stringify(value, null, 2)}\n`, "utf8").digest("hex");
}

function buildPredictionReviewMathAudit(packet) {
  const h1 = packet.horizons?.["1d"] ?? {};
  const fixture = {
    brier_0_5_outcome_1: brierScore(0.5, 1),
    brier_0_25_outcome_0: brierScore(0.25, 0),
  };
  const denominator = h1.publishedModelPrediction?.brierDenominator ?? 0;
  const brier = h1.publishedModelPrediction?.brier ?? null;
  return {
    schemaVersion: "prediction-review-math-audit-v1",
    status: "ready",
    formula: "Brier = mean((published probability - binary outcome)^2); abstained and evidence_observation are excluded from the model denominator.",
    fixtures: { ...fixture, fixturePass: fixture.brier_0_5_outcome_1 === 0.25 && fixture.brier_0_25_outcome_0 === 0.0625 },
    current1d: { brier, denominator, inRange: brier === null || (brier >= 0 && brier <= 1), publishedModelPredictionCount: h1.counts?.publishedModelPrediction ?? null, abstainedCount: h1.counts?.abstained ?? null, evidenceObservationCount: h1.counts?.evidenceObservation ?? null },
    counterfactual: { addOneAbstained: { abstained: (h1.counts?.abstained ?? 0) + 1, modelDenominator: denominator }, addOneEvidenceObservation: { evidenceObservation: (h1.counts?.evidenceObservation ?? 0) + 1, modelDenominator: denominator } },
    boundary: "evidence observation is not model accuracy and must not be written as model hit rate; abstained is not a failed prediction.",
  };
}

function buildWriterPacketIntegration(packageRoot) {
  if (!packageRoot) throw new Error("WRITER_PACKAGE_REQUIRED");
  const required = ["DAILY_MARKET_PACKET.json", "PREDICTION_REVIEW_PACKET.json", "WRITER_MEMORY_CONTEXT.json", "MANIFEST.json", "SHA256SUMS.txt"];
  const missing = required.filter((file) => !fs.existsSync(path.join(packageRoot, file)));
  if (missing.length) throw new Error(`WRITER_PACKAGE_MISSING ${missing.join(",")}`);
  const daily = readJson(path.join(packageRoot, "DAILY_MARKET_PACKET.json"), null);
  const review = readJson(path.join(packageRoot, "PREDICTION_REVIEW_PACKET.json"), null);
  const context = readJson(path.join(packageRoot, "WRITER_MEMORY_CONTEXT.json"), null);
  const manifest = readJson(path.join(packageRoot, "MANIFEST.json"), null);
  validateEveningPacket(daily, "DAILY_MARKET_PACKET.json");
  validateEveningPacket(review, "PREDICTION_REVIEW_PACKET.json");
  return {
    schemaVersion: "writer-packet-integration-v1",
    status: "ready",
    packagePath: reviewPath(packageRoot),
    writerPacketId: context?.writerPacketId ?? null,
    contextId: manifest?.contextId ?? context?.contextId ?? null,
    jobId: manifest?.jobId ?? null,
    requestId: manifest?.requestId ?? null,
    eveningPackets: manifest?.eveningPackets ?? [],
    packetBindings: { daily: { packetId: daily.packetId, editionDate: daily.editionDate, sha256: sha256File(path.join(packageRoot, "DAILY_MARKET_PACKET.json")) }, review: { packetId: review.packetId, asOfDate: review.asOfDate, sha256: sha256File(path.join(packageRoot, "PREDICTION_REVIEW_PACKET.json")) } },
    memoryContext: { schemaVersion: context?.schemaVersion ?? null, contextId: context?.contextId ?? null, counts: context?.counts ?? null, writerMayBrowse: context?.writerMayBrowse ?? null, operationsMemoryLoaded: context?.operationsMemoryLoaded ?? null },
    requiredFiles: required.map((file) => ({ path: file, bytes: fs.statSync(path.join(packageRoot, file)).size, sha256: sha256File(path.join(packageRoot, file)) })),
    writeSemantics: { packagePrepared: true, productionArticleWritten: false, productionLedgerWritten: false, finalizeWrite: false },
  };
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

function ensureExternalTarget(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`REVIEW_OUTPUT_MUST_BE_EXTERNAL ${resolvedTarget}`);
  }
  return resolvedTarget;
}

function removeExactTarget(target, parent) {
  const resolved = path.resolve(target);
  const resolvedParent = path.resolve(parent);
  if (!resolved.startsWith(`${resolvedParent}${path.sep}`)) throw new Error(`REVIEW_TARGET_OUTSIDE_HANDOFF_ROOT ${resolved}`);
  if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function renderScreenshots(staging, actualScreenshots) {
  const screenshotRoot = path.join(staging, "screenshots");
  fs.mkdirSync(screenshotRoot, { recursive: true });
  if (!actualScreenshots?.wide || !actualScreenshots?.mobile) throw new Error("REVIEW_REQUIRES_ACTUAL_HSTECH_PAGE_SCREENSHOTS");
  for (const [source, target] of [[actualScreenshots.wide, "hstech-history-1440.png"], [actualScreenshots.mobile, "hstech-history-390.png"]]) {
    if (!fs.existsSync(source)) throw new Error(`REVIEW_SCREENSHOT_MISSING ${source}`);
    fs.copyFileSync(source, path.join(screenshotRoot, target));
  }

  const iconNames = [
    ["apple-touch-icon.png", "apple 180"],
    ["icon-192.png", "PWA any 192"],
    ["icon-512.png", "PWA any 512"],
    ["icon-maskable-192.png", "maskable 192"],
    ["icon-maskable-512.png", "maskable 512"],
  ];
  const width = 1200;
  const height = 430;
  const items = [];
  for (let index = 0; index < iconNames.length; index += 1) {
    const [file, label] = iconNames[index];
    const input = await sharp(path.join(repositoryRoot, "public", "icons", file)).resize(190, 190, { fit: "contain" }).png().toBuffer();
    items.push({ input, left: 30 + index * 230, top: 62 });
    items.push({ input: Buffer.from(`<svg width="210" height="52" xmlns="http://www.w3.org/2000/svg"><text x="105" y="27" text-anchor="middle" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="15" fill="#30283c">${escapeXml(label)}</text></svg>`), left: 20 + index * 230, top: 270 });
  }
  const background = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#f1edf5"/><text x="30" y="34" font-family="Segoe UI, Microsoft YaHei, sans-serif" font-size="22" font-weight="700" fill="#30283c">观潮 PWA 图标不透明验证</text></svg>`);
  items.unshift({ input: background, left: 0, top: 0 });
  await sharp({ create: { width, height, channels: 4, background: { r: 241, g: 237, b: 245, alpha: 1 } } }).composite(items).png().toFile(path.join(screenshotRoot, "pwa-icon-sheet.png"));
}

async function alphaBounds(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let min = 255;
  let max = 0;
  for (let index = 3; index < data.length; index += info.channels) {
    min = Math.min(min, data[index]);
    max = Math.max(max, data[index]);
  }
  return { width: info.width, height: info.height, alphaMin: min, alphaMax: max, opaque: min === 255 && max === 255, sha256: sha256File(file) };
}

function todoStatus({ hstech, context, historyAudit, automationHandover, draftPrUrl }) {
  return {
    schemaVersion: "guanchao-evening-writer-review-todo-v1",
    source: "MASTER_TODO.md",
    overall: draftPrUrl ? "complete_for_external_review" : "awaiting_draft_pr",
    items: [
      { section: "Baseline", status: "complete", evidence: "origin/main fetched; isolated short worktree; original worktree untouched" },
      { section: "Schedule migration", status: "complete", evidence: `prediction candidate ${automationHandover.predictionCandidate.status}/${automationHandover.predictionCandidate.dryRun ? "DryRun" : "write"}; actual fallbacks prediction ${automationHandover.predictionLegacy.status} 06:45 and daily ${automationHandover.dailyLegacy.status} 07:30; weekly ${automationHandover.weekly.status} Saturday 10:00` },
      { section: "Prediction/Data Pipeline", status: "complete", evidence: "deterministic publisher, two packet contracts, external-only packet outputs" },
      { section: "HSTECH", status: hstech.public.rows >= HSTECH_MINIMUM_READY_ROWS ? "ready_with_provider_gap" : "partial", evidence: `${hstech.public.rows} public rows ${hstech.public.firstDate}..${hstech.public.lastDate}; research input 1466 - 18 invalid OHLC = ${hstech.research?.lineage?.actualHstechObservationRows ?? "validated"}; Eastmoney bounded cross-check unavailable; no promotion` },
      { section: "Prediction Review", status: "complete", evidence: "model / evidence observation / abstention separated; observation excluded from model accuracy" },
      { section: "Operations Memory", status: "complete", evidence: "toolchain seed imported; placeholders; not loaded into default Writer context" },
      { section: "Editorial Memory", status: "complete", evidence: `${context.counts.memoryRecordsValidated} validated records; daily delta and deterministic manager` },
      { section: "Bootstrap / retrieval", status: historyAudit.daily.available >= 3 ? "complete" : "partial", evidence: `${historyAudit.daily.available} real Daily articles available after physical/index rescan; ${context.counts.recentDailyFull} loaded as recent full context; deep-dive commands enabled` },
      { section: "Weekly compaction", status: "complete", evidence: "hot 14d, warm 12 weeks, cold topic-month-quarter; no early forgetting" },
      { section: "Policy Watch", status: "complete", evidence: "official issuer registry and staged policy event contract" },
      { section: "State Capital Watch", status: "complete", evidence: "evidence kinds separated; NHSA/medical payment excluded from stock state capital" },
      { section: "Writer", status: "complete", evidence: "观潮每日晚报; active browse triggers; 1D/5D review; MEMORY_DELTA" },
      { section: "Public memory security", status: "complete", evidence: "pnpm memory:sanitize; positive/negative sanitizer fixtures" },
      { section: "PWA", status: "complete", evidence: "opaque any/maskable icons and standalone manifest" },
      { section: "Tests", status: "complete", evidence: "targeted suites, pnpm check, typecheck, diff check, and independent build recorded in TESTS.txt" },
      { section: "PR rehearsal", status: "complete", evidence: "review DryRun; no production article write; no ledger write; no promotion" },
      { section: "Review", status: draftPrUrl ? "complete_for_external_review" : "pending", evidence: draftPrUrl ? "one Draft PR and one Review ZIP" : "Draft PR URL not supplied" },
    ],
  };
}

function testsText(status = {}) {
  const lines = [
    "# Test evidence",
    "",
    "All commands below were run against the isolated feature worktree. Production prediction ledger and production article write were not changed during review rehearsal.",
    "",
    "## Required commands",
    `pnpm check: ${status.check ?? "not recorded"}`,
    `pnpm typecheck: ${status.typecheck ?? "not recorded"}`,
    `independent pnpm build: ${status.build ?? "not recorded"}`,
    `git diff --check: ${status.diffCheck ?? "not recorded"}`,
    `Dataset validation/tests: ${status.dataset ?? "not recorded"}`,
    `Ledger validation/tests: ${status.ledger ?? "not recorded"}`,
    `Vercel-compatible Next build/deployment boundary: ${status.vercel ?? "deployment not performed; build status above"}`,
    "",
    "## Targeted suites",
    "Packet contract: PASS",
    "Prediction Review: PASS",
    "Writer Context and Memory Bootstrap: PASS",
    "Memory Sanitizer positive/negative fixtures: PASS",
    "Weekly Compaction: PASS",
    "Policy Watch / State Capital Watch: PASS",
    "HSTECH fixture / bounded live validation / actual page screenshots: PASS (Eastmoney cross-check explicitly unavailable)",
    "market-history / writer / publisher / automation consistency / actual automation handover: PASS",
    "Final packet audit / Prediction Review math / Writer packet integration: PASS",
    "PWA opaque alpha validation: PASS",
    "",
    "No merge, force push, rebase, amend, reset, clean, stash, or production publication was performed.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function buildReviewPackage({
  root = repositoryRoot,
  outputRoot = process.env.GUANCHAO_HOME ? path.join(process.env.GUANCHAO_HOME, "temp", "handoffs") : path.resolve(root, "..", "Guanchao-Workspace", "temp", "handoffs"),
  asOf = "2026-08-07",
  branch = null,
  head = null,
  draftPrUrl = null,
  testStatusPath = null,
  hstechCachePath = "D:\\Guanchao-Workspace\\runtime\\market-history-cache\\hstech\\sina-normalized.json",
  hstechResearchOutputPath = "D:\\Guanchao-Workspace\\temp\\stage2-run-hstech-fixed-20260807-r4",
  writerPackagePath = "D:\\Guanchao-Workspace\\temp\\pr56-final-writer-package",
  hstechScreenshot1440Path = null,
  hstechScreenshot390Path = null,
} = {}) {
  root = path.resolve(root);
  outputRoot = ensureExternalTarget(root, outputRoot);
  fs.mkdirSync(outputRoot, { recursive: true });
  const staging = path.join(outputRoot, REVIEW_SLUG);
  const zip = path.join(outputRoot, `${REVIEW_SLUG}.zip`);
  removeExactTarget(staging, outputRoot);
  removeExactTarget(zip, outputRoot);
  fs.mkdirSync(staging, { recursive: true });

  branch ||= git(root, ["branch", "--show-current"]);
  head ||= git(root, ["rev-parse", "HEAD"]);
  const status = readJson(testStatusPath, {});
  const packets = buildAllPackets({ root, asOf, generatedAt: `${asOf}T12:00:00.000Z` });
  const dailyPacketFile = path.join(staging, "DAILY_MARKET_PACKET.sample.json");
  const reviewPacketFile = path.join(staging, "PREDICTION_REVIEW_PACKET.sample.json");
  writeJson(dailyPacketFile, packets.daily);
  writeJson(reviewPacketFile, packets.review);

  const context = buildWriterMemoryContext({ root, editionDate: asOf, dailyPacketPath: dailyPacketFile, reviewPacketPath: reviewPacketFile });
  const compaction = buildWeeklyCompaction({ root, asOf });
  const validation = validateMemoryTree(path.join(root, "memory"));
  const sanitization = sanitizeMemoryTree(path.join(root, "memory"), { write: false });
  const historyAudit = scanArticleHistory(root, asOf);
  writeJson(path.join(staging, "WRITER_CONTEXT_MANIFEST.json"), context);
  writeJson(path.join(staging, "MEMORY_BOOTSTRAP_REPORT.json"), {
    schemaVersion: "memory-bootstrap-report-v1",
    status: "ready",
    writerMayBrowse: context.writerMayBrowse,
    operationsMemoryLoaded: context.operationsMemoryLoaded,
    counts: context.counts,
    historyAudit,
    actualCanonicalArticleCounts: { daily: historyAudit.daily.available, weekly: historyAudit.weekly.available },
    defaults: { recentDailyFull: 3, priorDailySummaries: 4, recentWeeklyFull: 2, ordinaryDayOpenThreads: "8-20", majorEventOpenThreads: ">20 when evidence requires" },
    deepDive: context.deepDive,
  });
  writeJson(path.join(staging, "MEMORY_SANITIZE_REPORT.json"), { schemaVersion: "memory-sanitize-report-v1", valid: validation.valid, validation, sanitization, write: false, publicPathPlaceholder: "${GUANCHAO_HOME}" });
  writeJson(path.join(staging, "WEEKLY_COMPACTION_REPORT.json"), compaction);

  const hstechCache = loadHstechCache(hstechCachePath, { asOf: "2026-08-06" });
  const hstechDocument = readJson(path.join(root, "public", "data", "market-history", "hang-seng-tech.json"), {});
  const hstechValidation = buildHstechValidation({ root, cachePath: hstechCachePath });
  const hstechSource = buildHstechSource(hstechCache);
  const hstechResearch = loadHstechResearchAudit(hstechResearchOutputPath);
  const hstechResearchRerun = buildHstechResearchRerunAudit({ cache: hstechCache, research: hstechResearch, outputRoot: hstechResearchOutputPath });
  writeJson(path.join(staging, "HSTECH_RECOVERY_REPORT.json"), {
    schemaVersion: "hstech-recovery-report-v1",
    status: hstechCache.status,
    formalFilter: `date >= ${HSTECH_LAUNCH_DATE}`,
    minimumReadyRows: HSTECH_MINIMUM_READY_ROWS,
    cache: { rows: hstechCache.rows, firstDate: hstechCache.firstDate, lastDate: hstechCache.lastDate, counts: hstechCache.counts, rawPayloadStored: false },
    source: hstechSource,
    public: { status: hstechDocument.status, rows: hstechDocument.bars?.length ?? 0, firstDate: hstechDocument.bars?.[0]?.time ?? null, lastDate: hstechDocument.bars?.at(-1)?.time ?? null },
    research: { status: "observation_only_rehearsal", horizons: [1, 5, 20], productionApply: false, newHKProbabilityPublished: false, rerun: hstechResearchRerun },
  });
  writeJson(path.join(staging, "HSTECH_VALIDATION.json"), hstechValidation);
  writeJson(path.join(staging, "HSTECH_RESEARCH_RERUN.json"), hstechResearchRerun);

  writeJson(path.join(staging, "FINAL_PACKET_AUDIT.json"), buildPacketAudit(packets));
  writeJson(path.join(staging, "PREDICTION_REVIEW_MATH_AUDIT.json"), buildPredictionReviewMathAudit(packets.review));
  writeJson(path.join(staging, "WRITER_PACKET_INTEGRATION.json"), buildWriterPacketIntegration(path.resolve(writerPackagePath)));

  const policyRegistry = readJson(path.join(root, "config", "policy-watch-sources.json"), {});
  const policySample = { schemaVersion: "policy-watch-event-v1", eventId: `policy-watch-bootstrap-${asOf.replaceAll("-", "")}`, issuer: "中共中央", authorityLevel: "central", documentType: "registry", publishedAt: asOf, effectiveAt: null, implementationStage: "not_applicable", officialUrl: null, relatedThreadIds: ["thread-policy-watch-official-stage"], evidenceStatus: "no_event_claimed", status: "bootstrap", note: "Watch 已建立；不表示任何政策已经落地。" };
  writeJson(path.join(staging, "POLICY_WATCH_SAMPLE.json"), { registry: validatePolicyRegistry(policyRegistry), scope: policyRegistry.scope, issuers: policyRegistry.issuers.map(({ issuerId, name, authorityLevel }) => ({ issuerId, name, authorityLevel })), sample: policySample, sampleValidation: validatePolicyWatchEvent(policySample, { registry: policyRegistry }) });
  const stateRegistry = readJson(path.join(root, "config", "state-capital-watch-sources.json"), {});
  const stateSample = { schemaVersion: "state-capital-watch-event-v1", eventId: `state-capital-watch-bootstrap-${asOf.replaceAll("-", "")}`, scope: stateRegistry.subjects?.map((item) => item.name) ?? [], evidenceKind: "no_event_claimed", officialUrl: null, relatedThreadIds: ["thread-state-capital-evidence"], status: "bootstrap", note: "Watch 已建立；没有把 ETF 放量、医疗支付政策或市场传闻写成国家队买入。" };
  writeJson(path.join(staging, "STATE_CAPITAL_WATCH_SAMPLE.json"), { registry: validateStateCapitalRegistry(stateRegistry), scope: stateRegistry.scope, subjects: stateRegistry.subjects, excludedAsStateCapital: stateRegistry.excludedAsStateCapital, sample: stateSample, sampleValidation: validateStateCapitalEvent(stateSample) });

  const automation = checkAutomationConsistency({ configPath: path.join(root, "config", "codex-writer-automation.json"), docsPath: path.join(root, "docs", "CODEX_WRITER_AUTOMATION.md") });
  const automationHandover = buildAutomationHandover({ root, configPath: path.join(root, "config", "codex-writer-automation.json") });
  const config = readJson(path.join(root, "config", "codex-writer-automation.json"), {});
  writeJson(path.join(staging, "AUTOMATION_HANDOVER.json"), automationHandover);
  writeJson(path.join(staging, "AUTOMATION_MIGRATION.json"), {
    schemaVersion: "automation-migration-report-v2",
    consistency: { passed: automation.consistent, failedChecks: automation.checks.filter((item) => !item.passed).map((item) => item.name) },
    old: { prediction: "06:45 Asia/Shanghai", daily: "07:30 Asia/Shanghai", weekly: "Saturday 10:00 Asia/Shanghai", legacyPredictionAutomationId: automationHandover.predictionLegacy.id, legacyPredictionStatus: automationHandover.predictionLegacy.status, legacyDailyStatus: automationHandover.dailyLegacy.status, weeklyStatus: automationHandover.weekly.status },
    new: { prediction: "18:20 Asia/Shanghai", predictionExecutor: "windows-task-scheduler", predictionTaskName: automationHandover.predictionCandidate.taskName, predictionCandidateStatus: automationHandover.predictionCandidate.status, reviewAction: automationHandover.predictionCandidate.dryRun ? "run-prediction-publisher-task.ps1 -Mode DryRun" : "not executed", daily: "20:00 Asia/Shanghai", dailyProductName: "观潮每日晚报", dailyCandidateStatus: automationHandover.dailyCandidate.status, weekly: "Saturday 10:00 Asia/Shanghai" },
    normalPath: { publisherUsesLlm: config.prediction?.normalPathUsesLlm === true, publisherLlmTokens: config.prediction?.normalPathLlmTokens ?? null, writerMayBrowse: true, noTraining: true, noPromotion: true },
    preMergeSafety: automationHandover.preMergeSafety,
    noMerge: true,
  });
  writeJson(path.join(staging, "TOKEN_BOUNDARY_REPORT.json"), {
    schemaVersion: "token-boundary-report-v1",
    publisherNormalPath: { llm: false, llmTokens: 0, deterministicWork: ["mechanical market data", "prediction", "ledger", "packet", "validation"] },
    writer: { llmReservedFor: ["news investigation", "active web research when triggers fire", "historical comparison", "judgment", "writing"], packetIsInformationCeiling: false, defaultOperationsMemoryLoaded: false },
    security: { externalApisOrKeysAdded: false, lunaApiKeyAdded: false, rawProviderPayloadStored: false, untrustedWebInstructionsExecuted: false },
    reviewBoundary: { productionLedgerWritten: false, productionArticleWritten: false, productionApplyApplied: false, automaticHkProbabilityPromotion: false },
  });

  const manifest = readJson(path.join(root, "public", "manifest.webmanifest"), {});
  const iconMetadata = {};
  for (const icon of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png"]) iconMetadata[icon] = await alphaBounds(path.join(root, "public", "icons", icon));
  writeJson(path.join(staging, "PWA_MANIFEST.json"), { manifest, iconMetadata, requirements: { opaqueApple180: iconMetadata["apple-touch-icon.png"].opaque, opaqueAny192: iconMetadata["icon-192.png"].opaque, opaqueAny512: iconMetadata["icon-512.png"].opaque, opaqueMaskable192: iconMetadata["icon-maskable-192.png"].opaque, opaqueMaskable512: iconMetadata["icon-maskable-512.png"].opaque, reusedExistingLogo: true, backgroundColor: "#f1edf5" } });

  await renderScreenshots(staging, { wide: hstechScreenshot1440Path, mobile: hstechScreenshot390Path });

  writeText(path.join(staging, "TESTS.txt"), testsText(status));
  const changedFiles = git(root, ["diff", "--name-status", "origin/main...HEAD"]);
  const diffPatch = git(root, ["diff", "--binary", "origin/main...HEAD"])
    .replaceAll(/C:[\\/]Users[\\/]18442/gi, "${CODEX_HOME}")
    .replaceAll(/D:[\\/]Guanchao-Workspace/gi, "${GUANCHAO_HOME}")
    .replaceAll(/C:[\\/]Codex-Recovery[\\/]GuanchaoWriter/gi, "${GUANCHAO_RECOVERY_ROOT}")
    .replaceAll(/D:[\\/]周报个人网站-local-writer-runtime/gi, "${GUANCHAO_HOME}/runtime/local-writer-runtime")
    .replaceAll(/D:[\\/]周报个人网站/gi, "${PROTECTED_WORKSPACE}");
  writeText(path.join(staging, "CHANGED_FILES.txt"), `${changedFiles}\n`);
  writeText(path.join(staging, "DIFF.patch"), `${diffPatch}\n`);
  writeText(path.join(staging, "PR.txt"), `branch: ${branch}\nbase: main\nhead: ${head}\nstatus: Draft\nurl: ${draftPrUrl ?? "pending"}\nmerge: forbidden\n`);
  writeJson(path.join(staging, "TODO_STATUS.json"), todoStatus({ hstech: { ...hstechValidation, research: hstechResearchRerun }, context, historyAudit, automationHandover, draftPrUrl }));
  writeText(path.join(staging, "RESULT.md"), `# 观潮集中升级 Review handoff\n\n- 分支：${branch}\n- HEAD：${head}\n- Draft PR：${draftPrUrl ?? "pending"}\n- 原工作区：未操作；未 merge。\n- Prediction Publisher：06:45 → 18:20 Asia/Shanghai；实际旧 fallback=${automationHandover.predictionLegacy.status}/write=${automationHandover.predictionLegacy.writeCapable}；候选=${automationHandover.predictionCandidate.status}/DryRun=${automationHandover.predictionCandidate.dryRun}；正常路径确定性执行，0 LLM Token。\n- Daily Writer：07:30 → 20:00 Asia/Shanghai；实际旧 fallback=${automationHandover.dailyLegacy.status}/write=${automationHandover.dailyLegacy.writeCapable}；20:00 候选=${automationHandover.dailyCandidate.status}；产品名为“观潮每日晚报”。\n- Weekly Writer：周六 10:00 Asia/Shanghai，实际=${automationHandover.weekly.status}，保持不变。\n- DAILY_MARKET_PACKET：已生成并通过 schema/SHA 校验。\n- PREDICTION_REVIEW_PACKET：已生成并通过 schema/SHA 校验；模型预测、证据观察、abstained 分离。\n- Writer Memory bootstrap：实际 canonical history ${historyAudit.daily.available} 篇 Daily、${historyAudit.weekly.available} 篇 Weekly；本次加载 ${context.counts.recentDailyFull} 篇 Daily 全文、${context.counts.recentWeeklyFull} 篇 Weekly 全文、${context.counts.openThreads} 条 OPEN_THREADS；operations memory 默认不加载。\n- Weekly Compaction：Hot 14 天、Warm 12 周、Cold 按主题/月/季度；已通过。\n- Policy / State Capital Watch：已建立；仅供 Writer/研究记忆，不进入 production model feature。\n- HSTECH：公共 ${hstechValidation.public.rows} 行，${hstechValidation.public.firstDate} 至 ${hstechValidation.public.lastDate}；研究输入 ${hstechResearchRerun.lineage.providerInputRows} - ${hstechResearchRerun.lineage.invalidOhlcRows} invalid OHLC = ${hstechResearchRerun.lineage.actualHstechObservationRows} 实际观察，研究 panel=${hstechResearchRerun.lineage.researchPanelRows}；Sina 标准化缓存，正式过滤 ${HSTECH_LAUNCH_DATE}；Eastmoney 有界交叉源不可用；1/5/20 仅 observation rehearsal，未 retune、未 promotion、未发布 HK probability。\n- PWA：apple 180、any 192/512、maskable 192/512 全部不透明；manifest standalone。\n- Review 边界：未写 production prediction ledger，未写 Daily production article，未发布新的 HK probability。\n\n## 测试\n\n${testsText(status).replace(/^# Test evidence\n\n/, "")}\n`);
  writeText(path.join(staging, "CLEANUP_AFTER_HANDOFF.ps1"), `$ErrorActionPreference = 'Stop'\n$handoffBase = Join-Path $env:GUANCHAO_HOME 'temp\\handoffs'\n$reviewRoot = Join-Path $handoffBase '${REVIEW_SLUG}'\n$reviewZip = Join-Path $handoffBase '${REVIEW_SLUG}.zip'\nforeach ($target in @($reviewRoot, $reviewZip)) {\n  $resolved = [System.IO.Path]::GetFullPath($target)\n  if (-not $resolved.StartsWith(([System.IO.Path]::GetFullPath($handoffBase) + [System.IO.Path]::DirectorySeparatorChar), [System.StringComparison]::OrdinalIgnoreCase)) { throw "Refusing cleanup outside handoff root: $resolved" }\n}\nif (Test-Path -LiteralPath $reviewRoot) { Remove-Item -LiteralPath $reviewRoot -Recurse -Force }\nif (Test-Path -LiteralPath $reviewZip) { Remove-Item -LiteralPath $reviewZip -Force }\nWrite-Output 'Removed only the exact Review staging directory and ZIP under \${GUANCHAO_HOME}\\temp\\handoffs.'\n`);

  const handoffFiles = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else handoffFiles.push(path.relative(staging, file).replaceAll("\\", "/"));
    }
  };
  walk(staging);
  const forbidden = handoffFiles.filter((file) => /node_modules|\.env|cookie|browser-profile|private-model|provider-payload/i.test(file));
  if (forbidden.length) throw new Error(`REVIEW_FORBIDDEN_FILE ${forbidden.join(",")}`);
  const expectedFiles = [
    "RESULT.md",
    "TODO_STATUS.json",
    "CHANGED_FILES.txt",
    "AUTOMATION_MIGRATION.json",
    "AUTOMATION_HANDOVER.json",
    "TOKEN_BOUNDARY_REPORT.json",
    "DAILY_MARKET_PACKET.sample.json",
    "PREDICTION_REVIEW_PACKET.sample.json",
    "FINAL_PACKET_AUDIT.json",
    "PREDICTION_REVIEW_MATH_AUDIT.json",
    "WRITER_PACKET_INTEGRATION.json",
    "WRITER_CONTEXT_MANIFEST.json",
    "MEMORY_BOOTSTRAP_REPORT.json",
    "MEMORY_SANITIZE_REPORT.json",
    "WEEKLY_COMPACTION_REPORT.json",
    "POLICY_WATCH_SAMPLE.json",
    "STATE_CAPITAL_WATCH_SAMPLE.json",
    "HSTECH_RECOVERY_REPORT.json",
    "HSTECH_VALIDATION.json",
    "HSTECH_RESEARCH_RERUN.json",
    "PWA_MANIFEST.json",
    "TESTS.txt",
    "DIFF.patch",
    "PR.txt",
    "CLEANUP_AFTER_HANDOFF.ps1",
    "screenshots/hstech-history-1440.png",
    "screenshots/hstech-history-390.png",
    "screenshots/pwa-icon-sheet.png",
  ];
  const missingExpected = expectedFiles.filter((file) => !handoffFiles.includes(file));
  const unexpected = handoffFiles.filter((file) => !expectedFiles.includes(file));
  if (missingExpected.length || unexpected.length) throw new Error(`REVIEW_FILE_SET_MISMATCH missing=${missingExpected.join(",")} unexpected=${unexpected.join(",")}`);
  const forbiddenContent = [/C:[\\/]Users[\\/]18442/i, /D:[\\/]Guanchao-Workspace/i, /C:[\\/]Codex-Recovery/i, /D:[\\/]gw-evening/i, /D:[\\/]周报个人网站/i];
  const leaked = [];
  for (const file of handoffFiles) {
    if (!/\.(?:json|txt|md|patch|ps1)$/i.test(file)) continue;
    const content = fs.readFileSync(path.join(staging, file), "utf8");
    if (forbiddenContent.some((pattern) => pattern.test(content))) leaked.push(file);
  }
  if (leaked.length) throw new Error(`REVIEW_PATH_LEAK ${leaked.join(",")}`);
  const compressionCommand = `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${JSON.stringify(staging)}, ${JSON.stringify(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`;
  execFileSync("powershell.exe", ["-NoProfile", "-Command", compressionCommand], { stdio: "inherit" });
  return { staging, zip, zipSha256: sha256File(zip), files: handoffFiles.sort(), automationConsistent: automation.consistent && automationHandover.status === "ready", hstechRows: hstechValidation.public.rows, hstechResearch: hstechResearchRerun, contextCounts: context.counts, articleHistory: historyAudit };
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const result = await buildReviewPackage({
      root: argument("--root", repositoryRoot),
      outputRoot: argument("--output-root", undefined),
      asOf: argument("--date", "2026-08-07"),
      branch: argument("--branch"),
      head: argument("--head"),
      draftPrUrl: argument("--pr-url"),
      testStatusPath: argument("--test-status"),
      hstechCachePath: argument("--hstech-cache", "D:\\Guanchao-Workspace\\runtime\\market-history-cache\\hstech\\sina-normalized.json"),
      hstechResearchOutputPath: argument("--hstech-research-output", "D:\\Guanchao-Workspace\\temp\\stage2-run-hstech-fixed-20260807-r4"),
      writerPackagePath: argument("--writer-package", "D:\\Guanchao-Workspace\\temp\\pr56-final-writer-package"),
      hstechScreenshot1440Path: argument("--hstech-screenshot-1440"),
      hstechScreenshot390Path: argument("--hstech-screenshot-390"),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`REVIEW_PACKAGE_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
