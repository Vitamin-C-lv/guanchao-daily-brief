import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  canonicalJson,
  computeBundleId,
  computeSourceRunId,
  sha256Canonical,
  validateBundle
} from "./research-contract.mjs";
import {
  WriterContextError,
  baselineBusinessView,
  baselineStableArtifactView,
  computeContentIdentity,
  computeContextId,
  contextStableArtifactView,
  createBaseline,
  loadWriterContextRegistry,
  prepareWriterContext,
  readJsonOrGzip,
  rebuildWriterContextDerivedViews,
  validateBaseline,
  validateRepoRelativePath,
  validateWriterContext,
  validateWriterContextRegistry
} from "./writer-context.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const moduleFile = path.join(repositoryRoot, "scripts", "writer-context.mjs");
const HASH = "a".repeat(64);
const AS_OF = "2026-07-30";
const NOW = new Date("2026-07-30T12:00:00.000Z");

// Keep exact-byte hashing local to the fixture. Business canonicalization always uses the
// repository helper imported above.
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

function copy(root, relativePath) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, ...relativePath.split("/")), target);
}

function write(root, relativePath, bytes) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function sealSourceRun(overrides = {}) {
  const value = {
    sourceRunId: "",
    sourceId: "fixture-source",
    provider: "Fixture Provider",
    sourceClass: "official-primary",
    adapterId: "fixture-adapter",
    adapterVersion: "v1",
    requestedAt: "2026-07-30T10:00:00.000Z",
    asOf: "2026-07-30T10:00:00.000Z",
    status: "unavailable",
    sourceUrl: "https://example.com/fixture",
    marketScopes: ["US"],
    topics: ["macro"],
    coverage: { itemCount: 0, note: "fixture unavailable" },
    snapshotPolicy: "none",
    rawSnapshotId: null,
    warnings: ["fixture unavailable"],
    integrity: { businessSha256: "", sha256: "" },
    ...overrides
  };
  value.sourceRunId = computeSourceRunId(value);
  value.integrity.businessSha256 = value.sourceRunId;
  value.integrity.sha256 = sha256Canonical({ ...value, integrity: { businessSha256: value.sourceRunId } });
  return value;
}

function researchBundle(edition = "daily", asOf = AS_OF) {
  const run = sealSourceRun({ asOf: `${asOf}T10:00:00.000Z`, requestedAt: `${asOf}T10:00:00.000Z` });
  const value = {
    schemaVersion: "research-bundle-v1",
    edition,
    asOf,
    generatedAt: `${asOf}T12:00:00.000Z`,
    window: { start: edition === "daily" ? asOf : "2026-07-24", end: asOf, timezone: "Asia/Shanghai" },
    sourcePolicyVersion: "research-source-policy-v1",
    sourceRuns: [run],
    documents: [],
    observations: [],
    events: [],
    duplicateClusters: [],
    coverage: {
      markets: ["A_SHARE", "HK", "US", "FED"].map((market) => ({ market, status: "partial", documentCount: 0, observationCount: 0, reasons: ["fixture coverage gap"] })),
      topics: [],
      totals: { sourceRuns: 1, documents: 0, observations: 0, events: 0, duplicateClusters: 0, conflictingObservations: 0 }
    },
    warnings: ["fixture coverage gap"],
    bundleId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  value.bundleId = computeBundleId(value);
  value.integrity.businessSha256 = value.bundleId;
  value.integrity.sha256 = sha256Canonical({ ...value, integrity: { businessSha256: value.bundleId } });
  return value;
}

function packetIdentity(value) {
  if (Array.isArray(value)) return value.map(packetIdentity);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !new Set(["requestedAt", "completedAt", "generatedAt", "rawSha256", "integrity", "businessIntegrity", "writerPacketId", "runId"]).has(key)).map(([key, item]) => [key, packetIdentity(item)]));
  return value;
}

