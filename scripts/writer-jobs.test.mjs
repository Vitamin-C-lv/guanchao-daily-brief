import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  canonicalJson,
  computeBundleId,
  computeDocumentId,
  computeEventId,
  computeObservationId,
  computeSourceRunId,
  deriveEvidenceState,
  sha256Canonical,
  validateBundle
} from "./research-contract.mjs";
import { computeContextId, prepareWriterContext, readJsonOrGzip } from "./writer-context.mjs";
import {
  apply,
  createResultTemplate,
  createWriterJobPaths,
  exportWriterJob,
  hash,
  makeRequest,
  prepare,
  rebuild,
  requestVersion,
  resultVersion,
  root,
  sealWriterResult,
  shanghaiDate,
  validateLegacyRequestV1,
  validateRequest,
  validateResult,
  writeResultTemplate
} from "./writer-jobs.mjs";

const registry = JSON.parse(fs.readFileSync(path.join(root, "data/research-bundles/contract.json"), "utf8"));
const AS_OF = { daily: "2026-07-24", weekly: "2026-07-17" };
const NOW = new Date("2026-07-30T12:00:00.000Z");
const moduleFile = path.join(root, "scripts", "writer-jobs.mjs");
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");

function copy(repo, relativePath) {
  const destination = path.join(repo, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, ...relativePath.split("/")), destination);
}

function write(repo, relativePath, bytes) {
  const destination = path.join(repo, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return destination;
}

function seal(value, idKey, compute) {
  value[idKey] = compute(value);
  value.integrity = { businessSha256: value[idKey], sha256: "" };
  value.integrity.sha256 = sha256Canonical({ ...value, integrity: { businessSha256: value[idKey] } });
  return value;
}

function makeSourceRun(asOf, sourceClass = "official-primary") {
  return seal({
    sourceRunId: "",
    sourceId: "writer-e2e-source",
    provider: "Writer E2E Provider",
    sourceClass,
    adapterId: "writer-e2e-adapter",
    adapterVersion: "v1",
    requestedAt: `${asOf}T10:00:00.000Z`,
    asOf: `${asOf}T09:00:00.000Z`,
    status: "ready",
    sourceUrl: "https://example.com/writer-e2e",
    marketScopes: ["US"],
    topics: ["macro"],
    coverage: { itemCount: 1, note: "writer e2e fixture" },
    snapshotPolicy: "stored",
    rawSnapshotId: "a".repeat(64),
    warnings: [],
    integrity: { businessSha256: "", sha256: "" }
  }, "sourceRunId", computeSourceRunId);
}

function makeDocument(run, asOf) {
  return seal({
    documentId: "",
    sourceRunId: run.sourceRunId,
    sourceId: run.sourceId,
    publisherId: "writer-e2e-publisher",
    publisher: "Writer E2E Publisher",
    title: "Writer E2E frozen document title",
    canonicalUrl: "https://example.com/writer-e2e/report",
    publishedDate: asOf,
    publishedAt: `${asOf}T08:00:00.000Z`,
    accessedAt: `${asOf}T10:00:00.000Z`,
    language: "en",
    contentType: "html",
    contentHashBasis: "response-entity",
    contentHashVersion: "v1",
    contentSha256: run.rawSnapshotId,
    rawSnapshotId: run.rawSnapshotId,
    marketScopes: ["US"],
    topics: ["macro"],
    warnings: [],
    integrity: { businessSha256: "", sha256: "" }
  }, "documentId", computeDocumentId);
}

function makeBundle(edition, asOf, evidenceState = "confirmed", withObservations = true) {
  const sourceClass = evidenceState === "unverified" ? "community-signal" : "official-primary";
  const run = makeSourceRun(asOf, sourceClass);
  const document = makeDocument(run, asOf);
  const observation = {
    observationId: "",
    kind: "hard-fact",
    subject: "writer e2e subject",
    statement: "The frozen source reports a writer E2E observation.",
    occurredAt: `${asOf}T08:00:00.000Z`,
    asOf,
    marketScopes: ["US"],
    topics: ["macro"],
    entities: ["writer-e2e"],
    evidenceState: "single-source",
    basis: [{ documentId: document.documentId, relation: "supports", excerpt: "Frozen source statement.", locator: "paragraph-1" }],
    warnings: []
  };
  if (evidenceState === "conflicting") observation.basis.push({ documentId: document.documentId, relation: "contradicts", excerpt: "Frozen counter statement.", locator: "paragraph-2" });
  observation.evidenceState = deriveEvidenceState(observation, { documents: [document], sourceRuns: [run] });
  observation.observationId = computeObservationId(observation);
  const event = { eventId: "", eventType: "macro-release", title: "Writer E2E event", occurredAt: observation.occurredAt, marketScopes: ["US"], topics: ["macro"], observationIds: [observation.observationId] };
  event.eventId = computeEventId(event);
  const documents = withObservations ? [document] : [];
  const observations = withObservations ? [observation] : [];
  const events = withObservations ? [event] : [];
  const markets = ["A_SHARE", "HK", "US", "FED"].map((market) => {
    const documentCount = documents.filter((item) => item.marketScopes.includes(market)).length;
    const observationCount = observations.filter((item) => item.marketScopes.includes(market)).length;
    return { market, status: documentCount || observationCount ? "ready" : "partial", documentCount, observationCount, reasons: documentCount || observationCount ? [] : ["fixture coverage gap"] };
  });
  const topics = withObservations ? [{ topic: "macro", status: "ready", documentCount: 1, observationCount: 1, reasons: [] }] : [];
  const bundle = seal({
    schemaVersion: "research-bundle-v1",
    edition,
    asOf,
    generatedAt: `${asOf}T12:00:00.000Z`,
    window: { start: edition === "daily" ? asOf : "2026-07-11", end: asOf, timezone: "Asia/Shanghai" },
    sourcePolicyVersion: "research-source-policy-v1",
    sourceRuns: [run],
    documents,
    observations,
    events,
    duplicateClusters: [],
    coverage: { markets, topics, totals: { sourceRuns: 1, documents: documents.length, observations: observations.length, events: events.length, duplicateClusters: 0, conflictingObservations: observations.filter((item) => item.evidenceState === "conflicting").length } },
    warnings: [],
    bundleId: "",
    integrity: { businessSha256: "", sha256: "" }
  }, "bundleId", computeBundleId);
  validateBundle(bundle, registry);
  return bundle;
}

function packetIdentity(value) {
  if (Array.isArray(value)) return value.map(packetIdentity);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !new Set(["requestedAt", "completedAt", "generatedAt", "rawSha256", "integrity", "businessIntegrity", "writerPacketId", "runId"]).has(key)).map(([key, item]) => [key, packetIdentity(item)]));
  return value;
}

