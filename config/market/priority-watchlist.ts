export interface PriorityWatchItem {
  id: string;
  nameZh: string;
  nameEn: string;
  market: "A_SHARE" | "HK" | "US" | "GLOBAL";
  category: "index" | "sector" | "theme" | "fund_flow" | "macro";
  priority: 1 | 2 | 3;
  updateFrequency: "intraday" | "daily" | "event_driven" | "weekly";
  enabled: boolean;
  relatedSymbols?: string[];
  relatedEtfPools?: string[];
  relatedMacroSeries?: string[];
}

export const PRIORITY_WATCHLIST: PriorityWatchItem[] = [
  {
    id: "hk_hstech",
    nameZh: "恒生科技",
    nameEn: "Hang Seng TECH",
    market: "HK",
    category: "index",
    priority: 1,
    updateFrequency: "daily",
    enabled: true,
    relatedSymbols: ["HSTECH"],
    relatedEtfPools: ["hk_hstech_etf"],
    relatedMacroSeries: ["US2Y", "USD_CNY", "HIBOR_1M"],
  },
  {
    id: "hk_internet_ai",
    nameZh: "港股互联网与AI巨头",
    nameEn: "Hong Kong Internet and AI Leaders",
    market: "HK",
    category: "theme",
    priority: 1,
    updateFrequency: "event_driven",
    enabled: true,
    relatedEtfPools: ["hk_internet", "hk_hstech_etf"],
    relatedMacroSeries: ["US2Y", "USD_CNY", "HIBOR_1M"],
  },
  {
    id: "a_defense",
    nameZh: "A股军工",
    nameEn: "A-share Defense",
    market: "A_SHARE",
    category: "sector",
    priority: 1,
    updateFrequency: "daily",
    enabled: true,
    relatedSymbols: ["399967"],
    relatedEtfPools: ["a_defense"],
  },
  {
    id: "a_healthcare",
    nameZh: "A股医疗",
    nameEn: "A-share Healthcare",
    market: "A_SHARE",
    category: "sector",
    priority: 1,
    updateFrequency: "daily",
    enabled: true,
    relatedSymbols: ["000991"],
    relatedEtfPools: ["a_healthcare"],
  },
  {
    id: "a_semiconductor",
    nameZh: "A股半导体",
    nameEn: "A-share Semiconductors",
    market: "A_SHARE",
    category: "theme",
    priority: 1,
    updateFrequency: "daily",
    enabled: true,
    relatedSymbols: ["000993"],
    relatedEtfPools: ["a_semiconductor"],
    relatedMacroSeries: ["US2Y", "NASDAQ", "SOX"],
  },
  {
    id: "a_ai_internet",
    nameZh: "A股AI与互联网",
    nameEn: "A-share AI and Internet",
    market: "A_SHARE",
    category: "theme",
    priority: 1,
    updateFrequency: "daily",
    enabled: true,
    relatedSymbols: ["399970", "000994"],
    relatedEtfPools: ["a_ai_internet"],
    relatedMacroSeries: ["US2Y", "NASDAQ"],
  },
  {
    id: "southbound_flow",
    nameZh: "南向资金",
    nameEn: "Southbound Flow",
    market: "HK",
    category: "fund_flow",
    priority: 1,
    updateFrequency: "daily",
    enabled: true,
  },
  {
    id: "global_macro",
    nameZh: "全球宏观主链",
    nameEn: "Global Macro Chain",
    market: "GLOBAL",
    category: "macro",
    priority: 2,
    updateFrequency: "event_driven",
    enabled: true,
    relatedMacroSeries: ["BRENT", "CORE_CPI", "US2Y", "USD_CNY", "NASDAQ"],
  },
];
