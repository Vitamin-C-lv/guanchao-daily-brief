import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateInvestmentStrategy } from "./investment-strategy-contract.mjs";

import { canonicalJson } from "./research-contract.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
export const GLOBAL_BRIEF_SCHEMA_VERSION = "global-market-brief-v1";
export const PUBLIC_DTO_SCHEMA_VERSION = "global-market-brief-public-dto-v1";
export const EVENT_SCHEMA_VERSION = "global-market-event-v1";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const HASH_LIKE = /^[a-z0-9][a-z0-9._:-]{1,119}$/;
const MARKETS = new Set(["US", "HK", "A_SHARE", "GLOBAL"]);
const EVENT_REGIONS = new Set(["US", "HK", "A_SHARE", "FED", "GLOBAL"]);
const DIRECTIONS = new Set(["positive", "negative", "mixed", "neutral"]);
const HORIZONS = new Set(["next_session", "one_week"]);
const FACT_STATUSES = new Set(["confirmed", "revised", "delayed", "estimated", "unavailable"]);
const EVIDENCE_STATUSES = new Set(["confirmed", "partially_confirmed", "pending", "reversed"]);
const TRIGGER_TYPES = new Set([
  "abnormal_market_move",
  "central_bank_policy",
  "macro_data_surprise",
  "geopolitical_risk",
  "major_earnings",
  "china_policy",
  "theme_reversal",
  "systemic_risk",
]);
const EVENT_TYPES = new Set([
  "macro-release",
  "monetary-policy",
  "fiscal-policy",
  "regulation",
  "company-event",
  "market-move",
  "technology",
  "commodity",
  "geopolitics",
  "calendar",
  "other",
]);
const EVENT_STATUSES = new Set(["new", "developing", "confirmed", "fading", "reversed"]);
const FORBIDDEN_KEYS = new Set([
  "accessToken",
  "articleText",
  "authToken",
  "authorization",
  "base64",
  "body",
  "cookie",
  "cookies",
  "evidenceScore",
  "fullText",
  "gateFailure",
  "gateFailures",
  "html",
  "imageData",
  "internalLineage",
  "localPath",
  "modelProbability",
  "modelState",
  "password",
  "path",
  "pdfBytes",
  "prediction",
  "probability",
  "provider",
  "providerDiagnostics",
  "providerError",
  "rawResearchPayload",
  "ranking",
  "runtimeLogs",
  "stack",
  "token",
]);
const NORMALIZED_FORBIDDEN_KEYS = new Set([...FORBIDDEN_KEYS].map((key) => key.toLowerCase().replaceAll("_", "").replaceAll("-", "")));

const TOP_KEYS = [
  "buildStatus",
  "dataAsOf",
  "editionDate",
  "generatedAt",
  "mainArticle",
  "schemaVersion",
  "sourceIndex",
  "specialReports",
  "specialTriggerCandidates",
];
const ARTICLE_KEYS = [
  "articleUrl",
  "analysisSections",
  "conclusion",
  "contentKind",
  "crossMarketTransmission",
  "dek",
  "id",
  "investmentStrategy",
  "invalidationConditions",
  "keyFacts",
  "logicChain",
  "marketTags",
  "outlook",
  "slug",
  "sourceIds",
  "title",
  "topicTags",
  "watchItems",
];
const SPECIAL_ARTICLE_KEYS = [...ARTICLE_KEYS, "analysis", "triggerCandidateId", "triggerEvidenceIds", "triggerReason", "triggerType"];
const KEY_FACT_KEYS = ["asOf", "factStatus", "id", "sourceIds", "statement", "unit", "value"];
const LOGIC_KEYS = ["contradictorySourceIds", "evidenceStatus", "from", "relation", "supportingSourceIds", "to"];
const TRANSMISSION_KEYS = [
  "direction",
  "explanation",
  "fromMarket",
  "horizon",
  "invalidationConditionIds",
  "supportingSourceIds",
  "toMarket",
  "evidenceStatus",
];
const OUTLOOK_KEYS = ["nextSession", "oneWeek"];
const OUTLOOK_ITEM_KEYS = ["invalidationConditionIds", "statement", "supportingSourceIds"];
const CONDITION_KEYS = ["affectedClaims", "condition", "id"];
const WATCH_ITEM_KEYS = ["expectedAt", "item", "sourceIds", "whyItMatters"];
const ANALYSIS_SECTION_KEYS = ["heading", "paragraphs", "sourceIds"];
const SOURCE_KEYS = ["asOf", "id", "publisher", "title", "url"];
const TRIGGER_KEYS = ["eligible", "id", "reason", "triggerEvidenceIds", "triggerType"];
const EVENT_KEYS = [
  "affectedAssets",
  "affectedThemes",
  "contradictorySourceIds",
  "direction",
  "eventType",
  "horizon",
  "marketConfirmation",
  "occurredAt",
  "region",
  "sourceConfidence",
  "status",
  "supportingSourceIds",
];

export class GlobalMarketBriefContractError extends Error {
  constructor(code, articleId, errorPath, reason) {
    super(`${articleId} ${errorPath} ${reason}`);
    this.name = "GlobalMarketBriefContractError";
    this.code = code;
    this.articleId = articleId;
    this.path = errorPath;
    this.reason = reason;
  }
}

