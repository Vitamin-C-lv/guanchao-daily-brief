import type { Metadata } from "next";
import PredictionHistoryExplorer from "@/components/PredictionHistoryExplorer";

export const metadata: Metadata = {
  title: "历史预测与到期复盘 · 观潮",
  description: "查看观潮不可覆盖预测账本中的完整历史发布、模型弃权、到期评价和周度复盘。",
};

export default function PredictionHistoryPage() {
  return <PredictionHistoryExplorer />;
}
