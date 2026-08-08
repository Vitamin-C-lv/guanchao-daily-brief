import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PROTECTED_PRODUCTION_PATHS,
  assertCleanupTargetAllowed,
  runWriterProductionPreflight,
} from "./writer-production-preflight.mjs";

const SHA = "e84904dc4cdfa89162aa161f91e75699434b1a53";
const REMOTE = "https://github.com/Vitamin-C-lv/guanchao-daily-brief.git";

function fixture({ repositoryExists = true, runtimeExists = true, repositoryHead = SHA, runtimeHead = SHA, repositoryStatus = "", runtimeStatus = "", repositoryRemote = REMOTE, runtimeRemote = REMOTE } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "writer-production-preflight-"));
  const repositoryPath = path.join(root, "repo");
  const runtimePath = path.join(root, "runtime");
  if (repositoryExists) fs.mkdirSync(repositoryPath, { recursive: true });
  if (runtimeExists) fs.mkdirSync(runtimePath, { recursive: true });
  const values = new Map();
  const add = (target, key, value) => values.set(`${target}|${key.join(" ")}`, value);
  for (const [target, head, status, remote] of [[repositoryPath, repositoryHead, repositoryStatus, repositoryRemote], [runtimePath, runtimeHead, runtimeStatus, runtimeRemote]]) {
    add(target, ["status", "--porcelain=v1", "-uall"], status);
    add(target, ["rev-parse", "HEAD"], head);
    add(target, ["symbolic-ref", "--quiet", "--short", "HEAD"], null);
    add(target, ["remote", "get-url", "origin"], remote);
    add(target, ["rev-parse", "refs/remotes/origin/main"], SHA);
  }
  const git = (cwd, args) => {
    const value = values.get(`${cwd}|${args.join(" ")}`);
    if (value === null || value === undefined) throw new Error("detached");
    return value;
  };
  return { repositoryPath, runtimePath, git, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("canonical repo missing fails before Writer", () => {
  const value = fixture({ repositoryExists: false });
  try {
    const result = runWriterProductionPreflight({ ...value, expectedProductionHead: SHA });
    assert.equal(result.status, "ERROR");
    assert.equal(result.errorCode, "CANONICAL_REPOSITORY_MISSING");
  } finally { value.cleanup(); }
});

test("clean repository and exact production runtime are READY", () => {
  const value = fixture();
  try {
    const result = runWriterProductionPreflight({ ...value, expectedProductionHead: SHA });
    assert.equal(result.status, "READY");
    assert.equal(result.repository.matchesProduction, true);
    assert.equal(result.runtime.matchesProduction, true);
  } finally { value.cleanup(); }
});

test("clean detached runtime at exact production SHA is allowed", () => {
  const value = fixture();
  try {
    const result = runWriterProductionPreflight({ ...value, expectedProductionHead: SHA });
    assert.equal(result.runtime.detached, true);
    assert.equal(result.status, "READY");
  } finally { value.cleanup(); }
});

test("detached runtime at the wrong SHA fails", () => {
  const value = fixture({ runtimeHead: "1111111111111111111111111111111111111111" });
  try {
    const result = runWriterProductionPreflight({ ...value, expectedProductionHead: SHA });
    assert.equal(result.status, "ERROR");
    assert.equal(result.errorCode, "CANONICAL_RUNTIME_HEAD_MISMATCH");
  } finally { value.cleanup(); }
});

test("dirty runtime fails", () => {
  const value = fixture({ runtimeStatus: " M content/example.json" });
  try {
    const result = runWriterProductionPreflight({ ...value, expectedProductionHead: SHA });
    assert.equal(result.status, "ERROR");
    assert.equal(result.errorCode, "CANONICAL_RUNTIME_DIRTY");
  } finally { value.cleanup(); }
});

test("cleanup target equal to or overlapping canonical roots is refused", () => {
  for (const root of PROTECTED_PRODUCTION_PATHS.slice(0, 4)) {
    assert.throws(() => assertCleanupTargetAllowed(root), { code: "PROTECTED_PRODUCTION_PATH" });
    assert.throws(() => assertCleanupTargetAllowed(path.join(root, "nested")), { code: "PROTECTED_PRODUCTION_PATH" });
    assert.throws(() => assertCleanupTargetAllowed(path.dirname(root)), { code: "PROTECTED_PRODUCTION_PATH" });
  }
});

test("ordinary feature worktree remains allowed", () => {
  const ordinary = "D:/Guanchao-Workspace/worktrees/active/example";
  assert.equal(assertCleanupTargetAllowed(ordinary), ordinary);
  assert.equal(assertCleanupTargetAllowed("D:/Guanchao-Workspace/runtime/local-writer-runtime.tmp"), "D:/Guanchao-Workspace/runtime/local-writer-runtime.tmp");
});
