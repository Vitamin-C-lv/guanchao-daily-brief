import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import {
  ResearchContractError,
  canonicalJson,
  compareImmutableCandidate,
  computeBundleId,
  computeClusterId,
  computeDocumentId,
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
const catalogFile = path.join(repositoryRoot, "config", "research-sources.json");
const contractFile = path.join(repositoryRoot, "data", "research-bundles", "contract.json");
const CATALOG_SCHEMA = "research-source-catalog-v1";
const USER_AGENT = "GuanchaoResearchBot/1.0 (+https://github.com/Vitamin-C-lv/guanchao-daily-brief; contact via repository issues)";
const SOURCE_KEYS = ["adapterId", "adapterVersion", "allowedRedirectHosts", "contentHashBasis", "contentType", "editions", "enabled", "freshnessDays", "marketScopes", "maxItems", "maxResponseBytes", "options", "provider", "publisher", "publisherId", "snapshotPolicy", "sourceClass", "sourceId", "timeoutMs", "topics", "url"];
const CATALOG_KEYS = ["schemaVersion", "sources", "userAgent"];
const SLUG = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const XML_TYPES = ["application/atom+xml", "application/rss+xml", "application/xml", "text/xml"];

export class ResearchPipelineError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "ResearchPipelineError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new ResearchPipelineError(code, errorPath, message);
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertObject(value, errorPath) {
  if (!plainObject(value)) fail("CATALOG_SCHEMA", errorPath, "object required");
}

function assertExactKeys(value, keys, errorPath) {
  assertObject(value, errorPath);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("CATALOG_KEYS", errorPath, "unknown or missing key");
}

function assertSortedUnique(values, errorPath) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) fail("CATALOG_SCHEMA", errorPath, "string array required");
  const expected = sortedUnique(values);
  if (expected.length !== values.length || expected.some((value, index) => value !== values[index])) fail("CATALOG_SCHEMA", errorPath, "sorted unique array required");
}

function readJson(file, code = "INVALID_JSON") {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(code, file, "JSON file is invalid");
  }
}

function loadRegistry() {
  const registry = readJson(contractFile);
  validateResearchContractRegistry(registry);
  return registry;
}

export function loadResearchSourceCatalog(file = catalogFile) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertSourceUrl(source, errorPath) {
  if (typeof source.url !== "string") fail("CATALOG_URL", `${errorPath}.url`, "HTTPS URL required");
  let normalized;
  try {
    normalized = normalizeCanonicalUrl(source.url);
  } catch {
    fail("CATALOG_URL", `${errorPath}.url`, "canonical HTTPS URL required");
  }
  if (normalized !== source.url) fail("CATALOG_URL", `${errorPath}.url`, "URL is not canonical");
  return new URL(normalized);
}

function adapterOptionsValid(source, errorPath) {
  assertObject(source.options, `${errorPath}.options`);
  const keys = Object.keys(source.options).sort();
  if (source.adapterId === "official-feed") {
    if (keys.length) fail("CATALOG_OPTIONS", `${errorPath}.options`, "feed adapter has no options");
    return;
  }
  if (source.adapterId === "federal-register-json") {
    if (keys.length !== 2 || keys[0] !== "order" || keys[1] !== "perPage" || source.options.order !== "newest" || source.options.perPage !== 100) fail("CATALOG_OPTIONS", `${errorPath}.options`, "Federal Register options are fixed");
    return;
  }
  fail("CATALOG_ADAPTER", `${errorPath}.adapterId`, "adapter is not registered");
}

