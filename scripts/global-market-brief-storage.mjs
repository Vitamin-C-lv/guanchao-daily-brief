import fs from "node:fs";
import path from "node:path";

import { canonicalJson, sha256Canonical } from "./research-contract.mjs";
import {
  PUBLIC_DTO_SCHEMA_VERSION,
  validateGlobalMarketBrief,
  validateGlobalMarketBriefPublicDto,
} from "./global-market-brief-contract.mjs";
import { projectInvestmentStrategyPreview } from "./investment-strategy-contract.mjs";

export const GLOBAL_HISTORY_DIRECTORY = "content/global-market-briefs";
export const GLOBAL_PUBLIC_DTO_PATH = "content/global-market-brief-public.json";
export const GLOBAL_INDEX_PATH = "content/global-market-brief-index.json";
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(code, field, message) {
  const error = new Error(message);
  error.code = code;
  error.path = field;
  throw error;
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function resolveRoot(rootDir, relativePath) {
  const root = path.resolve(rootDir);
  const file = path.resolve(root, ...relativePath.split("/"));
  const relation = path.relative(root, file);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) fail("GLOBAL_STORAGE_PATH", relativePath, "storage path escapes repository");
  return file;
}

function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJson(file, field) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("GLOBAL_STORAGE_CORRUPT", field, "existing global brief JSON is missing or invalid");
  }
}

function businessView(value) {
  const { generatedAt, ...business } = value;
  return business;
}

function equalBusiness(left, right) {
  return canonicalJson(businessView(left)) === canonicalJson(businessView(right));
}

function businessSha256(value) {
  return sha256Canonical(businessView(value));
}

function publicDto(brief) {
  const dto = {
    schemaVersion: PUBLIC_DTO_SCHEMA_VERSION,
    dataAsOf: brief.dataAsOf,
    mainArticle: {
      title: brief.mainArticle.title,
      dek: brief.mainArticle.dek,
      conclusion: brief.mainArticle.conclusion,
      logicChain: brief.mainArticle.logicChain.map((edge) => ({
        from: edge.from,
        relation: edge.relation,
        to: edge.to,
        evidenceStatus: edge.evidenceStatus,
      })),
      marketTags: brief.mainArticle.marketTags,
      dataAsOf: brief.dataAsOf,
      sourceCount: brief.mainArticle.sourceIds.length,
      articleUrl: brief.mainArticle.articleUrl,
      ...(brief.mainArticle.investmentStrategy ? { investmentStrategyPreview: projectInvestmentStrategyPreview(brief.mainArticle.investmentStrategy) } : {}),
    },
    specialReports: brief.specialReports.map((report) => ({
      title: report.title,
      triggerType: report.triggerType,
      conclusion: report.conclusion,
      marketTags: report.marketTags,
      articleUrl: report.articleUrl,
    })),
  };
  try {
    validateGlobalMarketBriefPublicDto(dto);
  } catch (cause) {
    fail("GLOBAL_PUBLIC_DTO_INVALID", GLOBAL_PUBLIC_DTO_PATH, cause instanceof Error ? cause.message : "public DTO failed validation");
  }
  return dto;
}

function indexArticle(article, editionDate, dataAsOf) {
  return {
    id: article.id,
    kind: article.contentKind,
    editionDate,
    dataAsOf,
    title: article.title,
    dek: article.dek,
    conclusion: article.conclusion,
    marketTags: article.marketTags,
    articleUrl: article.articleUrl,
    sourceCount: article.sourceIds.length,
    ...(article.investmentStrategy ? { investmentStrategyPreview: projectInvestmentStrategyPreview(article.investmentStrategy) } : {}),
  };
}

export function buildGlobalMarketBriefIndex(history) {
  if (!Array.isArray(history) || history.length < 1) fail("GLOBAL_INDEX_EMPTY", GLOBAL_INDEX_PATH, "canonical history is required to derive an index");
  const ordered = [...history].sort((left, right) => right.editionDate.localeCompare(left.editionDate));
  const articles = ordered.flatMap((brief) => [
    indexArticle(brief.mainArticle, brief.editionDate, brief.dataAsOf),
    ...brief.specialReports.map((report) => indexArticle(report, brief.editionDate, brief.dataAsOf)),
  ]).sort((left, right) => right.editionDate.localeCompare(left.editionDate) || (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "global_main" ? -1 : 1));
  return {
    schemaVersion: "global-market-brief-index-v1",
    latestEditionDate: ordered[0].editionDate,
    latestMainArticleId: ordered[0].mainArticle.id,
    articles,
  };
}

