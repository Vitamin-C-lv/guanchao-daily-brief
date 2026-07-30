import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

import { canonicalize, canonicalJson, sha256Canonical } from "./research-contract.mjs";
import {
  loadWriterContextRegistry,
  validateRepoRelativePath,
  validateWriterContext,
  validateWriterContextArtifacts
} from "./writer-context.mjs";

const modulePath = fileURLToPath(import.meta.url);
export const root = path.resolve(path.dirname(modulePath), "..");
export const requestVersion = "writer-request-v2";
export const resultVersion = "writer-result-v2";
export const canonical = canonicalize;
export const hash = sha256Canonical;

const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CONTEXT_PATH = /^data\/writer-contexts\/contexts\/\d{4}\/\d{2}\/[a-f0-9]{64}\.json\.gz$/;
const FORBIDDEN_FIELDS = new Set(["probability", "probabilities", "ranking", "rankings", "publicationstatus", "publicationgate", "modelstate", "modelstatus", "evidencescore", "return", "returns", "threshold", "thresholds"]);
const QUALITATIVE_UNCERTAINTY = {
  conflicting: /冲突|分歧|不一致|尚不能确认|无法确认|不确定|conflict|uncertain|disagree/i,
  unverified: /未验证|未经验证|尚未确认|无法确认|不确定|unverified|not verified/i
};
const SOURCE_METADATA_FIELDS = new Set(["title", "publisher", "canonicalUrl", "publishedDate", "publishedAt"]);
const EXPORT_FILES = ["BASELINE_CONTENT.json", "PROMPT.md", "QUANTITATIVE_PACKET.json", "REQUEST.json", "RESEARCH_BUNDLE.json", "RESULT_TEMPLATE.json", "TARGET_SCHEMA.json", "WRITER_CONTEXT.json"];

function object(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function error(errorCode, field, message, expected, actual) {
  const failure = new Error(JSON.stringify({ errorCode, path: field, message, expected, actual }));
  failure.errorCode = errorCode;
  throw failure;
}

function exactKeys(value, required, allowed, field) {
  if (!object(value)) error("INVALID_TYPE", field, "object required");
  for (const key of required) if (!Object.hasOwn(value, key)) error("MISSING_KEY", `${field}.${key}`, "required key missing");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) error("UNKNOWN_KEY", `${field}.${key}`, "unknown key");
}

function nonempty(value, field) {
  if (typeof value !== "string" || !value.length) error("INVALID_TYPE", field, "nonempty string required");
}

function validHash(value, field) {
  if (typeof value !== "string" || !HASH.test(value)) error("INVALID_HASH", field, "lowercase SHA-256 required");
}

function isoDate(value, field) {
  if (typeof value !== "string" || !DATE.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) error("INVALID_DATE", field, "valid YYYY-MM-DD required");
}

function isoTimestamp(value, field) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || new Date(value).toISOString() !== value) error("INVALID_TIMESTAMP", field, "canonical UTC timestamp required");
}

function warnings(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.length) || new Set(value).size !== value.length || value.some((item, index) => item !== [...value].sort()[index])) error("INVALID_WARNINGS", field, "sorted unique warnings required");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function gzip(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    error("JSON_INVALID", file, "JSON file missing or invalid");
  }
}

function gunzipJsonBytes(bytes, field) {
  try {
    return JSON.parse(gunzipSync(bytes).toString("utf8"));
  } catch {
    error("GZIP_INVALID", field, "gzip JSON artifact invalid");
  }
}

function gunzipJson(file) {
  return gunzipJsonBytes(fs.readFileSync(file), file);
}

function relative(rootDir, file) {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

function resolveRelative(rootDir, value, field) {
  try {
    validateRepoRelativePath(value, field);
  } catch (cause) {
    error("UNSAFE_PATH", field, cause instanceof Error ? cause.message : "unsafe path");
  }
  const base = path.resolve(rootDir);
  const resolved = path.resolve(base, ...value.split("/"));
  const relation = path.relative(base, resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) error("UNSAFE_PATH", field, "path escapes repository");
  return resolved;
}

function ensureOutsideRoot(output, rootDir, field = "output") {
  if (!path.isAbsolute(output)) error("OUTPUT_PATH", field, "absolute output path required");
  const relation = path.relative(path.resolve(rootDir), path.resolve(output));
  if (!relation || (!relation.startsWith("..") && !path.isAbsolute(relation))) error("OUTPUT_PATH", field, "output must be outside repository");
}

function assertNoAbsolute(value, field) {
  if (typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"))) error("LOCAL_ABSOLUTE_PATH", field, "local absolute paths are forbidden");
  if (Array.isArray(value)) value.forEach((item, index) => assertNoAbsolute(item, `${field}[${index}]`));
  if (object(value)) Object.entries(value).forEach(([key, item]) => assertNoAbsolute(item, `${field}.${key}`));
}

function fullLogicalHash(value) {
  const { integrity, ...body } = value;
  return hash({ ...body, integrity: { businessSha256: integrity?.businessSha256 } });
}

function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staged = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staged, bytes);
    fs.renameSync(staged, file);
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
  }
}

