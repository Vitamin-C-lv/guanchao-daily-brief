import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./research-contract.mjs";
import { resolveAutomationPaths } from "./automation-paths.mjs";
import { finalizeCodexWriter } from "./codex-writer-finalize.mjs";
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
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
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

function assertProductionTarget(root, paths, expectedRemote) {
  if (path.resolve(root) !== path.resolve(paths.repositoryPath)) fail("PUBLISHER_CANONICAL_REPOSITORY_REQUIRED", "root", "production publishing requires the canonical repository");
  const preflight = runWriterProductionPreflight({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath, expectedRemote });
  if (preflight.status !== "READY") fail(preflight.errorCode ?? "PUBLISHER_PREFLIGHT", "production", "canonical production preflight is not ready");
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

function allowedChangedFiles(report) {
  if (report.mode === "global_market_brief") return new Set([`content/global-market-briefs/${report.requestedAsOf}.json`, "content/global-market-brief-public.json", "content/global-market-brief-index.json"]);
  if (report.edition === "weekly") return new Set(report.productionApply?.files ?? []);
  return new Set();
}

function assertDiffBoundary(root, allowed) {
  const changed = git(root, ["status", "--porcelain=v1"]).split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replaceAll("\\", "/"));
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
  const preflight = production ? assertProductionTarget(publicationRoot, paths, expectedRemote) : null;
  const remoteHeadBefore = production ? remoteMainHead(publicationRoot) : null;
  const writerResult = JSON.parse(fs.readFileSync(resultFile, "utf8"));
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
  return receipt;
}
