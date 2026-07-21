import { CalendarDays, ChevronRight, Target } from "lucide-react";
import Link from "next/link";
import type { SectorRotationIndex } from "@/lib/types";

const probabilityTierLabel = {
  "model-calibrated": "样本外校准",
  "model-shrunk": "收缩概率",
  "historical-base-rate": "历史基准",
} as const;

export default function PredictionRankingPreview({ data }: { data?: SectorRotationIndex }) {
  const available = data?.markets.flatMap((market) => {
    const horizon = market.horizons.tomorrow;
    if (horizon.status !== "ready") return [];
    return [{ market, horizon, items: [...horizon.items].sort((a, b) => a.rank - b.rank).slice(0, 3) }];
  }) ?? [];

  return (
    <section className="prediction-preview" aria-labelledby="prediction-preview-title">
      <header>
        <div className="prediction-preview-icon"><Target size={18} /></div>
        <div>
          <span className="eyebrow">FORECAST FIRST</span>
          <h2 id="prediction-preview-title">先看预测排行榜</h2>
          <p>先看下一交易日上涨概率；历史基准、校准区间和失效条件放入详情。</p>
        </div>
        <Link href="/predictions/">查看完整预测<ChevronRight size={15} /></Link>
      </header>

      {available.length ? (
        <div className="prediction-preview-markets">
          {available.map(({ market, horizon, items }) => (
            <article key={market.id}>
              <div className="prediction-preview-market">
                <strong>{market.label}</strong>
                <span><CalendarDays size={11} />截至 {horizon.dueDate.replaceAll("-", ".")}</span>
              </div>
              <ol>
                {items.map((item) => (
                  <li key={item.forecastId}>
                    <span>{String(item.rank).padStart(2, "0")}</span>
                    <div><strong>{item.sector}</strong><small>{item.claim}</small></div>
                    <em>{item.upProbability.toFixed(1)}%<small>{probabilityTierLabel[item.probabilityTier]}</small></em>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      ) : (
        <p className="prediction-preview-empty">本期明日概率尚未生成；完整页仍保留数据状态和原因。</p>
      )}
    </section>
  );
}