function writeJson(file, value) {
  atomicBytes(file, jsonBytes(value));
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

function pruneEmptyParents(file, rootDir) {
  let current = path.dirname(file);
  const stop = path.resolve(rootDir);
  while (current.startsWith(stop) && current !== stop) {
    if (!fs.existsSync(current) || fs.readdirSync(current).length) break;
    fs.rmdirSync(current);
    current = path.dirname(current);
  }
}

function commit(entries, failAt, rootDir) {
  const backups = [];
  try {
    for (const entry of entries) {
      backups.push({ file: entry.file, before: fs.existsSync(entry.file) ? fs.readFileSync(entry.file) : null });
      atomicBytes(entry.file, entry.bytes);
      if (failAt === entry.kind) throw new Error(`INJECTED_${entry.kind}`);
    }
  } catch (cause) {
    const rollbackFailures = [];
    for (const backup of backups.reverse()) {
      try {
        if (backup.before === null) {
          if (fs.existsSync(backup.file)) fs.unlinkSync(backup.file);
          pruneEmptyParents(backup.file, rootDir);
        } else atomicBytes(backup.file, backup.before);
      } catch {
        rollbackFailures.push(backup.file);
      }
    }
    if (rollbackFailures.length) error("APPLY_ROLLBACK_FAILED", "apply", "rollback failed", rollbackFailures);
    throw cause;
  }
}

function short(text, max) {
  return [...text].length <= max ? text : `${[...text].slice(0, max - 1).join("")}…`;
}

export function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function createWriterJobPaths(rootDir = root) {
  const base = path.join(rootDir, "data", "writer-jobs");
  return {
    base,
    packet: (id, date) => path.join(base, "packets", date.slice(0, 4), date.slice(5, 7), `${id}.json.gz`),
    request: (id, date) => path.join(base, "requests", date.slice(0, 4), date.slice(5, 7), `${id}.json`),
    accepted: (id, date) => path.join(base, "accepted", date.slice(0, 4), date.slice(5, 7), `${id}.json.gz`),
    index: path.join(base, "index.json"),
    pending: (edition) => path.join(rootDir, "content", "writer-jobs", `${edition}-pending.json`)
  };
}

function contextReference(rootDir, contextPath) {
  if (typeof contextPath !== "string" || !CONTEXT_PATH.test(contextPath)) error("REQUEST_CONTEXT_PATH", "context", "explicit immutable writer-context path required");
  const file = resolveRelative(rootDir, contextPath, "context");
  if (!fs.existsSync(file)) error("REQUEST_CONTEXT_MISSING", "context", "writer context artifact is missing");
  const bytes = fs.readFileSync(file);
  const context = gunzipJsonBytes(bytes, contextPath);
  const registry = loadWriterContextRegistry(rootDir);
  try {
    validateWriterContext(context, registry, { root: rootDir });
  } catch (cause) {
    error("REQUEST_CONTEXT_INVALID", "context", cause instanceof Error ? cause.message : "writer context invalid");
  }
  if (path.basename(contextPath) !== `${context.contextId}.json.gz`) error("REQUEST_CONTEXT_ID", "context", "context path and internal ID differ");
  return { file, bytes, context, registry, reference: { schemaVersion: context.schemaVersion, artifactPath: contextPath, artifactSha256: hashBytes(bytes), contextId: context.contextId } };
}

function requestBusinessView(request) {
  const { requestId, jobId, createdAt, integrity, ...business } = request;
  return business;
}

function requestStableView(request) {
  return { ...requestBusinessView(request), requestId: request.requestId, jobId: request.jobId, integrity: { businessSha256: request.integrity.businessSha256 } };
}

function targetOutput(context, baseline) {
  return {
    targetPath: baseline.targetPath,
    contentType: context.edition === "daily" ? "daily-brief" : "weekly-report",
    targetSchemaVersion: context.targetSchemaVersion,
    validatorId: context.edition === "daily" ? "validate-brief" : "validate-weekly",
    validatorPath: context.targetValidator.path,
    validatorSha256: context.targetValidator.sha256,
    required: true
  };
}

export function makeRequest({ edition, contextPath, createdAt = new Date().toISOString(), rootDir = root }) {
  const loaded = contextReference(rootDir, contextPath);
  const { context, registry } = loaded;
  if (context.edition !== edition) error("REQUEST_CONTEXT_EDITION", "edition", "context edition differs from request", edition, context.edition);
  const inputs = validateWriterContextArtifacts(context, { root: rootDir, registry });
  const request = {
    schemaVersion: requestVersion,
    edition,
    requestedAsOf: context.asOf,
    createdAt,
    context: loaded.reference,
    writerPromptPath: context.writerPrompt.path,
    writerPromptSha256: context.writerPrompt.sha256,
    targetValidatorPath: context.targetValidator.path,
    targetValidatorSha256: context.targetValidator.sha256,
    targetSchemaVersion: context.targetSchemaVersion,
    targetOutputs: [targetOutput(context, inputs.baseline)],
    allowedFactIds: inputs.packet.facts.map((fact) => fact.factId).sort(),
    allowedObservationIds: inputs.bundle.observations.map((item) => item.observationId).sort(),
    allowedDocumentIds: inputs.bundle.documents.map((item) => item.documentId).sort(),
    requiredSections: ["counterEvidence", "explanation", "facts", "observation"],
    inputStatus: inputs.packet.providerHealth?.status === "ready" && inputs.bundle.coverage?.totals?.observations > 0 ? "ready" : "partial",
    requestId: "",
    jobId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  request.requestId = hash(requestBusinessView(request));
  request.jobId = request.requestId;
  request.integrity.businessSha256 = request.requestId;
  request.integrity.sha256 = fullLogicalHash(request);
  return validateRequest(request, { rootDir });
}

function assertSortedUniqueStrings(value, field, { nonempty = false } = {}) {
  if (!Array.isArray(value) || (nonempty && !value.length) || value.some((item) => typeof item !== "string" || !item.length) || new Set(value).size !== value.length || value.some((item, index) => item !== [...value].sort()[index])) error("INVALID_ARRAY", field, "sorted unique string array required");
}

export function validateLegacyRequestV1(request) {
  if (!object(request) || request.schemaVersion !== "writer-request-v1") error("LEGACY_REQUEST_SCHEMA", "schemaVersion", "writer-request-v1 fixture required");
  validHash(request.jobId, "jobId");
  nonempty(request.writerPacketPath, "writerPacketPath");
  return request;
}

export function validateRequest(request, { rootDir = root } = {}) {
  const keys = ["allowedDocumentIds", "allowedFactIds", "allowedObservationIds", "context", "createdAt", "edition", "inputStatus", "integrity", "jobId", "requestId", "requestedAsOf", "requiredSections", "schemaVersion", "targetOutputs", "targetSchemaVersion", "targetValidatorPath", "targetValidatorSha256", "writerPromptPath", "writerPromptSha256"];
  if (!object(request) || request.schemaVersion !== requestVersion) error("REQUEST_SCHEMA", "schemaVersion", "invalid writer request schema", requestVersion, request?.schemaVersion);
  exactKeys(request, keys, keys, "request");
  if (!["daily", "weekly"].includes(request.edition)) error("REQUEST_FIELDS", "edition", "daily or weekly required");
  isoDate(request.requestedAsOf, "requestedAsOf");
  isoTimestamp(request.createdAt, "createdAt");
  exactKeys(request.context, ["artifactPath", "artifactSha256", "contextId", "schemaVersion"], ["artifactPath", "artifactSha256", "contextId", "schemaVersion"], "request.context");
  if (request.context.schemaVersion !== "writer-context-v1" || !CONTEXT_PATH.test(request.context.artifactPath)) error("REQUEST_CONTEXT_PATH", "request.context", "immutable writer context reference required");
  validHash(request.context.artifactSha256, "request.context.artifactSha256");
  validHash(request.context.contextId, "request.context.contextId");
  for (const field of ["writerPromptPath", "targetValidatorPath"]) {
    nonempty(request[field], field);
    try { validateRepoRelativePath(request[field], field); } catch { error("UNSAFE_PATH", field, "unsafe frozen file path"); }
  }
  for (const field of ["writerPromptSha256", "targetValidatorSha256"]) validHash(request[field], field);
  nonempty(request.targetSchemaVersion, "targetSchemaVersion");
  if (!Array.isArray(request.targetOutputs) || request.targetOutputs.length !== 1) error("REQUEST_TARGETS", "targetOutputs", "exactly one target required");
  const target = request.targetOutputs[0];
  const targetKeys = ["contentType", "required", "targetPath", "targetSchemaVersion", "validatorId", "validatorPath", "validatorSha256"];
  exactKeys(target, targetKeys, targetKeys, "request.targetOutputs[0]");
  if (typeof target.required !== "boolean" || !target.required || !["daily-brief", "weekly-report"].includes(target.contentType)) error("REQUEST_TARGETS", "targetOutputs", "invalid target");
  try { validateRepoRelativePath(target.targetPath, "targetOutputs.targetPath"); validateRepoRelativePath(target.validatorPath, "targetOutputs.validatorPath"); } catch { error("REQUEST_TARGETS", "targetOutputs", "unsafe target path"); }
  validHash(target.validatorSha256, "targetOutputs.validatorSha256");
  for (const [field, nonemptyArray] of [["allowedFactIds", true], ["allowedObservationIds", false], ["allowedDocumentIds", false], ["requiredSections", true]]) assertSortedUniqueStrings(request[field], field, { nonempty: nonemptyArray });
  if (!["ready", "partial"].includes(request.inputStatus)) error("REQUEST_FIELDS", "inputStatus", "ready or partial required");
  validHash(request.requestId, "requestId");
  validHash(request.jobId, "jobId");
  const expectedId = hash(requestBusinessView(request));
  if (request.requestId !== expectedId || request.jobId !== expectedId) error("REQUEST_JOB_ID", "requestId/jobId", "request IDs do not match stable business identity");
  exactKeys(request.integrity, ["businessSha256", "sha256"], ["businessSha256", "sha256"], "request.integrity");
  if (request.integrity.businessSha256 !== expectedId || request.integrity.sha256 !== fullLogicalHash(request)) error("REQUEST_INTEGRITY", "integrity", "request integrity mismatch");
  assertNoAbsolute(request, "request");

  const loaded = contextReference(rootDir, request.context.artifactPath);
  if (loaded.reference.artifactSha256 !== request.context.artifactSha256) error("REQUEST_CONTEXT_SHA", "request.context.artifactSha256", "context bytes changed");
  if (loaded.context.contextId !== request.context.contextId) error("REQUEST_CONTEXT_ID", "request.context.contextId", "context ID mismatch");
  if (loaded.context.edition !== request.edition || loaded.context.asOf !== request.requestedAsOf) error("REQUEST_CONTEXT_COMPATIBILITY", "request.context", "context edition/asOf mismatch");
  const inputs = validateWriterContextArtifacts(loaded.context, { root: rootDir, registry: loaded.registry });
  if (request.writerPromptPath !== loaded.context.writerPrompt.path || request.writerPromptSha256 !== loaded.context.writerPrompt.sha256) error("PROMPT_SHA_MISMATCH", "writerPrompt", "request prompt binding differs from context");
  if (request.targetValidatorPath !== loaded.context.targetValidator.path || request.targetValidatorSha256 !== loaded.context.targetValidator.sha256) error("TARGET_VALIDATOR_SHA_MISMATCH", "targetValidator", "request validator binding differs from context");
  if (request.targetSchemaVersion !== loaded.context.targetSchemaVersion || target.targetSchemaVersion !== loaded.context.targetSchemaVersion) error("TARGET_SCHEMA_VERSION_MISMATCH", "targetSchemaVersion", "target schema differs from context");
  const expectedTarget = targetOutput(loaded.context, inputs.baseline);
  if (canonicalJson(target) !== canonicalJson(expectedTarget)) error("REQUEST_TARGETS", "targetOutputs", "target differs from immutable baseline/context");
  if (canonicalJson(request.allowedFactIds) !== canonicalJson(inputs.packet.facts.map((item) => item.factId).sort()) || canonicalJson(request.allowedObservationIds) !== canonicalJson(inputs.bundle.observations.map((item) => item.observationId).sort()) || canonicalJson(request.allowedDocumentIds) !== canonicalJson(inputs.bundle.documents.map((item) => item.documentId).sort())) error("REQUEST_EVIDENCE_INDEX", "allowed IDs", "request evidence index differs from context artifacts");
  return request;
}

function derived(rootDir, requestOverrides = [], acceptedOverrides = new Set()) {
  const paths = createWriterJobPaths(rootDir);
  const files = walk(path.join(paths.base, "requests")).filter((file) => file.endsWith(".json"));
  const byId = new Map();
  for (const file of files) {
    const request = validateRequest(readJson(file), { rootDir });
    if (path.basename(file) !== `${request.jobId}.json`) error("REQUEST_PATH", relative(rootDir, file), "request path and job ID differ");
    byId.set(request.jobId, { request, file });
  }
  for (const request of requestOverrides) byId.set(request.jobId, { request, file: paths.request(request.jobId, request.requestedAsOf) });
  const jobs = [...byId.values()].map(({ request, file }) => ({
    jobId: request.jobId,
    requestId: request.requestId,
    contextId: request.context.contextId,
    edition: request.edition,
    requestedAsOf: request.requestedAsOf,
    createdAt: request.createdAt,
    requestPath: relative(rootDir, file),
    inputStatus: request.inputStatus,
    accepted: acceptedOverrides.has(request.jobId) || fs.existsSync(paths.accepted(request.jobId, request.requestedAsOf))
  })).sort((left, right) => left.edition.localeCompare(right.edition) || left.requestedAsOf.localeCompare(right.requestedAsOf) || left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId));
  const index = { schemaVersion: "writer-job-index-v2", sort: ["edition", "requestedAsOf", "createdAt", "jobId"], jobs };
  const pending = Object.fromEntries(["daily", "weekly"].map((edition) => {
    const job = jobs.filter((item) => item.edition === edition && !item.accepted).sort((left, right) => left.requestedAsOf.localeCompare(right.requestedAsOf) || left.createdAt.localeCompare(right.createdAt) || left.jobId.localeCompare(right.jobId)).at(-1) ?? null;
    return [edition, { schemaVersion: "writer-job-pending-v2", edition, job }];
  }));
  return { index, pending };
}

export function rebuild(rootDir = root) {
  const paths = createWriterJobPaths(rootDir);
  const next = derived(rootDir);
  const entries = [
    { file: paths.index, bytes: jsonBytes(next.index), kind: "writer-index" },
    { file: paths.pending("daily"), bytes: jsonBytes(next.pending.daily), kind: "daily-pending" },
    { file: paths.pending("weekly"), bytes: jsonBytes(next.pending.weekly), kind: "weekly-pending" }
  ];
  commit(entries, null, rootDir);
  return next.index.jobs;
}

export function prepare({ edition, contextPath, dryRun = false, write = false, rootDir = root, createdAt = new Date().toISOString(), failAt = null } = {}) {
  if (dryRun === write) error("PREPARE_MODE", "mode", "exactly one of dryRun or write is required");
  if (!["daily", "weekly"].includes(edition)) error("PREPARE_ARGUMENT", "edition", "daily or weekly required");
  if (typeof contextPath !== "string") error("PREPARE_ARGUMENT", "context", "explicit immutable context required");
  const request = makeRequest({ edition, contextPath, createdAt, rootDir });
  const paths = createWriterJobPaths(rootDir);
  const file = paths.request(request.jobId, request.requestedAsOf);
  let effective = request;
  let existing = false;
  if (fs.existsSync(file)) {
    effective = validateRequest(readJson(file), { rootDir });
    existing = true;
    if (canonicalJson(requestStableView(effective)) !== canonicalJson(requestStableView(request))) error("JOB_CONFLICT", relative(rootDir, file), "same job ID has conflicting stable identity");
  }
  const next = derived(rootDir, existing ? [] : [effective]);
  const entries = existing ? [] : [
    { file, bytes: jsonBytes(effective), kind: "request" },
    { file: paths.index, bytes: jsonBytes(next.index), kind: "writer-index" },
    { file: paths.pending("daily"), bytes: jsonBytes(next.pending.daily), kind: "daily-pending" },
    { file: paths.pending("weekly"), bytes: jsonBytes(next.pending.weekly), kind: "weekly-pending" }
  ];
  if (write && entries.length) commit(entries, failAt, rootDir);
  return {
    request: effective,
    summary: {
      schemaVersion: "writer-job-prepare-summary-v2",
      edition,
      requestedAsOf: effective.requestedAsOf,
      contextId: effective.context.contextId,
      requestId: effective.requestId,
      jobId: effective.jobId,
      requestPath: relative(rootDir, file),
      inputStatus: effective.inputStatus,
      factCount: effective.allowedFactIds.length,
      observationCount: effective.allowedObservationIds.length,
      documentCount: effective.allowedDocumentIds.length,
      targetCount: effective.targetOutputs.length,
      created: !existing,
      noOp: existing,
      dryRun,
      wouldWrite: entries.map((entry) => relative(rootDir, entry.file))
    }
  };
}

function resultBusinessView(result) {
  const { resultId, generatedAt, warnings: auditWarnings, integrity, ...business } = result;
  return business;
}

function resultStableView(result) {
  return { ...resultBusinessView(result), resultId: result.resultId, integrity: { businessSha256: result.integrity.businessSha256 } };
}

export function sealWriterResult(result) {
  const sealed = structuredClone(result);
  sealed.resultId = hash(resultBusinessView(sealed));
  sealed.integrity = { businessSha256: sealed.resultId, sha256: "" };
  sealed.integrity.sha256 = fullLogicalHash(sealed);
  return sealed;
}

function parseClaimPath(claimPath) {
  if (typeof claimPath !== "string" || !/^\$\.payload(?:\.[A-Za-z_$][\w$]*|\[\d+\])+$/.test(claimPath) || /(?:__proto__|prototype|constructor)/.test(claimPath)) error("CLAIM_PATH", "claimPath", "safe $.payload path required");
  return claimPath.slice("$.payload".length).match(/[A-Za-z_$][\w$]*|\[\d+\]/g)?.map((token) => token.startsWith("[") ? Number(token.slice(1, -1)) : token) ?? [];
}

function claimValue(payload, claimPath) {
  let value = payload;
  for (const key of parseClaimPath(claimPath)) {
    if (value === null || value === undefined || !Object.hasOwn(value, key)) error("CLAIM_TARGET_MISSING", claimPath, "claim target is absent");
    value = value[key];
  }
  if (object(value) || Array.isArray(value)) error("CLAIM_TARGET_NON_PRIMITIVE", claimPath, "claim target must be primitive");
  return value;
}

function diffPaths(before, after, base = "$.payload") {
  if (before === after) return [];
  if (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)) return [];
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!(Array.isArray(before) || before === undefined) || !(Array.isArray(after) || after === undefined)) return [base];
    const length = Math.max(before?.length ?? 0, after?.length ?? 0);
    if (!length) return [base];
    return Array.from({ length }, (_, index) => diffPaths(before?.[index], after?.[index], `${base}[${index}]`)).flat();
  }
  if (object(before) || object(after)) {
    if (!(object(before) || before === undefined) || !(object(after) || after === undefined)) return [base];
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();
    if (!keys.length) return [base];
    return keys.flatMap((key) => diffPaths(before?.[key], after?.[key], `${base}.${key}`));
  }
  return [base];
}

