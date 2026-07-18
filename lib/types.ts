export type Tone = "positive" | "negative" | "neutral" | "warning";

export type SourceEvidenceClass =
  | "official-primary"
  | "company-filing"
  | "primary-research"
  | "exchange-market-data"
  | "vendor-market-data"
  | "vendor-estimate"
  | "major-media";

export interface SourceLink {
  name: string;
  publisher: string;
  url: string;
  tier: "official" | "authoritative" | "major-media";
  /** 证据的生成方式；与来源质量层级 tier 分开记录，旧内容可省略。 */
  evidenceClass?: SourceEvidenceClass;
}

export interface ArticleDetailSection {
  heading: string;
  body: string;
  sourceIndexes: number[];
}

export interface ArticleChartItem {
  label: string;
  value: number;
  display: string;
  tone: Tone;
}

export interface LegacyArticleChart {
  title: string;
  unit: string;
  items: ArticleChartItem[];
  sourceIndexes: number[];
}

export interface StructuredChartBase {
  title: string;
  unit: string;
  asOf: string;
  note?: string;
  sourceIndexes: number[];
}

export interface StructuredChartSeries {
  name: string;
  tone: Tone;
  kind: "observed" | "institution-forecast";
  items: ArticleChartItem[];
}

export type StructuredChart =
  | (StructuredChartBase & {
      type: "bar";
      items: ArticleChartItem[];
    })
  | (StructuredChartBase & {
      type: "diverging-bar";
      items: ArticleChartItem[];
    })
  | (StructuredChartBase & {
      type: "line";
      series: StructuredChartSeries[];
    })
  | (StructuredChartBase & {
      type: "grouped-bar";
      series: StructuredChartSeries[];
    });

export interface GeneratedEditorialVisual {
  kind: "ai-editorial-illustration";
  src: string;
  width: 1200;
  height: 675;
  bytes: number;
  sha256: string;
  generator: "openai-image";
  generatedAt: string;
  quality?: number;
  alt: string;
  caption: string;
  basisSourceIndexes: number[];
}

export interface EvidenceForecast {
  id: string;
  asOf: string;
  dueDate: string;
  title: string;
  horizon: "1_5d" | "2_4w" | "3_12m";
  direction: "upside" | "range" | "downside" | "mixed";
  confidence: "low" | "medium" | "medium-high";
  claim: string;
  evidence: Array<{
    label: string;
    observation: string;
    sourceIndexes: number[];
  }>;
  counterEvidence: Array<{
    label: string;
    observation: string;
    sourceIndexes: number[];
  }>;
  trigger: string;
  invalidation: string;
  riskNote: string;
  review?: {
    status: "pending" | "confirmed" | "partial" | "invalidated";
    reviewedAt?: string;
    note: string;
  };
}

export type RotationStage = "early" | "accelerating" | "diverging" | "fading" | "rebound";
export type RotationBias = "strengthening" | "range" | "weakening";
export type RotationConfidence = "low" | "medium" | "medium-high";

interface RotationOutlookBase {
  horizon: "1_5d" | "2_4w";
  bias: RotationBias;
  confidence: RotationConfidence;
  flowPath: string;
  trigger: string;
  invalidation: string;
  sourceIndexes: number[];
}

export type RotationOutlook =
  | (RotationOutlookBase & {
      /** 旧版快照未写 status，按 active 兼容。 */
      status?: "active";
      candidateSectors: string[];
      reason?: string;
    })
  | (RotationOutlookBase & {
      status: "insufficient";
      candidateSectors?: string[];
      reason: string;
    });

export interface RotationAnalysis {
  asOf: string;
  window: "5d_vs_20d";
  regime: string;
  volumeStatus: "verified" | "none" | "insufficient";
  volumeLeaders: Array<{
    sector: string;
    stage: RotationStage;
    turnoverAmountRatio20d: number;
    tradingVolumeRatio20d: number;
    turnoverShareRatio20d: number;
    historySessions: number;
    /** @deprecated 旧版字段仅供历史快照兼容，新内容必须写 turnoverAmountRatio20d。 */
    turnoverRatio20d?: number;
    breadthPct: number;
    relativeReturn5d: number;
    top3ConcentrationPct: number;
    sourceIndexes: number[];
  }>;
  flowSignals: Array<{
    sector: string;
    direction: "inflow" | "outflow" | "mixed";
    evidenceClass: "official" | "vendor-market-data" | "vendor-estimate" | "proxy";
    evidence: string;
    sourceIndexes: number[];
  }>;
  outlooks: RotationOutlook[];
  riskNote: string;
}

export interface ArticleDetail {
  lead: string;
  keyPoints: string[];
  sections: ArticleDetailSection[];
  /** @deprecated 新内容优先使用 charts；保留以兼容既有日报。 */
  chart?: LegacyArticleChart;
  charts?: StructuredChart[];
  visual?: GeneratedEditorialVisual;
  /** 单对象供旧版快照兼容；新内容优先使用数组表达多个预测窗口。 */
  evidenceForecast?: EvidenceForecast | EvidenceForecast[];
  rotationAnalysis?: RotationAnalysis;
}

