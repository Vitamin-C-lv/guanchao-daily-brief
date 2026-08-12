import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./research-contract.mjs";
import { resolveAutomationPaths } from "./automation-paths.mjs";
import { finalizeCodexWriter } from "./codex-writer-finalize.mjs";
import { buildReportAvailabilityReceipt, writeReportAvailabilityReceipt } from "./report-availability.mjs";
import { runWriterProductionPreflight } from "./writer-production-preflight.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

function fail(code, field, message, details = null) {
  const error = new Error(message);
  error.code = code;
  error.path = field;
  if (details) Object.assign(error, details);
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}

function git(root, args) {
  const output = execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  // Preserve the two-column porcelain status prefix.  Trimming leading spaces
  // turns " M path" into "M path", so the boundary parser drops the first
  // character of modified filenames.
  return args[0] === "status" ? output.trimEnd() : output.trim();
}

export function classifyPublisherRemoteError(cause) {
  const message = String(cause?.stderr ?? cause?.stdout ?? cause?.message ?? cause ?? "");
  return /non-fast-forward|fetch first|remote contains work|rejected|updates were rejected/i.test(message)
    ? "PUBLISHER_REMOTE_ADVANCED"
    : "PUBLISHER_PUSH_FAILED";
}

function remoteMainHead(root) {
  const output = git(root, ["ls-remote", "origin", "refs/heads/main"]);
  return output.split(/\s+/u)[0] ?? "";
}

function assertProductionTarget(root, paths, expectedRemote, { packageDirectory, requestedAsOf, edition } = {}) {
  if (path.resolve(root) !== path.resolve(paths.repositoryPath)) fail("PUBLISHER_CANONICAL_REPOSITORY_REQUIRED", "root", "production publishing requires the canonical repository");
  const packetPath = (name) => {
    const file = path.join(path.resolve(packageDirectory), name);
    return fs.existsSync(file) ? file : null;
  };
  const preflight = runWriterProductionPreflight({
    repositoryPath: paths.repositoryPath,
    runtimePath: paths.runtimePath,
    expectedRemote,
    dailyPacketPath: packetPath("DAILY_MARKET_PACKET.json"),
    predictionReviewPacketPath: packetPath("PREDICTION_REVIEW_PACKET.json"),
    editionDate: edition === "global_market_brief" ? null : requestedAsOf,
    editionPath: requestedAsOf ? path.join(paths.repositoryPath, "content", "global-market-briefs", `${requestedAsOf}.json`) : null,
    allowMissingReviewPacket: edition === "weekly" || !packetPath("PREDICTION_REVIEW_PACKET.json"),
  });
  if (preflight.status !== "READY") fail(preflight.errorCode ?? "PUBLISHER_PREFLIGHT", "production", `canonical production preflight is not ready: ${JSON.stringify(preflight.packetAudit)}`, { preflight });
  if (git(root, ["branch", "--show-current"]) !== "main") fail("PUBLISHER_MAIN_REQUIRED", "branch", "production publishing requires main, never a feature worktree");
  return preflight;
}

function assertFixtureTarget(root, paths) {
  const resolvedRoot = path.resolve(root);
  const canonicalRoot = path.resolve(paths.repositoryPath);
  const temporaryRoot = path.resolve(os.tmpdir());
  const relative = path.relative(temporaryRoot, resolvedRoot);
  if (resolvedRoot === canonicalRoot || relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("PUBLISHER_FIXTURE_ROOT", "root", "fixture writes are allowed only below the operating-system temporary directory");
  }
}

function writeAvailabilityReceipt({ paths, packageDirectory, finalization, published }) {
  const packageRoot = path.resolve(packageDirectory);
  const packet = (name) => {
    const file = path.join(packageRoot, name);
    if (!fs.existsSync(file)) return { status: "missing" };
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      return { status: value.status === "partial" ? "partial" : "valid" };
    } catch { return { status: "invalid" }; }
  };
  const daily = packet("DAILY_MARKET_PACKET.json");
  const review = packet("PREDICTION_REVIEW_PACKET.json");
  const quality = review.status !== "valid" ? "writer_only" : daily.status === "valid" ? "normal" : "degraded";
  const editionDate = finalization.requestedAsOf;
  const reportType = finalization.edition === "weekly" ? "weekly" : "daily";
  const receipt = buildReportAvailabilityReceipt({
    editionDate, reportType, publicationQuality: quality, guardianStatus: process.env.GUANCHAO_GUARDIAN_STATUS ?? "UNKNOWN",
    packetStatus: daily.status, reviewStatus: review.status, writerAttemptCount: Math.min(2, Math.max(0, Number(process.env.GUANCHAO_WRITER_ATTEMPT_COUNT ?? 1) || 1)),
    writerSucceeded: true, fallbackRendererUsed: process.env.GUANCHAO_FALLBACK_RENDERER === "true", publicationRetryCount: Math.max(0, Number(process.env.GUANCHAO_PUBLICATION_RETRY_COUNT ?? 0) || 0),
    published, degradationReasons: [daily.status !== "valid" ? `DAILY_PACKET_${daily.status.toUpperCase()}` : null, review.status !== "valid" ? `REVIEW_PACKET_${review.status.toUpperCase()}` : null].filter(Boolean),
  });
  const runsRoot = paths.runsRoot ?? path.join(paths.guanchaoHome ?? path.dirname(paths.repositoryPath), "runs");
  const target = path.join(runsRoot, editionDate, reportType, "REPORT_AVAILABILITY_RECEIPT.json");
  writeReportAvailabilityReceipt(target, receipt);
  return { path: target, ...receipt };
}