function fail(code, articleId, errorPath, reason) {
  throw new GlobalMarketBriefContractError(code, articleId, errorPath, reason);
}

function isObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, allowed, articleId, errorPath) {
  if (!isObject(value)) fail("INVALID_TYPE", articleId, errorPath, "object required");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("MISSING_KEY", articleId, `${errorPath}.${key}`, "required key missing");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("UNKNOWN_KEY", articleId, `${errorPath}.${key}`, "unknown key");
}

function stringValue(value, articleId, errorPath, { max = 240, nonempty = true } = {}) {
  if (typeof value !== "string" || (nonempty && !value.trim())) fail("INVALID_TYPE", articleId, errorPath, "nonempty string required");
  if (typeof value === "string" && value.length > max) fail("LIMIT", articleId, errorPath, `string exceeds ${max} characters`);
  return value;
}

function enumValue(value, allowed, articleId, errorPath) {
  if (typeof value !== "string" || !allowed.has(value)) fail("INVALID_ENUM", articleId, errorPath, `value must be one of ${[...allowed].join(", ")}`);
}

function validDate(value, articleId, errorPath, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== "string" || !DATE.test(value)) fail("INVALID_DATE", articleId, errorPath, "YYYY-MM-DD date required");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail("INVALID_DATE", articleId, errorPath, "valid calendar date required");
}

function validTimestamp(value, articleId, errorPath) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || Number.isNaN(new Date(value).getTime()) || new Date(value).toISOString() !== value) {
    fail("INVALID_TIMESTAMP", articleId, errorPath, "canonical UTC timestamp required");
  }
}

function slugValue(value, articleId, errorPath) {
  stringValue(value, articleId, errorPath, { max: 80 });
  if (!SLUG.test(value)) fail("INVALID_SLUG", articleId, errorPath, "lowercase slug required");
}

function idValue(value, articleId, errorPath) {
  stringValue(value, articleId, errorPath, { max: 120 });
  if (!HASH_LIKE.test(value)) fail("INVALID_ID", articleId, errorPath, "stable lowercase identifier required");
}

function stringArray(value, articleId, errorPath, { min = 0, max = 50, itemMax = 120, known = null, subset = null } = {}) {
  if (!Array.isArray(value) || value.length < min || value.length > max || value.some((item) => typeof item !== "string" || !item.trim() || item.length > itemMax)) {
    fail("INVALID_ARRAY", articleId, errorPath, `unique nonempty string array with ${min}-${max} items required`);
  }
  if (new Set(value).size !== value.length) fail("DUPLICATE_VALUE", articleId, errorPath, "array values must be unique");
  if (known) for (const item of value) if (!known.has(item)) fail("UNKNOWN_SOURCE_ID", articleId, `${errorPath}[${value.indexOf(item)}]`, `source ID ${item} is not in sourceIndex`);
  if (subset) for (const item of value) if (!subset.has(item)) fail("ARTICLE_SOURCE_SCOPE", articleId, `${errorPath}[${value.indexOf(item)}]`, `source ID ${item} is not declared by the article`);
  return value;
}

function canonicalSourceUrl(value) {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}

function officialPublisherDomainPass(publisher, url) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (publisher === "Federal Reserve") return hostname === "federalreserve.gov" || hostname.endsWith(".federalreserve.gov");
  if (publisher === "U.S. Department of the Treasury") return hostname === "treasury.gov" || hostname.endsWith(".treasury.gov");
  return true;
}

