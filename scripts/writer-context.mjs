import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  canonicalJson,
  sha256Canonical,
  validateBundle,
  validateResearchContractRegistry
} from "./research-contract.mjs";
import { validateGlobalMarketBrief } from "./global-market-brief-contract.mjs";
import { validatePacket } from "./validate-writer-packet.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASELINE_SCHEMA = "baseline-content-v1";
const CONTEXT_SCHEMA = "writer-context-v1";
export const GLOBAL_MARKET_BRIEF_MODE = "global_market_brief";

export class WriterContextError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "WriterContextError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new WriterContextError(code, errorPath, message);
}

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, errorPath) {
  if (!isObject(value)) fail("INVALID_TYPE", errorPath, "object required");
}

function assertExactKeys(value, required, allowed, errorPath) {
  assertObject(value, errorPath);
  for (const key of required) if (!Object.hasOwn(value, key)) fail("MISSING_KEY", `${errorPath}.${key}`, "required key missing");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("UNKNOWN_KEY", `${errorPath}.${key}`, "unknown key");
}

function assertString(value, errorPath) {
  if (typeof value !== "string" || !value.length) fail("INVALID_TYPE", errorPath, "nonempty string required");
}

function assertHash(value, errorPath) {
  if (typeof value !== "string" || !HASH.test(value)) fail("INVALID_HASH", errorPath, "lowercase SHA-256 required");
}

function assertDate(value, errorPath) {
  if (typeof value !== "string" || !DATE.test(value)) fail("INVALID_DATE", errorPath, "YYYY-MM-DD required");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) fail("INVALID_DATE", errorPath, "calendar date invalid");
}

function assertTimestamp(value, errorPath) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || new Date(value).toISOString() !== value) fail("INVALID_TIMESTAMP", errorPath, "canonical UTC timestamp required");
}

function assertWarnings(value, errorPath) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.length)) fail("INVALID_TYPE", errorPath, "string array required");
  if (new Set(value).size !== value.length) fail("DUPLICATE_VALUE", errorPath, "warnings must be unique");
  const sorted = [...value].sort();
  if (value.some((item, index) => item !== sorted[index])) fail("UNSORTED_ARRAY", errorPath, "warnings must be sorted");
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fullArtifactView(value) {
  const { integrity, ...body } = value;
  return { ...body, integrity: { businessSha256: integrity?.businessSha256 } };
}

function computeFullIntegrity(value) {
  return sha256Canonical(fullArtifactView(value));
}

function deterministicGzip(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function readJsonBytes(bytes, errorPath) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("ARTIFACT_CORRUPT", errorPath, "invalid JSON");
  }
}

export function readJsonOrGzip(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    fail("ARTIFACT_MISSING", file, "artifact is missing");
  }
  if (file.endsWith(".gz")) {
    try {
      bytes = gunzipSync(bytes);
    } catch {
      fail("ARTIFACT_CORRUPT", file, "gzip is invalid");
    }
  }
  return readJsonBytes(bytes, file);
}

export function validateRepoRelativePath(value, errorPath = "path") {
  assertString(value, errorPath);
  if (value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail("UNSAFE_PATH", errorPath, "repository-relative forward-slash path required");
  const segments = value.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) fail("UNSAFE_PATH", errorPath, "path traversal or empty segment");
  if (path.posix.normalize(value) !== value) fail("UNSAFE_PATH", errorPath, "path is not normalized");
  return value;
}

function resolveRepoPath(root, relativePath, errorPath = "path") {
  validateRepoRelativePath(relativePath, errorPath);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split("/"));
  const relation = path.relative(resolvedRoot, resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) fail("UNSAFE_PATH", errorPath, "path escapes or equals repository root");
  return resolved;
}

function readJsonFile(file, code = "REGISTRY_SCHEMA") {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(code, file, "JSON file is missing or invalid");
  }
}

export function loadWriterContextRegistry(root = repositoryRoot) {
  return readJsonFile(path.join(root, "data", "writer-contexts", "contract.json"));
}

function editionPolicy(registry, edition, errorPath = "edition") {
  const policy = registry.editions?.[edition];
  if (!policy) fail("INVALID_EDITION", errorPath, "daily or weekly required");
  return policy;
}

function modePolicy(registry, mode, errorPath = "mode") {
  const policy = registry.modes?.[mode];
  if (!policy) fail("INVALID_MODE", errorPath, "unsupported writer mode");
  return policy;
}

export function validateWriterContextRegistry(registry) {
  const required = ["auditOnlyFields", "baselineSchemaVersion", "contextSchemaVersion", "editions", "pathPrefixes", "requestSchemaVersion", "resultSchemaVersion", "schemaVersion", "storage"];
  assertExactKeys(registry, required, [...required, "modes"], "registry");
  if (registry.schemaVersion !== "writer-context-contract-v1" || registry.baselineSchemaVersion !== BASELINE_SCHEMA || registry.contextSchemaVersion !== CONTEXT_SCHEMA || registry.requestSchemaVersion !== "writer-request-v2" || registry.resultSchemaVersion !== "writer-result-v2") fail("REGISTRY_SCHEMA", "registry", "schema version mismatch");
  assertExactKeys(registry.auditOnlyFields, ["baseline", "context"], ["baseline", "context"], "registry.auditOnlyFields");
  if (canonicalJson(registry.auditOnlyFields.baseline) !== canonicalJson(["capturedAt", "warnings"]) || canonicalJson(registry.auditOnlyFields.context) !== canonicalJson(["generatedAt", "warnings"])) fail("REGISTRY_SCHEMA", "registry.auditOnlyFields", "audit-only fields mismatch");
  assertExactKeys(registry.editions, ["daily", "weekly"], ["daily", "weekly"], "registry.editions");
  assertExactKeys(registry.editions.daily, ["baselineTarget", "promptPath", "targetSchemaVersion", "validatorPath"], ["baselineTarget", "promptPath", "targetSchemaVersion", "validatorPath"], "registry.editions.daily");
  assertExactKeys(registry.editions.weekly, ["baselineTargetPattern", "promptPath", "targetSchemaVersion", "validatorPath"], ["baselineTargetPattern", "promptPath", "targetSchemaVersion", "validatorPath"], "registry.editions.weekly");
  if (registry.editions.daily.baselineTarget !== "content/daily-brief.json" || registry.editions.weekly.baselineTargetPattern !== "^content/weekly-reports/weekly-[0-9]{4}-W[0-9]{2}\\.json$") fail("REGISTRY_SCHEMA", "registry.editions", "target allowlist mismatch");
  for (const edition of ["daily", "weekly"]) {
    const policy = registry.editions[edition];
    for (const key of ["promptPath", "validatorPath"]) validateRepoRelativePath(policy[key], `registry.editions.${edition}.${key}`);
    assertString(policy.targetSchemaVersion, `registry.editions.${edition}.targetSchemaVersion`);
  }
  if (registry.modes !== undefined) {
    assertExactKeys(registry.modes, [GLOBAL_MARKET_BRIEF_MODE], [GLOBAL_MARKET_BRIEF_MODE], "registry.modes");
    const global = registry.modes[GLOBAL_MARKET_BRIEF_MODE];
    assertExactKeys(global, ["baselineTarget", "edition", "promptPath", "targetSchemaVersion", "validatorMode", "validatorPath", "writerOutputSchemaVersion"], ["baselineTarget", "edition", "promptPath", "targetSchemaVersion", "validatorMode", "validatorPath", "writerOutputSchemaVersion"], "registry.modes.global_market_brief");
    if (global.edition !== "daily" || global.validatorMode !== GLOBAL_MARKET_BRIEF_MODE || global.targetSchemaVersion !== "global-market-brief-v1" || global.writerOutputSchemaVersion !== "global-market-brief-writer-output-v1") fail("REGISTRY_SCHEMA", "registry.modes.global_market_brief", "global writer mode policy mismatch");
    validateRepoRelativePath(global.baselineTarget, "registry.modes.global_market_brief.baselineTarget");
    for (const key of ["promptPath", "validatorPath"]) validateRepoRelativePath(global[key], `registry.modes.global_market_brief.${key}`);
  }
  assertExactKeys(registry.pathPrefixes, ["baseline", "context", "qualitativeResearchBundle", "quantitativeWriterPacket"], ["baseline", "context", "qualitativeResearchBundle", "quantitativeWriterPacket"], "registry.pathPrefixes");
  for (const [key, value] of Object.entries(registry.pathPrefixes)) {
    assertString(value, `registry.pathPrefixes.${key}`);
    if (!value.endsWith("/")) fail("REGISTRY_SCHEMA", `registry.pathPrefixes.${key}`, "prefix must end with slash");
    validateRepoRelativePath(`${value}sentinel`, `registry.pathPrefixes.${key}`);
  }
  assertExactKeys(registry.storage, ["baselineArtifact", "contextArtifact", "dailyLatest", "index", "weeklyLatest"], ["baselineArtifact", "contextArtifact", "dailyLatest", "index", "weeklyLatest"], "registry.storage");
  for (const [key, value] of Object.entries(registry.storage)) assertString(value, `registry.storage.${key}`);
  return registry;
}