function allowedChangedFiles(report) {
  if (report.mode === "global_market_brief") return new Set([report.featureBranchWrite?.storage?.historyPath ?? `content/global-market-briefs/${report.requestedAsOf}.json`, report.featureBranchWrite?.storage?.editionDate ? `content/global-market-briefs/${report.featureBranchWrite.storage.editionDate}.json` : null, "content/global-market-brief-public.json", "content/global-market-brief-index.json"].filter(Boolean));
  if (report.edition === "weekly") return new Set(report.productionApply?.files ?? []);
  return new Set();
}

function assertDiffBoundary(root, allowed) {
  const changed = [];
  const addPath = (relative) => {
    const normalized = relative.replaceAll("\\", "/");
    const full = path.join(root, ...normalized.split("/"));
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) addPath(path.posix.join(normalized, entry.name));
    } else changed.push(normalized);
  };
  for (const line of git(root, ["status", "--porcelain=v1"]).split(/\r?\n/).filter(Boolean)) addPath(line.slice(3));
  for (const file of changed) if (!allowed.has(file)) fail("PUBLISHER_DIFF_BOUNDARY", file, "publisher attempted to include a file outside its validated boundary");
  return changed;
}

export function syncRuntimeToRemote(paths, expectedSha) {
  git(paths.runtimePath, ["fetch", "origin", "main"]);
  const remoteSha = git(paths.runtimePath, ["rev-parse", "refs/remotes/origin/main"]);
  if (remoteSha !== expectedSha) fail("PUBLISHER_RUNTIME_REMOTE_MISMATCH", "runtime", "runtime origin/main differs from pushed canonical commit", { recoveryEvidence: { runtimeRemoteSha: remoteSha, expectedSha } });
  git(paths.runtimePath, ["merge", "--ff-only", "origin/main"]);
  const runtimeSha = git(paths.runtimePath, ["rev-parse", "HEAD"]);
  if (runtimeSha !== expectedSha) fail("PUBLISHER_RUNTIME_SYNC_FAILED", "runtime", "runtime did not reach the pushed canonical commit", { recoveryEvidence: { runtimeSha, expectedSha } });
  if (git(paths.runtimePath, ["status", "--porcelain=v1"])) fail("PUBLISHER_RUNTIME_DIRTY", "runtime", "runtime remains dirty after ff-only sync", { recoveryEvidence: { runtimeSha } });
  return runtimeSha;
}

