"use client";

import dynamic from "next/dynamic";
import { AlertTriangle, ArrowLeft, CalendarDays, Database, ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import DesktopSidebar from "./DesktopSidebar";
import MobileBottomNav from "./MobileBottomNav";
import { findMarketInstrument } from "@/lib/market-instruments";
import { decodeMarketHistoryDocument, type MarketHistoryDocument } from "@/lib/market-history";

const MarketHistoryChart = dynamic(() => import("./MarketHistoryChart"), { ssr: false, loading: () => <div className="market-chart-loading">正在加载图表引擎…</div> });

function statusLabel(status: MarketHistoryDocument["status"]) {
  return status === "ready" ? "可用" : status === "partial" ? "部分数据" : status === "stale" ? "历史数据" : "来源不可用";
}

function formatDate(value: string | null) {
  return value ? value.replaceAll("-", ".") : "—";
}

function changePercent(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return (current / previous - 1) * 100;
}

function formatChange(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export default function MarketDetailView({ instrumentId }: { instrumentId: string }) {
  const instrument = findMarketInstrument(instrumentId);
  const [history, setHistory] = useState<MarketHistoryDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!instrument) return;
    const currentInstrument = instrument;
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch(`/data/market-history/${currentInstrument.id}.json`, { cache: "no-cache" });
        if (!response.ok) throw new Error(`行情数据 HTTP ${response.status}`);
        const raw: unknown = await response.json();
        const decoded = decodeMarketHistoryDocument(raw, currentInstrument);
        if (!decoded) throw new Error("行情数据契约无效");
        if (!cancelled) setHistory(decoded);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [instrument]);

  const latest = history?.bars.at(-1) ?? null;
  const previous = history?.bars.at(-2) ?? null;
  const dailyChange = changePercent(latest?.close ?? null, previous?.close ?? null);
  const readyForChart = history?.status === "ready" && history.bars.length >= 252;
  const dataState = useMemo(() => {
    if (loading) return "loading";
    if (error) return "error";
    if (!history) return "error";
    if (history.status === "unavailable") return "unavailable";
    if (history.status === "partial" || history.bars.length < 252) return "insufficient";
    return "ready";
  }, [error, history, loading]);

  if (!instrument) return null;
  return (
    <div className="market-detail-shell">
      <DesktopSidebar />
      <header className="market-detail-header">
        <div className="market-detail-header-inner">
          <Link className="market-detail-brand" href="/"><span>观潮</span><small>MARKET TERMINAL</small></Link>
          <Link className="market-detail-back" href="/markets"><ArrowLeft size={16} /> 返回市场概览</Link>
          <span className="market-detail-contract"><ShieldCheck size={14} />公开标准化行情数据</span>
        </div>
      </header>
      <main className="market-detail-main">
        <nav className="market-detail-breadcrumb" aria-label="面包屑"><Link href="/markets">三地市场</Link><span>/</span><span>{instrument.market === "a-share" ? "A股" : instrument.market === "hk" ? "港股" : "美股"}</span><span>/</span><strong>{instrument.label}</strong></nav>
        <section className="market-detail-hero">
          <div>
            <p className="eyebrow">{instrument.market.toUpperCase()} · DAILY HISTORY</p>
            <h1>{instrument.label}<small>{instrument.id}</small></h1>
            <p>轻量历史看盘：日 K、均线、成交量与 MACD。保留数据来源与真实降级状态，不提供实时分时、盘口或交易功能。</p>
          </div>
          <span className={`market-data-status status-${history?.status ?? "loading"}`}><i />{history ? statusLabel(history.status) : "校验中"}</span>
        </section>

        <section className="market-detail-summary" aria-label="行情摘要">
          <div><span>最新收盘</span><strong>{latest?.close == null ? "—" : latest.close.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</strong><small>{latest ? formatDate(latest.time) : "—"}</small></div>
          <div><span>日变化</span><strong className={dailyChange !== null && dailyChange > 0 ? "up" : dailyChange !== null && dailyChange < 0 ? "down" : "flat"}>{formatChange(dailyChange)}</strong><small>相对上一交易日</small></div>
          <div><span>有效行数</span><strong>{history?.bars.length.toLocaleString("zh-CN") ?? "—"}</strong><small>{history?.bars[0] ? `${formatDate(history.bars[0].time)} — ${formatDate(latest?.time ?? null)}` : "尚无日期范围"}</small></div>
          <div><span>数据状态</span><strong>{history ? statusLabel(history.status) : "—"}</strong><small>{history?.source.delayed ? "收盘后更新，存在延迟" : "来源说明见下方"}</small></div>
        </section>

        {dataState === "loading" ? <section className="market-data-message"><Database size={24} /><h2>正在校验行情数据</h2><p>页面只展示契约校验通过的标准化数据。</p></section> : null}
        {dataState === "error" ? <section className="market-data-message is-error"><AlertTriangle size={24} /><h2>行情数据加载失败</h2><p>{error ?? "未取得有效数据"}。页面不会用旧 fixture 或零值覆盖失败状态。</p></section> : null}
        {dataState === "unavailable" || dataState === "insufficient" ? <section className="market-data-message is-degraded"><AlertTriangle size={24} /><h2>{dataState === "unavailable" ? "来源暂不可用" : "历史数据不足一年"}</h2><p>{history?.source.note ?? "没有可展示的来源数据。"}</p><p className="market-data-message-meta">当前 {history?.bars.length ?? 0} 条真实记录 · 少于 252 个有效交易日不标记为 ready。</p></section> : null}
        {readyForChart && history ? <MarketHistoryChart history={history} /> : null}

        <section className="market-detail-source-card" aria-label="数据来源与延迟说明">
          <div className="market-detail-source-title"><div><span className="eyebrow">LINEAGE / FRESHNESS</span><h2>数据来源与边界</h2></div><CalendarDays size={20} /></div>
          <dl>
            <div><dt>来源</dt><dd>{history?.source.provider ?? "—"}</dd></div>
            <div><dt>截至日期</dt><dd>{formatDate(history?.asOf ?? null)}</dd></div>
            <div><dt>延迟说明</dt><dd>{history?.source.delayed ? "日线收盘数据，非实时；交易所收盘、源端处理与静态发布均可能产生延迟。" : "来源未声明延迟，当前仅展示已校验日期。"}</dd></div>
            <div><dt>原始缓存</dt><dd>原始 provider payload 与私有缓存不进入 Git；此页面只读取标准化公开 DTO。</dd></div>
          </dl>
          {history?.source.url ? <a href={history.source.url} target="_blank" rel="noreferrer">查看来源端点 <ExternalLink size={14} /></a> : <span className="market-detail-source-unavailable">没有可公开的来源端点</span>}
        </section>
      </main>
      <MobileBottomNav active="markets" />
    </div>
  );
}
