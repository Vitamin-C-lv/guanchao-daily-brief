import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ArticleReport from "@/components/ArticleReport";
import GlobalBriefArticleView from "@/components/GlobalBriefArticleView";
import dailyBrief from "@/content/daily-brief.json";
import { collectArticleRecords, findArticleRecord } from "@/lib/articles";
import { collectGlobalPublicArticleIds, findGlobalPublicArticle, loadGlobalMarketBriefPublic } from "@/lib/global-market-brief-public";
import type { DailyBrief } from "@/lib/types";

const data = dailyBrief as DailyBrief;
const globalBrief = loadGlobalMarketBriefPublic(process.env.GUANCHAO_GLOBAL_PUBLIC_DTO_PATH);

export const dynamicParams = false;

export function generateStaticParams() {
  const legacyIds = collectArticleRecords(data).map(({ article }) => article.id);
  const globalIds = globalBrief ? collectGlobalPublicArticleIds(globalBrief) : [];
  return [...new Set([...legacyIds, ...globalIds])].map((id) => ({ id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const globalArticle = globalBrief ? findGlobalPublicArticle(globalBrief, id) : null;
  if (globalArticle) {
    return {
      title: `${globalArticle.article.title} · 观潮`,
      description: globalArticle.kind === "global_main" ? globalArticle.article.dek : globalArticle.article.conclusion,
    };
  }
  const record = findArticleRecord(data, id);
  if (!record) return {};
  return {
    title: `${record.article.title} · 观潮`,
    description: record.article.detail.lead,
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const globalArticle = globalBrief ? findGlobalPublicArticle(globalBrief, id) : null;
  if (globalArticle && globalBrief) return <GlobalBriefArticleView article={globalArticle} data={globalBrief} />;
  const record = findArticleRecord(data, id);
  if (!record) notFound();
  return <ArticleReport record={record} visuals={data.visuals ?? []} />;
}
