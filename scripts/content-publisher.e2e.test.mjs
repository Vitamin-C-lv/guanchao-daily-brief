import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { syncRuntimeToRemote } from "./content-publisher.mjs";

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function configure(cwd) {
  git(cwd, ["config", "user.email", "publisher-e2e@example.invalid"]);
  git(cwd, ["config", "user.name", "Publisher E2E"]);
}

test("publisher full E2E Git boundary writes, pushes, verifies and ff-only syncs", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-full-e2e-"));
  const remote = path.join(staging, "remote.git");
  const canonical = path.join(staging, "canonical");
  const runtime = path.join(staging, "runtime");
  const racer = path.join(staging, "racer");
  try {
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", windowsHide: true });
    execFileSync("git", ["clone", remote, canonical], { encoding: "utf8", windowsHide: true });
    configure(canonical);
    fs.mkdirSync(path.join(canonical, "content", "weekly-reports"), { recursive: true });
    fs.mkdirSync(path.join(canonical, "public"), { recursive: true });
    fs.writeFileSync(path.join(canonical, "README.md"), "publisher e2e\n");
    git(canonical, ["add", "README.md"]);
    git(canonical, ["commit", "-m", "init"]);
    git(canonical, ["branch", "-M", "main"]);
    git(canonical, ["push", "origin", "main"]);
    execFileSync("git", ["clone", remote, runtime], { encoding: "utf8", windowsHide: true });
    configure(runtime);
    fs.writeFileSync(path.join(canonical, "content", "weekly-reports", "weekly-2026-W99.json"), "{\"revision\":1}\n");
    fs.writeFileSync(path.join(canonical, "content", "weekly-reports", "index.json"), "{\"latestReportId\":\"weekly-2026-W99\"}\n");
    fs.writeFileSync(path.join(canonical, "public", "update-notices.json"), "{\"latest\":\"weekly-2026-W99\"}\n");
    git(canonical, ["add", "content/weekly-reports/weekly-2026-W99.json", "content/weekly-reports/index.json", "public/update-notices.json"]);
    git(canonical, ["commit", "-m", "publish: weekly 2026-08-08"]);
    const commitSha = git(canonical, ["rev-parse", "HEAD"]);
    git(canonical, ["push", "origin", "main"]);
    assert.equal(git(canonical, ["status", "--porcelain=v1"]), "");
    syncRuntimeToRemote({ runtimePath: runtime }, commitSha);
    assert.equal(git(runtime, ["rev-parse", "HEAD"]), commitSha);
    assert.equal(git(runtime, ["status", "--porcelain=v1"]), "");
    for (const file of ["content/weekly-reports/weekly-2026-W99.json", "content/weekly-reports/index.json", "public/update-notices.json"]) assert.equal(fs.existsSync(path.join(runtime, file)), true);
    syncRuntimeToRemote({ runtimePath: runtime }, commitSha);
    execFileSync("git", ["clone", "-b", "main", remote, racer], { encoding: "utf8", windowsHide: true });
    configure(racer);
    fs.writeFileSync(path.join(racer, "RACE.txt"), "remote advanced\n");
    git(racer, ["add", "RACE.txt"]);
    git(racer, ["commit", "-m", "remote advance"]);
    git(racer, ["push", "origin", "main"]);
    assert.throws(() => syncRuntimeToRemote({ runtimePath: runtime }, commitSha), (error) => error.code === "PUBLISHER_RUNTIME_REMOTE_MISMATCH");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});
