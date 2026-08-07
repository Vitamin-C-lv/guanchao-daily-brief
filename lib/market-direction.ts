export type MarketDirection = "up" | "down" | "flat";

export function getMarketDirection(change: number | null | undefined): MarketDirection {
  if (typeof change !== "number" || !Number.isFinite(change) || change === 0) return "flat";
  return change > 0 ? "up" : "down";
}

export function marketDirectionClass(change: number | null | undefined) {
  return getMarketDirection(change);
}

export function formatMarketChange(change: number | null | undefined, digits = 2) {
  if (typeof change !== "number" || !Number.isFinite(change)) return "—";
  return `${change > 0 ? "+" : ""}${change.toFixed(digits)}%`;
}
