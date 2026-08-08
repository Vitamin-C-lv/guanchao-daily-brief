import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sealCodexResearch } from "./codex-research.mjs";
import { CodexWriterPrepareError, isShanghaiSunday, packetArtifactPlan, prepareCodexWriter } from "./codex-writer-prepare.mjs";
import { refreshWriterPacket } from "./refresh-writer-packet.mjs";
import { runGlobalMarketBriefDryRun } from "./writer-e2e-rehearsal.mjs";
import { finalizeCodexWriter } from "./codex-writer-finalize.mjs";
import { buildAllPackets } from "./build-market-packets.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKET_AS_OF = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/writer-packets/daily-latest.json"), "utf8")).marketDates.aShare;
const RESEARCH_BUNDLE_PATH = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "data/research-bundles/index.json"), "utf8")).bundles.find((item) => item.asOf === PACKET_AS_OF)?.artifactPath;
if (!RESEARCH_BUNDLE_PATH) throw new Error(`missing research bundle for packet asOf ${PACKET_AS_OF}`);
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
    "config/policy-watch-sources.json",
    "config/state-capital-watch-sources.json",
    "prompts/luna-daily-brief.md",
    "prompts/luna-weekly-brief.md",
    "scripts/validate-brief.mjs",
    "scripts/validate-weekly.mjs",
    "content/daily-brief.json",
    "content/writer-packets/daily-latest.json",
    "memory/editorial/OPEN_THREADS.jsonl",
    "memory/editorial/POLICY_WATCH.jsonl",
    "memory/editorial/STATE_CAPITAL_WATCH.jsonl"
  ]) copy(root, relative);
  const packet = JSON.parse(fs.readFileSync(path.join(root, "content/writer-packets/daily-latest.json"), "utf8"));
  // generatedAt is excluded from the packet identity, so a fixture packet can be
  // aligned to the edition date without breaking writerPacketId/integrity hashes.
  packet.generatedAt = `${PACKET_AS_OF}T12:00:00.000Z`;
  fs.writeFileSync(path.join(root, "content/writer-packets/daily-latest.json"), `${JSON.stringify(packet, null, 2)}\n`);
  const eveningDirectory = path.join(root, "runtime", "packets", PACKET_AS_OF);
  const evening = buildAllPackets({ root: repositoryRoot, asOf: PACKET_AS_OF, generatedAt: `${PACKET_AS_OF}T12:00:00.000Z` });
  fs.mkdirSync(eveningDirectory, { recursive: true });
  fs.writeFileSync(path.join(eveningDirectory, "DAILY_MARKET_PACKET.json"), `${JSON.stringify(evening.daily)}\n`);
  fs.writeFileSync(path.join(eveningDirectory, "PREDICTION_REVIEW_PACKET.json"), `${JSON.stringify(evening.review)}\n`);
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
  fs.mkdirSync(path.dirname(first.file), { recursive: true });
  fs.writeFileSync(first.file, first.bytes);
  const refreshed = { ...packet, generatedAt: "2099-01-01T12:00:00.000Z" };
  const reused = packetArtifactPlan(refreshed, root);
  assert.equal(reused.reused, true);
  assert.equal(reused.shouldWrite, false);
  assert.deepEqual(reused.bytes, first.bytes);
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
    for (const name of ["REQUEST.json", "WRITER_CONTEXT.json", "QUANTITATIVE_PACKET.json", "RESEARCH_BUNDLE.json", "BASELINE_CONTENT.json", "DAILY_MARKET_PACKET.json", "PREDICTION_REVIEW_PACKET.json", "WRITER_MEMORY_CONTEXT.json", "PROMPT.md", "TARGET_SCHEMA.json", "RESULT_TEMPLATE.json", "CODEX_RESEARCH.json", "EDITORIAL_STYLE.json", "MANIFEST.json", "SHA256SUMS.txt"]) assert.ok(fs.existsSync(path.join(output, name)), name);
    const preparedDailyPacket = JSON.parse(fs.readFileSync(path.join(output, "DAILY_MARKET_PACKET.json"), "utf8"));
    const preparedReviewPacket = JSON.parse(fs.readFileSync(path.join(output, "PREDICTION_REVIEW_PACKET.json"), "utf8"));
    const preparedMemory = JSON.parse(fs.readFileSync(path.join(output, "WRITER_MEMORY_CONTEXT.json"), "utf8"));
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "MANIFEST.json"), "utf8"));
    assert.equal(preparedDailyPacket.coreIndices.aShare.sse.status, "ready");
    assert.equal(preparedDailyPacket.rates.tenYear.value, value.packet.treasuryFactor.nominal10y);
    assert.ok(preparedReviewPacket.horizons["1d"].publishedModelPrediction.brier >= 0);
    assert.equal(preparedMemory.bootstrap.dailyPacket.packetId, preparedDailyPacket.packetId);
    assert.ok(preparedMemory.bootstrap.policyResearchTargets.some((item) => item.issuer === "证监会"));
    assert.deepEqual(manifest.eveningPackets.map((item) => item.name).sort(), ["DAILY_MARKET_PACKET.json", "PREDICTION_REVIEW_PACKET.json"]);
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

