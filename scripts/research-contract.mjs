import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const moduleRoot = path.resolve(path.dirname(moduleFile), "..");
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const ADAPTER_VERSION = /^v[1-9][0-9]*$/;
const METHOD_PRIORITY = new Map([["exact-url", 0], ["content-hash", 1], ["publisher-reprint", 2], ["semantic-signature", 3]]);
const AUTHORITATIVE = new Set(["official-primary", "company-filing", "exchange-market-data", "primary-research"]);
const ELIGIBLE_PUBLISHERS = new Set(["major-media", "specialist-media", "vendor-market-data", "vendor-estimate"]);
const QUALIFIED_CONTRADICTIONS = new Set([...AUTHORITATIVE, ...ELIGIBLE_PUBLISHERS]);

export class ResearchContractError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "ResearchContractError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new ResearchContractError(code, errorPath, message);
}

function codePointCompare(left, right) {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index].codePointAt(0) - rightPoints[index].codePointAt(0);
    if (difference) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalize(value) {
  const stack = new Set();
  const visit = (current, errorPath) => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("INVALID_TYPE", errorPath, "number must be finite");
      return Object.is(current, -0) ? 0 : current;
    }
    if (typeof current === "undefined" || typeof current === "bigint" || typeof current === "function" || typeof current === "symbol") fail("INVALID_TYPE", errorPath, "non-JSON value");
    if (current instanceof Date) fail("INVALID_TYPE", errorPath, "Date is not supported");
    if (typeof current !== "object") fail("INVALID_TYPE", errorPath, "invalid value");
    if (stack.has(current)) fail("INVALID_TYPE", errorPath, "circular value");
    stack.add(current);
    try {
      if (Array.isArray(current)) return current.map((item, index) => visit(item, `${errorPath}[${index}]`));
      if (!plainObject(current)) fail("INVALID_TYPE", errorPath, "plain object required");
      const result = {};
      for (const key of Object.keys(current).sort(codePointCompare)) result[key] = visit(current[key], `${errorPath}.${key}`);
      return result;
    } finally {
      stack.delete(current);
    }
  };
  return visit(value, "$" );
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sortedUnique(values) {
  return [...new Set(values)].sort(codePointCompare);
}

function objectWithout(value, keys) {
  const copy = {};
  for (const [key, entry] of Object.entries(value)) if (!keys.has(key)) copy[key] = entry;
  return copy;
}

function objectWithBusinessIntegrity(value) {
  const copy = { ...value, integrity: { businessSha256: value.integrity?.businessSha256 } };
  return copy;
}

function fullIntegrityHash(value) {
  return sha256Canonical(objectWithBusinessIntegrity(value));
}

function registrySchema(registry, name) {
  const schema = registry?.schemas?.[name];
  if (!plainObject(schema)) fail("REGISTRY_SCHEMA", `schemas.${name}`, "schema missing");
  return schema;
}

function enumValues(registry, name) {
  const values = registry?.enums?.[name];
  if (!Array.isArray(values)) fail("REGISTRY_SCHEMA", `enums.${name}`, "enum missing");
  return values;
}

function assertObject(value, errorPath) {
  if (!plainObject(value)) fail("INVALID_TYPE", errorPath, "object required");
}

function assertKeys(value, requiredKeys, allowedKeys, errorPath) {
  assertObject(value, errorPath);
  for (const key of requiredKeys) if (!Object.hasOwn(value, key)) fail("MISSING_KEY", `${errorPath}.${key}`, "required key missing");
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) fail("UNKNOWN_KEY", `${errorPath}.${key}`, "unknown key");
}

function assertString(value, errorPath, code = "INVALID_TYPE") {
  if (typeof value !== "string" || !value.length) fail(code, errorPath, "nonempty string required");
}

function assertHash(value, errorPath) {
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_HASH", errorPath, "lowercase SHA-256 required");
}

function assertEnum(value, values, errorPath) {
  if (!values.includes(value)) fail("INVALID_ENUM", errorPath, "invalid enum");
}

function assertArray(value, errorPath) {
  if (!Array.isArray(value)) fail("INVALID_TYPE", errorPath, "array required");
}

function assertSortedUnique(values, errorPath) {
  const expected = sortedUnique(values);
  if (values.length !== expected.length || values.some((value, index) => value !== expected[index])) fail("UNSORTED_ARRAY", errorPath, "sorted unique array required");
}

function assertEnumArray(values, allowed, errorPath, { nonempty = false } = {}) {
  assertArray(values, errorPath);
  if (nonempty && !values.length) fail("INVALID_TYPE", errorPath, "nonempty array required");
  for (let index = 0; index < values.length; index += 1) assertEnum(values[index], allowed, `${errorPath}[${index}]`);
  assertSortedUnique(values, errorPath);
}

function assertWarnings(value, errorPath) {
  assertArray(value, errorPath);
  for (let index = 0; index < value.length; index += 1) assertString(value[index], `${errorPath}[${index}]`);
}

function isDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function assertDate(value, errorPath) {
  if (!isDate(value)) fail("INVALID_DATE", errorPath, "YYYY-MM-DD required");
}

function assertTimestamp(value, errorPath, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(new Date(value).valueOf())) fail("INVALID_TIMESTAMP", errorPath, "timezone timestamp required");
}

function shanghaiEnd(date) {
  return new Date(`${date}T23:59:59+08:00`);
}

export function normalizeCanonicalUrl(input) {
  if (typeof input !== "string") fail("INVALID_URL", "canonicalUrl", "URL string required");
  let url;
  try {
    url = new URL(input);
  } catch {
    fail("INVALID_URL", "canonicalUrl", "invalid URL");
  }
  if (url.protocol !== "https:") fail("INVALID_URL", "canonicalUrl", "HTTPS required");
  if (url.username || url.password) fail("INVALID_URL", "canonicalUrl", "credentials forbidden");
  url.hostname = url.hostname.toLowerCase();
  url.protocol = "https:";
  url.hash = "";
  if (url.port === "443") url.port = "";
  if (!url.pathname) url.pathname = "/";
  return url.href;
}

