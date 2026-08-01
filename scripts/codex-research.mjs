import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  canonicalJson,
  computeBundleId,
  computeDocumentId,
  computeObservationId,
  computeSourceRunId,
  normalizeCanonicalUrl,
  normalizeTimestamp,
  sha256Canonical,
  validateBundle,
  validateDocument,
  validateResearchContractRegistry,
  validateSourceRun
} from "./research-contract.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const contractFile = path.join(repositoryRoot, "data", "codex-research", "contract.json");
const bundleContractFile = path.join(repositoryRoot, "data", "research-bundles", "contract.json");
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const MAX_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SOURCE_CLASSES = new Set([
  "official-primary",
  "company-filing",
  "exchange-market-data",
  "primary-research",
  "major-media",
  "specialist-media",
  "vendor-market-data",
  "vendor-estimate",
  "community-signal",
  "social-signal"
]);
const AUTHORITATIVE = new Set(["official-primary", "company-filing", "exchange-market-data", "primary-research"]);
const CORROBORATING = new Set(["major-media", "specialist-media", "vendor-market-data", "vendor-estimate"]);

let writeImmutableResearchArtifacts;

async function loadResearchPipelineStorage() {
  if (!writeImmutableResearchArtifacts) ({ writeImmutableResearchArtifacts } = await import("./research-pipeline.mjs"));
  return writeImmutableResearchArtifacts;
}

export class CodexResearchError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "CodexResearchError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new CodexResearchError(code, errorPath, message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertObject(value, errorPath) {
  if (!plainObject(value)) fail("INVALID_TYPE", errorPath, "object required");
}

function assertKeys(value, required, allowed, errorPath) {
  assertObject(value, errorPath);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("MISSING_KEY", `${errorPath}.${key}`, "required key missing");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("UNKNOWN_KEY", `${errorPath}.${key}`, "unknown key");
}

function assertString(value, errorPath, { max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_STRING", errorPath, "nonempty string required");
  if (value.length > max) fail("LIMIT", errorPath, "string exceeds contract limit");
}

function assertHash(value, errorPath) {
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_HASH", errorPath, "lowercase SHA-256 required");
}

function assertDate(value, errorPath) {
  if (typeof value !== "string" || !DATE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).valueOf())) fail("INVALID_DATE", errorPath, "YYYY-MM-DD required");
}

function assertTimestamp(value, errorPath, nullable = false) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !MAX_TIMESTAMP.test(value) || value !== new Date(value).toISOString()) fail("INVALID_TIMESTAMP", errorPath, "canonical UTC timestamp required");
}

function assertEnum(value, values, errorPath) {
  if (!values.includes(value)) fail("INVALID_ENUM", errorPath, "invalid enum");
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => {
    const a = Array.from(left);
    const b = Array.from(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
      if (difference) return difference;
    }
    return a.length - b.length;
  });
}

function assertSortedUnique(values, errorPath) {
  const expected = sortedUnique(values);
  if (!Array.isArray(values) || values.length !== expected.length || values.some((value, index) => value !== expected[index])) fail("UNSORTED_ARRAY", errorPath, "sorted unique array required");
}

function normalizeUrl(value, errorPath) {
  try {
    const normalized = normalizeCanonicalUrl(value);
    if (normalized !== value) fail("NON_CANONICAL_URL", errorPath, "URL is not canonical");
    return normalized;
  } catch (cause) {
    if (cause instanceof CodexResearchError) throw cause;
    fail("INVALID_URL", errorPath, "canonical HTTPS URL required");
  }
}

function normalizeDate(value, errorPath) {
  if (value === null) return null;
  assertDate(value, errorPath);
  return value;
}

function normalizeTime(value, errorPath) {
  if (value === null) return null;
  try {
    return normalizeTimestamp(value);
  } catch {
    fail("INVALID_TIMESTAMP", errorPath, "timestamp with timezone required");
  }
}

