import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import type { DailyBrief } from "@/lib/types";

export default function MarketsPage() {
  return <Dashboard data={dailyBrief as DailyBrief} view="markets" />;
}