function scanForbiddenKeys(value, articleId, errorPath = "$") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForbiddenKeys(item, articleId, `${errorPath}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const strategyProbability = errorPath.endsWith(".investmentStrategy.modelContext") && key === "probability";
    if (!strategyProbability && (FORBIDDEN_KEYS.has(key) || NORMALIZED_FORBIDDEN_KEYS.has(key.toLowerCase().replaceAll("_", "").replaceAll("-", "")))) {
      fail("FORBIDDEN_FIELD", articleId, `${errorPath}.${key}`, "provider/internal/model diagnostic or numeric probability field is forbidden");
    }
    scanForbiddenKeys(child, articleId, `${errorPath}.${key}`);
  }
}

function validateSourceIndex(value, articleId) {
  if (!Array.isArray(value) || value.length < 1) fail("INVALID_ARRAY", articleId, "sourceIndex", "at least one source is required");
  const ids = new Set();
  const canonicalUrls = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const source = value[index];
    const pathName = `sourceIndex[${index}]`;
    exactKeys(source, SOURCE_KEYS, SOURCE_KEYS, articleId, pathName);
    idValue(source.id, articleId, `${pathName}.id`);
    if (ids.has(source.id)) fail("DUPLICATE_ID", articleId, `${pathName}.id`, "source IDs must be unique");
    ids.add(source.id);
    stringValue(source.title, articleId, `${pathName}.title`, { max: 200 });
    stringValue(source.publisher, articleId, `${pathName}.publisher`, { max: 120 });
    stringValue(source.url, articleId, `${pathName}.url`, { max: 500 });
    let url;
    try {
      url = new URL(source.url);
    } catch {
      fail("INVALID_URL", articleId, `${pathName}.url`, "valid HTTPS source URL required");
    }
    if (url.protocol !== "https:") fail("INVALID_URL", articleId, `${pathName}.url`, "HTTPS source URL required");
    const canonical = canonicalSourceUrl(source.url);
    const previous = canonicalUrls.get(canonical);
    if (previous) fail("DUPLICATE_CANONICAL_URL", articleId, `${pathName}.url`, `canonical URL already belongs to ${previous}`);
    canonicalUrls.set(canonical, source.id);
    if (!officialPublisherDomainPass(source.publisher, source.url)) fail("OFFICIAL_PUBLISHER_DOMAIN", articleId, `${pathName}.publisher`, "official publisher must use its official domain or be downgraded to the real publisher");
    validDate(source.asOf, articleId, `${pathName}.asOf`, { nullable: true });
  }
  return ids;
}

function validateAnalysisSections(value, articleId, pathName, sourceIds, articleSourceIds) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) fail("INVALID_ARRAY", articleId, pathName, "one to seven analysis sections are required");
  const headings = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${pathName}[${index}]`;
    exactKeys(item, ANALYSIS_SECTION_KEYS, ANALYSIS_SECTION_KEYS, articleId, itemPath);
    stringValue(item.heading, articleId, `${itemPath}.heading`, { max: 120 });
    if (headings.has(item.heading)) fail("DUPLICATE_VALUE", articleId, `${itemPath}.heading`, "analysis section headings must be unique");
    headings.add(item.heading);
    stringArray(item.paragraphs, articleId, `${itemPath}.paragraphs`, { min: 1, max: 6, itemMax: 1200 });
    validateSourceRefs(item.sourceIds, articleId, `${itemPath}.sourceIds`, sourceIds, articleSourceIds, { min: 1 });
  }
}

function validateSourceRefs(value, articleId, errorPath, sourceIds, articleSourceIds, { min = 0 } = {}) {
  return stringArray(value, articleId, errorPath, { min, max: 50, itemMax: 120, known: sourceIds, subset: articleSourceIds });
}

function validateConditions(value, articleId, pathName) {
  if (!Array.isArray(value) || value.length < 1) fail("INVALID_ARRAY", articleId, pathName, "at least one invalidation condition is required");
  const ids = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const itemPath = `${pathName}[${index}]`;
    exactKeys(item, CONDITION_KEYS, CONDITION_KEYS, articleId, itemPath);
    idValue(item.id, articleId, `${itemPath}.id`);
    if (ids.has(item.id)) fail("DUPLICATE_ID", articleId, `${itemPath}.id`, "invalidation condition IDs must be unique");
    ids.add(item.id);
    stringValue(item.condition, articleId, `${itemPath}.condition`, { max: 500 });
    stringArray(item.affectedClaims, articleId, `${itemPath}.affectedClaims`, { min: 1, max: 20, itemMax: 160 });
  }
  return ids;
}

function validateOutlook(value, articleId, pathName, sourceIds, articleSourceIds, conditionIds) {
  exactKeys(value, OUTLOOK_KEYS, OUTLOOK_KEYS, articleId, pathName);
  for (const key of OUTLOOK_KEYS) {
    const item = value[key];
    const itemPath = `${pathName}.${key}`;
    exactKeys(item, OUTLOOK_ITEM_KEYS, OUTLOOK_ITEM_KEYS, articleId, itemPath);
    stringValue(item.statement, articleId, `${itemPath}.statement`, { max: 500 });
    validateSourceRefs(item.supportingSourceIds, articleId, `${itemPath}.supportingSourceIds`, sourceIds, articleSourceIds, { min: 1 });
    stringArray(item.invalidationConditionIds, articleId, `${itemPath}.invalidationConditionIds`, { min: 1, max: 20, itemMax: 120 });
    for (const id of item.invalidationConditionIds) if (!conditionIds.has(id)) fail("UNKNOWN_CONDITION_ID", articleId, `${itemPath}.invalidationConditionIds`, `condition ID ${id} is not declared`);
  }
}

