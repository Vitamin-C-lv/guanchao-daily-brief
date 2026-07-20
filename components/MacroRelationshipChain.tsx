import { ArrowDown, ExternalLink, GitBranch } from "lucide-react";
import type { MacroRelationshipStatus, MarketObserverSnapshot } from "@/lib/types";

const relationshipLabel: Record<MacroRelationshipStatus, string> = {
  confirmed: "已确认",
  partial: "部分确认",
  unconfirmed: "未确认",
  reverse: "出现反向信号",
};

const dataStatusLabel = {
  official: "官方数据",
  revised: "修订值",
  estimated: "估算值",
  delayed: "数据延迟",
} as const;

export default function MacroRelationshipChain({ data }: { data: MarketObserverSnapshot }) {
  const sourceMap = new Map(data.sources.map((source) => [source.id, source]));
  const edgeMap = new Map(data.macroChain.relationships.map((edge) => [`${edge.from}:${edge.to}`, edge]));

  return (
    <section className="macro-chain-card">
      <header>
        <div className="observer-icon-tile"><GitBranch size={18} /></div>
        <div><span className="eyebrow">MACRO CHAIN</span><h3>{data.macroChain.title}</h3></div>
      </header>
      <p className="macro-chain-conclusion">{data.macroChain.conclusion}</p>
      <ol className="macro-chain-list">
        {data.macroChain.nodes.map((node, index) => {
          const next = data.macroChain.nodes[index + 1];
          const edge = next ? edgeMap.get(`${node.id}:${next.id}`) : undefined;
          const source = sourceMap.get(node.fact.sourceId);
          return (
            <li key={node.id}>
              <article className="macro-node">
                <div className="macro-node-top">
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div><strong>{node.label}</strong><small>{node.role}</small></div>
                  <em className={`data-status status-${node.fact.status}`}>{dataStatusLabel[node.fact.status]}</em>
                </div>
                <b>{node.fact.currentValue}</b>
                <div className="macro-node-metrics">
                  <span>前值 <strong>{node.fact.previousValue}</strong></span>
                  <span>预期 <strong>{node.fact.expectedValue}</strong></span>
                  <span>预期差 <strong>{node.fact.surprise}</strong></span>
                  <span>统计期 <strong>{node.fact.dataPeriod}</strong></span>
                  <span>公布 <strong>{node.fact.releasedAt}</strong></span>
                  <span>更新 <strong>{node.fact.updatedAt}</strong></span>
                </div>
                {node.fact.note ? <p>{node.fact.note}</p> : null}
                {source ? <a href={source.url} target="_blank" rel="noreferrer">{source.publisher}<ExternalLink size={11} /></a> : null}
              </article>
              {edge ? (
                <div className={`macro-edge edge-${edge.status}`}>
                  <ArrowDown size={16} />
                  <span>{relationshipLabel[edge.status]}</span>
                  <p>{edge.explanation}</p>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