function validateTargetPath(edition, targetPath, registry, mode = null) {
  validateRepoRelativePath(targetPath, "baseline.targetPath");
  if (mode === GLOBAL_MARKET_BRIEF_MODE) {
    const policy = modePolicy(registry, mode);
    const legacyFixture = "content/writer-contexts/fixtures/p2-b1-global-baseline.json";
    const realBaseline = "data/global-market-brief-baseline-v1.json";
    if (edition !== policy.edition || ![policy.baselineTarget, legacyFixture, realBaseline].includes(targetPath)) fail("TARGET_ALLOWLIST", "baseline.targetPath", "global writer target is not allowed");
    return;
  }
  const policy = editionPolicy(registry, edition);
  if (edition === "daily" && targetPath !== policy.baselineTarget) fail("TARGET_ALLOWLIST", "baseline.targetPath", "daily target is not allowed");
  if (edition === "weekly" && !new RegExp(policy.baselineTargetPattern).test(targetPath)) fail("TARGET_ALLOWLIST", "baseline.targetPath", "weekly target is not allowed");
}

export function baselineBusinessView(baseline) {
  const view = {
    schemaVersion: baseline.schemaVersion,
    edition: baseline.edition,
    asOf: baseline.asOf,
    targetPath: baseline.targetPath,
    targetSchemaVersion: baseline.targetSchemaVersion,
    payload: baseline.payload
  };
  if (baseline.mode !== undefined) view.mode = baseline.mode;
  return view;
}

export function baselineStableArtifactView(baseline) {
  return {
    ...baselineBusinessView(baseline),
    contentIdentity: baseline.contentIdentity,
    integrity: { businessSha256: baseline.integrity.businessSha256 }
  };
}

export function computeContentIdentity(baseline) {
  return sha256Canonical(baselineBusinessView(baseline));
}

export function createBaseline({ edition, asOf, targetPath, targetSchemaVersion, payload, mode = null, capturedAt = new Date().toISOString(), warnings = [] }, registry = loadWriterContextRegistry()) {
  validateWriterContextRegistry(registry);
  const baseline = {
    schemaVersion: BASELINE_SCHEMA,
    edition,
    asOf,
    capturedAt,
    targetPath,
    targetSchemaVersion,
    payload,
    contentIdentity: "",
    warnings: [...new Set(warnings)].sort(),
    integrity: { businessSha256: "", sha256: "" }
  };
  if (mode !== null) baseline.mode = mode;
  baseline.contentIdentity = computeContentIdentity(baseline);
  baseline.integrity.businessSha256 = baseline.contentIdentity;
  baseline.integrity.sha256 = computeFullIntegrity(baseline);
  return validateBaseline(baseline, registry);
}

export function validateBaseline(baseline, registry = loadWriterContextRegistry()) {
  validateWriterContextRegistry(registry);
  const keys = ["asOf", "capturedAt", "contentIdentity", "edition", "integrity", "payload", "schemaVersion", "targetPath", "targetSchemaVersion", "warnings"];
  assertExactKeys(baseline, keys, [...keys, "mode"], "baseline");
  if (baseline.schemaVersion !== BASELINE_SCHEMA) fail("BASELINE_SCHEMA", "baseline.schemaVersion", "baseline-content-v1 required");
  const policy = baseline.mode === GLOBAL_MARKET_BRIEF_MODE ? modePolicy(registry, baseline.mode, "baseline.mode") : editionPolicy(registry, baseline.edition, "baseline.edition");
  assertDate(baseline.asOf, "baseline.asOf");
  assertTimestamp(baseline.capturedAt, "baseline.capturedAt");
  validateTargetPath(baseline.edition, baseline.targetPath, registry, baseline.mode ?? null);
  if (baseline.targetSchemaVersion !== policy.targetSchemaVersion) fail("TARGET_SCHEMA", "baseline.targetSchemaVersion", "target schema mismatch");
  assertObject(baseline.payload, "baseline.payload");
  if (baseline.mode === GLOBAL_MARKET_BRIEF_MODE) {
    try {
      validateGlobalMarketBrief(baseline.payload);
    } catch (cause) {
      fail("TARGET_SCHEMA", "baseline.payload", cause instanceof Error ? cause.message : "global market brief is invalid");
    }
  }
  if (baseline.edition === "weekly" && baseline.payload.schemaVersion !== 1) fail("TARGET_SCHEMA", "baseline.payload.schemaVersion", "weekly schemaVersion 1 required");
  assertWarnings(baseline.warnings, "baseline.warnings");
  assertHash(baseline.contentIdentity, "baseline.contentIdentity");
  const expectedIdentity = computeContentIdentity(baseline);
  if (baseline.contentIdentity !== expectedIdentity) fail("BASELINE_ID", "baseline.contentIdentity", "content identity mismatch");
  assertExactKeys(baseline.integrity, ["businessSha256", "sha256"], ["businessSha256", "sha256"], "baseline.integrity");
  assertHash(baseline.integrity.businessSha256, "baseline.integrity.businessSha256");
  assertHash(baseline.integrity.sha256, "baseline.integrity.sha256");
  if (baseline.integrity.businessSha256 !== expectedIdentity) fail("BASELINE_INTEGRITY", "baseline.integrity.businessSha256", "business hash mismatch");
  if (baseline.integrity.sha256 !== computeFullIntegrity(baseline)) fail("BASELINE_INTEGRITY", "baseline.integrity.sha256", "full logical hash mismatch");
  return baseline;
}

function assertArtifactReference(reference, label, idKey, expectedSchema, prefix) {
  const keys = ["artifactPath", "artifactSha256", idKey, "schemaVersion"];
  assertExactKeys(reference, keys, keys, label);
  if (reference.schemaVersion !== expectedSchema) fail("REFERENCE_SCHEMA", `${label}.schemaVersion`, "referenced schema mismatch");
  validateRepoRelativePath(reference.artifactPath, `${label}.artifactPath`);
  if (!reference.artifactPath.startsWith(prefix) || !reference.artifactPath.endsWith(".json.gz")) fail("REFERENCE_PATH", `${label}.artifactPath`, "immutable gzip storage path required");
  assertHash(reference.artifactSha256, `${label}.artifactSha256`);
  assertHash(reference[idKey], `${label}.${idKey}`);
}

function assertFileReference(reference, label) {
  assertExactKeys(reference, ["path", "sha256"], ["path", "sha256"], label);
  validateRepoRelativePath(reference.path, `${label}.path`);
  assertHash(reference.sha256, `${label}.sha256`);
}

export function contextBusinessView(context) {
  const view = {
    schemaVersion: context.schemaVersion,
    edition: context.edition,
    asOf: context.asOf,
    quantitativeWriterPacket: context.quantitativeWriterPacket,
    qualitativeResearchBundle: context.qualitativeResearchBundle,
    baselineContent: context.baselineContent,
    writerPrompt: context.writerPrompt,
    targetValidator: context.targetValidator,
    targetSchemaVersion: context.targetSchemaVersion
  };
  if (context.mode !== undefined) view.mode = context.mode;
  if (context.globalMarketBrief !== undefined) view.globalMarketBrief = context.globalMarketBrief;
  return view;
}

