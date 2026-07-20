import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import marketObserver from "@/content/market-observer.json";
import type { DailyBrief, MarketObserverSnapshot } from "@/lib/types";

export default function HomePage() {
  return <Dashboard data={dailyBrief as DailyBrief} marketObserver={marketObserver as MarketObserverSnapshot} view="overview" />;
}
