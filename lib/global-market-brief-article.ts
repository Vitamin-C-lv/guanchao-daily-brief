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

export interface ArticleAnalysisSection {
  heading: string;
  paragraphs: string[];
  sources: ArticleSource[];
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

export interface InvestmentStrategyRecommendation {
  market: string;
  targetType: string;
  targetId: string;
  label: string;
  action: "increase" | "hold" | "reduce";
  direction: "bullish" | "neutral" | "bearish";
  conviction: number;
  horizon: string;
  whyNow: string;
  modelEvidence: string;
  writerOverlay: string;
  supportingSourceIds: string[];
  predictionIds: string[];
  trigger: string;
  invalidation: string;
  modelAgreement: "agree" | "override" | "not_applicable";
  overrideReason: string | null;
  modelSignal: {
    status: "published" | "abstained" | "unavailable" | "no_direct_model_signal";
    predictionIds: string[];
    probability: number | null;
    probabilityTarget: string | null;
    probabilityUnit: string | null;
    horizonSessions: number;
    market: string;
    predictionTargetId: string;
  };
}

export interface InvestmentStrategyArticleData {
  title: string;
  summary: string;
  overallStance: "risk_on" | "neutral" | "risk_off";
  signalOrigin: "model_plus_writer" | "writer_only";
  modelContext: { status: "published" | "abstained" | "unavailable"; signalAvailable: boolean; horizonSessions: number; sourcePredictionIds: string[] };
  allocationPreference: { preferredTargetIds: string[]; underweightTargetIds: string[] };
  recommendations: InvestmentStrategyRecommendation[];
}

export interface GlobalArticlePage {
  kind: GlobalArticleKind;
  id: string;
  articleUrl: string;
  editionDate: string;
  title: string;
  dek: string;
  conclusion: string;
  dataAsOf: string;
  marketTags: string[];
  sourceCount: number;
  triggerType: string | null;
  triggerReason: string | null;
  analysisSections: ArticleAnalysisSection[];
  analysis: string[];
  keyFacts: ArticleFact[];
  logicChain: ArticleLogicEdge[];
  crossMarketTransmission: ArticleTransmission[];
  outlook: { nextSession: ArticleOutlookItem; oneWeek: ArticleOutlookItem };
  invalidationConditions: ArticleInvalidation[];
  watchItems: ArticleWatchItem[];
  investmentStrategy: InvestmentStrategyArticleData | null;
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
  if (!/^\/articles\/[a-z0-9][a-z0-9._-]{1,79}\/$/.test(parsed)) throw new Error(`GLOBAL_ARTICLE_INVALID ${field}: article URL required`);
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

function analysisSections(value: unknown, field: string, resolveSources: (ids: unknown, field: string) => ArticleSource[]): ArticleAnalysisSection[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const item = record(entry, `${field}[${index}]`);
    return {
      heading: string(item.heading, `${field}[${index}].heading`),
      paragraphs: stringArray(item.paragraphs, `${field}[${index}].paragraphs`),
      sources: resolveSources(item.sourceIds, `${field}[${index}].sourceIds`),
    };
  });
}

export interface GlobalMarketBriefArchiveArticle {
  id: string;
  kind: GlobalArticleKind;
  editionDate: string;
  dataAsOf: string;
  title: string;
  dek: string;
  conclusion: string;
  marketTags: string[];
  articleUrl: string;
  sourceCount: number;
  investmentStrategyPreview: { summary: string; overallStance: string; modelStatus: string; signalOrigin: string; recommendations: Array<{ label: string; action: string; direction: string; conviction: number }> } | null;
}