export interface BriefArticle {
  id: string;
  title: string;
  summary: string;
  impact: string;
  publishedAt: string;
  tags: string[];
  sources: SourceLink[];
  detail: ArticleDetail;
}

export interface MarketIndex {
  name: string;
  value: string;
  change: number;
  date: string;
}

export interface MarketSection {
  id: "a-share" | "hk" | "us";
  name: string;
  shortName: string;
  sessionDate: string;
  status: string;
  summary: string;
  leadIndex: string;
  indices: MarketIndex[];
  sparkline: number[];
  tone: Tone;
  sources: SourceLink[];
  articles: BriefArticle[];
}

export type SectorRotationMarketMode = "industry" | "major-index";
export type SectorRotationDataStatus = "ready" | "insufficient";
export type SectorRotationConfidence = "low" | "medium" | "medium-high";
export type SectorRotationObservedDirection = "leading" | "strengthening" | "neutral" | "weakening" | "lagging";
export type SectorRotationForecastDirection = "strong-up" | "up" | "range" | "down" | "strong-down";

export interface SectorRotationEvidencePoint {
  label: string;
  observation: string;
  /** Zero-based indexes into the owning market's sources array. */
  sourceIndexes: number[];
}

export interface SectorRotationObservedItem {
  sector: string;
  code?: string;
  rank: number;
  /** A cross-sectional ranking score, not a probability or promised return. */
  score: number;
  direction: SectorRotationObservedDirection;
  signal: string;
  metrics: Array<{
    label: string;
    value: string;
    tone?: Tone;
  }>;
  sourceIndexes: number[];
}

export interface SectorRotationForecastItem {
  sector: string;
  code?: string;
  rank: number;
  /** A model ranking score, not a probability or promised return. */
  score: number;
  direction: SectorRotationForecastDirection;
  confidence: SectorRotationConfidence;
  claim: string;
  evidence: SectorRotationEvidencePoint[];
  counterEvidence: SectorRotationEvidencePoint[];
  trigger: string;
  invalidation: string;
  dueDate: string;
}

export interface SectorRotationChartBase {
  title: string;
  /** Explicit display unit, for example "%", "点" or "亿元". */
  unit: string;
  /** Scope, normalization or calculation note needed to interpret the chart. */
  note: string;
  /** The last complete observation represented by the chart. */
  asOf: string;
  /** Zero-based indexes into the owning market's sources array. */
  sourceIndexes: number[];
}

export interface SectorRotationLinePoint {
  date: string;
  value: number;
}

export interface SectorRotationLineSeries {
  name: string;
  points: SectorRotationLinePoint[];
}

