type StrategyCardData = {
  title: string;
  summary: string;
  overallStance: "risk_on" | "neutral" | "risk_off";
  signalOrigin: "model_plus_writer" | "writer_only";
  modelContext: { status: "published" | "abstained" | "unavailable" };
  recommendations: Array<{
    label: string;
    action: "increase" | "hold" | "reduce";
    direction: "bullish" | "neutral" | "bearish";
    conviction: number;
    whyNow: string;
    modelEvidence: string;
    writerOverlay: string;
    trigger: string;
    invalidation: string;
    modelAgreement: "agree" | "override" | "not_applicable";
    overrideReason: string | null;
    modelSignal: { status: "published" | "abstained" | "unavailable" | "no_direct_model_signal"; probability: number | null; probabilityTarget: string | null; probabilityUnit: string | null };
  }>;
};

const actionLabels = { increase: "增配", hold: "维持", reduce: "减配" } as const;
const directionLabels = { bullish: "偏多", neutral: "中性", bearish: "偏空" } as const;
const stanceLabels = { risk_on: "偏进取", neutral: "中性", risk_off: "偏防御" } as const;

export default function InvestmentStrategyCard({ strategy }: { strategy: StrategyCardData }) {
  const directSignals = strategy.recommendations.filter((item) => item.modelSignal.status === "published");
  const modelLine = directSignals.length > 1
    ? `本期包含 ${directSignals.length} 条已发布模型信号。`
    : directSignals.length === 1
      ? "本期包含 1 条已发布模型信号，概率仅显示在对应配置上。"
      : "模型本期没有给出可直接用于该配置的概率。";
  return (
    <section className="investment-strategy-card" aria-label={strategy.title} data-strategy-placement="after-intro">
      <div className="investment-strategy-heading"><div><span>MARKET ALLOCATION</span><h2>{strategy.title}</h2></div><b>{stanceLabels[strategy.overallStance]}</b></div>
      <p className="investment-strategy-summary">{strategy.summary}</p>
      <p className="investment-strategy-model">{modelLine}</p>
      <div className="investment-strategy-list">
        {strategy.recommendations.map((item) => (
          <article key={`${item.label}-${item.action}`}>
            <div><strong>{item.label}</strong><span>{actionLabels[item.action]} · {directionLabels[item.direction]} · 判断强度 {item.conviction}/5</span></div>
            <p>{item.whyNow}</p>
            <dl>
              <div><dt>模型与主笔</dt><dd>{item.modelEvidence} {item.writerOverlay}</dd></div>
              {item.modelSignal.status === "published" ? <div><dt>模型概率</dt><dd>{Math.round((item.modelSignal.probability ?? 0) * 100)}%（{item.modelSignal.probabilityTarget === "absolute_up" ? "绝对上涨" : item.modelSignal.probabilityTarget === "relative_outperformance" ? "相对跑赢" : "进入前四分位"}）</dd></div> : null}
              {item.modelAgreement === "override" && item.overrideReason ? <div><dt>分歧原因</dt><dd>{item.overrideReason}</dd></div> : null}
              <div><dt>下一步确认</dt><dd>{item.trigger}</dd></div>
              <div><dt>失效条件</dt><dd>{item.invalidation}</dd></div>
            </dl>
          </article>
        ))}
      </div>
      <small>基于公开信息、模型与主笔判断的非个性化市场策略，不承诺收益。</small>
    </section>
  );
}