export function validateResearchSourceCatalog(catalog, registry = loadRegistry()) {
  assertExactKeys(catalog, CATALOG_KEYS, "catalog");
  if (catalog.schemaVersion !== CATALOG_SCHEMA) fail("CATALOG_SCHEMA", "catalog.schemaVersion", "schema version mismatch");
  if (catalog.userAgent !== USER_AGENT) fail("CATALOG_USER_AGENT", "catalog.userAgent", "fixed identifiable user agent required");
  if (!Array.isArray(catalog.sources) || !catalog.sources.length) fail("CATALOG_SCHEMA", "catalog.sources", "nonempty sources required");
  const sourceIds = new Set();
  for (let index = 0; index < catalog.sources.length; index += 1) {
    const source = catalog.sources[index];
    const errorPath = `catalog.sources[${index}]`;
    assertExactKeys(source, SOURCE_KEYS, errorPath);
    for (const key of ["sourceId", "provider", "publisherId", "publisher", "sourceClass", "adapterId", "adapterVersion", "contentType", "contentHashBasis", "snapshotPolicy"]) {
      if (typeof source[key] !== "string" || !source[key]) fail("CATALOG_SCHEMA", `${errorPath}.${key}`, "nonempty string required");
    }
    for (const key of ["sourceId", "publisherId", "adapterId"]) if (!SLUG.test(source[key])) fail("CATALOG_SCHEMA", `${errorPath}.${key}`, "stable ASCII slug required");
    if (!/^v[1-9][0-9]*$/.test(source.adapterVersion)) fail("CATALOG_SCHEMA", `${errorPath}.adapterVersion`, "vN required");
    if (typeof source.enabled !== "boolean") fail("CATALOG_SCHEMA", `${errorPath}.enabled`, "boolean required");
    if (sourceIds.has(source.sourceId)) fail("CATALOG_DUPLICATE", `${errorPath}.sourceId`, "duplicate source ID");
    sourceIds.add(source.sourceId);
    const url = assertSourceUrl(source, errorPath);
    if (!registry.enums.sourceClass.includes(source.sourceClass) || !registry.enums.contentType.includes(source.contentType) || !registry.enums.contentHashBasis.includes(source.contentHashBasis)) fail("CATALOG_ENUM", errorPath, "contract enum mismatch");
    if (source.snapshotPolicy !== "stored") fail("CATALOG_POLICY", `${errorPath}.snapshotPolicy`, "initial sources must store raw snapshots");
    if (!((source.adapterId === "official-feed" && source.contentHashBasis === "feed-item" && ["rss", "atom"].includes(source.contentType)) || (source.adapterId === "federal-register-json" && source.contentHashBasis === "structured-record" && source.contentType === "json"))) fail("CATALOG_ADAPTER", errorPath, "adapter/content mismatch");
    assertSortedUnique(source.marketScopes, `${errorPath}.marketScopes`);
    assertSortedUnique(source.topics, `${errorPath}.topics`);
    if (!source.marketScopes.length || !source.topics.length || source.marketScopes.some((scope) => !registry.enums.marketScope.includes(scope)) || source.topics.some((topic) => !registry.enums.topic.includes(topic))) fail("CATALOG_ENUM", errorPath, "scope or topic mismatch");
    assertSortedUnique(source.editions, `${errorPath}.editions`);
    if (!source.editions.length || source.editions.some((edition) => !["daily", "weekly"].includes(edition))) fail("CATALOG_ENUM", `${errorPath}.editions`, "daily or weekly required");
    if (!Number.isInteger(source.maxItems) || source.maxItems < 1 || source.maxItems > 200) fail("CATALOG_LIMIT", `${errorPath}.maxItems`, "1..200 required");
    if (!Number.isInteger(source.maxResponseBytes) || source.maxResponseBytes < 1024 || source.maxResponseBytes > 2097152) fail("CATALOG_LIMIT", `${errorPath}.maxResponseBytes`, "1024..2097152 required");
    if (!Number.isInteger(source.timeoutMs) || source.timeoutMs < 1000 || source.timeoutMs > 20000) fail("CATALOG_LIMIT", `${errorPath}.timeoutMs`, "1000..20000 required");
    if (!Number.isInteger(source.freshnessDays) || source.freshnessDays < 0 || source.freshnessDays > 366) fail("CATALOG_LIMIT", `${errorPath}.freshnessDays`, "0..366 required");
    assertSortedUnique(source.allowedRedirectHosts, `${errorPath}.allowedRedirectHosts`);
    if (!source.allowedRedirectHosts.length || source.allowedRedirectHosts.some((host) => host !== host.toLowerCase() || !/^[a-z0-9.-]+$/.test(host)) || !source.allowedRedirectHosts.includes(url.hostname)) fail("CATALOG_HOST", `${errorPath}.allowedRedirectHosts`, "explicit canonical hosts required");
    adapterOptionsValid(source, errorPath);
  }
  return catalog;
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

export function shanghaiDate(now = new Date()) {
  const parts = shanghaiParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function resolveResearchWindow({ edition, asOf = "auto", now = new Date() }) {
  if (!["daily", "weekly"].includes(edition)) fail("PIPELINE_ARGUMENT", "edition", "daily or weekly required");
  const end = asOf === "auto" ? shanghaiDate(now) : asOf;
  if (!validDate(end)) fail("PIPELINE_ARGUMENT", "asOf", "YYYY-MM-DD or auto required");
  const startDate = new Date(`${end}T00:00:00Z`);
  if (edition === "weekly") startDate.setUTCDate(startDate.getUTCDate() - 6);
  return { start: startDate.toISOString().slice(0, 10), end, timezone: "Asia/Shanghai" };
}

function expectedContentType(source, value) {
  const type = (value ?? "").split(";", 1)[0].trim().toLowerCase();
  if (source.contentType === "json") return type === "application/json" || type.endsWith("+json");
  return XML_TYPES.includes(type) || type.endsWith("+xml");
}

function header(response, name) {
  return response.headers?.get?.(name) ?? response.headers?.[name] ?? "";
}

export function buildFederalRegisterUrl(source, window) {
  const url = new URL(source.url);
  url.searchParams.append("conditions[publication_date][gte]", window.start);
  url.searchParams.append("conditions[publication_date][lte]", window.end);
  url.searchParams.append("order", "newest");
  url.searchParams.append("per_page", "100");
  return url.href;
}

export async function fetchOfficialSource(source, { userAgent = USER_AGENT, fetchImpl = globalThis.fetch, requestUrl: initialUrl = source.url } = {}) {
  if (typeof fetchImpl !== "function") fail("UNAVAILABLE", "fetch", "Node fetch is unavailable");
  let requestUrl = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), source.timeoutMs);
    let response;
    try {
      response = await fetchImpl(requestUrl, { method: "GET", headers: { "User-Agent": userAgent }, redirect: "manual", signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) fail("UNAVAILABLE", "fetch", "timeout");
      fail("UNAVAILABLE", "fetch", cause instanceof Error ? cause.message : "network failure");
    } finally {
      clearTimeout(timer);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3) fail("UNAVAILABLE", "fetch", "redirect limit exceeded");
      const location = header(response, "location");
      if (!location) fail("UNAVAILABLE", "fetch", "redirect location missing");
      const next = new URL(location, requestUrl);
      if (next.protocol !== "https:" || !source.allowedRedirectHosts.includes(next.hostname.toLowerCase())) fail("UNAVAILABLE", "fetch", "redirect host rejected");
      requestUrl = next.href;
      continue;
    }
    if (response.status === 429) fail("RATE_LIMITED", "fetch", "HTTP 429");
    if (!response.ok) fail("UNAVAILABLE", "fetch", `HTTP ${response.status}`);
    if (!expectedContentType(source, header(response, "content-type"))) fail("SCHEMA_CHANGED", "fetch", "content type mismatch");
    const contentLength = Number(header(response, "content-length"));
    if (Number.isFinite(contentLength) && contentLength > source.maxResponseBytes) fail("SCHEMA_CHANGED", "fetch", "response exceeds cap");
    let bytes;
    try {
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (cause) {
      fail("UNAVAILABLE", "fetch", cause instanceof Error ? cause.message : "response read failure");
    }
    if (bytes.length > source.maxResponseBytes) fail("SCHEMA_CHANGED", "fetch", "response exceeds cap");
    return { bytes, finalUrl: requestUrl, contentType: header(response, "content-type") };
  }
  fail("UNAVAILABLE", "fetch", "redirect failure");
}

