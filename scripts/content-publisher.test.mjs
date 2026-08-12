import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { classifyPublisherRemoteError, publishWriterResult } from "./content-publisher.mjs";

test("publisher requires an explicit mode", () => {
  assert.throws(() => publishWriterResult({}), (error) => error.code === "PUBLISHER_MODE");
});

test("fixture write is blocked outside a temporary repository", () => {
  assert.throws(
    () => publishWriterResult({ packageDirectory: "C:/missing", resultFile: "C:/missing.json", root: "C:/non-temporary-fixture", fixtureWrite: true }),
    (error) => error.code === "PUBLISHER_FIXTURE_ROOT"
  );
});

test("fixture write permits a temporary root up to package validation", () => {
  const root = path.join(os.tmpdir(), "guanchao-publisher-fixture");
  assert.throws(
    () => publishWriterResult({ packageDirectory: path.join(root, "package"), resultFile: path.join(root, "result.json"), root, fixtureWrite: true }),
    (error) => error.code !== "PUBLISHER_FIXTURE_ROOT"
  );
});

test("remote race is fail-closed and never retried inside the one-shot publisher", () => {
  assert.equal(classifyPublisherRemoteError({ stderr: "! [rejected] main -> main (non-fast-forward)" }), "PUBLISHER_REMOTE_ADVANCED");
  assert.equal(classifyPublisherRemoteError({ stderr: "fatal: unable to access remote" }), "PUBLISHER_PUSH_FAILED");
});

test("publisher modes keep QA dry-run separate from production", () => {
  assert.throws(() => publishWriterResult({ dryRun: true, production: true }), (error) => error.code === "PUBLISHER_MODE");
  assert.throws(() => publishWriterResult({ fixtureWrite: true, production: true }), (error) => error.code === "PUBLISHER_MODE");
});
