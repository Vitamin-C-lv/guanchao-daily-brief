"use client";

import { ExternalLink, Gauge, Newspaper, Radar, Target } from "lucide-react";
import { useState } from "react";
import EvidenceConclusionCard from "./EvidenceConclusionCard";
import MacroRelationshipChain from "./MacroRelationshipChain";
import type { MarketObserverSnapshot } from "@/lib/types";

export default function MarketObserver({ data }: { data?: MarketObserverSnapshot }) {
  const [view, setView] = useState<"global" | "priority">("global");
  if (!data) return null;

  return (
    <section className="market-observer" id="market-observer">
      <div className="market-observer-heading">
        <div>
          <span className="eyebrow">EVIDENCE OBSERVER</span>
          <h2>市场证据观察</h2>
          <p>全面收集，重点观察；优先级改变采集深度，不改变客观评分。</p>
        </div>
        <span className="observer-updated">更新 {data.meta.dataAsOf}</span>
      </div>

      <div className="observer-view-tabs" role="tablist" aria-label="市场证据观察视图">
        <button type="button" role="tab" aria-selected={view === "global"} className={view === "global" ? "active" : ""} onClick={() => setView("global")}>
          <Gauge size={15} /><span>全局市场</span>
        </button>
        <button type="button" role="tab" aria-selected={view === "priority"} className={view === "priority" ? "active" : ""} onClick={() => setView("priority")}>
          <Target size={15} /><span>重点观察</span><em>{data.priorityWatch.length}</em>
        </button>
      </div>

      {view === "global" ? (
        <div className="observer-global-view">
          <EvidenceConclusionCard card={data.globalOverview} sources={data.sources} />
          <MacroRelationshipChain data={data} />
          <div className="observer-secondary-grid">
            <EvidenceConclusionCard card={data.policyFundRadar} sources={data.sources} compact />
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
          </div>
        </div>
      ) : (
        <div className="observer-priority-view">
          <div className="priority-watch-intro"><Radar size={18} /><p>恒生科技、港股互联网与AI，以及A股军工、医疗、半导体、AI互联网获得更深采集；其他市场继续参与全局风险判断。</p></div>
          <div className="priority-watch-grid">
            {data.priorityWatch.map((card) => <EvidenceConclusionCard key={card.id} card={card} sources={data.sources} compact />)}
          </div>
        </div>
      )}
    </section>
  );
}