export function contextStableArtifactView(context) {
  return {
    ...contextBusinessView(context),
    contextId: context.contextId,
    integrity: { businessSha256: context.integrity.businessSha256 }
  };
}

export function computeContextId(context) {
  return sha256Canonical(contextBusinessView(context));
}

function artifactFromVirtualOrDisk(root, relativePath, virtualArtifacts) {
  const key = relativePath.toLowerCase();
  const virtual = virtualArtifacts?.get(key);
  if (virtual) return virtual;
  const file = resolveRepoPath(root, relativePath, "artifactPath");
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    fail("ARTIFACT_MISSING", relativePath, "referenced artifact is missing");
  }
  return { bytes, value: undefined, relativePath };
}

function readBoundArtifact(root, reference, label, virtualArtifacts) {
  const artifact = artifactFromVirtualOrDisk(root, reference.artifactPath, virtualArtifacts);
  if (sha256Bytes(artifact.bytes) !== reference.artifactSha256) fail("ARTIFACT_SHA", `${label}.artifactSha256`, "referenced bytes do not match SHA");
  if (artifact.value === undefined) {
    let jsonBytes;
    try {
      jsonBytes = gunzipSync(artifact.bytes);
    } catch {
      fail("ARTIFACT_CORRUPT", reference.artifactPath, "referenced gzip is invalid");
    }
    artifact.value = readJsonBytes(jsonBytes, reference.artifactPath);
  }
  return artifact;
}

function loadResearchRegistry(root) {
  const registry = readJsonFile(path.join(root, "data", "research-bundles", "contract.json"), "RESEARCH_REGISTRY");
  validateResearchContractRegistry(registry);
  return registry;
}

function sourceFromPacketFact(fact) {
  return {
    asOf: fact.asOf ?? null,
    id: fact.sourceId,
    publisher: fact.publisher ?? fact.sourceId,
    title: fact.sourceTitle ?? fact.label ?? fact.sourceId,
    url: fact.sourceUrl
  };
}

function canonicalSourceUrl(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function publicPublisher(publisher, url) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (publisher === "Federal Reserve" && !(hostname === "federalreserve.gov" || hostname.endsWith(".federalreserve.gov"))) return "Compliance Alliance";
  return publisher;
}

function sourceFromDocument(document) {
  return {
    asOf: document.publishedDate ?? null,
    id: document.sourceId,
    publisher: publicPublisher(document.publisher, document.canonicalUrl),
    title: document.title,
    url: document.canonicalUrl
  };
}

function mergeGlobalSources(seed, packet, bundle) {
  const sources = new Map();
  const urls = new Map();
  const add = (source, { status = "ready" } = {}) => {
    if (!source?.id || !source.url || status !== "ready") return;
    const key = canonicalSourceUrl(source.url);
    if (urls.has(key)) return;
    sources.set(source.id, source);
    urls.set(key, source.id);
  };
  for (const source of seed.sourceIndex ?? []) add(source);
  for (const fact of packet.facts ?? []) {
    if (!fact.sourceId || !fact.sourceUrl) continue;
    add({ ...sourceFromPacketFact(fact), publisher: publicPublisher(fact.publisher ?? fact.sourceId, fact.sourceUrl) });
  }
  for (const document of bundle.documents ?? []) {
    if (!document.sourceId || !document.canonicalUrl) continue;
    add(sourceFromDocument(document));
  }
  return [...sources.values()].sort((left, right) => left.id.localeCompare(right.id) || left.url.localeCompare(right.url));
}

function normalizeStableFactId(id) {
  const value = String(id ?? "");
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) fail("GLOBAL_INPUT", "globalMarketBrief.keyFacts.id", `invalid packet fact id: ${value}`);
  return normalized;
}

function packetKeyFacts(packet, sourceIndex) {
  const known = new Set(sourceIndex.map((source) => source.id));
  return (packet.facts ?? []).filter((fact) => fact.sourceId && known.has(fact.sourceId)).map((fact) => ({
    id: normalizeStableFactId(fact.factId),
    statement: formatPacketFactStatement(fact),
    asOf: fact.asOf,
    sourceIds: [fact.sourceId],
    factStatus: fact.status === "unavailable" ? "unavailable" : fact.status === "stale" ? "delayed" : fact.status === "partial" ? "estimated" : "confirmed",
    value: fact.value ?? null,
    ...(fact.unit ? { unit: fact.unit } : {})
  }));
}

export function validatePacketFactDirection(fact, statement) {
  if (typeof statement !== "string" || typeof fact?.change1d !== "number") return true;
  const rising = /上行|上涨|上升|走高|升至|扩大|扩张/u;
  const falling = /回落|下行|下跌|下降|走低|收窄|缩小/u;
  if (fact.change1d < 0 && rising.test(statement)) fail("PACKET_DIRECTION_CONFLICT", "packet.facts", `${fact.factId} has a negative change but rising language`);
  if (fact.change1d > 0 && falling.test(statement)) fail("PACKET_DIRECTION_CONFLICT", "packet.facts", `${fact.factId} has a positive change but falling language`);
  return true;
}

export function formatPacketFactStatement(fact) {
  const labels = {
    "US Treasury 2Y": "美国2年期国债收益率",
    "US Treasury 10Y": "美国10年期国债收益率",
    "US Treasury 30Y": "美国30年期国债收益率",
    "US Treasury real 10Y": "美国实际10年期国债收益率",
    "US Treasury 2s10s spread": "美国2年期与10年期国债收益率利差",
  };
  const label = labels[fact.label] ?? fact.label;
  if (fact.value === null || fact.value === undefined) return `${label}：数据不可用`;
  const valueText = fact.unit === "percent" ? `${Number(fact.value).toFixed(2)}%` : `${fact.value}${fact.unit === "bp" ? "bp" : fact.unit ? ` ${fact.unit}` : ""}`;
  const change = typeof fact.change1d === "number" ? fact.change1d : null;
  if (change === null) return `${label}为${valueText}。`;
  let statement;
  if (fact.changeUnit === "bp") {
    if (change < 0) statement = `${label}为${valueText}，较前一交易日回落${Math.abs(change)}bp。`;
    else if (change > 0) statement = `${label}为${valueText}，较前一交易日上行${change}bp。`;
    else statement = `${label}为${valueText}，较前一交易日持平。`;
  } else {
    statement = `${label}为${valueText}，较前一交易日${change < 0 ? "回落" : change > 0 ? "上行" : "持平"}${change === 0 ? "" : Math.abs(change)}。`;
  }
  validatePacketFactDirection(fact, statement);
  return statement;
}

function assertGlobalSourceRefs(value, sourceIds, label) {
  if (!Array.isArray(value)) fail("GLOBAL_INPUT", label, "array required");
  for (const sourceId of value) if (typeof sourceId !== "string" || !sourceIds.has(sourceId)) fail("GLOBAL_INPUT", label, `source ${sourceId} is outside frozen sourceIndex`);
}