function values(value) {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function text(value) {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!plainObject(value)) return "";
  return text(value["#text"] ?? value["#cdata"]);
}

function textWithoutMarkup(value) {
  return text(value).slice(0, 10000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function publication(value) {
  const raw = text(value);
  if (!raw) return { publishedDate: null, publishedAt: null, warning: "missing-published-date" };
  if (validDate(raw)) return { publishedDate: raw, publishedAt: null, warning: null };
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf())) return { publishedDate: null, publishedAt: null, warning: "invalid-published-date" };
  const at = parsed.toISOString();
  const explicitDate = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return { publishedDate: explicitDate?.[1] ?? at.slice(0, 10), publishedAt: at, warning: null };
}

function canonicalLink(value) {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    return normalizeCanonicalUrl(candidate);
  } catch {
    return null;
  }
}

function atomLink(entry) {
  for (const link of values(entry.link)) {
    if (plainObject(link) && typeof link["@_href"] === "string" && (!link["@_rel"] || link["@_rel"] === "alternate")) return canonicalLink(link["@_href"]);
    const direct = canonicalLink(link);
    if (direct) return direct;
  }
  return null;
}

function feedItemHash(source, item) {
  return sha256Canonical({ adapterId: source.adapterId, adapterVersion: source.adapterVersion, guidOrId: item.guidOrId, canonicalUrl: item.canonicalUrl, title: item.title, publishedDate: item.publishedDate, publishedAt: item.publishedAt, summaryText: item.summaryText, categories: item.categories });
}

export function parseOfficialFeed(bytes, source) {
  const xml = Buffer.from(bytes).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail("SCHEMA_CHANGED", "feed", "DOCTYPE or ENTITY is forbidden");
  let parsed;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", processEntities: false, trimValues: true }).parse(xml);
  } catch {
    fail("SCHEMA_CHANGED", "feed", "XML parse failure");
  }
  const isRss = plainObject(parsed.rss) && parsed.rss.channel;
  const isAtom = plainObject(parsed.feed);
  if (!isRss && !isAtom) fail("SCHEMA_CHANGED", "feed", "RSS or Atom root required");
  const entries = isRss ? values(parsed.rss.channel.item) : values(parsed.feed.entry);
  const items = [];
  const warnings = [];
  for (const entry of entries) {
    const title = text(entry.title);
    const link = isRss ? canonicalLink(entry.link) : atomLink(entry);
    if (!title || !link) {
      warnings.push(!title ? "skip-missing-title" : "skip-missing-link");
      continue;
    }
    const date = publication(isRss ? (entry.pubDate ?? entry.isoDate ?? entry.date) : (entry.published ?? entry.updated));
    if (date.warning) warnings.push(date.warning);
    const categories = sortedUnique(values(entry.category).map((category) => text(plainObject(category) ? category["@_term"] ?? category : category)).filter(Boolean));
    const item = { title, canonicalUrl: link, guidOrId: text(isRss ? entry.guid : entry.id) || link, ...date, summaryText: textWithoutMarkup(isRss ? entry.description ?? entry.summary : entry.summary ?? entry.content), categories };
    items.push({ ...item, contentSha256: feedItemHash(source, item) });
  }
  return { items, warnings: sortedUnique(warnings), format: isRss ? "rss" : "atom" };
}

