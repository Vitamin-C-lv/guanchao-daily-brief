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

function fail(code, field, message) {
  const error = new Error(message);
  error.code = code;
  error.path = field;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(Buffer.from(canonicalJson(value), "utf8")).digest("hex");
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function assertProductionTarget(root, paths) {
  if (path.resolve(root) !== path.resolve(paths.repositoryPath)) fail("PUBLISHER_CANONICAL_REPOSITORY_REQUIRED", "root", "production publishing requires the canonical repository");
  const preflight = runWriterProductionPreflight({ repositoryPath: paths.repositoryPath, runtimePath: paths.runtimePath });
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

export function publishWriterResult({ packageDirectory, resultFile, root = repositoryRoot, dryRun = false, production = false, fixtureWrite = false, correction = false, maintenanceProjection = false } = {}) {
  if (production && (dryRun || fixtureWrite)) fail("PUBLISHER_MODE", "mode", "production cannot be combined with dry-run or fixture-write");
  if (!production && !dryRun && !fixtureWrite) fail("PUBLISHER_MODE", "mode", "use dryRun, fixtureWrite, or explicit production");
  const paths = resolveAutomationPaths();
  if (fixtureWrite) assertFixtureTarget(root, paths);
  const preflight = production ? assertProductionTarget(root, paths) : null;
  const writerResult = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  const finalization = finalizeCodexWriter({ packageDirectory, resultFile, root, dryRun, write: production || fixtureWrite, correction, maintenanceProjection });
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
    finalization,
  };
  if (!production) return receipt;
  if (!finalization.wrote) fail("PUBLISHER_NO_PUBLICATION", "finalization", "production publisher requires a canonical editorial publication");
  const changed = assertDiffBoundary(root, allowedChangedFiles(finalization));
  if (!changed.length) fail("PUBLISHER_NO_CHANGES", "git", "publisher expected validated content changes");
  git(root, ["add", "--", ...changed]);
  git(root, ["commit", "-m", `publish: ${finalization.edition} ${finalization.requestedAsOf}`]);
  receipt.commitSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["push", "origin", "main"]);
  receipt.pushStatus = "pushed";
  receipt.productionPreflight = preflight;
  return receipt;
}