function writerPacket(edition = "daily", asOf = AS_OF) {
  const value = {
    schemaVersion: 1,
    edition,
    generatedAt: `${asOf}T12:00:00.000Z`,
    marketDates: { aShare: asOf, us: asOf },
    marketSummary: { status: "partial" },
    providerHealth: { status: "ready" },
    sourceIndex: {
      "us-treasury-nominal-xml": { sourceId: "us-treasury-nominal-xml", status: "ready" }
    },
    facts: [{
      factId: `treasury-nominal2y-${asOf}`,
      label: "US Treasury 2Y",
      market: "US",
      topic: "treasury",
      sourceId: "us-treasury-nominal-xml",
      sourceUrl: "https://home.treasury.gov/fixture",
      status: "ready",
      unit: "percent",
      value: 4.26,
      changeUnit: "bp",
      change1d: -1,
      change5d: 2,
      change20d: 3,
      asOf,
      releasedAt: asOf
    }],
    treasuryFactor: {
      status: "ready",
      spread2s10sBp: 35,
      changesBp: {},
      nominalSource: { sourceId: "us-treasury-nominal-xml", asOf },
      realSource: { sourceId: "us-treasury-real-xml", asOf }
    },
    writerPacketId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  const businessHash = sha256Canonical(packetIdentity(value));
  value.writerPacketId = businessHash;
  value.integrity = { businessSha256: businessHash, sha256: businessHash };
  return value;
}

function artifact(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function makeRoot({ edition = "daily", asOf = AS_OF } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-writer-context-"));
  for (const relative of [
    "data/writer-contexts/contract.json",
    "data/research-bundles/contract.json",
    "prompts/luna-daily-brief.md",
    "prompts/luna-weekly-brief.md",
    "scripts/validate-brief.mjs",
    "scripts/validate-weekly.mjs",
    "content/daily-brief.json",
    "content/weekly-reports/weekly-2026-W29.json"
  ]) copy(root, relative);
  const packet = writerPacket(edition, asOf);
  const bundle = researchBundle(edition, asOf);
  const packetPath = `data/writer-jobs/packets/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${packet.writerPacketId}.json.gz`;
  const bundlePath = `data/research-bundles/bundles/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${bundle.bundleId}.json.gz`;
  write(root, packetPath, artifact(packet));
  write(root, bundlePath, artifact(bundle));
  return { root, edition, asOf, packet, bundle, packetPath, bundlePath, baselineSource: edition === "daily" ? "content/daily-brief.json" : "content/weekly-reports/weekly-2026-W29.json" };
}

function clean(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function prepare(fixture, options = {}) {
  return prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, write: true, root: fixture.root, now: NOW, ...options });
}

function loadPrepared(fixture, summary) {
  return {
    baseline: readJsonOrGzip(path.join(fixture.root, ...summary.baselinePath.split("/"))),
    context: readJsonOrGzip(path.join(fixture.root, ...summary.contextPath.split("/")))
  };
}

function resealContext(context) {
  context.contextId = computeContextId(context);
  context.integrity.businessSha256 = context.contextId;
  context.integrity.sha256 = sha256Canonical({ ...context, integrity: { businessSha256: context.contextId } });
  return context;
}

function resealBaseline(baseline) {
  baseline.contentIdentity = computeContentIdentity(baseline);
  baseline.integrity.businessSha256 = baseline.contentIdentity;
  baseline.integrity.sha256 = sha256Canonical({ ...baseline, integrity: { businessSha256: baseline.contentIdentity } });
  return baseline;
}

function expectCode(action, code) {
  assert.throws(action, (error) => error instanceof WriterContextError && error.code === code);
}

function filesBelow(root) {
  const visit = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? visit(path.join(directory, entry.name)) : [path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/")]);
  return visit(root).sort();
}

test("01 registry validates", () => assert.equal(validateWriterContextRegistry(loadWriterContextRegistry()).schemaVersion, "writer-context-contract-v1"));
test("02 registry rejects a wrong baseline version", () => { const value = structuredClone(loadWriterContextRegistry()); value.baselineSchemaVersion = "bad"; expectCode(() => validateWriterContextRegistry(value), "REGISTRY_SCHEMA"); });
test("03 registry rejects a wrong request version", () => { const value = structuredClone(loadWriterContextRegistry()); value.requestSchemaVersion = "writer-request-v1"; expectCode(() => validateWriterContextRegistry(value), "REGISTRY_SCHEMA"); });
test("04 registry rejects extra keys", () => { const value = structuredClone(loadWriterContextRegistry()); value.extra = true; expectCode(() => validateWriterContextRegistry(value), "UNKNOWN_KEY"); });
test("05 safe path accepts nested forward slashes", () => assert.equal(validateRepoRelativePath("data/a/b.json"), "data/a/b.json"));
test("06 safe path rejects traversal", () => expectCode(() => validateRepoRelativePath("data/../secret"), "UNSAFE_PATH"));
test("07 safe path rejects absolute POSIX paths", () => expectCode(() => validateRepoRelativePath("/data/file"), "UNSAFE_PATH"));
test("08 safe path rejects drive paths", () => expectCode(() => validateRepoRelativePath("C:/data/file"), "UNSAFE_PATH"));
test("09 safe path rejects backslashes", () => expectCode(() => validateRepoRelativePath("data\\file"), "UNSAFE_PATH"));
test("10 safe path rejects empty segments", () => expectCode(() => validateRepoRelativePath("data//file"), "UNSAFE_PATH"));
test("11 safe path rejects dot segments", () => expectCode(() => validateRepoRelativePath("data/./file"), "UNSAFE_PATH"));
test("12 safe path rejects the repository root marker", () => expectCode(() => validateRepoRelativePath("."), "UNSAFE_PATH"));

test("13 baseline has a canonical identity", () => { const baseline = createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: { z: 1, a: 2 }, capturedAt: NOW.toISOString() }); assert.equal(baseline.contentIdentity, sha256Canonical(baselineBusinessView(baseline))); });
test("14 baseline key order does not affect identity", () => { const common = { edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", capturedAt: NOW.toISOString() }; assert.equal(createBaseline({ ...common, payload: { a: 1, z: 2 } }).contentIdentity, createBaseline({ ...common, payload: { z: 2, a: 1 } }).contentIdentity); });
test("15 capturedAt is audit-only", () => { const common = { edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: { value: 1 } }; assert.equal(createBaseline({ ...common, capturedAt: NOW.toISOString() }).contentIdentity, createBaseline({ ...common, capturedAt: "2026-07-30T13:00:00.000Z" }).contentIdentity); });
test("16 warnings are audit-only", () => { const common = { edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: { value: 1 }, capturedAt: NOW.toISOString() }; assert.equal(createBaseline({ ...common }).contentIdentity, createBaseline({ ...common, warnings: ["warning"] }).contentIdentity); });
test("17 payload changes baseline identity", () => { const common = { edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", capturedAt: NOW.toISOString() }; assert.notEqual(createBaseline({ ...common, payload: { value: 1 } }).contentIdentity, createBaseline({ ...common, payload: { value: 2 } }).contentIdentity); });
test("18 target changes baseline identity", () => { const payload = { schemaVersion: 1 }; const first = createBaseline({ edition: "weekly", asOf: AS_OF, targetPath: "content/weekly-reports/weekly-2026-W29.json", targetSchemaVersion: "weekly-report-v1", payload, capturedAt: NOW.toISOString() }); const second = createBaseline({ edition: "weekly", asOf: AS_OF, targetPath: "content/weekly-reports/weekly-2026-W30.json", targetSchemaVersion: "weekly-report-v1", payload, capturedAt: NOW.toISOString() }); assert.notEqual(first.contentIdentity, second.contentIdentity); });
test("19 daily target allowlist is exact", () => expectCode(() => createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/other.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: NOW.toISOString() }), "TARGET_ALLOWLIST"));
test("20 weekly target allowlist is exact", () => expectCode(() => createBaseline({ edition: "weekly", asOf: AS_OF, targetPath: "content/weekly-reports/latest.json", targetSchemaVersion: "weekly-report-v1", payload: { schemaVersion: 1 }, capturedAt: NOW.toISOString() }), "TARGET_ALLOWLIST"));
test("21 weekly payload requires schemaVersion 1", () => expectCode(() => createBaseline({ edition: "weekly", asOf: AS_OF, targetPath: "content/weekly-reports/weekly-2026-W29.json", targetSchemaVersion: "weekly-report-v1", payload: {}, capturedAt: NOW.toISOString() }), "TARGET_SCHEMA"));
test("22 baseline rejects noncanonical timestamp", () => expectCode(() => createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: "2026-07-30T12:00:00Z" }), "INVALID_TIMESTAMP"));
test("23 baseline rejects impossible dates", () => expectCode(() => createBaseline({ edition: "daily", asOf: "2026-02-30", targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: NOW.toISOString() }), "INVALID_DATE"));
test("24 baseline rejects a forged identity", () => { const value = createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: NOW.toISOString() }); value.contentIdentity = HASH; expectCode(() => validateBaseline(value), "BASELINE_ID"); });
test("25 baseline rejects a forged full integrity hash", () => { const value = createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: NOW.toISOString() }); value.integrity.sha256 = HASH; expectCode(() => validateBaseline(value), "BASELINE_INTEGRITY"); });
test("26 baseline stable view excludes audit fields", () => { const first = createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: NOW.toISOString() }); const second = createBaseline({ edition: "daily", asOf: AS_OF, targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", payload: {}, capturedAt: "2026-07-30T13:00:00.000Z", warnings: ["later"] }); assert.deepEqual(baselineStableArtifactView(first), baselineStableArtifactView(second)); });

test("27 prepare writes baseline, context, index and latest", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); for (const relative of [summary.baselinePath, summary.contextPath, "data/writer-contexts/index.json", "content/writer-contexts/daily-latest.json"]) assert.equal(fs.existsSync(path.join(fixture.root, ...relative.split("/"))), true); } finally { clean(fixture); } });
test("28 prepared baseline validates", () => { const fixture = makeRoot(); try { const value = loadPrepared(fixture, prepare(fixture)).baseline; assert.equal(validateBaseline(value).schemaVersion, "baseline-content-v1"); } finally { clean(fixture); } });
test("29 prepared context validates all immutable references", () => { const fixture = makeRoot(); try { const value = loadPrepared(fixture, prepare(fixture)).context; assert.equal(validateWriterContext(value, loadWriterContextRegistry(fixture.root), { root: fixture.root }).schemaVersion, "writer-context-v1"); } finally { clean(fixture); } });
test("30 context ID is its business hash", () => { const fixture = makeRoot(); try { const value = loadPrepared(fixture, prepare(fixture)).context; assert.equal(value.contextId, computeContextId(value)); } finally { clean(fixture); } });
test("31 generatedAt is audit-only", () => { const fixture = makeRoot(); try { const first = prepare(fixture); const second = prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: new Date("2026-07-30T13:00:00.000Z") }); assert.equal(first.contextId, second.contextId); } finally { clean(fixture); } });
test("32 repeated prepare reuses first immutable bytes", () => { const fixture = makeRoot(); try { const first = prepare(fixture); const before = fs.readFileSync(path.join(fixture.root, ...first.contextPath.split("/"))); const second = prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, write: true, root: fixture.root, now: new Date("2026-07-30T13:00:00.000Z") }); assert(second.reused.includes(first.contextPath)); assert.deepEqual(fs.readFileSync(path.join(fixture.root, ...first.contextPath.split("/"))), before); } finally { clean(fixture); } });
test("33 dry-run performs zero repository writes", () => { const fixture = makeRoot(); try { const before = filesBelow(fixture.root); const summary = prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }); assert(summary.wouldWrite.length >= 4); assert.deepEqual(filesBelow(fixture.root), before); } finally { clean(fixture); } });
test("34 prepare requires exactly one mode", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, root: fixture.root }), "CLI_ARGUMENT"); } finally { clean(fixture); } });
test("35 prepare rejects two modes", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, write: true, root: fixture.root }), "CLI_ARGUMENT"); } finally { clean(fixture); } });
test("36 prepare requires an explicit packet", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root }), "INVALID_TYPE"); } finally { clean(fixture); } });
test("37 prepare requires an explicit research bundle", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root }), "INVALID_TYPE"); } finally { clean(fixture); } });
test("38 prepare never consults latest", () => { const fixture = makeRoot(); try { write(fixture.root, "content/writer-contexts/daily-latest.json", Buffer.from("not json")); const summary = prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }); assert.equal(summary.contextId.length, 64); } finally { clean(fixture); } });
test("39 packet path must use immutable storage", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: "content/writer-packets/daily-latest.json", researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root }), "REFERENCE_PATH"); } finally { clean(fixture); } });
test("40 research path must use immutable storage", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: "content/research-bundles/daily-latest.json", baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root }), "REFERENCE_PATH"); } finally { clean(fixture); } });
test("41 corrupt packet gzip fails closed", () => { const fixture = makeRoot(); try { fs.writeFileSync(path.join(fixture.root, ...fixture.packetPath.split("/")), "bad"); expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root }), "ARTIFACT_CORRUPT"); } finally { clean(fixture); } });
test("42 corrupt bundle gzip fails closed", () => { const fixture = makeRoot(); try { fs.writeFileSync(path.join(fixture.root, ...fixture.bundlePath.split("/")), "bad"); expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root }), "ARTIFACT_CORRUPT"); } finally { clean(fixture); } });
test("43 packet edition mismatch fails", () => { const fixture = makeRoot(); try { const packet = writerPacket("weekly", AS_OF); const bytes = artifact(packet); const mismatch = `data/writer-jobs/packets/2026/07/${packet.writerPacketId}.json.gz`; write(fixture.root, mismatch, bytes); expectCode(() => prepareWriterContext({ edition: "daily", asOf: AS_OF, writerPacketPath: mismatch, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }), "REFERENCE_COMPATIBILITY"); } finally { clean(fixture); } });
test("44 packet asOf mismatch fails", () => { const fixture = makeRoot(); try { const packet = writerPacket("daily", "2026-07-29"); const mismatch = `data/writer-jobs/packets/2026/07/${packet.writerPacketId}.json.gz`; write(fixture.root, mismatch, artifact(packet)); expectCode(() => prepareWriterContext({ edition: "daily", asOf: AS_OF, writerPacketPath: mismatch, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }), "REFERENCE_COMPATIBILITY"); } finally { clean(fixture); } });
test("45 bundle edition mismatch fails", () => { const fixture = makeRoot(); try { const bundle = researchBundle("weekly", AS_OF); const mismatch = `data/research-bundles/bundles/2026/07/${bundle.bundleId}.json.gz`; write(fixture.root, mismatch, artifact(bundle)); expectCode(() => prepareWriterContext({ edition: "daily", asOf: AS_OF, writerPacketPath: fixture.packetPath, researchBundlePath: mismatch, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }), "REFERENCE_COMPATIBILITY"); } finally { clean(fixture); } });
test("46 bundle asOf mismatch fails", () => { const fixture = makeRoot(); try { const bundle = researchBundle("daily", "2026-07-29"); const mismatch = `data/research-bundles/bundles/2026/07/${bundle.bundleId}.json.gz`; write(fixture.root, mismatch, artifact(bundle)); expectCode(() => prepareWriterContext({ edition: "daily", asOf: AS_OF, writerPacketPath: fixture.packetPath, researchBundlePath: mismatch, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }), "REFERENCE_COMPATIBILITY"); } finally { clean(fixture); } });
test("47 changed packet bytes break context SHA", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; fs.appendFileSync(path.join(fixture.root, ...fixture.packetPath.split("/")), "x"); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "ARTIFACT_SHA"); } finally { clean(fixture); } });
test("48 changed bundle bytes break context SHA", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; fs.appendFileSync(path.join(fixture.root, ...fixture.bundlePath.split("/")), "x"); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "ARTIFACT_SHA"); } finally { clean(fixture); } });
test("49 changed baseline bytes break context SHA", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; fs.appendFileSync(path.join(fixture.root, ...summary.baselinePath.split("/")), "x"); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "ARTIFACT_SHA"); } finally { clean(fixture); } });
test("50 changed prompt bytes break context SHA", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; fs.appendFileSync(path.join(fixture.root, "prompts", "luna-daily-brief.md"), "changed"); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "ARTIFACT_SHA"); } finally { clean(fixture); } });
test("51 changed validator bytes break context SHA", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; fs.appendFileSync(path.join(fixture.root, "scripts", "validate-brief.mjs"), "changed"); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "ARTIFACT_SHA"); } finally { clean(fixture); } });
test("52 internal packet ID mismatch fails", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; context.quantitativeWriterPacket.writerPacketId = HASH; resealContext(context); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "REFERENCE_ID"); } finally { clean(fixture); } });
test("53 internal bundle ID mismatch fails", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; context.qualitativeResearchBundle.bundleId = HASH; resealContext(context); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "REFERENCE_ID"); } finally { clean(fixture); } });
test("54 internal baseline ID mismatch fails", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; context.baselineContent.contentIdentity = HASH; resealContext(context); expectCode(() => validateWriterContext(context, loadWriterContextRegistry(fixture.root), { root: fixture.root }), "REFERENCE_ID"); } finally { clean(fixture); } });
test("55 context stable view excludes audit fields", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const first = loadPrepared(fixture, summary).context; const second = structuredClone(first); second.generatedAt = "2026-07-30T13:00:00.000Z"; second.warnings = ["later"]; resealContext(second); assert.deepEqual(contextStableArtifactView(first), contextStableArtifactView(second)); } finally { clean(fixture); } });
test("56 immutable baseline conflict fails closed", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const file = path.join(fixture.root, ...summary.baselinePath.split("/")); const baseline = readJsonOrGzip(file); baseline.payload = { changed: true }; resealBaseline(baseline); fs.writeFileSync(file, artifact(baseline)); expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, now: NOW }), "IMMUTABLE_CONFLICT"); } finally { clean(fixture); } });
test("57 rollback removes all new immutable and derived files", () => { const fixture = makeRoot(); try { const before = filesBelow(fixture.root); expectCode(() => prepare(fixture, { failAt: "index" }), "STORAGE_WRITE"); assert.deepEqual(filesBelow(fixture.root), before); } finally { clean(fixture); } });
test("58 rebuild reproduces a deleted index", () => { const fixture = makeRoot(); try { prepare(fixture); const index = path.join(fixture.root, "data", "writer-contexts", "index.json"); const expected = fs.readFileSync(index); fs.unlinkSync(index); const result = rebuildWriterContextDerivedViews({ root: fixture.root }); assert(result.written.includes("data/writer-contexts/index.json")); assert.deepEqual(fs.readFileSync(index), expected); } finally { clean(fixture); } });
test("59 rebuild is offline and idempotent", () => { const fixture = makeRoot(); try { prepare(fixture); const result = rebuildWriterContextDerivedViews({ root: fixture.root }); assert(result.reused.includes("data/writer-contexts/index.json")); assert(result.reused.includes("content/writer-contexts/daily-latest.json")); } finally { clean(fixture); } });
test("60 weekly prepare writes weekly latest", () => { const fixture = makeRoot({ edition: "weekly", asOf: AS_OF }); try { const summary = prepare(fixture); assert.equal(summary.edition, "weekly"); assert.equal(fs.existsSync(path.join(fixture.root, "content", "writer-contexts", "weekly-latest.json")), true); } finally { clean(fixture); } });
test("61 external summary output is supported", () => { const fixture = makeRoot(); const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), "writer-context-output-")); try { const output = path.join(outputRoot, "summary.json"); prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, output, now: NOW }); assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).dryRun, true); } finally { clean(fixture); fs.rmSync(outputRoot, { recursive: true, force: true }); } });
test("62 summary output inside repository is rejected", () => { const fixture = makeRoot(); try { expectCode(() => prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, dryRun: true, root: fixture.root, output: path.join(fixture.root, "summary.json"), now: NOW }), "CLI_ARGUMENT"); } finally { clean(fixture); } });
test("63 CLI validates the registry", () => { const result = spawnSync(process.execPath, [moduleFile, "validate-registry"], { cwd: repositoryRoot, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).valid, true); });
test("64 CLI prepare requires explicit immutable arguments", () => { const result = spawnSync(process.execPath, [moduleFile, "prepare", "--edition", "daily", "--as-of", AS_OF, "--dry-run"], { cwd: repositoryRoot, encoding: "utf8" }); assert.equal(result.status, 1); assert.match(result.stderr, /CLI_ARGUMENT/); });
test("65 CLI rejects unknown options", () => { const result = spawnSync(process.execPath, [moduleFile, "validate-registry", "--unknown"], { cwd: repositoryRoot, encoding: "utf8" }); assert.equal(result.status, 1); assert.match(result.stderr, /CLI_ARGUMENT/); });
test("66 deterministic gzip references exact bytes", () => { const fixture = makeRoot(); try { const summary = prepare(fixture); const context = loadPrepared(fixture, summary).context; assert.equal(context.quantitativeWriterPacket.artifactSha256, hashBytes(fs.readFileSync(path.join(fixture.root, ...fixture.packetPath.split("/"))))); } finally { clean(fixture); } });
