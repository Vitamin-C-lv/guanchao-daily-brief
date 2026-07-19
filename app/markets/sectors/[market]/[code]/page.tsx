import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SectorDetailReport from "@/components/SectorDetailReport";
import { collectSectorDetailRecords, findSectorDetailRecord } from "@/lib/sector-details";

export const dynamicParams = false;

export function generateStaticParams() {
  return collectSectorDetailRecords().map(({ market, detail }) => ({
    market: market.id,
    code: detail.code,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ market: string; code: string }>;
}): Promise<Metadata> {
  const { market, code } = await params;
  const record = findSectorDetailRecord(market, code);
  if (!record) return {};
  return {
    title: `${record.detail.name}板块说明 · 观潮`,
    description: record.detail.description,
  };
}

export default async function SectorDetailPage({
  params,
}: {
  params: Promise<{ market: string; code: string }>;
}) {
  const { market, code } = await params;
  const record = findSectorDetailRecord(market, code);
  if (!record) notFound();
  return <SectorDetailReport market={record.market} detail={record.detail} />;
}
