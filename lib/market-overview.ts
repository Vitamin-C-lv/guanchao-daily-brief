import type { MarketHistoryStatus } from "@/lib/market-history";

export interface MarketOverviewSnapshot {
  status: MarketHistoryStatus;
  asOf: string | null;
  latestClose: number | null;
  previousClose: number | null;
  pointChange: number | null;
  percentChange: number | null;
  trend: number[];
}