function buildGlobalMarketBriefInput({ seed, packet, bundle, baseline, root, globalInputPath, policy, packetArtifactPath, packetArtifactBytes, bundleArtifactPath, bundleArtifactBytes, baselineArtifactBytes, writerOutputSchemaPath = "schemas/global-market-brief-writer-output-v1.schema.json", targetSchemaPath = "schemas/global-market-brief-v1.schema.json" }) {
  try {
    validateGlobalMarketBrief(seed);
  } catch (cause) {
    fail("GLOBAL_INPUT", globalInputPath, cause instanceof Error ? cause.message : "global seed is invalid");
  }
  const sourceIndex = mergeGlobalSources(seed, packet, bundle);
  const sourceIds = new Set(sourceIndex.map((source) => source.id));
  const seedArticles = [seed.mainArticle, ...(seed.specialReports ?? [])];
  const keyFacts = [...seedArticles.flatMap((article) => article.keyFacts ?? []), ...packetKeyFacts(packet, sourceIndex)];
  for (const fact of keyFacts) assertGlobalSourceRefs(fact.sourceIds, sourceIds, "globalMarketBrief.keyFacts.sourceIds");
  for (const edge of seed.mainArticle.logicChain ?? []) {
    assertGlobalSourceRefs(edge.supportingSourceIds, sourceIds, "globalMarketBrief.logicChainCandidates.supportingSourceIds");
    assertGlobalSourceRefs(edge.contradictorySourceIds, sourceIds, "globalMarketBrief.logicChainCandidates.contradictorySourceIds");
  }
  for (const transmission of seed.mainArticle.crossMarketTransmission ?? []) assertGlobalSourceRefs(transmission.supportingSourceIds, sourceIds, "globalMarketBrief.crossMarketCandidates.supportingSourceIds");
  for (const watch of seed.mainArticle.watchItems ?? []) assertGlobalSourceRefs(watch.sourceIds, sourceIds, "globalMarketBrief.watchItems.sourceIds");
  const contradictoryEvidence = (bundle.observations ?? []).filter((item) => item.evidenceState === "conflicting").map((item) => ({
    id: item.observationId,
    statement: item.statement,
    sourceIds: [...new Set((item.basis ?? []).map((basis) => basis.sourceId).filter((sourceId) => sourceIds.has(sourceId)))].sort()
  })).filter((item) => item.sourceIds.length > 0);
  const globalSeedBytes = fs.readFileSync(resolveRepoPath(root, globalInputPath, "globalInputPath"));
  const schemaReference = (schemaPath, schemaVersion) => ({ schemaVersion, path: schemaPath, sha256: sha256Bytes(fs.readFileSync(resolveRepoPath(root, schemaPath, schemaPath))) });
  const globalMarketBrief = {
    mode: GLOBAL_MARKET_BRIEF_MODE,
    sourceIndex,
    keyFacts,
    quantitativePacket: {
      schemaVersion: packet.schemaVersion,
      artifactPath: packetArtifactPath,
      artifactSha256: sha256Bytes(packetArtifactBytes),
      writerPacketId: packet.writerPacketId
    },
    qualitativeResearchBundle: {
      schemaVersion: bundle.schemaVersion,
      artifactPath: bundleArtifactPath,
      artifactSha256: sha256Bytes(bundleArtifactBytes),
      bundleId: bundle.bundleId
    },
    logicChainCandidates: structuredClone(seed.mainArticle.logicChain),
    crossMarketCandidates: structuredClone(seed.mainArticle.crossMarketTransmission),
    specialTriggerCandidates: structuredClone(seed.specialTriggerCandidates),
    contradictoryEvidence,
    watchItems: structuredClone(seed.mainArticle.watchItems),
    baselineArticle: structuredClone(baseline.payload.mainArticle),
    inputSchemas: {
      quantitativePacket: { schemaVersion: packet.schemaVersion, artifactSha256: sha256Bytes(packetArtifactBytes) },
      qualitativeResearchBundle: { schemaVersion: bundle.schemaVersion, artifactSha256: sha256Bytes(bundleArtifactBytes) },
      baselineContent: { schemaVersion: BASELINE_SCHEMA, artifactSha256: sha256Bytes(baselineArtifactBytes) },
      globalSeed: { schemaVersion: seed.schemaVersion, path: globalInputPath, sha256: sha256Bytes(globalSeedBytes) },
      writerOutput: schemaReference(writerOutputSchemaPath, policy.writerOutputSchemaVersion),
      targetBrief: schemaReference(targetSchemaPath, policy.targetSchemaVersion),
      writerPrompt: { schemaVersion: "prompt-v1", path: policy.promptPath, sha256: sha256Bytes(fs.readFileSync(resolveRepoPath(root, policy.promptPath, policy.promptPath))) },
      targetValidator: { schemaVersion: "validator-v1", path: policy.validatorPath, sha256: sha256Bytes(fs.readFileSync(resolveRepoPath(root, policy.validatorPath, policy.validatorPath))) }
    }
  };
  return globalMarketBrief;
}

function packetAsOf(packet) {
  return packet.marketDates?.aShare ?? null;
}

