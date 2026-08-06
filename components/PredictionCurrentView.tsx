"use client";

import { CalendarDays, Database, History, ShieldCheck, Target } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import MobileBottomNav from "./MobileBottomNav";
import PredictionHorizonCard from "./PredictionHorizonCard";
import PredictionMarketTabs, { type PredictionMarketId } from "./PredictionMarketTabs";
import PredictionSourceNote from "./PredictionSourceNote";
import PredictionWeeklyReviewTeaser from "./PredictionWeeklyReviewTeaser";
import { isPublicPredictionView, marketOf } from "@/lib/public-prediction-view";
import type { PublicPredictionMarket, PublicPredictionView } from "@/lib/public-prediction-view";

function statusWord(market: PublicPredictionMarket) {
  const statuses = market.objects.flatMap((object) => object.horizons.map((horizon) => horizon.publicationStatus));
  if (statuses.every((status) => status === "abstained")) return "模型弃权 · 不发布概率";
  if (statuses.some((status) => status === "published")) return "已发布概率";
  if (statuses.some((status) => status === "unavailable")) return "含数据不可用对象";
  if (statuses.some((status) => status === "insufficient_data")) return "含样本不足对象";
  return "不发布概率";
}

function MarketHeader({ market }: { market: PublicPredictionMarket }) {
  return (
    <section className="prediction-market-summary" aria-label={`${market.label}市场摘要`}>
      <div className="prediction-market-summary-title">
        <h2>{market.label} · {statusWord(market)}</h2>
        <p>数据截至 {market.dataAsOf.replaceAll("-", ".")} · 数据状态 {market.datasetStatus} · 数据集 {market.datasetId ?? "—"}</p>
      </div>
      <div className="prediction-market-summary-tags">
        <span><Database size={12} aria-hidden="true" />dataset {market.datasetId ?? "null"}</span>
        {market.marketId === "a-share" ? <span><ShieldCheck size={12} aria-hidden="true" />生产模型已训练</span> : <span><ShieldCheck size={12} aria-hidden="true" />研究 shadow · 未发布</span>}
      </div>
    </section>
  );
}

function ObjectSection({ marketId, object }: { marketId: string; object: PublicPredictionMarket["objects"][number] }) {
  return (
    <section className="prediction-object" aria-label={object.label}>
      <header className="prediction-object-header">
        <div>
          <h3>{object.label}</h3>
          <p>基准 {object.benchmarkLabel} · 模型状态 {object.modelAvailability === "trained" ? "已训练" : object.modelAvailability === "not_trained" ? "未训练" : "未实现"} · 候选 {object.candidateStatus}</p>
        </div>
        {marketId === "a-share" && object.objectId === "a-share-sector-rotation" ? <span className="prediction-object-badge">当前生产模型</span> : null}
      </header>
      <div className="prediction-horizon-grid">
        {object.horizons.map((horizon) => <PredictionHorizonCard key={horizon.horizonSessions} horizon={horizon} marketId={marketId} modelAvailability={object.modelAvailability} />)}
      </div>
    </section>
  );
}

export default function PredictionCurrentView() {
  const [dto, setDto] = useState<PublicPredictionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marketId, setMarketId] = useState<PredictionMarketId>(() => {
    if (typeof window === "undefined") return "a-share";
    const requested = new URLSearchParams(window.location.search).get("market");
    return requested === "hk" || requested === "us" ? requested : "a-share";
  });
  const changeMarket = (id: PredictionMarketId) => {
    setMarketId(id);
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `/predictions/?market=${id}`);
    }
  };

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/data/predictions/current.json", { cache: "no-cache" });
        if (!response.ok) throw new Error(`current.json HTTP ${response.status}`);
        const raw: unknown = await response.json();
        if (!isPublicPredictionView(raw)) throw new Error("公开预测 DTO 契约无效");
        if (!cancelled) setDto(raw);
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="prediction-current-shell">
        <main className="prediction-current-main">
          <section className="prediction-current-hero">
            <p className="eyebrow">PREDICTION PRODUCT</p>
            <h1>预测与模型状态</h1>
            <p>正在校验公开预测数据…</p>
          </section>
          <PredictionMarketTabs active={marketId} onChange={changeMarket} />
        </main>
        <MobileBottomNav active="predictions" />
      </div>
    );
  }

  if (!dto) {
    return (
      <div className="prediction-current-shell">
        <main className="prediction-current-main">
          <section className="prediction-current-hero">
            <p className="eyebrow">PREDICTION PRODUCT</p>
            <h1>预测与模型状态</h1>
            <p>公开预测数据不可用（{error ?? "未知错误"}）；页面保持失败关闭，不显示任何概率占位。</p>
          </section>
          <PredictionMarketTabs active={marketId} onChange={changeMarket} />
        </main>
        <MobileBottomNav active="predictions" />
      </div>
    );
  }

  const market = marketOf(dto, marketId) ?? dto.markets[0];
  const effectiveMarketId = market.marketId === "hk" || market.marketId === "us" ? market.marketId : "a-share";
  return (
    <div className="prediction-current-shell">
      <header className="prediction-current-header">
        <div className="prediction-current-header-inner">
          <Link className="prediction-current-home" href="/"><Target size={17} /> 观潮</Link>
          <span className="prediction-current-contract"><ShieldCheck size={15} /> Git 不可覆盖预测账本</span>
        </div>
      </header>
      <main className="prediction-current-main">
        <section className="prediction-current-hero">
          <div>
            <p className="eyebrow">PREDICTION PRODUCT · {dto.asOf.replaceAll("-", ".")}</p>
            <h1>预测与模型状态</h1>
            <p>只有通过样本外门槛的模型才显示概率；弃权与数据不足不会被伪装成概率。观察分是证据分，不是概率。</p>
          </div>
          <Link className="prediction-history-link" href={dto.historyUrl}><History size={14} />历史预测与复盘</Link>
        </section>
        <PredictionMarketTabs active={effectiveMarketId} onChange={changeMarket} />
        <MarketHeader market={market} />
        {market.objects.map((object) => <ObjectSection key={object.objectId} marketId={market.marketId} object={object} />)}
        <PredictionSourceNote marketId={market.marketId} />
        <PredictionWeeklyReviewTeaser latestReview={dto.latestReview} historyUrl={dto.historyUrl} />
        <p className="prediction-current-updated"><CalendarDays size={12} aria-hidden="true" />当前预测数据更新于 {dto.generatedAt.slice(0, 10)}，来源为公开预测 DTO 与不可变账本。</p>
      </main>
      <MobileBottomNav active="predictions" />
    </div>
  );
}
