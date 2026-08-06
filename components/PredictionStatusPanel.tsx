import { Database, Info, ShieldCheck } from "lucide-react";
import { modelAvailabilityLabel, targetLabel } from "@/lib/public-prediction-view";
import type { PublicPredictionHorizon } from "@/lib/public-prediction-view";

const statusTitle: Record<PublicPredictionHorizon["publicationStatus"], string> = {
  published: "已通过发布门槛",
  abstained: "模型弃权 · 不发布概率",
  insufficient_data: "样本不足 · 不发布概率",
  unavailable: "数据不可用",
  not_applicable: "模型未实现 · 不适用",
};

function dateText(value: string | null) {
  return value ? value.replaceAll("-", ".") : "—";
}

export default function PredictionStatusPanel({ horizon, modelAvailability }: { horizon: PublicPredictionHorizon; modelAvailability: "trained" | "not_trained" | "not_implemented" }) {
  return (
    <div className="prediction-status-panel">
      <div className="prediction-status-heading">
        <ShieldCheck size={16} aria-hidden="true" />
        <strong>{statusTitle[horizon.publicationStatus]}</strong>
      </div>
      <p className="prediction-status-reason">{horizon.statusReason}</p>
      <dl className="prediction-status-meta">
        <div><dt>模型状态</dt><dd>{modelAvailabilityLabel(modelAvailability)}</dd></div>
        <div><dt>概率目标</dt><dd>{targetLabel(horizon.target)}</dd></div>
        <div><dt>数据截至</dt><dd>{dateText(horizon.asOf)}</dd></div>
        <div><dt>到期日</dt><dd>{dateText(horizon.dueDate)}</dd></div>
      </dl>
      <p className="prediction-status-no-probability"><Info size={13} aria-hidden="true" />本卡片不显示任何数字概率。</p>
    </div>
  );
}