function validateGlobalMarketBriefContext(global, context, registry, root, requireCurrentFrozen = true) {
  const field = "context.globalMarketBrief";
  assertObject(global, field);
  const keys = ["baselineArticle", "contradictoryEvidence", "crossMarketCandidates", "inputSchemas", "keyFacts", "logicChainCandidates", "mode", "qualitativeResearchBundle", "quantitativePacket", "sourceIndex", "specialTriggerCandidates", "watchItems"];
  assertExactKeys(global, keys, keys, field);
  if (global.mode !== GLOBAL_MARKET_BRIEF_MODE) fail("GLOBAL_CONTEXT", `${field}.mode`, "global_market_brief required");
  if (!Array.isArray(global.sourceIndex) || global.sourceIndex.length < 1) fail("GLOBAL_CONTEXT", `${field}.sourceIndex`, "nonempty source index required");
  const sourceIds = new Set();
  for (let index = 0; index < global.sourceIndex.length; index += 1) {
    const source = global.sourceIndex[index];
    const sourcePath = `${field}.sourceIndex[${index}]`;
    assertExactKeys(source, ["asOf", "id", "publisher", "title", "url"], ["asOf", "id", "publisher", "title", "url"], sourcePath);
    assertString(source.id, `${sourcePath}.id`);
    if (sourceIds.has(source.id)) fail("GLOBAL_CONTEXT", `${sourcePath}.id`, "source IDs must be unique");
    sourceIds.add(source.id);
    assertString(source.title, `${sourcePath}.title`);
    assertString(source.publisher, `${sourcePath}.publisher`);
    assertString(source.url, `${sourcePath}.url`);
    if (!source.url.startsWith("https://")) fail("GLOBAL_CONTEXT", `${sourcePath}.url`, "HTTPS source URL required");
    if (source.asOf !== null) assertDate(source.asOf, `${sourcePath}.asOf`);
  }
  for (const [label, values] of [["keyFacts", global.keyFacts], ["logicChainCandidates", global.logicChainCandidates], ["crossMarketCandidates", global.crossMarketCandidates], ["specialTriggerCandidates", global.specialTriggerCandidates], ["watchItems", global.watchItems]]) {
    if (!Array.isArray(values)) fail("GLOBAL_CONTEXT", `${field}.${label}`, "array required");
  }
  for (let index = 0; index < global.keyFacts.length; index += 1) {
    const fact = global.keyFacts[index];
    assertObject(fact, `${field}.keyFacts[${index}]`);
    assertString(fact.id, `${field}.keyFacts[${index}].id`);
    assertString(fact.statement, `${field}.keyFacts[${index}].statement`);
    assertDate(fact.asOf, `${field}.keyFacts[${index}].asOf`);
    assertGlobalSourceRefs(fact.sourceIds, sourceIds, `${field}.keyFacts[${index}].sourceIds`);
  }
  for (const [label, values] of [["logicChainCandidates", global.logicChainCandidates], ["crossMarketCandidates", global.crossMarketCandidates]]) {
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      assertObject(value, `${field}.${label}[${index}]`);
      for (const key of ["supportingSourceIds", ...(label === "logicChainCandidates" ? ["contradictorySourceIds"] : [])]) assertGlobalSourceRefs(value[key], sourceIds, `${field}.${label}[${index}].${key}`);
    }
  }
  for (let index = 0; index < global.specialTriggerCandidates.length; index += 1) assertGlobalSourceRefs(global.specialTriggerCandidates[index].triggerEvidenceIds, sourceIds, `${field}.specialTriggerCandidates[${index}].triggerEvidenceIds`);
  for (let index = 0; index < global.watchItems.length; index += 1) assertGlobalSourceRefs(global.watchItems[index].sourceIds, sourceIds, `${field}.watchItems[${index}].sourceIds`);
  for (let index = 0; index < global.contradictoryEvidence.length; index += 1) {
    const value = global.contradictoryEvidence[index];
    assertExactKeys(value, ["id", "sourceIds", "statement"], ["id", "sourceIds", "statement"], `${field}.contradictoryEvidence[${index}]`);
    assertString(value.id, `${field}.contradictoryEvidence[${index}].id`);
    assertString(value.statement, `${field}.contradictoryEvidence[${index}].statement`);
    assertGlobalSourceRefs(value.sourceIds, sourceIds, `${field}.contradictoryEvidence[${index}].sourceIds`);
  }
  assertObject(global.baselineArticle, `${field}.baselineArticle`);
  assertGlobalSourceRefs(global.baselineArticle.sourceIds, sourceIds, `${field}.baselineArticle.sourceIds`);
  const referenceKeys = ["artifactPath", "artifactSha256", "bundleId", "schemaVersion", "writerPacketId"];
  assertExactKeys(global.quantitativePacket, referenceKeys.filter((key) => key !== "bundleId"), referenceKeys.filter((key) => key !== "bundleId"), `${field}.quantitativePacket`);
  assertExactKeys(global.qualitativeResearchBundle, referenceKeys.filter((key) => key !== "writerPacketId"), referenceKeys.filter((key) => key !== "writerPacketId"), `${field}.qualitativeResearchBundle`);
  assertHash(global.quantitativePacket.artifactSha256, `${field}.quantitativePacket.artifactSha256`);
  assertHash(global.qualitativeResearchBundle.artifactSha256, `${field}.qualitativeResearchBundle.artifactSha256`);
  if (global.quantitativePacket.artifactPath !== context.quantitativeWriterPacket.artifactPath || global.quantitativePacket.artifactSha256 !== context.quantitativeWriterPacket.artifactSha256 || global.quantitativePacket.writerPacketId !== context.quantitativeWriterPacket.writerPacketId) fail("GLOBAL_CONTEXT", `${field}.quantitativePacket`, "quantitative packet reference differs from context reference");
  if (global.qualitativeResearchBundle.artifactPath !== context.qualitativeResearchBundle.artifactPath || global.qualitativeResearchBundle.artifactSha256 !== context.qualitativeResearchBundle.artifactSha256 || global.qualitativeResearchBundle.bundleId !== context.qualitativeResearchBundle.bundleId) fail("GLOBAL_CONTEXT", `${field}.qualitativeResearchBundle`, "research bundle reference differs from context reference");
  const schemaKeys = ["baselineContent", "globalSeed", "qualitativeResearchBundle", "quantitativePacket", "targetBrief", "targetValidator", "writerOutput", "writerPrompt"];
  assertExactKeys(global.inputSchemas, schemaKeys, schemaKeys, `${field}.inputSchemas`);
  for (const key of schemaKeys) {
    assertObject(global.inputSchemas[key], `${field}.inputSchemas.${key}`);
    if (!((typeof global.inputSchemas[key].schemaVersion === "string" && global.inputSchemas[key].schemaVersion.length > 0) || (typeof global.inputSchemas[key].schemaVersion === "number" && Number.isFinite(global.inputSchemas[key].schemaVersion)))) fail("GLOBAL_CONTEXT", `${field}.inputSchemas.${key}.schemaVersion`, "schema version required");
    assertHash(global.inputSchemas[key].sha256 ?? global.inputSchemas[key].artifactSha256, `${field}.inputSchemas.${key}.sha256`);
  }
  for (const key of ["globalSeed", "targetBrief", "targetValidator", "writerOutput", "writerPrompt"]) assertFileReference({ path: global.inputSchemas[key].path, sha256: global.inputSchemas[key].sha256 }, `${field}.inputSchemas.${key}`);
  if (global.inputSchemas.quantitativePacket.artifactSha256 !== context.quantitativeWriterPacket.artifactSha256 || global.inputSchemas.qualitativeResearchBundle.artifactSha256 !== context.qualitativeResearchBundle.artifactSha256) fail("GLOBAL_CONTEXT", `${field}.inputSchemas`, "input schema hashes differ from immutable artifacts");
  if (global.inputSchemas.baselineContent.artifactSha256 !== context.baselineContent.artifactSha256) fail("GLOBAL_CONTEXT", `${field}.inputSchemas.baselineContent`, "baseline artifact hash differs from immutable artifact");
  const seedArtifact = artifactFromVirtualOrDisk(root, global.inputSchemas.globalSeed.path, new Map());
  if (requireCurrentFrozen) {
    if (sha256Bytes(seedArtifact.bytes) !== global.inputSchemas.globalSeed.sha256) fail("GLOBAL_CONTEXT", `${field}.inputSchemas.globalSeed.sha256`, "global seed bytes changed");
    try {
      validateGlobalMarketBrief(readJsonBytes(seedArtifact.bytes, global.inputSchemas.globalSeed.path));
    } catch (cause) {
      fail("GLOBAL_CONTEXT", `${field}.inputSchemas.globalSeed`, cause instanceof Error ? cause.message : "global seed invalid");
    }
  }
  return global;
}

export function validateWriterContextArtifacts(context, { root = repositoryRoot, registry = loadWriterContextRegistry(root), virtualArtifacts = new Map(), requireCurrentFrozen = true } = {}) {
  const packetArtifact = readBoundArtifact(root, context.quantitativeWriterPacket, "context.quantitativeWriterPacket", virtualArtifacts);
  try {
    validatePacket(packetArtifact.value, context.quantitativeWriterPacket.artifactPath);
  } catch (cause) {
    fail("PACKET_INVALID", context.quantitativeWriterPacket.artifactPath, cause instanceof Error ? cause.message : "writer packet invalid");
  }
  if (packetArtifact.value.schemaVersion !== context.quantitativeWriterPacket.schemaVersion || packetArtifact.value.writerPacketId !== context.quantitativeWriterPacket.writerPacketId) fail("REFERENCE_ID", "context.quantitativeWriterPacket", "packet schema or ID mismatch");
  if (packetArtifact.value.edition !== context.edition || packetAsOf(packetArtifact.value) !== context.asOf) fail("REFERENCE_COMPATIBILITY", "context.quantitativeWriterPacket", "packet edition/asOf mismatch");

  const bundleArtifact = readBoundArtifact(root, context.qualitativeResearchBundle, "context.qualitativeResearchBundle", virtualArtifacts);
  try {
    validateBundle(bundleArtifact.value, loadResearchRegistry(root));
  } catch (cause) {
    fail("BUNDLE_INVALID", context.qualitativeResearchBundle.artifactPath, cause instanceof Error ? cause.message : "research bundle invalid");
  }
  if (bundleArtifact.value.schemaVersion !== context.qualitativeResearchBundle.schemaVersion || bundleArtifact.value.bundleId !== context.qualitativeResearchBundle.bundleId) fail("REFERENCE_ID", "context.qualitativeResearchBundle", "bundle schema or ID mismatch");
  if (bundleArtifact.value.edition !== context.edition || bundleArtifact.value.asOf !== context.asOf) fail("REFERENCE_COMPATIBILITY", "context.qualitativeResearchBundle", "bundle edition/asOf mismatch");

  const baselineArtifact = readBoundArtifact(root, context.baselineContent, "context.baselineContent", virtualArtifacts);
  validateBaseline(baselineArtifact.value, registry);
  if (baselineArtifact.value.schemaVersion !== context.baselineContent.schemaVersion || baselineArtifact.value.contentIdentity !== context.baselineContent.contentIdentity) fail("REFERENCE_ID", "context.baselineContent", "baseline schema or ID mismatch");
  if (baselineArtifact.value.edition !== context.edition || baselineArtifact.value.asOf !== context.asOf || baselineArtifact.value.targetSchemaVersion !== context.targetSchemaVersion) fail("REFERENCE_COMPATIBILITY", "context.baselineContent", "baseline edition/asOf/schema mismatch");

  const policy = context.mode === GLOBAL_MARKET_BRIEF_MODE ? modePolicy(registry, context.mode, "context.mode") : editionPolicy(registry, context.edition);
  if (context.mode === GLOBAL_MARKET_BRIEF_MODE) validateGlobalMarketBriefContext(context.globalMarketBrief, context, registry, root, requireCurrentFrozen);
  for (const [label, reference, expectedPath] of [["context.writerPrompt", context.writerPrompt, policy.promptPath], ["context.targetValidator", context.targetValidator, policy.validatorPath]]) {
    if (reference.path !== expectedPath) fail("REFERENCE_PATH", `${label}.path`, "frozen file path mismatch");
    // Historical contexts keep representing the prompt/validator frozen at generation
    // time. Only new prepare and current apply phases require the current working-tree
    // bytes to equal the frozen SHA; audits and rebuilds of historical artifacts must
    // validate the frozen reference itself without re-imposing current file SHAs.
    if (!requireCurrentFrozen) continue;
    const bytes = fs.readFileSync(resolveRepoPath(root, reference.path, `${label}.path`));
    if (sha256Bytes(bytes) !== reference.sha256) fail("ARTIFACT_SHA", `${label}.sha256`, "frozen file bytes do not match SHA");
  }
  return { packet: packetArtifact.value, bundle: bundleArtifact.value, baseline: baselineArtifact.value, global: context.globalMarketBrief ?? null };
}

