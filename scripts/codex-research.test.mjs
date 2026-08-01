import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CodexResearchError,
  sealCodexResearch,
  storeCodexResearchRun,
  validateCodexResearch
} from "./codex-research.mjs";

const HASH_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function candidate() {
  const accessA = "2026-08-01T01:00:00+08:00";
  const accessB = "2026-08-01T01:02:00+08:00";
  return {
    schemaVersion: "codex-research-v1",
    edition: "daily",
    asOf: "2026-08-01",
    window: { start: "2026-07-28", end: "2026-08-01", timezone: "Asia/Shanghai" },
    documents: [
      {
        sourceId: "official-macro-1",
        sourceUrl: "https://example.com/official/macro-1",
        publisherId: "official-example",
        publisher: "Official Example",
        title: "Official macro release",
        publishedAt: "2026-07-31T08:00:00Z",
        publishedDate: null,
        accessedAt: accessA,
        contentSha256: HASH_A,
        evidenceClass: "official-primary",
        evidenceExcerpt: "The release reports the measured change and its publication date.",
        marketScopes: ["A_SHARE", "US"],
        topics: ["macro", "market-structure"]
      },
      {
        sourceId: "specialist-market-1",
        sourceUrl: "https://example.com/market/brief-1",
        publisherId: "specialist-example",
        publisher: "Specialist Example",
        title: "Specialist market brief",
        publishedAt: "2026-07-31T09:00:00Z",
        publishedDate: null,
        accessedAt: accessB,
        contentSha256: HASH_B,
        evidenceClass: "specialist-media",
        evidenceExcerpt: "The independent brief describes the same observed move and the relevant session.",
        marketScopes: ["A_SHARE", "US"],
        topics: ["macro", "market-structure"]
      }
    ],
    facts: [
      {
        sourceId: "official-macro-1",
        sourceUrl: "https://example.com/official/macro-1",
        publisher: "Official Example",
        publishedAt: "2026-07-31T08:00:00Z",
        publishedDate: null,
        accessedAt: accessA,
        claimText: "The official release records the measured macro change.",
        evidenceClass: "official-primary",
        contentSha256: HASH_A,
        subject: "macro release",
        value: 1.2,
        unit: "percent"
      },
      {
        sourceId: "specialist-market-1",
        sourceUrl: "https://example.com/market/brief-1",
        publisher: "Specialist Example",
        publishedAt: "2026-07-31T09:00:00Z",
        publishedDate: null,
        accessedAt: accessB,
        claimText: "The specialist brief describes the same observed market session.",
        evidenceClass: "specialist-media",
        contentSha256: HASH_B,
        subject: "market session"
      }
    ],
    observations: [
      {
        subject: "macro and market session",
        statement: "The official release and the independent brief describe the same observed session; the bundle does not infer a causal forecast.",
        asOf: "2026-08-01",
        occurredAt: "2026-07-31T09:00:00Z",
        kind: "market-event",
        marketScopes: ["A_SHARE", "US"],
        topics: ["macro", "market-structure"],
        entities: ["official release"],
        basis: [
          { sourceId: "official-macro-1", relation: "supports", locator: "release summary", excerpt: "The release reports the measured change and its publication date." },
          { sourceId: "specialist-market-1", relation: "supports", locator: "session note", excerpt: "The independent brief describes the same observed move and the relevant session." }
        ]
      }
    ]
  };
}

test("seals deterministic facts, observations, and adapted bundle identity", () => {
  const run = sealCodexResearch(candidate(), { now: new Date("2026-08-01T02:00:00Z") });
  assert.equal(run.schemaVersion, "codex-research-v1");
  assert.equal(run.observations[0].evidenceState, "confirmed");
  assert.equal(run.documents.length, 2);
  assert.equal(run.facts.length, 2);
  assert.equal(run.evidenceRecords.length, 2);
  assert.match(run.researchRunId, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => validateCodexResearch(run));
  const repeat = sealCodexResearch(candidate(), { now: new Date("2026-08-02T04:00:00Z") });
  assert.equal(repeat.researchRunId, run.researchRunId, "audit time must not change business identity");
});

test("rejects title-only evidence and unbound fact metadata", () => {
  const titleOnly = candidate();
  titleOnly.observations[0].basis[0].excerpt = titleOnly.documents[0].title;
  assert.throws(() => sealCodexResearch(titleOnly, { now: new Date("2026-08-01T02:00:00Z") }), (error) => error instanceof CodexResearchError && error.code === "TITLE_ONLY_EVIDENCE");

  const unbound = candidate();
  unbound.facts[0].publisher = "Other publisher";
  assert.throws(() => sealCodexResearch(unbound, { now: new Date("2026-08-01T02:00:00Z") }), (error) => error instanceof CodexResearchError && error.code === "FACT_BINDING");
});

test("rejects forbidden full article fields", () => {
  const value = candidate();
  value.documents[0].body = "This must never be stored";
  assert.throws(() => sealCodexResearch(value, { now: new Date("2026-08-01T02:00:00Z") }), (error) => error instanceof CodexResearchError && error.code === "FORBIDDEN_KEY");
});

test("dry-run storage reports immutable writes without changing the repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-research-test-"));
  const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  fs.mkdirSync(path.join(root, "data", "research-bundles"), { recursive: true });
  fs.mkdirSync(path.join(root, "data", "codex-research"), { recursive: true });
  fs.cpSync(path.join(testRoot, "data", "research-bundles", "contract.json"), path.join(root, "data", "research-bundles", "contract.json"));
  fs.cpSync(path.join(testRoot, "data", "codex-research", "contract.json"), path.join(root, "data", "codex-research", "contract.json"));
  const run = sealCodexResearch(candidate(), { now: new Date("2026-08-01T02:00:00Z") });
  const before = fs.readdirSync(root, { recursive: true });
  const summary = await storeCodexResearchRun({ run, root, dryRun: true, write: false });
  assert.equal(summary.dryRun, true);
  assert.ok(summary.wouldWrite.length > 0);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }), before);
});