function assertNoForbidden(value, contract, errorPath = "$") {
  const forbidden = new Set(contract.forbiddenKeys);
  const visit = (current, currentPath) => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`));
      return;
    }
    if (!plainObject(current)) return;
    for (const [key, item] of Object.entries(current)) {
      if (forbidden.has(key)) fail("FORBIDDEN_KEY", `${currentPath}.${key}`, "full article, credential, or model field is forbidden");
      visit(item, `${currentPath}.${key}`);
    }
  };
  visit(value, errorPath);
}

function readJson(file, code = "INVALID_JSON") {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(code, file, "JSON is invalid or unreadable");
  }
}

function loadCodexResearchContract(file = contractFile) {
  const contract = readJson(file);
  validateCodexResearchContract(contract);
  return contract;
}

export function validateCodexResearchContract(contract) {
  assertObject(contract, "contract");
  if (contract.schemaVersion !== "codex-research-contract-v1") fail("CONTRACT_VERSION", "contract.schemaVersion", "unsupported Codex research contract");
  for (const key of ["sourceClass", "observationKind", "marketScope", "topic", "relation", "evidenceState", "contentType"]) {
    if (!Array.isArray(contract[key]) || !contract[key].length || contract[key].some((entry) => typeof entry !== "string")) fail("CONTRACT_ENUM", `contract.${key}`, "nonempty string enum required");
  }
  assertObject(contract.limits, "contract.limits");
  assertObject(contract.identity, "contract.identity");
  assertObject(contract.storage, "contract.storage");
  assertObject(contract.sourcePolicy, "contract.sourcePolicy");
  if (!Array.isArray(contract.forbiddenKeys) || contract.forbiddenKeys.some((key) => typeof key !== "string")) fail("CONTRACT_FORBIDDEN_KEYS", "contract.forbiddenKeys", "string array required");
  for (const key of ["titleMaxCharacters", "claimMaxCharacters", "excerptMaxCharacters", "locatorMaxCharacters", "subjectMaxCharacters", "entityMaxCharacters", "documentCountMax", "factCountMax", "observationCountMax"]) if (!Number.isInteger(contract.limits[key]) || contract.limits[key] < 1) fail("CONTRACT_LIMIT", `contract.limits.${key}`, "positive integer required");
  if (contract.limits.timezone !== "Asia/Shanghai") fail("CONTRACT_TIMEZONE", "contract.limits.timezone", "Asia/Shanghai is required");
  return contract;
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function gzipCanonical(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function fullIntegrityHash(value) {
  return sha256Canonical({ ...value, integrity: { businessSha256: value.integrity.businessSha256 } });
}

function sealIntegrity(value, businessSha256) {
  const sealed = { ...value, integrity: { businessSha256, sha256: "" } };
  sealed.integrity.sha256 = fullIntegrityHash(sealed);
  return sealed;
}

function endOfShanghai(asOf) {
  return new Date(`${asOf}T23:59:59.999+08:00`).toISOString();
}

function normalizeWindow(candidate, asOf, contract) {
  assertObject(candidate, "window");
  assertKeys(candidate, ["start", "end", "timezone"], ["start", "end", "timezone"], "window");
  assertDate(candidate.start, "window.start");
  assertDate(candidate.end, "window.end");
  if (candidate.end !== asOf || candidate.start > candidate.end) fail("WINDOW", "window", "window end must equal asOf and start may not be after end");
  if (candidate.timezone !== contract.limits.timezone) fail("WINDOW_TIMEZONE", "window.timezone", "Asia/Shanghai is required");
  return { start: candidate.start, end: candidate.end, timezone: candidate.timezone };
}

const DOCUMENT_KEYS = ["accessedAt", "canonicalUrl", "contentSha256", "contentType", "documentId", "evidenceClass", "evidenceExcerpt", "integrity", "language", "marketScopes", "publishedAt", "publishedDate", "publisher", "publisherId", "rawSnapshotId", "sourceId", "sourceRunId", "sourceUrl", "title", "topics", "warnings"];
const FACT_KEYS = ["accessedAt", "claimText", "contentSha256", "documentId", "evidenceClass", "factId", "marketScopes", "publishedAt", "publishedDate", "publisher", "sourceId", "sourceUrl", "subject", "topics", "unit", "value"];
const OBSERVATION_KEYS = ["asOf", "basis", "documentIds", "entities", "evidenceState", "kind", "marketScopes", "observationId", "occurredAt", "sourceIds", "statement", "subject", "topics"];
const BASIS_KEYS = ["documentId", "excerpt", "locator", "relation", "sourceId"];
const RUN_KEYS = ["asOf", "bundleId", "documents", "edition", "evidenceRecords", "facts", "generatedAt", "integrity", "observations", "researchRunId", "schemaVersion", "sourceRuns", "warnings", "window"];

function normalizeScopes(value, contract, errorPath) {
  if (!Array.isArray(value) || !value.length) fail("INVALID_ARRAY", errorPath, "nonempty market scope array required");
  for (const entry of value) assertEnum(entry, contract.marketScope, `${errorPath}[]`);
  const normalized = sortedUnique(value);
  if (normalized.length !== value.length || normalized.some((entry, index) => entry !== value[index])) fail("UNSORTED_ARRAY", errorPath, "sorted unique market scope array required");
  return normalized;
}

function normalizeTopics(value, contract, errorPath) {
  if (!Array.isArray(value) || !value.length) fail("INVALID_ARRAY", errorPath, "nonempty topic array required");
  for (const entry of value) assertEnum(entry, contract.topic, `${errorPath}[]`);
  const normalized = sortedUnique(value);
  if (normalized.length !== value.length || normalized.some((entry, index) => entry !== value[index])) fail("UNSORTED_ARRAY", errorPath, "sorted unique topic array required");
  return normalized;
}

function normalizeDocumentInput(document, contract, index) {
  const errorPath = `documents[${index}]`;
  assertKeys(document, ["accessedAt", "contentSha256", "evidenceClass", "evidenceExcerpt", "marketScopes", "publisher", "publisherId", "sourceId", "sourceUrl", "title", "topics"], ["accessedAt", "canonicalUrl", "contentSha256", "contentType", "documentId", "evidenceClass", "evidenceExcerpt", "language", "marketScopes", "publishedAt", "publishedDate", "publisher", "publisherId", "rawSnapshotId", "sourceId", "sourceRunId", "sourceUrl", "title", "topics"], errorPath);
  if (!SLUG.test(document.sourceId)) fail("INVALID_SLUG", `${errorPath}.sourceId`, "sourceId must be a stable slug");
  const sourceUrl = normalizeUrl(document.sourceUrl, `${errorPath}.sourceUrl`);
  const canonicalUrl = normalizeUrl(document.canonicalUrl ?? sourceUrl, `${errorPath}.canonicalUrl`);
  assertString(document.publisher, `${errorPath}.publisher`, { max: 200 });
  if (!SLUG.test(document.publisherId)) fail("INVALID_SLUG", `${errorPath}.publisherId`, "publisherId must be a stable slug");
  assertString(document.title, `${errorPath}.title`, { max: contract.limits.titleMaxCharacters });
  assertString(document.evidenceExcerpt, `${errorPath}.evidenceExcerpt`, { max: contract.limits.excerptMaxCharacters });
  assertHash(document.contentSha256, `${errorPath}.contentSha256`);
  assertEnum(document.evidenceClass, contract.sourceClass, `${errorPath}.evidenceClass`);
  assertEnum(document.contentType ?? "json", contract.contentType, `${errorPath}.contentType`);
  assertEnum(document.language ?? "zh", ["zh", "en", "mixed", "other"], `${errorPath}.language`);
  const publishedAt = normalizeTime(document.publishedAt ?? null, `${errorPath}.publishedAt`);
  const publishedDate = normalizeDate(document.publishedDate ?? null, `${errorPath}.publishedDate`);
  if (publishedAt === null && publishedDate === null) fail("PUBLICATION_DATE", errorPath, "publishedAt or publishedDate is required");
  const accessedAt = normalizeTime(document.accessedAt, `${errorPath}.accessedAt`);
  const marketScopes = normalizeScopes(document.marketScopes, contract, `${errorPath}.marketScopes`);
  const topics = normalizeTopics(document.topics, contract, `${errorPath}.topics`);
  return {
    sourceId: document.sourceId,
    sourceUrl,
    canonicalUrl,
    publisherId: document.publisherId,
    publisher: document.publisher,
    title: document.title,
    publishedAt,
    publishedDate,
    accessedAt,
    contentSha256: document.contentSha256,
    evidenceClass: document.evidenceClass,
    evidenceExcerpt: document.evidenceExcerpt,
    contentType: document.contentType ?? "json",
    language: document.language ?? "zh",
    marketScopes,
    topics
  };
}

function documentStableInput(document) {
  return {
    canonicalUrl: document.canonicalUrl,
    contentSha256: document.contentSha256,
    contentType: document.contentType,
    evidenceClass: document.evidenceClass,
    evidenceExcerpt: document.evidenceExcerpt,
    language: document.language,
    marketScopes: document.marketScopes,
    publishedAt: document.publishedAt,
    publishedDate: document.publishedDate,
    publisher: document.publisher,
    publisherId: document.publisherId,
    sourceId: document.sourceId,
    sourceUrl: document.sourceUrl,
    title: document.title,
    topics: document.topics
  };
}

function normalizeFactInput(fact, documentsBySourceId, documentsById, contract, index) {
  const errorPath = `facts[${index}]`;
  assertKeys(fact, ["accessedAt", "claimText", "contentSha256", "evidenceClass", "publisher", "sourceUrl"], FACT_KEYS, errorPath);
  const document = fact.documentId ? documentsById.get(fact.documentId) : documentsBySourceId.get(fact.sourceId);
  if (!document) fail("FACT_DOCUMENT", `${errorPath}.documentId`, "fact must reference a known documentId or sourceId");
  if (fact.sourceId !== undefined && fact.sourceId !== document.sourceId) fail("FACT_BINDING", `${errorPath}.sourceId`, "fact sourceId does not match document");
  if (fact.documentId !== undefined && fact.documentId !== document.documentId) fail("FACT_BINDING", `${errorPath}.documentId`, "fact documentId does not match document");
  const sourceUrl = normalizeUrl(fact.sourceUrl, `${errorPath}.sourceUrl`);
  if (sourceUrl !== document.sourceUrl) fail("FACT_BINDING", `${errorPath}.sourceUrl`, "fact sourceUrl does not match document");
  assertString(fact.publisher, `${errorPath}.publisher`, { max: 200 });
  if (fact.publisher !== document.publisher) fail("FACT_BINDING", `${errorPath}.publisher`, "fact publisher does not match document");
  const publishedAt = normalizeTime(fact.publishedAt ?? null, `${errorPath}.publishedAt`);
  const publishedDate = normalizeDate(fact.publishedDate ?? null, `${errorPath}.publishedDate`);
  if (publishedAt !== document.publishedAt || publishedDate !== document.publishedDate) fail("FACT_BINDING", errorPath, "fact publication metadata does not match document");
  const accessedAt = normalizeTime(fact.accessedAt, `${errorPath}.accessedAt`);
  if (accessedAt !== document.accessedAt) fail("FACT_BINDING", `${errorPath}.accessedAt`, "fact accessedAt does not match document");
  assertHash(fact.contentSha256, `${errorPath}.contentSha256`);
  if (fact.contentSha256 !== document.contentSha256) fail("FACT_BINDING", `${errorPath}.contentSha256`, "fact content hash does not match document");
  assertEnum(fact.evidenceClass, contract.sourceClass, `${errorPath}.evidenceClass`);
  if (fact.evidenceClass !== document.evidenceClass) fail("FACT_BINDING", `${errorPath}.evidenceClass`, "fact evidence class does not match document");
  assertString(fact.claimText, `${errorPath}.claimText`, { max: contract.limits.claimMaxCharacters });
  assertString(fact.subject ?? "fact", `${errorPath}.subject`, { max: contract.limits.subjectMaxCharacters });
  const marketScopes = fact.marketScopes === undefined ? document.marketScopes : normalizeScopes(fact.marketScopes, contract, `${errorPath}.marketScopes`);
  const topics = fact.topics === undefined ? document.topics : normalizeTopics(fact.topics, contract, `${errorPath}.topics`);
  const output = {
    factId: "",
    sourceId: document.sourceId,
    documentId: document.documentId,
    sourceUrl,
    publisher: fact.publisher,
    publishedAt,
    publishedDate,
    accessedAt,
    claimText: fact.claimText,
    evidenceClass: fact.evidenceClass,
    contentSha256: fact.contentSha256,
    subject: fact.subject ?? "fact",
    marketScopes,
    topics
  };
  if (Object.hasOwn(fact, "value")) output.value = fact.value;
  if (Object.hasOwn(fact, "unit")) {
    assertString(fact.unit, `${errorPath}.unit`, { max: 40 });
    output.unit = fact.unit;
  }
  delete output.factId;
  output.factId = sha256Canonical(output);
  return output;
}

function basisSort(left, right) {
  return `${left.documentId}\u0000${left.relation}\u0000${left.locator}\u0000${left.excerpt}`.localeCompare(`${right.documentId}\u0000${right.relation}\u0000${right.locator}\u0000${right.excerpt}`);
}

function derivedEvidenceState(basis, documentsById) {
  const supports = basis.filter((item) => item.relation === "supports").map((item) => documentsById.get(item.documentId));
  const contradicts = basis.filter((item) => item.relation === "contradicts");
  if (contradicts.length) return "conflicting";
  if (supports.some((document) => AUTHORITATIVE.has(document.evidenceClass))) return "confirmed";
  const publishers = new Set(supports.filter((document) => CORROBORATING.has(document.evidenceClass)).map((document) => document.publisherId));
  if (publishers.size >= 2) return "corroborated";
  if (supports.length && supports.every((document) => ["community-signal", "social-signal"].includes(document.evidenceClass))) return "unverified";
  return "single-source";
}

function normalizeBasis(input, documentsBySourceId, documentsById, contract, errorPath) {
  if (!Array.isArray(input) || !input.length) fail("OBSERVATION_BASIS", errorPath, "at least one basis is required");
  const basis = input.map((item, index) => {
    assertKeys(item, ["excerpt", "locator", "relation"], BASIS_KEYS, `${errorPath}[${index}]`);
    const document = item.documentId ? documentsById.get(item.documentId) : documentsBySourceId.get(item.sourceId);
    if (!document) fail("OBSERVATION_DOCUMENT", `${errorPath}[${index}]`, "basis must reference a known document");
    assertEnum(item.relation, ["supports", "contradicts", "context"], `${errorPath}[${index}].relation`);
    assertString(item.locator, `${errorPath}[${index}].locator`, { max: contract.limits.locatorMaxCharacters });
    assertString(item.excerpt, `${errorPath}[${index}].excerpt`, { max: contract.limits.excerptMaxCharacters });
    if (item.excerpt === document.title) fail("TITLE_ONLY_EVIDENCE", `${errorPath}[${index}].excerpt`, "title-only evidence is not sufficient");
    return { documentId: document.documentId, relation: item.relation, locator: item.locator, excerpt: item.excerpt };
  }).sort(basisSort);
  const identities = basis.map((item) => `${item.documentId}\u0000${item.relation}\u0000${item.locator}\u0000${item.excerpt}`);
  if (new Set(identities).size !== identities.length) fail("DUPLICATE_BASIS", errorPath, "duplicate basis is not allowed");
  if (!basis.some((item) => item.relation === "supports")) fail("OBSERVATION_BASIS", errorPath, "at least one supporting basis is required");
  return basis;
}

function normalizeObservationInput(observation, documentsBySourceId, documentsById, contract, asOf, index) {
  const errorPath = `observations[${index}]`;
  assertKeys(observation, ["asOf", "basis", "kind", "marketScopes", "statement", "subject", "topics"], OBSERVATION_KEYS, errorPath);
  assertEnum(observation.kind, contract.observationKind, `${errorPath}.kind`);
  assertString(observation.subject, `${errorPath}.subject`, { max: contract.limits.subjectMaxCharacters });
  assertString(observation.statement, `${errorPath}.statement`, { max: contract.limits.claimMaxCharacters });
  assertDate(observation.asOf, `${errorPath}.asOf`);
  if (observation.asOf > asOf) fail("OBSERVATION_TIME", `${errorPath}.asOf`, "observation may not be after research asOf");
  const occurredAt = normalizeTime(observation.occurredAt ?? null, `${errorPath}.occurredAt`);
  const marketScopes = normalizeScopes(observation.marketScopes, contract, `${errorPath}.marketScopes`);
  const topics = normalizeTopics(observation.topics, contract, `${errorPath}.topics`);
  const entities = sortedUnique(observation.entities ?? []);
  for (const entity of entities) assertString(entity, `${errorPath}.entities[]`, { max: contract.limits.entityMaxCharacters });
  const basis = normalizeBasis(observation.basis, documentsBySourceId, documentsById, contract, `${errorPath}.basis`);
  const documentIds = sortedUnique(basis.map((item) => item.documentId));
  const documentTitles = new Set(documentIds.map((id) => documentsById.get(id).title));
  if (documentTitles.has(observation.statement)) fail("TITLE_ONLY_CAUSALITY", `${errorPath}.statement`, "observation statement may not be a document title");
  const evidenceState = derivedEvidenceState(basis, documentsById);
  const adapted = {
    kind: observation.kind,
    subject: observation.subject,
    statement: observation.statement,
    occurredAt,
    asOf: observation.asOf,
    marketScopes,
    topics,
    entities,
    evidenceState,
    basis
  };
  const observationId = computeObservationId({ observationId: "", ...adapted });
  return { observationId, ...adapted, documentIds, sourceIds: sortedUnique(documentIds.map((id) => documentsById.get(id).sourceId)) };
}

function boundedRecordFor(document, facts, observations) {
  return {
    schemaVersion: "codex-research-evidence-v1",
    sourceId: document.sourceId,
    sourceUrl: document.sourceUrl,
    document: documentStableInput(document),
    facts: facts.map((fact) => ({
      claimText: fact.claimText,
      contentSha256: fact.contentSha256,
      evidenceClass: fact.evidenceClass,
      subject: fact.subject,
      value: fact.value,
      unit: fact.unit
    })).map((fact) => Object.fromEntries(Object.entries(fact).filter(([, value]) => value !== undefined))),
    // Observations are derived from bounded documents and are deliberately not
    // copied into the raw snapshot.  This keeps the raw hash independent of
    // document/observation IDs and avoids an identity cycle.
    observations: []
  };
}

function sourceRunFor(document, rawSnapshotId, asOfTimestamp, now) {
  const candidate = {
    sourceRunId: "",
    sourceId: document.sourceId,
    provider: "Codex Researcher",
    adapterId: "codex-research",
    adapterVersion: "v1",
    sourceClass: document.evidenceClass,
    requestedAt: now,
    asOf: asOfTimestamp,
    status: "ready",
    sourceUrl: document.sourceUrl,
    marketScopes: document.marketScopes,
    topics: document.topics,
    coverage: { itemCount: 1, note: "bounded evidence record collected by local Codex Researcher" },
    snapshotPolicy: "stored",
    rawSnapshotId,
    warnings: []
  };
  candidate.sourceRunId = computeSourceRunId(candidate);
  return sealIntegrity(candidate, candidate.sourceRunId);
}

function existingDocumentFor(document, sourceRun) {
  const candidate = {
    documentId: "",
    sourceRunId: sourceRun.sourceRunId,
    sourceId: sourceRun.sourceId,
    publisherId: document.publisherId,
    publisher: document.publisher,
    title: document.title,
    canonicalUrl: document.canonicalUrl,
    publishedDate: document.publishedDate,
    publishedAt: document.publishedAt,
    accessedAt: document.accessedAt,
    language: document.language,
    contentType: "json",
    contentHashBasis: "structured-record",
    contentHashVersion: "v1",
    contentSha256: document.contentSha256,
    rawSnapshotId: sourceRun.rawSnapshotId,
    marketScopes: document.marketScopes,
    topics: document.topics,
    warnings: []
  };
  candidate.documentId = computeDocumentId(candidate);
  return sealIntegrity(candidate, candidate.documentId);
}

function sourceClassForDocument(document) {
  return document.evidenceClass;
}

function coverageStatus(sourceRuns) {
  if (!sourceRuns.length) return { status: "unavailable", reasons: ["no-enabled-source"] };
  if (sourceRuns.every((run) => run.status === "ready")) return { status: "ready", reasons: [] };
  if (sourceRuns.some((run) => run.status === "ready")) return { status: "partial", reasons: ["source-failure"] };
  return { status: "partial", reasons: ["source-partial-or-stale"] };
}

function buildCoverage(sourceRuns, documents, observations, contract) {
  const observedMarkets = new Set([...documents, ...observations].flatMap((item) => item.marketScopes));
  const markets = contract.marketScope.filter((market) => ["A_SHARE", "HK", "US", "FED"].includes(market) || observedMarkets.has(market)).map((market) => {
    const state = coverageStatus(sourceRuns.filter((run) => run.marketScopes.includes(market)));
    return {
      market,
      ...state,
      documentCount: documents.filter((document) => document.marketScopes.includes(market)).length,
      observationCount: observations.filter((observation) => observation.marketScopes.includes(market)).length
    };
  });
  const observedTopics = sortedUnique([...documents, ...observations].flatMap((item) => item.topics));
  const topics = contract.topic.filter((topic) => observedTopics.includes(topic)).map((topic) => {
    const state = coverageStatus(sourceRuns.filter((run) => run.topics.includes(topic)));
    return {
      topic,
      ...state,
      documentCount: documents.filter((document) => document.topics.includes(topic)).length,
      observationCount: observations.filter((observation) => observation.topics.includes(topic)).length
    };
  });
  return {
    markets,
    topics,
    totals: {
      sourceRuns: sourceRuns.length,
      documents: documents.length,
      observations: observations.length,
      events: 0,
      duplicateClusters: 0,
      conflictingObservations: observations.filter((observation) => observation.evidenceState === "conflicting").length
    }
  };
}

function codexFactBusinessView(fact) {
  return Object.fromEntries(Object.entries(fact).filter(([key]) => !["accessedAt"].includes(key)).sort(([left], [right]) => left.localeCompare(right)));
}

function codexObservationBusinessView(observation) {
  return {
    observationId: observation.observationId,
    asOf: observation.asOf,
    basis: observation.basis,
    documentIds: observation.documentIds,
    entities: observation.entities,
    evidenceState: observation.evidenceState,
    kind: observation.kind,
    marketScopes: observation.marketScopes,
    occurredAt: observation.occurredAt,
    statement: observation.statement,
    subject: observation.subject,
    topics: observation.topics
  };
}

export function codexResearchBusinessView(run) {
  return {
    schemaVersion: run.schemaVersion,
    edition: run.edition,
    asOf: run.asOf,
    window: run.window,
    documents: run.documents.map((document) => documentStableInput(document)).sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    facts: run.facts.map(codexFactBusinessView).sort((left, right) => left.factId.localeCompare(right.factId)),
    observations: run.observations.map(codexObservationBusinessView).sort((left, right) => left.observationId.localeCompare(right.observationId)),
    sourceRunIds: run.sourceRuns.map((sourceRun) => sourceRun.sourceRunId).sort()
  };
}

function runIntegrity(run) {
  return sealIntegrity(run, run.researchRunId);
}

function buildBundleFromParts({ edition, asOf, window, sourceRuns, documents, observations, generatedAt }, contract, bundleRegistry) {
  const adaptedDocuments = documents.map(({ evidenceClass: _evidenceClass, evidenceExcerpt: _evidenceExcerpt, sourceUrl: _sourceUrl, contentType: _contentType, ...document }) => ({ ...document, contentType: "json", contentHashBasis: "structured-record", contentHashVersion: "v1" })).sort((left, right) => left.documentId.localeCompare(right.documentId));
  const adaptedObservations = observations.map(({ documentIds: _documentIds, sourceIds: _sourceIds, ...observation }) => ({ ...observation, warnings: [] })).sort((left, right) => left.observationId.localeCompare(right.observationId));
  const bundle = {
    schemaVersion: bundleRegistry.bundleSchemaVersion,
    edition,
    asOf,
    generatedAt,
    window,
    sourcePolicyVersion: bundleRegistry.sourcePolicyVersion,
    sourceRuns: [...sourceRuns].sort((left, right) => left.sourceRunId.localeCompare(right.sourceRunId)),
    documents: adaptedDocuments,
    observations: adaptedObservations,
    events: [],
    duplicateClusters: [],
    coverage: buildCoverage(sourceRuns, documents, observations, contract),
    warnings: [],
    bundleId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  bundle.bundleId = computeBundleId(bundle);
  const sealed = sealIntegrity(bundle, bundle.bundleId);
  validateBundle(sealed, bundleRegistry);
  return sealed;
}

export function buildResearchBundleFromCodexRun(run, { generatedAt = run.generatedAt, root = repositoryRoot } = {}) {
  const contract = loadCodexResearchContract(path.join(root, "data", "codex-research", "contract.json"));
  const bundleRegistry = JSON.parse(fs.readFileSync(path.join(root, "data", "research-bundles", "contract.json"), "utf8"));
  validateResearchContractRegistry(bundleRegistry);
  validateCodexResearch(run, { contract, bundleRegistry });
  return buildBundleFromParts({ edition: run.edition, asOf: run.asOf, window: run.window, sourceRuns: run.sourceRuns, documents: run.documents, observations: run.observations, generatedAt }, contract, bundleRegistry);
}

export function sealCodexResearch(candidate, { now = new Date(), contract = loadCodexResearchContract() } = {}) {
  validateCodexResearchContract(contract);
  assertObject(candidate, "research");
  assertNoForbidden(candidate, contract);
  assertKeys(candidate, ["asOf", "documents", "edition", "facts", "observations", "window"], ["asOf", "documents", "edition", "facts", "generatedAt", "observations", "schemaVersion", "warnings", "window"], "research");
  if (candidate.schemaVersion !== undefined && candidate.schemaVersion !== contract.researchRunSchemaVersion) fail("SCHEMA_VERSION", "research.schemaVersion", "unsupported research run schema");
  assertEnum(candidate.edition, ["daily", "weekly"], "research.edition");
  assertDate(candidate.asOf, "research.asOf");
  const window = normalizeWindow(candidate.window, candidate.asOf, contract);
  if (!Array.isArray(candidate.documents) || candidate.documents.length < 1 || candidate.documents.length > contract.limits.documentCountMax) fail("DOCUMENT_COUNT", "research.documents", "document count is outside contract limit");
  if (!Array.isArray(candidate.facts) || candidate.facts.length > contract.limits.factCountMax) fail("FACT_COUNT", "research.facts", "fact count is outside contract limit");
  if (!Array.isArray(candidate.observations) || candidate.observations.length > contract.limits.observationCountMax) fail("OBSERVATION_COUNT", "research.observations", "observation count is outside contract limit");
  const nowIso = normalizeTimestamp(now.toISOString());
  const normalizedInputs = candidate.documents.map((document, index) => normalizeDocumentInput(document, contract, index));
  const sourceIds = normalizedInputs.map((document) => document.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) fail("DUPLICATE_SOURCE_ID", "research.documents", "each bounded source record needs a unique sourceId");
  const asOfTimestamp = endOfShanghai(candidate.asOf);
  const factsInput = candidate.facts;
  const factsBySource = new Map();
  for (const fact of factsInput) {
    const sourceId = fact.sourceId ?? normalizedInputs.find((document) => document.documentId === fact.documentId)?.sourceId;
    if (sourceId) factsBySource.set(sourceId, [...(factsBySource.get(sourceId) ?? []), fact]);
  }
  const sourceRuns = [];
  const documents = [];
  const sourceToDocument = new Map();
  const evidenceRecords = [];
  for (const inputDocument of normalizedInputs) {
    const preliminaryFacts = (factsBySource.get(inputDocument.sourceId) ?? []).map((fact) => ({
      claimText: fact.claimText,
      contentSha256: fact.contentSha256,
      evidenceClass: fact.evidenceClass,
      subject: fact.subject ?? "fact",
      value: fact.value,
      unit: fact.unit
    }));
    const bounded = boundedRecordFor(inputDocument, preliminaryFacts, []);
    const rawBytes = Buffer.from(canonicalJson(bounded), "utf8");
    const rawSnapshotId = hashBytes(rawBytes);
    const sourceRun = sourceRunFor(inputDocument, rawSnapshotId, asOfTimestamp, nowIso);
    const document = existingDocumentFor(inputDocument, sourceRun);
    const codexDocument = { ...inputDocument, documentId: document.documentId, sourceRunId: sourceRun.sourceRunId, rawSnapshotId: sourceRun.rawSnapshotId, warnings: [], integrity: document.integrity };
    sourceRuns.push(sourceRun);
    documents.push(codexDocument);
    sourceToDocument.set(inputDocument.sourceId, codexDocument);
    evidenceRecords.push({ sourceRunId: sourceRun.sourceRunId, rawSnapshotId, record: bounded });
  }
  const documentsBySourceId = new Map(documents.map((document) => [document.sourceId, document]));
  const documentsById = new Map(documents.map((document) => [document.documentId, document]));
  const facts = factsInput.map((fact, index) => normalizeFactInput(fact, documentsBySourceId, documentsById, contract, index)).sort((left, right) => left.factId.localeCompare(right.factId));
  const observations = candidate.observations.map((observation, index) => normalizeObservationInput(observation, documentsBySourceId, documentsById, contract, candidate.asOf, index)).sort((left, right) => left.observationId.localeCompare(right.observationId));
  for (const record of evidenceRecords) {
    const document = documents.find((item) => item.sourceRunId === record.sourceRunId);
    const relatedFacts = facts.filter((fact) => fact.documentId === document.documentId);
    const relatedObservations = observations.filter((observation) => observation.documentIds.includes(document.documentId));
    record.record = boundedRecordFor(document, relatedFacts, relatedObservations);
    const bytes = Buffer.from(canonicalJson(record.record), "utf8");
    record.rawSnapshotId = hashBytes(bytes);
    if (record.rawSnapshotId !== document.rawSnapshotId) {
      fail("RAW_ID_CYCLE", `evidenceRecords.${record.sourceRunId}`, "bounded evidence record changed after binding; provide facts before sealing");
    }
  }
  const bundle = buildBundleFromParts({ edition: candidate.edition, asOf: candidate.asOf, window, sourceRuns, documents, observations, generatedAt: nowIso }, contract, JSON.parse(fs.readFileSync(bundleContractFile, "utf8")));
  const runCandidate = {
    schemaVersion: contract.researchRunSchemaVersion,
    edition: candidate.edition,
    asOf: candidate.asOf,
    window,
    generatedAt: nowIso,
    sourceRuns: sourceRuns.sort((left, right) => left.sourceRunId.localeCompare(right.sourceRunId)),
    documents: documents.sort((left, right) => left.documentId.localeCompare(right.documentId)),
    facts,
    observations,
    evidenceRecords: evidenceRecords.sort((left, right) => left.sourceRunId.localeCompare(right.sourceRunId)),
    bundleId: bundle.bundleId,
    warnings: [],
    researchRunId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  runCandidate.researchRunId = sha256Canonical(codexResearchBusinessView(runCandidate));
  const sealed = runIntegrity(runCandidate);
  validateCodexResearch(sealed, { contract, bundleRegistry: JSON.parse(fs.readFileSync(bundleContractFile, "utf8")) });
  return sealed;
}

function validateCodexDocument(document, sourceRuns, contract, index) {
  const errorPath = `documents[${index}]`;
  assertKeys(document, DOCUMENT_KEYS, DOCUMENT_KEYS, errorPath);
  assertHash(document.documentId, `${errorPath}.documentId`);
  if (!SLUG.test(document.sourceId)) fail("INVALID_SLUG", `${errorPath}.sourceId`, "sourceId must be a stable slug");
  const sourceRun = sourceRuns.get(document.sourceRunId);
  if (!sourceRun) fail("DOCUMENT_SOURCE_RUN", `${errorPath}.sourceRunId`, "unknown source run");
  if (document.rawSnapshotId !== sourceRun.rawSnapshotId) fail("DOCUMENT_RAW_SNAPSHOT", `${errorPath}.rawSnapshotId`, "raw snapshot mismatch");
  normalizeUrl(document.sourceUrl, `${errorPath}.sourceUrl`);
  normalizeUrl(document.canonicalUrl, `${errorPath}.canonicalUrl`);
  assertString(document.evidenceExcerpt, `${errorPath}.evidenceExcerpt`, { max: contract.limits.excerptMaxCharacters });
  assertEnum(document.evidenceClass, contract.sourceClass, `${errorPath}.evidenceClass`);
  const adapted = { ...document };
  delete adapted.evidenceClass;
  delete adapted.evidenceExcerpt;
  delete adapted.sourceUrl;
  adapted.contentType = "json";
  adapted.contentHashBasis = "structured-record";
  adapted.contentHashVersion = "v1";
  validateDocument(adapted, sourceRuns, JSON.parse(fs.readFileSync(bundleContractFile, "utf8")));
  return document;
}

function validateFact(fact, documentsById, contract, index) {
  const errorPath = `facts[${index}]`;
  assertKeys(fact, ["accessedAt", "claimText", "contentSha256", "documentId", "evidenceClass", "factId", "marketScopes", "publishedAt", "publishedDate", "publisher", "sourceId", "sourceUrl", "subject", "topics"], FACT_KEYS, errorPath);
  assertHash(fact.factId, `${errorPath}.factId`);
  const document = documentsById.get(fact.documentId);
  if (!document) fail("FACT_DOCUMENT", `${errorPath}.documentId`, "fact references unknown document");
  for (const [key, value] of [["sourceUrl", fact.sourceUrl], ["publisher", fact.publisher], ["contentSha256", fact.contentSha256], ["evidenceClass", fact.evidenceClass]]) {
    const expected = key === "sourceUrl" ? document.sourceUrl : key === "evidenceClass" ? document.evidenceClass : document[key];
    if (value !== expected) fail("FACT_BINDING", `${errorPath}.${key}`, "fact metadata does not match document");
  }
  if (fact.publishedAt !== document.publishedAt || fact.publishedDate !== document.publishedDate || fact.accessedAt !== document.accessedAt) fail("FACT_BINDING", errorPath, "fact publication/access metadata does not match document");
  assertString(fact.claimText, `${errorPath}.claimText`, { max: contract.limits.claimMaxCharacters });
  assertString(fact.subject, `${errorPath}.subject`, { max: contract.limits.subjectMaxCharacters });
  assertHash(fact.contentSha256, `${errorPath}.contentSha256`);
  const copy = { ...fact };
  delete copy.factId;
  if (sha256Canonical(copy) !== fact.factId) fail("FACT_ID", `${errorPath}.factId`, "fact ID mismatch");
  return fact;
}

function validateObservationRecord(observation, documentsById, contract, index) {
  const errorPath = `observations[${index}]`;
  assertKeys(observation, OBSERVATION_KEYS, OBSERVATION_KEYS, errorPath);
  assertHash(observation.observationId, `${errorPath}.observationId`);
  assertEnum(observation.kind, contract.observationKind, `${errorPath}.kind`);
  assertString(observation.subject, `${errorPath}.subject`, { max: contract.limits.subjectMaxCharacters });
  assertString(observation.statement, `${errorPath}.statement`, { max: contract.limits.claimMaxCharacters });
  assertDate(observation.asOf, `${errorPath}.asOf`);
  assertTimestamp(observation.occurredAt, `${errorPath}.occurredAt`, true);
  normalizeScopes(observation.marketScopes, contract, `${errorPath}.marketScopes`);
  normalizeTopics(observation.topics, contract, `${errorPath}.topics`);
  assertSortedUnique(observation.documentIds, `${errorPath}.documentIds`);
  if (!observation.documentIds.length || observation.documentIds.some((id) => !documentsById.has(id))) fail("OBSERVATION_DOCUMENT", `${errorPath}.documentIds`, "unknown observation document");
  assertSortedUnique(observation.sourceIds, `${errorPath}.sourceIds`);
  const basis = normalizeBasis(observation.basis, new Map([...documentsById.values()].map((document) => [document.sourceId, document])), documentsById, contract, `${errorPath}.basis`);
  if (canonicalJson(basis) !== canonicalJson(observation.basis)) fail("UNSORTED_ARRAY", `${errorPath}.basis`, "basis is not canonical");
  if (sortedUnique(basis.map((item) => item.documentId)).join("\u0000") !== observation.documentIds.join("\u0000")) fail("OBSERVATION_DOCUMENT", `${errorPath}.documentIds`, "documentIds do not match basis");
  const expected = computeObservationId({ observationId: "", kind: observation.kind, subject: observation.subject, statement: observation.statement, occurredAt: observation.occurredAt, asOf: observation.asOf, marketScopes: observation.marketScopes, topics: observation.topics, entities: observation.entities, evidenceState: observation.evidenceState, basis: observation.basis });
  if (expected !== observation.observationId) fail("OBSERVATION_ID", `${errorPath}.observationId`, "observation ID mismatch");
  if (derivedEvidenceState(observation.basis, documentsById) !== observation.evidenceState) fail("OBSERVATION_STATE", `${errorPath}.evidenceState`, "evidence state mismatch");
  return observation;
}

export function validateCodexResearch(run, { contract = loadCodexResearchContract(), bundleRegistry = JSON.parse(fs.readFileSync(bundleContractFile, "utf8")) } = {}) {
  validateCodexResearchContract(contract);
  validateResearchContractRegistry(bundleRegistry);
  assertNoForbidden(run, contract);
  assertKeys(run, RUN_KEYS, RUN_KEYS, "research");
  if (run.schemaVersion !== contract.researchRunSchemaVersion) fail("SCHEMA_VERSION", "research.schemaVersion", "unsupported research run schema");
  assertEnum(run.edition, ["daily", "weekly"], "research.edition");
  assertDate(run.asOf, "research.asOf");
  normalizeWindow(run.window, run.asOf, contract);
  assertTimestamp(run.generatedAt, "research.generatedAt");
  if (!Array.isArray(run.warnings)) fail("INVALID_ARRAY", "research.warnings", "warnings array required");
  if (!Array.isArray(run.sourceRuns) || !Array.isArray(run.documents) || !Array.isArray(run.facts) || !Array.isArray(run.observations) || !Array.isArray(run.evidenceRecords)) fail("INVALID_ARRAY", "research", "research collections required");
  const sourceRuns = new Map();
  for (const sourceRun of run.sourceRuns) {
    validateSourceRun(sourceRun, bundleRegistry);
    if (sourceRuns.has(sourceRun.sourceRunId)) fail("DUPLICATE_ID", "research.sourceRuns", "duplicate sourceRunId");
    sourceRuns.set(sourceRun.sourceRunId, sourceRun);
  }
  const documentsById = new Map();
  for (let index = 0; index < run.documents.length; index += 1) {
    const document = validateCodexDocument(run.documents[index], sourceRuns, contract, index);
    if (documentsById.has(document.documentId)) fail("DUPLICATE_ID", `documents[${index}].documentId`, "duplicate documentId");
    documentsById.set(document.documentId, document);
  }
  if ([...documentsById.keys()].some((id, index, ids) => index && id.localeCompare(ids[index - 1]) < 0)) fail("UNSORTED_ARRAY", "research.documents", "documents must be sorted by documentId");
  const facts = run.facts.map((fact, index) => validateFact(fact, documentsById, contract, index));
  if (new Set(facts.map((fact) => fact.factId)).size !== facts.length) fail("DUPLICATE_ID", "research.facts", "duplicate factId");
  const observations = run.observations.map((observation, index) => validateObservationRecord(observation, documentsById, contract, index));
  if (new Set(observations.map((observation) => observation.observationId)).size !== observations.length) fail("DUPLICATE_ID", "research.observations", "duplicate observationId");
  const expectedSourceIds = sortedUnique(run.documents.map((document) => document.sourceId));
  if (expectedSourceIds.length !== run.documents.length) fail("DUPLICATE_SOURCE_ID", "research.documents", "sourceId must be unique");
  for (const record of run.evidenceRecords) {
    assertKeys(record, ["rawSnapshotId", "record", "sourceRunId"], ["rawSnapshotId", "record", "sourceRunId"], "research.evidenceRecords[]");
    assertHash(record.rawSnapshotId, "research.evidenceRecords[].rawSnapshotId");
    const sourceRun = sourceRuns.get(record.sourceRunId);
    if (!sourceRun || sourceRun.rawSnapshotId !== record.rawSnapshotId) fail("RAW_BINDING", "research.evidenceRecords[]", "evidence record does not bind source run");
    const bytes = Buffer.from(canonicalJson(record.record), "utf8");
    if (hashBytes(bytes) !== record.rawSnapshotId) fail("RAW_HASH", "research.evidenceRecords[].record", "bounded evidence record hash mismatch");
    assertNoForbidden(record.record, contract, "research.evidenceRecords[].record");
  }
  const expectedBundle = buildBundleFromParts({ edition: run.edition, asOf: run.asOf, window: run.window, sourceRuns: run.sourceRuns, documents: run.documents, observations: run.observations, generatedAt: run.generatedAt }, contract, bundleRegistry);
  if (expectedBundle.bundleId !== run.bundleId) fail("BUNDLE_ID", "research.bundleId", "adapted bundle ID mismatch");
  assertHash(run.researchRunId, "research.researchRunId");
  if (sha256Canonical(codexResearchBusinessView(run)) !== run.researchRunId) fail("RESEARCH_RUN_ID", "research.researchRunId", "research run ID mismatch");
  if (run.integrity?.businessSha256 !== run.researchRunId || run.integrity?.sha256 !== fullIntegrityHash(run)) fail("INTEGRITY", "research.integrity", "research integrity mismatch");
  return run;
}

export function runArtifactPath(run, root = repositoryRoot) {
  return path.join(root, "data", "codex-research", "runs", run.asOf.slice(0, 7).replace("-", "/"), `${run.researchRunId}.json.gz`);
}

function readGzipJson(file) {
  try {
    return JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
  } catch {
    fail("ARTIFACT_CORRUPT", file, "gzip JSON artifact is invalid");
  }
}

function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function planRunArtifact(run, root) {
  const file = runArtifactPath(run, root);
  const bytes = gzipCanonical(run);
  if (!fs.existsSync(file)) return { file, bytes, created: true, reused: false, shouldWrite: true };
  const existing = readGzipJson(file);
  validateCodexResearch(existing);
  if (Buffer.compare(fs.readFileSync(file), bytes) === 0) return { file, bytes, created: false, reused: true, shouldWrite: false };
  if (sha256Canonical(codexResearchBusinessView(existing)) !== sha256Canonical(codexResearchBusinessView(run))) fail("IMMUTABLE_CONFLICT", file, "existing research run has different business identity");
  return { file, bytes: fs.readFileSync(file), created: false, reused: true, shouldWrite: false };
}

function scanRunArtifacts(root) {
  const directory = path.join(root, "data", "codex-research", "runs");
  if (!fs.existsSync(directory)) return [];
  const entries = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".json.gz")) {
        const run = readGzipJson(file);
        validateCodexResearch(run);
        entries.push({ file, run, bytes: fs.readFileSync(file) });
      }
    }
  };
  visit(directory);
  return entries;
}

function runIndex(root, entries) {
  return {
    schemaVersion: "codex-research-index-v1",
    runs: entries.map(({ file, run, bytes }) => ({ id: run.researchRunId, edition: run.edition, asOf: run.asOf, artifactPath: path.relative(root, file).split(path.sep).join("/"), artifactSha256: hashBytes(bytes) })).sort((left, right) => left.id.localeCompare(right.id))
  };
}

export async function storeCodexResearchRun({ run, root = repositoryRoot, dryRun = false, write = false } = {}) {
  if (dryRun === write) fail("STORAGE_MODE", "mode", "exactly one of dryRun or write is required");
  const contract = loadCodexResearchContract(path.join(root, "data", "codex-research", "contract.json"));
  const bundleRegistry = JSON.parse(fs.readFileSync(path.join(root, "data", "research-bundles", "contract.json"), "utf8"));
  validateCodexResearch(run, { contract, bundleRegistry });
  const plan = planRunArtifact(run, root);
  const bundle = buildResearchBundleFromCodexRun(run, { root, generatedAt: run.generatedAt });
  const sourceResults = run.sourceRuns.map((sourceRun) => {
    const record = run.evidenceRecords.find((entry) => entry.sourceRunId === sourceRun.sourceRunId);
    if (!record) fail("RAW_BINDING", sourceRun.sourceRunId, "source run evidence record missing");
    const bytes = Buffer.from(canonicalJson(record.record), "utf8");
    return { source: { sourceId: sourceRun.sourceId, sourceUrl: sourceRun.sourceUrl, sourceClass: sourceRun.sourceClass, provider: sourceRun.provider, publisher: "Codex Researcher", publisherId: sourceRun.sourceId, marketScopes: sourceRun.marketScopes, topics: sourceRun.topics }, sourceRun, documents: run.documents.filter((document) => document.sourceRunId === sourceRun.sourceRunId).map(({ evidenceClass: _evidenceClass, evidenceExcerpt: _evidenceExcerpt, sourceUrl: _sourceUrl, contentType: _contentType, ...document }) => ({ ...document, contentType: "json", contentHashBasis: "structured-record", contentHashVersion: "v1" })), raw: { rawSnapshotId: sourceRun.rawSnapshotId, bytes, asOf: run.asOf } };
  });
  const writeResearch = await loadResearchPipelineStorage();
  const adaptedStorage = writeResearch({ sourceResults, bundle, root, dryRun });
  const existingEntries = scanRunArtifacts(root).filter((entry) => entry.run.researchRunId !== run.researchRunId);
  const index = runIndex(root, [...existingEntries, { file: plan.file, run, bytes: plan.bytes }]);
  const indexFile = path.join(root, "data", "codex-research", "index.json");
  const indexBytes = Buffer.from(`${canonicalJson(index)}\n`, "utf8");
  const indexChanged = !fs.existsSync(indexFile) || Buffer.compare(fs.readFileSync(indexFile), indexBytes) !== 0;
  const summary = {
    schemaVersion: "codex-research-store-summary-v1",
    researchRunId: run.researchRunId,
    bundleId: bundle.bundleId,
    artifactPath: path.relative(root, plan.file).split(path.sep).join("/"),
    created: plan.created ? [path.relative(root, plan.file).split(path.sep).join("/")] : [],
    reused: plan.reused ? [path.relative(root, plan.file).split(path.sep).join("/")] : [],
    wouldWrite: [...(plan.shouldWrite ? [path.relative(root, plan.file).split(path.sep).join("/")] : []), ...(indexChanged ? [path.relative(root, indexFile).split(path.sep).join("/")] : []), ...adaptedStorage.wouldWrite],
    adaptedStorage,
    dryRun
  };
  if (write) {
    if (plan.shouldWrite) atomicBytes(plan.file, plan.bytes);
    if (indexChanged) atomicBytes(indexFile, indexBytes);
  }
  return summary;
}

function writeJsonOutput(file, value) {
  if (!path.isAbsolute(file)) fail("CLI_ARGUMENT", "output", "absolute output path required");
  atomicBytes(file, Buffer.from(`${canonicalJson(value)}\n`, "utf8"));
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") continue;
    if (!args[index].startsWith("--")) fail("CLI_ARGUMENT", "arguments", "unknown positional argument");
    const key = args[index].slice(2);
    if (!key || Object.hasOwn(parsed, key)) fail("CLI_ARGUMENT", "arguments", "duplicate option");
    parsed[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

function only(args, keys, command) {
  if (Object.keys(args).some((key) => !keys.includes(key))) fail("CLI_ARGUMENT", command, "unknown option");
}

async function runCli() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "validate-contract") {
    only(args, [], command);
    const contract = loadCodexResearchContract();
    console.log(canonicalJson({ valid: true, schemaVersion: contract.schemaVersion }));
    return;
  }
  if (command === "validate") {
    only(args, ["file", "root"], command);
    if (typeof args.file !== "string") fail("CLI_ARGUMENT", command, "--file is required");
    const run = readJson(path.resolve(args.file));
    validateCodexResearch(run, { contract: loadCodexResearchContract(path.join(args.root ? path.resolve(args.root) : repositoryRoot, "data", "codex-research", "contract.json")), bundleRegistry: JSON.parse(fs.readFileSync(path.join(args.root ? path.resolve(args.root) : repositoryRoot, "data", "research-bundles", "contract.json"), "utf8")) });
    console.log(canonicalJson({ valid: true, researchRunId: run.researchRunId, bundleId: run.bundleId }));
    return;
  }
  if (command === "seal") {
    only(args, ["input", "output", "as-of", "edition"], command);
    if (typeof args.input !== "string" || typeof args.output !== "string") fail("CLI_ARGUMENT", command, "--input and --output are required");
    const input = readJson(path.resolve(args.input));
    if (args["as-of"] !== undefined) input.asOf = args["as-of"];
    if (args.edition !== undefined) input.edition = args.edition;
    const run = sealCodexResearch(input);
    writeJsonOutput(path.resolve(args.output), run);
    console.log(canonicalJson({ valid: true, researchRunId: run.researchRunId, bundleId: run.bundleId, output: path.resolve(args.output) }));
    return;
  }
  if (command === "store") {
    only(args, ["input", "root", "dry-run", "write", "output"], command);
    if (typeof args.input !== "string" || (args["dry-run"] !== true && args.write !== true) || (args["dry-run"] === true && args.write === true)) fail("CLI_ARGUMENT", command, "input and exactly one mode are required");
    const root = args.root ? path.resolve(args.root) : repositoryRoot;
    const run = readJson(path.resolve(args.input));
    const summary = await storeCodexResearchRun({ run, root, dryRun: args["dry-run"] === true, write: args.write === true });
    if (args.output !== undefined) writeJsonOutput(path.resolve(args.output), summary);
    console.log(canonicalJson(summary));
    return;
  }
  fail("CLI_ARGUMENT", "command", "usage: validate-contract | validate | seal | store");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    await runCli();
  } catch (cause) {
    console.error(cause instanceof Error ? `${cause.code ?? "CODEX_RESEARCH_FAILURE"} ${cause.path ?? "research"} ${cause.message}` : "CODEX_RESEARCH_FAILURE");
    process.exitCode = 1;
  }
}
