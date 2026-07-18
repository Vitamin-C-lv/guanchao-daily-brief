import type { BriefArticle, DailyBrief } from "@/lib/types";

export type ArticleSectionId = "fed" | "a-share" | "hk" | "us" | "hotspot";

export interface ArticleRecord {
  article: BriefArticle;
  sectionId: ArticleSectionId;
  category: string;
  backHref: string;
  backLabel: string;
}

export function collectArticleRecords(data: DailyBrief): ArticleRecord[] {
  const records: ArticleRecord[] = data.federalReserve.articles.map((article) => ({
    article,
    sectionId: "fed",
    category: "美联储",
    backHref: "/fed/",
    backLabel: "返回美联储",
  }));

  data.markets.forEach((market) => {
    market.articles.forEach((article) => {
      records.push({
        article,
        sectionId: market.id,
        category: market.shortName,
        backHref: "/markets/",
        backLabel: "返回市场",
      });
    });
  });

  data.hotspots.forEach((article) => {
    records.push({
      article,
      sectionId: "hotspot",
      category: "热点",
      backHref: "/hotspots/",
      backLabel: "返回热点",
    });
  });

  return records;
}

export function findArticleRecord(data: DailyBrief, id: string): ArticleRecord | undefined {
  return collectArticleRecords(data).find((record) => record.article.id === id);
}

export function countArticleCharacters(article: BriefArticle): number {
  const detail = article.detail;
  const rotation = detail.rotationAnalysis;
  const forecasts = detail.evidenceForecast
    ? (Array.isArray(detail.evidenceForecast) ? detail.evidenceForecast : [detail.evidenceForecast])
    : [];
  return [
    detail.lead,
    ...detail.keyPoints,
    ...detail.sections.flatMap((section) => [section.heading, section.body]),
    ...(rotation ? [
      rotation.regime,
      ...rotation.volumeLeaders.map((item) => item.sector),
      ...rotation.flowSignals.flatMap((item) => [item.sector, item.evidence]),
      ...rotation.outlooks.flatMap((item) => [item.horizon, ...(item.candidateSectors ?? []), item.reason ?? "", item.flowPath, item.trigger, item.invalidation]),
      rotation.riskNote,
    ] : []),
    ...forecasts.flatMap((forecast) => [
      forecast.title,
      forecast.claim,
      ...forecast.evidence.flatMap((item) => [item.label, item.observation]),
      ...forecast.counterEvidence.flatMap((item) => [item.label, item.observation]),
      forecast.trigger,
      forecast.invalidation,
      forecast.riskNote,
      forecast.review?.note ?? "",
    ]),
  ].join("").replace(/\s/g, "").length;
}
