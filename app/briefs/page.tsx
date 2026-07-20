import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import marketObserver from "@/content/market-observer.json";
import { loadWeeklyIndex } from "@/lib/weekly";
import type { DailyBrief, MarketObserverSnapshot } from "@/lib/types";

export default function BriefsPage() {
  return <Dashboard data={dailyBrief as DailyBrief} marketObserver={marketObserver as MarketObserverSnapshot} view="briefs" weeklyIndex={loadWeeklyIndex()} />;
}
