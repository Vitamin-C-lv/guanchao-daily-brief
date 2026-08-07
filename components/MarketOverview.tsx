"use client";

import { Activity, CalendarDays, ChevronRight, Database, ExternalLink, RefreshCw, ShieldCheck, TrendingDown, TrendingUp } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useMemo, useState } from "react";
import PredictionRankingPreview from "./PredictionRankingPreview";
import DesktopSidebar from "./DesktopSidebar";
import MobileBottomNav from "./MobileBottomNav";
import { formatMarketChange, getMarketDirection, marketDirectionClass, type MarketDirection } from "@/lib/market-direction";
import { coreMarketInstruments, marketInstrumentPath, type MarketGroup } from "@/lib/market-instruments";
import type { MarketOverviewSnapshot } from "@/lib/market-overview";
import type { DailyBrief, MarketSection, SectorRotationIndex } from "@/lib/types";

const MARKET_ORDER: readonly MarketGroup[] = ["a-share", "hk", "us"];

const MARKET_LABELS: Record<MarketGroup, string> = {
  "a-share": "A股",
  hk: "港股",
  us: "美股",
};

const MARKET_DESCRIPTIONS: Record<MarketGroup, string> = {
  "a-share": "沪深主要指数与创业板的收盘状态",
  hk: "恒生、国企与科技指数的收盘状态",
  us: "道指、纳指与标普500的收盘状态",
};

function formatDate(value: string | null) {
  return value ? value.replaceAll("-", ".") : "—";
}

function formatClose(value: number | null, fallback: string | null) {
  if (value !== null && Number.isFinite(value)) return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return fallback ?? "—";
}

function statusLabel(status: MarketOverviewSnapshot["status"] | null) {
  if (status === "ready") return "可用";
  if (status === "partial") return "部分数据";
  if (status === "stale") return "历史数据";
  return "来源不可用";
}

function statusClass(status: MarketOverviewSnapshot["status"] | null) {
  return status === "ready" ? "ready" : status === "partial" || status === "stale" ? "partial" : "unavailable";
}