function isSearchResultUrl(normalized) {
  const url = new URL(normalized);
  const host = url.hostname;
  const google = /(^|\.)google\.[a-z.]+$/.test(host);
  if (google && (url.pathname === "/search" || url.pathname === "/url")) return true;
  if ((host === "bing.com" || host.endsWith(".bing.com")) && url.pathname === "/search") return true;
  if (/^search\.yahoo\.[a-z.]+$/.test(host) && url.pathname.startsWith("/search")) return true;
  if ((host === "baidu.com" || host.endsWith(".baidu.com")) && url.pathname === "/s") return true;
  if ((host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) && url.pathname === "/" && url.searchParams.has("q")) return true;
  return false;
}

function assertCanonicalUrl(value, errorPath) {
  let normalized;
  try {
    normalized = normalizeCanonicalUrl(value);
  } catch (cause) {
    if (cause instanceof ResearchContractError) throw new ResearchContractError(cause.code, errorPath, cause.message);
    throw cause;
  }
  if (normalized !== value) fail("INVALID_URL", errorPath, "URL is not canonical");
  if (isSearchResultUrl(normalized)) fail("SEARCH_RESULT_URL", errorPath, "search result URL");
  return normalized;
}

function assertNoForbidden(value, registry, errorPath = "$") {
  const forbidden = new Set(registry?.forbiddenKeys ?? []);
  const visit = (current, currentPath) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (!plainObject(current)) return;
    for (const [key, item] of Object.entries(current)) {
      if (forbidden.has(key)) fail("FORBIDDEN_KEY", `${currentPath}.${key}`, "forbidden key");
      visit(item, `${currentPath}.${key}`);
    }
  };
  visit(value, errorPath);
}

function validateIntegrity(value, expectedId, errorPath, code, requiredKeys, allowedKeys) {
  assertKeys(value.integrity, requiredKeys, allowedKeys, `${errorPath}.integrity`);
  if (!HASH.test(value.integrity.businessSha256 ?? "") || !HASH.test(value.integrity.sha256 ?? "")) fail("INVALID_HASH", `${errorPath}.integrity`, "integrity hashes required");
  if (value.integrity.businessSha256 !== expectedId) fail(code, `${errorPath}.integrity.businessSha256`, "business hash mismatch");
  if (value.integrity.sha256 !== fullIntegrityHash(value)) fail(code, `${errorPath}.integrity.sha256`, "artifact hash mismatch");
}

export function sourceRunBusinessView(sourceRun) {
  return {
    sourceId: sourceRun.sourceId,
    provider: sourceRun.provider,
    sourceClass: sourceRun.sourceClass,
    adapterId: sourceRun.adapterId,
    adapterVersion: sourceRun.adapterVersion,
    asOf: sourceRun.asOf,
    status: sourceRun.status,
    sourceUrl: normalizeCanonicalUrl(sourceRun.sourceUrl),
    marketScopes: sortedUnique(sourceRun.marketScopes),
    topics: sortedUnique(sourceRun.topics),
    coverage: { itemCount: sourceRun.coverage.itemCount, note: sourceRun.coverage.note },
    snapshotPolicy: sourceRun.snapshotPolicy,
    rawSnapshotId: sourceRun.rawSnapshotId
  };
}

export function sourceRunStableArtifactView(sourceRun) {
  return {
    sourceRunId: sourceRun.sourceRunId,
    ...sourceRunBusinessView(sourceRun),
    integrity: { businessSha256: sourceRun.integrity.businessSha256 }
  };
}

export function computeSourceRunId(sourceRun) {
  return sha256Canonical(sourceRunBusinessView(sourceRun));
}

export function validateSourceRun(sourceRun, registry) {
  validateResearchContractRegistry(registry);
  assertNoForbidden(sourceRun, registry, "sourceRun");
  const schema = registrySchema(registry, "research-source-run-v1");
  assertKeys(sourceRun, schema.requiredKeys, schema.allowedKeys, "sourceRun");
  for (const key of ["sourceRunId", "sourceId", "provider", "adapterId", "adapterVersion", "sourceUrl"]) assertString(sourceRun[key], `sourceRun.${key}`);
  assertHash(sourceRun.sourceRunId, "sourceRun.sourceRunId");
  if (!SLUG.test(sourceRun.adapterId)) fail("INVALID_FORMAT", "sourceRun.adapterId", "invalid adapter ID");
  if (!ADAPTER_VERSION.test(sourceRun.adapterVersion)) fail("INVALID_FORMAT", "sourceRun.adapterVersion", "invalid adapter version");
  assertEnum(sourceRun.sourceClass, enumValues(registry, "sourceClass"), "sourceRun.sourceClass");
  assertTimestamp(sourceRun.requestedAt, "sourceRun.requestedAt");
  assertTimestamp(sourceRun.asOf, "sourceRun.asOf", true);
  assertEnum(sourceRun.status, enumValues(registry, "sourceRunStatus"), "sourceRun.status");
  assertCanonicalUrl(sourceRun.sourceUrl, "sourceRun.sourceUrl");
  assertEnumArray(sourceRun.marketScopes, enumValues(registry, "marketScope"), "sourceRun.marketScopes");
  assertEnumArray(sourceRun.topics, enumValues(registry, "topic"), "sourceRun.topics");
  assertKeys(sourceRun.coverage, schema.coverageRequiredKeys, schema.coverageAllowedKeys, "sourceRun.coverage");
  if (!Number.isInteger(sourceRun.coverage.itemCount) || sourceRun.coverage.itemCount < 0) fail("INVALID_TYPE", "sourceRun.coverage.itemCount", "nonnegative integer required");
  assertString(sourceRun.coverage.note, "sourceRun.coverage.note");
  assertEnum(sourceRun.snapshotPolicy, enumValues(registry, "snapshotPolicy"), "sourceRun.snapshotPolicy");
  assertWarnings(sourceRun.warnings, "sourceRun.warnings");
  const unavailable = new Set(["unavailable", "rate_limited", "schema_changed"]);
  if (unavailable.has(sourceRun.status)) {
    if (sourceRun.rawSnapshotId !== null || sourceRun.snapshotPolicy !== "none" || sourceRun.coverage.itemCount !== 0 || !sourceRun.warnings.length) fail("SOURCE_RUN_STATUS", "sourceRun", "unavailable source run mismatch");
  } else {
    assertHash(sourceRun.rawSnapshotId, "sourceRun.rawSnapshotId");
    if (sourceRun.snapshotPolicy === "none") fail("SOURCE_RUN_POLICY", "sourceRun.snapshotPolicy", "snapshot policy required");
  }
  const expected = computeSourceRunId(sourceRun);
  if (sourceRun.sourceRunId !== expected) fail("SOURCE_RUN_ID", "sourceRun.sourceRunId", "source run ID mismatch");
  validateIntegrity(sourceRun, expected, "sourceRun", "SOURCE_RUN_INTEGRITY", schema.integrityRequiredKeys, schema.integrityAllowedKeys);
  return sourceRun;
}