function validateArticle(value, articleId, sourceIds, { special = false, dataAsOf = null, requireInvestmentStrategy = false, predictionRecords = null, root = undefined } = {}) {
  const keys = special ? SPECIAL_ARTICLE_KEYS : ARTICLE_KEYS;
  const expectedKeys = special
    ? keys.filter((key) => key !== "analysisSections" && key !== "investmentStrategy")
    : Object.hasOwn(value, "investmentStrategy") ? keys : keys.filter((key) => key !== "investmentStrategy");
  exactKeys(value, expectedKeys, keys, articleId, articleId);
  slugValue(value.id, articleId, `${articleId}.id`);
  slugValue(value.slug, articleId, `${articleId}.slug`);
  if (value.id !== value.slug) fail("ARTICLE_ID", articleId, `${articleId}.slug`, "id and slug must match");
  stringValue(value.articleUrl, articleId, `${articleId}.articleUrl`, { max: 200 });
  if (value.articleUrl !== `/articles/${value.slug}/`) fail("ARTICLE_URL", articleId, `${articleId}.articleUrl`, "articleUrl must be the canonical article route");
  stringValue(value.title, articleId, `${articleId}.title`, { max: 200 });
  stringValue(value.dek, articleId, `${articleId}.dek`, { max: 500 });
  stringValue(value.conclusion, articleId, `${articleId}.conclusion`, { max: 1200 });
  if (value.contentKind !== (special ? "special_report" : "global_main")) fail("CONTENT_KIND", articleId, `${articleId}.contentKind`, `contentKind must be ${special ? "special_report" : "global_main"}`);
  stringArray(value.sourceIds, articleId, `${articleId}.sourceIds`, { min: 1, max: 50, itemMax: 120, known: sourceIds });
  const articleSourceIds = new Set(value.sourceIds);
  stringArray(value.marketTags, articleId, `${articleId}.marketTags`, { min: 1, max: 4, itemMax: 20 });
  for (const tag of value.marketTags) if (!MARKETS.has(tag)) fail("INVALID_MARKET", articleId, `${articleId}.marketTags`, `market tag ${tag} is not supported`);
  stringArray(value.topicTags, articleId, `${articleId}.topicTags`, { min: 1, max: 20, itemMax: 80 });
  if (!special) validateInvestmentStrategy(value.investmentStrategy, { sourceIds, requireStrategy: requireInvestmentStrategy, edition: "daily", predictionRecords, root });

  if (!Array.isArray(value.keyFacts) || value.keyFacts.length < 1) fail("INVALID_ARRAY", articleId, `${articleId}.keyFacts`, "at least one key fact is required");
  const factIds = new Set();
  for (let index = 0; index < value.keyFacts.length; index += 1) {
    const fact = value.keyFacts[index];
    const factPath = `${articleId}.keyFacts[${index}]`;
    exactKeys(fact, KEY_FACT_KEYS.filter((key) => key !== "unit" && key !== "value"), KEY_FACT_KEYS, articleId, factPath);
    idValue(fact.id, articleId, `${factPath}.id`);
    if (factIds.has(fact.id)) fail("DUPLICATE_ID", articleId, `${factPath}.id`, "key fact IDs must be unique");
    factIds.add(fact.id);
    stringValue(fact.statement, articleId, `${factPath}.statement`, { max: 500 });
    validDate(fact.asOf, articleId, `${factPath}.asOf`);
    if (dataAsOf !== null && fact.asOf > dataAsOf) {
      fail("DATE_ORDER", articleId, `${factPath}.asOf`, `key fact asOf must not be later than dataAsOf ${dataAsOf}`);
    }
    validateSourceRefs(fact.sourceIds, articleId, `${factPath}.sourceIds`, sourceIds, articleSourceIds, { min: 1 });
    enumValue(fact.factStatus, FACT_STATUSES, articleId, `${factPath}.factStatus`);
    if (fact.value !== undefined && fact.value !== null && (typeof fact.value !== "number" || !Number.isFinite(fact.value))) fail("INVALID_TYPE", articleId, `${factPath}.value`, "finite number or null required");
    if (fact.unit !== undefined) stringValue(fact.unit, articleId, `${factPath}.unit`, { max: 80 });
    if (fact.factStatus === "unavailable" && (fact.value !== null || !Object.hasOwn(fact, "value"))) fail("UNAVAILABLE_VALUE", articleId, `${factPath}.value`, "unavailable facts must preserve value as null");
    if (fact.factStatus === "unavailable" && /\b0+(?:\.0+)?\b/.test(fact.statement)) fail("UNAVAILABLE_VALUE", articleId, `${factPath}.statement`, "unavailable facts must not be represented as zero");
  }

  if (!special || Object.hasOwn(value, "analysisSections")) validateAnalysisSections(value.analysisSections, articleId, `${articleId}.analysisSections`, sourceIds, articleSourceIds);

  if (!Array.isArray(value.logicChain) || value.logicChain.length < 1) fail("INVALID_ARRAY", articleId, `${articleId}.logicChain`, "at least one logic-chain edge is required");
  for (let index = 0; index < value.logicChain.length; index += 1) {
    const edge = value.logicChain[index];
    const edgePath = `${articleId}.logicChain[${index}]`;
    exactKeys(edge, LOGIC_KEYS, LOGIC_KEYS, articleId, edgePath);
    stringValue(edge.from, articleId, `${edgePath}.from`, { max: 120 });
    stringValue(edge.relation, articleId, `${edgePath}.relation`, { max: 120 });
    stringValue(edge.to, articleId, `${edgePath}.to`, { max: 120 });
    enumValue(edge.evidenceStatus, EVIDENCE_STATUSES, articleId, `${edgePath}.evidenceStatus`);
    const supportingSourceIds = validateSourceRefs(edge.supportingSourceIds, articleId, `${edgePath}.supportingSourceIds`, sourceIds, articleSourceIds);
    const contradictorySourceIds = validateSourceRefs(edge.contradictorySourceIds, articleId, `${edgePath}.contradictorySourceIds`, sourceIds, articleSourceIds);
    if (["confirmed", "partially_confirmed"].includes(edge.evidenceStatus) && supportingSourceIds.length < 1) {
      fail("LOGIC_EVIDENCE_REQUIRED", articleId, `${edgePath}.supportingSourceIds`, `${edge.evidenceStatus} logic edge requires at least one supporting source`);
    }
    if (edge.evidenceStatus === "reversed" && contradictorySourceIds.length < 1) {
      fail("LOGIC_EVIDENCE_REQUIRED", articleId, `${edgePath}.contradictorySourceIds`, "reversed logic edge requires at least one contradictory source");
    }
    if (edge.evidenceStatus === "pending" && supportingSourceIds.length + contradictorySourceIds.length < 1) {
      fail("LOGIC_EVIDENCE_REQUIRED", articleId, edgePath, "pending logic edge requires at least one supporting or contradictory source");
    }
  }

  if (!Array.isArray(value.crossMarketTransmission) || value.crossMarketTransmission.length < 1) fail("INVALID_ARRAY", articleId, `${articleId}.crossMarketTransmission`, "at least one cross-market transmission is required");
  for (let index = 0; index < value.crossMarketTransmission.length; index += 1) {
    const transmission = value.crossMarketTransmission[index];
    const transmissionPath = `${articleId}.crossMarketTransmission[${index}]`;
    exactKeys(transmission, TRANSMISSION_KEYS, TRANSMISSION_KEYS, articleId, transmissionPath);
    enumValue(transmission.fromMarket, MARKETS, articleId, `${transmissionPath}.fromMarket`);
    enumValue(transmission.toMarket, MARKETS, articleId, `${transmissionPath}.toMarket`);
    if (transmission.fromMarket === transmission.toMarket) fail("MARKET_EDGE", articleId, transmissionPath, "fromMarket and toMarket must differ");
    enumValue(transmission.direction, DIRECTIONS, articleId, `${transmissionPath}.direction`);
    enumValue(transmission.horizon, HORIZONS, articleId, `${transmissionPath}.horizon`);
    stringValue(transmission.explanation, articleId, `${transmissionPath}.explanation`, { max: 600 });
    enumValue(transmission.evidenceStatus, EVIDENCE_STATUSES, articleId, `${transmissionPath}.evidenceStatus`);
    validateSourceRefs(transmission.supportingSourceIds, articleId, `${transmissionPath}.supportingSourceIds`, sourceIds, articleSourceIds, { min: 1 });
    stringArray(transmission.invalidationConditionIds, articleId, `${transmissionPath}.invalidationConditionIds`, { min: 1, max: 20, itemMax: 120 });
  }

  const conditionIds = validateConditions(value.invalidationConditions, articleId, `${articleId}.invalidationConditions`);
  validateOutlook(value.outlook, articleId, `${articleId}.outlook`, sourceIds, articleSourceIds, conditionIds);
  for (const transmission of value.crossMarketTransmission) for (const id of transmission.invalidationConditionIds) if (!conditionIds.has(id)) fail("UNKNOWN_CONDITION_ID", articleId, `${articleId}.crossMarketTransmission`, `condition ID ${id} is not declared`);

  if (!Array.isArray(value.watchItems) || value.watchItems.length < 1) fail("INVALID_ARRAY", articleId, `${articleId}.watchItems`, "at least one watch item is required");
  for (let index = 0; index < value.watchItems.length; index += 1) {
    const watch = value.watchItems[index];
    const watchPath = `${articleId}.watchItems[${index}]`;
    exactKeys(watch, WATCH_ITEM_KEYS, WATCH_ITEM_KEYS, articleId, watchPath);
    stringValue(watch.item, articleId, `${watchPath}.item`, { max: 240 });
    stringValue(watch.whyItMatters, articleId, `${watchPath}.whyItMatters`, { max: 400 });
    if (watch.expectedAt !== null) validDate(watch.expectedAt, articleId, `${watchPath}.expectedAt`);
    validateSourceRefs(watch.sourceIds, articleId, `${watchPath}.sourceIds`, sourceIds, articleSourceIds, { min: 1 });
  }

  if (special) {
    stringValue(value.triggerReason, articleId, `${articleId}.triggerReason`, { max: 500 });
    stringArray(value.triggerEvidenceIds, articleId, `${articleId}.triggerEvidenceIds`, { min: 1, max: 20, itemMax: 120, known: sourceIds, subset: articleSourceIds });
    stringArray(value.analysis, articleId, `${articleId}.analysis`, { min: 1, max: 20, itemMax: 1000 });
    slugValue(value.triggerCandidateId, articleId, `${articleId}.triggerCandidateId`);
    validateOutlook(value.outlook, articleId, `${articleId}.outlook`, sourceIds, articleSourceIds, conditionIds);
  }
}

