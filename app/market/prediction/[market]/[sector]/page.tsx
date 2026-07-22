import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SectorPredictionDetail from "@/components/SectorPredictionDetail";
import { collectSectorDetailRecords, findSectorDetailRecord } from "@/lib/sector-details";
import { findRotationMarket, predictionHistoryRecords } from "@/lib/prediction-history";

export const dynamicParams = false;

export function generateStaticParams() {
  return collectSectorDetailRecords().map(({ market, detail }) => ({
    market: market.id,
    sector: detail.code,
  }));
}

export async function generateMetadata({ params }: { params: Promise<{ market: string; sector: string }> }): Promise<Metadata> {
  const { market, sector } = await params;
  const record = findSectorDetailRecord(market, sector);
  if (!record) return {};
  return {
    title: `${record.detail.name}预测历史 · 观潮`,
    description: `查看${record.detail.name}的真实历史预测、模型弃权与到期实际结果。`,
  };
}

export default async function SectorPredictionPage({ params }: { params: Promise<{ market: string; sector: string }> }) {
  const { market, sector } = await params;
  const detailRecord = findSectorDetailRecord(market, sector);
  if (!detailRecord) notFound();
  return (
    <SectorPredictionDetail
      market={detailRecord.market}
      detail={detailRecord.detail}
      rotationMarket={findRotationMarket(market)}
      records={predictionHistoryRecords(market, sector)}
    />
  );
}
