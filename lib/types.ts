export type Tone = "positive" | "negative" | "neutral" | "warning";

export interface SourceLink {
  name: string;
  publisher: string;
  url: string;
  tier: "official" | "authoritative" | "major-media";
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

export type RotationStage = "early" | "accelerating" | "diverging" | "fading" | "rebound";
export type RotationBias = "strengthening" | "range" | "weakening";
export type RotationConfidence = "low" | "medium" | "medium-high";

export interface RotationAnalysis {
  asOf: string;
  window: "5d_vs_20d";
  regime: string;
  volumeStatus: "verified" | "none" | "insufficient";
  volumeLeaders: Array<{
    sector: string;
    stage: RotationStage;
    turnoverRatio20d: number;
    turnoverShareRatio20d: number;
    breadthPct: number;
    relativeReturn5d: number;
    top3ConcentrationPct: number;
    sourceIndexes: number[];
  }>;
  flowSignals: Array<{
    sector: string;
    direction: "inflow" | "outflow" | "mixed";
    evidenceClass: "official" | "vendor-estimate" | "proxy";
    evidence: string;
    sourceIndexes: number[];
  }>;
  outlooks: Array<{
    horizon: "1_5d" | "2_4w";
    candidateSectors: string[];
    bias: RotationBias;
    confidence: RotationConfidence;
    flowPath: string;
    trigger: string;
    invalidation: string;
    sourceIndexes: number[];
  }>;
  riskNote: string;
}

export interface ArticleDetail {
  lead: string;
  keyPoints: string[];
  sections: ArticleDetailSection[];
  chart?: {
    title: string;
    unit: string;
    items: ArticleChartItem[];
    sourceIndexes: number[];
  };
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
