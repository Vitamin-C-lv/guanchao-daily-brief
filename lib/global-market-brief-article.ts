import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type GlobalArticleKind = "global_main" | "special_report";
export type GlobalArticleStatus = "confirmed" | "revised" | "delayed" | "estimated" | "unavailable";
export type GlobalArticleEvidenceStatus = "confirmed" | "partially_confirmed" | "pending" | "reversed";

export interface ArticleSource {
  sourceId: string;
  title: string;
  publisher: string;
  url: string;
  publishedAt: string | null;
}

export interface ArticleFact {
  id: string;
  statement: string;
  asOf: string;
  factStatus: GlobalArticleStatus;
  value: number | null;
  unit: string | null;
  sources: ArticleSource[];
}

export interface ArticleLogicEdge {
  from: string;
  relation: string;
  to: string;
  evidenceStatus: GlobalArticleEvidenceStatus;
  supportingSources: ArticleSource[];
  contradictorySources: ArticleSource[];
}

export interface ArticleTransmission {
  fromMarket: string;
  toMarket: string;
  direction: string;
  horizon: string;
  explanation: string;
  evidenceStatus: GlobalArticleEvidenceStatus;
  sources: ArticleSource[];
  invalidationConditionIds: string[];
}

export interface ArticleOutlookItem {
  statement: string;
  sources: ArticleSource[];
  invalidationConditionIds: string[];
}

export interface ArticleInvalidation {
  id: string;
  condition: string;
  affectedClaims: string[];
}

export interface ArticleWatchItem {
  item: string;
  whyItMatters: string;
  expectedAt: string | null;
  sources: ArticleSource[];
}

export interface GlobalArticlePage {
  kind: GlobalArticleKind;
  id: string;
  articleUrl: string;
  title: string;
  dek: string;
  conclusion: string;
  dataAsOf: string;
  marketTags: string[];
  sourceCount: number;
  triggerType: string | null;
  triggerReason: string | null;
  analysis: string[];
  keyFacts: ArticleFact[];
  logicChain: ArticleLogicEdge[];
  crossMarketTransmission: ArticleTransmission[];
  outlook: { nextSession: ArticleOutlookItem; oneWeek: ArticleOutlookItem };
  invalidationConditions: ArticleInvalidation[];
  watchItems: ArticleWatchItem[];
  sources: ArticleSource[];
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: object required`);
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: non-empty string required`);
  return value;
}

function nullableDate(value: unknown, field: string): string | null {
  if (value === null) return null;
  const parsed = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: date required`);
  return parsed;
}

function date(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed)) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: date required`);
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: string array required`);
  return [...value];
}

function safeSource(value: unknown, field: string): ArticleSource {
  const source = record(value, field);
  const sourceId = string(source.id, `${field}.id`);
  const url = string(source.url, `${field}.url`);
  if (!url.startsWith("https://")) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}.url: HTTPS source required`);
  return {
    sourceId,
    title: string(source.title, `${field}.title`),
    publisher: string(source.publisher, `${field}.publisher`),
    url,
    publishedAt: nullableDate(source.asOf, `${field}.asOf`),
  };
}

function articleUrl(value: unknown, field: string): string {
  const parsed = string(value, field);
  if (!/^\/articles\/[a-z0-9][a-z0-9._-]{1,79}\/\/$/.test(parsed)) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: article URL required`);
  return parsed;
}

function sourceResolver(sourceIndex: unknown) {
  if (!Array.isArray(sourceIndex) || sourceIndex.length < 1) throw new Error("GLOBAL_ARTICLE_INVALID sourceIndex: source array required");
  const sources = sourceIndex.map((source, index) => safeSource(source, `sourceIndex[${index}]`));
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  return (ids: unknown, field: string): ArticleSource[] => stringArray(ids, field).map((id) => {
    const source = byId.get(id);
    if (!source) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: source ${id} is not in sourceIndex`);
    return { ...source };
  });
}

function fact(value: unknown, index: number, resolveSources: (ids: unknown, field: string) => ArticleSource[]): ArticleFact {
  const item = record(value, `keyFacts[${index}]`);
  return {
    id: string(item.id, `keyFacts[${index}].id`),
    statement: string(item.statement, `keyFacts[${index}].statement`),
    asOf: date(item.asOf, `keyFacts[${index}].asOf`),
    factStatus: string(item.factStatus, `keyFacts[${index}].factStatus`) as GlobalArticleStatus,
    value: typeof item.value === "number" ? item.value : null,
    unit: typeof item.unit === "string" ? item.unit : null,
    sources: resolveSources(item.sourceIds, `keyFacts[${index}].sourceIds`),
  };
}

function logic(value: unknown, index: number, resolveSources: (ids: unknown, field: string) => ArticleSource[]): ArticleLogicEdge {
  const item = record(value, `logicChain[${index}]`);
  return {
    from: string(item.from, `logicChain[${index}].from`),
    relation: string(item.relation, `logicChain[${index}].relation`),
    to: string(item.to, `logicChain[${index}].to`),
    evidenceStatus: string(item.evidenceStatus, `logicChain[${index}].evidenceStatus`) as GlobalArticleEvidenceStatus,
    supportingSources: resolveSources(item.supportingSourceIds, `logicChain[${index}].supportingSourceIds`),
    contradictorySources: resolveSources(item.contradictorySourceIds, `logicChain[${index}].contradictorySourceIds`),
  };
}