export function validateWriterContext(context, registry = loadWriterContextRegistry(), options = {}) {
  validateWriterContextRegistry(registry);
  const keys = ["asOf", "baselineContent", "contextId", "edition", "generatedAt", "integrity", "qualitativeResearchBundle", "quantitativeWriterPacket", "schemaVersion", "targetSchemaVersion", "targetValidator", "warnings", "writerPrompt"];
  assertExactKeys(context, keys, [...keys, "mode", "globalMarketBrief"], "context");
  if (context.schemaVersion !== CONTEXT_SCHEMA) fail("CONTEXT_SCHEMA", "context.schemaVersion", "writer-context-v1 required");
  const policy = context.mode === GLOBAL_MARKET_BRIEF_MODE ? modePolicy(registry, context.mode, "context.mode") : editionPolicy(registry, context.edition, "context.edition");
  if (context.mode === GLOBAL_MARKET_BRIEF_MODE && context.edition !== policy.edition) fail("INVALID_MODE", "context.edition", "global writer mode is daily only");
  if (context.mode === undefined && context.globalMarketBrief !== undefined) fail("GLOBAL_CONTEXT", "context.globalMarketBrief", "globalMarketBrief requires global_market_brief mode");
  if (context.mode === GLOBAL_MARKET_BRIEF_MODE && context.globalMarketBrief === undefined) fail("GLOBAL_CONTEXT", "context.globalMarketBrief", "globalMarketBrief is required for global writer mode");
  assertDate(context.asOf, "context.asOf");
  assertTimestamp(context.generatedAt, "context.generatedAt");
  assertArtifactReference(context.quantitativeWriterPacket, "context.quantitativeWriterPacket", "writerPacketId", 1, registry.pathPrefixes.quantitativeWriterPacket);
  assertArtifactReference(context.qualitativeResearchBundle, "context.qualitativeResearchBundle", "bundleId", "research-bundle-v1", registry.pathPrefixes.qualitativeResearchBundle);
  assertArtifactReference(context.baselineContent, "context.baselineContent", "contentIdentity", BASELINE_SCHEMA, registry.pathPrefixes.baseline);
  assertFileReference(context.writerPrompt, "context.writerPrompt");
  assertFileReference(context.targetValidator, "context.targetValidator");
  if (context.targetSchemaVersion !== policy.targetSchemaVersion) fail("TARGET_SCHEMA", "context.targetSchemaVersion", "target schema mismatch");
  assertWarnings(context.warnings, "context.warnings");
  assertHash(context.contextId, "context.contextId");
  const expectedId = computeContextId(context);
  if (context.contextId !== expectedId) fail("CONTEXT_ID", "context.contextId", "context ID mismatch");
  assertExactKeys(context.integrity, ["businessSha256", "sha256"], ["businessSha256", "sha256"], "context.integrity");
  assertHash(context.integrity.businessSha256, "context.integrity.businessSha256");
  assertHash(context.integrity.sha256, "context.integrity.sha256");
  if (context.integrity.businessSha256 !== expectedId) fail("CONTEXT_INTEGRITY", "context.integrity.businessSha256", "business hash mismatch");
  if (context.integrity.sha256 !== computeFullIntegrity(context)) fail("CONTEXT_INTEGRITY", "context.integrity.sha256", "full logical hash mismatch");
  validateWriterContextArtifacts(context, { root: options.root ?? repositoryRoot, registry, virtualArtifacts: options.virtualArtifacts ?? new Map(), requireCurrentFrozen: options.requireCurrentFrozen ?? true });
  return context;
}

function relativeArtifact(root, relativePath, prefix, label) {
  validateRepoRelativePath(relativePath, label);
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(".json.gz")) fail("REFERENCE_PATH", label, "explicit immutable gzip path required");
  const file = resolveRepoPath(root, relativePath, label);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    fail("ARTIFACT_MISSING", label, "explicit artifact does not exist");
  }
  let value;
  try {
    value = JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch {
    fail("ARTIFACT_CORRUPT", label, "explicit artifact is not valid gzip JSON");
  }
  return { relativePath, file, bytes, value };
}

function fileReference(root, relativePath) {
  const file = resolveRepoPath(root, relativePath, relativePath);
  if (!fs.existsSync(file)) fail("ARTIFACT_MISSING", relativePath, "frozen file missing");
  return { path: relativePath, sha256: sha256Bytes(fs.readFileSync(file)) };
}

function buildWriterContext({ edition, asOf, writerPacket, researchBundle, baseline, root, generatedAt, warnings, registry, virtualArtifacts }) {
  try {
    validatePacket(writerPacket.value, writerPacket.relativePath);
  } catch (cause) {
    fail("PACKET_INVALID", writerPacket.relativePath, cause instanceof Error ? cause.message : "writer packet invalid");
  }
  validateBundle(researchBundle.value, loadResearchRegistry(root));
  validateBaseline(baseline.value, registry);
  const mode = arguments[0]?.mode ?? null;
  const globalInput = arguments[0]?.globalInput ?? null;
  const globalInputPath = arguments[0]?.globalInputPath ?? null;
  const policy = mode === GLOBAL_MARKET_BRIEF_MODE ? modePolicy(registry, mode) : editionPolicy(registry, edition);
  const context = {
    schemaVersion: CONTEXT_SCHEMA,
    edition,
    asOf,
    generatedAt,
    quantitativeWriterPacket: { schemaVersion: writerPacket.value.schemaVersion, artifactPath: writerPacket.relativePath, artifactSha256: sha256Bytes(writerPacket.bytes), writerPacketId: writerPacket.value.writerPacketId },
    qualitativeResearchBundle: { schemaVersion: researchBundle.value.schemaVersion, artifactPath: researchBundle.relativePath, artifactSha256: sha256Bytes(researchBundle.bytes), bundleId: researchBundle.value.bundleId },
    baselineContent: { schemaVersion: baseline.value.schemaVersion, artifactPath: baseline.relativePath, artifactSha256: sha256Bytes(baseline.bytes), contentIdentity: baseline.value.contentIdentity },
    writerPrompt: fileReference(root, policy.promptPath),
    targetValidator: fileReference(root, policy.validatorPath),
    targetSchemaVersion: policy.targetSchemaVersion,
    contextId: "",
    warnings: [...new Set(warnings)].sort(),
    integrity: { businessSha256: "", sha256: "" }
  };
  if (mode !== null) {
    context.mode = mode;
    context.globalMarketBrief = buildGlobalMarketBriefInput({
      seed: globalInput,
      packet: writerPacket.value,
      bundle: researchBundle.value,
      baseline: baseline.value,
      root,
      globalInputPath,
      policy,
      packetArtifactPath: writerPacket.relativePath,
      packetArtifactBytes: writerPacket.bytes,
      bundleArtifactPath: researchBundle.relativePath,
      bundleArtifactBytes: researchBundle.bytes,
      baselineArtifactBytes: baseline.bytes
    });
  }
  context.contextId = computeContextId(context);
  context.integrity.businessSha256 = context.contextId;
  context.integrity.sha256 = computeFullIntegrity(context);
  return validateWriterContext(context, registry, { root, virtualArtifacts });
}

function artifactRelativePath(kind, value) {
  const id = kind === "baseline" ? value.contentIdentity : value.contextId;
  const segment = kind === "baseline" ? "baselines" : "contexts";
  return `data/writer-contexts/${segment}/${value.asOf.slice(0, 4)}/${value.asOf.slice(5, 7)}/${id}.json.gz`;
}