export function documentBusinessView(document) {
  return {
    sourceRunId: document.sourceRunId,
    canonicalUrl: normalizeCanonicalUrl(document.canonicalUrl),
    publishedAt: document.publishedAt,
    contentHashBasis: document.contentHashBasis,
    contentHashVersion: document.contentHashVersion,
    contentSha256: document.contentSha256
  };
}

export function documentStableArtifactView(document) {
  return {
    documentId: document.documentId,
    ...objectWithout(document, new Set(["documentId", "accessedAt", "warnings", "integrity"])),
    integrity: { businessSha256: document.integrity.businessSha256 }
  };
}

export function computeDocumentId(document) {
  return sha256Canonical(documentBusinessView(document));
}

export function validateDocument(document, sourceRuns, registry) {
  validateResearchContractRegistry(registry);
  assertNoForbidden(document, registry, "document");
  const schema = registrySchema(registry, "research-document-v1");
  assertKeys(document, schema.requiredKeys, schema.allowedKeys, "document");
  for (const key of ["documentId", "sourceRunId", "sourceId", "publisherId", "publisher", "title", "canonicalUrl", "contentHashBasis", "contentHashVersion", "contentSha256", "rawSnapshotId"]) assertString(document[key], `document.${key}`);
  assertHash(document.documentId, "document.documentId");
  assertHash(document.contentSha256, "document.contentSha256");
  assertHash(document.rawSnapshotId, "document.rawSnapshotId");
  if (!SLUG.test(document.publisherId)) fail("DOCUMENT_PUBLISHER", "document.publisherId", "invalid publisher ID");
  assertCanonicalUrl(document.canonicalUrl, "document.canonicalUrl");
  assertTimestamp(document.publishedAt, "document.publishedAt", true);
  assertTimestamp(document.accessedAt, "document.accessedAt");
  assertEnum(document.language, enumValues(registry, "language"), "document.language");
  assertEnum(document.contentType, enumValues(registry, "contentType"), "document.contentType");
  assertEnum(document.contentHashBasis, enumValues(registry, "contentHashBasis"), "document.contentHashBasis");
  assertEnum(document.contentHashVersion, enumValues(registry, "contentHashVersion"), "document.contentHashVersion");
  if (document.contentHashBasis === "metadata-only" && document.contentType !== "pdf-metadata") fail("DOCUMENT_HASH_BASIS", "document.contentHashBasis", "metadata-only requires pdf metadata");
  if (document.contentType === "pdf-metadata" && document.contentHashBasis !== "metadata-only") fail("DOCUMENT_HASH_BASIS", "document.contentHashBasis", "pdf metadata requires metadata-only");
  assertEnumArray(document.marketScopes, enumValues(registry, "marketScope"), "document.marketScopes");
  assertEnumArray(document.topics, enumValues(registry, "topic"), "document.topics");
  assertWarnings(document.warnings, "document.warnings");
  const runs = sourceRuns instanceof Map ? sourceRuns : new Map(sourceRuns.map((run) => [run.sourceRunId, run]));
  const sourceRun = runs.get(document.sourceRunId);
  if (!sourceRun) fail("DOCUMENT_SOURCE_RUN", "document.sourceRunId", "unknown source run");
  if (sourceRun.sourceId !== document.sourceId) fail("DOCUMENT_SOURCE_ID", "document.sourceId", "source ID mismatch");
  const expected = computeDocumentId(document);
  if (document.documentId !== expected) fail("DOCUMENT_ID", "document.documentId", "document ID mismatch");
  validateIntegrity(document, expected, "document", "DOCUMENT_INTEGRITY", schema.integrityRequiredKeys, schema.integrityAllowedKeys);
  return document;
}

export function observationBusinessView(observation) {
  return {
    kind: observation.kind,
    subject: observation.subject,
    statement: observation.statement,
    occurredAt: observation.occurredAt,
    asOf: observation.asOf,
    marketScopes: sortedUnique(observation.marketScopes),
    topics: sortedUnique(observation.topics),
    entities: sortedUnique(observation.entities),
    evidenceState: observation.evidenceState,
    basis: [...observation.basis].sort((left, right) => codePointCompare(`${left.documentId}\u0000${left.relation}\u0000${left.locator}\u0000${left.excerpt}`, `${right.documentId}\u0000${right.relation}\u0000${right.locator}\u0000${right.excerpt}`)).map((basis) => ({ documentId: basis.documentId, relation: basis.relation, excerpt: basis.excerpt, locator: basis.locator }))
  };
}

export function computeObservationId(observation) {
  return sha256Canonical(observationBusinessView(observation));
}

export function eventBusinessView(event) {
  return { eventType: event.eventType, title: event.title, occurredAt: event.occurredAt, marketScopes: sortedUnique(event.marketScopes), topics: sortedUnique(event.topics), observationIds: sortedUnique(event.observationIds) };
}