function allowedFormattingOrDatePath(edition, claimPath) {
  const daily = new Set(["$.payload.meta.editionDate", "$.payload.meta.generatedAt", "$.payload.meta.dataThrough"]);
  const weekly = new Set(["$.payload.report.weekStart", "$.payload.report.weekEnd", "$.payload.report.generatedAt", "$.payload.report.revision"]);
  return (edition === "daily" ? daily : weekly).has(claimPath);
}

function forbiddenChangedPath(claimPath) {
  return claimPath.split(/[.\[\]]/).filter(Boolean).some((segment) => FORBIDDEN_FIELDS.has(segment.toLowerCase()));
}

function renderedFactValue(fact) {
  if (fact.value === null) return null;
  return `${Number(fact.value.toFixed(2)).toString()}${fact.unit === "percent" ? "%" : "bp"}`;
}

function expectedClaimMode(status) {
  if (status === "ready") return "value";
  if (status === "partial") return "partial";
  if (status === "stale") return "delayed";
  return "unavailable";
}

function validateQuantitativeBindings(bindings, context, request, payload, changed, bound) {
  const facts = new Map(context.packet.facts.map((fact) => [fact.factId, fact]));
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const field = `claimBindings.quantitative[${index}]`;
    exactKeys(binding, ["claimPath", "claimText", "factId", "renderedValue"], ["claimPath", "claimText", "factId", "renderedValue"], field);
    nonempty(binding.claimText, `${field}.claimText`);
    nonempty(binding.factId, `${field}.factId`);
    if (!(typeof binding.renderedValue === "string" || binding.renderedValue === null)) error("QUANTITATIVE_BINDING", `${field}.renderedValue`, "string or null required");
    parseClaimPath(binding.claimPath);
    if (bound.has(binding.claimPath)) error("CLAIM_PATH_DUPLICATE", binding.claimPath, "a changed field may have one binding only");
    if (!changed.has(binding.claimPath)) error("UNCHANGED_REBOUND", binding.claimPath, "unchanged baseline content cannot be relabeled as new evidence");
    const fact = facts.get(binding.factId);
    if (!fact || !request.allowedFactIds.includes(binding.factId)) error("FACT_NOT_ALLOWED", `${field}.factId`, "fact is not in immutable packet/request");
    const rendered = renderedFactValue(fact);
    if (binding.renderedValue !== rendered) error("FACT_VALUE", `${field}.renderedValue`, "rendered value differs from packet fact");
    const actual = claimValue(payload, binding.claimPath);
    const mode = expectedClaimMode(fact.status);
    if (typeof actual === "number") {
      if (actual !== fact.value || binding.claimText !== binding.renderedValue || mode === "unavailable") error("FACT_VALUE", binding.claimPath, "numeric claim differs from packet");
    } else if (typeof actual === "string") {
      if (actual !== binding.claimText) error("FACT_CLAIM_TEXT", binding.claimPath, "text target differs from claim text");
      if (rendered && !actual.includes(rendered)) error("FACT_VALUE", binding.claimPath, "claim text omits rendered value");
      if (mode === "partial" && !/部分数据|数据不完整/.test(actual)) error("FACT_STATUS", binding.claimPath, "partial status must remain explicit");
      if (mode === "delayed" && (!/数据延迟|截至/.test(actual) || /最新|刚刚|当前实时/.test(actual))) error("FACT_STATUS", binding.claimPath, "stale status language invalid");
      if (mode === "unavailable" && (!/数据不可用|暂无数据/.test(actual) || /\d/.test(actual))) error("FACT_STATUS", binding.claimPath, "unavailable status language invalid");
    } else error("FACT_VALUE", binding.claimPath, "quantitative target must be string or number");
    bound.add(binding.claimPath);
  }
}

