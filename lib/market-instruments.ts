export type MarketGroup = "a-share" | "hk" | "us";

export interface MarketInstrument {
  id: string;
  market: MarketGroup;
  slug: string;
  label: string;
  shortLabel: string;
  aliases: readonly string[];
  providerSymbol: string | null;
  currency: string;
  timezone: string;
}

export const MARKET_INSTRUMENTS = [
  { id: "sse-composite", market: "a-share", slug: "sse-composite", label: "上证指数", shortLabel: "上证", aliases: ["上证指数", "上证综指"], providerSymbol: "000001", currency: "点", timezone: "Asia/Shanghai" },
  { id: "szse-component", market: "a-share", slug: "szse-component", label: "深证成指", shortLabel: "深成", aliases: ["深证成指"], providerSymbol: "399001", currency: "点", timezone: "Asia/Shanghai" },
  { id: "chinext", market: "a-share", slug: "chinext", label: "创业板指", shortLabel: "创业板", aliases: ["创业板指"], providerSymbol: "399006", currency: "点", timezone: "Asia/Shanghai" },
  { id: "hang-seng", market: "hk", slug: "hang-seng", label: "恒生指数", shortLabel: "恒指", aliases: ["恒生指数"], providerSymbol: "^HSI", currency: "点", timezone: "Asia/Hong_Kong" },
  { id: "hang-seng-china-enterprises", market: "hk", slug: "hang-seng-china-enterprises", label: "国企指数", shortLabel: "国企", aliases: ["国企指数", "恒生中国企业指数", "HSCEI"], providerSymbol: "^HSCE", currency: "点", timezone: "Asia/Hong_Kong" },
  { id: "hang-seng-tech", market: "hk", slug: "hang-seng-tech", label: "恒生科技", shortLabel: "恒科", aliases: ["恒生科技", "恒生科技指数"], providerSymbol: "HSTECH.HK", currency: "点", timezone: "Asia/Hong_Kong" },
  { id: "dow-jones", market: "us", slug: "dow-jones", label: "道琼斯", shortLabel: "道指", aliases: ["道琼斯", "道琼斯工业指数"], providerSymbol: "^DJI", currency: "点", timezone: "America/New_York" },
  { id: "nasdaq-composite", market: "us", slug: "nasdaq-composite", label: "纳斯达克综合", shortLabel: "纳指", aliases: ["纳斯达克", "纳斯达克综合"], providerSymbol: "^IXIC", currency: "点", timezone: "America/New_York" },
  { id: "sp500", market: "us", slug: "sp500", label: "标普500", shortLabel: "标普500", aliases: ["标普500", "标普 500"], providerSymbol: "^GSPC", currency: "点", timezone: "America/New_York" },
] as const satisfies readonly MarketInstrument[];

export const MARKET_CORE_INSTRUMENT_IDS: Record<MarketGroup, readonly string[]> = {
  "a-share": ["sse-composite", "szse-component", "chinext"],
  hk: ["hang-seng", "hang-seng-china-enterprises", "hang-seng-tech"],
  us: ["dow-jones", "nasdaq-composite", "sp500"],
};

export function findMarketInstrument(id: string) {
  return MARKET_INSTRUMENTS.find((instrument) => instrument.id === id) ?? null;
}

export function coreMarketInstruments(market: MarketGroup) {
  return MARKET_CORE_INSTRUMENT_IDS[market].map((id) => findMarketInstrument(id)).filter((instrument): instrument is (typeof MARKET_INSTRUMENTS)[number] => instrument !== null);
}

export function findMarketInstrumentForIndex(market: MarketGroup, name: string) {
  return MARKET_INSTRUMENTS.find((instrument) => instrument.market === market && instrument.aliases.some((alias) => alias === name)) ?? null;
}

export function marketInstrumentPath(instrument: Pick<MarketInstrument, "market" | "slug">) {
  return `/markets/${instrument.market}/${instrument.slug}`;
}
