import { readFileSync } from "node:fs";
import path from "node:path";

export const GLOBAL_PUBLIC_DTO_SCHEMA_VERSION = "global-market-brief-public-dto-v1" as const;
export const GLOBAL_PUBLIC_DTO_PATH = "content/global-market-brief-public.json" as const;

export const GLOBAL_MARKET_TAGS = ["US", "HK", "A_SHARE", "GLOBAL"] as const;
export type GlobalMarketTag = (typeof GLOBAL_MARKET_TAGS)[number];

export const GLOBAL_LOGIC_STATUSES = ["confirmed", "partially_confirmed", "pending", "reversed"] as const;
export type GlobalLogicStatus = (typeof GLOBAL_LOGIC_STATUSES)[number];

export const GLOBAL_TRIGGER_TYPES = [
  "abnormal_market_move",
  "central_bank_policy",
  "macro_data_surprise",
  "geopolitical_risk",
  "major_earnings",
  "china_policy",
  "theme_reversal",
  "systemic_risk",
] as const;
export type GlobalTriggerType = (typeof GLOBAL_TRIGGER_TYPES)[number];

export interface LogicChainSummary {
  from: string;
  relation: string;
  to: string;
  evidenceStatus: GlobalLogicStatus;
}

export interface GlobalMainBriefPublic {
  title: string;
  dek: string;
  conclusion: string;
  logicChainSummary: LogicChainSummary[];
  marketTags: GlobalMarketTag[];
  dataAsOf: string;
  sourceCount: number;
  articleUrl: string;
}

export interface GlobalSpecialReportPublic {
  title: string;
  triggerType: GlobalTriggerType;
  conclusion: string;
  marketTags: GlobalMarketTag[];
  articleUrl: string;
}

export interface GlobalMarketBriefPublic {
  schemaVersion: typeof GLOBAL_PUBLIC_DTO_SCHEMA_VERSION;
  dataAsOf: string;
  mainArticle: GlobalMainBriefPublic;
  specialReports: GlobalSpecialReportPublic[];
}

export type GlobalPublicArticle =
  | { kind: "global_main"; article: GlobalMainBriefPublic }
  | { kind: "special_report"; article: GlobalSpecialReportPublic };

export class GlobalMarketBriefPublicDecodeError extends Error {
  readonly code = "GLOBAL_MARKET_BRIEF_PUBLIC_INVALID";
  readonly fieldPath: string;

  constructor(fieldPath: string, reason: string) {
    super(`GLOBAL_MARKET_BRIEF_PUBLIC_INVALID path=${fieldPath} reason=${reason}`);
    this.name = "GlobalMarketBriefPublicDecodeError";
    this.fieldPath = fieldPath;
  }
}

const MAIN_KEYS = ["articleUrl", "conclusion", "dataAsOf", "dek", "logicChain", "marketTags", "sourceCount", "title"] as const;
const SPECIAL_KEYS = ["articleUrl", "conclusion", "marketTags", "title", "triggerType"] as const;
const LOGIC_KEYS = ["evidenceStatus", "from", "relation", "to"] as const;
const TOP_KEYS = ["dataAsOf", "mainArticle", "schemaVersion", "specialReports"] as const;