function makePacket(edition, asOf, status = "ready") {
  const unavailable = ["unavailable", "rate_limited", "schema_changed"].includes(status);
  const packet = {
    schemaVersion: 1,
    edition,
    generatedAt: `${asOf}T12:00:00.000Z`,
    marketDates: { aShare: asOf, us: asOf },
    marketSummary: { status: "partial" },
    providerHealth: { status: status === "ready" ? "ready" : "partial" },
    sourceIndex: { "us-treasury-nominal-xml": { sourceId: "us-treasury-nominal-xml", status } },
    facts: [{ factId: `treasury-nominal2y-${asOf}-${status}`, label: "US Treasury 2Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status, unit: "percent", value: unavailable ? null : 4.26, changeUnit: "bp", change1d: unavailable ? null : -1, change5d: unavailable ? null : 2, change20d: unavailable ? null : 3, asOf: unavailable ? null : asOf, releasedAt: unavailable ? null : asOf }],
    treasuryFactor: { status: "ready", spread2s10sBp: 35, changesBp: {}, nominalSource: { sourceId: "us-treasury-nominal-xml", asOf }, realSource: { sourceId: "us-treasury-real-xml", asOf } },
    writerPacketId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  const business = sha256Canonical(packetIdentity(packet));
  packet.writerPacketId = business;
  packet.integrity = { businessSha256: business, sha256: business };
  return packet;
}

function gz(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function setup({ edition = "daily", status = "ready", evidenceState = "confirmed", withObservations = true } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-writer-jobs-v2-"));
  for (const relative of [
    "data/writer-contexts/contract.json", "data/research-bundles/contract.json", "data/writer-jobs/contract.json", "data/writer-jobs/index.json",
    "content/writer-jobs/daily-pending.json", "content/writer-jobs/weekly-pending.json", "content/daily-brief.json",
    "content/weekly-reports/weekly-2026-W29.json", "content/weekly-reports/weekly-2026-W31.json", "content/weekly-reports/index.json", "public/update-notices.json",
    "prompts/luna-daily-brief.md", "prompts/luna-weekly-brief.md", "scripts/validate-brief.mjs", "scripts/validate-weekly.mjs"
  ]) copy(repo, relative);
  if (edition === "weekly") {
    const indexPath = path.join(repo, "content/weekly-reports/index.json");
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    const baselineEntry = index.reports.find((item) => item.id === "weekly-2026-W29");
    index.latestReportId = baselineEntry.id;
    index.reports = [baselineEntry];
    fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
    const noticesPath = path.join(repo, "public/update-notices.json");
    const notices = JSON.parse(fs.readFileSync(noticesPath, "utf8"));
    notices.weekly = {
      ...notices.weekly,
      noticeId: `${baselineEntry.id}-r${baselineEntry.revision}`,
      publishedAt: baselineEntry.publishedAt,
      href: `/weekly/${baselineEntry.id}/`,
    };
    fs.writeFileSync(noticesPath, `${JSON.stringify(notices, null, 2)}\n`);
  }
  const asOf = AS_OF[edition];
  const packet = makePacket(edition, asOf, status);
  const bundle = makeBundle(edition, asOf, evidenceState, withObservations);
  const packetPath = `data/writer-jobs/packets/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${packet.writerPacketId}.json.gz`;
  const bundlePath = `data/research-bundles/bundles/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${bundle.bundleId}.json.gz`;
  write(repo, packetPath, gz(packet));
  write(repo, bundlePath, gz(bundle));
  const baselineSource = edition === "daily" ? "content/daily-brief.json" : "content/weekly-reports/weekly-2026-W29.json";
  const contextSummary = prepareWriterContext({ edition, asOf, writerPacketPath: packetPath, researchBundlePath: bundlePath, baselineSource, write: true, root: repo, now: NOW });
  const prepared = prepare({ edition, contextPath: contextSummary.contextPath, write: true, rootDir: repo, createdAt: NOW.toISOString() });
  return { repo, edition, asOf, packet, bundle, packetPath, bundlePath, baselineSource, contextSummary, request: prepared.request, prepareSummary: prepared.summary };
}

function cleanup(fixture) {
  fs.rmSync(fixture.repo, { recursive: true, force: true });
}

function baseline(fixture) {
  return readJsonOrGzip(path.join(fixture.repo, ...fixture.contextSummary.baselinePath.split("/")));
}

function result(fixture, options = {}) {
  const payload = structuredClone(baseline(fixture).payload);
  const fact = fixture.packet.facts[0];
  const renderedValue = fact.value === null ? null : `${fact.value}%`;
  let claimText = renderedValue;
  if (fact.status === "partial") claimText = `部分数据 ${renderedValue}`;
  if (fact.status === "stale") claimText = `截至数据延迟 ${renderedValue}`;
  if (["unavailable", "rate_limited", "schema_changed"].includes(fact.status)) claimText = "数据不可用";
  const claimPath = fixture.edition === "daily" ? "$.payload.meta.subtitle" : "$.payload.report.subtitle";
  if (fixture.edition === "daily") payload.meta.subtitle = claimText;
  else {
    payload.report.subtitle = claimText;
    payload.report.revision = 2;
    payload.report.generatedAt = "2026-07-17T21:00:00+08:00";
  }
  const value = {
    schemaVersion: resultVersion,
    jobId: fixture.request.jobId,
    requestId: fixture.request.requestId,
    contextId: fixture.request.context.contextId,
    generatedAt: "2026-07-30T12:30:00.000Z",
    writerEngine: "deterministic-test-writer",
    writerVersion: "v1",
    payload,
    claimBindings: { quantitative: [{ claimPath, claimText, factId: fact.factId, renderedValue }], qualitative: [], sourceMetadata: [] },
    warnings: fixture.bundle.observations.length ? [] : ["no-new-qualitative-observations"],
    resultId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  if (options.unchanged) {
    value.payload = structuredClone(baseline(fixture).payload);
    value.claimBindings.quantitative = [];
  }
  return sealWriterResult(Object.assign(value, options.override ?? {}));
}

function resealRequest(request) {
  const { requestId, jobId, createdAt, integrity, ...business } = request;
  const id = hash(business);
  request.requestId = id;
  request.jobId = id;
  request.integrity = { businessSha256: id, sha256: "" };
  const { integrity: ignored, ...body } = request;
  request.integrity.sha256 = hash({ ...body, integrity: { businessSha256: id } });
  return request;
}

function resealContext(context) {
  context.contextId = computeContextId(context);
  context.integrity.businessSha256 = context.contextId;
  context.integrity.sha256 = sha256Canonical({ ...context, integrity: { businessSha256: context.contextId } });
  return context;
}

function codeOf(action) {
  try { action(); return null; } catch (cause) { return cause.errorCode ?? cause.message; }
}

function snapshot(repo, prefixes = ["content", "data/prediction-ledger", "data/sector-details", "public/data/prediction-history"]) {
  const entries = [];
  const visit = (target) => {
    if (!fs.existsSync(target)) return;
    if (fs.statSync(target).isFile()) {
      entries.push({ path: relative(repo, target), sha256: hashBytes(fs.readFileSync(target)) });
      return;
    }
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const file = path.join(target, entry.name);
      if (entry.isDirectory()) visit(file);
      else entries.push({ path: relative(repo, file), sha256: hashBytes(fs.readFileSync(file)) });
    }
  };
  for (const prefix of prefixes) visit(path.join(repo, ...prefix.split("/")));
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function relative(repo, file) {
  return path.relative(repo, file).split(path.sep).join("/");
}

function qualitativeResult(fixture, { text, state = fixture.bundle.observations[0].evidenceState, documentIds = [fixture.bundle.documents[0].documentId], observationIds = [fixture.bundle.observations[0].observationId] } = {}) {
  const value = result(fixture, { unchanged: true });
  value.payload.meta.curationNote = text ?? fixture.bundle.observations[0].statement;
  value.claimBindings.qualitative = [{ claimPath: "$.payload.meta.curationNote", claimText: value.payload.meta.curationNote, observationIds: [...observationIds].sort(), documentIds: [...documentIds].sort(), evidenceState: state }];
  return sealWriterResult(value);
}

test("01 Windows file URL root preserves drive, spaces and Chinese", () => { const source = path.join(root, "中文 space", "writer jobs.mjs"); assert.equal(fileURLToPath(pathToFileURL(source)), source); assert.match(root, /^[A-Za-z]:\\/); assert.ok(!root.includes("%")); });
test("02 current request and result versions are v2", () => { assert.equal(requestVersion, "writer-request-v2"); assert.equal(resultVersion, "writer-result-v2"); });
test("03 prepare creates only a context-bound v2 request", () => { const fixture = setup(); try { assert.equal(fixture.request.schemaVersion, requestVersion); assert.equal(fixture.request.context.contextId, readJsonOrGzip(path.join(fixture.repo, ...fixture.contextSummary.contextPath.split("/"))).contextId); assert.equal(Object.hasOwn(fixture.request, "writerPacketPath"), false); } finally { cleanup(fixture); } });
test("04 request identity binds context ID and SHA", () => { const fixture = setup(); try { const changedId = structuredClone(fixture.request); changedId.context.contextId = "b".repeat(64); resealRequest(changedId); assert.notEqual(changedId.requestId, fixture.request.requestId); const changedSha = structuredClone(fixture.request); changedSha.context.artifactSha256 = "c".repeat(64); resealRequest(changedSha); assert.notEqual(changedSha.requestId, fixture.request.requestId); } finally { cleanup(fixture); } });
test("05 request identity binds prompt, validator and target schema", () => { const fixture = setup(); try { for (const field of ["writerPromptSha256", "targetValidatorSha256", "targetSchemaVersion"]) { const changed = structuredClone(fixture.request); changed[field] = field.endsWith("Sha256") ? "d".repeat(64) : "different-schema"; resealRequest(changed); assert.notEqual(changed.requestId, fixture.request.requestId); } } finally { cleanup(fixture); } });
test("06 createdAt is audit-only and repeated prepare is byte no-op", () => { const fixture = setup(); try { const file = createWriterJobPaths(fixture.repo).request(fixture.request.jobId, fixture.asOf); const before = fs.readFileSync(file); const rerun = prepare({ edition: fixture.edition, contextPath: fixture.contextSummary.contextPath, write: true, rootDir: fixture.repo, createdAt: "2026-07-31T12:00:00.000Z" }); assert.equal(rerun.request.requestId, fixture.request.requestId); assert.equal(rerun.summary.noOp, true); assert.deepEqual(fs.readFileSync(file), before); } finally { cleanup(fixture); } });
test("07 prepare dry-run leaves the repository unchanged", () => { const fixture = setup(); try { const before = snapshot(fixture.repo, ["data/writer-jobs", "content/writer-jobs"]); const rerun = prepare({ edition: fixture.edition, contextPath: fixture.contextSummary.contextPath, dryRun: true, rootDir: fixture.repo, createdAt: "2026-07-31T12:00:00.000Z" }); assert.equal(rerun.summary.noOp, true); assert.deepEqual(snapshot(fixture.repo, ["data/writer-jobs", "content/writer-jobs"]), before); } finally { cleanup(fixture); } });
test("08 prepare requires exactly one mode", () => { const fixture = setup(); try { assert.equal(codeOf(() => prepare({ edition: "daily", contextPath: fixture.contextSummary.contextPath, rootDir: fixture.repo })), "PREPARE_MODE"); } finally { cleanup(fixture); } });
test("09 prepare rejects dual modes", () => { const fixture = setup(); try { assert.equal(codeOf(() => prepare({ edition: "daily", contextPath: fixture.contextSummary.contextPath, dryRun: true, write: true, rootDir: fixture.repo })), "PREPARE_MODE"); } finally { cleanup(fixture); } });
test("10 prepare rejects missing explicit context", () => assert.equal(codeOf(() => prepare({ edition: "daily", packet: {}, dryRun: true })), "PREPARE_ARGUMENT"));
test("11 prepare never reads latest context", () => { const fixture = setup(); try { write(fixture.repo, "content/writer-contexts/daily-latest.json", "malicious"); assert.equal(prepare({ edition: "daily", contextPath: fixture.contextSummary.contextPath, dryRun: true, rootDir: fixture.repo }).request.context.contextId, fixture.request.context.contextId); } finally { cleanup(fixture); } });
test("12 request context byte SHA is verified", () => { const fixture = setup(); try { const changed = structuredClone(fixture.request); changed.context.artifactSha256 = "b".repeat(64); resealRequest(changed); assert.equal(codeOf(() => validateRequest(changed, { rootDir: fixture.repo })), "REQUEST_CONTEXT_SHA"); } finally { cleanup(fixture); } });
test("13 request context internal ID is verified", () => { const fixture = setup(); try { const changed = structuredClone(fixture.request); changed.context.contextId = "b".repeat(64); resealRequest(changed); assert.equal(codeOf(() => validateRequest(changed, { rootDir: fixture.repo })), "REQUEST_CONTEXT_ID"); } finally { cleanup(fixture); } });
test("14 request prompt hash must equal context", () => { const fixture = setup(); try { const changed = structuredClone(fixture.request); changed.writerPromptSha256 = "b".repeat(64); resealRequest(changed); assert.equal(codeOf(() => validateRequest(changed, { rootDir: fixture.repo })), "PROMPT_SHA_MISMATCH"); } finally { cleanup(fixture); } });
test("15 request validator hash must equal context", () => { const fixture = setup(); try { const changed = structuredClone(fixture.request); changed.targetValidatorSha256 = "b".repeat(64); resealRequest(changed); assert.equal(codeOf(() => validateRequest(changed, { rootDir: fixture.repo })), "TARGET_VALIDATOR_SHA_MISMATCH"); } finally { cleanup(fixture); } });
test("16 request target schema must equal context", () => { const fixture = setup(); try { const changed = structuredClone(fixture.request); changed.targetSchemaVersion = "daily-brief-v999"; resealRequest(changed); assert.equal(codeOf(() => validateRequest(changed, { rootDir: fixture.repo })), "TARGET_SCHEMA_VERSION_MISMATCH"); } finally { cleanup(fixture); } });
test("17 request evidence indexes are frozen", () => { const fixture = setup(); try { const changed = structuredClone(fixture.request); changed.allowedFactIds = ["unknown-fact"]; resealRequest(changed); assert.equal(codeOf(() => validateRequest(changed, { rootDir: fixture.repo })), "REQUEST_EVIDENCE_INDEX"); } finally { cleanup(fixture); } });
test("18 v1 validator remains fixture-only", () => { assert.equal(validateLegacyRequestV1({ schemaVersion: "writer-request-v1", jobId: "a".repeat(64), writerPacketPath: "fixture" }).schemaVersion, "writer-request-v1"); assert.equal(codeOf(() => validateRequest({ schemaVersion: "writer-request-v1" })), "REQUEST_SCHEMA"); });
test("19 prepare request/index/pending is transactional", () => { const fixture = setup(); try { const source = path.join(fixture.repo, ...fixture.baselineSource.split("/")); const payload = JSON.parse(fs.readFileSync(source, "utf8")); payload.meta.subtitle = "second immutable baseline"; fs.writeFileSync(source, `${JSON.stringify(payload)}\n`); const secondContext = prepareWriterContext({ edition: fixture.edition, asOf: fixture.asOf, writerPacketPath: fixture.packetPath, researchBundlePath: fixture.bundlePath, baselineSource: fixture.baselineSource, write: true, root: fixture.repo, now: new Date("2026-07-31T12:00:00.000Z") }); const before = snapshot(fixture.repo, ["data/writer-jobs", "content/writer-jobs"]); assert.throws(() => prepare({ edition: fixture.edition, contextPath: secondContext.contextPath, write: true, rootDir: fixture.repo, createdAt: "2026-07-31T12:30:00.000Z", failAt: "writer-index" }), /INJECTED_writer-index/); assert.deepEqual(snapshot(fixture.repo, ["data/writer-jobs", "content/writer-jobs"]), before); } finally { cleanup(fixture); } });
test("20 Shanghai date boundary is exact", () => { assert.equal(shanghaiDate(new Date("2026-07-29T16:30:00.000Z")), "2026-07-30"); assert.equal(shanghaiDate(new Date("2026-07-29T15:59:59.000Z")), "2026-07-29"); });

test("21 valid quantitative result passes", () => { const fixture = setup(); try { assert.equal(validateResult(fixture.repo, fixture.request, result(fixture)).schemaVersion, resultVersion); } finally { cleanup(fixture); } });
test("22 unchanged baseline result is allowed", () => { const fixture = setup(); try { assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, result(fixture, { unchanged: true }))); } finally { cleanup(fixture); } });
test("23 result schema is strict", () => { const fixture = setup(); try { const value = result(fixture); value.schemaVersion = "writer-result-v1"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, value)), "RESULT_SCHEMA"); } finally { cleanup(fixture); } });
test("24 result request ID is bound", () => { const fixture = setup(); try { const value = result(fixture); value.requestId = "b".repeat(64); const sealed = sealWriterResult(value); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealed)), "RESULT_METADATA"); } finally { cleanup(fixture); } });
test("25 result context ID is bound", () => { const fixture = setup(); try { const value = result(fixture); value.contextId = "b".repeat(64); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "RESULT_METADATA"); } finally { cleanup(fixture); } });
test("26 result integrity detects mutation", () => { const fixture = setup(); try { const value = result(fixture); value.payload.meta.subtitle = "mutated"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, value)), "FACT_CLAIM_TEXT"); } finally { cleanup(fixture); } });
test("27 payload.factClaims is forbidden anywhere", () => { const fixture = setup(); try { const value = result(fixture); value.payload.factClaims = []; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_CLAIMS_FORBIDDEN"); } finally { cleanup(fixture); } });
test("28 unbound baseline business change fails", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.meta.subtitle = "unbound"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "UNBOUND_BASELINE_DIFF"); } finally { cleanup(fixture); } });
test("29 allowed date-only change passes", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.meta.generatedAt = "2026-07-30T20:00:00+08:00"; assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))); } finally { cleanup(fixture); } });
test("30 frozen probability change fails", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.pulse.probability = 0.5; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FROZEN_FIELD_CHANGED"); } finally { cleanup(fixture); } });
test("31 unchanged field cannot be rebound as new evidence", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.claimBindings.quantitative = result(fixture).claimBindings.quantitative; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "UNCHANGED_REBOUND"); } finally { cleanup(fixture); } });
test("32 duplicate claim path fails", () => { const fixture = setup(); try { const value = result(fixture); value.claimBindings.quantitative.push(structuredClone(value.claimBindings.quantitative[0])); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "CLAIM_PATH_DUPLICATE"); } finally { cleanup(fixture); } });
test("33 unsafe claim path fails", () => { const fixture = setup(); try { const value = result(fixture); value.claimBindings.quantitative[0].claimPath = "$.payload.__proto__.x"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "CLAIM_PATH"); } finally { cleanup(fixture); } });
test("34 unknown fact fails", () => { const fixture = setup(); try { const value = result(fixture); value.claimBindings.quantitative[0].factId = "unknown"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_NOT_ALLOWED"); } finally { cleanup(fixture); } });
test("35 rendered quantitative value must match packet", () => { const fixture = setup(); try { const value = result(fixture); value.claimBindings.quantitative[0].renderedValue = "999%"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_VALUE"); } finally { cleanup(fixture); } });
test("36 quantitative text must equal payload", () => { const fixture = setup(); try { const value = result(fixture); value.claimBindings.quantitative[0].claimText = "wrong"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_CLAIM_TEXT"); } finally { cleanup(fixture); } });
test("37 numeric claim binds exact packet value", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.federalReserve.countdownDays = 4.26; value.claimBindings.quantitative = [{ claimPath: "$.payload.federalReserve.countdownDays", claimText: "4.26%", factId: fixture.packet.facts[0].factId, renderedValue: "4.26%" }]; assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))); value.payload.federalReserve.countdownDays = 4.25; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_VALUE"); } finally { cleanup(fixture); } });
test("38 partial quantitative claim preserves partial language", () => { const fixture = setup({ status: "partial" }); try { assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, result(fixture))); const value = result(fixture); value.payload.meta.subtitle = "4.26%"; value.claimBindings.quantitative[0].claimText = "4.26%"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_STATUS"); } finally { cleanup(fixture); } });
test("39 stale quantitative claim preserves delay language", () => { const fixture = setup({ status: "stale" }); try { assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, result(fixture))); const value = result(fixture); value.payload.meta.subtitle = "最新4.26%"; value.claimBindings.quantitative[0].claimText = "最新4.26%"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_STATUS"); } finally { cleanup(fixture); } });
test("40 unavailable quantitative claim cannot invent a number", () => { const fixture = setup({ status: "unavailable" }); try { assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, result(fixture))); const value = result(fixture); value.payload.meta.subtitle = "数据不可用123"; value.claimBindings.quantitative[0].claimText = "数据不可用123"; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "FACT_STATUS"); } finally { cleanup(fixture); } });

test("41 qualitative observation and covering document pass", () => { const fixture = setup(); try { assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, qualitativeResult(fixture))); } finally { cleanup(fixture); } });
test("42 qualitative binding requires observations", () => { const fixture = setup(); try { const value = qualitativeResult(fixture); value.claimBindings.qualitative[0].observationIds = []; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "INVALID_ARRAY"); } finally { cleanup(fixture); } });
test("43 unknown observation fails", () => { const fixture = setup(); try { const value = qualitativeResult(fixture, { observationIds: ["b".repeat(64)] }); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, value)), "OBSERVATION_NOT_ALLOWED"); } finally { cleanup(fixture); } });
test("44 evidenceState must equal bundle state", () => { const fixture = setup(); try { const value = qualitativeResult(fixture, { state: "unverified" }); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, value)), "EVIDENCE_STATE"); } finally { cleanup(fixture); } });
test("45 document IDs must cover observation basis", () => { const fixture = setup(); try { const value = qualitativeResult(fixture, { documentIds: ["b".repeat(64)] }); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, value)), "DOCUMENT_NOT_ALLOWED"); const none = qualitativeResult(fixture); none.claimBindings.qualitative[0].documentIds = []; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(none))), "INVALID_ARRAY"); } finally { cleanup(fixture); } });
test("46 conflicting observation must retain uncertainty", () => { const fixture = setup({ evidenceState: "conflicting" }); try { assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, qualitativeResult(fixture, { text: "The source confirms a fact." }))), "EVIDENCE_LANGUAGE"); assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, qualitativeResult(fixture, { text: "证据存在分歧，结论尚不能确认。" }))); } finally { cleanup(fixture); } });
test("47 unverified observation must retain uncertainty", () => { const fixture = setup({ evidenceState: "unverified" }); try { assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, qualitativeResult(fixture, { text: "Confirmed fact." }))), "EVIDENCE_LANGUAGE"); assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, qualitativeResult(fixture, { text: "该观察尚未验证，结论不确定。" }))); } finally { cleanup(fixture); } });
test("48 empty observations cannot carry qualitative claims", () => { const fixture = setup({ withObservations: false }); try { const value = result(fixture); value.claimBindings.qualitative = [{ claimPath: "$.payload.meta.curationNote", claimText: "invented", observationIds: ["b".repeat(64)], documentIds: ["c".repeat(64)], evidenceState: "confirmed" }]; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "EMPTY_OBSERVATIONS"); } finally { cleanup(fixture); } });
test("49 empty observations require an explicit warning", () => { const fixture = setup({ withObservations: false }); try { const value = result(fixture); value.warnings = []; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "EMPTY_OBSERVATIONS"); } finally { cleanup(fixture); } });
  test("50 source metadata may repeat an exact title", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.meta.subtitle = fixture.bundle.documents[0].title; value.claimBindings.sourceMetadata = [{ claimPath: "$.payload.meta.subtitle", claimText: fixture.bundle.documents[0].title, documentId: fixture.bundle.documents[0].documentId, metadataField: "title" }]; assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))); } finally { cleanup(fixture); } });
  test("51 numeric qualitative claim binds a numeric field", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); const path = "$.payload.markets[0].indices[0].change"; const next = value.payload.markets[0].indices[0].change + 0.5; value.payload.markets[0].indices[0].change = next; value.claimBindings.qualitative = [{ claimPath: path, claimText: String(next), observationIds: [fixture.bundle.observations[0].observationId].sort(), documentIds: [fixture.bundle.documents[0].documentId].sort(), evidenceState: fixture.bundle.observations[0].evidenceState }]; assert.doesNotThrow(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))); value.claimBindings.qualitative[0].claimText = String(next + 1); assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "QUALITATIVE_CLAIM_TEXT"); } finally { cleanup(fixture); } });
  test("52 historical request with an older frozen validator scans without the current-frozen gate", () => { const fixture = setup(); try { const current = readJsonOrGzip(path.join(fixture.repo, ...fixture.contextSummary.contextPath.split("/"))); const historicalContext = structuredClone(current); historicalContext.targetValidator.sha256 = "e".repeat(64); resealContext(historicalContext); const historicalContextPath = `data/writer-contexts/contexts/${historicalContext.asOf.slice(0, 4)}/${historicalContext.asOf.slice(5, 7)}/${historicalContext.contextId}.json.gz`; const historicalContextFile = write(fixture.repo, historicalContextPath, gz(historicalContext)); const historical = structuredClone(fixture.request); historical.context.artifactPath = historicalContextPath; historical.context.artifactSha256 = hashBytes(fs.readFileSync(historicalContextFile)); historical.context.contextId = historicalContext.contextId; historical.writerPromptSha256 = historicalContext.writerPrompt.sha256; historical.targetValidatorSha256 = historicalContext.targetValidator.sha256; historical.targetOutputs[0].validatorSha256 = historicalContext.targetValidator.sha256; resealRequest(historical); write(fixture.repo, `data/writer-jobs/requests/${historical.requestedAsOf.slice(0, 4)}/${historical.requestedAsOf.slice(5, 7)}/${historical.jobId}.json`, Buffer.from(`${canonicalJson(historical)}\n`)); assert.doesNotThrow(() => prepare({ edition: "daily", contextPath: fixture.contextSummary.contextPath, dryRun: true, rootDir: fixture.repo, createdAt: NOW.toISOString() })); assert.equal(codeOf(() => makeRequest({ edition: "daily", contextPath: historicalContextPath, rootDir: fixture.repo, createdAt: NOW.toISOString() })), "REQUEST_CONTEXT_INVALID"); } finally { cleanup(fixture); } });
