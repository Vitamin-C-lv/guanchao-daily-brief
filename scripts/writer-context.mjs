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
import { validatePacket } from "./validate-writer-packet.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASELINE_SCHEMA = "baseline-content-v1";
const CONTEXT_SCHEMA = "writer-context-v1";

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

export function validateWriterContextRegistry(registry) {
  const required = ["auditOnlyFields", "baselineSchemaVersion", "contextSchemaVersion", "editions", "pathPrefixes", "requestSchemaVersion", "resultSchemaVersion", "schemaVersion", "storage"];
  assertExactKeys(registry, required, required, "registry");
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

function validateTargetPath(edition, targetPath, registry) {
  validateRepoRelativePath(targetPath, "baseline.targetPath");
  const policy = editionPolicy(registry, edition);
  if (edition === "daily" && targetPath !== policy.baselineTarget) fail("TARGET_ALLOWLIST", "baseline.targetPath", "daily target is not allowed");
  if (edition === "weekly" && !new RegExp(policy.baselineTargetPattern).test(targetPath)) fail("TARGET_ALLOWLIST", "baseline.targetPath", "weekly target is not allowed");
}

export function baselineBusinessView(baseline) {
  return {
    schemaVersion: baseline.schemaVersion,
    edition: baseline.edition,
    asOf: baseline.asOf,
    targetPath: baseline.targetPath,
    targetSchemaVersion: baseline.targetSchemaVersion,
    payload: baseline.payload
  };
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

export function createBaseline({ edition, asOf, targetPath, targetSchemaVersion, payload, capturedAt = new Date().toISOString(), warnings = [] }, registry = loadWriterContextRegistry()) {
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
  baseline.contentIdentity = computeContentIdentity(baseline);
  baseline.integrity.businessSha256 = baseline.contentIdentity;
  baseline.integrity.sha256 = computeFullIntegrity(baseline);
  return validateBaseline(baseline, registry);
}

export function validateBaseline(baseline, registry = loadWriterContextRegistry()) {
  validateWriterContextRegistry(registry);
  const keys = ["asOf", "capturedAt", "contentIdentity", "edition", "integrity", "payload", "schemaVersion", "targetPath", "targetSchemaVersion", "warnings"];
  assertExactKeys(baseline, keys, keys, "baseline");
  if (baseline.schemaVersion !== BASELINE_SCHEMA) fail("BASELINE_SCHEMA", "baseline.schemaVersion", "baseline-content-v1 required");
  const policy = editionPolicy(registry, baseline.edition, "baseline.edition");
  assertDate(baseline.asOf, "baseline.asOf");
  assertTimestamp(baseline.capturedAt, "baseline.capturedAt");
  validateTargetPath(baseline.edition, baseline.targetPath, registry);
  if (baseline.targetSchemaVersion !== policy.targetSchemaVersion) fail("TARGET_SCHEMA", "baseline.targetSchemaVersion", "target schema mismatch");
  assertObject(baseline.payload, "baseline.payload");
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
  return {
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

function packetAsOf(packet) {
  return packet.marketDates?.aShare ?? null;
}

export function validateWriterContextArtifacts(context, { root = repositoryRoot, registry = loadWriterContextRegistry(root), virtualArtifacts = new Map() } = {}) {
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

  const policy = editionPolicy(registry, context.edition);
  for (const [label, reference, expectedPath] of [["context.writerPrompt", context.writerPrompt, policy.promptPath], ["context.targetValidator", context.targetValidator, policy.validatorPath]]) {
    if (reference.path !== expectedPath) fail("REFERENCE_PATH", `${label}.path`, "frozen file path mismatch");
    const bytes = fs.readFileSync(resolveRepoPath(root, reference.path, `${label}.path`));
    if (sha256Bytes(bytes) !== reference.sha256) fail("ARTIFACT_SHA", `${label}.sha256`, "frozen file bytes do not match SHA");
  }
  return { packet: packetArtifact.value, bundle: bundleArtifact.value, baseline: baselineArtifact.value };
}

export function validateWriterContext(context, registry = loadWriterContextRegistry(), options = {}) {
  validateWriterContextRegistry(registry);
  const keys = ["asOf", "baselineContent", "contextId", "edition", "generatedAt", "integrity", "qualitativeResearchBundle", "quantitativeWriterPacket", "schemaVersion", "targetSchemaVersion", "targetValidator", "warnings", "writerPrompt"];
  assertExactKeys(context, keys, keys, "context");
  if (context.schemaVersion !== CONTEXT_SCHEMA) fail("CONTEXT_SCHEMA", "context.schemaVersion", "writer-context-v1 required");
  const policy = editionPolicy(registry, context.edition, "context.edition");
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
  validateWriterContextArtifacts(context, { root: options.root ?? repositoryRoot, registry, virtualArtifacts: options.virtualArtifacts ?? new Map() });
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
  const policy = editionPolicy(registry, edition);
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

function validateImmutableValue(kind, value, registry, root, virtualArtifacts) {
  if (kind === "baseline") return validateBaseline(value, registry);
  return validateWriterContext(value, registry, { root, virtualArtifacts });
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
  validateImmutableValue(kind, existing, registry, root, virtualArtifacts);
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

function scanWriterContexts(root, registry, virtualArtifacts = new Map()) {
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
      validateImmutableValue(kind, value, registry, root, virtualArtifacts);
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

export function prepareWriterContext({ edition, asOf, writerPacketPath, researchBundlePath, baselineSource, dryRun = false, write = false, root = repositoryRoot, output = null, now = new Date(), warnings = [], failAt = null } = {}) {
  if (dryRun === write) fail("CLI_ARGUMENT", "mode", "exactly one of dryRun or write is required");
  const registry = validateWriterContextRegistry(loadWriterContextRegistry(root));
  const policy = editionPolicy(registry, edition);
  assertDate(asOf, "asOf");
  for (const [label, value] of [["writerPacket", writerPacketPath], ["researchBundle", researchBundlePath], ["baselineSource", baselineSource]]) assertString(value, label);
  validateTargetPath(edition, baselineSource, registry);
  const packetArtifact = relativeArtifact(root, writerPacketPath, registry.pathPrefixes.quantitativeWriterPacket, "writerPacket");
  const bundleArtifact = relativeArtifact(root, researchBundlePath, registry.pathPrefixes.qualitativeResearchBundle, "researchBundle");
  const baselinePayload = readJsonFile(resolveRepoPath(root, baselineSource, "baselineSource"), "BASELINE_SOURCE");
  const timestamp = now.toISOString();
  assertTimestamp(timestamp, "now");
  const baselineCandidate = createBaseline({ edition, asOf, targetPath: baselineSource, targetSchemaVersion: policy.targetSchemaVersion, payload: baselinePayload, capturedAt: timestamp, warnings }, registry);
  const baselineVirtual = new Map();
  const baselinePlan = planImmutable("baseline", baselineCandidate, { root, registry, virtualArtifacts: baselineVirtual });
  baselineVirtual.set(baselinePlan.relativePath.toLowerCase(), baselinePlan);
  const contextCandidate = buildWriterContext({ edition, asOf, writerPacket: packetArtifact, researchBundle: bundleArtifact, baseline: baselinePlan, root, generatedAt: timestamp, warnings, registry, virtualArtifacts: baselineVirtual });
  const contextPlan = planImmutable("context", contextCandidate, { root, registry, virtualArtifacts: baselineVirtual });
  const allVirtual = new Map(baselineVirtual);
  allVirtual.set(contextPlan.relativePath.toLowerCase(), contextPlan);
  const artifacts = scanWriterContexts(root, registry, allVirtual);
  mergePlan(artifacts.baselines, baselinePlan);
  mergePlan(artifacts.contexts, contextPlan);
  const plans = [baselinePlan, contextPlan, ...derivedPlans(root, artifacts)];
  const summary = {
    schemaVersion: "writer-context-prepare-summary-v1",
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
    onlyKeys(args, ["file", "root"], command);
    if (typeof args.file !== "string" || (args.root !== undefined && typeof args.root !== "string")) fail("CLI_ARGUMENT", command, "--file is required");
    const root = args.root ? path.resolve(args.root) : repositoryRoot;
    const registry = loadWriterContextRegistry(root);
    const context = validateWriterContext(readJsonOrGzip(path.resolve(process.cwd(), args.file)), registry, { root });
    console.log(JSON.stringify({ valid: true, schemaVersion: context.schemaVersion, contextId: context.contextId }));
    return;
  }
  if (command === "prepare") {
    onlyKeys(args, ["edition", "as-of", "writer-packet", "research-bundle", "baseline-source", "dry-run", "write", "root", "output"], command);
    if (typeof args.edition !== "string" || typeof args["as-of"] !== "string" || typeof args["writer-packet"] !== "string" || typeof args["research-bundle"] !== "string" || typeof args["baseline-source"] !== "string" || (args["dry-run"] !== undefined && args["dry-run"] !== true) || (args.write !== undefined && args.write !== true) || (args.root !== undefined && typeof args.root !== "string") || (args.output !== undefined && typeof args.output !== "string")) fail("CLI_ARGUMENT", command, "invalid prepare arguments");
    const summary = prepareWriterContext({ edition: args.edition, asOf: args["as-of"], writerPacketPath: args["writer-packet"], researchBundlePath: args["research-bundle"], baselineSource: args["baseline-source"], dryRun: args["dry-run"] === true, write: args.write === true, root: args.root ? path.resolve(args.root) : repositoryRoot, output: args.output ? path.resolve(args.output) : null });
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
