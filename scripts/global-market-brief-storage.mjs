import fs from "node:fs";
import path from "node:path";

import { canonicalJson, sha256Canonical } from "./research-contract.mjs";
import {
  PUBLIC_DTO_SCHEMA_VERSION,
  validateGlobalMarketBrief,
  validateGlobalMarketBriefPublicDto,
} from "./global-market-brief-contract.mjs";

export const GLOBAL_HISTORY_DIRECTORY = "content/global-market-briefs";
export const GLOBAL_PUBLIC_DTO_PATH = "content/global-market-brief-public.json";
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

function validateExistingHistory(file, candidate) {
  const existing = readJson(file, file);
  try {
    validateGlobalMarketBrief(existing);
  } catch (cause) {
    fail("GLOBAL_HISTORY_CORRUPT", file, cause instanceof Error ? cause.message : "existing history failed validation");
  }
  if (!equalBusiness(existing, candidate)) fail("GLOBAL_HISTORY_CONFLICT", file, "existing history differs in business content; refusing overwrite");
  return existing;
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

export function planGlobalMarketBriefWrite({ rootDir, brief }) {
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
  if (fs.existsSync(historyFile)) historyExisting = validateExistingHistory(historyFile, brief);
  const historyBytes = historyExisting ? fs.readFileSync(historyFile) : jsonBytes(brief);
  const publicPath = GLOBAL_PUBLIC_DTO_PATH;
  const historyEntry = planEntry(root, historyPath, historyBytes, "global-history");
  const publicEntry = planEntry(root, publicPath, jsonBytes(dto), "global-public-dto");
  const entries = [historyEntry, publicEntry];
  return {
    schemaVersion: "global-market-brief-storage-plan-v1",
    editionDate: brief.editionDate,
    dataAsOf: brief.dataAsOf,
    historyPath,
    publicPath,
    dtoSha256: sha256Canonical(dto),
    entries,
    noOp: entries.every((entry) => !entry.shouldWrite),
    wouldWrite: entries.filter((entry) => entry.shouldWrite).map((entry) => entry.relativePath),
  };
}

export function writeGlobalMarketBrief({ rootDir, brief, dryRun = false, write = false, failAt = null }) {
  if (dryRun === write) fail("GLOBAL_STORAGE_MODE", "mode", "exactly one of dryRun or write is required");
  const plan = planGlobalMarketBriefWrite({ rootDir, brief });
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
    allowedFiles: [plan.historyPath, plan.publicPath],
    dtoSha256: plan.dtoSha256,
  };
}

export function listGlobalMarketBriefHistory(rootDir) {
  const directory = resolveRoot(rootDir, GLOBAL_HISTORY_DIRECTORY);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().map((name) => {
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
