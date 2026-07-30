import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as contract from "./research-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = JSON.parse(fs.readFileSync(path.join(root, "data/research-bundles/contract.json"), "utf8"));
const hash = (character) => character.repeat(64);

function seal(value, idKey, compute) {
  const next = structuredClone(value);
  next[idKey] = compute(next);
  next.integrity = { businessSha256: next[idKey], sha256: "" };
  next.integrity.sha256 = contract.sha256Canonical({ ...next, integrity: { businessSha256: next.integrity.businessSha256 } });
  return next;
}

function sourceRun(overrides = {}) {
  const base = {
    sourceRunId: "",
    sourceId: "sample-source",
    provider: "Sample Provider",
    sourceClass: "official-primary",
    adapterId: "sample-adapter",
    adapterVersion: "v1",
    requestedAt: "2026-07-30T09:00:00+08:00",
    asOf: "2026-07-30T08:00:00+08:00",
    status: "ready",
    sourceUrl: "https://example.com/source",
    marketScopes: ["US"],
    topics: ["macro"],
    coverage: { itemCount: 1, note: "fixture" },
    snapshotPolicy: "stored",
    rawSnapshotId: hash("a"),
    warnings: [],
    integrity: { businessSha256: "", sha256: "" }
  };
  const next = { ...base, ...overrides, coverage: { ...base.coverage, ...(overrides.coverage ?? {}) } };
  return seal(next, "sourceRunId", contract.computeSourceRunId);
}

function document(run, overrides = {}) {
  const base = {
    documentId: "",
    sourceRunId: run.sourceRunId,
    sourceId: run.sourceId,
    publisherId: "sample-publisher",
    publisher: "Sample Publisher",
    title: "Sample document",
    canonicalUrl: "https://example.com/report?b=2&a=1",
    publishedAt: "2026-07-30T07:00:00+08:00",
    accessedAt: "2026-07-30T09:01:00+08:00",
    language: "en",
    contentType: "html",
    contentHashBasis: "response-entity",
    contentHashVersion: "v1",
    contentSha256: hash("b"),
    rawSnapshotId: run.rawSnapshotId ?? hash("a"),
    marketScopes: ["US"],
    topics: ["macro"],
    warnings: [],
    integrity: { businessSha256: "", sha256: "" }
  };
  const next = { ...base, ...overrides };
  return seal(next, "documentId", contract.computeDocumentId);
}

function observation(documents, runs, overrides = {}) {
  const base = {
    observationId: "",
    kind: "hard-fact",
    subject: "sample subject",
    statement: "Sample statement.",
    occurredAt: "2026-07-30T07:00:00+08:00",
    asOf: "2026-07-30",
    marketScopes: ["US"],
    topics: ["macro"],
    entities: ["sample"],
    evidenceState: "single-source",
    basis: [{ documentId: documents[0].documentId, relation: "supports", excerpt: "Minimal support.", locator: "paragraph-1" }],
    warnings: []
  };
  const next = { ...base, ...overrides };
  next.evidenceState = contract.deriveEvidenceState(next, { documents, sourceRuns: runs, duplicateClusters: overrides.duplicateClusters ?? [] });
  delete next.duplicateClusters;
  next.observationId = contract.computeObservationId(next);
  return next;
}

function event(observations, overrides = {}) {
  const base = { eventId: "", eventType: "macro-release", title: "Sample event", occurredAt: observations[0].occurredAt, marketScopes: ["US"], topics: ["macro"], observationIds: [observations[0].observationId] };
  return { ...base, ...overrides, eventId: contract.computeEventId({ ...base, ...overrides }) };
}

function cluster(documents, method = "semantic-signature", canonicalDocumentId = documents[0].documentId) {
  const next = { clusterId: "", method, canonicalDocumentId, memberDocumentIds: documents.map((item) => item.documentId).sort() };
  next.clusterId = contract.computeClusterId(next);
  return next;
}