export function validateGlobalMarketBriefIndex(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("GLOBAL_INDEX_INVALID", GLOBAL_INDEX_PATH, "index object required");
  const keys = Object.keys(value).sort();
  const expected = ["articles", "latestEditionDate", "latestMainArticleId", "schemaVersion"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail("GLOBAL_INDEX_INVALID", GLOBAL_INDEX_PATH, "index keys are invalid");
  if (value.schemaVersion !== "global-market-brief-index-v1") fail("GLOBAL_INDEX_INVALID", GLOBAL_INDEX_PATH, "global-market-brief-index-v1 required");
  if (typeof value.latestEditionDate !== "string" || !DATE.test(value.latestEditionDate) || typeof value.latestMainArticleId !== "string" || !value.latestMainArticleId) fail("GLOBAL_INDEX_INVALID", GLOBAL_INDEX_PATH, "latest metadata is invalid");
  if (!Array.isArray(value.articles) || value.articles.length < 1) fail("GLOBAL_INDEX_INVALID", GLOBAL_INDEX_PATH, "at least one indexed article required");
  const ids = new Set();
  let priorDate = null;
  for (const [position, article] of value.articles.entries()) {
    const field = `${GLOBAL_INDEX_PATH}.articles[${position}]`;
    if (!article || typeof article !== "object" || Array.isArray(article)) fail("GLOBAL_INDEX_INVALID", field, "article object required");
    const articleKeys = Object.keys(article).sort();
    const expectedArticle = ["articleUrl", "conclusion", "dataAsOf", "dek", "editionDate", "id", "investmentStrategyPreview", "kind", "marketTags", "sourceCount", "title"];
    const legacyArticle = expectedArticle.filter((key) => key !== "investmentStrategyPreview");
    const required = Object.hasOwn(article, "investmentStrategyPreview") ? expectedArticle : legacyArticle;
    if (articleKeys.length !== required.length || articleKeys.some((key, index) => key !== required[index])) fail("GLOBAL_INDEX_INVALID", field, "article metadata keys are invalid");
    if (typeof article.id !== "string" || !article.id || ids.has(article.id)) fail("GLOBAL_INDEX_INVALID", `${field}.id`, "article id must be unique");
    ids.add(article.id);
    if (!new Set(["global_main", "special_report"]).has(article.kind) || typeof article.editionDate !== "string" || !DATE.test(article.editionDate)) fail("GLOBAL_INDEX_INVALID", field, "article kind or edition date is invalid");
    if (priorDate !== null && article.editionDate > priorDate) fail("GLOBAL_INDEX_INVALID", field, "articles must be in descending edition order");
    priorDate = article.editionDate;
    for (const key of ["title", "dek", "conclusion", "articleUrl"]) if (typeof article[key] !== "string" || !article[key].trim()) fail("GLOBAL_INDEX_INVALID", `${field}.${key}`, "reader metadata string required");
    if (!Array.isArray(article.marketTags) || article.marketTags.length < 1 || !Number.isInteger(article.sourceCount) || article.sourceCount < 1) fail("GLOBAL_INDEX_INVALID", field, "market tags and source count are invalid");
  }
  const latest = value.articles.find((article) => article.kind === "global_main" && article.editionDate === value.latestEditionDate);
  if (!latest || latest.id !== value.latestMainArticleId) fail("GLOBAL_INDEX_INVALID", GLOBAL_INDEX_PATH, "latest main article does not match index metadata");
  return value;
}

function historyRelativePath(editionDate) {
  if (typeof editionDate !== "string" || !DATE.test(editionDate)) fail("GLOBAL_HISTORY_DATE", "editionDate", "canonical YYYY-MM-DD required");
  return `${GLOBAL_HISTORY_DIRECTORY}/${editionDate}.json`;
}

function planEntry(rootDir, relativePath, bytes, kind) {
  const file = resolveRoot(rootDir, relativePath);
  if (!fs.existsSync(file)) return { file, relativePath, bytes, kind, shouldWrite: true, status: "new" };
  const existing = fs.readFileSync(file);
  if (Buffer.compare(existing, bytes) === 0) return { file, relativePath, bytes: existing, kind, shouldWrite: false, status: "exact-no-op" };
  return { file, relativePath, bytes, kind, shouldWrite: true, status: "update" };
}

function validateExistingHistory(file, candidate, { replaceExisting = false, expectedExistingBusinessSha256 = null } = {}) {
  const existing = readJson(file, file);
  let existingValidated = true;
  try {
    validateGlobalMarketBrief(existing);
  } catch (cause) {
    if (!replaceExisting || existing.schemaVersion !== "global-market-brief-v1") {
      fail("GLOBAL_HISTORY_CORRUPT", file, cause instanceof Error ? cause.message : "existing history failed validation");
    }
    existingValidated = false;
  }
  const existingBusinessSha256 = businessSha256(existing);
  if (!equalBusiness(existing, candidate)) {
    if (!replaceExisting) fail("GLOBAL_HISTORY_CONFLICT", file, "existing history differs in business content; refusing overwrite without explicit replacement");
    if (typeof expectedExistingBusinessSha256 !== "string" || expectedExistingBusinessSha256 !== existingBusinessSha256) fail("GLOBAL_HISTORY_REPLACE_CONFLICT", file, "explicit replacement hash does not match the existing business content");
    return { existing, existingBusinessSha256, existingValidated, replaced: true };
  }
  return { existing, existingBusinessSha256, existingValidated, replaced: false };
}

function commit(entries, failAt = null) {
  const backups = entries.map((entry) => ({ file: entry.file, before: fs.existsSync(entry.file) ? fs.readFileSync(entry.file) : null }));
  const written = [];
  try {
    for (const [index, entry] of entries.entries()) {
      if (!entry.shouldWrite) continue;
      atomicBytes(entry.file, entry.bytes);
      written.push(entry);
      if (failAt !== null && failAt === index + 1) fail("GLOBAL_STORAGE_WRITE", entry.relativePath, "injected storage write failure");
    }
  } catch (cause) {
    for (const backup of backups) {
      if (backup.before === null) {
        if (fs.existsSync(backup.file)) fs.unlinkSync(backup.file);
      } else {
        atomicBytes(backup.file, backup.before);
      }
    }
    throw cause;
  }
  return written;
}

export function projectGlobalMarketBriefPublicDto(brief) {
  try {
    validateGlobalMarketBrief(brief);
  } catch (cause) {
    fail("GLOBAL_BRIEF_INVALID", "brief", cause instanceof Error ? cause.message : "global brief failed validation");
  }
  return publicDto(brief);
}

export function planGlobalMarketBriefWrite({ rootDir, brief, replaceExisting = false, expectedExistingBusinessSha256 = null }) {
  const root = path.resolve(rootDir);
  try {
    validateGlobalMarketBrief(brief);
  } catch (cause) {
    fail("GLOBAL_BRIEF_INVALID", "brief", cause instanceof Error ? cause.message : "global brief failed validation");
  }
  const dto = publicDto(brief);
  const historyPath = historyRelativePath(brief.editionDate);
  const historyFile = resolveRoot(root, historyPath);
  let historyExisting = null;
  if (fs.existsSync(historyFile)) historyExisting = validateExistingHistory(historyFile, brief, { replaceExisting, expectedExistingBusinessSha256 });
  const historyBytes = historyExisting?.replaced ? jsonBytes(brief) : historyExisting ? fs.readFileSync(historyFile) : jsonBytes(brief);
  const publicPath = GLOBAL_PUBLIC_DTO_PATH;
  const historyEntry = planEntry(root, historyPath, historyBytes, "global-history");
  const publicEntry = planEntry(root, publicPath, jsonBytes(dto), "global-public-dto");
  const history = listGlobalMarketBriefHistory(root, { excludeEditionDate: brief.editionDate });
  history.push(historyExisting?.replaced ? brief : historyExisting?.existing ?? brief);
  const index = buildGlobalMarketBriefIndex(history);
  validateGlobalMarketBriefIndex(index);
  const indexEntry = planEntry(root, GLOBAL_INDEX_PATH, jsonBytes(index), "global-index");
  const entries = [historyEntry, publicEntry, indexEntry];
  return {
    schemaVersion: "global-market-brief-storage-plan-v1",
    editionDate: brief.editionDate,
    dataAsOf: brief.dataAsOf,
    historyPath,
    publicPath,
    indexPath: GLOBAL_INDEX_PATH,
    dtoSha256: sha256Canonical(dto),
    replacement: historyExisting?.replaced ? {
      mode: "explicit-replace",
      expectedExistingBusinessSha256,
      existingBusinessSha256: historyExisting.existingBusinessSha256,
      existingValidated: historyExisting.existingValidated,
    } : null,
    entries,
    noOp: entries.every((entry) => !entry.shouldWrite),
    wouldWrite: entries.filter((entry) => entry.shouldWrite).map((entry) => entry.relativePath),
  };
}

export function writeGlobalMarketBrief({ rootDir, brief, dryRun = false, write = false, failAt = null, replaceExisting = false, expectedExistingBusinessSha256 = null }) {
  if (dryRun === write) fail("GLOBAL_STORAGE_MODE", "mode", "exactly one of dryRun or write is required");
  const plan = planGlobalMarketBriefWrite({ rootDir, brief, replaceExisting, expectedExistingBusinessSha256 });
  const written = write ? commit(plan.entries, failAt) : [];
  return {
    schemaVersion: "global-market-brief-storage-result-v1",
    editionDate: plan.editionDate,
    dataAsOf: plan.dataAsOf,
    noOp: plan.noOp,
    dryRun,
    wrote: written.length > 0,
    files: written.map((entry) => entry.relativePath),
    wouldWrite: plan.wouldWrite,
    allowedFiles: [plan.historyPath, plan.publicPath, plan.indexPath],
    replacement: plan.replacement,
    dtoSha256: plan.dtoSha256,
  };
}

export function listGlobalMarketBriefHistory(rootDir, { excludeEditionDate = null } = {}) {
  const directory = resolveRoot(rootDir, GLOBAL_HISTORY_DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) !== excludeEditionDate)
    .sort().map((name) => {
    const relativePath = `${GLOBAL_HISTORY_DIRECTORY}/${name}`;
    const value = readJson(resolveRoot(rootDir, relativePath), relativePath);
    try {
      validateGlobalMarketBrief(value);
    } catch (cause) {
      fail("GLOBAL_HISTORY_CORRUPT", relativePath, cause instanceof Error ? cause.message : "history failed validation");
    }
    return value;
  });
}