function validateQualitativeBindings(bindings, context, request, payload, changed, bound) {
  const observations = new Map(context.bundle.observations.map((item) => [item.observationId, item]));
  const documents = new Map(context.bundle.documents.map((item) => [item.documentId, item]));
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const field = `claimBindings.qualitative[${index}]`;
    exactKeys(binding, ["claimPath", "claimText", "documentIds", "evidenceState", "observationIds"], ["claimPath", "claimText", "documentIds", "evidenceState", "observationIds"], field);
    nonempty(binding.claimText, `${field}.claimText`);
    parseClaimPath(binding.claimPath);
    assertSortedUniqueStrings(binding.observationIds, `${field}.observationIds`, { nonempty: true });
    assertSortedUniqueStrings(binding.documentIds, `${field}.documentIds`, { nonempty: true });
    if (bound.has(binding.claimPath)) error("CLAIM_PATH_DUPLICATE", binding.claimPath, "a changed field may have one binding only");
    if (!changed.has(binding.claimPath)) error("UNCHANGED_REBOUND", binding.claimPath, "unchanged baseline content cannot be relabeled as new evidence");
    const selected = binding.observationIds.map((id) => {
      const observation = observations.get(id);
      if (!observation || !request.allowedObservationIds.includes(id)) error("OBSERVATION_NOT_ALLOWED", `${field}.observationIds`, "observation is not in immutable bundle/request");
      return observation;
    });
    if (selected.some((item) => item.evidenceState !== binding.evidenceState)) error("EVIDENCE_STATE", `${field}.evidenceState`, "evidence state differs from bundle");
    const requiredDocuments = new Set(selected.flatMap((item) => item.basis.map((basis) => basis.documentId)));
    for (const id of binding.documentIds) if (!documents.has(id) || !request.allowedDocumentIds.includes(id)) error("DOCUMENT_NOT_ALLOWED", `${field}.documentIds`, "document is not in immutable bundle/request");
    for (const id of requiredDocuments) if (!binding.documentIds.includes(id)) error("DOCUMENT_COVERAGE", `${field}.documentIds`, "document IDs do not cover observation basis");
    const actual = claimValue(payload, binding.claimPath);
    if (typeof actual !== "string" || actual !== binding.claimText) error("QUALITATIVE_CLAIM_TEXT", binding.claimPath, "qualitative claim target differs from claim text");
    const uncertainty = QUALITATIVE_UNCERTAINTY[binding.evidenceState];
    if (uncertainty && !uncertainty.test(actual)) error("EVIDENCE_LANGUAGE", binding.claimPath, `${binding.evidenceState} claim must preserve uncertainty`);
    bound.add(binding.claimPath);
  }
}