export function computeEventId(event) {
  return sha256Canonical(eventBusinessView(event));
}

export function duplicateClusterBusinessView(cluster) {
  return { method: cluster.method, canonicalDocumentId: cluster.canonicalDocumentId, memberDocumentIds: sortedUnique(cluster.memberDocumentIds) };
}

export function computeClusterId(cluster) {
  return sha256Canonical(duplicateClusterBusinessView(cluster));
}

function clusterLookup(clusters) {
  const byDocument = new Map();
  const byId = new Map();
  for (const cluster of clusters ?? []) {
    byId.set(cluster.clusterId, cluster);
    for (const id of cluster.memberDocumentIds) byDocument.set(id, cluster);
  }
  return { byDocument, byId };
}

function sourceClassFor(document, sourceRuns) {
  return sourceRuns.get(document.sourceRunId)?.sourceClass;
}

function independentPublisherId(document, documents, clusters) {
  const cluster = clusters.byDocument.get(document.documentId);
  if (!cluster) return document.publisherId;
  return documents.get(cluster.canonicalDocumentId)?.publisherId ?? document.publisherId;
}

export function deriveEvidenceState(observation, { documents, sourceRuns, duplicateClusters = [] }) {
  const documentMap = documents instanceof Map ? documents : new Map(documents.map((document) => [document.documentId, document]));
  const runMap = sourceRuns instanceof Map ? sourceRuns : new Map(sourceRuns.map((run) => [run.sourceRunId, run]));
  const clusters = clusterLookup(duplicateClusters);
  const references = observation.basis.map((basis) => ({ basis, document: documentMap.get(basis.documentId) })).filter((entry) => entry.document);
  const supports = references.filter((entry) => entry.basis.relation === "supports");
  const contradicts = references.filter((entry) => entry.basis.relation === "contradicts");
  const qualified = new Set();
  for (const entry of contradicts) {
    const sourceClass = sourceClassFor(entry.document, runMap);
    if (QUALIFIED_CONTRADICTIONS.has(sourceClass)) qualified.add(`${clusters.byDocument.get(entry.document.documentId)?.clusterId ?? entry.document.documentId}\u0000${independentPublisherId(entry.document, documentMap, clusters)}`);
  }
  if (qualified.size) return "conflicting";
  if (supports.some((entry) => AUTHORITATIVE.has(sourceClassFor(entry.document, runMap)))) return "confirmed";
  const publishers = new Set();
  for (const entry of supports) {
    if (ELIGIBLE_PUBLISHERS.has(sourceClassFor(entry.document, runMap))) publishers.add(independentPublisherId(entry.document, documentMap, clusters));
  }
  if (publishers.size >= 2) return "corroborated";
  if (supports.length && supports.every((entry) => ["community-signal", "social-signal"].includes(sourceClassFor(entry.document, runMap)))) return "unverified";
  return "single-source";
}

function validateObservation(observation, context, index) {
  const { registry, documents, sourceRuns, duplicateClusters, bundleAsOf } = context;
  const schema = registrySchema(registry, "research-bundle-v1");
  const errorPath = `observations[${index}]`;
  assertKeys(observation, schema.observationRequiredKeys, schema.observationAllowedKeys, errorPath);
  for (const key of ["observationId", "subject", "statement"]) assertString(observation[key], `${errorPath}.${key}`);
  assertHash(observation.observationId, `${errorPath}.observationId`);
  assertEnum(observation.kind, enumValues(registry, "observationKind"), `${errorPath}.kind`);
  if (observation.statement.length > registry.limits.statementMaxCharacters) fail("OBSERVATION_LIMIT", `${errorPath}.statement`, "statement too long");
  assertDate(observation.asOf, `${errorPath}.asOf`);
  if (observation.asOf > bundleAsOf) fail("OBSERVATION_TIME", `${errorPath}.asOf`, "observation after bundle");
  assertTimestamp(observation.occurredAt, `${errorPath}.occurredAt`, true);
  assertEnum(observation.evidenceState, enumValues(registry, "evidenceState"), `${errorPath}.evidenceState`);
  assertEnumArray(observation.marketScopes, enumValues(registry, "marketScope"), `${errorPath}.marketScopes`, { nonempty: true });
  assertEnumArray(observation.topics, enumValues(registry, "topic"), `${errorPath}.topics`, { nonempty: true });
  if (observation.kind === "calendar-event" && !observation.topics.includes("calendar")) fail("OBSERVATION_TIME", `${errorPath}.topics`, "calendar topic required");
  assertArray(observation.entities, `${errorPath}.entities`);
  for (let entityIndex = 0; entityIndex < observation.entities.length; entityIndex += 1) {
    assertString(observation.entities[entityIndex], `${errorPath}.entities[${entityIndex}]`);
    if (observation.entities[entityIndex].length > registry.limits.entityMaxCharacters) fail("OBSERVATION_LIMIT", `${errorPath}.entities[${entityIndex}]`, "entity too long");
  }
  assertSortedUnique(observation.entities, `${errorPath}.entities`);
  assertWarnings(observation.warnings, `${errorPath}.warnings`);
  assertArray(observation.basis, `${errorPath}.basis`);
  if (!observation.basis.length) fail("OBSERVATION_BASIS", `${errorPath}.basis`, "basis required");
  const basisKeys = new Set();
  let supportCount = 0;
  for (let basisIndex = 0; basisIndex < observation.basis.length; basisIndex += 1) {
    const basis = observation.basis[basisIndex];
    const basisPath = `${errorPath}.basis[${basisIndex}]`;
    assertKeys(basis, schema.basisRequiredKeys, schema.basisAllowedKeys, basisPath);
    for (const key of schema.basisRequiredKeys) assertString(basis[key], `${basisPath}.${key}`);
    assertEnum(basis.relation, enumValues(registry, "basisRelation"), `${basisPath}.relation`);
    if (basis.excerpt.length > registry.limits.excerptMaxCharacters || basis.locator.length > registry.limits.locatorMaxCharacters) fail("OBSERVATION_LIMIT", basisPath, "basis too long");
    if (!documents.has(basis.documentId)) fail("OBSERVATION_REFERENCE", `${basisPath}.documentId`, "unknown document");
    const identity = `${basis.documentId}\u0000${basis.relation}\u0000${basis.locator}\u0000${basis.excerpt}`;
    if (basisKeys.has(identity)) fail("OBSERVATION_BASIS", basisPath, "duplicate basis");
    basisKeys.add(identity);
    if (basis.relation === "supports") supportCount += 1;
  }
  if (!supportCount) fail("OBSERVATION_BASIS", `${errorPath}.basis`, "support required");
  const expectedState = deriveEvidenceState(observation, { documents, sourceRuns, duplicateClusters });
  if (observation.evidenceState !== expectedState) fail("OBSERVATION_STATE", `${errorPath}.evidenceState`, "evidence state mismatch");
  if (observation.occurredAt !== null && new Date(observation.occurredAt) > shanghaiEnd(bundleAsOf)) {
    if (observation.kind !== "calendar-event") fail("OBSERVATION_TIME", `${errorPath}.occurredAt`, "future occurrence");
    const timelySupport = observation.basis.filter((basis) => basis.relation === "supports").map((basis) => documents.get(basis.documentId)).some((document) => document.publishedAt !== null && new Date(document.publishedAt) <= shanghaiEnd(bundleAsOf));
    if (!timelySupport) fail("OBSERVATION_TIME", `${errorPath}.occurredAt`, "calendar support published late");
  }
  const expectedId = computeObservationId(observation);
  if (observation.observationId !== expectedId) fail("OBSERVATION_ID", `${errorPath}.observationId`, "observation ID mismatch");
  return observation;
}