function outlookItem(value: unknown, field: string, resolveSources: (ids: unknown, field: string) => ArticleSource[]): ArticleOutlookItem {
  const item = record(value, field);
  return {
    statement: string(item.statement, `${field}.statement`),
    sources: resolveSources(item.supportingSourceIds, `${field}.supportingSourceIds`),
    invalidationConditionIds: stringArray(item.invalidationConditionIds, `${field}.invalidationConditionIds`),
  };
}

function projectArticle(brief: Record<string, unknown>, article: Record<string, unknown>, kind: GlobalArticleKind, resolveSources: (ids: unknown, field: string) => ArticleSource[]): GlobalArticlePage {
  const field = kind === "global_main" ? "mainArticle" : "specialReport";
  const sourceLinks = resolveSources(article.sourceIds, `${field}.sourceIds`);
  const outlook = record(article.outlook, `${field}.outlook`);
  const projected: GlobalArticlePage = {
    kind,
    id: string(article.id, `${field}.id`),
    articleUrl: articleUrl(article.articleUrl, `${field}.articleUrl`),
    title: string(article.title, `${field}.title`),
    dek: string(article.dek, `${field}.dek`),
    conclusion: string(article.conclusion, `${field}.conclusion`),
    dataAsOf: date(brief.dataAsOf, "dataAsOf"),
    marketTags: stringArray(article.marketTags, `${field}.marketTags`),
    sourceCount: sourceLinks.length,
    triggerType: kind === "special_report" ? string(article.triggerType, `${field}.triggerType`) : null,
    triggerReason: kind === "special_report" ? string(article.triggerReason, `${field}.triggerReason`) : null,
    analysis: kind === "special_report" ? stringArray(article.analysis, `${field}.analysis`) : [],
    keyFacts: Array.isArray(article.keyFacts) ? article.keyFacts.map((item, index) => fact(item, index, resolveSources)) : [],
    logicChain: Array.isArray(article.logicChain) ? article.logicChain.map((item, index) => logic(item, index, resolveSources)) : [],
    crossMarketTransmission: Array.isArray(article.crossMarketTransmission) ? article.crossMarketTransmission.map((value, index) => {
      const item = record(value, `${field}.crossMarketTransmission[${index}]`);
      return {
        fromMarket: string(item.fromMarket, "fromMarket"),
        toMarket: string(item.toMarket, "toMarket"),
        direction: string(item.direction, "direction"),
        horizon: string(item.horizon, "horizon"),
        explanation: string(item.explanation, "explanation"),
        evidenceStatus: string(item.evidenceStatus, "evidenceStatus") as GlobalArticleEvidenceStatus,
        sources: resolveSources(item.supportingSourceIds, "supportingSourceIds"),
        invalidationConditionIds: stringArray(item.invalidationConditionIds, "invalidationConditionIds"),
      };
    }) : [],
    outlook: {
      nextSession: outlookItem(outlook.nextSession, `${field}.outlook.nextSession`, resolveSources),
      oneWeek: outlookItem(outlook.oneWeek, `${field}.outlook.oneWeek`, resolveSources),
    },
    invalidationConditions: Array.isArray(article.invalidationConditions) ? article.invalidationConditions.map((value, index) => {
      const item = record(value, `${field}.invalidationConditions[${index}]`);
      return { id: string(item.id, "condition.id"), condition: string(item.condition, "condition.condition"), affectedClaims: stringArray(item.affectedClaims, "condition.affectedClaims") };
    }) : [],
    watchItems: Array.isArray(article.watchItems) ? article.watchItems.map((value, index) => {
      const item = record(value, `${field}.watchItems[${index}]`);
      return { item: string(item.item, "watch.item"), whyItMatters: string(item.whyItMatters, "watch.whyItMatters"), expectedAt: nullableDate(item.expectedAt, "watch.expectedAt"), sources: resolveSources(item.sourceIds, "watch.sourceIds") };
    }) : [],
    sources: sourceLinks,
  };
  return projected;
}

export function projectGlobalMarketBriefForArticle(value: unknown): GlobalArticlePage[] {
  const brief = record(value, "$globalBrief");
  const resolveSources = sourceResolver(brief.sourceIndex);
  const main = record(brief.mainArticle, "mainArticle");
  const specials = Array.isArray(brief.specialReports) ? brief.specialReports : [];
  return [projectArticle(brief, main, "global_main", resolveSources), ...specials.map((item, index) => projectArticle(brief, record(item, `specialReports[${index}]`), "special_report", resolveSources))];
}

export function loadGlobalMarketBriefArticles(root = process.cwd()): GlobalArticlePage[] {
  const directory = path.join(root, "content", "global-market-briefs");
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().flatMap((name) => {
    const value = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as unknown;
    return projectGlobalMarketBriefForArticle(value);
  });
}

export function findGlobalMarketBriefArticle(articles: GlobalArticlePage[], id: string): GlobalArticlePage | null {
  return articles.find((article) => article.id === id || article.articleUrl.split("/").filter(Boolean).at(-1) === id) ?? null;
}

export function collectGlobalMarketBriefArticleIds(articles: GlobalArticlePage[]): string[] {
  return articles.map((article) => article.id);
}
