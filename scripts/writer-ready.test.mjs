import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writerReady } from "./writer-ready.mjs";

const paths = {
  repositoryPath: "C:/canonical/repo",
  runtimePath: "C:/canonical/runtime",
  eveningPacketsRoot: "C:/canonical/packets",
  recoveryRoot: "C:/recovery"
};

test("Sunday is a deterministic no-report hard stop before any production preflight", () => {
  let calls = 0;
  const result = writerReady({
    edition: "daily",
    editionDate: "2026-08-16",
    paths,
    preflight: () => { calls += 1; return { status: "READY" }; },
    writeDiagnostics: false
  });
  assert.deepEqual(result, { ready: false, code: "SUNDAY_NO_REPORT", edition: "daily", editionDate: "2026-08-16" });
  assert.equal(calls, 0);
});

test("automation inconsistency remains a compact hard stop", () => {
  const result = writerReady({
    edition: "weekly",
    editionDate: "2026-08-12",
    paths,
    preflight: () => ({ status: "READY" }),
    automationCheck: () => ({ consistent: false }),
    writeDiagnostics: false
  });
  assert.equal(result.ready, false);
  assert.equal(result.code, "AUTOMATION_DRIFT");
});

test("Shanghai date calculation is locale-independent", () => {
  const result = writerReady({
    edition: "daily",
    now: new Date("2026-08-12T00:30:00.000Z"),
    paths,
    preflight: () => ({ status: "READY" }),
    automationCheck: () => ({ consistent: false }),
    writeDiagnostics: false
  });
  assert.equal(result.editionDate, "2026-08-12");
});

test("availability-first keeps Daily ready with a bounded degraded context when packets are missing", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "writer-ready-availability-"));
  const isolatedPaths = { repositoryPath: path.join(staging, "repo"), runtimePath: path.join(staging, "runtime"), eveningPacketsRoot: path.join(staging, "packets"), recoveryRoot: path.join(staging, "recovery") };
  try {
    const result = writerReady({ edition: "daily", editionDate: "2026-08-12", paths: isolatedPaths, preflight: () => ({ status: "READY" }), automationCheck: () => ({ consistent: true }), writeDiagnostics: false });
    assert.equal(result.ready, true);
    assert.equal(result.availability, "degraded");
    assert.equal(result.packetStatus.daily, "missing");
    assert.equal(fs.existsSync(result.degradedContext), true);
    const context = JSON.parse(fs.readFileSync(result.degradedContext, "utf8"));
    assert.equal(context.strategy.probability, null);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});