function coverage(documents, observations, sourceRuns, events, clusters) {
  const markets = ["A_SHARE", "HK", "US", "FED"].map((market) => {
    const documentCount = documents.filter((item) => item.marketScopes.includes(market)).length;
    const observationCount = observations.filter((item) => item.marketScopes.includes(market)).length;
    return { market, status: documentCount || observationCount ? "ready" : "partial", documentCount, observationCount, reasons: documentCount || observationCount ? [] : ["fixture coverage gap"] };
  });
  const topics = [...new Set(documents.flatMap((item) => item.topics).concat(observations.flatMap((item) => item.topics)))].sort((left, right) => registry.enums.topic.indexOf(left) - registry.enums.topic.indexOf(right)).map((topic) => ({ topic, status: "ready", documentCount: documents.filter((item) => item.topics.includes(topic)).length, observationCount: observations.filter((item) => item.topics.includes(topic)).length, reasons: [] }));
  return { markets, topics, totals: { sourceRuns: sourceRuns.length, documents: documents.length, observations: observations.length, events: events.length, duplicateClusters: clusters.length, conflictingObservations: observations.filter((item) => item.evidenceState === "conflicting").length } };
}

function completeBundle({ sourceRuns, documents, observations, events, clusters = [], edition = "daily", asOf = "2026-07-30", generatedAt = "2026-07-30T10:00:00+08:00" }) {
  const next = {
    schemaVersion: registry.bundleSchemaVersion,
    edition,
    asOf,
    generatedAt,
    window: { start: edition === "daily" ? asOf : "2026-07-24", end: asOf, timezone: "Asia/Shanghai" },
    sourcePolicyVersion: registry.sourcePolicyVersion,
    sourceRuns: [...sourceRuns].sort((left, right) => left.sourceRunId.localeCompare(right.sourceRunId)),
    documents: [...documents].sort((left, right) => left.documentId.localeCompare(right.documentId)),
    observations: [...observations].sort((left, right) => left.observationId.localeCompare(right.observationId)),
    events: [...events].sort((left, right) => left.eventId.localeCompare(right.eventId)),
    duplicateClusters: [...clusters].sort((left, right) => left.clusterId.localeCompare(right.clusterId)),
    coverage: coverage(documents, observations, sourceRuns, events, clusters),
    warnings: [],
    bundleId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  return seal(next, "bundleId", contract.computeBundleId);
}

function dailyBundle(options = {}) {
  const run = sourceRun(options.sourceRun);
  const doc = document(run, options.document);
  const obs = observation([doc], [run], options.observation);
  const evt = event([obs], options.event);
  return completeBundle({ sourceRuns: [run], documents: [doc], observations: [obs], events: [evt], ...options.bundle });
}

function weeklyCalendarBundle(options = {}) {
  const run = sourceRun({ topics: ["calendar"], ...(options.sourceRun ?? {}) });
  const doc = document(run, { topics: ["calendar"], ...(options.document ?? {}) });
  const obs = observation([doc], [run], { kind: "calendar-event", statement: "Published calendar announces a future release.", occurredAt: "2026-08-02T20:30:00+08:00", topics: ["calendar"], ...(options.observation ?? {}) });
  const evt = event([obs], { eventType: "calendar", title: "Future calendar", occurredAt: obs.occurredAt, topics: ["calendar"], ...(options.event ?? {}) });
  return completeBundle({ sourceRuns: [run], documents: [doc], observations: [obs], events: [evt], edition: "weekly", ...options.bundle });
}

function expectCode(run, code) {
  assert.throws(run, (error) => error instanceof contract.ResearchContractError && (!code || error.code === code));
}

function twoDocumentContext({ sameUrl = false, sameHash = false, sourceClass = "major-media" } = {}) {
  const firstRun = sourceRun({ sourceId: "one", sourceClass, sourceUrl: "https://example.com/one" });
  const secondRun = sourceRun({ sourceId: "two", sourceClass, sourceUrl: "https://example.com/two" });
  const first = document(firstRun, { publisherId: "publisher-one", canonicalUrl: "https://example.com/one-story", contentSha256: hash("c"), publishedAt: "2026-07-29T07:00:00+08:00" });
  const second = document(secondRun, { publisherId: "publisher-two", canonicalUrl: sameUrl ? first.canonicalUrl : "https://example.com/two-story", contentSha256: sameHash ? first.contentSha256 : hash("d"), publishedAt: "2026-07-30T07:00:00+08:00" });
  return { runs: [firstRun, secondRun], documents: [first, second] };
}

test("01 canonical object keys are stable", () => assert.equal(contract.canonicalJson({ z: 1, a: 2 }), contract.canonicalJson({ a: 2, z: 1 })));
test("02 canonical -0 equals 0", () => assert.equal(contract.canonicalJson(-0), contract.canonicalJson(0)));
test("03 canonical NaN is rejected", () => expectCode(() => contract.canonicalJson(Number.NaN), "INVALID_TYPE"));
test("04 canonical Infinity is rejected", () => expectCode(() => contract.canonicalJson(Infinity), "INVALID_TYPE"));
test("05 canonical undefined is rejected", () => expectCode(() => contract.canonicalJson({ value: undefined }), "INVALID_TYPE"));
test("06 canonical Date is rejected", () => expectCode(() => contract.canonicalJson(new Date()), "INVALID_TYPE"));
test("07 canonical circular values are rejected", () => { const value = {}; value.self = value; expectCode(() => contract.canonicalJson(value), "INVALID_TYPE"); });
test("08 URL HTTPS normalization", () => assert.equal(contract.normalizeCanonicalUrl("HTTPS://EXAMPLE.COM"), "https://example.com/"));
test("09 URL fragment is removed", () => assert.equal(contract.normalizeCanonicalUrl("https://example.com/a#part"), "https://example.com/a"));
test("10 URL default port is removed", () => assert.equal(contract.normalizeCanonicalUrl("https://example.com:443/a"), "https://example.com/a"));
test("11 URL query order is preserved", () => assert.equal(contract.normalizeCanonicalUrl("https://example.com/?b=2&a=1&a=0"), "https://example.com/?b=2&a=1&a=0"));
test("12 URL HTTP is rejected", () => expectCode(() => contract.normalizeCanonicalUrl("http://example.com/"), "INVALID_URL"));
test("13 URL credentials are rejected", () => expectCode(() => contract.normalizeCanonicalUrl("https://user:pass@example.com/"), "INVALID_URL"));
test("14 Google search URL is rejected", () => { const run = sourceRun(); const value = document(run, { canonicalUrl: "https://www.google.com/search?q=test" }); expectCode(() => contract.validateDocument(value, [run], registry), "SEARCH_RESULT_URL"); });
test("15 valid ready source run", () => assert.equal(contract.validateSourceRun(sourceRun(), registry).status, "ready"));
test("16 valid unavailable source run", () => assert.equal(contract.validateSourceRun(sourceRun({ status: "unavailable", snapshotPolicy: "none", rawSnapshotId: null, coverage: { itemCount: 0, note: "blocked" }, warnings: ["blocked"] }), registry).status, "unavailable"));
test("17 requestedAt does not change sourceRunId", () => { const first = sourceRun(); const second = sourceRun({ requestedAt: "2026-07-30T10:00:00+08:00" }); assert.equal(first.sourceRunId, second.sourceRunId); });
test("18 adapter version changes sourceRunId", () => assert.notEqual(sourceRun().sourceRunId, sourceRun({ adapterVersion: "v2" }).sourceRunId));
test("19 source raw snapshot hash is enforced", () => { const value = sourceRun({ rawSnapshotId: "bad" }); expectCode(() => contract.validateSourceRun(value, registry), "INVALID_HASH"); });
test("20 unavailable source run cannot contain data", () => { const value = sourceRun({ status: "unavailable", snapshotPolicy: "none", rawSnapshotId: null, coverage: { itemCount: 1, note: "bad" }, warnings: ["blocked"] }); expectCode(() => contract.validateSourceRun(value, registry), "SOURCE_RUN_STATUS"); });
test("21 source status and policy must agree", () => { const value = sourceRun({ snapshotPolicy: "none" }); expectCode(() => contract.validateSourceRun(value, registry), "SOURCE_RUN_POLICY"); });
test("22 source run integrity is enforced", () => { const value = sourceRun(); value.integrity.sha256 = hash("0"); expectCode(() => contract.validateSourceRun(value, registry), "SOURCE_RUN_INTEGRITY"); });
test("23 document binds its exact sourceRunId", () => { const run = sourceRun(); assert.equal(contract.validateDocument(document(run), [run], registry).sourceRunId, run.sourceRunId); });
test("24 document sourceId mismatch fails", () => { const run = sourceRun(); const value = document(run, { sourceId: "wrong-source" }); expectCode(() => contract.validateDocument(value, [run], registry), "DOCUMENT_SOURCE_ID"); });
test("25 publisherId format is enforced", () => { const run = sourceRun(); const value = document(run, { publisherId: "Not Valid" }); expectCode(() => contract.validateDocument(value, [run], registry), "DOCUMENT_PUBLISHER"); });
test("26 accessedAt does not change documentId", () => { const run = sourceRun(); assert.equal(document(run).documentId, document(run, { accessedAt: "2026-07-30T10:01:00+08:00" }).documentId); });
test("27 content hash basis changes documentId", () => { const run = sourceRun(); assert.notEqual(document(run).documentId, document(run, { contentHashBasis: "feed-item" }).documentId); });
test("28 unknown sourceRunId fails", () => { const run = sourceRun(); const value = document(run, { sourceRunId: hash("f") }); expectCode(() => contract.validateDocument(value, [run], registry), "DOCUMENT_SOURCE_RUN"); });
test("29 search-result document URL fails", () => { const run = sourceRun(); const value = document(run, { canonicalUrl: "https://www.bing.com/search?q=test" }); expectCode(() => contract.validateDocument(value, [run], registry), "SEARCH_RESULT_URL"); });
test("30 document integrity is enforced", () => { const run = sourceRun(); const value = document(run); value.integrity.sha256 = hash("0"); expectCode(() => contract.validateDocument(value, [run], registry), "DOCUMENT_INTEGRITY"); });
test("31 authoritative support is confirmed", () => { const run = sourceRun(); const doc = document(run); assert.equal(contract.deriveEvidenceState(observation([doc], [run]), { documents: [doc], sourceRuns: [run] }), "confirmed"); });
test("32 two eligible publishers are corroborated", () => { const { runs, documents } = twoDocumentContext(); const value = observation(documents, runs, { basis: documents.map((item) => ({ documentId: item.documentId, relation: "supports", excerpt: item.publisherId, locator: item.publisherId })) }); assert.equal(value.evidenceState, "corroborated"); });
test("33 one publisher with two URLs is not corroborated", () => { const { runs, documents } = twoDocumentContext(); documents[1].publisherId = documents[0].publisherId; documents[1] = seal(documents[1], "documentId", contract.computeDocumentId); const value = observation(documents, runs, { basis: documents.map((item) => ({ documentId: item.documentId, relation: "supports", excerpt: item.publisherId, locator: item.documentId })) }); assert.equal(value.evidenceState, "single-source"); });
test("34 duplicate cluster does not add independent publisher", () => { const { runs, documents } = twoDocumentContext({ sameHash: true }); const duplicate = cluster(documents, "content-hash"); const value = observation(documents, runs, { duplicateClusters: [duplicate], basis: documents.map((item) => ({ documentId: item.documentId, relation: "supports", excerpt: item.publisherId, locator: item.documentId })) }); assert.equal(value.evidenceState, "single-source"); });
test("35 community and social cannot corroborate", () => { const first = sourceRun({ sourceClass: "community-signal", sourceId: "community", sourceUrl: "https://example.com/community" }); const second = sourceRun({ sourceClass: "social-signal", sourceId: "social", sourceUrl: "https://example.com/social" }); const docs = [document(first, { publisherId: "community-one" }), document(second, { publisherId: "social-two", canonicalUrl: "https://example.com/social-post", contentSha256: hash("c") })]; const value = observation(docs, [first, second], { basis: docs.map((item) => ({ documentId: item.documentId, relation: "supports", excerpt: item.publisherId, locator: item.documentId })) }); assert.equal(value.evidenceState, "unverified"); });
test("36 community contradiction is only unverified counter-signal", () => { const run = sourceRun({ sourceClass: "community-signal" }); const doc = document(run); const value = observation([doc], [run], { basis: [{ documentId: doc.documentId, relation: "supports", excerpt: "support", locator: "a" }, { documentId: doc.documentId, relation: "contradicts", excerpt: "counter", locator: "b" }] }); assert.equal(value.evidenceState, "unverified"); });
test("37 qualified contradiction is conflicting", () => { const run = sourceRun(); const doc = document(run); const value = observation([doc], [run], { basis: [{ documentId: doc.documentId, relation: "supports", excerpt: "support", locator: "a" }, { documentId: doc.documentId, relation: "contradicts", excerpt: "counter", locator: "b" }] }); assert.equal(value.evidenceState, "conflicting"); });
test("38 analysis context confirmed is source-analysis only", () => { const run = sourceRun(); const doc = document(run); const value = observation([doc], [run], { kind: "analysis-context", statement: "The source describes its method.", basis: [{ documentId: doc.documentId, relation: "supports", excerpt: "method", locator: "method" }] }); assert.equal(value.evidenceState, "confirmed"); });
test("39 duplicate observation basis fails", () => { const value = dailyBundle(); value.observations[0].basis.push(structuredClone(value.observations[0].basis[0])); expectCode(() => contract.validateBundle(value, registry), "OBSERVATION_BASIS"); });
test("40 unknown observation document fails", () => { const value = dailyBundle(); value.observations[0].basis[0].documentId = hash("e"); expectCode(() => contract.validateBundle(value, registry), "OBSERVATION_REFERENCE"); });
test("41 ordinary future observation fails", () => { const value = dailyBundle(); value.observations[0].occurredAt = "2026-08-01T10:00:00+08:00"; expectCode(() => contract.validateBundle(value, registry), "OBSERVATION_TIME"); });
test("42 published future calendar is valid", () => assert.equal(contract.validateBundle(weeklyCalendarBundle(), registry).edition, "weekly"));
test("43 late calendar support fails", () => { const value = weeklyCalendarBundle({ document: { publishedAt: "2026-07-31T09:00:00+08:00" } }); expectCode(() => contract.validateBundle(value, registry), "OBSERVATION_TIME"); });
test("44 event unknown observation fails", () => { const value = dailyBundle(); value.events[0].observationIds = [hash("d")]; expectCode(() => contract.validateBundle(value, registry), "EVENT_REFERENCE"); });
test("45 exact-url cluster requires equal URLs", () => { const { runs, documents } = twoDocumentContext(); const duplicate = cluster(documents, "exact-url"); const obs = observation([documents[0]], runs); const evt = event([obs]); const value = completeBundle({ sourceRuns: runs, documents, observations: [obs], events: [evt], clusters: [duplicate] }); expectCode(() => contract.validateBundle(value, registry), "CLUSTER_METHOD"); });
test("46 content-hash cluster requires equal hashes", () => { const { runs, documents } = twoDocumentContext(); const duplicate = cluster(documents, "content-hash"); const obs = observation([documents[0]], runs); const evt = event([obs]); const value = completeBundle({ sourceRuns: runs, documents, observations: [obs], events: [evt], clusters: [duplicate] }); expectCode(() => contract.validateBundle(value, registry), "CLUSTER_METHOD"); });
test("47 document cannot span clusters", () => { const context = twoDocumentContext(); const thirdRun = sourceRun({ sourceId: "three", sourceClass: "major-media", sourceUrl: "https://example.com/three" }); const third = document(thirdRun, { publisherId: "publisher-three", canonicalUrl: "https://example.com/three-story", contentSha256: hash("e") }); const firstCluster = cluster(context.documents, "semantic-signature"); const secondCluster = cluster([context.documents[1], third], "semantic-signature", context.documents[1].documentId); const obs = observation([context.documents[0]], [...context.runs, thirdRun]); const evt = event([obs]); const value = completeBundle({ sourceRuns: [...context.runs, thirdRun], documents: [...context.documents, third], observations: [obs], events: [evt], clusters: [firstCluster, secondCluster] }); expectCode(() => contract.validateBundle(value, registry), "CLUSTER_OVERLAP"); });
test("48 cluster canonical selection is deterministic", () => { const { runs, documents } = twoDocumentContext(); const duplicate = cluster(documents, "semantic-signature", documents[1].documentId); const obs = observation([documents[0]], runs); const value = completeBundle({ sourceRuns: runs, documents, observations: [obs], events: [event([obs])], clusters: [duplicate] }); expectCode(() => contract.validateBundle(value, registry), "CLUSTER_CANONICAL"); });
test("49 lower priority cluster cannot hide exact URL", () => { const { runs, documents } = twoDocumentContext({ sameUrl: true, sameHash: true }); const duplicate = cluster(documents, "semantic-signature"); const obs = observation([documents[0]], runs); const value = completeBundle({ sourceRuns: runs, documents, observations: [obs], events: [event([obs])], clusters: [duplicate] }); expectCode(() => contract.validateBundle(value, registry), "CLUSTER_METHOD"); });
test("50 coverage requires four markets", () => { const value = dailyBundle(); value.coverage.markets.pop(); expectCode(() => contract.validateBundle(value, registry), "COVERAGE_MARKETS"); });
test("51 coverage market duplicates fail", () => { const value = dailyBundle(); value.coverage.markets[1].market = "A_SHARE"; expectCode(() => contract.validateBundle(value, registry), "COVERAGE_MARKETS"); });
test("52 coverage topic duplicates fail", () => { const value = dailyBundle(); value.coverage.topics.push(structuredClone(value.coverage.topics[0])); expectCode(() => contract.validateBundle(value, registry), "COVERAGE_TOPICS"); });
test("53 coverage counts unique IDs", () => { const value = dailyBundle(); assert.equal(contract.validateBundle(value, registry).coverage.markets.find((item) => item.market === "US").documentCount, 1); });
test("54 ready coverage cannot have reasons", () => { const value = dailyBundle(); value.coverage.markets.find((item) => item.market === "US").reasons.push("bad"); expectCode(() => contract.validateBundle(value, registry), "COVERAGE_STATUS"); });
test("55 partial coverage needs a reason", () => { const value = dailyBundle(); value.coverage.markets.find((item) => item.market === "HK").reasons = []; expectCode(() => contract.validateBundle(value, registry), "COVERAGE_STATUS"); });
test("56 coverage totals are checked", () => { const value = dailyBundle(); value.coverage.totals.documents = 2; expectCode(() => contract.validateBundle(value, registry), "COVERAGE_COUNT"); });
test("57 bundle arrays must be sorted", () => { const context = twoDocumentContext(); const obs = observation([context.documents[0]], context.runs); const value = completeBundle({ sourceRuns: context.runs, documents: context.documents, observations: [obs], events: [event([obs])] }); value.sourceRuns.reverse(); expectCode(() => contract.validateBundle(value, registry), "UNSORTED_ARRAY"); });
test("58 bundle ID is stable", () => assert.equal(dailyBundle().bundleId, dailyBundle().bundleId));
test("59 generatedAt does not change bundleId", () => { const first = dailyBundle(); const second = dailyBundle({ bundle: { generatedAt: "2026-07-30T11:00:00+08:00" } }); assert.equal(first.bundleId, second.bundleId); });
test("60 warnings do not change bundleId", () => { const first = dailyBundle(); const second = dailyBundle(); second.warnings = ["audit note"]; second.integrity.sha256 = contract.sha256Canonical({ ...second, integrity: { businessSha256: second.integrity.businessSha256 } }); assert.equal(first.bundleId, second.bundleId); });
test("61 business fields change bundleId", () => { const first = dailyBundle(); const second = dailyBundle({ observation: { statement: "Changed statement." } }); assert.notEqual(first.bundleId, second.bundleId); });
test("62 bundle integrity is enforced", () => { const value = dailyBundle(); value.integrity.sha256 = hash("0"); expectCode(() => contract.validateBundle(value, registry), "BUNDLE_INTEGRITY"); });
test("63 duplicate source run IDs fail", () => { const value = dailyBundle(); value.sourceRuns.push(structuredClone(value.sourceRuns[0])); expectCode(() => contract.validateBundle(value, registry), "DUPLICATE_ID"); });
test("64 forbidden keys are recursive", () => { const value = dailyBundle(); value.observations[0].body = "forbidden"; expectCode(() => contract.validateBundle(value, registry), "FORBIDDEN_KEY"); });
test("65 unknown keys are rejected", () => { const value = dailyBundle(); value.unknown = true; expectCode(() => contract.validateBundle(value, registry), "UNKNOWN_KEY"); });
test("66 source policy version is frozen", () => { const value = dailyBundle(); value.sourcePolicyVersion = "wrong"; expectCode(() => contract.validateBundle(value, registry), "BUNDLE_POLICY_VERSION"); });
test("67 daily window validates", () => assert.equal(contract.validateBundle(dailyBundle(), registry).window.end, "2026-07-30"));
test("68 weekly window validates", () => assert.equal(contract.validateBundle(weeklyCalendarBundle(), registry).window.start, "2026-07-24"));
test("69 audit-only source candidate reuses existing", () => { const existing = sourceRun(); const candidate = sourceRun({ requestedAt: "2026-07-30T11:00:00+08:00", warnings: ["later audit"] }); assert.equal(contract.compareImmutableCandidate("sourceRun", existing, candidate, registry).reused, true); });
test("70 audit-only document candidate reuses existing", () => { const run = sourceRun(); const existing = document(run); const candidate = document(run, { accessedAt: "2026-07-30T11:01:00+08:00", warnings: ["later audit"] }); assert.equal(contract.compareImmutableCandidate("document", existing, candidate, registry).reused, true); });
test("71 audit-only bundle candidate reuses existing", () => { const existing = dailyBundle(); const candidate = dailyBundle({ bundle: { generatedAt: "2026-07-30T11:00:00+08:00" } }); candidate.warnings = ["later audit"]; candidate.integrity.sha256 = contract.sha256Canonical({ ...candidate, integrity: { businessSha256: candidate.integrity.businessSha256 } }); assert.equal(contract.compareImmutableCandidate("bundle", existing, candidate, registry).reused, true); });
test("72 business differences conflict", () => { const existing = sourceRun(); const candidate = sourceRun({ provider: "Different Provider" }); expectCode(() => contract.compareImmutableCandidate("sourceRun", existing, candidate, registry), "IMMUTABLE_CONFLICT"); });
test("73 damaged existing artifacts fail closed", () => { const existing = sourceRun(); const candidate = sourceRun({ requestedAt: "2026-07-30T11:00:00+08:00" }); existing.integrity.sha256 = hash("0"); expectCode(() => contract.compareImmutableCandidate("sourceRun", existing, candidate, registry), "SOURCE_RUN_INTEGRITY"); });