function validateCluster(cluster, context, index, occupied) {
  const { registry, documents } = context;
  const schema = registrySchema(registry, "research-bundle-v1");
  const errorPath = `duplicateClusters[${index}]`;
  assertKeys(cluster, schema.duplicateClusterRequiredKeys, schema.duplicateClusterAllowedKeys, errorPath);
  for (const key of ["clusterId", "method", "canonicalDocumentId"]) assertString(cluster[key], `${errorPath}.${key}`);
  assertHash(cluster.clusterId, `${errorPath}.clusterId`);
  assertEnum(cluster.method, enumValues(registry, "duplicateClusterMethod"), `${errorPath}.method`);
  assertArray(cluster.memberDocumentIds, `${errorPath}.memberDocumentIds`);
  if (cluster.memberDocumentIds.length < registry.limits.minimumDocumentsPerDuplicateCluster) fail("CLUSTER_REFERENCE", `${errorPath}.memberDocumentIds`, "cluster needs two documents");
  assertSortedUnique(cluster.memberDocumentIds, `${errorPath}.memberDocumentIds`);
  if (!cluster.memberDocumentIds.includes(cluster.canonicalDocumentId)) fail("CLUSTER_CANONICAL", `${errorPath}.canonicalDocumentId`, "canonical member missing");
  const members = cluster.memberDocumentIds.map((id) => {
    const document = documents.get(id);
    if (!document) fail("CLUSTER_REFERENCE", `${errorPath}.memberDocumentIds`, "unknown document");
    if (occupied.has(id)) fail("CLUSTER_OVERLAP", `${errorPath}.memberDocumentIds`, "document in another cluster");
    occupied.add(id);
    return document;
  });
  const canonical = documents.get(cluster.canonicalDocumentId);
  const expectedCanonical = [...members].sort((left, right) => {
    if (left.publishedAt === null && right.publishedAt !== null) return 1;
    if (left.publishedAt !== null && right.publishedAt === null) return -1;
    if (left.publishedAt !== right.publishedAt) return codePointCompare(left.publishedAt ?? "", right.publishedAt ?? "");
    return codePointCompare(left.documentId, right.documentId);
  })[0];
  if (canonical.documentId !== expectedCanonical.documentId) fail("CLUSTER_CANONICAL", `${errorPath}.canonicalDocumentId`, "wrong canonical document");
  const sameUrl = members.every((document) => document.canonicalUrl === canonical.canonicalUrl);
  const sameHash = members.every((document) => document.contentSha256 === canonical.contentSha256);
  if (cluster.method === "exact-url" && !sameUrl) fail("CLUSTER_METHOD", `${errorPath}.method`, "exact URL mismatch");
  if (cluster.method === "content-hash" && !sameHash) fail("CLUSTER_METHOD", `${errorPath}.method`, "content hash mismatch");
  if (METHOD_PRIORITY.get(cluster.method) > METHOD_PRIORITY.get("exact-url") && sameUrl) fail("CLUSTER_METHOD", `${errorPath}.method`, "higher priority exact URL exists");
  if (METHOD_PRIORITY.get(cluster.method) > METHOD_PRIORITY.get("content-hash") && sameHash) fail("CLUSTER_METHOD", `${errorPath}.method`, "higher priority content hash exists");
  const expected = computeClusterId(cluster);
  if (cluster.clusterId !== expected) fail("CLUSTER_ID", `${errorPath}.clusterId`, "cluster ID mismatch");
  return cluster;
}