function recordHash(source, record) {
  return sha256Canonical({ adapterId: source.adapterId, adapterVersion: source.adapterVersion, documentNumber: record.documentNumber, title: record.title, publicationDate: record.publicationDate, canonicalUrl: record.canonicalUrl, type: record.type, agencies: record.agencies, abstract: record.abstract, action: record.action, dates: record.dates });
}

export function parseFederalRegisterDocuments(bytes, source) {
  let data;
  try {
    data = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("SCHEMA_CHANGED", "federal-register", "JSON parse failure");
  }
  if (!plainObject(data) || !Number.isInteger(data.count) || !Array.isArray(data.results)) fail("SCHEMA_CHANGED", "federal-register", "count and results required");
  const items = [];
  const warnings = [];
  for (const result of data.results) {
    if (!plainObject(result) || typeof result.document_number !== "string" || !result.document_number || typeof result.title !== "string" || !result.title || typeof result.html_url !== "string" || !result.html_url || typeof result.type !== "string" || !result.type || !validDate(result.publication_date)) {
      warnings.push("skip-invalid-federal-register-record");
      continue;
    }
    const canonicalUrl = canonicalLink(result.html_url);
    if (!canonicalUrl) {
      warnings.push("skip-invalid-federal-register-url");
      continue;
    }
    const agencies = sortedUnique(values(result.agencies).map((agency) => plainObject(agency) ? { slug: text(agency.slug), name: text(agency.name) } : null).filter((agency) => agency && (agency.slug || agency.name)).map((agency) => canonicalJson(agency))).map((agency) => JSON.parse(agency));
    const record = { documentNumber: result.document_number, title: result.title.trim(), publicationDate: result.publication_date, canonicalUrl, type: result.type.trim(), agencies, abstract: textWithoutMarkup(result.abstract), action: textWithoutMarkup(result.action), dates: textWithoutMarkup(result.dates) };
    items.push({ ...record, publishedDate: record.publicationDate, publishedAt: null, contentSha256: recordHash(source, record) });
  }
  return { items, warnings: sortedUnique(warnings) };
}

function seal(value, idKey, compute) {
  const next = structuredClone(value);
  next[idKey] = compute(next);
  next.integrity = { businessSha256: next[idKey], sha256: "" };
  next.integrity.sha256 = sha256Canonical({ ...next, integrity: { businessSha256: next.integrity.businessSha256 } });
  return next;
}

function asOfTimestamp(asOf) {
  return new Date(`${asOf}T23:59:59.999+08:00`).toISOString();
}