function validateTriggerCandidates(value, articleId, sourceIds) {
  if (!Array.isArray(value) || value.length > 20) fail("INVALID_ARRAY", articleId, "specialTriggerCandidates", "at most 20 trigger candidates are allowed");
  const ids = new Set();
  const candidates = new Map();
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const candidatePath = `specialTriggerCandidates[${index}]`;
    exactKeys(candidate, TRIGGER_KEYS, TRIGGER_KEYS, articleId, candidatePath);
    slugValue(candidate.id, articleId, `${candidatePath}.id`);
    if (ids.has(candidate.id)) fail("DUPLICATE_ID", articleId, `${candidatePath}.id`, "trigger candidate IDs must be unique");
    ids.add(candidate.id);
    if (typeof candidate.eligible !== "boolean") fail("INVALID_TYPE", articleId, `${candidatePath}.eligible`, "boolean eligibility flag required");
    enumValue(candidate.triggerType, TRIGGER_TYPES, articleId, `${candidatePath}.triggerType`);
    stringValue(candidate.reason, articleId, `${candidatePath}.reason`, { max: 500 });
    stringArray(candidate.triggerEvidenceIds, articleId, `${candidatePath}.triggerEvidenceIds`, { min: 1, max: 20, itemMax: 120, known: sourceIds });
    candidates.set(candidate.id, candidate);
  }
  return candidates;
}