test("51 source metadata cannot upgrade a title into causal prose", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.meta.subtitle = `${fixture.bundle.documents[0].title} caused markets to rise`; value.claimBindings.sourceMetadata = [{ claimPath: "$.payload.meta.subtitle", claimText: value.payload.meta.subtitle, documentId: fixture.bundle.documents[0].documentId, metadataField: "title" }]; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "SOURCE_METADATA_VALUE"); } finally { cleanup(fixture); } });
test("52 source metadata field allowlist is strict", () => { const fixture = setup(); try { const value = result(fixture, { unchanged: true }); value.payload.meta.subtitle = fixture.bundle.documents[0].sourceId; value.claimBindings.sourceMetadata = [{ claimPath: "$.payload.meta.subtitle", claimText: value.payload.meta.subtitle, documentId: fixture.bundle.documents[0].documentId, metadataField: "sourceId" }]; assert.equal(codeOf(() => validateResult(fixture.repo, fixture.request, sealWriterResult(value))), "SOURCE_METADATA_FIELD"); } finally { cleanup(fixture); } });

test("53 daily apply dry-run writes nothing and reports the full plan", () => { const fixture = setup(); try { const before = snapshot(fixture.repo); const planned = apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), dryRun: true }); assert.equal(planned.applied, false); assert(planned.files.includes("data/writer-jobs/accepted/2026/07/" + fixture.request.jobId + ".json.gz")); assert.deepEqual(snapshot(fixture.repo), before); } finally { cleanup(fixture); } });
test("54 daily apply writes target and immutable accepted result", () => { const fixture = setup(); try { const applied = apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true }); assert.equal(applied.applied, true); assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.repo, "content/daily-brief.json"), "utf8")).meta.subtitle, "4.26%"); assert.equal(fs.existsSync(createWriterJobPaths(fixture.repo).accepted(fixture.request.jobId, fixture.asOf)), true); } finally { cleanup(fixture); } });
test("55 accepted result audit-only rerun is a no-op", () => { const fixture = setup(); try { const first = result(fixture); apply({ rootDir: fixture.repo, request: fixture.request, result: first, write: true }); const accepted = createWriterJobPaths(fixture.repo).accepted(fixture.request.jobId, fixture.asOf); const before = fs.readFileSync(accepted); const second = structuredClone(first); second.generatedAt = "2026-07-31T12:30:00.000Z"; second.warnings = ["later-audit-warning"]; const rerun = apply({ rootDir: fixture.repo, request: fixture.request, result: sealWriterResult(second), write: true }); assert.equal(rerun.noOp, true); assert.deepEqual(fs.readFileSync(accepted), before); } finally { cleanup(fixture); } });
test("56 conflicting accepted result fails closed", () => { const fixture = setup(); try { apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true }); const changed = result(fixture); changed.payload.meta.subtitle = "4.26% changed"; changed.claimBindings.quantitative[0].claimText = "4.26% changed"; assert.equal(codeOf(() => apply({ rootDir: fixture.repo, request: fixture.request, result: sealWriterResult(changed), write: true })), "ACCEPTED_CONFLICT"); } finally { cleanup(fixture); } });
test("57 daily target validator rejects structurally invalid payload", () => { const fixture = setup(); try { const value = result(fixture); value.payload.meta.generatedAt = ""; assert.equal(codeOf(() => apply({ rootDir: fixture.repo, request: fixture.request, result: sealWriterResult(value), write: true })), "TARGET_SCHEMA_INVALID"); } finally { cleanup(fixture); } });
test("58 apply transaction rolls back target, accepted, index and pending", () => { for (const stage of ["target", "accepted", "writer-index", "daily-pending", "weekly-pending"]) { const fixture = setup(); try { const before = snapshot(fixture.repo, ["content", "data/writer-jobs"]); assert.throws(() => apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true, failAt: stage }), new RegExp(`INJECTED_${stage}`)); assert.deepEqual(snapshot(fixture.repo, ["content", "data/writer-jobs"]), before); } finally { cleanup(fixture); } } });
test("59 apply leaves prediction/model/ledger bytes unchanged", () => { const fixture = setup(); try { for (const relativePath of ["data/prediction-ledger/sentinel.json", "data/sector-details/model-sentinel.json", "public/data/prediction-history/sentinel.json"]) write(fixture.repo, relativePath, "sentinel"); const before = snapshot(fixture.repo, ["data/prediction-ledger", "data/sector-details", "public/data/prediction-history"]); apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true }); assert.deepEqual(snapshot(fixture.repo, ["data/prediction-ledger", "data/sector-details", "public/data/prediction-history"]), before); } finally { cleanup(fixture); } });
test("60 weekly apply updates report, index and notice atomically", () => { const fixture = setup({ edition: "weekly" }); try { const applied = apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true }); assert.equal(applied.applied, true); const report = JSON.parse(fs.readFileSync(path.join(fixture.repo, fixture.request.targetOutputs[0].targetPath), "utf8")); const index = JSON.parse(fs.readFileSync(path.join(fixture.repo, "content/weekly-reports/index.json"), "utf8")); const notice = JSON.parse(fs.readFileSync(path.join(fixture.repo, "public/update-notices.json"), "utf8")); assert.equal(report.report.revision, 2); assert.equal(index.reports.find((item) => item.id === report.report.id).revision, 2); assert.equal(notice.weekly.noticeId, `${report.report.id}-r2`); } finally { cleanup(fixture); } });
test("61 weekly revision regression fails closed", () => { const fixture = setup({ edition: "weekly" }); try { const value = result(fixture); value.payload.report.revision = 0; assert.equal(codeOf(() => apply({ rootDir: fixture.repo, request: fixture.request, result: sealWriterResult(value), write: true })), "WEEKLY_REVISION_REGRESSION"); } finally { cleanup(fixture); } });
test("62 daily apply leaves weekly publication unchanged", () => { const fixture = setup(); try { const before = snapshot(fixture.repo, ["content/weekly-reports", "public/update-notices.json"]); apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true }); assert.deepEqual(snapshot(fixture.repo, ["content/weekly-reports", "public/update-notices.json"]), before); } finally { cleanup(fixture); } });
test("63 rebuild is deterministic and filters accepted requests", () => { const fixture = setup(); try { rebuild(fixture.repo); const first = fs.readFileSync(createWriterJobPaths(fixture.repo).index); rebuild(fixture.repo); assert.deepEqual(fs.readFileSync(createWriterJobPaths(fixture.repo).index), first); apply({ rootDir: fixture.repo, request: fixture.request, result: result(fixture), write: true }); assert.equal(JSON.parse(fs.readFileSync(createWriterJobPaths(fixture.repo).pending("daily"), "utf8")).job, null); } finally { cleanup(fixture); } });