function validateImmutableValue(kind, value, registry, root, virtualArtifacts, requireCurrentFrozen) {
  if (kind === "baseline") return validateBaseline(value, registry);
  return validateWriterContext(value, registry, { root, virtualArtifacts, requireCurrentFrozen });
}

function stableView(kind, value) {
  return kind === "baseline" ? baselineStableArtifactView(value) : contextStableArtifactView(value);
}

function planImmutable(kind, candidate, { root, registry, virtualArtifacts }) {
  const relativePath = artifactRelativePath(kind, candidate);
  const file = resolveRepoPath(root, relativePath, relativePath);
  const candidateBytes = deterministicGzip(candidate);
  if (!fs.existsSync(file)) return { kind, relativePath, file, bytes: candidateBytes, value: candidate, created: true, reused: false, shouldWrite: true };
  let existing;
  const existingBytes = fs.readFileSync(file);
  try {
    existing = JSON.parse(gunzipSync(existingBytes).toString("utf8"));
  } catch {
    fail("ARTIFACT_CORRUPT", relativePath, "stored immutable gzip is invalid");
  }
  validateImmutableValue(kind, existing, registry, root, virtualArtifacts, true);
  const expectedId = kind === "baseline" ? candidate.contentIdentity : candidate.contextId;
  const actualId = kind === "baseline" ? existing.contentIdentity : existing.contextId;
  if (expectedId !== actualId || canonicalJson(stableView(kind, existing)) !== canonicalJson(stableView(kind, candidate))) fail("IMMUTABLE_CONFLICT", relativePath, "stored immutable artifact conflicts with candidate");
  return { kind, relativePath, file, bytes: existingBytes, value: existing, created: false, reused: true, shouldWrite: false };
}

function readTreeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? readTreeFiles(target) : [target];
  });
}

function scanWriterContexts(root, registry, virtualArtifacts = new Map(), requireCurrentFrozen = false) {
  const result = { baselines: [], contexts: [] };
  const rootDirectory = path.join(root, "data", "writer-contexts");
  for (const [kind, directory, idKey, collection] of [["baseline", "baselines", "contentIdentity", "baselines"], ["context", "contexts", "contextId", "contexts"]]) {
    for (const file of readTreeFiles(path.join(rootDirectory, directory)).filter((item) => item.endsWith(".json.gz"))) {
      const relativePath = path.relative(root, file).split(path.sep).join("/");
      const bytes = fs.readFileSync(file);
      let value;
      try {
        value = JSON.parse(gunzipSync(bytes).toString("utf8"));
      } catch {
        fail("ARTIFACT_CORRUPT", relativePath, "stored gzip JSON invalid");
      }
      validateImmutableValue(kind, value, registry, root, virtualArtifacts, requireCurrentFrozen);
      if (path.basename(file) !== `${value[idKey]}.json.gz` || relativePath !== artifactRelativePath(kind, value)) fail("ARTIFACT_PATH", relativePath, "stored path does not match identity/date");
      result[collection].push({ kind, relativePath, file, bytes, value, created: false, reused: true, shouldWrite: false });
    }
  }
  return result;
}

function mergePlan(collection, plan) {
  const index = collection.findIndex((item) => item.relativePath.toLowerCase() === plan.relativePath.toLowerCase());
  if (index >= 0) collection[index] = plan;
  else collection.push(plan);
}

function derivedPlan(root, relativePath, bytes, kind) {
  const file = resolveRepoPath(root, relativePath, relativePath);
  if (!fs.existsSync(file)) return { kind, relativePath, file, bytes, created: true, reused: false, shouldWrite: true };
  const existing = fs.readFileSync(file);
  if (Buffer.compare(existing, bytes) === 0) return { kind, relativePath, file, bytes: existing, created: false, reused: true, shouldWrite: false };
  return { kind, relativePath, file, bytes, created: false, reused: false, shouldWrite: true };
}

function derivedPlans(root, artifacts) {
  const baselines = [...artifacts.baselines].sort((left, right) => left.value.contentIdentity.localeCompare(right.value.contentIdentity));
  const contexts = [...artifacts.contexts].sort((left, right) => left.value.contextId.localeCompare(right.value.contextId));
  const index = {
    schemaVersion: "writer-context-index-v1",
    baselines: baselines.map((item) => ({ id: item.value.contentIdentity, schemaVersion: BASELINE_SCHEMA, edition: item.value.edition, asOf: item.value.asOf, artifactPath: item.relativePath, artifactSha256: sha256Bytes(item.bytes) })),
    contexts: contexts.map((item) => ({ id: item.value.contextId, schemaVersion: CONTEXT_SCHEMA, edition: item.value.edition, asOf: item.value.asOf, artifactPath: item.relativePath, artifactSha256: sha256Bytes(item.bytes) }))
  };
  const plans = [derivedPlan(root, "data/writer-contexts/index.json", Buffer.from(`${canonicalJson(index)}\n`, "utf8"), "index")];
  for (const edition of ["daily", "weekly"]) {
    const latest = contexts.filter((item) => item.value.edition === edition).sort((left, right) => left.value.asOf.localeCompare(right.value.asOf) || left.value.contextId.localeCompare(right.value.contextId)).at(-1);
    if (latest) plans.push(derivedPlan(root, `content/writer-contexts/${edition}-latest.json`, Buffer.from(`${canonicalJson(latest.value)}\n`, "utf8"), `${edition}-latest`));
  }
  return plans;
}

function applyPlan(plan, transaction) {
  if (!plan.shouldWrite) return;
  if (!transaction.before.has(plan.file)) transaction.before.set(plan.file, fs.existsSync(plan.file) ? fs.readFileSync(plan.file) : null);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  const temporary = `${plan.file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, plan.bytes);
    fs.renameSync(temporary, plan.file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function pruneEmptyParents(start, root) {
  let current = path.dirname(start);
  const stop = path.resolve(root);
  while (current.startsWith(stop) && current !== stop) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function rollback(transaction, root) {
  for (const [file, before] of [...transaction.before.entries()].reverse()) {
    if (before === null) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      pruneEmptyParents(file, root);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, before);
    }
  }
}

function shouldFail(failAt, plan, index) {
  return failAt === plan.kind || failAt === index;
}

function ensureOutputOutsideRoot(output, root) {
  if (!path.isAbsolute(output)) fail("CLI_ARGUMENT", "output", "absolute output path required");
  const relation = path.relative(path.resolve(root), path.resolve(output));
  if (!relation || (!relation.startsWith("..") && !path.isAbsolute(relation))) fail("CLI_ARGUMENT", "output", "output must be outside repository");
}

function writeSummaryOutput(output, root, summary) {
  if (output === null || output === undefined) return;
  ensureOutputOutsideRoot(output, root);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${canonicalJson(summary)}\n`, "utf8");
}