function validateEvent(event, context, index) {
  const { registry, observations, bundleAsOf } = context;
  const schema = registrySchema(registry, "research-bundle-v1");
  const errorPath = `events[${index}]`;
  assertKeys(event, schema.eventRequiredKeys, schema.eventAllowedKeys, errorPath);
  for (const key of ["eventId", "title"]) assertString(event[key], `${errorPath}.${key}`);
  assertHash(event.eventId, `${errorPath}.eventId`);
  assertEnum(event.eventType, enumValues(registry, "eventType"), `${errorPath}.eventType`);
  assertTimestamp(event.occurredAt, `${errorPath}.occurredAt`, true);
  assertEnumArray(event.marketScopes, enumValues(registry, "marketScope"), `${errorPath}.marketScopes`, { nonempty: true });
  assertEnumArray(event.topics, enumValues(registry, "topic"), `${errorPath}.topics`, { nonempty: true });
  assertArray(event.observationIds, `${errorPath}.observationIds`);
  if (!event.observationIds.length) fail("EVENT_REFERENCE", `${errorPath}.observationIds`, "observation required");
  assertSortedUnique(event.observationIds, `${errorPath}.observationIds`);
  const members = event.observationIds.map((id) => {
    const observation = observations.get(id);
    if (!observation) fail("EVENT_REFERENCE", `${errorPath}.observationIds`, "unknown observation");
    return observation;
  });
  if (event.occurredAt !== null && new Date(event.occurredAt) > shanghaiEnd(bundleAsOf) && members.some((observation) => observation.kind !== "calendar-event")) fail("EVENT_TIME", `${errorPath}.occurredAt`, "future event requires calendar observations");
  const expected = computeEventId(event);
  if (event.eventId !== expected) fail("EVENT_ID", `${errorPath}.eventId`, "event ID mismatch");
  return event;
}

function assertSortedIds(items, key, errorPath) {
  const ids = items.map((item) => item[key]);
  const sorted = [...ids].sort(codePointCompare);
  if (new Set(ids).size !== ids.length) fail("DUPLICATE_ID", errorPath, "duplicate identity");
  if (ids.some((id, index) => id !== sorted[index])) fail("UNSORTED_ARRAY", errorPath, "array not sorted");
}

function validateCoverage(coverage, context) {
  const { registry, documents, observations, sourceRuns, events, clusters } = context;
  const schema = registrySchema(registry, "research-bundle-v1");
  assertKeys(coverage, schema.coverageRequiredKeys, schema.coverageAllowedKeys, "coverage");
  assertArray(coverage.markets, "coverage.markets");
  assertArray(coverage.topics, "coverage.topics");
  assertKeys(coverage.totals, schema.coverageTotalsRequiredKeys, schema.coverageTotalsAllowedKeys, "coverage.totals");
  const marketEnum = enumValues(registry, "marketScope");
  const topicEnum = enumValues(registry, "topic");
  const seenMarkets = new Set();
  for (let index = 0; index < coverage.markets.length; index += 1) {
    const entry = coverage.markets[index];
    const entryPath = `coverage.markets[${index}]`;
    assertKeys(entry, schema.coverageMarketRequiredKeys, schema.coverageMarketAllowedKeys, entryPath);
    assertEnum(entry.market, marketEnum, `${entryPath}.market`);
    if (seenMarkets.has(entry.market)) fail("COVERAGE_MARKETS", `${entryPath}.market`, "duplicate market");
    seenMarkets.add(entry.market);
    assertEnum(entry.status, enumValues(registry, "coverageStatus"), `${entryPath}.status`);
    for (const key of ["documentCount", "observationCount"]) if (!Number.isInteger(entry[key]) || entry[key] < 0) fail("COVERAGE_COUNT", `${entryPath}.${key}`, "nonnegative integer required");
    assertWarnings(entry.reasons, `${entryPath}.reasons`);
    if ((entry.status === "partial" || entry.status === "unavailable") && !entry.reasons.length) fail("COVERAGE_STATUS", `${entryPath}.reasons`, "reasons required");
    if (entry.status === "ready" && entry.reasons.length) fail("COVERAGE_STATUS", `${entryPath}.reasons`, "ready reasons must be empty");
    const documentCount = [...documents.values()].filter((document) => document.marketScopes.includes(entry.market)).length;
    const observationCount = [...observations.values()].filter((observation) => observation.marketScopes.includes(entry.market)).length;
    if (entry.documentCount !== documentCount || entry.observationCount !== observationCount) fail("COVERAGE_COUNT", entryPath, "market count mismatch");
  }
  const expectedMarkets = ["A_SHARE", "HK", "US", "FED"];
  if (!expectedMarkets.every((market) => seenMarkets.has(market)) || coverage.markets.length !== expectedMarkets.length + (seenMarkets.has("GLOBAL") ? 1 : 0)) fail("COVERAGE_MARKETS", "coverage.markets", "required markets missing");
  const marketOrder = coverage.markets.map((entry) => marketEnum.indexOf(entry.market));
  if (marketOrder.some((value, index) => index && value <= marketOrder[index - 1])) fail("UNSORTED_ARRAY", "coverage.markets", "markets not enum sorted");
  const seenTopics = new Set();
  for (let index = 0; index < coverage.topics.length; index += 1) {
    const entry = coverage.topics[index];
    const entryPath = `coverage.topics[${index}]`;
    assertKeys(entry, schema.coverageTopicRequiredKeys, schema.coverageTopicAllowedKeys, entryPath);
    assertEnum(entry.topic, topicEnum, `${entryPath}.topic`);
    if (seenTopics.has(entry.topic)) fail("COVERAGE_TOPICS", `${entryPath}.topic`, "duplicate topic");
    seenTopics.add(entry.topic);
    assertEnum(entry.status, enumValues(registry, "coverageStatus"), `${entryPath}.status`);
    for (const key of ["documentCount", "observationCount"]) if (!Number.isInteger(entry[key]) || entry[key] < 0) fail("COVERAGE_COUNT", `${entryPath}.${key}`, "nonnegative integer required");
    assertWarnings(entry.reasons, `${entryPath}.reasons`);
    if ((entry.status === "partial" || entry.status === "unavailable") && !entry.reasons.length) fail("COVERAGE_STATUS", `${entryPath}.reasons`, "reasons required");
    if (entry.status === "ready" && entry.reasons.length) fail("COVERAGE_STATUS", `${entryPath}.reasons`, "ready reasons must be empty");
    const documentCount = [...documents.values()].filter((document) => document.topics.includes(entry.topic)).length;
    const observationCount = [...observations.values()].filter((observation) => observation.topics.includes(entry.topic)).length;
    if (entry.documentCount !== documentCount || entry.observationCount !== observationCount) fail("COVERAGE_COUNT", entryPath, "topic count mismatch");
  }
  const actualTopics = new Set([...documents.values()].flatMap((document) => document.topics).concat([...observations.values()].flatMap((observation) => observation.topics)));
  if (![...actualTopics].every((topic) => seenTopics.has(topic))) fail("COVERAGE_TOPICS", "coverage.topics", "missing observed topic");
  const topicOrder = coverage.topics.map((entry) => topicEnum.indexOf(entry.topic));
  if (topicOrder.some((value, index) => index && value <= topicOrder[index - 1])) fail("UNSORTED_ARRAY", "coverage.topics", "topics not enum sorted");
  const expectedTotals = { sourceRuns: sourceRuns.size, documents: documents.size, observations: observations.size, events: events.size, duplicateClusters: clusters.length, conflictingObservations: [...observations.values()].filter((observation) => observation.evidenceState === "conflicting").length };
  for (const [key, expected] of Object.entries(expectedTotals)) if (coverage.totals[key] !== expected) fail("COVERAGE_COUNT", `coverage.totals.${key}`, "total mismatch");
}

