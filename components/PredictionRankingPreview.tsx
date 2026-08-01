import { CalendarDays, ChevronRight, Target } from "lucide-react";
import Link from "next/link";
import type {
  SectorRotationForecastHorizon,
  SectorRotationForecastItem,
  SectorRotationIndex,
  SectorRotationMarket,
  SectorRotationObservedItem,
} from "@/lib/types";

type ReadyHorizon = Extract<SectorRotationForecastHorizon, { status: "ready" }>;
type AbstainedHorizon = Extract<SectorRotationForecastHorizon, { status: "abstained" }>;
type PreviewEntry =
  | {
      market: SectorRotationMarket;
      horizon: ReadyHorizon;
      mode: "probability";
      items: SectorRotationForecastItem[];
    }
  | {
      market: SectorRotationMarket;
      horizon: AbstainedHorizon;
      mode: "observation";
      items: SectorRotationObservedItem[];
    };

export default function PredictionRankingPreview({ data }: { data?: SectorRotationIndex }) {
  const available: PreviewEntry[] = data?.markets.flatMap<PreviewEntry>((market) => {
    const horizon = market.horizons.tomorrow;
    if (horizon.status === "ready") {
      return [{ market, horizon, mode: "probability" as const, items: [...horizon.items].sort((a, b) => a.rank - b.rank).slice(0, 3) }];
    }
    if (horizon.status === "abstained") {
      return [{ market, horizon, mode: "observation" as const, items: [...horizon.observationItems].sort((a, b) => a.rank - b.rank).slice(0, 3) }];
    }
    return [];
  }) ?? [];
  const hasProbability = available.some((entry) => entry.mode === "probability");
  const hasObservation = available.some((entry) => entry.mode === "observation");
  const previewCopy = !available.length
    ? {
        title: "本期暂无可用排行榜",
        description: "当前没有可发布概率或可复核观察榜；完整页保留模型与数据状态。",
      }
    : hasProbability && hasObservation
      ? {
          title: "预测与板块观察",
          description: "已发布窗口展示前四分位概率；其余窗口明确展示证据观察分，不混用概率。",
        }
      : hasProbability
        ? {
            title: "先看预测排行榜",
            description: "仅展示已通过全部发布闸门的前四分位概率。",
          }
        : {
            title: "先看板块观察榜",
            description: "当前仅有证据观察榜：证据分，不是概率。",
          };

  return (
    <section className="prediction-preview" aria-labelledby="prediction-preview-title">
      <header>
        <div className="prediction-preview-icon"><Target size={18} /></div>
        <div>
          <span className="eyebrow">FORECAST / OBSERVATION</span>
          <h2 id="prediction-preview-title">{previewCopy.title}</h2>
          <p>{previewCopy.description}</p>
        </div>
        <Link href="/predictions/">查看完整榜单<ChevronRight size={15} /></Link>
      </header>

      {available.length ? (
        <div className="prediction-preview-markets">
          {available.map(({ market, horizon, mode, items }) => (
            <article key={market.id}>
              <div className="prediction-preview-market">
                <strong>{market.label}</strong>
                <span><CalendarDays size={11} />截至 {(horizon.dueDate ?? horizon.asOf).replaceAll("-", ".")}</span>
              </div>
              <ol>
                {mode === "probability"
                  ? (items as SectorRotationForecastItem[]).map((item) => (
                    <li key={item.forecastId}>
                      <span>{String(item.rank).padStart(2, "0")}</span>
                      <div><strong>{item.sector}</strong><small>{item.claim}</small></div>
                      <em>{item.topQuartileProbability.toFixed(1)}%<small>前25%概率</small></em>
                    </li>
                  ))
                  : (items as SectorRotationObservedItem[]).map((item) => (
                    <li key={`${market.id}-${item.code ?? item.sector}`}>
                      <span>{String(item.rank).padStart(2, "0")}</span>
                      <div><strong>{item.sector}</strong><small>{item.signal}</small></div>
                      <em>{item.score.toFixed(0)}<small>证据分</small></em>
                    </li>
                  ))}
              </ol>
            </article>
          ))}
        </div>
      ) : (
        <p className="prediction-preview-empty">本期尚无可发布的概率或观察榜；完整页保留数据状态和原因。</p>
      )}
    </section>
  );
}