function daysOld(asOf, publishedDate) {
  return Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${publishedDate}T00:00:00Z`)) / 86400000);
}

function unavailableRun(source, asOf, requestedAt, code) {
  return seal({ sourceRunId: "", sourceId: source.sourceId, provider: source.provider, sourceClass: source.sourceClass, adapterId: source.adapterId, adapterVersion: source.adapterVersion, requestedAt, asOf: asOfTimestamp(asOf), status: code === "RATE_LIMITED" ? "rate_limited" : code === "SCHEMA_CHANGED" ? "schema_changed" : "unavailable", sourceUrl: source.url, marketScopes: source.marketScopes, topics: source.topics, coverage: { itemCount: 0, note: code.toLowerCase() }, snapshotPolicy: "none", rawSnapshotId: null, warnings: [code.toLowerCase()], integrity: { businessSha256: "", sha256: "" } }, "sourceRunId", computeSourceRunId);
}

export async function collectResearchSource(source, { asOf, window, userAgent = USER_AGENT, fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  const requestedAt = now.toISOString();
  try {
    const response = await fetchOfficialSource(source, { userAgent, fetchImpl, requestUrl: source.adapterId === "federal-register-json" ? buildFederalRegisterUrl(source, window) : source.url });
    const parsed = source.adapterId === "official-feed" ? parseOfficialFeed(response.bytes, source) : parseFederalRegisterDocuments(response.bytes, source);
    const limited = parsed.items.slice(0, source.maxItems);
    const warnings = sortedUnique([...parsed.warnings, ...(parsed.items.length > limited.length ? ["max-items-truncated"] : [])]);
    const recent = limited.map((item) => item.publishedDate).filter(Boolean).sort().at(-1) ?? null;
    const status = warnings.some((warning) => warning.startsWith("skip-") || warning === "max-items-truncated") ? "partial" : recent && daysOld(asOf, recent) > source.freshnessDays ? "stale" : "ready";
    const rawSnapshotId = sha256Bytes(response.bytes);
    const sourceRun = seal({ sourceRunId: "", sourceId: source.sourceId, provider: source.provider, sourceClass: source.sourceClass, adapterId: source.adapterId, adapterVersion: source.adapterVersion, requestedAt, asOf: asOfTimestamp(asOf), status, sourceUrl: source.url, marketScopes: source.marketScopes, topics: source.topics, coverage: { itemCount: limited.length, note: status === "stale" ? "latest document exceeds freshness limit" : "official structured response" }, snapshotPolicy: source.snapshotPolicy, rawSnapshotId, warnings, integrity: { businessSha256: "", sha256: "" } }, "sourceRunId", computeSourceRunId);
    const documents = limited.map((item) => seal({ documentId: "", sourceRunId: sourceRun.sourceRunId, sourceId: source.sourceId, publisherId: source.publisherId, publisher: source.publisher, title: item.title, canonicalUrl: item.canonicalUrl, publishedDate: item.publishedDate, publishedAt: item.publishedAt, accessedAt: requestedAt, language: "en", contentType: source.contentType, contentHashBasis: source.contentHashBasis, contentHashVersion: "v1", contentSha256: item.contentSha256, rawSnapshotId, marketScopes: source.marketScopes, topics: source.topics, warnings: [], integrity: { businessSha256: "", sha256: "" } }, "documentId", computeDocumentId));
    const registry = loadRegistry();
    validateSourceRun(sourceRun, registry);
    for (const document of documents) validateDocument(document, [sourceRun], registry);
    return { source, sourceRun, documents, raw: { rawSnapshotId, bytes: response.bytes, asOf }, warnings, window };
  } catch (cause) {
    if (cause instanceof ResearchPipelineError) return { source, sourceRun: unavailableRun(source, asOf, requestedAt, cause.code), documents: [], raw: null, warnings: [cause.code.toLowerCase()], window };
    throw cause;
  }
}

function documentWindowDate(document) {
  if (document.publishedDate !== null) return document.publishedDate;
  if (document.publishedAt !== null) return shanghaiDate(new Date(document.publishedAt));
  return null;
}

function canonicalClusterDocument(documents) {
  return [...documents].sort((left, right) => {
    if (left.publishedAt !== null && right.publishedAt !== null && left.publishedAt !== right.publishedAt) return left.publishedAt.localeCompare(right.publishedAt);
    if (left.publishedAt !== null) return -1;
    if (right.publishedAt !== null) return 1;
    return left.documentId.localeCompare(right.documentId);
  })[0];
}

export function buildDuplicateClusters(documents) {
  const clusters = [];
  const occupied = new Set();
  const byUrl = new Map();
  for (const document of documents) byUrl.set(document.canonicalUrl, [...(byUrl.get(document.canonicalUrl) ?? []), document]);
  for (const members of byUrl.values()) {
    if (members.length < 2) continue;
    const canonical = canonicalClusterDocument(members);
    const cluster = { clusterId: "", method: "exact-url", canonicalDocumentId: canonical.documentId, memberDocumentIds: members.map((document) => document.documentId).sort() };
    cluster.clusterId = computeClusterId(cluster);
    clusters.push(cluster);
    for (const member of members) occupied.add(member.documentId);
  }
  const byHash = new Map();
  for (const document of documents.filter((item) => !occupied.has(item.documentId))) {
    const key = `${document.contentHashBasis}\u0000${document.contentHashVersion}\u0000${document.contentSha256}`;
    byHash.set(key, [...(byHash.get(key) ?? []), document]);
  }
  for (const members of byHash.values()) {
    if (members.length < 2) continue;
    const canonical = canonicalClusterDocument(members);
    const cluster = { clusterId: "", method: "content-hash", canonicalDocumentId: canonical.documentId, memberDocumentIds: members.map((document) => document.documentId).sort() };
    cluster.clusterId = computeClusterId(cluster);
    clusters.push(cluster);
  }
  return clusters.sort((left, right) => left.clusterId.localeCompare(right.clusterId));
}

function coverageStatus(runs) {
  if (!runs.length) return { status: "unavailable", reasons: ["no-enabled-source"] };
  if (runs.every((run) => run.status === "ready")) return { status: "ready", reasons: [] };
  if (runs.some((run) => run.status === "ready")) return { status: "partial", reasons: ["source-failure"] };
  if (runs.some((run) => ["partial", "stale"].includes(run.status))) return { status: "partial", reasons: ["source-partial-or-stale"] };
  return { status: "unavailable", reasons: ["source-failure"] };
}

export function buildResearchCoverage({ sources, sourceRuns, documents, observations = [], events = [], duplicateClusters = [], registry = loadRegistry() }) {
  const scopes = ["A_SHARE", "HK", "US", "FED"];
  const configuredTopics = sortedUnique(sources.flatMap((source) => source.topics)).sort((left, right) => registry.enums.topic.indexOf(left) - registry.enums.topic.indexOf(right));
  const markets = scopes.map((market) => {
    const state = coverageStatus(sourceRuns.filter((run) => run.marketScopes.includes(market)));
    return { market, ...state, documentCount: documents.filter((document) => document.marketScopes.includes(market)).length, observationCount: observations.filter((observation) => observation.marketScopes.includes(market)).length };
  });
  const topics = configuredTopics.map((topic) => {
    const state = coverageStatus(sourceRuns.filter((run) => run.topics.includes(topic)));
    return { topic, ...state, documentCount: documents.filter((document) => document.topics.includes(topic)).length, observationCount: observations.filter((observation) => observation.topics.includes(topic)).length };
  });
  return { markets, topics, totals: { sourceRuns: sourceRuns.length, documents: documents.length, observations: observations.length, events: events.length, duplicateClusters: duplicateClusters.length, conflictingObservations: 0 } };
}

export function buildResearchBundle({ edition, asOf, window = resolveResearchWindow({ edition, asOf }), sourceRuns, documents, sources, generatedAt = new Date().toISOString(), registry = loadRegistry() }) {
  const selected = documents.filter((document) => {
    const published = documentWindowDate(document);
    return published !== null && published >= window.start && published <= window.end;
  }).sort((left, right) => left.documentId.localeCompare(right.documentId));
  const sourceRunList = [...sourceRuns].sort((left, right) => left.sourceRunId.localeCompare(right.sourceRunId));
  const duplicateClusters = buildDuplicateClusters(selected);
  const coverage = buildResearchCoverage({ sources, sourceRuns: sourceRunList, documents: selected, duplicateClusters, registry });
  const bundle = { schemaVersion: registry.bundleSchemaVersion, edition, asOf, generatedAt, window, sourcePolicyVersion: registry.sourcePolicyVersion, sourceRuns: sourceRunList, documents: selected, observations: [], events: [], duplicateClusters, coverage, warnings: [], bundleId: "", integrity: { businessSha256: "", sha256: "" } };
  const sealed = seal(bundle, "bundleId", computeBundleId);
  validateBundle(sealed, registry);
  return sealed;
}

function artifactPath(kind, value, root) {
  const month = kind === "document" && value.publishedDate ? value.publishedDate.slice(0, 7).replace("-", "/") : value.asOf?.slice(0, 7).replace("-", "/");
  const id = kind === "sourceRun" ? value.sourceRunId : kind === "document" ? value.documentId : value.bundleId;
  const base = kind === "sourceRun" ? "source-runs" : kind === "document" ? "documents" : "bundles";
  return path.join(root, "data", "research-bundles", base, month, `${id}.json.gz`);
}

function rawArtifactPath(raw, root) {
  return path.join(root, "data", "research-bundles", "raw", raw.asOf.slice(0, 7).replace("-", "/"), `${raw.rawSnapshotId}.bin.gz`);
}

function gzipCanonical(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function gzipRaw(value) {
  return gzipSync(value, { mtime: 0 });
}

function readGzipJson(file) {
  try {
    return JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
  } catch {
    fail("ARTIFACT_CORRUPT", file, "gzip JSON artifact is invalid");
  }
}

function readTreeFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? readTreeFiles(target) : [target];
  });
}

function planImmutableJson(kind, value, root, sourceRuns) {
  const file = artifactPath(kind, value, root);
  const bytes = gzipCanonical(value);
  if (!fs.existsSync(file)) return { file, bytes, created: true, kind };
  const existing = readGzipJson(file);
  try {
    if (kind === "sourceRun") validateSourceRun(existing, loadRegistry());
    if (kind === "document") validateDocument(existing, sourceRuns, loadRegistry());
    if (kind === "bundle") validateBundle(existing, loadRegistry());
  } catch (cause) {
    if (cause instanceof ResearchContractError) fail("ARTIFACT_CORRUPT", file, cause.message);
    throw cause;
  }
  const existingBytes = fs.readFileSync(file);
  if (sha256Bytes(existingBytes) !== sha256Bytes(bytes)) {
    try {
      compareImmutableCandidate(kind, existing, value, loadRegistry(), kind === "document" ? { sourceRuns } : {});
    } catch (cause) {
      if (cause instanceof ResearchContractError) fail("IMMUTABLE_CONFLICT", file, cause.message);
      throw cause;
    }
  }
  return { file, bytes: existingBytes, created: false, kind };
}

function planRaw(raw, root) {
  const file = rawArtifactPath(raw, root);
  const bytes = gzipRaw(raw.bytes);
  if (!fs.existsSync(file)) return { file, bytes, created: true, kind: "raw" };
  let existing;
  try {
    existing = gunzipSync(fs.readFileSync(file));
  } catch {
    fail("ARTIFACT_CORRUPT", file, "raw artifact gzip is invalid");
  }
  if (sha256Bytes(existing) !== raw.rawSnapshotId) fail("ARTIFACT_CORRUPT", file, "raw artifact hash mismatch");
  if (Buffer.compare(existing, raw.bytes) !== 0) fail("IMMUTABLE_CONFLICT", file, "raw artifact differs");
  return { file, bytes, created: false, kind: "raw" };
}

function applyWrite(plan, transaction) {
  if (!transaction.before.has(plan.file)) transaction.before.set(plan.file, fs.existsSync(plan.file) ? fs.readFileSync(plan.file) : null);
  fs.mkdirSync(path.dirname(plan.file), { recursive: true });
  fs.writeFileSync(plan.file, plan.bytes);
}

function rollback(transaction) {
  for (const [file, before] of [...transaction.before.entries()].reverse()) {
    if (before === null) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, before);
    }
  }
}

function scanResearchArtifacts(root) {
  const registry = loadRegistry();
  const artifactRoot = path.join(root, "data", "research-bundles");
  const kinds = ["source-runs", "documents", "bundles"];
  const found = { sourceRuns: [], documents: [], bundles: [] };
  for (const kind of kinds) {
    for (const file of readTreeFiles(path.join(artifactRoot, kind)).filter((item) => item.endsWith(".json.gz"))) {
      const value = readGzipJson(file);
      const entry = { file, value, bytes: fs.readFileSync(file), artifactPath: path.relative(root, file).split(path.sep).join("/") };
      if (kind === "source-runs") found.sourceRuns.push(entry);
      if (kind === "documents") found.documents.push(entry);
      if (kind === "bundles") found.bundles.push(entry);
    }
  }
  const sourceRuns = new Map();
  for (const entry of found.sourceRuns) sourceRuns.set(validateSourceRun(entry.value, registry).sourceRunId, entry.value);
  for (const entry of found.documents) validateDocument(entry.value, sourceRuns, registry);
  for (const entry of found.bundles) validateBundle(entry.value, registry);
  return found;
}

function derivedPlans(root, transaction) {
  const found = scanResearchArtifacts(root);
  const index = { schemaVersion: "research-bundle-index-v1", sourceRuns: found.sourceRuns.map((entry) => ({ id: entry.value.sourceRunId, schemaVersion: "research-source-run-v1", asOf: entry.value.asOf, artifactPath: entry.artifactPath, artifactSha256: sha256Bytes(entry.bytes) })).sort((left, right) => left.id.localeCompare(right.id)), documents: found.documents.map((entry) => ({ id: entry.value.documentId, schemaVersion: "research-document-v1", publishedDate: entry.value.publishedDate, artifactPath: entry.artifactPath, artifactSha256: sha256Bytes(entry.bytes) })).sort((left, right) => left.id.localeCompare(right.id)), bundles: found.bundles.map((entry) => ({ id: entry.value.bundleId, schemaVersion: "research-bundle-v1", asOf: entry.value.asOf, artifactPath: entry.artifactPath, artifactSha256: sha256Bytes(entry.bytes) })).sort((left, right) => left.id.localeCompare(right.id)) };
  const plans = [{ file: path.join(root, "data", "research-bundles", "index.json"), bytes: Buffer.from(canonicalJson(index), "utf8"), created: !fs.existsSync(path.join(root, "data", "research-bundles", "index.json")), kind: "index" }];
  for (const edition of ["daily", "weekly"]) {
    const latest = found.bundles.filter((entry) => entry.value.edition === edition).sort((left, right) => left.value.asOf.localeCompare(right.value.asOf) || left.value.bundleId.localeCompare(right.value.bundleId)).at(-1);
    if (latest) plans.push({ file: path.join(root, "content", "research-bundles", `${edition}-latest.json`), bytes: Buffer.from(canonicalJson(latest.value), "utf8"), created: !fs.existsSync(path.join(root, "content", "research-bundles", `${edition}-latest.json`)), kind: `${edition}-latest` });
  }
  return plans;
}

function injectedFailure(failAt, stage, count) {
  return failAt === stage || failAt === count;
}

export function rebuildResearchDerivedViews({ root = repositoryRoot, transaction = null, failAt = null } = {}) {
  const own = transaction ?? { before: new Map() };
  try {
    const plans = derivedPlans(root, own);
    for (let index = 0; index < plans.length; index += 1) {
      applyWrite(plans[index], own);
      if (injectedFailure(failAt, plans[index].kind === "index" ? "index" : "latest", index + 1)) fail("STORAGE_WRITE", plans[index].file, "injected derived write failure");
    }
    return { indexPath: path.join(root, "data", "research-bundles", "index.json"), written: plans.map((plan) => plan.file) };
  } catch (cause) {
    if (!transaction) rollback(own);
    throw cause;
  }
}

export function writeImmutableResearchArtifacts({ sourceResults, bundle, root = repositoryRoot, dryRun = false, failAt = null } = {}) {
  const sourceRuns = sourceResults.map((result) => result.sourceRun);
  const documents = sourceResults.flatMap((result) => result.documents);
  const plans = [
    ...sourceResults.filter((result) => result.raw).map((result) => planRaw(result.raw, root)),
    ...sourceRuns.map((value) => planImmutableJson("sourceRun", value, root, sourceRuns)),
    ...documents.map((value) => planImmutableJson("document", value, root, sourceRuns)),
    planImmutableJson("bundle", bundle, root, sourceRuns)
  ];
  const summary = { created: plans.filter((plan) => plan.created).map((plan) => path.relative(root, plan.file).split(path.sep).join("/")), reused: plans.filter((plan) => !plan.created).map((plan) => path.relative(root, plan.file).split(path.sep).join("/")), wouldWrite: plans.map((plan) => path.relative(root, plan.file).split(path.sep).join("/")) };
  if (dryRun) {
    const derived = [path.join(root, "data", "research-bundles", "index.json"), path.join(root, "content", "research-bundles", `${bundle.edition}-latest.json`)];
    summary.wouldWrite.push(...derived.map((file) => path.relative(root, file).split(path.sep).join("/")));
    summary.created.push(...derived.filter((file) => !fs.existsSync(file)).map((file) => path.relative(root, file).split(path.sep).join("/")));
    return summary;
  }
  const transaction = { before: new Map() };
  try {
    let stage = 0;
    for (const plan of plans) {
      applyWrite(plan, transaction);
      stage += 1;
      const stageName = plan.kind === "sourceRun" ? "source-run" : plan.kind === "document" ? "document" : plan.kind;
      if (injectedFailure(failAt, stageName, stage)) fail("STORAGE_WRITE", plan.file, "injected write failure");
    }
    const derived = rebuildResearchDerivedViews({ root, transaction, failAt });
    summary.created.push(...derived.written.filter((file) => !transaction.before.get(file)).map((file) => path.relative(root, file).split(path.sep).join("/")));
    summary.wouldWrite.push(...derived.written.map((file) => path.relative(root, file).split(path.sep).join("/")));
    return summary;
  } catch (cause) {
    rollback(transaction);
    throw cause;
  }
}

function ensureOutsideRepository(output, root) {
  if (!path.isAbsolute(output)) fail("PIPELINE_ARGUMENT", "output", "absolute path required");
  const relative = path.relative(root, output);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) fail("PIPELINE_ARGUMENT", "output", "output must be outside repository root");
}

export async function runResearchPipeline({ edition, asOf = "auto", dryRun = false, output = null, root = repositoryRoot, fetchImpl = globalThis.fetch, now = new Date(), catalog = null } = {}) {
  const registry = loadRegistry();
  const loadedCatalog = validateResearchSourceCatalog(catalog ?? loadResearchSourceCatalog(), registry);
  const window = resolveResearchWindow({ edition, asOf, now });
  const active = loadedCatalog.sources.filter((source) => source.enabled && source.editions.includes(edition));
  const sourceResults = [];
  for (const source of active) sourceResults.push(await collectResearchSource(source, { asOf: window.end, window, userAgent: loadedCatalog.userAgent, fetchImpl, now }));
  const allDocuments = sourceResults.flatMap((result) => result.documents);
  const bundle = buildResearchBundle({ edition, asOf: window.end, window, sourceRuns: sourceResults.map((result) => result.sourceRun), documents: allDocuments, sources: active, generatedAt: now.toISOString(), registry });
  const storage = writeImmutableResearchArtifacts({ sourceResults, bundle, root, dryRun });
  const summary = { edition, asOf: window.end, window, sourceStatuses: Object.fromEntries(sourceResults.map((result) => [result.source.sourceId, result.sourceRun.status])), rawSnapshotCount: sourceResults.filter((result) => result.raw).length, sourceRunCount: sourceResults.length, documentArtifactCount: allDocuments.length, bundleDocumentCount: bundle.documents.length, bundleId: bundle.bundleId, coverage: bundle.coverage, created: storage.created, reused: storage.reused, wouldWrite: storage.wouldWrite, dryRun };
  if (output !== null) {
    ensureOutsideRepository(output, root);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${canonicalJson(summary)}\n`, "utf8");
  }
  return summary;
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (!args[index].startsWith("--")) fail("PIPELINE_ARGUMENT", "arguments", "unknown positional argument");
    const name = args[index].slice(2);
    parsed[name] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