function validateSourceMetadataBindings(bindings, context, request, payload, changed, bound) {
  const documents = new Map(context.bundle.documents.map((item) => [item.documentId, item]));
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const field = `claimBindings.sourceMetadata[${index}]`;
    exactKeys(binding, ["claimPath", "claimText", "documentId", "metadataField"], ["claimPath", "claimText", "documentId", "metadataField"], field);
    nonempty(binding.claimText, `${field}.claimText`);
    if (!SOURCE_METADATA_FIELDS.has(binding.metadataField)) error("SOURCE_METADATA_FIELD", `${field}.metadataField`, "only frozen document metadata may be repeated");
    parseClaimPath(binding.claimPath);
    if (bound.has(binding.claimPath)) error("CLAIM_PATH_DUPLICATE", binding.claimPath, "a changed field may have one binding only");
    if (!changed.has(binding.claimPath)) error("UNCHANGED_REBOUND", binding.claimPath, "unchanged baseline content cannot be relabeled as new evidence");
    const document = documents.get(binding.documentId);
    if (!document || !request.allowedDocumentIds.includes(binding.documentId)) error("DOCUMENT_NOT_ALLOWED", `${field}.documentId`, "document is not in immutable bundle/request");
    if (typeof document[binding.metadataField] !== "string" || binding.claimText !== document[binding.metadataField]) error("SOURCE_METADATA_VALUE", field, "claim must exactly repeat selected document metadata");
    const actual = claimValue(payload, binding.claimPath);
    if (typeof actual !== "string" || actual !== binding.claimText) error("SOURCE_METADATA_VALUE", binding.claimPath, "target differs from document metadata");
    bound.add(binding.claimPath);
  }
}

