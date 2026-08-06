import type { Metadata } from "next";
import PredictionCurrentView from "@/components/PredictionCurrentView";

export const metadata: Metadata = {
  title: "预测与模型状态 · 观潮",
  description: "A股、港股、美股三市场当前预测状态：只有通过样本外门槛的模型才显示概率；弃权与数据不足不会被伪装成概率。",
};

export default function PredictionsPage() {
  return <PredictionCurrentView />;
}
