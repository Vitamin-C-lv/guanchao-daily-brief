import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import marketObserver from "@/content/market-observer.json";
import { loadGlobalMarketBriefPublic } from "@/lib/global-market-brief-public";
import { loadWeeklyIndex } from "@/lib/weekly";
import type { DailyBrief, MarketObserverSnapshot } from "@/lib/types";

const globalBrief = loadGlobalMarketBriefPublic(process.env.GUANCHAO_GLOBAL_PUBLIC_DTO_PATH);

export default function BriefsPage() {
  return <Dashboard data={dailyBrief as DailyBrief} marketObserver={marketObserver as MarketObserverSnapshot} view="briefs" weeklyIndex={loadWeeklyIndex()} globalBrief={globalBrief} />;
}
