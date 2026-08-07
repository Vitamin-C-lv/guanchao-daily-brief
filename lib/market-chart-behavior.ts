export type MarketRangeKey = "1M" | "3M" | "6M" | "1Y" | "ALL";

export interface MarketLogicalRange {
  from: number;
  to: number;
}

export const NORMAL_MARKET_CHART_HEIGHT = 520;
export const FULLSCREEN_MARKET_CHART_MIN_HEIGHT = 320;

export function marketRangeCount(range: MarketRangeKey, length: number) {
  if (range === "1M") return Math.min(21, length);
  if (range === "3M") return Math.min(63, length);
  if (range === "6M") return Math.min(126, length);
  if (range === "1Y") return Math.min(252, length);
  return length;
}

export function visibleRangeForMarketRange(range: MarketRangeKey, length: number): MarketLogicalRange {
  const count = marketRangeCount(range, length);
  return { from: Math.max(0, length - count - 1), to: Math.max(0, length - 1) };
}

export function clampMarketLogicalRange(range: MarketLogicalRange, length: number, rightPadding = 0): MarketLogicalRange {
  if (length <= 0 || !Number.isFinite(range.from) || !Number.isFinite(range.to) || range.to <= length - 1 + rightPadding) return range;
  const span = Math.max(1, range.to - range.from);
  const to = length - 1 + rightPadding;
  return { from: Math.max(-1, to - span), to };
}

export function sameMarketLogicalRange(left: MarketLogicalRange | null, right: MarketLogicalRange | null) {
  return left !== null && right !== null && left.from === right.from && left.to === right.to;
}