function MiniTrend({ values, direction }: { values: number[]; direction: MarketDirection }) {
  if (values.length < 2) return <span className={`market-mini-trend ${direction}`} aria-label="趋势数据不足" />;
  const width = 112;
  const height = 34;
  const padding = 3;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = Math.max(max - min, 0.0001);
  const points = values.map((value, index) => {
    const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
    const y = padding + ((max - value) / span) * (height - padding * 2);
    return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return <svg className={`market-mini-trend ${direction}`} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="最近交易日趋势"><path d={points} /></svg>;
}

function SourceList({ market }: { market: MarketSection }) {
  return (
    <div className="market-overview-sources" aria-label="市场数据来源">
      <span><ShieldCheck size={13} />来源与边界</span>
      {market.sources.slice(0, 3).map((source) => <a key={`${source.name}-${source.url}`} href={source.url} target="_blank" rel="noreferrer">{source.name}<ExternalLink size={11} /></a>)}
    </div>
  );
}

function MarketCoreCard({
  market,
  instrument,
  index,
  snapshot,
}: {
  market: MarketGroup;
  instrument: ReturnType<typeof coreMarketInstruments>[number];
  index: MarketSection["indices"][number] | null;
  snapshot: MarketOverviewSnapshot | null;
}) {
  const hasHistoryClose = snapshot?.latestClose !== null && snapshot?.latestClose !== undefined;
  const change = snapshot?.percentChange ?? index?.change ?? null;
  const direction = getMarketDirection(change);
  const value = formatClose(snapshot?.latestClose ?? null, hasHistoryClose ? null : index?.value ?? null);
  const href = marketInstrumentPath(instrument);
  return (
    <Link className="market-core-card" href={href} data-market-instrument={instrument.id}>
      <div className="market-core-card-topline">
        <span className="market-core-short-label">{instrument.shortLabel}</span>
        <span className={`market-data-badge ${statusClass(snapshot?.status ?? null)}`}><i />{statusLabel(snapshot?.status ?? null)}</span>
      </div>
      <div className="market-core-card-title"><strong>{instrument.label}</strong><ChevronRight size={16} /></div>
      <div className="market-core-value-row">
        <div><strong>{value}</strong><span>最新收盘 · {formatDate(snapshot?.asOf ?? index?.date ?? null)}</span></div>
        <MiniTrend values={snapshot?.trend ?? []} direction={direction} />
      </div>
      <div className={`market-core-change ${marketDirectionClass(change)}`}>
        {direction === "up" ? <TrendingUp size={15} /> : direction === "down" ? <TrendingDown size={15} /> : <span>—</span>}
        <strong>{snapshot?.pointChange === null || snapshot?.pointChange === undefined ? "点差 —" : `点差 ${snapshot.pointChange > 0 ? "+" : ""}${snapshot.pointChange.toFixed(2)}`}</strong>
        <span>{formatMarketChange(change)}</span>
      </div>
      <small className="market-core-card-foot">进入行情详情 · 日 K 与指标</small>
    </Link>
  );
}

export default function MarketOverview({
  data,
  sectorRotation,
  historySnapshots,
}: {
  data: DailyBrief;
  sectorRotation?: SectorRotationIndex;
  historySnapshots: Record<string, MarketOverviewSnapshot | null>;
}) {
  const [selectedMarket, setSelectedMarket] = useState<MarketGroup>("a-share");
  const selected = data.markets.find((market) => market.id === selectedMarket) ?? data.markets[0];
  const instruments = coreMarketInstruments(selectedMarket);
  const selectedRotation = useMemo(() => sectorRotation ? { ...sectorRotation, markets: sectorRotation.markets.filter((market) => market.id === selectedMarket) } : undefined, [sectorRotation, selectedMarket]);
  const selectedSnapshots = instruments.map((instrument) => historySnapshots[instrument.id] ?? null);
  const lastDataDate = selectedSnapshots.map((snapshot) => snapshot?.asOf ?? null).filter((date): date is string => date !== null).sort().at(-1) ?? selected?.sessionDate ?? null;
  const hasPartial = selectedSnapshots.some((snapshot) => snapshot?.status === "partial" || snapshot?.status === "stale");
  const selectedArticle = selected?.articles[0] ?? null;

  return (
    <div className="market-overview-shell">
      <DesktopSidebar />
      <main className="dashboard market-overview-dashboard">
        <header className="topbar">
          <Link className="desktop-brand" href="/" aria-label="观潮首页"><Image src="/brand/guanchao-logo-horizontal.png" alt="观潮 Guanchao Daily Brief" width={180} height={90} priority unoptimized /><span className="sr-only">观潮 · 每日早报</span></Link>
          <Link className="mobile-brand" href="/" aria-label="观潮首页"><Image src="/brand/guanchao-logo-mark.png" alt="观潮 Guanchao Daily Brief" width={40} height={40} priority unoptimized /><b>观潮</b></Link>
          <div className="route-title">三地市场</div>
          <div className="topbar-actions"><span className="verified-pill"><i />{data.meta.status}</span><span className="market-overview-updated"><RefreshCw size={13} />数据截至 {formatDate(lastDataDate)}</span></div>
        </header>

        <div className="dashboard-content market-overview-content">
          <section className="market-overview-hero" aria-labelledby="market-overview-title">
            <div><span className="eyebrow">MARKET FACTS / DAILY CLOSE</span><h1 id="market-overview-title">先看市场，再看观察</h1><p>单市场切换、三核心指数与真实数据状态集中在首屏；预测观察和收盘简报放在事实之后。</p></div>
            <span className="market-overview-contract"><Database size={14} />只读历史行情 · 非实时交易工具</span>
          </section>

          <div className="market-switch" role="tablist" aria-label="选择市场">
            {MARKET_ORDER.map((market) => <button key={market} type="button" role="tab" aria-selected={selectedMarket === market} className={selectedMarket === market ? "active" : ""} onClick={() => setSelectedMarket(market)}>{MARKET_LABELS[market]}</button>)}
          </div>

          <section className="market-status-strip" aria-label={`${MARKET_LABELS[selectedMarket]}市场状态`}>
            <div><span className="eyebrow">SESSION STATUS</span><strong>已收盘</strong><small>{selected?.status ?? "状态待确认"}</small></div>
            <div><span className="eyebrow">DATA DATE</span><strong>{formatDate(lastDataDate)}</strong><small>最近一条有效日线</small></div>
            <div><span className="eyebrow">FRESHNESS</span><strong>日线延迟</strong><small>{hasPartial ? "部分指数历史不足一年" : "收盘后更新，非实时"}</small></div>
          </section>

          <section className="market-core-section" aria-labelledby="market-core-title">
            <header className="market-overview-section-heading"><div><span className="eyebrow">THREE CORE INDICES</span><h2 id="market-core-title">{MARKET_LABELS[selectedMarket]}核心指数</h2><p>{MARKET_DESCRIPTIONS[selectedMarket]}</p></div><span className="market-core-count">3 个核心对象</span></header>
            <div className="market-core-grid">
              {instruments.map((instrument) => {
                const index = selected?.indices.find((candidate) => instrument.aliases.some((alias) => alias === candidate.name)) ?? null;
                return <MarketCoreCard key={instrument.id} market={selectedMarket} instrument={instrument} index={index} snapshot={historySnapshots[instrument.id] ?? null} />;
              })}
            </div>
          </section>

          <section className="market-breadth-card" aria-label="市场广度">
            <div className="market-breadth-icon"><Activity size={18} /></div>
            <div><span className="eyebrow">MARKET BREADTH</span><h2>市场广度</h2><p>市场广度数据暂不可用</p><small>当前没有可靠的点时全市场涨跌分布，页面不生成估算数字或柱状图。</small></div>
          </section>

          <section className="market-observation-section" aria-labelledby="market-observation-title">
            <header className="market-overview-section-heading"><div><span className="eyebrow">FORECAST / OBSERVATION</span><h2 id="market-observation-title">今日观察</h2><p>市场事实之后再看预测与证据观察；观察分不是概率。</p></div><Link href={`/predictions/?market=${selectedMarket}`}>查看完整观察榜<ChevronRight size={14} /></Link></header>
            <PredictionRankingPreview data={selectedRotation} />
          </section>

          <section className="market-brief-source-section" aria-labelledby="market-brief-title">
            <div className="market-closing-brief">
              <div className="market-overview-section-heading"><div><span className="eyebrow">CLOSING BRIEF</span><h2 id="market-brief-title">收盘简报</h2></div><CalendarDays size={18} /></div>
              {selectedArticle ? <><Link className="market-closing-brief-title" href={`/articles/${selectedArticle.id}/`}>{selectedArticle.title}<ChevronRight size={16} /></Link><p>{selectedArticle.summary}</p><span className="market-closing-brief-impact">关注：{selectedArticle.impact}</span><Link className="market-overview-report-link" href={`/articles/${selectedArticle.id}/`}>查看收盘详报 <ChevronRight size={14} /></Link></> : <p>当前没有可用收盘简报。</p>}
            </div>
            <div className="market-source-panel"><div className="market-overview-section-heading"><div><span className="eyebrow">LINEAGE / FRESHNESS</span><h2>来源与数据边界</h2></div><ShieldCheck size={18} /></div><p>行情卡只使用已校验的标准化日线；来源失败、数据不足与延迟会保留真实状态，不用其他指数替代。</p><SourceList market={selected} /></div>
          </section>

          <footer><div><span className="footer-mark"><ShieldCheck size={15} /></span><strong>观潮</strong><span>个人市场信息工作台</span></div><p>本页面仅作信息整理，不构成投资建议。所有摘要请以引用原文为准。</p><span>Edition {data.meta.editionDate}</span></footer>
        </div>
      </main>
      <MobileBottomNav active="markets" />
    </div>
  );
}
