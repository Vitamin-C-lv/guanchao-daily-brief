import { AlertTriangle, ExternalLink, Eye, LineChart, ShieldCheck } from "lucide-react";
import type {
  EvidenceConclusionCardData,
  MarketDataStatus,
  MarketNarrativeState,
  MarketObserverSource,
} from "@/lib/types";

const statusLabel: Record<MarketDataStatus, string> = {
  official: "官方数据",
  revised: "修订值",
  estimated: "估算值",
  delayed: "数据延迟",
};

const stateLabel: Record<MarketNarrativeState, string> = {
  "identity-unconfirmed": "身份未确认",
  "market-unconfirmed": "市场未确认该叙事",
};

const levelLabel = {
  strong: "强证据",
  moderate: "中等证据",
  weak: "有限证据",
} as const;

function SourceAnchor({ source }: { source?: MarketObserverSource }) {
  if (!source) return null;
  return (
    <a href={source.url} target="_blank" rel="noreferrer" title={`打开 ${source.publisher} 原始页面`}>
      {source.publisher}<ExternalLink size={11} />
    </a>
  );
}

export default function EvidenceConclusionCard({
  card,
  sources,
  compact = false,
}: {
  card: EvidenceConclusionCardData;
  sources: MarketObserverSource[];
  compact?: boolean;
}) {
  const sourceMap = new Map(sources.map((source) => [source.id, source]));

  return (
    <article className={`evidence-conclusion-card level-${card.conclusionLevel} ${compact ? "compact" : ""}`}>
      <header className="evidence-card-header">
        <div>
          <span className="eyebrow">{card.eyebrow}</span>
          <span className="evidence-subject">{card.subject}</span>
        </div>
        <div className="evidence-state-row">
          <span className={`evidence-level evidence-level-${card.conclusionLevel}`}>{levelLabel[card.conclusionLevel]}</span>
          {(card.states || []).map((state) => <span key={state} className={`narrative-state state-${state}`}>{stateLabel[state]}</span>)}
        </div>
      </header>

      <div className="evidence-conclusion">
        <span>结论</span>
        <h3>{card.conclusion}</h3>
      </div>

      <section className="evidence-facts" aria-label="核心数据">
        <div className="evidence-section-label"><LineChart size={14} /><span>数据</span></div>
        <div className="evidence-fact-grid">
          {card.facts.map((fact) => (
            <article className="evidence-fact" key={`${card.id}-${fact.label}`}>
              <div className="evidence-fact-top">
                <span>{fact.label}</span>
                <em className={`data-status status-${fact.status}`}>{statusLabel[fact.status]}</em>
              </div>
              <strong>{fact.currentValue}</strong>
              <dl>
                <div><dt>前值</dt><dd>{fact.previousValue}</dd></div>
                <div><dt>市场预期</dt><dd>{fact.expectedValue}</dd></div>
                <div><dt>预期差</dt><dd>{fact.surprise}</dd></div>
                <div><dt>统计期</dt><dd>{fact.dataPeriod}</dd></div>
                <div><dt>公布时间</dt><dd>{fact.releasedAt}</dd></div>
                <div><dt>页面更新</dt><dd>{fact.updatedAt}</dd></div>
              </dl>
              {fact.note ? <p className="evidence-fact-note">{fact.note}</p> : null}
              <SourceAnchor source={sourceMap.get(fact.sourceId)} />
            </article>
          ))}
        </div>
      </section>

      <div className="evidence-reasoning-grid">
        <section>
          <div className="evidence-section-label"><ShieldCheck size={14} /><span>解释</span></div>
          <ul>{card.explanation.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section className="counter-evidence">
          <div className="evidence-section-label"><AlertTriangle size={14} /><span>反证</span></div>
          <ul>{card.counterEvidence.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>
        <section className="watch-conditions">
          <div className="evidence-section-label"><Eye size={14} /><span>观察</span></div>
          <ul>
            {card.watchItems.map((item) => (
              <li key={`${item.indicator}-${item.trigger || ""}`}>
                <strong>{item.indicator}</strong>
                {item.trigger ? <span>{item.trigger}</span> : null}
                {item.nextReleaseAt ? <small>{item.nextReleaseAt}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </article>
  );
}
