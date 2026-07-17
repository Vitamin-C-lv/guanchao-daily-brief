import type { Metadata } from "next";
import { notFound } from "next/navigation";
import WeeklyReportView from "@/components/WeeklyReportView";
import { loadWeeklyIndex, loadWeeklyReport } from "@/lib/weekly";

export const dynamicParams = false;

export function generateStaticParams() {
  const reports = loadWeeklyIndex().reports.map((item) => ({ id: item.id }));
  return reports.length ? reports : [{ id: "pending" }];
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const report = loadWeeklyReport(id);
  return report ? { title: `${report.report.title} · 观潮`, description: report.executiveSummary.weekVerdict } : {};
}

export default async function WeeklyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = loadWeeklyReport(id);
  if (!report) notFound();
  return <WeeklyReportView data={report} />;
}