function investmentStrategy(value: unknown): InvestmentStrategyArticleData | null {
  if (value === undefined || value === null) return null;
  const item = record(value, "investmentStrategy");
  const model = record(item.modelContext, "investmentStrategy.modelContext");
  const recommendations = Array.isArray(item.recommendations) ? item.recommendations : [];
  return {
    title: string(item.title, "investmentStrategy.title"),
    summary: string(item.summary, "investmentStrategy.summary"),
    overallStance: string(item.overallStance, "investmentStrategy.overallStance") as InvestmentStrategyArticleData["overallStance"],
    signalOrigin: string(item.signalOrigin, "investmentStrategy.signalOrigin") as InvestmentStrategyArticleData["signalOrigin"],
    allocationPreference: {
      preferredTargetIds: stringArray(record(item.allocationPreference, "investmentStrategy.allocationPreference").preferredTargetIds, "investmentStrategy.allocationPreference.preferredTargetIds"),
      underweightTargetIds: stringArray(record(item.allocationPreference, "investmentStrategy.allocationPreference").underweightTargetIds, "investmentStrategy.allocationPreference.underweightTargetIds"),
    },
    modelContext: {
      status: string(model.status, "investmentStrategy.modelContext.status") as InvestmentStrategyArticleData["modelContext"]["status"],
      signalAvailable: model.signalAvailable === true,
      horizonSessions: typeof model.horizonSessions === "number" ? model.horizonSessions : 0,
      sourcePredictionIds: stringArray(model.sourcePredictionIds, "investmentStrategy.modelContext.sourcePredictionIds"),
    },
    recommendations: recommendations.map((value, index) => {
      const recommendation = record(value, `investmentStrategy.recommendations[${index}]`);
      return {
        market: string(recommendation.market, "investmentStrategy.recommendations.market"),
        targetType: string(recommendation.targetType, "investmentStrategy.recommendations.targetType"),
        targetId: string(recommendation.targetId, "investmentStrategy.recommendations.targetId"),
        label: string(recommendation.label, "investmentStrategy.recommendations.label"),
        action: string(recommendation.action, "investmentStrategy.recommendations.action") as InvestmentStrategyRecommendation["action"],
        direction: string(recommendation.direction, "investmentStrategy.recommendations.direction") as InvestmentStrategyRecommendation["direction"],
        conviction: typeof recommendation.conviction === "number" ? recommendation.conviction : 0,
        horizon: string(recommendation.horizon, "investmentStrategy.recommendations.horizon"),
        whyNow: string(recommendation.whyNow, "investmentStrategy.recommendations.whyNow"),
        modelEvidence: string(recommendation.modelEvidence, "investmentStrategy.recommendations.modelEvidence"),
        writerOverlay: string(recommendation.writerOverlay, "investmentStrategy.recommendations.writerOverlay"),
        supportingSourceIds: stringArray(recommendation.supportingSourceIds, "investmentStrategy.recommendations.supportingSourceIds"),
        predictionIds: stringArray(recommendation.predictionIds, "investmentStrategy.recommendations.predictionIds"),
        trigger: string(recommendation.trigger, "investmentStrategy.recommendations.trigger"),
        invalidation: string(recommendation.invalidation, "investmentStrategy.recommendations.invalidation"),
        modelAgreement: string(recommendation.modelAgreement, "investmentStrategy.recommendations.modelAgreement") as InvestmentStrategyRecommendation["modelAgreement"],
        overrideReason: recommendation.overrideReason === null ? null : string(recommendation.overrideReason, "investmentStrategy.recommendations.overrideReason"),
        modelSignal: (() => {
          const signal = record(recommendation.modelSignal, `investmentStrategy.recommendations[${index}].modelSignal`);
          return {
            status: string(signal.status, "investmentStrategy.recommendations.modelSignal.status") as InvestmentStrategyRecommendation["modelSignal"]["status"],
            predictionIds: stringArray(signal.predictionIds, "investmentStrategy.recommendations.modelSignal.predictionIds"),
            probability: typeof signal.probability === "number" ? signal.probability : null,
            probabilityTarget: signal.probabilityTarget === null ? null : string(signal.probabilityTarget, "investmentStrategy.recommendations.modelSignal.probabilityTarget"),
            probabilityUnit: signal.probabilityUnit === null ? null : string(signal.probabilityUnit, "investmentStrategy.recommendations.modelSignal.probabilityUnit"),
            horizonSessions: typeof signal.horizonSessions === "number" ? signal.horizonSessions : 0,
            market: string(signal.market, "investmentStrategy.recommendations.modelSignal.market"),
            predictionTargetId: string(signal.predictionTargetId, "investmentStrategy.recommendations.modelSignal.predictionTargetId"),
          };
        })(),
      };
    }),
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
    editionDate: date(brief.editionDate, "editionDate"),
    title: string(article.title, `${field}.title`),
    dek: string(article.dek, `${field}.dek`),
    conclusion: string(article.conclusion, `${field}.conclusion`),
    dataAsOf: date(brief.dataAsOf, "dataAsOf"),
    marketTags: stringArray(article.marketTags, `${field}.marketTags`),
    sourceCount: sourceLinks.length,
    triggerType: kind === "special_report" ? string(article.triggerType, `${field}.triggerType`) : null,
    triggerReason: kind === "special_report" ? string(article.triggerReason, `${field}.triggerReason`) : null,
    analysisSections: analysisSections(article.analysisSections, `${field}.analysisSections`, resolveSources),
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
    investmentStrategy: kind === "global_main" ? investmentStrategy(article.investmentStrategy) : null,
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

export function projectGlobalMarketBriefArchive(articles: GlobalArticlePage[]): GlobalMarketBriefArchiveArticle[] {
  return articles.map((article) => ({
    id: article.id,
    kind: article.kind,
    editionDate: article.editionDate,
    dataAsOf: article.dataAsOf,
    title: article.title,
    dek: article.dek,
    conclusion: article.conclusion,
    marketTags: [...article.marketTags],
    articleUrl: article.articleUrl,
    sourceCount: article.sourceCount,
    investmentStrategyPreview: article.investmentStrategy ? {
      summary: article.investmentStrategy.summary,
      overallStance: article.investmentStrategy.overallStance,
      modelStatus: article.investmentStrategy.modelContext.status,
      signalOrigin: article.investmentStrategy.signalOrigin,
      recommendations: article.investmentStrategy.recommendations.slice(0, 3).map((item) => ({ label: item.label, action: item.action, direction: item.direction, conviction: item.conviction })),
    } : null,
  })).sort((left, right) => right.editionDate.localeCompare(left.editionDate) || (left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind === "global_main" ? -1 : 1));
}

export function findGlobalMarketBriefArticle(articles: GlobalArticlePage[], id: string): GlobalArticlePage | null {
  return articles.find((article) => article.id === id || article.articleUrl.split("/").filter(Boolean).at(-1) === id) ?? null;
}

export function collectGlobalMarketBriefArticleIds(articles: GlobalArticlePage[]): string[] {
  return articles.map((article) => article.id);
}