function assertNoFactClaims(value, field = "payload") {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoFactClaims(item, `${field}[${index}]`));
  if (!object(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "factClaims") error("FACT_CLAIMS_FORBIDDEN", `${field}.${key}`, "claimBindings is the only fact lineage source");
    assertNoFactClaims(item, `${field}.${key}`);
  }
}

export function validateResult(rootDir, request, result) {
  validateRequest(request, { rootDir });
  const loaded = contextReference(rootDir, request.context.artifactPath);
  const inputs = validateWriterContextArtifacts(loaded.context, { root: rootDir, registry: loaded.registry });
  const keys = ["claimBindings", "contextId", "generatedAt", "integrity", "jobId", "payload", "requestId", "resultId", "schemaVersion", "warnings", "writerEngine", "writerVersion"];
  exactKeys(result, keys, keys, "result");
  if (result.schemaVersion !== resultVersion) error("RESULT_SCHEMA", "schemaVersion", "writer-result-v2 required");
  if (result.jobId !== request.jobId || result.requestId !== request.requestId || result.contextId !== request.context.contextId) error("RESULT_METADATA", "jobId/requestId/contextId", "result does not bind request/context");
  isoTimestamp(result.generatedAt, "generatedAt");
  nonempty(result.writerEngine, "writerEngine");
  nonempty(result.writerVersion, "writerVersion");
  warnings(result.warnings, "warnings");
  if (!object(result.payload)) error("RESULT_PAYLOAD", "payload", "complete payload object required");
  assertNoAbsolute(result, "result");
  assertNoFactClaims(result.payload);
  exactKeys(result.claimBindings, ["qualitative", "quantitative", "sourceMetadata"], ["qualitative", "quantitative", "sourceMetadata"], "claimBindings");
  for (const key of ["quantitative", "qualitative", "sourceMetadata"]) if (!Array.isArray(result.claimBindings[key])) error("CLAIM_BINDINGS", `claimBindings.${key}`, "array required");
  if (!inputs.bundle.observations.length) {
    if (result.claimBindings.qualitative.length) error("EMPTY_OBSERVATIONS", "claimBindings.qualitative", "bundle has no qualitative observations");
    if (!result.warnings.includes("no-new-qualitative-observations")) error("EMPTY_OBSERVATIONS", "warnings", "empty observation bundle must remain explicit");
  }
  const changedList = diffPaths(inputs.baseline.payload, result.payload);
  const changed = new Set(changedList);
  for (const claimPath of changed) if (forbiddenChangedPath(claimPath)) error("FROZEN_FIELD_CHANGED", claimPath, "model/probability/ranking/return/threshold fields are frozen");
  const bound = new Set();
  validateQuantitativeBindings(result.claimBindings.quantitative, inputs, request, result.payload, changed, bound);
  validateQualitativeBindings(result.claimBindings.qualitative, inputs, request, result.payload, changed, bound);
  validateSourceMetadataBindings(result.claimBindings.sourceMetadata, inputs, request, result.payload, changed, bound);
  for (const claimPath of changed) if (!bound.has(claimPath) && !allowedFormattingOrDatePath(request.edition, claimPath)) error("UNBOUND_BASELINE_DIFF", claimPath, "every business change must bind immutable evidence");
  validHash(result.resultId, "resultId");
  const expectedId = hash(resultBusinessView(result));
  if (result.resultId !== expectedId) error("RESULT_INTEGRITY", "resultId", "result ID mismatch");
  exactKeys(result.integrity, ["businessSha256", "sha256"], ["businessSha256", "sha256"], "result.integrity");
  if (result.integrity.businessSha256 !== expectedId || result.integrity.sha256 !== fullLogicalHash(result)) error("RESULT_INTEGRITY", "integrity", "result integrity mismatch");
  return result;
}

