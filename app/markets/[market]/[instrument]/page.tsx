import type { Metadata } from "next";
import { notFound } from "next/navigation";
import MarketDetailView from "@/components/MarketDetailView";
import { findMarketInstrument, MARKET_INSTRUMENTS } from "@/lib/market-instruments";

export const dynamicParams = false;

export function generateStaticParams() {
  return MARKET_INSTRUMENTS.map((instrument) => ({ market: instrument.market, instrument: instrument.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ market: string; instrument: string }> }): Promise<Metadata> {
  const { instrument } = await params;
  const record = findMarketInstrument(instrument);
  return record ? { title: `${record.label}行情详情 · 观潮`, description: `查看${record.label}最近一年及更长区间的日K、均线、成交量与MACD。` } : {};
}

export default async function MarketInstrumentPage({ params }: { params: Promise<{ market: string; instrument: string }> }) {
  const { market, instrument } = await params;
  const record = findMarketInstrument(instrument);
  if (!record || record.market !== market) notFound();
  return <MarketDetailView instrumentId={record.id} />;
}