export function bundleBusinessView(bundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    edition: bundle.edition,
    asOf: bundle.asOf,
    window: { start: bundle.window.start, end: bundle.window.end, timezone: bundle.window.timezone },
    sourcePolicyVersion: bundle.sourcePolicyVersion,
    sourceRunIds: [...bundle.sourceRuns].map((sourceRun) => sourceRun.sourceRunId).sort(codePointCompare),
    documentIds: [...bundle.documents].map((document) => document.documentId).sort(codePointCompare),
    observations: [...bundle.observations].sort((left, right) => codePointCompare(left.observationId, right.observationId)).map(observationBusinessView),
    events: [...bundle.events].sort((left, right) => codePointCompare(left.eventId, right.eventId)).map(eventBusinessView),
    duplicateClusters: [...bundle.duplicateClusters].sort((left, right) => codePointCompare(left.clusterId, right.clusterId)).map(duplicateClusterBusinessView),
    coverage: bundle.coverage
  };
}

export function bundleStableArtifactView(bundle) {
  return {
    schemaVersion: bundle.schemaVersion,
    edition: bundle.edition,
    asOf: bundle.asOf,
    window: bundle.window,
    sourcePolicyVersion: bundle.sourcePolicyVersion,
    sourceRuns: bundle.sourceRuns.map(sourceRunStableArtifactView),
    documents: bundle.documents.map(documentStableArtifactView),
    observations: bundle.observations.map((observation) => ({ observationId: observation.observationId, ...observationBusinessView(observation) })),
    events: bundle.events.map((event) => ({ eventId: event.eventId, ...eventBusinessView(event) })),
    duplicateClusters: bundle.duplicateClusters.map((cluster) => ({ clusterId: cluster.clusterId, ...duplicateClusterBusinessView(cluster) })),
    coverage: bundle.coverage,
    bundleId: bundle.bundleId,
    integrity: { businessSha256: bundle.integrity.businessSha256 }
  };
}

export function computeBundleId(bundle) {
  return sha256Canonical(bundleBusinessView(bundle));
}

export function validateBundle(bundle, registry) {
  validateResearchContractRegistry(registry);
  assertNoForbidden(bundle, registry, "bundle");
  const schema = registrySchema(registry, "research-bundle-v1");
  assertKeys(bundle, schema.requiredKeys, schema.allowedKeys, "bundle");
  if (bundle.schemaVersion !== registry.bundleSchemaVersion) fail("BUNDLE_POLICY_VERSION", "bundle.schemaVersion", "bundle schema mismatch");
  assertEnum(bundle.edition, enumValues(registry, "edition"), "bundle.edition");
  assertDate(bundle.asOf, "bundle.asOf");
  assertTimestamp(bundle.generatedAt, "bundle.generatedAt");
  assertKeys(bundle.window, schema.windowRequiredKeys, schema.windowAllowedKeys, "bundle.window");
  assertDate(bundle.window.start, "bundle.window.start");
  assertDate(bundle.window.end, "bundle.window.end");
  if (bundle.window.timezone !== registry.limits.timezone || bundle.window.end !== bundle.asOf || bundle.window.start > bundle.window.end) fail("BUNDLE_WINDOW", "bundle.window", "invalid bundle window");
  if (bundle.sourcePolicyVersion !== registry.sourcePolicyVersion) fail("BUNDLE_POLICY_VERSION", "bundle.sourcePolicyVersion", "source policy mismatch");
  assertWarnings(bundle.warnings, "bundle.warnings");
  for (const key of ["sourceRuns", "documents", "observations", "events", "duplicateClusters"]) assertArray(bundle[key], `bundle.${key}`);
  assertSortedIds(bundle.sourceRuns, "sourceRunId", "bundle.sourceRuns");
  const sourceRuns = new Map();
  for (const sourceRun of bundle.sourceRuns) sourceRuns.set(validateSourceRun(sourceRun, registry).sourceRunId, sourceRun);
  assertSortedIds(bundle.documents, "documentId", "bundle.documents");
  const documents = new Map();
  for (const document of bundle.documents) documents.set(validateDocument(document, sourceRuns, registry).documentId, document);
  assertSortedIds(bundle.duplicateClusters, "clusterId", "bundle.duplicateClusters");
  const occupied = new Set();
  for (let index = 0; index < bundle.duplicateClusters.length; index += 1) validateCluster(bundle.duplicateClusters[index], { registry, documents }, index, occupied);
  assertSortedIds(bundle.observations, "observationId", "bundle.observations");
  const observations = new Map();
  for (let index = 0; index < bundle.observations.length; index += 1) observations.set(validateObservation(bundle.observations[index], { registry, documents, sourceRuns, duplicateClusters: bundle.duplicateClusters, bundleAsOf: bundle.asOf }, index).observationId, bundle.observations[index]);
  assertSortedIds(bundle.events, "eventId", "bundle.events");
  const events = new Map();
  for (let index = 0; index < bundle.events.length; index += 1) events.set(validateEvent(bundle.events[index], { registry, observations, bundleAsOf: bundle.asOf }, index).eventId, bundle.events[index]);
  validateCoverage(bundle.coverage, { registry, documents, observations, sourceRuns, events, clusters: bundle.duplicateClusters });
  assertHash(bundle.bundleId, "bundle.bundleId");
  const expected = computeBundleId(bundle);
  if (bundle.bundleId !== expected) fail("BUNDLE_ID", "bundle.bundleId", "bundle ID mismatch");
  validateIntegrity(bundle, expected, "bundle", "BUNDLE_INTEGRITY", schema.integrityRequiredKeys, schema.integrityAllowedKeys);
  return bundle;
}

