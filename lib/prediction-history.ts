import predictionHistoryJson from "@/content/prediction-history.json";
import sectorRotationJson from "@/content/sector-rotation.json";
import type {
  SectorPredictionHistoryIndex,
  SectorPredictionHistoryRecord,
  SectorRotationIndex,
} from "@/lib/types";

export const predictionHistory = predictionHistoryJson as SectorPredictionHistoryIndex;
export const sectorRotation = sectorRotationJson as SectorRotationIndex;

export function predictionHistoryRecords(market: string, sectorId: string) {
  return predictionHistory.records
    .filter((item) => item.market === market && item.sector_id === sectorId)
    .sort((left, right) => right.prediction_date.localeCompare(left.prediction_date));
}

export function latestPredictionRecord(
  records: SectorPredictionHistoryRecord[],
  horizon: 1 | 5 | 20,
) {
  return records.find((item) => item.horizon === horizon);
}

export function findRotationMarket(market: string) {
  return sectorRotation.markets.find((item) => item.id === market);
}
