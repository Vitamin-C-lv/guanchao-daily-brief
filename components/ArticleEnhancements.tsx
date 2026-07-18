import { Bot, CheckCircle2, ShieldAlert, Telescope } from "lucide-react";
import type { EvidenceForecast, GeneratedEditorialVisual, SourceLink } from "@/lib/types";

function EvidenceRefs({ indexes, sources }: { indexes: number[]; sources: SourceLink[] }) {
  return (
    <span className="article-inline-refs" aria-label="预测依据引用">
      {[...new Set(indexes)].map((index) => {
        const source = sources[index];
        if (!source) return null;
        return <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" title={source.name}>[{index + 1}]</a>;
      })}
    </span>
  );
}

export function GeneratedEditorialVisualFigure({ visual, sources }: { visual: GeneratedEditorialVisual; sources: SourceLink[] }) {
  return (
    <figure className="generated-editorial-visual">
      <img src={visual.src} alt={visual.alt} loading="lazy" decoding="async" />
      <figcaption>
        <span><Bot size={14} />AI 生成编辑配图 · 仅用于说明主题，不代表真实数据或现场画面</span>
        <p>{visual.caption}<EvidenceRefs indexes={visual.basisSourceIndexes} sources={sources} /></p>
      </figcaption>
    </figure>
  );
}

const horizonLabel: Record<EvidenceForecast["horizon"], string> = {
  "1_5d": "未来 1–5 个交易日",
  "2_4w": "未来 2–4 周",
  "3_12m": "未来 3–12 个月",
};

const confidenceLabel: Record<EvidenceForecast["confidence"], string> = {
  low: "低置信度",
  medium: "中置信度",
  "medium-high": "中高置信度",
};

const directionLabel: Record<EvidenceForecast["direction"], string> = {
  upside: "上行情景",
  range: "区间情景",
  downside: "下行情景",
  mixed: "方向分化",
};

const reviewStatusLabel: Record<NonNullable<EvidenceForecast["review"]>["status"], string> = {
  pending: "待复盘",
  confirmed: "已验证",
  partial: "部分验证",
  invalidated: "已失效",
};

export function EvidenceForecastPanel({ forecast, sources }: { forecast: EvidenceForecast; sources: SourceLink[] }) {
  const review = forecast.review ?? { status: "pending" as const, note: "尚未到复盘节点。" };
  const titleId = `evidence-forecast-title-${forecast.id}`;
  return (
    <section className="evidence-forecast" aria-labelledby={titleId}>
      <header>
        <div>
          <span className="eyebrow">EVIDENCE FORECAST</span>
          <h2 id={titleId}><Telescope size={18} />{forecast.title}</h2>
        </div>
        <p><span>{horizonLabel[forecast.horizon]}</span><strong>{confidenceLabel[forecast.confidence]}</strong></p>
      </header>

      <div className="evidence-forecast-thesis">
        <span>预测 #{forecast.id} · {directionLabel[forecast.direction]} · 截至 {forecast.asOf} · {forecast.dueDate} 到期</span>
        <p>{forecast.claim}</p>
      </div>

      <h3 className="evidence-forecast-list-heading">支持证据</h3>
      <div className="evidence-forecast-facts">
        {forecast.evidence.map((item) => (
          <article key={`${item.label}-${item.observation}`}>
            <CheckCircle2 size={15} />
            <div><strong>{item.label}</strong><p>{item.observation}<EvidenceRefs indexes={item.sourceIndexes} sources={sources} /></p></div>
          </article>
        ))}
      </div>

      <section className="evidence-forecast-counter">
        <h3>反证与约束</h3>
        {forecast.counterEvidence.map((item) => (
          <article key={`${item.label}-${item.observation}`}>
            <ShieldAlert size={14} />
            <div><strong>{item.label}</strong><p>{item.observation}<EvidenceRefs indexes={item.sourceIndexes} sources={sources} /></p></div>
          </article>
        ))}
      </section>

      <dl className="evidence-forecast-conditions">
        <div><dt>成立触发</dt><dd>{forecast.trigger}</dd></div>
        <div><dt>失效条件</dt><dd>{forecast.invalidation}</dd></div>
      </dl>

      <div className={`evidence-forecast-review review-${review.status}`}>
        <strong>复盘状态 · {reviewStatusLabel[review.status]}</strong>
        <p>{review.note}{review.reviewedAt ? ` · ${review.reviewedAt}` : ""}</p>
      </div>

      <p className="evidence-forecast-risk"><ShieldAlert size={14} />{forecast.riskNote}</p>
    </section>
  );
}