export function compareImmutableCandidate(kind, existing, candidate, registry) {
  const variants = {
    sourceRun: { validate: validateSourceRun, id: "sourceRunId", stable: sourceRunStableArtifactView },
    document: { validate: (value) => validateDocument(value, [existing], registry), id: "documentId", stable: documentStableArtifactView },
    bundle: { validate: validateBundle, id: "bundleId", stable: bundleStableArtifactView }
  };
  const variant = variants[kind];
  if (!variant) fail("INVALID_TYPE", "kind", "unknown immutable kind");
  if (kind === "document") {
    const runs = new Map([[existing.sourceRunId, { sourceRunId: existing.sourceRunId, sourceId: existing.sourceId }], [candidate.sourceRunId, { sourceRunId: candidate.sourceRunId, sourceId: candidate.sourceId }]]);
    validateDocument(existing, runs, registry);
    validateDocument(candidate, runs, registry);
  } else {
    variant.validate(existing, registry);
    variant.validate(candidate, registry);
  }
  if (existing.integrity.businessSha256 !== candidate.integrity.businessSha256) fail("IMMUTABLE_CONFLICT", kind, "business identity conflict");
  if (canonicalJson(variant.stable(existing)) !== canonicalJson(variant.stable(candidate))) fail("IMMUTABLE_CONFLICT", kind, "stable artifact conflict");
  return { noOp: true, reused: true, artifact: existing };
}

export function validateResearchContractRegistry(registry) {
  assertObject(registry, "registry");
  const required = ["schemaVersion", "sourceRunSchemaVersion", "documentSchemaVersion", "bundleSchemaVersion", "sourcePolicyVersion", "storage", "enums", "schemas", "identity", "evidenceStateRules", "limits", "sourcePolicy", "writerContextBoundary", "forbiddenKeys"];
  for (const key of required) if (!Object.hasOwn(registry, key)) fail("REGISTRY_SCHEMA", `registry.${key}`, "registry key missing");
  if (registry.schemaVersion !== "research-contract-v1" || registry.sourceRunSchemaVersion !== "research-source-run-v1" || registry.documentSchemaVersion !== "research-document-v1" || registry.bundleSchemaVersion !== "research-bundle-v1" || registry.sourcePolicyVersion !== "research-source-policy-v1") fail("REGISTRY_SCHEMA", "registry", "schema version mismatch");
  assertArray(registry.forbiddenKeys, "registry.forbiddenKeys");
  for (const value of registry.forbiddenKeys) assertString(value, "registry.forbiddenKeys");
  for (const name of ["research-source-run-v1", "research-document-v1", "research-bundle-v1"]) {
    const schema = registrySchema(registry, name);
    for (const key of Object.keys(schema)) if ((key.endsWith("RequiredKeys") || key.endsWith("AllowedKeys")) && !Array.isArray(schema[key])) fail("REGISTRY_SCHEMA", `schemas.${name}.${key}`, "key list required");
    if (!Array.isArray(schema.requiredKeys) || !Array.isArray(schema.allowedKeys) || schema.requiredKeys.some((key) => !schema.allowedKeys.includes(key))) fail("REGISTRY_SCHEMA", `schemas.${name}`, "invalid key registry");
  }
  for (const name of ["sourceClass", "sourceRunStatus", "snapshotPolicy", "language", "contentType", "contentHashBasis", "contentHashVersion", "observationKind", "basisRelation", "evidenceState", "eventType", "duplicateClusterMethod", "edition", "marketScope", "topic", "coverageStatus"]) {
    const values = enumValues(registry, name);
    if (!values.length || values.some((value) => typeof value !== "string")) fail("REGISTRY_SCHEMA", `enums.${name}`, "invalid enum");
  }
  return registry;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    fail("INVALID_TYPE", file, "invalid JSON file");
  }
}

function cliArgs() {
  const args = process.argv.slice(3);
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) continue;
    parsed[args[index].slice(2)] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

function runCli() {
  const [command] = process.argv.slice(2);
  const args = cliArgs();
  const registry = readJson(path.join(moduleRoot, "data", "research-bundles", "contract.json"));
  if (command === "validate-registry") {
    validateResearchContractRegistry(registry);
    console.log(JSON.stringify({ valid: true, schemaVersion: registry.schemaVersion }));
    return;
  }
  if (command === "validate-bundle" && typeof args.file === "string") {
    const bundle = readJson(path.resolve(process.cwd(), args.file));
    validateBundle(bundle, registry);
    console.log(JSON.stringify({ valid: true, schemaVersion: bundle.schemaVersion, bundleId: bundle.bundleId, edition: bundle.edition, asOf: bundle.asOf }));
    return;
  }
  fail("INVALID_TYPE", "command", "usage: validate-registry | validate-bundle --file <path>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    runCli();
  } catch (cause) {
    if (cause instanceof ResearchContractError) console.error(`${cause.code} ${cause.path} ${cause.message}`);
    else console.error(`INVALID_TYPE command ${cause instanceof Error ? cause.message : "unexpected failure"}`);
    process.exitCode = 1;
  }
}
