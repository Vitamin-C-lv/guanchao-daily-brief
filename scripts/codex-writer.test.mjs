import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sealCodexResearch } from "./codex-research.mjs";
import { CodexWriterPrepareError, packetArtifactPlan, prepareCodexWriter } from "./codex-writer-prepare.mjs";
import { refreshWriterPacket } from "./refresh-writer-packet.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_AS_OF = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/writer-packets/daily-latest.json"), "utf8")).marketDates.aShare;
const CONTENT_HASH = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

function copy(root, relativePath) {
  const source = path.join(repositoryRoot, ...relativePath.split("/"));
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function candidate(asOf = PACKET_AS_OF) {
  const accessedAt = "2026-07-29T04:00:00+08:00";
  return {
    schemaVersion: "codex-research-v1",
    edition: "daily",
    asOf,
    window: { start: asOf, end: asOf, timezone: "Asia/Shanghai" },
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
      asOf,
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
  // generatedAt is excluded from the packet identity, so a fixture packet can be
  // aligned to the edition date without breaking writerPacketId/integrity hashes.
  packet.generatedAt = `${PACKET_AS_OF}T12:00:00.000Z`;
  fs.writeFileSync(path.join(root, "content/writer-packets/daily-latest.json"), `${JSON.stringify(packet, null, 2)}\n`);
  // The checked-in brief may already be published after PACKET_AS_OF; a fixture
  // baseline must never be later than the edition date under test.
  const baselineFile = path.join(root, "content/daily-brief.json");
  const brief = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  brief.meta.editionDate = PACKET_AS_OF;
  fs.writeFileSync(baselineFile, `${JSON.stringify(brief, null, 2)}\n`);
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

function withEditionDate(options) {
  return { editionDate: PACKET_AS_OF, ...options };
}

test("prepare writes a complete package and re-running is a no-op", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-package`);
  try {
    const first = await prepareCodexWriter(withEditionDate({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: true, dryRun: false, root: value.root, now: new Date("2026-08-01T02:00:00Z") }));
    assert.equal(first.wrote, true);
    assert.equal(first.freshness.passed, true);
    assert.equal(first.freshness.relations.requestedAsOf, PACKET_AS_OF);
    for (const name of ["REQUEST.json", "WRITER_CONTEXT.json", "QUANTITATIVE_PACKET.json", "RESEARCH_BUNDLE.json", "BASELINE_CONTENT.json", "PROMPT.md", "TARGET_SCHEMA.json", "RESULT_TEMPLATE.json", "CODEX_RESEARCH.json", "EDITORIAL_STYLE.json", "MANIFEST.json", "SHA256SUMS.txt"]) assert.ok(fs.existsSync(path.join(output, name)), name);
    const second = await prepareCodexWriter(withEditionDate({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: true, dryRun: false, root: value.root, now: new Date("2026-08-02T02:00:00Z") }));
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
    const summary = await prepareCodexWriter(withEditionDate({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: false, dryRun: true, root: value.root, now: new Date("2026-08-01T02:00:00Z") }));
    assert.equal(summary.wrote, false);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});

test("stale writer packet blocks writing with STALE_WRITER_PACKET", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-stale-package`);
  try {
    await assert.rejects(
      prepareCodexWriter({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: value.researchFile, outputDirectory: output, write: true, dryRun: false, root: value.root, editionDate: "2026-08-04", now: new Date("2026-08-04T02:00:00Z") }),
      (error) => error instanceof CodexWriterPrepareError && error.code === "STALE_WRITER_PACKET"
    );
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});

test("research asOf differing from packet blocks writing", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-research-mismatch`);
  try {
    const run = sealCodexResearch(candidate("2026-07-30"), { now: new Date("2026-07-30T01:00:00Z") });
    const researchFile = path.join(value.root, "mismatch.json");
    fs.writeFileSync(researchFile, `${JSON.stringify(run)}\n`, "utf8");
    await assert.rejects(
      prepareCodexWriter(withEditionDate({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: researchFile, outputDirectory: output, write: true, dryRun: false, root: value.root, now: new Date("2026-08-01T02:00:00Z") })),
      (error) => error instanceof CodexWriterPrepareError && error.code === "RESEARCH_COMPATIBILITY"
    );
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});

test("refreshed packet is accepted by prepare after market data refresh", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-fresh-package`);
  try {
    // Stub runner writes a same-day packet into the fixture packet path.
    const runner = path.join(value.root, "stub-market-runner.mjs");
    const stub = `import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
const args = process.argv.slice(2);
const edition = args[args.indexOf("--edition") + 1];
const asOf = args[args.indexOf("--as-of") + 1];
const packet = {
  schemaVersion: 1,
  edition,
  generatedAt: asOf + "T02:00:00.000Z",
  marketDates: { aShare: asOf, us: asOf },
  marketSummary: { status: "partial" },
  providerHealth: { status: "ready", readySources: 2, sourceCount: 2, requiredSourceCount: 2, requiredSourcesReady: true },
  sourceIndex: { "us-treasury-nominal-xml": { sourceId: "us-treasury-nominal-xml", status: "ready" } },
  facts: [{ factId: "treasury-nominal2y-" + asOf, label: "US Treasury 2Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/x", status: "ready", unit: "percent", value: 4.26, changeUnit: "bp", change1d: -1, change5d: 2, change20d: 3, asOf, releasedAt: asOf }],
  treasuryFactor: { status: "ready", spread2s10sBp: 35, changesBp: {}, nominalSource: { sourceId: "us-treasury-nominal-xml", asOf }, realSource: { sourceId: "us-treasury-real-xml", asOf } },
  writerPacketId: "",
  integrity: { businessSha256: "", sha256: "" }
};
const strip = (v) => Array.isArray(v) ? v.map(strip) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => !["requestedAt","completedAt","generatedAt","rawSha256","integrity","businessIntegrity","writerPacketId","runId"].includes(k)).map(([k,i]) => [k, strip(i)])) : v;
const normalize = (v) => Array.isArray(v) ? v.map(normalize) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, normalize(v[k])])) : v;
const h = (v) => createHash("sha256").update(JSON.stringify(normalize(strip(v)))).digest("hex");
packet.writerPacketId = h(packet);
packet.integrity = { businessSha256: packet.writerPacketId, sha256: packet.writerPacketId };
fs.mkdirSync(path.join(root, "content", "writer-packets"), { recursive: true });
fs.writeFileSync(path.join(root, "content", "writer-packets", edition + "-latest.json"), JSON.stringify(packet) + "\\n");
console.log(JSON.stringify({ ok: true, asOf }));
`;
    fs.writeFileSync(runner, stub, "utf8");
    const summary = refreshWriterPacket({ edition: "daily", editionDate: PACKET_AS_OF, runner: "stub-market-runner.mjs", root: value.root, now: new Date("2026-08-03T12:00:00.000Z") });
    assert.equal(summary.writerPacketId.length, 64);
    // At the fixed refresh time the latest complete A-share trading day equals the packet edition date.
    assert.equal(summary.marketDates.aShare, PACKET_AS_OF);
    const research = sealCodexResearch(candidate(PACKET_AS_OF), { now: new Date("2026-08-03T01:00:00Z") });
    const alignedResearch = path.join(value.root, "aligned.json");
    fs.writeFileSync(alignedResearch, `${JSON.stringify(research)}\n`, "utf8");
    const prepared = await prepareCodexWriter({ edition: "daily", marketPacket: "content/writer-packets/daily-latest.json", codexResearch: alignedResearch, outputDirectory: output, write: true, dryRun: false, root: value.root, editionDate: PACKET_AS_OF, now: new Date("2026-08-01T02:00:00Z") });
    assert.equal(prepared.wrote, true);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});