export function validateGlobalMarketBrief(value, { requireInvestmentStrategy = false, predictionRecords = null, root = undefined } = {}) {
  const documentId = "global-market-brief";
  scanForbiddenKeys(value, documentId);
  exactKeys(value, TOP_KEYS, TOP_KEYS, documentId, "$" );
  if (value.schemaVersion !== GLOBAL_BRIEF_SCHEMA_VERSION) fail("SCHEMA_VERSION", documentId, "schemaVersion", `${GLOBAL_BRIEF_SCHEMA_VERSION} required`);
  validDate(value.editionDate, documentId, "editionDate");
  validTimestamp(value.generatedAt, documentId, "generatedAt");
  validDate(value.dataAsOf, documentId, "dataAsOf");
  if (value.dataAsOf > value.editionDate) fail("DATE_ORDER", documentId, "dataAsOf", "dataAsOf must not be later than editionDate");
  if (value.editionDate > value.generatedAt.slice(0, 10)) fail("DATE_ORDER", documentId, "generatedAt", "editionDate must not be later than the UTC date of generatedAt");
  enumValue(value.buildStatus, new Set(["ready", "partial"]), documentId, "buildStatus");
  const sourceIds = validateSourceIndex(value.sourceIndex, documentId);
  const candidates = validateTriggerCandidates(value.specialTriggerCandidates, documentId, sourceIds);
  if (!isObject(value.mainArticle)) fail("MAIN_ARTICLE_COUNT", "mainArticle", "mainArticle", "exactly one mainArticle object is required");
  validateArticle(value.mainArticle, value.mainArticle.id ?? "mainArticle", sourceIds, { dataAsOf: value.dataAsOf, requireInvestmentStrategy, predictionRecords, root });
  if (value.mainArticle.contentKind !== "global_main") fail("CONTENT_KIND", value.mainArticle.id, "mainArticle.contentKind", "global_main required");
  if (!Array.isArray(value.specialReports) || value.specialReports.length > 2) fail("SPECIAL_REPORT_LIMIT", "global-market-brief", "specialReports", "zero to two special reports are allowed");
  const articleIds = new Set([value.mainArticle.id]);
  const usedTriggerCandidateIds = new Set();
  for (let index = 0; index < value.specialReports.length; index += 1) {
    const report = value.specialReports[index];
    const articleId = report?.id ?? `specialReports[${index}]`;
    validateArticle(report, articleId, sourceIds, { special: true, dataAsOf: value.dataAsOf });
    if (report.contentKind !== "special_report") fail("CONTENT_KIND", articleId, `specialReports[${index}].contentKind`, "special_report required");
    if (articleIds.has(report.id)) fail("DUPLICATE_ID", articleId, `specialReports[${index}].id`, "article IDs must be unique");
    articleIds.add(report.id);
    const candidate = candidates.get(report.triggerCandidateId);
    if (!candidate) fail("TRIGGER_NOT_AUTHORIZED", articleId, `specialReports[${index}].triggerCandidateId`, "special report must select a frozen trigger candidate");
    if (!candidate.eligible) fail("TRIGGER_NOT_ELIGIBLE", articleId, `specialReports[${index}].triggerCandidateId`, "special report trigger candidate is not marked eligible");
    if (candidate.triggerType !== report.triggerType) fail("TRIGGER_TYPE", articleId, `specialReports[${index}].triggerType`, "trigger type must match the authorized candidate");
    if (usedTriggerCandidateIds.has(report.triggerCandidateId)) {
      fail("DUPLICATE_TRIGGER_CANDIDATE", articleId, `specialReports[${index}].triggerCandidateId`, "a trigger candidate can be used by at most one special report per edition");
    }
    usedTriggerCandidateIds.add(report.triggerCandidateId);
    for (let evidenceIndex = 0; evidenceIndex < report.triggerEvidenceIds.length; evidenceIndex += 1) {
      const evidenceId = report.triggerEvidenceIds[evidenceIndex];
      if (!candidate.triggerEvidenceIds.includes(evidenceId)) {
        fail("TRIGGER_EVIDENCE", articleId, `specialReports[${index}].triggerEvidenceIds[${evidenceIndex}]`, "trigger evidence must be authorized by the selected candidate");
      }
    }
  }
  return value;
}