function validatePayload(rootDir, target, payload) {
  if (target.contentType === "weekly-report") return;
  if (target.contentType !== "daily-brief") error("TARGET_SCHEMA_UNKNOWN", "contentType", "unknown target content type");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "writer-job-validator-"));
  try {
    const candidate = path.join(temporary, "candidate.json");
    writeJson(candidate, payload);
    const run = spawnSync(process.execPath, [path.join(rootDir, "scripts", "validate-brief.mjs"), "--input", candidate], { cwd: rootDir, encoding: "utf8" });
    if (run.status !== 0) error("TARGET_SCHEMA_INVALID", target.targetPath, (run.stderr || run.stdout || "target validator failed").trim());
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function weeklyDerived(rootDir, target, payload) {
  const report = payload.report;
  if (!report?.id || !report.revision || !report.weekStart || !report.weekEnd || !report.generatedAt || !report.title || !payload.executiveSummary?.weekVerdict) error("WEEKLY_INDEX_INVALID", "weekly report", "weekly report lacks derivation fields");
  const index = readJson(path.join(rootDir, "content/weekly-reports/index.json"));
  const entry = { id: report.id, weekStart: report.weekStart, weekEnd: report.weekEnd, publishedAt: report.generatedAt, title: report.title, summary: short(payload.executiveSummary.weekVerdict, 220), revision: report.revision };
  const old = index.reports.find((item) => item.id === entry.id);
  if (old && old.revision > entry.revision) error("WEEKLY_REVISION_REGRESSION", entry.id, "weekly revision regressed");
  if (old && old.revision === entry.revision && canonicalJson(old) !== canonicalJson(entry)) error("WEEKLY_INDEX_CONFLICT", entry.id, "same revision differs");
  const reports = [...index.reports.filter((item) => item.id !== entry.id), entry].sort((left, right) => left.weekEnd.localeCompare(right.weekEnd) || left.id.localeCompare(right.id));
  const nextIndex = { schemaVersion: 1, latestReportId: reports.at(-1)?.id ?? null, reports };
  const notices = readJson(path.join(rootDir, "public/update-notices.json"));
  if (report.id !== nextIndex.latestReportId) {
    if (!object(notices.weekly) || notices.weekly.href !== `/weekly/${nextIndex.latestReportId}/`) error("WEEKLY_NOTICE_INVALID", "weekly", "historical report requires a valid latest weekly notice");
    return { index: nextIndex, notices: { ...notices } };
  }
  const titles = (payload.executiveSummary.keyTakeaways ?? []).slice(0, 3).map((item) => short(item?.title ?? "", 64)).filter(Boolean);
  if (titles.length < 2) error("WEEKLY_NOTICE_DERIVATION_FAILED", "keyTakeaways", "weekly notice needs two highlights");
  return { index: nextIndex, notices: { ...notices, weekly: { noticeId: `${report.id}-r${report.revision}`, kind: "weekly", importance: 100, publishedAt: report.generatedAt, expiresAt: null, title: "观潮本周市场周报已更新", summary: short(payload.executiveSummary.weekVerdict, 180), selectionReason: "这是固定周报发布提醒，汇总本周经核验的重要变化。", highlights: titles, href: `/weekly/${report.id}/`, ctaLabel: "查看本周周报" } } };
}

function weeklyReportConflict(rootDir, target, payload) {
  const file = path.join(rootDir, ...target.targetPath.split("/"));
  if (!fs.existsSync(file)) return;
  const existing = readJson(file);
  if (existing.report?.id !== payload.report?.id) error("WEEKLY_REPORT_CONFLICT", target.targetPath, "existing report ID differs from candidate");
  if (existing.report?.revision > payload.report?.revision) error("WEEKLY_REVISION_REGRESSION", target.targetPath, "weekly revision regressed");
  if (existing.report?.revision === payload.report?.revision && canonicalJson(existing) !== canonicalJson(payload)) error("WEEKLY_REPORT_CONFLICT", target.targetPath, "same report revision differs");
}

function validateWeeklyPublication(rootDir, target, payload, publication) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "writer-weekly-publication-"));
  try {
    const report = path.join(temporary, "candidate-report.json");
    const index = path.join(temporary, "candidate-index.json");
    const notices = path.join(temporary, "candidate-notices.json");
    writeJson(report, payload);
    writeJson(index, publication.index);
    writeJson(notices, publication.notices);
    const run = spawnSync(process.execPath, [path.join(rootDir, "scripts", "validate-weekly.mjs"), "--candidate-report", report, "--candidate-index", index, "--candidate-notices", notices], { cwd: rootDir, encoding: "utf8" });
    if (run.status !== 0) error("WEEKLY_PUBLICATION_INVALID", target.targetPath, (run.stderr || run.stdout || "weekly publication validator failed").trim());
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function apply({ request, result, dryRun = false, write = false, rootDir = root, failAt = null } = {}) {
  if (dryRun === write) error("APPLY_MODE", "mode", "exactly one of dryRun or write is required");
  validateResult(rootDir, request, result);
  const target = request.targetOutputs[0];
  validatePayload(rootDir, target, result.payload);
  const paths = createWriterJobPaths(rootDir);
  const accepted = paths.accepted(request.jobId, request.requestedAsOf);
  if (fs.existsSync(accepted)) {
    const existing = gunzipJson(accepted);
    validateResult(rootDir, request, existing);
    if (canonicalJson(resultStableView(existing)) !== canonicalJson(resultStableView(result))) error("ACCEPTED_CONFLICT", relative(rootDir, accepted), "accepted result conflicts with stable result identity");
    return { noOp: true, applied: false, files: [] };
  }
  let publication = null;
  if (target.contentType === "weekly-report") {
    if (path.basename(target.targetPath, ".json") !== result.payload.report?.id) error("WEEKLY_TARGET_ID_MISMATCH", target.targetPath, "weekly target and report ID differ");
    weeklyReportConflict(rootDir, target, result.payload);
    publication = weeklyDerived(rootDir, target, result.payload);
    validateWeeklyPublication(rootDir, target, result.payload, publication);
  }
  const next = derived(rootDir, [], new Set([request.jobId]));
  const entries = [
    { file: path.join(rootDir, ...target.targetPath.split("/")), bytes: jsonBytes(result.payload), kind: target.contentType === "weekly-report" ? "weekly-report" : "target" },
    ...(publication ? [
      { file: path.join(rootDir, "content", "weekly-reports", "index.json"), bytes: jsonBytes(publication.index), kind: "weekly-index" },
      { file: path.join(rootDir, "public", "update-notices.json"), bytes: jsonBytes(publication.notices), kind: "weekly-notice" }
    ] : []),
    { file: accepted, bytes: gzip(result), kind: "accepted" },
    { file: paths.index, bytes: jsonBytes(next.index), kind: "writer-index" },
    { file: paths.pending("daily"), bytes: jsonBytes(next.pending.daily), kind: "daily-pending" },
    { file: paths.pending("weekly"), bytes: jsonBytes(next.pending.weekly), kind: "weekly-pending" }
  ];
  if (write) commit(entries, failAt, rootDir);
  return { noOp: false, applied: write, files: entries.map((entry) => relative(rootDir, entry.file)) };
}

export function createResultTemplate({ request, rootDir = root }) {
  validateRequest(request, { rootDir });
  const loaded = contextReference(rootDir, request.context.artifactPath);
  const inputs = validateWriterContextArtifacts(loaded.context, { root: rootDir, registry: loaded.registry });
  return {
    schemaVersion: "writer-result-template-v1",
    resultSchemaVersion: resultVersion,
    jobId: request.jobId,
    requestId: request.requestId,
    contextId: request.context.contextId,
    targetPath: request.targetOutputs[0].targetPath,
    availableEvidence: {
      quantitative: inputs.packet.facts.map((fact) => ({ factId: fact.factId, status: fact.status })).sort((left, right) => left.factId.localeCompare(right.factId)),
      qualitative: inputs.bundle.observations.map((item) => ({ observationId: item.observationId, evidenceState: item.evidenceState })).sort((left, right) => left.observationId.localeCompare(right.observationId)),
      sourceMetadata: inputs.bundle.documents.map((item) => ({ documentId: item.documentId, availableFields: [...SOURCE_METADATA_FIELDS].filter((field) => typeof item[field] === "string").sort() })).sort((left, right) => left.documentId.localeCompare(right.documentId))
    },
    resultTemplate: {
      schemaVersion: resultVersion,
      jobId: request.jobId,
      requestId: request.requestId,
      contextId: request.context.contextId,
      generatedAt: "<canonical UTC timestamp>",
      writerEngine: "<manual writer engine>",
      writerVersion: "<writer version>",
      payload: null,
      claimBindings: { quantitative: [], qualitative: [], sourceMetadata: [] },
      warnings: [],
      resultId: "<computed SHA-256>",
      integrity: { businessSha256: "<same as resultId>", sha256: "<full logical SHA-256>" }
    }
  };
}

export function writeResultTemplate({ request, output, rootDir = root }) {
  ensureOutsideRoot(output, rootDir);
  const value = createResultTemplate({ request, rootDir });
  atomicBytes(output, jsonBytes(value));
  return { output, sha256: hashBytes(fs.readFileSync(output)), jobId: request.jobId };
}

function deterministicManifest(request, context, files) {
  return {
    schemaVersion: "writer-execution-package-manifest-v1",
    requestId: request.requestId,
    jobId: request.jobId,
    contextId: context.contextId,
    contentIdentity: context.baselineContent.contentIdentity,
    writerPacketId: context.quantitativeWriterPacket.writerPacketId,
    bundleId: context.qualitativeResearchBundle.bundleId,
    files: files.map((item) => ({ path: item.name, bytes: item.bytes.length, sha256: hashBytes(item.bytes) })).sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function exportWriterJob({ request, outputDirectory, rootDir = root }) {
  validateRequest(request, { rootDir });
  ensureOutsideRoot(outputDirectory, rootDir, "outputDirectory");
  const loaded = contextReference(rootDir, request.context.artifactPath);
  const inputs = validateWriterContextArtifacts(loaded.context, { root: rootDir, registry: loaded.registry });
  if (fs.existsSync(outputDirectory)) {
    const allowed = new Set([...EXPORT_FILES, "MANIFEST.json", "SHA256SUMS.txt"]);
    const unexpected = fs.readdirSync(outputDirectory).filter((name) => !allowed.has(name));
    if (unexpected.length) error("EXPORT_DIRECTORY", "outputDirectory", "directory contains unrelated files", [], unexpected);
  } else fs.mkdirSync(outputDirectory, { recursive: true });
  const targetSchema = { schemaVersion: "writer-target-schema-reference-v1", targetSchemaVersion: request.targetSchemaVersion, targetPath: request.targetOutputs[0].targetPath, validator: { path: request.targetValidatorPath, sha256: request.targetValidatorSha256 } };
  const files = [
    { name: "REQUEST.json", bytes: jsonBytes(request) },
    { name: "WRITER_CONTEXT.json", bytes: jsonBytes(loaded.context) },
    { name: "QUANTITATIVE_PACKET.json", bytes: jsonBytes(inputs.packet) },
    { name: "RESEARCH_BUNDLE.json", bytes: jsonBytes(inputs.bundle) },
    { name: "BASELINE_CONTENT.json", bytes: jsonBytes(inputs.baseline) },
    { name: "PROMPT.md", bytes: fs.readFileSync(resolveRelative(rootDir, request.writerPromptPath, "writerPromptPath")) },
    { name: "TARGET_SCHEMA.json", bytes: jsonBytes(targetSchema) },
    { name: "RESULT_TEMPLATE.json", bytes: jsonBytes(createResultTemplate({ request, rootDir })) }
  ].sort((left, right) => left.name.localeCompare(right.name));
  const manifest = deterministicManifest(request, loaded.context, files);
  const manifestBytes = jsonBytes(manifest);
  const sums = [...files, { name: "MANIFEST.json", bytes: manifestBytes }].sort((left, right) => left.name.localeCompare(right.name)).map((item) => `${hashBytes(item.bytes)}  ${item.name}`).join("\n") + "\n";
  for (const item of files) atomicBytes(path.join(outputDirectory, item.name), item.bytes);
  atomicBytes(path.join(outputDirectory, "MANIFEST.json"), manifestBytes);
  atomicBytes(path.join(outputDirectory, "SHA256SUMS.txt"), Buffer.from(sums, "utf8"));
  return { schemaVersion: manifest.schemaVersion, outputDirectory, requestId: request.requestId, contextId: loaded.context.contextId, files: [...EXPORT_FILES, "MANIFEST.json", "SHA256SUMS.txt"].sort() };
}

function parseArgs(values) {
  const args = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--") continue;
    if (!values[index].startsWith("--")) error("CLI_ARGUMENT", "arguments", "unknown positional argument");
    const key = values[index].slice(2);
    if (!key || Object.hasOwn(args, key)) error("CLI_ARGUMENT", "arguments", "invalid or duplicate option");
    args[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return args;
}

function only(args, keys, command) {
  if (Object.keys(args).some((key) => !keys.includes(key))) error("CLI_ARGUMENT", command, "unknown option");
}

function requestFromArgument(rootDir, argument) {
  if (typeof argument !== "string") error("CLI_ARGUMENT", "request", "--request is required");
  const file = path.isAbsolute(argument) ? argument : path.resolve(rootDir, argument);
  return readJson(file);
}

function runCli() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  const rootDir = args.root && typeof args.root === "string" ? path.resolve(args.root) : root;
  if (command === "prepare") {
    only(args, ["edition", "context", "dry-run", "write", "root"], command);
    if (typeof args.edition !== "string" || typeof args.context !== "string" || (args["dry-run"] !== undefined && args["dry-run"] !== true) || (args.write !== undefined && args.write !== true)) error("CLI_ARGUMENT", command, "edition, context and exactly one mode are required");
    console.log(canonicalJson(prepare({ edition: args.edition, contextPath: args.context, dryRun: args["dry-run"] === true, write: args.write === true, rootDir }).summary));
    return;
  }
  if (command === "validate") {
    only(args, ["request", "result", "root"], command);
    const request = requestFromArgument(rootDir, args.request);
    if (typeof args.result !== "string") error("CLI_ARGUMENT", command, "--result is required");
    const result = readJson(path.isAbsolute(args.result) ? args.result : path.resolve(rootDir, args.result));
    validateResult(rootDir, request, result);
    console.log(canonicalJson({ valid: true, jobId: request.jobId, requestId: request.requestId, resultId: result.resultId }));
    return;
  }
  if (command === "template") {
    only(args, ["request", "output", "root"], command);
    if (typeof args.output !== "string") error("CLI_ARGUMENT", command, "--output is required");
    console.log(canonicalJson(writeResultTemplate({ request: requestFromArgument(rootDir, args.request), output: path.resolve(args.output), rootDir })));
    return;
  }
  if (command === "export") {
    only(args, ["request", "output", "root"], command);
    if (typeof args.output !== "string") error("CLI_ARGUMENT", command, "--output is required");
    console.log(canonicalJson(exportWriterJob({ request: requestFromArgument(rootDir, args.request), outputDirectory: path.resolve(args.output), rootDir })));
    return;
  }
  if (command === "apply") {
    only(args, ["request", "result", "dry-run", "write", "root"], command);
    if (typeof args.result !== "string" || (args["dry-run"] !== undefined && args["dry-run"] !== true) || (args.write !== undefined && args.write !== true)) error("CLI_ARGUMENT", command, "request, result and exactly one mode are required");
    const request = requestFromArgument(rootDir, args.request);
    const result = readJson(path.isAbsolute(args.result) ? args.result : path.resolve(rootDir, args.result));
    console.log(canonicalJson(apply({ request, result, dryRun: args["dry-run"] === true, write: args.write === true, rootDir })));
    return;
  }
  error("CLI_ARGUMENT", "command", "usage: prepare | validate | template | export | apply");
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  try {
    runCli();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : "writer job failure");
    process.exitCode = 1;
  }
}