export function publishWriterResult({ packageDirectory, resultFile, root = repositoryRoot, dryRun = false, production = false, fixtureWrite = false, correction = false, maintenanceProjection = false, automationPaths = null, productionRemote = undefined } = {}) {
  if (production && (dryRun || fixtureWrite)) fail("PUBLISHER_MODE", "mode", "production cannot be combined with dry-run or fixture-write");
  if (!production && !dryRun && !fixtureWrite) fail("PUBLISHER_MODE", "mode", "use dryRun, fixtureWrite, or explicit production");
  const paths = automationPaths ?? resolveAutomationPaths();
  const publicationRoot = production ? paths.repositoryPath : root;
  if (fixtureWrite) assertFixtureTarget(publicationRoot, paths);
  const expectedRemote = productionRemote ?? undefined;
  const writerResult = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  let packageRequest = null;
  try { packageRequest = JSON.parse(fs.readFileSync(path.join(path.resolve(packageDirectory), "REQUEST.json"), "utf8")); } catch { /* finalize reports the authoritative package error */ }
  const existingEditionDate = packageRequest?.mode === "global_market_brief" ? writerResult?.payload?.editionDate ?? packageRequest.requestedAsOf : packageRequest?.requestedAsOf;
  const existingHistory = production && packageRequest?.mode === "global_market_brief" && existingEditionDate
    ? path.join(publicationRoot, "content", "global-market-briefs", `${existingEditionDate}.json`)
    : null;
  if (production && existingHistory && fs.existsSync(existingHistory)) {
    const existing = JSON.parse(fs.readFileSync(existingHistory, "utf8"));
    const existingBusiness = structuredClone(existing);
    const resultBusiness = structuredClone(writerResult.payload);
    delete existingBusiness.generatedAt;
    delete resultBusiness.generatedAt;
    const sameStablePayload = existing.mainArticle?.id === writerResult.payload?.mainArticle?.id;
    if (canonicalJson(existingBusiness) === canonicalJson(resultBusiness) || sameStablePayload) {
      const remoteHead = remoteMainHead(publicationRoot);
      const localHead = git(publicationRoot, ["rev-parse", "HEAD"]);
      const runtimeHead = git(paths.runtimePath, ["rev-parse", "HEAD"]);
      if (localHead !== remoteHead || runtimeHead !== remoteHead || git(publicationRoot, ["status", "--porcelain=v1"]) || git(paths.runtimePath, ["status", "--porcelain=v1"])) {
        fail("PUBLISHER_IDEMPOTENT_STATE_MISMATCH", "git", "same result is already published but canonical/runtime are not at the same clean remote head");
      }
      return {
        schemaVersion: "content-publication-receipt-v1",
        edition: packageRequest.edition,
        editionDate: existingEditionDate,
        articleId: writerResult?.payload?.mainArticle?.id ?? null,
        historyPath: `content/global-market-briefs/${existingEditionDate}.json`,
        publicPath: "content/global-market-brief-public.json",
        archiveIndexPath: "content/global-market-brief-index.json",
        businessSha256: sha256({ edition: packageRequest.edition, editionDate: existingEditionDate, requestId: packageRequest.requestId, resultId: writerResult.resultId, publication: null, storage: null }),
        commitSha: localHead,
        pushStatus: "not-attempted-idempotent",
        publicationStatus: "no-op",
        runtimeSyncStatus: "already-synced",
        contentWritten: false,
        localCommitCreated: false,
        remotePushed: false,
        runtimeSynced: false,
        remoteHeadBefore: remoteHead,
        remoteHeadAfter: remoteHead,
        localHead,
        idempotent: true,
        finalization: { noOp: true, reason: "same canonical article already published" },
        availabilityReceipt: writeAvailabilityReceipt({ paths, packageDirectory, finalization: { edition: packageRequest.edition, requestedAsOf: existingEditionDate }, published: true }),
      };
    }
  }
  const preflight = production ? assertProductionTarget(publicationRoot, paths, expectedRemote, { packageDirectory, requestedAsOf: packageRequest?.requestedAsOf, edition: packageRequest?.mode ?? packageRequest?.edition }) : null;
  const remoteHeadBefore = production ? remoteMainHead(publicationRoot) : null;
  if (production && remoteHeadBefore && remoteMainHead(publicationRoot) !== remoteHeadBefore) fail("PUBLISHER_REMOTE_ADVANCED", "origin/main", "origin/main advanced before filesystem write; no write was attempted", { recoveryEvidence: { contentWritten: false, localCommitCreated: false, remotePushed: false, runtimeSynced: false, remoteHeadBefore, remoteHeadAfter: remoteMainHead(publicationRoot), localHead: git(publicationRoot, ["rev-parse", "HEAD"]) } });
  const finalization = finalizeCodexWriter({ packageDirectory, resultFile, root: publicationRoot, dryRun, write: production || fixtureWrite, correction, maintenanceProjection });
  const businessSha256 = sha256({ edition: finalization.edition, editionDate: finalization.requestedAsOf, requestId: finalization.requestId, resultId: finalization.resultId, publication: finalization.publication ?? null, storage: finalization.featureBranchWrite?.storage ?? null });
  const receipt = {
    schemaVersion: "content-publication-receipt-v1",
    edition: finalization.edition,
    editionDate: finalization.requestedAsOf,
    articleId: finalization.mode === "global_market_brief" ? writerResult?.payload?.mainArticle?.id ?? null : writerResult?.payload?.report?.id ?? finalization.publication?.latestReportId ?? null,
    historyPath: finalization.mode === "global_market_brief" ? finalization.featureBranchWrite?.storage?.historyPath ?? null : null,
    publicPath: finalization.mode === "global_market_brief" ? "content/global-market-brief-public.json" : null,
    archiveIndexPath: finalization.mode === "global_market_brief" ? "content/global-market-brief-index.json" : null,
    businessSha256,
    commitSha: null,
    pushStatus: dryRun ? "not-attempted-dry-run" : fixtureWrite ? "not-attempted-fixture" : "pending",
    publicationStatus: dryRun || fixtureWrite ? "not-pushed" : "pending",
    runtimeSyncStatus: dryRun || fixtureWrite ? "not-attempted" : "pending",
    contentWritten: Boolean(finalization.wrote),
    localCommitCreated: false,
    remotePushed: false,
    runtimeSynced: false,
    remoteHeadBefore,
    remoteHeadAfter: null,
    localHead: null,
    finalization,
  };
  if (!production) return receipt;
  if (!finalization.wrote) fail("PUBLISHER_NO_PUBLICATION", "finalization", "production publisher requires a canonical editorial publication");
  const changed = assertDiffBoundary(publicationRoot, allowedChangedFiles(finalization));
  if (!changed.length) fail("PUBLISHER_NO_CHANGES", "git", "publisher expected validated content changes");
  if (remoteHeadBefore && remoteMainHead(publicationRoot) !== remoteHeadBefore) fail("PUBLISHER_REMOTE_ADVANCED", "origin/main", "origin/main advanced after filesystem write and before commit; canonical repository is dirty and requires recovery", { recoveryEvidence: { contentWritten: true, localCommitCreated: false, remotePushed: false, runtimeSynced: false, remoteHeadBefore, remoteHeadAfter: remoteMainHead(publicationRoot), localHead: git(publicationRoot, ["rev-parse", "HEAD"]), canonicalRepositoryDirty: true } });
  git(publicationRoot, ["add", "--", ...changed]);
  git(publicationRoot, ["commit", "-m", `publish: ${finalization.edition} ${finalization.requestedAsOf}`]);
  receipt.commitSha = git(publicationRoot, ["rev-parse", "HEAD"]);
  receipt.localHead = receipt.commitSha;
  receipt.localCommitCreated = true;
  const remoteHeadAtPush = remoteMainHead(publicationRoot);
  if (remoteHeadBefore && remoteHeadAtPush !== remoteHeadBefore) fail("PUBLISHER_REMOTE_ADVANCED", "origin/main", "origin/main advanced after local commit; local unpublished commit requires recovery", { recoveryEvidence: { contentWritten: true, localCommitCreated: true, remotePushed: false, runtimeSynced: false, remoteHeadBefore, remoteHeadAfter: remoteHeadAtPush, localHead: receipt.commitSha, localUnpublishedCommit: receipt.commitSha } });
  try {
    git(publicationRoot, ["push", "origin", "main"]);
  } catch (cause) {
    fail(classifyPublisherRemoteError(cause), "origin/main", "one-shot production push failed; inspect remote state before retrying", { recoveryEvidence: { contentWritten: true, localCommitCreated: true, remotePushed: false, runtimeSynced: false, remoteHeadBefore, remoteHeadAfter: remoteMainHead(publicationRoot), localHead: receipt.commitSha, localUnpublishedCommit: receipt.commitSha } });
  }
  receipt.remoteHeadAfter = remoteMainHead(publicationRoot);
  if (receipt.remoteHeadAfter !== receipt.commitSha) fail("PUBLISHER_REMOTE_VERIFY_FAILED", "origin/main", "remote main did not reach the local publication commit", { recoveryEvidence: { contentWritten: true, localCommitCreated: true, remotePushed: false, runtimeSynced: false, remoteHeadBefore, remoteHeadAfter: receipt.remoteHeadAfter, localHead: receipt.commitSha } });
  receipt.pushStatus = "pushed";
  receipt.publicationStatus = "pushed";
  receipt.remotePushed = true;
  try {
    receipt.localHead = git(publicationRoot, ["rev-parse", "HEAD"]);
    receipt.runtimeSyncStatus = "synced";
    receipt.runtimeSynced = true;
    syncRuntimeToRemote(paths, receipt.commitSha);
  } catch (cause) {
    receipt.runtimeSyncStatus = "failed";
    receipt.runtimeSynced = false;
    receipt.errorCode = "PUBLISHER_RUNTIME_SYNC_FAILED";
    receipt.recoveryEvidence = { contentWritten: true, localCommitCreated: true, remotePushed: true, runtimeSynced: false, remoteHeadBefore, remoteHeadAfter: receipt.remoteHeadAfter, localHead: receipt.commitSha, runtimeError: cause?.message ?? String(cause) };
    receipt.runtimeSyncStatus = "failed";
    receipt.productionPreflight = preflight;
    return receipt;
  }
  receipt.remotePushed = true;
  receipt.runtimeSynced = true;
  if (git(publicationRoot, ["rev-parse", "HEAD"]) !== receipt.commitSha) fail("PUBLISHER_CANONICAL_VERIFY_FAILED", "root", "canonical repository moved after push");
  if (git(publicationRoot, ["status", "--porcelain=v1"])) fail("PUBLISHER_CANONICAL_DIRTY", "root", "canonical repository remains dirty after publication");
  receipt.productionPreflight = preflight;
  receipt.availabilityReceipt = writeAvailabilityReceipt({ paths, packageDirectory, finalization, published: true });
  return receipt;
}
