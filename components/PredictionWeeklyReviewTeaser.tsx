import { ChevronRight, FileText } from "lucide-react";
import Link from "next/link";

export default function PredictionWeeklyReviewTeaser({
  latestReview,
  historyUrl,
}: {
  latestReview: { isoWeek: string; path: string; sha256: string } | null;
  historyUrl: string;
}) {
  return (
    <section className="prediction-weekly-teaser" aria-label="周度复盘">
      <div className="prediction-weekly-teaser-icon"><FileText size={17} /></div>
      <div>
        <span className="eyebrow">WEEKLY REVIEW</span>
        <h2>周度复盘{latestReview ? ` · ${latestReview.isoWeek}` : ""}</h2>
        <p>弃权、未训练、数据不足与未实现状态不计为错误；样本不足时指标返回 null 与原因。</p>
      </div>
      <Link href={historyUrl}>查看历史预测与复盘<ChevronRight size={15} /></Link>
    </section>
  );
}
