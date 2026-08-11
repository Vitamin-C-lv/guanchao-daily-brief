type StrategyCardData = {
  title: string;
  summary: string;
  overallStance: "risk_on" | "neutral" | "risk_off";
  signalOrigin: "model_plus_writer" | "writer_only";
  modelContext: { status: "published" | "abstained" | "unavailable"; probability: number | null };
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
  }>;
};

const actionLabels = { increase: "增配", hold: "维持", reduce: "减配" } as const;
const directionLabels = { bullish: "偏多", neutral: "中性", bearish: "偏空" } as const;
const stanceLabels = { risk_on: "偏进取", neutral: "中性", risk_off: "偏防御" } as const;

export default function InvestmentStrategyCard({ strategy }: { strategy: StrategyCardData }) {
  const modelLine = strategy.modelContext.status === "published"
    ? `模型信号已发布${strategy.modelContext.probability === null ? "" : `：${Math.round(strategy.modelContext.probability * 100)}%`}；主笔判断${strategy.signalOrigin === "model_plus_writer" ? "结合模型信号形成" : "独立形成"}。`
    : strategy.modelContext.status === "abstained"
      ? "模型本期没有给出概率，本节由主笔结合市场数据给出方向判断。"
      : "模型本期没有可用信号，本节由主笔结合市场数据给出方向判断。";
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