test("64 result template contains ID indexes but no generated facts", () => { const fixture = setup(); try { const template = createResultTemplate({ request: fixture.request, rootDir: fixture.repo }); assert.equal(template.availableEvidence.quantitative[0].factId, fixture.packet.facts[0].factId); assert.equal(template.availableEvidence.qualitative[0].observationId, fixture.bundle.observations[0].observationId); assert.equal(template.resultTemplate.payload, null); } finally { cleanup(fixture); } });
test("65 result template output must stay outside repository", () => { const fixture = setup(); try { assert.equal(codeOf(() => writeResultTemplate({ request: fixture.request, rootDir: fixture.repo, output: path.join(fixture.repo, "template.json") })), "OUTPUT_PATH"); } finally { cleanup(fixture); } });
test("66 execution package contains exactly the ten allowed files", () => { const fixture = setup(); const output = fs.mkdtempSync(path.join(os.tmpdir(), "writer-export-")); try { exportWriterJob({ request: fixture.request, rootDir: fixture.repo, outputDirectory: output }); assert.deepEqual(fs.readdirSync(output).sort(), ["BASELINE_CONTENT.json", "MANIFEST.json", "PROMPT.md", "QUANTITATIVE_PACKET.json", "REQUEST.json", "RESEARCH_BUNDLE.json", "RESULT_TEMPLATE.json", "SHA256SUMS.txt", "TARGET_SCHEMA.json", "WRITER_CONTEXT.json"]); } finally { cleanup(fixture); fs.rmSync(output, { recursive: true, force: true }); } });
test("67 execution package SHA256SUMS verifies every listed file", () => { const fixture = setup(); const output = fs.mkdtempSync(path.join(os.tmpdir(), "writer-export-")); try { exportWriterJob({ request: fixture.request, rootDir: fixture.repo, outputDirectory: output }); for (const line of fs.readFileSync(path.join(output, "SHA256SUMS.txt"), "utf8").trim().split("\n")) { const [expected, name] = line.split(/  /); assert.equal(hashBytes(fs.readFileSync(path.join(output, name))), expected); } } finally { cleanup(fixture); fs.rmSync(output, { recursive: true, force: true }); } });
test("68 repeated execution package export is byte-stable", () => { const fixture = setup(); const output = fs.mkdtempSync(path.join(os.tmpdir(), "writer-export-")); try { exportWriterJob({ request: fixture.request, rootDir: fixture.repo, outputDirectory: output }); const first = snapshot(output, ["."]); exportWriterJob({ request: fixture.request, rootDir: fixture.repo, outputDirectory: output }); assert.deepEqual(snapshot(output, ["."]), first); } finally { cleanup(fixture); fs.rmSync(output, { recursive: true, force: true }); } });
test("69 execution package refuses unrelated existing files", () => { const fixture = setup(); const output = fs.mkdtempSync(path.join(os.tmpdir(), "writer-export-")); try { fs.writeFileSync(path.join(output, "secret.txt"), "do not touch"); assert.equal(codeOf(() => exportWriterJob({ request: fixture.request, rootDir: fixture.repo, outputDirectory: output })), "EXPORT_DIRECTORY"); } finally { cleanup(fixture); fs.rmSync(output, { recursive: true, force: true }); } });
test("70 execution package manifest binds all immutable IDs", () => { const fixture = setup(); const output = fs.mkdtempSync(path.join(os.tmpdir(), "writer-export-")); try { exportWriterJob({ request: fixture.request, rootDir: fixture.repo, outputDirectory: output }); const manifest = JSON.parse(fs.readFileSync(path.join(output, "MANIFEST.json"), "utf8")); assert.equal(manifest.contextId, fixture.request.context.contextId); assert.equal(manifest.writerPacketId, fixture.packet.writerPacketId); assert.equal(manifest.bundleId, fixture.bundle.bundleId); } finally { cleanup(fixture); fs.rmSync(output, { recursive: true, force: true }); } });

