import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ArticleReport from "@/components/ArticleReport";
import dailyBrief from "@/content/daily-brief.json";
import { collectArticleRecords, findArticleRecord } from "@/lib/articles";
import type { DailyBrief } from "@/lib/types";

const data = dailyBrief as DailyBrief;

export const dynamicParams = false;

export function generateStaticParams() {
  return collectArticleRecords(data).map(({ article }) => ({ id: article.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const record = findArticleRecord(data, id);
  if (!record) return {};
  return {
    title: `${record.article.title} · 观潮`,
    description: record.article.detail.lead,
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = findArticleRecord(data, id);
  if (!record) notFound();
  return <ArticleReport record={record} visuals={data.visuals ?? []} />;
}
