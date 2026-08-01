import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sealCodexResearch } from "./codex-research.mjs";
import { packetArtifactPlan, prepareCodexWriter } from "./codex-writer-prepare.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_AS_OF = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/writer-packets/daily-latest.json"), "utf8")).marketDates.aShare;
const CONTENT_HASH = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function copy(root, relativePath) {
  const source = path.join(repositoryRoot, ...relativePath.split("/"));
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function candidate() {
  const accessedAt = "2026-07-29T04:00:00+08:00";
  return {
    schemaVersion: "codex-research-v1",
    edition: "daily",
    asOf: PACKET_AS_OF,
    window: { start: PACKET_AS_OF, end: PACKET_AS_OF, timezone: "Asia/Shanghai" },
    documents: [{
      sourceId: "codex-writer-source",
      sourceUrl: "https://example.com/codex-writer-source",
      publisherId: "codex-writer-publisher",
      publisher: "Codex Writer Test Publisher",
      title: "Test market source",
      publishedAt: "2026-07-29T03:00:00Z",
      publishedDate: null,
      accessedAt,
      contentSha256: CONTENT_HASH,
      evidenceClass: "official-primary",
      evidenceExcerpt: "The bounded record states the observed market change and its date.",
      marketScopes: ["US"],
      topics: ["macro"]
    }],
    facts: [{
      sourceId: "codex-writer-source",
      sourceUrl: "https://example.com/codex-writer-source",
      publisher: "Codex Writer Test Publisher",
      publishedAt: "2026-07-29T03:00:00Z",
      publishedDate: null,
      accessedAt,
      claimText: "The bounded record states the observed market change and its date.",
      evidenceClass: "official-primary",
      contentSha256: CONTENT_HASH,
      subject: "market change"
    }],
    observations: [{
      subject: "market change",
      statement: "The source records an observed market change for the dated session.",
      asOf: PACKET_AS_OF,
      occurredAt: "2026-07-29T03:00:00Z",
      kind: "market-event",
      marketScopes: ["US"],
      topics: ["macro"],
      basis: [{ sourceId: "codex-writer-source", relation: "supports", locator: "bounded-record", excerpt: "The bounded record states the observed market change and its date." }]
    }]
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-writer-prepare-"));
  for (const relative of [
    "data/writer-contexts/contract.json",
    "data/research-bundles/contract.json",
    "data/codex-research/contract.json",
    "data/writer-jobs/contract.json",
    "config/editorial-style.json",
    "prompts/luna-daily-brief.md",
    "prompts/luna-weekly-brief.md",
    "scripts/validate-brief.mjs",
    "scripts/validate-weekly.mjs",
    "content/daily-brief.json",
    "content/writer-packets/daily-latest.json"
  ]) copy(root, relative);
  const packet = JSON.parse(fs.readFileSync(path.join(root, "content/writer-packets/daily-latest.json"), "utf8"));
  const researchFile = path.join(root, "candidate.json");
  const run = sealCodexResearch(candidate(), { now: new Date("2026-08-01T01:00:00Z") });
  fs.writeFileSync(researchFile, `${JSON.stringify(run)}\n`, "utf8");
  return { root, packet, researchFile };
}

function cleanup(value) {
  fs.rmSync(value.root, { recursive: true, force: true });
}

test("packet artifact plan is deterministic and immutable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-writer-packet-"));
  const packet = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/writer-packets/daily-latest.json"), "utf8"));
  const first = packetArtifactPlan(packet, root);
  const second = packetArtifactPlan(packet, root);
  assert.equal(first.file, second.file);
  assert.deepEqual(first.bytes, second.bytes);
  fs.rmSync(root, { recursive: true, force: true });
});

test("prepare writes a complete package and re-running is a no-op", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-package`);
  try {
    const first = await prepareCodexWriter({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: true, dryRun: false, root: value.root, now: new Date("2026-08-01T02:00:00Z") });
    assert.equal(first.wrote, true);
    for (const name of ["REQUEST.json", "WRITER_CONTEXT.json", "QUANTITATIVE_PACKET.json", "RESEARCH_BUNDLE.json", "BASELINE_CONTENT.json", "PROMPT.md", "TARGET_SCHEMA.json", "RESULT_TEMPLATE.json", "CODEX_RESEARCH.json", "EDITORIAL_STYLE.json", "MANIFEST.json", "SHA256SUMS.txt"]) assert.ok(fs.existsSync(path.join(output, name)), name);
    const second = await prepareCodexWriter({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: true, dryRun: false, root: value.root, now: new Date("2026-08-02T02:00:00Z") });
    assert.equal(second.noOp, true);
    assert.equal(second.requestId, first.requestId);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});

test("dry-run does not create the package directory", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-dry-package`);
  try {
    const summary = await prepareCodexWriter({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: false, dryRun: true, root: value.root, now: new Date("2026-08-01T02:00:00Z") });
    assert.equal(summary.wrote, false);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});
