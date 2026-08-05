import { ArrowRight, Check, CircleHelp, RotateCcw } from "lucide-react";
import type { GlobalLogicStatus, LogicChainSummary } from "@/lib/global-market-brief-public";

const statusLabel: Record<GlobalLogicStatus, string> = {
  confirmed: "已确认",
  partially_confirmed: "部分确认",
  pending: "待验证",
  reversed: "反向信号",
};

function StatusIcon({ status }: { status: GlobalLogicStatus }) {
  if (status === "confirmed") return <Check size={13} />;
  if (status === "reversed") return <RotateCcw size={13} />;
  return <CircleHelp size={13} />;
}

export default function LogicChainPreview({ logicChain }: { logicChain: LogicChainSummary[] }) {
  return (
    <section className="global-logic-chain" aria-labelledby="global-logic-chain-title">
      <div className="global-logic-chain-heading">
        <div>
          <span className="eyebrow">LOGIC CHAIN</span>
          <h3 id="global-logic-chain-title">今日逻辑链</h3>
        </div>
        <span>从事实到判断</span>
      </div>
      <ol>
        {logicChain.map((edge, index) => (
          <li key={`${edge.from}-${edge.relation}-${edge.to}-${index}`} className={`logic-status-${edge.evidenceStatus}`}>
            <span className="global-logic-index">{String(index + 1).padStart(2, "0")}</span>
            <div className="global-logic-edge-copy">
              <div className="global-logic-edge-line">
                <strong>{edge.from}</strong>
                <ArrowRight size={14} aria-hidden="true" />
                <strong>{edge.to}</strong>
              </div>
              <span className="global-logic-relation">{edge.relation}</span>
            </div>
            <span className="global-logic-status"><StatusIcon status={edge.evidenceStatus} />{statusLabel[edge.evidenceStatus]}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