test("Shanghai calendar allows Saturday and Monday, and Sunday is a no-report no-op", async () => {
  assert.equal(isShanghaiSunday("2026-08-08T12:00:00+08:00"), false);
  assert.equal(isShanghaiSunday("2026-08-09T12:00:00+08:00"), true);
  assert.equal(isShanghaiSunday("2026-08-10T12:00:00+08:00"), false);
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-sunday-package`);
  try {
    const summary = await prepareCodexWriter({
      edition: "daily",
      editionDate: "2026-08-09",
      outputDirectory: output,
      write: true,
      dryRun: false,
      root: value.root,
      now: new Date("2026-08-09T12:00:00+08:00"),
    });
    assert.equal(summary.status, "SUNDAY_NO_REPORT");
    assert.equal(summary.wrote, false);
    assert.equal(summary.noOp, true);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});

test("global_market_brief prepare is offline and always reports wrote=false", async () => {
  const value = fixture();
  const output = path.join(value.root, "..", `${path.basename(value.root)}-global-dry-package`);
  try {
    for (const relative of [
      "schemas/global-market-brief-v1.schema.json",
      "schemas/global-market-brief-writer-output-v1.schema.json",
      "scripts/global-market-brief-contract.mjs",
      "content/writer-contexts/fixtures/p2-b1-global-baseline.json",
      "content/writer-contexts/fixtures/p2-b1-global-writer-two-special.json",
      RESEARCH_BUNDLE_PATH
    ]) copy(value.root, relative);
    const baselinePath = path.join(value.root, "content/writer-contexts/fixtures/p2-b1-global-baseline.json");
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    baseline.editionDate = PACKET_AS_OF;
    baseline.generatedAt = `${PACKET_AS_OF}T12:00:00.000Z`;
    fs.writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`, "utf8");
    const packetPlan = packetArtifactPlan(value.packet, value.root);
    fs.mkdirSync(path.dirname(packetPlan.file), { recursive: true });
    fs.writeFileSync(packetPlan.file, packetPlan.bytes);
    const summary = await prepareCodexWriter({
      edition: "daily",
      mode: "global_market_brief",
      marketPacket: "content/writer-packets/daily-latest.json",
      researchBundle: RESEARCH_BUNDLE_PATH,
      baselineSource: "content/writer-contexts/fixtures/p2-b1-global-baseline.json",
      globalInput: "content/writer-contexts/fixtures/p2-b1-global-writer-two-special.json",
      outputDirectory: output,
      write: false,
      dryRun: true,
      root: value.root,
      editionDate: PACKET_AS_OF,
      now: new Date("2026-08-04T02:00:00Z")
    });
    assert.equal(summary.mode, "global_market_brief");
    assert.equal(summary.wrote, false);
    assert.equal(summary.contextSummary.mode, "global_market_brief");
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
    cleanup(value);
  }
});

test("global_market_brief finalize keeps productionApply.applied=false", () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-finalize-"));
  try {
    const rehearsal = runGlobalMarketBriefDryRun({ outputDirectory: output, sourceHead: "db26bc727d3f668f80d33e1b58cdb64456af0a6d" });
    const report = finalizeCodexWriter({ packageDirectory: rehearsal.executionPackage, resultFile: path.join(output, "writer-result.json"), root: rehearsal.isolationRoot, dryRun: true, write: false });
    assert.equal(report.mode, "global_market_brief");
    assert.equal(report.wrote, false);
    assert.equal(report.productionApply.applied, false);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
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
