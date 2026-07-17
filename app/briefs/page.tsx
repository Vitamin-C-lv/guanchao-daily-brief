import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import { loadWeeklyIndex } from "@/lib/weekly";
import type { DailyBrief } from "@/lib/types";

export default function BriefsPage() {
  return <Dashboard data={dailyBrief as DailyBrief} view="briefs" weeklyIndex={loadWeeklyIndex()} />;
}