test("71 CLI prepare rejects missing context", () => { const run = spawnSync(process.execPath, [moduleFile, "prepare", "--edition", "daily", "--dry-run"], { cwd: root, encoding: "utf8" }); assert.equal(run.status, 1); assert.match(run.stderr, /CLI_ARGUMENT/); });
test("72 CLI rejects implicit real apply", () => { const run = spawnSync(process.execPath, [moduleFile, "apply"], { cwd: root, encoding: "utf8" }); assert.equal(run.status, 1); assert.match(run.stderr, /CLI_ARGUMENT/); });
test("73 Luna prompts define the v2 closed evidence boundary", () => { for (const file of ["prompts/luna-daily-brief.md", "prompts/luna-weekly-brief.md"]) { const prompt = fs.readFileSync(path.join(root, file), "utf8"); for (const phrase of ["writer-request-v2", "writer-context-v1", "writer-result-v2", "claimBindings", "quantitative", "qualitative", "sourceMetadata", "payload.factClaims", "latest", "no-new-qualitative-observations"]) assert.ok(prompt.includes(phrase), `${file} lacks ${phrase}`); assert.match(prompt, /Do not browse, search, call APIs/); } });
test("74 workflow is manual, context-explicit, latest-free and single-runner", () => { const workflow = fs.readFileSync(path.join(root, ".github/workflows/writer-job-prepare.yml"), "utf8"); assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /context_path:/); assert.match(workflow, /--context "\$CONTEXT_PATH" --dry-run/); assert.match(workflow, /--context "\$CONTEXT_PATH" --write/); assert.doesNotMatch(workflow, /^\s*schedule:/m); assert.doesNotMatch(workflow, /cron:|--as-of auto|writer-packets\/.*latest/); assert.doesNotMatch(workflow, /matrix:/); });
