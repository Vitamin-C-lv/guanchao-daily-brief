export type EtfFlowMethod = "shares_times_nav" | "aum_return_adjusted" | "unavailable";

export interface EtfPoolConstituent {
  symbol: string;
  name: string;
  market: "CN" | "HK";
  identityStatus: "verified" | "verify-before-use";
}

export interface EtfPoolConfig {
  id: string;
  label: string;
  themeIds: string[];
  constituents: EtfPoolConstituent[];
  preferredFlowMethod: EtfFlowMethod;
}

export const ETF_POOLS: EtfPoolConfig[] = [
  { id: "a_broad_large", label: "A股大盘宽基", themeIds: [], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "510300", name: "沪深300ETF", market: "CN", identityStatus: "verify-before-use" },
    { symbol: "510050", name: "上证50ETF", market: "CN", identityStatus: "verify-before-use" },
  ] },
  { id: "a_defense", label: "军工ETF池", themeIds: ["a_defense"], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "512660", name: "军工ETF", market: "CN", identityStatus: "verify-before-use" },
  ] },
  { id: "a_healthcare", label: "医疗ETF池", themeIds: ["a_healthcare"], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "512170", name: "医疗ETF", market: "CN", identityStatus: "verify-before-use" },
  ] },
  { id: "a_semiconductor", label: "半导体ETF池", themeIds: ["a_semiconductor"], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "512480", name: "半导体ETF", market: "CN", identityStatus: "verify-before-use" },
  ] },
  { id: "a_ai_internet", label: "AI互联网ETF池", themeIds: ["a_ai_internet"], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "159819", name: "人工智能ETF", market: "CN", identityStatus: "verify-before-use" },
    { symbol: "513330", name: "恒生互联网ETF", market: "CN", identityStatus: "verify-before-use" },
  ] },
  { id: "hk_hstech_etf", label: "恒生科技ETF池", themeIds: ["hk_hstech", "hk_internet_ai"], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "3032", name: "恒生科技ETF", market: "HK", identityStatus: "verify-before-use" },
  ] },
  { id: "hk_internet", label: "港股互联网ETF池", themeIds: ["hk_internet_ai"], preferredFlowMethod: "shares_times_nav", constituents: [
    { symbol: "513330", name: "恒生互联网ETF", market: "CN", identityStatus: "verify-before-use" },
  ] },
];