const FORBIDDEN_KEY_PATTERNS = [
  /provider/i,
  /lineage/i,
  /gate.?failure/i,
  /path/i,
  /stack/i,
  /raw.?research/i,
  /runtime.?log/i,
  /skill/i,
  /private/i,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(fieldPath: string, reason: string): never {
  throw new GlobalMarketBriefPublicDecodeError(fieldPath, reason);
}

function inspectForbiddenKeys(value: unknown, fieldPath = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectForbiddenKeys(item, `${fieldPath}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERNS.some((pattern) => pattern.test(key))) {
      fail(`${fieldPath}.${key}`, "internal provider, lineage, path, stack, research, runtime log, gate, or private Skill field is not public");
    }
    inspectForbiddenKeys(child, `${fieldPath}.${key}`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], fieldPath: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    const unexpected = actual.filter((key) => !allowed.includes(key));
    const missing = allowed.filter((key) => !actual.includes(key));
    const detail = [...unexpected.map((key) => `unexpected ${key}`), ...missing.map((key) => `missing ${key}`)].join(", ");
    fail(fieldPath, detail || "object fields do not match the public contract");
  }
}

function record(value: unknown, fieldPath: string): Record<string, unknown> {
  if (!isRecord(value)) fail(fieldPath, "object required");
  return value;
}

function string(value: unknown, fieldPath: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    fail(fieldPath, `non-empty string up to ${maxLength} characters required`);
  }
  return value;
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function date(value: unknown, fieldPath: string): string {
  const parsed = string(value, fieldPath, 10);
  if (!isDate(parsed)) fail(fieldPath, "YYYY-MM-DD date required");
  return parsed;
}

function oneOf<T extends string>(value: unknown, fieldPath: string, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    fail(fieldPath, `one of ${values.join(", ")} required`);
  }
  return value as T;
}

function tags(value: unknown, fieldPath: string): GlobalMarketTag[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) fail(fieldPath, "one to four market tags required");
  const result = value.map((item, index) => oneOf(item, `${fieldPath}[${index}]`, GLOBAL_MARKET_TAGS));
  if (new Set(result).size !== result.length) fail(fieldPath, "market tags must be unique");
  return result;
}

function articleUrl(value: unknown, fieldPath: string): string {
  const parsed = string(value, fieldPath, 120);
  if (!/^\/articles\/[a-z0-9][a-z0-9._-]{1,79}\/$/.test(parsed)) {
    fail(fieldPath, "internal article URL required");
  }
  return parsed;
}

function logicChain(value: unknown, fieldPath: string): LogicChainSummary[] {
  if (!Array.isArray(value) || value.length < 1) fail(fieldPath, "at least one public logic-chain edge is required");
  return value.map((item, index) => {
    const edgePath = `${fieldPath}[${index}]`;
    const edge = record(item, edgePath);
    exactKeys(edge, LOGIC_KEYS, edgePath);
    return {
      from: string(edge.from, `${edgePath}.from`, 160),
      relation: string(edge.relation, `${edgePath}.relation`, 160),
      to: string(edge.to, `${edgePath}.to`, 160),
      evidenceStatus: oneOf(edge.evidenceStatus, `${edgePath}.evidenceStatus`, GLOBAL_LOGIC_STATUSES),
    };
  });
}

function mainArticle(value: unknown): GlobalMainBriefPublic {
  const source = record(value, "mainArticle");
  exactKeys(source, MAIN_KEYS, "mainArticle");
  return {
    title: string(source.title, "mainArticle.title", 200),
    dek: string(source.dek, "mainArticle.dek", 500),
    conclusion: string(source.conclusion, "mainArticle.conclusion", 1200),
    logicChainSummary: logicChain(source.logicChain, "mainArticle.logicChain"),
    marketTags: tags(source.marketTags, "mainArticle.marketTags"),
    dataAsOf: date(source.dataAsOf, "mainArticle.dataAsOf"),
    sourceCount: (() => {
      if (!Number.isInteger(source.sourceCount) || (source.sourceCount as number) < 1) fail("mainArticle.sourceCount", "positive integer required");
      return source.sourceCount as number;
    })(),
    articleUrl: articleUrl(source.articleUrl, "mainArticle.articleUrl"),
  };
}

function specialReport(value: unknown, index: number): GlobalSpecialReportPublic {
  const fieldPath = `specialReports[${index}]`;
  const source = record(value, fieldPath);
  exactKeys(source, SPECIAL_KEYS, fieldPath);
  return {
    title: string(source.title, `${fieldPath}.title`, 200),
    triggerType: oneOf(source.triggerType, `${fieldPath}.triggerType`, GLOBAL_TRIGGER_TYPES),
    conclusion: string(source.conclusion, `${fieldPath}.conclusion`, 1200),
    marketTags: tags(source.marketTags, `${fieldPath}.marketTags`),
    articleUrl: articleUrl(source.articleUrl, `${fieldPath}.articleUrl`),
  };
}

/**
 * Decode the public DTO and rebuild a fresh UI-safe object. The input is never
 * passed through to React, which keeps internal Writer fields outside the page boundary.
 */
export function decodeGlobalMarketBriefPublic(value: unknown): GlobalMarketBriefPublic {
  inspectForbiddenKeys(value);
  const source = record(value, "$");
  exactKeys(source, TOP_KEYS, "$");
  if (source.schemaVersion !== GLOBAL_PUBLIC_DTO_SCHEMA_VERSION) {
    fail("schemaVersion", `${GLOBAL_PUBLIC_DTO_SCHEMA_VERSION} required`);
  }
  const dataAsOf = date(source.dataAsOf, "dataAsOf");
  if (!Array.isArray(source.specialReports) || source.specialReports.length > 2) {
    fail("specialReports", "zero to two special reports are allowed");
  }
  return {
    schemaVersion: GLOBAL_PUBLIC_DTO_SCHEMA_VERSION,
    dataAsOf,
    mainArticle: mainArticle(source.mainArticle),
    specialReports: source.specialReports.map((report, index) => specialReport(report, index)),
  };
}

export const adaptGlobalMarketBriefPublic = decodeGlobalMarketBriefPublic;
export const parseGlobalMarketBriefPublic = decodeGlobalMarketBriefPublic;

/** Read the future public DTO only when B4/Writer has placed it in production content. */
export function loadGlobalMarketBriefPublic(filePath = path.join(process.cwd(), GLOBAL_PUBLIC_DTO_PATH)): GlobalMarketBriefPublic | null {
  try {
    return decodeGlobalMarketBriefPublic(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

function articleId(articleUrl: string): string {
  return articleUrl.split("/").filter(Boolean).at(-1) ?? "";
}

export function findGlobalPublicArticle(data: GlobalMarketBriefPublic, id: string): GlobalPublicArticle | null {
  if (articleId(data.mainArticle.articleUrl) === id) return { kind: "global_main", article: data.mainArticle };
  const special = data.specialReports.find((report) => articleId(report.articleUrl) === id);
  return special ? { kind: "special_report", article: special } : null;
}

export function collectGlobalPublicArticleIds(data: GlobalMarketBriefPublic): string[] {
  return [data.mainArticle, ...data.specialReports].map((article) => articleId(article.articleUrl));
}
