/**
 * PublicPredictionView v1 types and runtime guards.
 * public/data/predictions/current.json is the only public authoritative input
 * for the /predictions page.
 */

export type PublicPredictionMarketId = "a-share" | "hk" | "us" | string;
export type PublicPredictionStatus = "published" | "abstained" | "insufficient_data" | "unavailable" | "not_applicable";
export type PublicPredictionOutputMode = "probability" | "evidence_observation" | "current_observation" | "none";
export type PublicPredictionSource = "raw_model" | "calibrated_model" | "historical_base_rate" | "legacy_unknown" | "none";
export type PublicPredictionCalibration = "enabled" | "disabled" | "collapsed" | "not_applicable" | "legacy_unknown";

export interface PublicPredictionObservationItem {
  rank: number;
  sector: string;
  code?: string;
  score: number;
  signal: string;
  direction?: string;
}

export interface PublicPredictionHorizon {
  horizonSessions: 1 | 5 | 20;
  label: string;
  target: string;
  modelVersion: string | null;
  publicationStatus: PublicPredictionStatus;
  outputMode: PublicPredictionOutputMode;
  probabilitySource: PublicPredictionSource;
  calibrationStatus: PublicPredictionCalibration;
  probability: number | null;
  expectedReturn: number | null;
  evidenceScore: number | null;
  claim: string;
  statusReason: string;
  asOf: string | null;
  dueDate: string | null;
  historyUrl: string;
  observationItems?: PublicPredictionObservationItem[];
}

export interface PublicPredictionObject {
  objectId: string;
  label: string;
  objectType: string;
  benchmarkLabel: string;
  modelAvailability: "trained" | "not_trained" | "not_implemented";
  candidateStatus: string;
  horizons: PublicPredictionHorizon[];
}

export interface PublicPredictionMarket {
  marketId: PublicPredictionMarketId;
  label: string;
  datasetStatus: string;
  dataAsOf: string;
  datasetId: string | null;
  sourceStatus: Record<string, { status: string; reason?: string }>;
  objects: PublicPredictionObject[];
}

export interface PublicPredictionView {
  schemaVersion: "public-prediction-view-v1";
  contractVersion: "public-prediction-view-v1";
  generatedAt: string;
  asOf: string;
  historyUrl: string;
  latestReview: { isoWeek: string; path: string; sha256: string } | null;
  markets: PublicPredictionMarket[];
}

export function isPublicPredictionView(value: unknown): value is PublicPredictionView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "public-prediction-view-v1" || candidate.contractVersion !== "public-prediction-view-v1") return false;
  if (typeof candidate.generatedAt !== "string" || typeof candidate.asOf !== "string" || typeof candidate.historyUrl !== "string") return false;
  if (!Array.isArray(candidate.markets) || candidate.markets.length < 3) return false;
  return candidate.markets.every((market) => {
    if (typeof market !== "object" || market === null) return false;
    const item = market as Record<string, unknown>;
    return typeof item.marketId === "string"
      && typeof item.label === "string"
      && typeof item.dataAsOf === "string"
      && Array.isArray(item.objects)
      && item.objects.every((object) => {
        if (typeof object !== "object" || object === null) return false;
        const entry = object as Record<string, unknown>;
        return typeof entry.objectId === "string"
          && typeof entry.label === "string"
          && ["trained", "not_trained", "not_implemented"].includes(String(entry.modelAvailability))
          && Array.isArray(entry.horizons)
          && entry.horizons.every((horizon) => {
            if (typeof horizon !== "object" || horizon === null) return false;
            const itemHorizon = horizon as Record<string, unknown>;
            return [1, 5, 20].includes(Number(itemHorizon.horizonSessions))
              && typeof itemHorizon.publicationStatus === "string"
              && typeof itemHorizon.outputMode === "string"
              && typeof itemHorizon.statusReason === "string"
              && (itemHorizon.publicationStatus === "published"
                ? itemHorizon.outputMode === "probability"
                  && (itemHorizon.probability === null || typeof itemHorizon.probability === "number")
                : itemHorizon.probability === null);
          });
      });
  });
}

export function probabilityOf(horizon: PublicPredictionHorizon): number | null {
  if (horizon.publicationStatus !== "published" || horizon.outputMode !== "probability") return null;
  if (horizon.probabilitySource !== "raw_model" && horizon.probabilitySource !== "calibrated_model") return null;
  return horizon.probability;
}

export function marketOf(view: PublicPredictionView, marketId: string): PublicPredictionMarket | null {
  return view.markets.find((market) => market.marketId === marketId) ?? null;
}