async function runCli() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "validate-catalog") {
    validateResearchSourceCatalog(loadResearchSourceCatalog());
    console.log(JSON.stringify({ valid: true, schemaVersion: CATALOG_SCHEMA }));
    return;
  }
  if (command === "rebuild") {
    if (Object.keys(args).length) fail("PIPELINE_ARGUMENT", "rebuild", "rebuild accepts no options");
    console.log(JSON.stringify(rebuildResearchDerivedViews()));
    return;
  }
  if (command === "run") {
    if (typeof args.edition !== "string" || (args["dry-run"] !== undefined && args["dry-run"] !== true) || (args.output !== undefined && typeof args.output !== "string")) fail("PIPELINE_ARGUMENT", "run", "usage: run --edition daily|weekly --as-of YYYY-MM-DD|auto [--dry-run] [--output absolute-path]");
    console.log(JSON.stringify(await runResearchPipeline({ edition: args.edition, asOf: args["as-of"] ?? "auto", dryRun: args["dry-run"] === true, output: args.output ?? null })));
    return;
  }
  fail("PIPELINE_ARGUMENT", "command", "usage: validate-catalog | run | rebuild");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  runCli().catch((cause) => {
    if (cause instanceof ResearchPipelineError || cause instanceof ResearchContractError) console.error(`${cause.code} ${cause.path} ${cause.message}`);
    else console.error(`UNAVAILABLE pipeline ${cause instanceof Error ? cause.message : "unexpected failure"}`);
    process.exitCode = 1;
  });
}
