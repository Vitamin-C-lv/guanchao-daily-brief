import Dashboard from "@/components/Dashboard";
import dailyBrief from "@/content/daily-brief.json";
import marketObserver from "@/content/market-observer.json";
import sectorRotation from "@/content/sector-rotation.json";
import { collectSectorDetailKeys } from "@/lib/sector-details";
import type { DailyBrief, MarketObserverSnapshot, SectorRotationIndex } from "@/lib/types";

export default function PredictionsPage() {
  return (
    <Dashboard
      data={dailyBrief as DailyBrief}
      sectorRotation={sectorRotation as SectorRotationIndex}
      sectorDetailKeys={collectSectorDetailKeys()}
      marketObserver={marketObserver as MarketObserverSnapshot}
      view="predictions"
    />
  );
}
