import type { MarketInstrument } from "@/lib/market-instruments";

export const MARKET_HISTORY_SCHEMA_VERSION = "public-market-history-v1" as const;
export type MarketHistoryStatus = "ready" | "partial" | "stale" | "unavailable";

export interface MarketHistoryBar {
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface MarketHistorySource {
  provider: string;
  url: string | null;
  delayed: boolean;
  note: string;
  rawSha256?: string;
}

export interface MarketHistoryDocument {
  schemaVersion: typeof MARKET_HISTORY_SCHEMA_VERSION;
  instrument: Pick<MarketInstrument, "id" | "market" | "slug" | "label" | "currency" | "timezone">;
  status: MarketHistoryStatus;
  asOf: string | null;
  source: MarketHistorySource;
  bars: MarketHistoryBar[];
}

export interface MarketHistoryIndexEntry extends Omit<MarketHistoryDocument, "bars" | "instrument"> {
  instrument: MarketHistoryDocument["instrument"];
  path: string;
  rowCount: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface MarketHistoryIndex {
  schemaVersion: typeof MARKET_HISTORY_SCHEMA_VERSION;
  generatedAt: string;
  targetYears: number;
  minimumReadyRows: number;
  instruments: MarketHistoryIndexEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function finiteOrNull(value: unknown): number | null {
  return value === null ? null : typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeBar(value: unknown): MarketHistoryBar | null {
  if (!isRecord(value) || !hasExactKeys(value, ["time", "open", "high", "low", "close", "volume"])) return null;
  if (!isDate(value.time)) return null;
  const bar = { time: value.time, open: finiteOrNull(value.open), high: finiteOrNull(value.high), low: finiteOrNull(value.low), close: finiteOrNull(value.close), volume: finiteOrNull(value.volume) };
  if (bar.open === null || bar.high === null || bar.low === null || bar.close === null) return null;
  if (bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) return null;
  return bar;
}

export function decodeMarketHistoryDocument(raw: unknown, expected: MarketInstrument): MarketHistoryDocument | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["schemaVersion", "instrument", "status", "asOf", "source", "bars"])) return null;
  if (raw.schemaVersion !== MARKET_HISTORY_SCHEMA_VERSION || !["ready", "partial", "stale", "unavailable"].includes(String(raw.status))) return null;
  if (!(raw.asOf === null || isDate(raw.asOf))) return null;
  if (!isRecord(raw.instrument) || raw.instrument.id !== expected.id || raw.instrument.market !== expected.market || raw.instrument.slug !== expected.slug || raw.instrument.label !== expected.label) return null;
  if (!hasExactKeys(raw.instrument, ["id", "market", "slug", "label", "currency", "timezone"])) return null;
  if (!isRecord(raw.source) || !hasExactKeys(raw.source, ["provider", "url", "delayed", "note", ...(raw.source.rawSha256 === undefined ? [] : ["rawSha256"]) ])) return null;
  if (typeof raw.source.provider !== "string" || !(raw.source.url === null || typeof raw.source.url === "string") || typeof raw.source.delayed !== "boolean" || typeof raw.source.note !== "string") return null;
  if (!Array.isArray(raw.bars)) return null;
  const bars = raw.bars.map(decodeBar);
  if (bars.some((bar) => bar === null)) return null;
  const normalizedBars = bars as MarketHistoryBar[];
  for (let index = 1; index < normalizedBars.length; index += 1) {
    if (normalizedBars[index - 1].time >= normalizedBars[index].time) return null;
  }
  return {
    schemaVersion: MARKET_HISTORY_SCHEMA_VERSION,
    instrument: { id: expected.id, market: expected.market, slug: expected.slug, label: expected.label, currency: expected.currency, timezone: expected.timezone },
    status: raw.status as MarketHistoryStatus,
    asOf: raw.asOf,
    source: { provider: raw.source.provider, url: raw.source.url, delayed: raw.source.delayed, note: raw.source.note, ...(typeof raw.source.rawSha256 === "string" ? { rawSha256: raw.source.rawSha256 } : {}) },
    bars: normalizedBars,
  };
}

export function decodeMarketHistoryIndex(raw: unknown): MarketHistoryIndex | null {
  if (!isRecord(raw) || !hasExactKeys(raw, ["schemaVersion", "generatedAt", "targetYears", "minimumReadyRows", "instruments"])) return null;
  if (raw.schemaVersion !== MARKET_HISTORY_SCHEMA_VERSION || typeof raw.generatedAt !== "string" || typeof raw.targetYears !== "number" || typeof raw.minimumReadyRows !== "number" || !Array.isArray(raw.instruments)) return null;
  const instruments = raw.instruments.filter(isRecord).map((entry) => {
    const instrument = entry.instrument;
    if (!isRecord(instrument)) return null;
    if (typeof entry.path !== "string" || typeof entry.rowCount !== "number" || !(entry.firstDate === null || isDate(entry.firstDate)) || !(entry.lastDate === null || isDate(entry.lastDate))) return null;
    return { ...entry, instrument } as unknown as MarketHistoryIndexEntry;
  });
  return instruments.some((entry) => entry === null) ? null : { schemaVersion: MARKET_HISTORY_SCHEMA_VERSION, generatedAt: raw.generatedAt, targetYears: raw.targetYears, minimumReadyRows: raw.minimumReadyRows, instruments: instruments as MarketHistoryIndexEntry[] };
}
