"use client";

import {
  Bell,
  Calendar,
  ChevronRight,
  ExternalLink,
  FileText,
  Flame,
  Globe2,
  History,
  Landmark,
  LayoutDashboard,
  Link as LinkIcon,
  Menu,
  Newspaper,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, TouchEvent } from "react";
import DesktopSidebar from "./DesktopSidebar";
import MobileBottomNav from "./MobileBottomNav";
import GlobalMainBriefCard from "./GlobalMainBriefCard";
import MarketObserver from "./MarketObserver";
import MarketObserverTeaser from "./MarketObserverTeaser";
import PredictionRankingPreview from "./PredictionRankingPreview";
import SectorRotationIndex from "./SectorRotationIndex";
import SpecialReportSection from "./SpecialReportSection";
import WeeklyTeaser from "./WeeklyTeaser";
import { isGlobalBriefCurrentOrNewer, shouldShowLegacyHomeNarrative } from "@/lib/dashboard-visibility";
import type { GlobalMarketBriefPublic } from "@/lib/global-market-brief-public";
import type { GlobalMarketBriefArchiveArticle } from "@/lib/global-market-brief-article";
import { findMarketInstrumentForIndex, marketInstrumentPath } from "@/lib/market-instruments";
import { formatMarketChange, getMarketDirection, marketDirectionClass, type MarketDirection } from "@/lib/market-direction";
import { desktopNavItems } from "@/lib/site-navigation";
import { sourceEvidenceClassLabel, sourceMetaLabel, sourceTierLabel } from "./SourceLink";
import type {
  BriefArticle,
  DailyBrief,
  MarketSection,
  MarketObserverSnapshot,
  SectorRotationIndex as SectorRotationIndexData,
  SourceLink,
  Tone,
  WeeklyReportIndex,
} from "@/lib/types";

export type DashboardView = "overview" | "fed" | "predictions" | "markets" | "briefs" | "hotspots";

const toneText: Record<Tone, string> = {
  positive: "偏积极",
  negative: "偏谨慎",
  neutral: "中性",
  warning: "需关注",
};

function formatEditionDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T00:00:00+08:00`));
}

function formatCompactDate(date: string) {
  return date.replaceAll("-", ".");
}

function formatYield(value: number | null) {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function Sparkline({ values, direction }: { values: number[]; direction: MarketDirection }) {
  const width = 280;
  const height = 92;
  const padding = 8;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
    const y = padding + ((max - value) / range) * (height - padding * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `${line} L${points.at(-1)?.[0]},${height - padding} L${points[0][0]},${height - padding} Z`;
  const color = direction === "up" ? "#df4d4d" : direction === "down" ? "#219b63" : "#8b8790";
  const gradientId = `spark-${direction}`;

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="最近十个交易日趋势">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.23" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points.at(-1)?.[0]} cy={points.at(-1)?.[1]} r="4.5" fill="#fff" stroke={color} strokeWidth="3" />
    </svg>
  );
}

function PolicyPathChart({ path }: { path: DailyBrief["federalReserve"]["path"] }) {
  const width = 680;
  const height = 230;
  const padding = { top: 18, right: 20, bottom: 42, left: 42 };
  const minY = 3.25;
  const maxY = 5.25;
  const x = (index: number) => padding.left + (index / (path.length - 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((maxY - value) / (maxY - minY)) * (height - padding.top - padding.bottom);
  const upper = path.map((item, index) => [x(index), y(item.upper)] as const);
  const lower = path.map((item, index) => [x(index), y(item.lower)] as const);
  const upperLine = upper.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const lowerLine = lower.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const area = `${upperLine} ${[...lower].reverse().map(([px, py]) => `L${px},${py}`).join(" ")} Z`;
  const ticks = [3.5, 4, 4.5, 5];

  return (
    <div className="policy-chart-wrap">
      <div className="chart-title-row">
        <div>
          <span className="eyebrow">POLICY PATH</span>
          <h3>目标利率区间路径</h3>
        </div>
        <span className="chart-unit">单位：%</span>
      </div>
      <svg className="policy-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="2024 年 9 月至 2026 年 6 月美联储目标利率区间路径">
        <defs>
          <linearGradient id="policy-area" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#ff9585" stopOpacity="0.42" />
            <stop offset="0.5" stopColor="#f2d66e" stopOpacity="0.38" />
            <stop offset="1" stopColor="#9fe7a5" stopOpacity="0.48" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} stroke="#ebe7ee" strokeDasharray="4 6" />
            <text x={padding.left - 10} y={y(tick) + 4} textAnchor="end" className="axis-label">{tick.toFixed(1)}</text>
          </g>
        ))}
        <path d={area} fill="url(#policy-area)" />
        <path d={upperLine} fill="none" stroke="#1b191d" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={lowerLine} fill="none" stroke="#8b8790" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        {path.map((item, index) => (
          <g key={item.label}>
            <circle cx={x(index)} cy={y(item.upper)} r={index === path.length - 1 ? 5 : 3.5} fill={index === path.length - 1 ? "#1b191d" : "#fff"} stroke="#1b191d" strokeWidth="2" />
            <text x={x(index)} y={height - 15} textAnchor="middle" className="axis-label">{item.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function SourceLinks({ sources, compact = false }: { sources: SourceLink[]; compact?: boolean }) {
  return (
    <div className={`source-links ${compact ? "source-links-compact" : ""}`} aria-label="引用来源">
      <span className="source-prefix"><LinkIcon size={13} /> 引用</span>
      {sources.map((source) => (
        <a key={`${source.publisher}-${source.url}`} href={source.url} target="_blank" rel="noreferrer" title={`打开原文 · ${sourceMetaLabel(source)}`}>
          {source.name}
          <ExternalLink size={12} />
        </a>
      ))}
    </div>
  );
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

function MarketCard({ market, overviewOnly = false }: { market: MarketSection; overviewOnly?: boolean }) {
  const lead = market.indices[0];
  const detailArticle = market.articles[0];
  const leadDirection = getMarketDirection(lead?.change);
  const leadInstrument = lead ? findMarketInstrumentForIndex(market.id, lead.name) : null;
  return (
    <article className={`market-card tone-${market.tone} direction-${leadDirection} ${overviewOnly ? "market-card-overview" : ""}`}>
      <div className="market-card-head">
        <div>
          <span className="market-name">{market.name}</span>
          <span className="session-date">{formatCompactDate(market.sessionDate)} · {market.status}</span>
        </div>
        <span className={`tone-badge tone-badge-${market.tone}`}>{toneText[market.tone]}</span>
      </div>
      <div className="market-lead">
        <div>
          {leadInstrument ? <Link className="market-index-link" href={marketInstrumentPath(leadInstrument)}><span className="lead-label">{lead.name}</span><strong>{lead.value}</strong></Link> : <><span className="lead-label">{lead.name}</span><strong>{lead.value}</strong></>}
          <span className={`change ${marketDirectionClass(lead?.change)}`}>
            {leadDirection === "up" ? <TrendingUp size={15} /> : leadDirection === "down" ? <TrendingDown size={15} /> : <span className="flat-change-icon">—</span>}
            {formatMarketChange(lead?.change)}
          </span>
        </div>
        {leadInstrument ? <Link className="market-sparkline-link" href={marketInstrumentPath(leadInstrument)} aria-label={`查看${lead.name}行情详情`}><Sparkline values={market.sparkline} direction={leadDirection} /></Link> : <Sparkline values={market.sparkline} direction={leadDirection} />}
      </div>
      <div className="sub-indices">
        {market.indices.slice(1).map((index) => (
          <div key={index.name}>{(() => { const instrument = findMarketInstrumentForIndex(market.id, index.name); return instrument ? <Link className="market-index-link market-index-link-secondary" href={marketInstrumentPath(instrument)}><span>{index.name}</span><strong>{index.value}</strong><em className={marketDirectionClass(index.change)}>{formatMarketChange(index.change)}</em></Link> : <><span>{index.name}</span><strong>{index.value}</strong><em className={marketDirectionClass(index.change)}>{formatMarketChange(index.change)}</em></>; })()}</div>
        ))}
      </div>
      {!overviewOnly ? <p className="market-summary">{market.summary}</p> : null}
      {!overviewOnly && detailArticle ? <Link className="market-detail-link" href={`/articles/${detailArticle.id}/`}>查看收盘详报 <ChevronRight size={14} /></Link> : null}
      <SourceLinks sources={market.sources} compact />
    </article>
  );
}

function ArticleCard({ article, label, featured = false }: { article: BriefArticle; label: string; featured?: boolean }) {
  return (
    <article className={`brief-card ${featured ? "brief-card-featured" : ""}`}>
      <div className="brief-date">
        <span>{formatCompactDate(article.publishedAt).slice(5)}</span>
        <small>{label}</small>
      </div>
      <div className="brief-content">
        <div className="brief-title-row">
          <Link className="brief-title-link" href={`/articles/${article.id}/`}>
            <h3>{article.title}</h3><ChevronRight size={17} aria-hidden="true" />
          </Link>
          <span className="source-count">{article.sources.length} 个来源</span>
        </div>
        <p>{article.summary}</p>
        <div className="impact-note">
          <Sparkles size={15} />
          <span><b>关注：</b>{article.impact}</span>
        </div>
        <div className="tag-row">
          {article.tags.map((tag) => <span key={tag}>#{tag}</span>)}
        </div>
        <Link className="article-read-link" href={`/articles/${article.id}/`}>阅读全文 <ChevronRight size={14} /></Link>
        <SourceLinks sources={article.sources} />
      </div>
    </article>
  );
}

function GlobalArchiveCard({ article, featured = false }: { article: GlobalMarketBriefArchiveArticle; featured?: boolean }) {
  const strategy = article.investmentStrategyPreview;
  return (
    <article className={`brief-card ${featured ? "brief-card-featured" : ""}`} data-canonical-archive="true" data-article-id={article.id}>
      <div className="brief-date"><span>{formatCompactDate(article.editionDate).slice(5)}</span><small>{article.kind === "global_main" ? "全球主线" : "重大专项"}</small></div>
      <div className="brief-content">
        <div className="brief-title-row"><Link className="brief-title-link" href={article.articleUrl}><h3>{article.title}</h3><ChevronRight size={17} aria-hidden="true" /></Link><span className="source-count">{article.sourceCount} 个来源</span></div>
        <p>{article.dek}</p>
        {strategy ? <div className="impact-note"><Sparkles size={15} /><span><b>本期配置：</b>{strategy.summary}</span></div> : null}
        <div className="tag-row">{article.marketTags.map((tag) => <span key={tag}>#{tag === "A_SHARE" ? "A股" : tag === "US" ? "美股" : tag === "HK" ? "港股" : "全球"}</span>)}</div>
        <Link className="article-read-link" href={article.articleUrl}>阅读全文 <ChevronRight size={14} /></Link>
      </div>
    </article>
  );
}

function HotspotCard({ item, rank }: { item: DailyBrief["hotspots"][number]; rank: number }) {
  return (
    <article className="hotspot-card">
      <div className="hotspot-rank">{String(rank + 1).padStart(2, "0")}</div>
      <div className="hotspot-body">
        <div className="hotspot-meta">
          <span>编辑优先级</span>
          <div className="priority-track"><i style={{ width: `${item.priority}%` }} /></div>
          <strong>{item.priority}</strong>
        </div>
        <Link className="hotspot-title-link" href={`/articles/${item.id}/`}>
          <h3>{item.title}</h3><ChevronRight size={17} aria-hidden="true" />
        </Link>
        <p>{item.summary}</p>
        <div className="affected-markets">
          {item.affectedMarkets.map((market) => <span key={market}>{market}</span>)}
        </div>
        <Link className="article-read-link" href={`/articles/${item.id}/`}>阅读全文 <ChevronRight size={14} /></Link>
        <SourceLinks sources={item.sources} compact />
      </div>
    </article>
  );
}

export default function Dashboard({
  data,
  view,
  weeklyIndex,
  sectorRotation,
  sectorDetailKeys,
  marketObserver,
  globalBrief,
  globalArchive = [],
}: {
  data: DailyBrief;
  view: DashboardView;
  weeklyIndex?: WeeklyReportIndex;
  sectorRotation?: SectorRotationIndexData;
  sectorDetailKeys?: string[];
  marketObserver?: MarketObserverSnapshot;
  globalBrief?: GlobalMarketBriefPublic | null;
  globalArchive?: GlobalMarketBriefArchiveArticle[];
}) {
  const [query, setQuery] = useState("");
  const [selectedMarket, setSelectedMarket] = useState("all");
  const [activeMarketCard, setActiveMarketCard] = useState(0);
  const marketGridRef = useRef<HTMLDivElement>(null);
  const marketSwipeStartRef = useRef({ x: 0, y: 0, index: 0 });
  const marketScrollTargetRef = useRef<number | null>(null);
  const marketScrollFrameRef = useRef<number | null>(null);
  const isOverview = view === "overview";
  const showFed = isOverview || view === "fed";
  const showMarkets = isOverview || view === "markets";
  const showPredictions = view === "predictions";
  const showBriefs = isOverview || view === "briefs";
  const currentGlobalBrief = isGlobalBriefCurrentOrNewer(globalBrief, data.meta.editionDate);
  const showGlobalHomeBrief = isOverview && currentGlobalBrief;
  const showLegacyHomeNarrative = !currentGlobalBrief && shouldShowLegacyHomeNarrative({ view, editionDate: data.meta.editionDate, globalBrief });
  const marketOverviewOnly = isOverview && currentGlobalBrief;
  const showLegacyBriefs = showBriefs && !(isOverview && currentGlobalBrief);
  const showHotspots = isOverview || view === "hotspots";
  const showSearch = isOverview || view === "briefs" || view === "hotspots";
  const mobileNavView = view === "fed" ? "overview" : view;

  const scrollToMarket = (index: number) => {
    const scroller = marketGridRef.current;
    const card = scroller?.children[index] as HTMLElement | undefined;
    if (!scroller || !card) return;
    const left = card.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
    if (Math.abs(card.getBoundingClientRect().left - scroller.getBoundingClientRect().left) <= 2) {
      marketScrollTargetRef.current = null;
      setActiveMarketCard(index);
      return;
    }
    marketScrollTargetRef.current = index;
    scroller.scrollTo({ left, behavior: "smooth" });
    setActiveMarketCard(index);
  };

  const handleMarketTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % data.markets.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + data.markets.length) % data.markets.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = data.markets.length - 1;
    else return;
    event.preventDefault();
    scrollToMarket(nextIndex);
    window.requestAnimationFrame(() => document.getElementById(`market-tab-${data.markets[nextIndex].id}`)?.focus());
  };

  const syncActiveMarket = () => {
    if (marketScrollFrameRef.current !== null) return;
    marketScrollFrameRef.current = window.requestAnimationFrame(() => {
      marketScrollFrameRef.current = null;
      const scroller = marketGridRef.current;
      if (!scroller) return;
      const scrollerLeft = scroller.getBoundingClientRect().left;
      const cards = Array.from(scroller.children) as HTMLElement[];
      const target = marketScrollTargetRef.current;
      if (target !== null) {
        const targetCard = cards[target];
        if (targetCard && Math.abs(targetCard.getBoundingClientRect().left - scrollerLeft) <= 2) {
          setActiveMarketCard(target);
          marketScrollTargetRef.current = null;
        }
        return;
      }
      const nearest = cards.reduce((best, card, index) => {
        const distance = Math.abs(card.getBoundingClientRect().left - scrollerLeft);
        return distance < best.distance ? { index, distance } : best;
      }, { index: 0, distance: Number.POSITIVE_INFINITY });
      setActiveMarketCard(nearest.index);
    });
  };

  const startMarketSwipe = (event: TouchEvent<HTMLDivElement>) => {
    marketScrollTargetRef.current = null;
    const scroller = marketGridRef.current;
    const scrollerLeft = scroller?.getBoundingClientRect().left ?? 0;
    const cards = scroller ? Array.from(scroller.children) as HTMLElement[] : [];
    const nearest = cards.reduce((best, card, index) => {
      const distance = Math.abs(card.getBoundingClientRect().left - scrollerLeft);
      return distance < best.distance ? { index, distance } : best;
    }, { index: activeMarketCard, distance: Number.POSITIVE_INFINITY });
    marketSwipeStartRef.current = {
      x: event.touches[0]?.clientX ?? 0,
      y: event.touches[0]?.clientY ?? 0,
      index: nearest.index,
    };
  };

  const finishMarketSwipe = (event: TouchEvent<HTMLDivElement>) => {
    const endX = event.changedTouches[0]?.clientX ?? marketSwipeStartRef.current.x;
    const endY = event.changedTouches[0]?.clientY ?? marketSwipeStartRef.current.y;
    const distanceX = endX - marketSwipeStartRef.current.x;
    const distanceY = endY - marketSwipeStartRef.current.y;
    if (Math.abs(distanceX) < 38 || Math.abs(distanceX) <= Math.abs(distanceY)) return;
    const direction = distanceX < 0 ? 1 : -1;
    const target = Math.max(0, Math.min(data.markets.length - 1, marketSwipeStartRef.current.index + direction));
    scrollToMarket(target);
  };

  useEffect(() => {
    const realignMarketCard = () => {
      const scroller = marketGridRef.current;
      const card = scroller?.children[activeMarketCard] as HTMLElement | undefined;
      if (!scroller || !card) return;
      const left = card.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
      scroller.scrollTo({ left, behavior: "auto" });
    };
    window.addEventListener("resize", realignMarketCard);
    return () => {
      window.removeEventListener("resize", realignMarketCard);
      if (marketScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(marketScrollFrameRef.current);
        marketScrollFrameRef.current = null;
      }
    };
  }, [activeMarketCard]);

  const articles = useMemo(() => {
    const combined = [
      ...data.federalReserve.articles.map((article) => ({ article, label: "美联储", market: "fed" })),
      ...data.markets.flatMap((market) => market.articles.map((article) => ({ article, label: market.shortName, market: market.id }))),
    ];
    const normalizedQuery = query.trim().toLowerCase();
    return combined
      .filter(({ article, market }) => {
        const matchesMarket = selectedMarket === "all" || selectedMarket === market;
        const sameEditionLegacy = Boolean(currentGlobalBrief && view === "briefs" && market !== "fed" && article.publishedAt === data.meta.editionDate);
        const haystack = `${article.title} ${article.summary} ${article.impact} ${article.tags.join(" ")}`.toLowerCase();
        return matchesMarket && !sameEditionLegacy && (!normalizedQuery || haystack.includes(normalizedQuery));
      })
      .sort((left, right) => right.article.publishedAt.localeCompare(left.article.publishedAt));
  }, [currentGlobalBrief, data, query, selectedMarket, view]);

  const canonicalArchive = useMemo(() => {
    const currentArticleIds = new Set(currentGlobalBrief && globalBrief ? [globalBrief.mainArticle, ...globalBrief.specialReports].map((article) => article.articleUrl.split("/").filter(Boolean).at(-1)) : []);
    const normalizedQuery = query.trim().toLowerCase();
    const marketTag = selectedMarket === "a-share" ? "A_SHARE" : selectedMarket === "hk" ? "HK" : selectedMarket === "us" ? "US" : null;
    return globalArchive
      .filter((article) => !currentArticleIds.has(article.id))
      .filter((article) => selectedMarket === "all" || (selectedMarket === "fed" ? article.marketTags.includes("US") : marketTag !== null && article.marketTags.includes(marketTag)))
      .filter((article) => !normalizedQuery || `${article.title} ${article.dek} ${article.conclusion} ${article.marketTags.join(" ")}`.toLowerCase().includes(normalizedQuery));
  }, [currentGlobalBrief, globalArchive, globalBrief, query, selectedMarket]);
  const canonicalIds = useMemo(() => new Set(globalArchive.map((article) => article.id)), [globalArchive]);
  const canonicalEditionDate = globalBrief?.mainArticle?.articleUrl?.match(/^\/articles\/global-market-brief-(\d{4}-\d{2}-\d{2})\/$/)?.[1] ?? null;
  const legacyArchive = useMemo(() => articles.filter(({ article }) => !canonicalIds.has(article.id) && (!currentGlobalBrief || !canonicalEditionDate || article.publishedAt < canonicalEditionDate)), [articles, canonicalEditionDate, canonicalIds, currentGlobalBrief]);

  const filteredHotspots = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return data.hotspots;
    return data.hotspots.filter((item) => `${item.title} ${item.summary} ${item.tags.join(" ")} ${item.affectedMarkets.join(" ")}`.toLowerCase().includes(normalizedQuery));
  }, [data.hotspots, query]);

  return (
    <>
      <div className="page-orb page-orb-one" />
      <div className="page-orb page-orb-two" />
      <DesktopSidebar />

      <main className="dashboard">
        <header className="topbar">
          <Link className="desktop-brand" href="/" aria-label="观潮首页">
            <Image src="/brand/guanchao-logo-horizontal.png" alt="观潮 Guanchao Daily Brief" width={180} height={90} priority unoptimized />
            <span className="sr-only">观潮 · 观潮每日晚报</span>
          </Link>
          <Link className="mobile-brand" href="/" aria-label="观潮首页">
            <Image src="/brand/guanchao-logo-mark.png" alt="观潮 Guanchao Daily Brief" width={40} height={40} priority unoptimized />
            <b>观潮</b>
          </Link>
          {showSearch ? (
            <label className="search-box">
              <Search size={17} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索政策、市场或热点…" aria-label="搜索简报" />
              {query ? <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">×</button> : <kbd>⌘ K</kbd>}
            </label>
          ) : <div className="route-title">{desktopNavItems.find((item) => item.view === view)?.label ?? (view === "fed" ? "美联储政策" : "")}</div>}
          <div className="topbar-actions">
            <span className="verified-pill"><i />{data.meta.status}</span>
            <button type="button" className="icon-button" onClick={() => window.location.reload()} aria-label="刷新页面"><RefreshCw size={17} /></button>
            <button type="button" className="icon-button notification-button" aria-label="通知"><Bell size={17} /><i /></button>
            <div className="avatar">AI</div>
          </div>
          <button className="mobile-menu" type="button" aria-label="打开导航"><Menu size={20} /></button>
        </header>

        <div className="dashboard-content">
          {showGlobalHomeBrief && globalBrief ? (
            <section className="global-home-section" aria-labelledby="global-home-title">
              <SectionHeading eyebrow="TODAY&apos;S GLOBAL JUDGMENT" title="今日全球判断" description="先看跨市场主线，再回到各市场的独立数据与历史简报。" />
              <GlobalMainBriefCard brief={globalBrief.mainArticle} />
              <SpecialReportSection reports={globalBrief.specialReports} />
            </section>
          ) : null}

          {showFed ? (
          <section className={`hero-grid ${isOverview ? "" : "focused-view"} ${showLegacyHomeNarrative ? "" : "global-integrated-grid"}`} id={isOverview ? "overview" : undefined}>
            {showLegacyHomeNarrative && isOverview ? (
            <article className="hero-card">
              <div className="hero-orbit" aria-hidden="true"><span /><span /></div>
              <div className="hero-copy">
                <div className="hero-kicker"><Sparkles size={15} /> AI 每日精选 · {formatEditionDate(data.meta.editionDate)}</div>
                <h1>{data.meta.title}<br /><span>{data.meta.subtitle}</span></h1>
                <p>{data.meta.curationNote}</p>
              </div>
              <div className="pulse-panel">
                <div className="pulse-score">
                  <strong>{data.pulse.score}</strong><span>/ 100</span>
                  <small>{data.pulse.label}</small>
                </div>
                <div className="pulse-meter" aria-label={`风险信号 ${data.pulse.score} 分`}>
                  <div className="pulse-gradient" />
                  <i style={{ left: `${data.pulse.score}%` }} />
                </div>
                <p>{data.pulse.explanation}</p>
              </div>
              <div className="signal-strip">
                {data.pulse.signals.map((signal) => (
                  <div key={signal.label}>
                    <span>{signal.label}</span>
                    <strong className={`text-${signal.tone}`}>{signal.value}</strong>
                  </div>
                ))}
              </div>
            </article>
            ) : null}

            <article className="fed-summary-card" id="fed">
              <div className="card-topline">
                <span className="icon-tile"><Landmark size={18} /></span>
                <div><span className="eyebrow">FEDERAL RESERVE</span><h2>美联储政策</h2></div>
                <span className={`tone-badge tone-badge-${data.federalReserve.stanceTone}`}>{data.federalReserve.stance}</span>
              </div>
              <div className="rate-display">
                <span>联邦基金目标利率</span>
                <strong>{data.federalReserve.targetRange}</strong>
                <small>截至 {formatCompactDate(data.federalReserve.lastDecisionDate)}</small>
              </div>
              <div className="decision-row">
                <div><span>最近决议</span><b>{data.federalReserve.lastDecision}</b></div>
                <div><span>表决</span><b>{data.federalReserve.vote}</b></div>
                <div><span>异议</span><b>{data.federalReserve.dissents.join("；") || "无"}</b></div>
                <div><span>下次会议</span><b>{data.federalReserve.nextMeeting}（{formatCompactDate(data.federalReserve.nextMeetingStartDate)}–{formatCompactDate(data.federalReserve.nextMeetingEndDate)}）</b></div>
              </div>
              <div className="countdown-box">
                <Calendar size={18} />
                <span>距下次 FOMC 会议</span>
                <strong>{data.federalReserve.countdownDays}</strong>
                <small>天</small>
              </div>
              <div className="fed-yield-strip">
                <div><span>美债 2Y</span><b>{formatYield(data.federalReserve.treasury2Y)}</b></div>
                <div><span>美债 10Y</span><b>{formatYield(data.federalReserve.treasury10Y)}</b></div>
                <div><span>实际 10Y</span><b>{formatYield(data.federalReserve.real10Y)}</b></div>
                <small>收益率数据截至 {formatCompactDate(data.federalReserve.yieldDataThrough)}</small>
              </div>
              <p className="fed-takeaway">{data.federalReserve.takeaway}</p>
              <SourceLinks sources={data.federalReserve.articles[0].sources} compact />
            </article>
          </section>
          ) : null}

          {isOverview && marketObserver ? <MarketObserverTeaser data={marketObserver} /> : null}

          {showFed ? (
          <section className="policy-card">
            <PolicyPathChart path={data.federalReserve.path} />
            <div className="policy-side">
              <span className="eyebrow">AI TAKEAWAY</span>
              <h2>今天怎样理解政策信号</h2>
              <div className="policy-points">
                {data.federalReserve.articles.map((article, index) => (
                  <div key={article.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong><Link href={`/articles/${article.id}/`}>{article.title}</Link></strong><p>{article.impact}</p></div>
                  </div>
                ))}
              </div>
              <a className="primary-link" href={data.federalReserve.articles[0].sources[0].url} target="_blank" rel="noreferrer">查看美联储原文 <ExternalLink size={14} /></a>
            </div>
          </section>
          ) : null}

          {showMarkets ? (
          <section id="markets" className={`section-block ${isOverview ? "" : "route-section"}`}>
            <SectionHeading eyebrow={marketOverviewOnly ? "MARKET DATA OVERVIEW" : "THREE MARKETS"} title={marketOverviewOnly ? "市场数据概览" : "三地股市简报"} description={marketOverviewOnly ? "保留指数、涨跌、成交与数据时间，作为全球主文章的次级数据概览。" : "每个市场使用各自最新完整交易日，避免盘中与收盘数据混用。"} action={<span className="updated-label"><RefreshCw size={13} /> 数据截至 {formatCompactDate(data.meta.dataThrough)}</span>} />
            {view === "markets" ? <PredictionRankingPreview data={sectorRotation} /> : null}
            <div className="market-mobile-tabs" role="tablist" aria-label="切换市场卡片">
              {data.markets.map((market, index) => (
                <button key={market.id} id={`market-tab-${market.id}`} type="button" role="tab" aria-controls="market-carousel" aria-selected={activeMarketCard === index} tabIndex={activeMarketCard === index ? 0 : -1} className={activeMarketCard === index ? "active" : ""} onClick={() => scrollToMarket(index)} onKeyDown={(event) => handleMarketTabKeyDown(event, index)}>{market.shortName}</button>
              ))}
            </div>
            <div
              className="market-grid"
              id="market-carousel"
              ref={marketGridRef}
              onScroll={syncActiveMarket}
              onTouchStart={startMarketSwipe}
              onTouchEnd={finishMarketSwipe}
            >
              {data.markets.map((market) => <MarketCard key={market.id} market={market} overviewOnly={marketOverviewOnly} />)}
            </div>
          </section>
          ) : null}

          {showPredictions ? (
          <section id="predictions" className="section-block route-section prediction-route">
            <SectionHeading eyebrow="FORECAST / OBSERVATION" title="板块预测与观察榜" description="模型通过时显示概率；模型弃权时显示证据观察分，不把观察分当作概率。" action={<div className="prediction-heading-actions"><Link className="prediction-history-link" href="/predictions/history"><History size={14} />查看历史预测</Link><span className="updated-label"><RefreshCw size={13} /> 数据截至 {formatCompactDate(data.meta.dataThrough)}</span></div>} />
            <div className="prediction-market-tabs" role="tablist" aria-label="切换预测市场">
              {data.markets.map((market, index) => (
                <button key={market.id} type="button" role="tab" aria-selected={activeMarketCard === index} className={activeMarketCard === index ? "active" : ""} onClick={() => setActiveMarketCard(index)}>{market.shortName}</button>
              ))}
            </div>
            <SectorRotationIndex
              data={sectorRotation}
              activeMarketId={data.markets[activeMarketCard]?.id ?? "a-share"}
              detailKeys={sectorDetailKeys}
              availableHorizons={["tomorrow", "oneWeek", "oneMonth"]}
              initialHorizon="tomorrow"
            />
            <MarketObserver data={marketObserver} mode="prediction-support" />
          </section>
          ) : null}

          {showLegacyBriefs || showHotspots ? (
          <div className={`content-grid ${isOverview ? "" : "single-panel"}`}>
            {showLegacyBriefs ? (
            <section id="briefs" className="briefs-panel">
              {globalBrief && currentGlobalBrief && view === "briefs" ? <SectionHeading eyebrow="WEEKLY JUDGMENT" title="每周判断" description="先看今日全球判断，再按需回查历史市场简报。" /> : <SectionHeading eyebrow="CURATED BRIEFS" title="今日精选简报" description="只保留会改变政策预期、风险偏好或行业定价的信息。" />}
              {weeklyIndex ? <WeeklyTeaser index={weeklyIndex} /> : null}
              {globalBrief && currentGlobalBrief && view === "briefs" ? (
                <>
                  <GlobalMainBriefCard brief={globalBrief.mainArticle} />
                  <SpecialReportSection reports={globalBrief.specialReports} />
                  <div className="global-history-heading">
                    <SectionHeading eyebrow="ARCHIVE" title="其他历史文章" description="市场标签保留为次级筛选信息。" />
                  </div>
                </>
              ) : null}
              {view === "briefs" ? <MarketObserver data={marketObserver} mode="daily-macro" /> : null}
              <div className="filter-row" role="tablist" aria-label={globalBrief && currentGlobalBrief && view === "briefs" ? "历史简报市场筛选" : "简报市场筛选"}>
                {[
                  ["all", "全部"],
                  ["fed", "美联储"],
                  ["a-share", "A股"],
                  ["hk", "港股"],
                  ["us", "美股"],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={selectedMarket === value ? "active" : ""} onClick={() => setSelectedMarket(value)} role="tab" aria-selected={selectedMarket === value}>{label}</button>
                ))}
              </div>
              <div className="brief-list">
                {canonicalArchive.length || legacyArchive.length ? <>
                  {canonicalArchive.map((article, index) => <GlobalArchiveCard key={`canonical-${article.id}`} article={article} featured={index === 0} />)}
                  {legacyArchive.map(({ article, label }, index) => <ArticleCard key={`legacy-${article.id}`} article={article} label={label} featured={canonicalArchive.length === 0 && index === 0} />)}
                </> : <div className="empty-state"><Search size={22} /><strong>没有找到相关简报</strong><p>换一个关键词或清除筛选条件。</p></div>}
              </div>
            </section>
            ) : null}

            {showHotspots ? (
            <aside className="right-rail">
              <section id="hotspots" className="hotspots-panel">
                <SectionHeading eyebrow="HOT TOPICS" title="近期热点" description="按对三地市场的潜在影响排序。" />
                <div className="hotspot-list">
                  {filteredHotspots.length ? filteredHotspots.map((item, index) => <HotspotCard key={item.id} item={item} rank={index} />) : <div className="empty-state compact"><Search size={20} /><strong>未找到相关热点</strong></div>}
                </div>
              </section>

              <section className="watchlist-panel">
                <div className="panel-title"><Calendar size={18} /><div><span className="eyebrow">WATCHLIST</span><h2>后续观察</h2></div></div>
                <div className="watchlist">
                  {data.watchlist.map((item) => (
                    <div key={`${item.time}-${item.title}`}>
                      <time>{item.time}</time>
                      <span className={`watch-dot tone-${item.tone}`} />
                      <div><strong>{item.title}</strong><p>{item.note}</p></div>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
            ) : null}
          </div>
          ) : null}

          {isOverview ? (
          <section id="sources" className="sources-panel">
            <SectionHeading eyebrow="SOURCE LIBRARY" title="可信信息源" description="每日自动化从这里开始检索；重要结论仍需回到原始公告或官方文件。" action={<span className="source-standard"><ShieldCheck size={14} /> 可追溯引用</span>} />
            <div className="source-directory">
              {data.sourceDirectory.map((source) => (
                <a href={source.url} key={source.name} target="_blank" rel="noreferrer">
                  <span className={`source-tier tier-${source.tier}`}>{sourceTierLabel(source.tier)}</span>
                  <div><strong>{source.name}</strong><small>{[source.category, sourceEvidenceClassLabel(source.evidenceClass)].filter(Boolean).join(" · ")}</small><p>{source.description}</p></div>
                  <ExternalLink size={15} />
                </a>
              ))}
            </div>
            <div className="methodology-box">
              <div className="methodology-title"><ShieldCheck size={19} /><div><strong>编辑与引用原则</strong><span>Automation guardrails</span></div></div>
              <ol>{data.methodology.map((rule) => <li key={rule}>{rule}</li>)}</ol>
            </div>
          </section>
          ) : null}

          <footer>
            <div><span className="footer-mark"><Sparkles size={15} /></span><strong>观潮</strong><span>个人市场信息工作台</span></div>
            <p>本页面仅作信息整理，不构成投资建议。所有摘要请以引用原文为准。</p>
            <span>Edition {data.meta.editionDate}</span>
          </footer>
        </div>
      </main>

      <MobileBottomNav active={mobileNavView} />
    </>
  );
}
