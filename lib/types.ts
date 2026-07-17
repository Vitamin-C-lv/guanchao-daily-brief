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
