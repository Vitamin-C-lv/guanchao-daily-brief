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

export type MarketOverviewFactStatus = "verified" | "delayed" | "incomplete";

const CORE_INDEX_COUNT = 3;

function validDates(snapshots: readonly (MarketOverviewSnapshot | null)[]) {
  return snapshots
    .map((snapshot) => snapshot?.asOf ?? null)
    .filter((asOf): asOf is string => typeof asOf === "string" && asOf.length > 0);
}

export function getCommonDataThrough(snapshots: readonly (MarketOverviewSnapshot | null)[]) {
  return validDates(snapshots).sort()[0] ?? null;
}

export function hasMismatchedDataThrough(snapshots: readonly (MarketOverviewSnapshot | null)[]) {
  return new Set(validDates(snapshots)).size > 1;
}

export function getMarketOverviewFactStatus(snapshots: readonly (MarketOverviewSnapshot | null)[]): MarketOverviewFactStatus {
  if (
    snapshots.length !== CORE_INDEX_COUNT ||
    snapshots.some((snapshot) => {
      if (snapshot === null) return true;
      return (
        snapshot.status === "unavailable" ||
        snapshot.asOf === null ||
        snapshot.latestClose === null ||
        !Number.isFinite(snapshot.latestClose)
      );
    })
  ) {
    return "incomplete";
  }
  if (snapshots.some((snapshot) => snapshot === null || snapshot.status !== "ready")) return "delayed";
  return "verified";
}

export function getMarketOverviewFactStatusLabel(status: MarketOverviewFactStatus) {
  if (status === "verified") return "核心指数数据已校验";
  if (status === "delayed") return "部分指数数据延迟";
  return "核心指数数据不完整";
}

export function getMarketOverviewFreshnessLabel(snapshots: readonly (MarketOverviewSnapshot | null)[]) {
  if (hasMismatchedDataThrough(snapshots)) return "部分指数晚于/早于共同交易日";
  const status = getMarketOverviewFactStatus(snapshots);
  if (status === "incomplete") return "核心指数数据不完整";
  if (status === "delayed") return "部分指数历史不足一年";
  return "收盘后更新，非实时";
}

export function getMarketOverviewSessionDetail(snapshots: readonly (MarketOverviewSnapshot | null)[]) {
  const status = getMarketOverviewFactStatus(snapshots);
  if (status === "incomplete") return "核心指数数据不足，未使用旧日报";
  if (hasMismatchedDataThrough(snapshots)) return "按各指数最后有效日线展示";
  if (status === "delayed") return "部分核心指数历史不足一年";
  return "三核心指数共同有效日线";
}

export function getMarketCoreDisplay(snapshot: MarketOverviewSnapshot | null) {
  return {
    latestClose: snapshot?.latestClose ?? null,
    pointChange: snapshot?.pointChange ?? null,
    percentChange: snapshot?.percentChange ?? null,
  };
}
