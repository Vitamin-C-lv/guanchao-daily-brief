import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sealNoResearchBundle, validateCodexResearch } from "./codex-research.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("no-targeted-research creates a sealed run with an official reference and no invented facts", () => {
  const run = sealNoResearchBundle({ edition: "daily", asOf: "2026-08-12", root, now: new Date("2026-08-12T12:00:00.000Z") });
  assert.equal(run.schemaVersion, "codex-research-v1");
  assert.equal(run.facts.length, 0);
  assert.equal(run.observations.length, 0);
  assert.equal(run.documents.length, 1);
  assert.equal(run.documents[0].evidenceClass, "official-primary");
  assert.doesNotThrow(() => validateCodexResearch(run));
});