export function prepareWriterContext({ edition, asOf, writerPacketPath, researchBundlePath, baselineSource, mode = null, globalInputPath = null, dryRun = false, write = false, root = repositoryRoot, output = null, now = new Date(), warnings = [], failAt = null } = {}) {
  if (dryRun === write) fail("CLI_ARGUMENT", "mode", "exactly one of dryRun or write is required");
  const registry = validateWriterContextRegistry(loadWriterContextRegistry(root));
  const policy = mode === GLOBAL_MARKET_BRIEF_MODE ? modePolicy(registry, mode) : editionPolicy(registry, edition);
  assertDate(asOf, "asOf");
  for (const [label, value] of [["writerPacket", writerPacketPath], ["researchBundle", researchBundlePath], ["baselineSource", baselineSource]]) assertString(value, label);
  if (mode === GLOBAL_MARKET_BRIEF_MODE && typeof globalInputPath !== "string") fail("CLI_ARGUMENT", "globalInputPath", "global seed path is required for global writer mode");
  validateTargetPath(edition, baselineSource, registry, mode);
  const packetArtifact = relativeArtifact(root, writerPacketPath, registry.pathPrefixes.quantitativeWriterPacket, "writerPacket");
  const bundleArtifact = relativeArtifact(root, researchBundlePath, registry.pathPrefixes.qualitativeResearchBundle, "researchBundle");
  const baselinePayload = readJsonFile(resolveRepoPath(root, baselineSource, "baselineSource"), "BASELINE_SOURCE");
  const globalInput = mode === GLOBAL_MARKET_BRIEF_MODE ? readJsonFile(resolveRepoPath(root, globalInputPath, "globalInputPath"), "GLOBAL_INPUT") : null;
  if (mode === GLOBAL_MARKET_BRIEF_MODE) {
    try {
      validateGlobalMarketBrief(globalInput);
    } catch (cause) {
      fail("GLOBAL_INPUT", globalInputPath, cause instanceof Error ? cause.message : "global seed is invalid");
    }
  }
  const timestamp = now.toISOString();
  assertTimestamp(timestamp, "now");
  const baselineCandidate = createBaseline({ edition, asOf, targetPath: baselineSource, targetSchemaVersion: policy.targetSchemaVersion, payload: baselinePayload, mode, capturedAt: timestamp, warnings }, registry);
  const baselineVirtual = new Map();
  const baselinePlan = planImmutable("baseline", baselineCandidate, { root, registry, virtualArtifacts: baselineVirtual });
  baselineVirtual.set(baselinePlan.relativePath.toLowerCase(), baselinePlan);
  const contextCandidate = buildWriterContext({ edition, asOf, mode, globalInput, globalInputPath, writerPacket: packetArtifact, researchBundle: bundleArtifact, baseline: baselinePlan, root, generatedAt: timestamp, warnings, registry, virtualArtifacts: baselineVirtual });
  const contextPlan = planImmutable("context", contextCandidate, { root, registry, virtualArtifacts: baselineVirtual });
  const allVirtual = new Map(baselineVirtual);
  allVirtual.set(contextPlan.relativePath.toLowerCase(), contextPlan);
  const artifacts = scanWriterContexts(root, registry, allVirtual);
  mergePlan(artifacts.baselines, baselinePlan);
  mergePlan(artifacts.contexts, contextPlan);
  const plans = [baselinePlan, contextPlan, ...derivedPlans(root, artifacts)];
  const summary = {
    schemaVersion: "writer-context-prepare-summary-v1",
    ...(mode ? { mode } : {}),
    edition,
    asOf,
    contentIdentity: baselinePlan.value.contentIdentity,
    contextId: contextPlan.value.contextId,
    baselinePath: baselinePlan.relativePath,
    contextPath: contextPlan.relativePath,
    created: plans.filter((plan) => plan.created).map((plan) => plan.relativePath),
    reused: plans.filter((plan) => plan.reused).map((plan) => plan.relativePath),
    wouldWrite: plans.filter((plan) => plan.shouldWrite).map((plan) => plan.relativePath),
    dryRun
  };
  if (!dryRun) {
    const transaction = { before: new Map() };
    try {
      let writeIndex = 0;
      for (const plan of plans) {
        applyPlan(plan, transaction);
        if (!plan.shouldWrite) continue;
        writeIndex += 1;
        if (shouldFail(failAt, plan, writeIndex)) fail("STORAGE_WRITE", plan.relativePath, "injected write failure");
      }
    } catch (cause) {
      rollback(transaction, root);
      throw cause;
    }
  }
  writeSummaryOutput(output, root, summary);
  return summary;
}

export function rebuildWriterContextDerivedViews({ root = repositoryRoot, failAt = null } = {}) {
  const registry = validateWriterContextRegistry(loadWriterContextRegistry(root));
  const artifacts = scanWriterContexts(root, registry);
  const plans = derivedPlans(root, artifacts);
  const transaction = { before: new Map() };
  try {
    let writeIndex = 0;
    for (const plan of plans) {
      applyPlan(plan, transaction);
      if (!plan.shouldWrite) continue;
      writeIndex += 1;
      if (shouldFail(failAt, plan, writeIndex)) fail("STORAGE_WRITE", plan.relativePath, "injected rebuild failure");
    }
  } catch (cause) {
    rollback(transaction, root);
    throw cause;
  }
  return { schemaVersion: "writer-context-rebuild-summary-v1", written: plans.filter((plan) => plan.shouldWrite).map((plan) => plan.relativePath), reused: plans.filter((plan) => plan.reused).map((plan) => plan.relativePath) };
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") continue;
    if (!args[index].startsWith("--")) fail("CLI_ARGUMENT", "arguments", "unknown positional argument");
    const key = args[index].slice(2);
    if (!key || Object.hasOwn(result, key)) fail("CLI_ARGUMENT", "arguments", "invalid or duplicate option");
    result[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return result;
}

function onlyKeys(args, allowed, command) {
  if (Object.keys(args).some((key) => !allowed.includes(key))) fail("CLI_ARGUMENT", command, "unknown option");
}

function runCli() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "validate-registry") {
    onlyKeys(args, [], command);
    const registry = validateWriterContextRegistry(loadWriterContextRegistry());
    console.log(JSON.stringify({ valid: true, schemaVersion: registry.schemaVersion }));
    return;
  }
  if (command === "validate-baseline") {
    onlyKeys(args, ["file"], command);
    if (typeof args.file !== "string") fail("CLI_ARGUMENT", command, "--file is required");
    const baseline = validateBaseline(readJsonOrGzip(path.resolve(process.cwd(), args.file)));
    console.log(JSON.stringify({ valid: true, schemaVersion: baseline.schemaVersion, contentIdentity: baseline.contentIdentity }));
    return;
  }
  if (command === "validate-context") {
    onlyKeys(args, ["file", "root", "legacy"], command);
    if (typeof args.file !== "string" || (args.root !== undefined && typeof args.root !== "string")) fail("CLI_ARGUMENT", command, "--file is required");
    const root = args.root ? path.resolve(args.root) : repositoryRoot;
    const registry = loadWriterContextRegistry(root);
    const context = validateWriterContext(readJsonOrGzip(path.resolve(process.cwd(), args.file)), registry, { root, requireCurrentFrozen: args.legacy !== true });
    console.log(JSON.stringify({ valid: true, schemaVersion: context.schemaVersion, contextId: context.contextId }));
    return;
  }
  if (command === "prepare") {
    onlyKeys(args, ["edition", "as-of", "writer-packet", "research-bundle", "baseline-source", "mode", "global-input", "dry-run", "write", "root", "output"], command);
    if (typeof args.edition !== "string" || typeof args["as-of"] !== "string" || typeof args["writer-packet"] !== "string" || typeof args["research-bundle"] !== "string" || typeof args["baseline-source"] !== "string" || (args["dry-run"] !== undefined && args["dry-run"] !== true) || (args.write !== undefined && args.write !== true) || (args.root !== undefined && typeof args.root !== "string") || (args.output !== undefined && typeof args.output !== "string")) fail("CLI_ARGUMENT", command, "invalid prepare arguments");
    const summary = prepareWriterContext({ edition: args.edition, asOf: args["as-of"], writerPacketPath: args["writer-packet"], researchBundlePath: args["research-bundle"], baselineSource: args["baseline-source"], mode: args.mode ?? null, globalInputPath: args["global-input"] ?? null, dryRun: args["dry-run"] === true, write: args.write === true, root: args.root ? path.resolve(args.root) : repositoryRoot, output: args.output ? path.resolve(args.output) : null });
    console.log(canonicalJson(summary));
    return;
  }
  if (command === "rebuild") {
    onlyKeys(args, ["root"], command);
    if (args.root !== undefined && typeof args.root !== "string") fail("CLI_ARGUMENT", command, "--root must be a path");
    console.log(canonicalJson(rebuildWriterContextDerivedViews({ root: args.root ? path.resolve(args.root) : repositoryRoot })));
    return;
  }
  fail("CLI_ARGUMENT", "command", "usage: validate-registry | validate-baseline | validate-context | prepare | rebuild");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    runCli();
  } catch (cause) {
    if (cause instanceof WriterContextError) console.error(`${cause.code} ${cause.path} ${cause.message}`);
    else console.error(`WRITER_CONTEXT_FAILURE command ${cause instanceof Error ? cause.message : "unexpected failure"}`);
    process.exitCode = 1;
  }
}