const PUBLIC_TOP_KEYS = ["dataAsOf", "mainArticle", "schemaVersion", "specialReports"];
const PUBLIC_MAIN_KEYS = ["articleUrl", "conclusion", "dataAsOf", "dek", "investmentStrategyPreview", "logicChain", "marketTags", "sourceCount", "title"];
const PUBLIC_SPECIAL_KEYS = ["articleUrl", "conclusion", "marketTags", "title", "triggerType"];
const PUBLIC_LOGIC_KEYS = ["evidenceStatus", "from", "relation", "to"];

function validatePublicForbidden(value, articleId = "public-dto", errorPath = "$") {
  if (Array.isArray(value)) return value.forEach((item, index) => validatePublicForbidden(item, articleId, `${errorPath}[${index}]`));
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (["provider", "providerError", "providerDiagnostics", "rawResearchPayload", "internalLineage", "path", "stack", "gateFailure", "gateFailures", "runtimeLogs", "skill"].includes(key) || key.toLowerCase().includes("providererror") || key.toLowerCase().includes("gatefailure")) {
      fail("PUBLIC_FIELD_FORBIDDEN", articleId, `${errorPath}.${key}`, "provider error, internal path, stack, or gate failure is not public");
    }
    validatePublicForbidden(child, articleId, `${errorPath}.${key}`);
  }
}

export function validateGlobalMarketBriefPublicDto(value) {
  const documentId = "public-dto";
  validatePublicForbidden(value, documentId);
  exactKeys(value, PUBLIC_TOP_KEYS, PUBLIC_TOP_KEYS, documentId, "$" );
  if (value.schemaVersion !== PUBLIC_DTO_SCHEMA_VERSION) fail("SCHEMA_VERSION", documentId, "schemaVersion", `${PUBLIC_DTO_SCHEMA_VERSION} required`);
  validDate(value.dataAsOf, documentId, "dataAsOf");
  const publicMainKeys = Object.hasOwn(value.mainArticle, "investmentStrategyPreview") ? PUBLIC_MAIN_KEYS : PUBLIC_MAIN_KEYS.filter((key) => key !== "investmentStrategyPreview");
  exactKeys(value.mainArticle, publicMainKeys, PUBLIC_MAIN_KEYS, documentId, "mainArticle");
  stringValue(value.mainArticle.title, documentId, "mainArticle.title", { max: 200 });
  stringValue(value.mainArticle.dek, documentId, "mainArticle.dek", { max: 500 });
  stringValue(value.mainArticle.conclusion, documentId, "mainArticle.conclusion", { max: 1200 });
  validDate(value.mainArticle.dataAsOf, documentId, "mainArticle.dataAsOf");
  stringValue(value.mainArticle.articleUrl, documentId, "mainArticle.articleUrl", { max: 200 });
  stringArray(value.mainArticle.marketTags, documentId, "mainArticle.marketTags", { min: 1, max: 4, itemMax: 20 });
  if (!Number.isInteger(value.mainArticle.sourceCount) || value.mainArticle.sourceCount < 1) fail("INVALID_TYPE", documentId, "mainArticle.sourceCount", "positive integer required");
  if (!Array.isArray(value.mainArticle.logicChain) || value.mainArticle.logicChain.length < 1) fail("INVALID_ARRAY", documentId, "mainArticle.logicChain", "at least one logic-chain summary is required");
  value.mainArticle.logicChain.forEach((edge, index) => {
    const edgePath = `mainArticle.logicChain[${index}]`;
    exactKeys(edge, PUBLIC_LOGIC_KEYS, PUBLIC_LOGIC_KEYS, documentId, edgePath);
    for (const key of ["from", "relation", "to"]) stringValue(edge[key], documentId, `${edgePath}.${key}`, { max: 160 });
    enumValue(edge.evidenceStatus, EVIDENCE_STATUSES, documentId, `${edgePath}.evidenceStatus`);
  });
  if (Object.hasOwn(value.mainArticle, "investmentStrategyPreview")) {
    const preview = value.mainArticle.investmentStrategyPreview;
    exactKeys(preview, ["modelStatus", "overallStance", "recommendations", "signalOrigin", "summary"], ["modelStatus", "overallStance", "recommendations", "signalOrigin", "summary"], documentId, "mainArticle.investmentStrategyPreview");
    stringValue(preview.summary, documentId, "mainArticle.investmentStrategyPreview.summary", { max: 900 });
    enumValue(preview.overallStance, new Set(["risk_on", "neutral", "risk_off"]), documentId, "mainArticle.investmentStrategyPreview.overallStance");
    enumValue(preview.signalOrigin, new Set(["model_plus_writer", "writer_only"]), documentId, "mainArticle.investmentStrategyPreview.signalOrigin");
    enumValue(preview.modelStatus, new Set(["published", "abstained", "unavailable"]), documentId, "mainArticle.investmentStrategyPreview.modelStatus");
    if (!Array.isArray(preview.recommendations) || preview.recommendations.length < 1 || preview.recommendations.length > 3) fail("INVALID_ARRAY", documentId, "mainArticle.investmentStrategyPreview.recommendations", "one to three strategy recommendations required");
    preview.recommendations.forEach((item, index) => {
      exactKeys(item, ["action", "conviction", "direction", "label"], ["action", "conviction", "direction", "label"], documentId, `mainArticle.investmentStrategyPreview.recommendations[${index}]`);
      stringValue(item.label, documentId, `mainArticle.investmentStrategyPreview.recommendations[${index}].label`, { max: 120 });
      enumValue(item.action, new Set(["increase", "hold", "reduce"]), documentId, `mainArticle.investmentStrategyPreview.recommendations[${index}].action`);
      enumValue(item.direction, new Set(["bullish", "neutral", "bearish"]), documentId, `mainArticle.investmentStrategyPreview.recommendations[${index}].direction`);
      if (!Number.isInteger(item.conviction) || item.conviction < 1 || item.conviction > 5) fail("INVALID_TYPE", documentId, `mainArticle.investmentStrategyPreview.recommendations[${index}].conviction`, "integer 1–5 required");
    });
  }
  if (!Array.isArray(value.specialReports) || value.specialReports.length > 2) fail("SPECIAL_REPORT_LIMIT", documentId, "specialReports", "zero to two special reports are allowed");
  value.specialReports.forEach((report, index) => {
    const reportPath = `specialReports[${index}]`;
    exactKeys(report, PUBLIC_SPECIAL_KEYS, PUBLIC_SPECIAL_KEYS, documentId, reportPath);
    stringValue(report.title, documentId, `${reportPath}.title`, { max: 200 });
    enumValue(report.triggerType, TRIGGER_TYPES, documentId, `${reportPath}.triggerType`);
    stringValue(report.conclusion, documentId, `${reportPath}.conclusion`, { max: 1200 });
    stringArray(report.marketTags, documentId, `${reportPath}.marketTags`, { min: 1, max: 4, itemMax: 20 });
    stringValue(report.articleUrl, documentId, `${reportPath}.articleUrl`, { max: 200 });
  });
  return value;
}

