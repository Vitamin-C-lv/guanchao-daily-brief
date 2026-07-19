import sectorDetailsJson from "@/content/sector-details.json";
import type {
  SectorDetail,
  SectorDetailMarket,
  SectorDetailMarketId,
  SectorDetailsIndex,
} from "@/lib/types";

export const sectorDetails = sectorDetailsJson as SectorDetailsIndex;

export interface SectorDetailRecord {
  market: SectorDetailMarket;
  detail: SectorDetail;
}

export function sectorDetailKey(marketId: SectorDetailMarketId, code: string) {
  return `${marketId}:${code}`;
}

export function collectSectorDetailRecords(data: SectorDetailsIndex = sectorDetails): SectorDetailRecord[] {
  return data.markets
    .flatMap((market) => market.sectors.map((detail) => ({ market, detail })))
    .filter(({ detail }) => Boolean(detail.code.trim()));
}

export function collectSectorDetailKeys(data: SectorDetailsIndex = sectorDetails) {
  return collectSectorDetailRecords(data).map(({ market, detail }) => sectorDetailKey(market.id, detail.code));
}

export function findSectorDetailRecord(
  marketId: string,
  code: string,
  data: SectorDetailsIndex = sectorDetails,
): SectorDetailRecord | undefined {
  const market = data.markets.find((candidate) => candidate.id === marketId);
  if (!market) return undefined;
  const detail = market.sectors.find((candidate) => candidate.code === code);
  return detail ? { market, detail } : undefined;
}
