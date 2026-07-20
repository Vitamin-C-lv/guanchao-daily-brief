import { CalendarDays, ChevronRight, Target } from "lucide-react";
import Link from "next/link";
import type { SectorRotationIndex } from "@/lib/types";

const confidenceLabel = {
  low: "低置信度",
  medium: "中置信度",
  "medium-high": "中高置信度",
} as const;

export default function PredictionRankingPreview({ data }: { data?: SectorRotationIndex }) {
  const available = data?.markets.flatMap((market) => {
    const horizon = market.horizons.oneWeek;
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
          <p>排行榜先给方向与置信度；支持证据、反证和失效条件放入详情。</p>
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
                    <em>{item.score.toFixed(0)}<small>{confidenceLabel[item.confidence]}</small></em>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      ) : (
        <p className="prediction-preview-empty">本期尚无达到证据门槛的一周预测；完整页仍保留数据状态和缺口。</p>
      )}
    </section>
  );
}