export interface SectorRotationCandlestickPoint {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Optional evidence charts. They are rendered only after strict runtime validation;
 * ranking bars continue to be derived directly from the horizon's ranked items.
 */
export type SectorRotationChart =
  | (SectorRotationChartBase & {
      type: "line";
      series: SectorRotationLineSeries[];
    })
  | (SectorRotationChartBase & {
      type: "candlestick";
      points: SectorRotationCandlestickPoint[];
    });

export type SectorRotationObservedHorizon =
  | {
      kind: "observed";
      status: "ready";
      asOf: string;
      note: string;
      items: SectorRotationObservedItem[];
      charts?: SectorRotationChart[];
    }
  | {
      kind: "observed";
      status: "insufficient";
      asOf: string;
      reason: string;
      items?: never;
      charts?: never;
    };

export type SectorRotationForecastHorizon =
  | {
      kind: "forecast";
      status: "ready";
      asOf: string;
      dueDate: string;
      sessions: 5 | 20;
      note: string;
      items: SectorRotationForecastItem[];
      charts?: SectorRotationChart[];
    }
  | {
      kind: "forecast";
      status: "insufficient";
      asOf: string;
      dueDate?: string;
      sessions: 5 | 20;
      reason: string;
      items?: never;
      charts?: never;
    };

export interface SectorRotationMarket {
  id: MarketSection["id"];
  label: string;
  mode: SectorRotationMarketMode;
  asOf: string;
  status: SectorRotationDataStatus;
  taxonomy: {
    owner: string;
    name: string;
    version: string;
    effectiveDate: string;
  };
  note: string;
  reason?: string;
  sources: SourceLink[];
  horizons: {
    current: SectorRotationObservedHorizon;
    oneWeek: SectorRotationForecastHorizon;
    oneMonth: SectorRotationForecastHorizon;
  };
}

export interface SectorRotationIndex {
  schemaVersion: 1;
  generatedAt: string;
  model: {
    id: string;
    version: string;
    trainedAt: string;
    trainingStart: string;
    trainingEnd: string;
    method: string;
    features: string[];
    backtest: {
      status: "passed" | "limited" | "insufficient";
      summary: string;
    };
  };
  markets: SectorRotationMarket[];
}

export interface FederalReserveSection {
  targetRange: string;
  stance: string;
  stanceTone: Tone;
  lastDecision: string;
  lastDecisionDate: string;
  nextMeeting: string;
  countdownDays: number;
  takeaway: string;
  path: Array<{ label: string; lower: number; upper: number }>;
  articles: BriefArticle[];
}

export interface Hotspot extends BriefArticle {
  priority: number;
  affectedMarkets: string[];
}

export interface DailyBrief {
  meta: {
    editionDate: string;
    generatedAt: string;
    dataThrough: string;
    title: string;
    subtitle: string;
    status: string;
    curationNote: string;
  };
  pulse: {
    score: number;
    label: string;
    explanation: string;
    signals: Array<{ label: string; value: string; tone: Tone }>;
  };
  federalReserve: FederalReserveSection;
  markets: MarketSection[];
  hotspots: Hotspot[];
  watchlist: Array<{ time: string; title: string; note: string; tone: Tone }>;
  sourceDirectory: Array<{
    name: string;
    category: string;
    description: string;
    url: string;
    tier: SourceLink["tier"];
    evidenceClass?: SourceEvidenceClass;
  }>;
  methodology: string[];
}

export type WeeklyScope = "fed" | "a-share" | "hk" | "us";
export type WeeklyConfidence = "low" | "medium" | "medium-high";

export interface WeeklyReportIndexEntry {
  id: string;
  weekStart: string;
  weekEnd: string;
  publishedAt: string;
  title: string;
  summary: string;
  revision: number;
}

export interface WeeklyReportIndex {
  schemaVersion: 1;
  latestReportId: string | null;
  reports: WeeklyReportIndexEntry[];
}

export interface WeeklyReport {
  schemaVersion: 1;
  visual?: GeneratedEditorialVisual;
  charts?: StructuredChart[];
  report: {
    id: string;
    revision: number;
    weekStart: string;
    weekEnd: string;
    generatedAt: string;
    timezone: "Asia/Shanghai";
    model: "gpt-5.6-terra";
    title: string;
    subtitle: string;
    status: "complete";
    coverage: Array<{
      scope: WeeklyScope;
      dataThrough: string;
      status: "complete" | "partial-by-schedule" | "insufficient";
      note: string;
    }>;
  };
  executiveSummary: {
    editorialScore: number;
    weekVerdict: string;
    keyTakeaways: Array<{
      id: string;
      title: string;
      summary: string;
      importance: number;
      sourceIds: string[];
    }>;
  };
  majorEvents: Array<{
    id: string;
    date: string;
    title: string;
    categories: string[];
    affectedMarkets: WeeklyScope[];
    importance: number;
    facts: Array<{ text: string; sourceIds: string[] }>;
    whyItMatters: string;
    confidence: WeeklyConfidence;
    basisSourceIds: string[];
  }>;
  highValueInsights: Array<{
    id: string;
    title: string;
    insight: string;
    evidence: Array<{ text: string; sourceIds: string[] }>;
    whyHighValue: string;
    counterEvidence: Array<{ text: string; sourceIds: string[] }>;
    watchNext: string;
    confidence: WeeklyConfidence;
    basisSourceIds: string[];
  }>;
  markets: Array<{
    id: "a-share" | "hk" | "us";
    label: string;
    sessionStart: string;
    sessionEnd: string;
    coverageStatus: "complete" | "partial-by-schedule" | "insufficient";
    summary: string;
    weeklyPerformance: string;
    rotation: string;
    capitalFlow: string;
    nextWeekScenario: string;
    trigger: string;
    invalidation: string;
    confidence: WeeklyConfidence;
    sourceIds: string[];
  }>;
  crossMarketThemes: Array<{
    id: string;
    title: string;
    thesis: string;
    causalChain: string[];
    counterEvidence: string;
    nextSignal: string;
    confidence: WeeklyConfidence;
    sourceIds: string[];
  }>;
  nextWeekCalendar: Array<{
    id: string;
    startsAt: string;
    title: string;
    markets: WeeklyScope[];
    importance: "high" | "medium";
    whyWatch: string;
    sourceIds: string[];
  }>;
  localSynthesis: {
    editionDates: string[];
    archiveSnapshots: number;
    continuities: string[];
    coverageGaps: string[];
    note: string;
  };
  sources: Array<SourceLink & { id: string; publishedAt: string; accessedAt: string }>;
  methodology: {
    selection: string;
    deduplication: string;
    sourcePolicy: string;
    limitations: string[];
  };
}

export interface UpdateNoticeItem {
  noticeId: string;
  kind: "daily" | "weekly";
  importance: number;
  publishedAt: string;
  expiresAt: string | null;
  title: string;
  summary: string;
  selectionReason: string;
  highlights: string[];
  href: string;
  ctaLabel: string;
}

export interface UpdateNotices {
  schemaVersion: 1;
  daily: UpdateNoticeItem | null;
  weekly: UpdateNoticeItem | null;
}
