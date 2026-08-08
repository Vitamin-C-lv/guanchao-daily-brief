import { canonicalJson, sha256Canonical } from "./research-contract.mjs";

const OMIT_KEYS = new Set([
  "articleurl",
  "asof",
  "buildstatus",
  "countdowndays",
  "createdat",
  "dataasof",
  "datathrough",
  "date",
  "editiondate",
  "expectedat",
  "generatedat",
  "id",
  "integrity",
  "jobid",
  "publishedat",
  "publisheddate",
  "requestid",
  "resultid",
  "runtime",
  "runtimemetadata",
  "schemaversion",
  "slug",
  "updatedat",
  "visuals",
  "visualselections",
  "warnings",
  "writerengine",
  "writerversion",
]);

const SOURCE_ARRAY_KEYS = new Set(["documentids", "sourceids", "sourceindexes"]);
const JUDGMENT_KEYS = new Set([
  "analysis",
  "body",
  "conclusion",
  "condition",
  "dek",
  "explanation",
  "heading",
  "lead",
  "mainthesis",
  "note",
  "outlook",
  "summary",
  "statement",
  "subtitle",
  "thesis",
  "title",
  "whyitmatters",
]);

function lowerKey(key) {
  return String(key).toLowerCase();
}

function omitKey(key) {
  const lower = lowerKey(key);
  return OMIT_KEYS.has(lower)
    || lower.startsWith("frozen")
    || lower.startsWith("visual")
    || lower.startsWith("runtime");
}

function sourceId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.id === "string" ? value.id
    : typeof value.sourceId === "string" ? value.sourceId
      : typeof value.documentId === "string" ? value.documentId
        : typeof value.url === "string" ? value.url
          : null;
}

function sourceSet(value) {
  if (Array.isArray(value)) return value.map(sourceId).filter(Boolean).sort();
  if (value && typeof value === "object") return Object.entries(value).map(([key, item]) => sourceId(item) ?? key).sort();
  return [];
}

function normalize(value, key = "") {
  if (Array.isArray(value)) {
    if (SOURCE_ARRAY_KEYS.has(lowerKey(key))) return [...new Set(value.filter((item) => typeof item === "string"))].sort();
    return value.map((item) => normalize(item, key));
  }
  if (value === null || typeof value !== "object") return value;
  const output = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (omitKey(childKey)) continue;
    if (lowerKey(childKey) === "sourceindex") {
      output.sourceSet = sourceSet(child);
      continue;
    }
    if (lowerKey(childKey) === "claimbindings" || lowerKey(childKey) === "articledepth") continue;
    output[childKey] = normalize(child, childKey);
  }
  return output;
}

export function normalizeEditorialContent(value) {
  return normalize(value);
}

function collectSources(value, key = "", output = new Set()) {
  const lower = lowerKey(key);
  if (typeof value === "string") {
    if (lower === "sourceid" || lower === "documentid") output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    if (SOURCE_ARRAY_KEYS.has(lowerKey(key))) {
      for (const item of value) if (typeof item === "string") output.add(item);
      return output;
    }
    for (const item of value) collectSources(item, key, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  if (lower === "sourceindex") {
    for (const item of sourceSet(value)) output.add(item);
    return output;
  }
  if (lower === "sourceid" || lower === "documentid") {
    if (typeof value === "string") output.add(value);
    return output;
  }
  for (const [childKey, child] of Object.entries(value)) collectSources(child, childKey, output);
  return output;
}

function collectJudgments(value, key = "", output = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJudgments(item, key, output);
    return output;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && JUDGMENT_KEYS.has(lowerKey(key)) && value.trim()) output.push(`${lowerKey(key)}:${value.trim()}`);
    return output;
  }
  for (const [childKey, child] of Object.entries(value)) collectJudgments(child, childKey, output);
  return output;
}

function digest(value) {
  return sha256Canonical(normalizeEditorialContent(value));
}

export function compareEditorialContent(previous, current) {
  const previousDigest = previous === null || previous === undefined ? null : digest(previous);
  const currentDigest = digest(current);
  const previousSources = collectSources(previous ?? {});
  const currentSources = collectSources(current ?? {});
  const previousJudgments = new Set(collectJudgments(previous ?? {}));
  const currentJudgments = collectJudgments(current ?? {});
  return {
    previousEditorialDigest: previousDigest,
    currentEditorialDigest: currentDigest,
    contentChanged: previousDigest === null || previousDigest !== currentDigest,
    newSourcesCount: [...currentSources].filter((item) => !previousSources.has(item)).length,
    reusedSourcesCount: [...currentSources].filter((item) => previousSources.has(item)).length,
    newJudgmentsCount: currentJudgments.filter((item) => !previousJudgments.has(item)).length,
    previousSourceIds: [...previousSources].sort(),
    currentSourceIds: [...currentSources].sort(),
  };
}

export function enforceFreshEditionContent(previous, current, { sameEdition = false, correction = false } = {}) {
  const comparison = compareEditorialContent(previous, current);
  if (!sameEdition && !correction && !comparison.contentChanged) {
    const error = new Error("new edition editorial content is unchanged after runtime/date/visual normalization");
    error.code = "FRESH_EDITION_CONTENT_REQUIRED";
    throw error;
  }
  return comparison;
}

export function editorialDigest(value) {
  return {
    digest: digest(value),
    normalized: normalizeEditorialContent(value),
  };
}

export function canonicalNormalizedJson(value) {
  return canonicalJson(normalizeEditorialContent(value));
}
