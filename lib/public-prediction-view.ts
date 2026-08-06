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

/**
 * Single Chinese label map for every public enum that can reach page text.
 * Pages must never render raw machine enums; keep this as the one source.
 */
export const publicPredictionLabels = {
  target: {
    absolute_up: "绝对上涨",
    relative_outperformance: "跑赢基准",
    relative_outperformance_vs_hsi: "相对恒生指数跑赢",
    top_quartile: "进入前25%",
    expected_return: "预期收益",
    none: "无概率目标",
  } as Record<string, string>,
  datasetStatus: {
    ready: "数据完整",
    partial: "部分数据可用",
    insufficient: "部分数据可用",
    unavailable: "数据不可用",
  } as Record<string, string>,
  candidateStatus: {
    shadow: "研究候选",
    production: "生产模型",
  } as Record<string, string>,
  modelAvailability: {
    trained: "已训练",
    not_trained: "未训练",
    not_implemented: "未实现",
  } as Record<string, string>,
  publicationStatus: {
    published: "已发布概率",
    abstained: "模型弃权",
    insufficient_data: "样本不足",
    unavailable: "数据不可用",
    not_applicable: "不适用",
  } as Record<string, string>,
  probabilitySource: {
    raw_model: "原始模型",
    calibrated_model: "校准模型",
    historical_base_rate: "历史基准率",
    legacy_unknown: "旧版未知",
    none: "无",
  } as Record<string, string>,
  calibrationStatus: {
    enabled: "已启用",
    disabled: "已禁用",
    collapsed: "已塌缩",
    not_applicable: "不适用",
    legacy_unknown: "旧版未知",
  } as Record<string, string>,
  outputMode: {
    probability: "模型概率",
    evidence_observation: "证据观察",
    current_observation: "当前观察",
    none: "无输出",
  } as Record<string, string>,
};

export function labelOf(map: Record<string, string>, value: string | null | undefined, fallback = "未知") {
  if (value == null) return fallback;
  return map[value] ?? value;
}

export const targetLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.target, value);
export const datasetStatusLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.datasetStatus, value);
export const candidateStatusLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.candidateStatus, value);
export const modelAvailabilityLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.modelAvailability, value);
export const publicationStatusLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.publicationStatus, value);
export const probabilitySourceLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.probabilitySource, value);
export const calibrationStatusLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.calibrationStatus, value);
export const outputModeLabel = (value: string | null | undefined) => labelOf(publicPredictionLabels.outputMode, value);
