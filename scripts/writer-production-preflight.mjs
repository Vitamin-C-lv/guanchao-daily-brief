#!/usr/bin/env node
/**
 * Small launcher-side production guard.
 *
 * The Writer consumes READY or a structured error. It does not discover Git,
 * repositories, or cleanup state while drafting.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { validateEveningPacket } from "./validate-evening-packets.mjs";
import { isForbiddenProductionPath, resolveAutomationPaths } from "./automation-paths.mjs";

export const PRODUCTION_REPOSITORY_REMOTE = "https://github.com/Vitamin-C-lv/guanchao-daily-brief.git";
export const PROTECTED_PRODUCTION_PATHS = Object.freeze([
  "D:/Guanchao-Workspace/repo/guanchao-daily-brief",
  "D:/Guanchao-Workspace/runtime/local-writer-runtime",
  "D:/Guanchao-Workspace/runtime/writer-memory",
  "C:/Codex-Recovery/GuanchaoWriter",
  "D:/周报个人网站",
]);

function normalizePath(value) {
  return path.resolve(String(value).replaceAll("/", path.sep)).replace(/[\\/]+$/, "").toLowerCase();
}

function isWithin(candidate, root) {
  const relative = path.relative(normalizePath(root), normalizePath(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isWithin(left, right) || isWithin(right, left);
}

export function protectedProductionRootFor(target, protectedPaths = PROTECTED_PRODUCTION_PATHS) {
  if (typeof target !== "string" || !target.trim()) return null;
  return protectedPaths.find((root) => pathsOverlap(target, root)) ?? null;
}

export function assertCleanupTargetAllowed(target, protectedPaths = PROTECTED_PRODUCTION_PATHS) {
  const protectedRoot = protectedProductionRootFor(target, protectedPaths);
  if (!protectedRoot) return target;
  const error = new Error(`PROTECTED_PRODUCTION_PATH target=${target} root=${protectedRoot}`);
  error.code = "PROTECTED_PRODUCTION_PATH";
  error.target = target;
  error.protectedRoot = protectedRoot;
  throw error;
}

function defaultGit(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function errorText(error) {
  return String(error?.stderr || error?.stdout || error?.message || error).trim().slice(0, 500);
}

function readGitSnapshot(targetPath, git = defaultGit) {
  const snapshot = {
    path: targetPath,
    exists: fs.existsSync(targetPath),
    clean: null,
    head: null,
    branch: null,
    detached: null,
    remote: null,
    status: [],
    error: null,
    matchesProduction: null,
  };
  if (!snapshot.exists) return snapshot;
  try {
    const status = String(git(targetPath, ["status", "--porcelain=v1", "-uall"]) ?? "");
    snapshot.status = status.split(/\r?\n/).filter(Boolean);
    snapshot.clean = snapshot.status.length === 0;
    snapshot.head = String(git(targetPath, ["rev-parse", "HEAD"]));
    try { snapshot.branch = String(git(targetPath, ["symbolic-ref", "--quiet", "--short", "HEAD"])); } catch { snapshot.branch = null; }
    snapshot.detached = snapshot.branch === null;
    try { snapshot.remote = String(git(targetPath, ["remote", "get-url", "origin"])); } catch { snapshot.remote = null; }
  } catch (error) {
    snapshot.error = errorText(error);
    snapshot.clean = false;
  }
  return snapshot;
}

function normalizeRemote(value) {
  return String(value ?? "").replace(/[\\/]+$/, "").toLowerCase();
}

function packetAudit(file, kind, editionDate, packetValidator) {
  if (!file) return { status: "not_checked", path: null, packetId: null, schemaVersion: null, error: null };
  if (!fs.existsSync(file)) return { status: "missing", path: file, packetId: null, schemaVersion: null, error: "file does not exist" };
  try {
    const packet = JSON.parse(fs.readFileSync(file, "utf8"));
    const summary = packetValidator(packet, kind);
    if (kind === "DAILY_MARKET_PACKET.json" && editionDate && packet.editionDate !== editionDate) {
      throw new Error(`editionDate ${packet.editionDate ?? "null"} != ${editionDate}`);
    }
    return { status: "valid", path: file, packetId: summary.packetId, schemaVersion: summary.schemaVersion, error: null };
  } catch (error) {
    return { status: "invalid", path: file, packetId: null, schemaVersion: null, error: errorText(error) };
  }
}

function packetStatus(audit) {
  return audit.status;
}

export function runWriterProductionPreflight({
  repositoryPath = resolveAutomationPaths().repositoryPath,
  runtimePath = resolveAutomationPaths().runtimePath,
  expectedProductionHead = null,
  expectedRemote = PRODUCTION_REPOSITORY_REMOTE,
  dailyPacketPath = null,
  predictionReviewPacketPath = null,
  editionDate = null,
  editionPath = null,
  git = defaultGit,
  packetValidator = validateEveningPacket,
} = {}) {
  const repository = readGitSnapshot(repositoryPath, git);
  const runtime = readGitSnapshot(runtimePath, git);
  const configuredPaths = [repositoryPath, runtimePath];
  const forbiddenPath = configuredPaths.find((value) => isForbiddenProductionPath(value)) ?? null;
  let productionHead = expectedProductionHead;
  if (!productionHead && repository.exists && !repository.error) {
    try { productionHead = String(git(repositoryPath, ["rev-parse", "refs/remotes/origin/main"])); } catch { productionHead = null; }
  }
  repository.matchesProduction = Boolean(productionHead && repository.head === productionHead);
  runtime.matchesProduction = Boolean(productionHead && runtime.head === productionHead);

  const daily = packetAudit(dailyPacketPath, "DAILY_MARKET_PACKET.json", editionDate, packetValidator);
  const review = packetAudit(predictionReviewPacketPath, "PREDICTION_REVIEW_PACKET.json", editionDate, packetValidator);
  const resolvedEditionPath = editionPath ?? (editionDate ? path.join(repositoryPath, "content", "global-market-briefs", `${editionDate}.json`) : null);
  const editionExists = resolvedEditionPath ? fs.existsSync(resolvedEditionPath) : null;
  const result = {
    schemaVersion: "writer-production-preflight-v1",
    status: "ERROR",
    errorCode: null,
    productionHead: productionHead ?? null,
    repository: {
      ...repository,
      remoteMatchesProduction: Boolean(expectedRemote && normalizeRemote(repository.remote) === normalizeRemote(expectedRemote)),
    },
    runtime: {
      ...runtime,
      remoteMatchesProduction: Boolean(expectedRemote && normalizeRemote(runtime.remote) === normalizeRemote(expectedRemote)),
    },
    packets: { daily: packetStatus(daily), review: packetStatus(review) },
    packetAudit: { daily, review },
    editionExists,
  };

  if (forbiddenPath) result.errorCode = "FORBIDDEN_PRODUCTION_PATH";
  else if (!repository.exists) result.errorCode = "CANONICAL_REPOSITORY_MISSING";
  else if (!runtime.exists) result.errorCode = "CANONICAL_RUNTIME_MISSING";
  else if (repository.error) result.errorCode = "CANONICAL_REPOSITORY_GIT_INVALID";
  else if (runtime.error) result.errorCode = "CANONICAL_RUNTIME_GIT_INVALID";
  else if (!productionHead) result.errorCode = "PRODUCTION_HEAD_UNAVAILABLE";
  else if (!result.repository.remoteMatchesProduction) result.errorCode = "CANONICAL_REPOSITORY_REMOTE_MISMATCH";
  else if (!result.runtime.remoteMatchesProduction) result.errorCode = "CANONICAL_RUNTIME_REMOTE_MISMATCH";
  else if (!repository.clean) result.errorCode = "CANONICAL_REPOSITORY_DIRTY";
  else if (!runtime.clean) result.errorCode = "CANONICAL_RUNTIME_DIRTY";
  else if (!repository.matchesProduction) result.errorCode = "CANONICAL_REPOSITORY_HEAD_MISMATCH";
  else if (!runtime.matchesProduction) result.errorCode = "CANONICAL_RUNTIME_HEAD_MISMATCH";
  else if (editionExists === true) result.errorCode = "DUPLICATE_EDITION_NO_OP";
  else if (daily.status === "missing" || review.status === "missing") result.errorCode = "PACKET_MISSING";
  else if (daily.status === "invalid" || review.status === "invalid") result.errorCode = "PACKET_INVALID";
  else {
    result.status = "READY";
  }
  return result;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) throw new Error(`unknown argument ${values[index]}`);
    const key = values[index].slice(2);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w):/, "$1"))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const paths = resolveAutomationPaths();
    const result = runWriterProductionPreflight({
      repositoryPath: args.repository ? path.resolve(args.repository) : paths.repositoryPath,
      runtimePath: args.runtime ? path.resolve(args.runtime) : paths.runtimePath,
      expectedProductionHead: args["production-head"] ?? null,
      expectedRemote: args["expected-remote"] ?? PRODUCTION_REPOSITORY_REMOTE,
      dailyPacketPath: args["daily-packet"] ? path.resolve(args["daily-packet"]) : null,
      predictionReviewPacketPath: args["review-packet"] ? path.resolve(args["review-packet"]) : null,
      editionDate: args["edition-date"] ?? null,
      editionPath: args["edition-path"] ? path.resolve(args["edition-path"]) : null,
    });
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== "READY") process.exitCode = 1;
  } catch (error) {
    console.error(`WRITER_PRODUCTION_PREFLIGHT_FAILURE ${errorText(error)}`);
    process.exitCode = 1;
  }
}