export function validateGlobalMarketEvent(value, { sourceIds = null } = {}) {
  const documentId = "global-event";
  scanForbiddenKeys(value, documentId);
  exactKeys(value, EVENT_KEYS, EVENT_KEYS, documentId, "$" );
  enumValue(value.eventType, EVENT_TYPES, documentId, "eventType");
  validTimestamp(value.occurredAt, documentId, "occurredAt");
  if (!EVENT_REGIONS.has(value.region)) fail("INVALID_ENUM", documentId, "region", "supported event region required");
  stringArray(value.affectedAssets, documentId, "affectedAssets", { min: 1, max: 30, itemMax: 120 });
  stringArray(value.affectedThemes, documentId, "affectedThemes", { min: 0, max: 30, itemMax: 120 });
  enumValue(value.direction, DIRECTIONS, documentId, "direction");
  enumValue(value.horizon, HORIZONS, documentId, "horizon");
  enumValue(value.sourceConfidence, new Set(["confirmed", "corroborated", "single-source", "conflicting", "unverified"]), documentId, "sourceConfidence");
  enumValue(value.marketConfirmation, EVIDENCE_STATUSES, documentId, "marketConfirmation");
  enumValue(value.status, EVENT_STATUSES, documentId, "status");
  stringArray(value.supportingSourceIds, documentId, "supportingSourceIds", { min: 0, max: 50, itemMax: 120, known: sourceIds });
  stringArray(value.contradictorySourceIds, documentId, "contradictorySourceIds", { min: 0, max: 50, itemMax: 120, known: sourceIds });
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("JSON_INVALID", "input", file, "JSON file is missing or invalid");
  }
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) fail("CLI_ARGUMENT", "cli", "arguments", "unknown positional argument");
    const key = args[index].slice(2);
    if (!key || Object.hasOwn(parsed, key)) fail("CLI_ARGUMENT", "cli", "arguments", "duplicate option");
    parsed[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

function runCli() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (typeof args.file !== "string") fail("CLI_ARGUMENT", "cli", "file", "--file is required");
  const value = readJson(path.resolve(process.cwd(), args.file));
  if (command === "validate") {
    validateGlobalMarketBrief(value);
    console.log(canonicalJson({ valid: true, schemaVersion: value.schemaVersion, mainArticleId: value.mainArticle.id, specialReportCount: value.specialReports.length }));
    return;
  }
  if (command === "validate-public") {
    validateGlobalMarketBriefPublicDto(value);
    console.log(canonicalJson({ valid: true, schemaVersion: value.schemaVersion }));
    return;
  }
  if (command === "validate-event") {
    validateGlobalMarketEvent(value);
    console.log(canonicalJson({ valid: true, schemaVersion: EVENT_SCHEMA_VERSION }));
    return;
  }
  fail("CLI_ARGUMENT", "cli", "command", "usage: validate|validate-public|validate-event --file <path>");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    runCli();
  } catch (cause) {
    if (cause instanceof GlobalMarketBriefContractError) {
      console.error(`${cause.code} articleId=${cause.articleId} path=${cause.path} reason=${cause.reason}`);
    } else {
      console.error(`GLOBAL_MARKET_BRIEF_CONTRACT_FAILURE articleId=unknown path=cli reason=${cause instanceof Error ? cause.message : "unexpected failure"}`);
    }
    process.exitCode = 1;
  }
}
