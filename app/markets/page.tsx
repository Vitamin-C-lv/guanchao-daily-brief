import { readFile } from "node:fs/promises";
import path from "node:path";
import MarketOverview from "@/components/MarketOverview";
import dailyBrief from "@/content/daily-brief.json";
import sectorRotation from "@/content/sector-rotation.json";
import { decodeMarketHistoryDocument } from "@/lib/market-history";
import { coreMarketInstruments } from "@/lib/market-instruments";
import type { MarketOverviewSnapshot } from "@/lib/market-overview";
import type { DailyBrief, SectorRotationIndex } from "@/lib/types";

async function loadHistorySnapshots() {
  const root = path.join(process.cwd(), "public", "data", "market-history");
  const snapshots: Record<string, MarketOverviewSnapshot | null> = {};
  for (const instrument of [...coreMarketInstruments("a-share"), ...coreMarketInstruments("hk"), ...coreMarketInstruments("us")]) {
    try {
      const raw: unknown = JSON.parse(await readFile(path.join(root, `${instrument.id}.json`), "utf8"));
      const history = decodeMarketHistoryDocument(raw, instrument);
      const latest = history?.bars.at(-1) ?? null;
      const previous = history?.bars.at(-2) ?? null;
      const pointChange = latest?.close !== null && latest?.close !== undefined && previous?.close !== null && previous?.close !== undefined ? latest.close - previous.close : null;
      const percentChange = pointChange !== null && previous?.close ? (pointChange / previous.close) * 100 : null;
      snapshots[instrument.id] = history ? { status: history.status, asOf: history.asOf, latestClose: latest?.close ?? null, previousClose: previous?.close ?? null, pointChange, percentChange, trend: history.bars.slice(-12).map((bar) => bar.close).filter((close): close is number => close !== null) } : null;
    } catch {
      snapshots[instrument.id] = null;
    }
  }
  return snapshots;
}

export default async function MarketsPage() {
  return <MarketOverview data={dailyBrief as DailyBrief} sectorRotation={sectorRotation as SectorRotationIndex} historySnapshots={await loadHistorySnapshots()} />;
}
