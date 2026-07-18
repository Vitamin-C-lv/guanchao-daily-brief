import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import sectorRotation from "@/content/sector-rotation.json";
import type { DailyBrief, SectorRotationIndex } from "@/lib/types";

export default function MarketsPage() {
  return (
    <Dashboard
      data={dailyBrief as DailyBrief}
      sectorRotation={sectorRotation as SectorRotationIndex}
      view="markets"
    />
  );
}
