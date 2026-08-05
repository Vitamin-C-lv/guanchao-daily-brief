import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import marketObserver from "@/content/market-observer.json";
import { loadGlobalMarketBriefPublic } from "@/lib/global-market-brief-public";
import type { DailyBrief, MarketObserverSnapshot } from "@/lib/types";

const globalBrief = loadGlobalMarketBriefPublic(process.env.GUANCHAO_GLOBAL_PUBLIC_DTO_PATH);

export default function HomePage() {
  return <Dashboard data={dailyBrief as DailyBrief} marketObserver={marketObserver as MarketObserverSnapshot} view="overview" globalBrief={globalBrief} />;
}
