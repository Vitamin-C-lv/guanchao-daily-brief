import { ChevronDown, ExternalLink, GitBranch, Newspaper, Radar, Target } from "lucide-react";
import EvidenceConclusionCard from "./EvidenceConclusionCard";
import MacroRelationshipChain from "./MacroRelationshipChain";
import type { MarketObserverSnapshot } from "@/lib/types";

function HeadlineCalibration({ data }: { data: MarketObserverSnapshot }) {
  return (
    <section className="headline-calibration-card">
      <header><Newspaper size={17} /><div><span className="eyebrow">HEADLINE CALIBRATION</span><h3>媒体标题校准</h3></div></header>
      {data.headlineCalibrations.map((item) => (
        <article key={item.id}>
          <div className="headline-original"><span>待校准标题</span><s>{item.originalHeadline}</s>{item.detectedTerms.map((term) => <em key={term}>{term}</em>)}</div>
          <div className="headline-calibrated"><span>校准后</span><strong>{item.calibratedHeadline}</strong></div>
          <p>{item.verification}</p>
          <div className="headline-source-row">
            {item.sourceIds.map((sourceId) => {
              const source = data.sources.find((candidate) => candidate.id === sourceId);
              return source ? <a key={sourceId} href={source.url} target="_blank" rel="noreferrer">{source.publisher}<ExternalLink size={10} /></a> : null;
            })}
          </div>
        </article>
      ))}
    </section>
  );
}

export default function MarketObserver({
  data,
  mode,
}: {
  data?: MarketObserverSnapshot;
  mode: "prediction-support" | "daily-macro";
}) {
  if (!data) return null;

  if (mode === "daily-macro") {
    return (
      <section className="daily-macro-disclosure" id="daily-macro" aria-labelledby="daily-macro-title">
        <details>
          <summary>
            <span className="observer-icon-tile"><GitBranch size={17} /></span>
            <div><span className="eyebrow">DAILY MACRO CHAIN</span><h2 id="daily-macro-title">当日宏观链路</h2><p>{data.macroChain.conclusion}</p></div>
            <em>7 个节点<ChevronDown size={15} /></em>
          </summary>
          <div className="daily-macro-content">
            <MacroRelationshipChain data={data} />
            <div className="observer-secondary-grid">
              <EvidenceConclusionCard card={data.policyFundRadar} sources={data.sources} compact />
              <HeadlineCalibration data={data} />
            </div>
          </div>
        </details>
      </section>
    );
  }

  return (
    <section className="prediction-evidence-drawer" aria-labelledby="prediction-evidence-title">
      <details>
        <summary>
          <span className="observer-icon-tile"><Target size={17} /></span>
          <div><span className="eyebrow">EVIDENCE LEDGER</span><h2 id="prediction-evidence-title">预测证据底稿</h2><p>排行榜是主结论；这里保留数据、解释、反证和观察条件。</p></div>
          <em>{data.priorityWatch.length} 个重点主题<ChevronDown size={15} /></em>
        </summary>
        <div className="prediction-evidence-content">
          <div className="priority-watch-intro"><Radar size={18} /><p>恒生科技、港股互联网与AI，以及A股军工、医疗、半导体、AI互联网获得更深采集；关注优先级不改变模型评分。</p></div>
          <div className="priority-watch-grid">
            {data.priorityWatch.map((card) => <EvidenceConclusionCard key={card.id} card={card} sources={data.sources} compact />)}
          </div>
          <EvidenceConclusionCard card={data.policyFundRadar} sources={data.sources} compact />
        </div>
      </details>
    </section>
  );
}
