import { ArrowUpRight, Siren } from "lucide-react";
import Link from "next/link";
import type { GlobalSpecialReportPublic, GlobalTriggerType, GlobalMarketTag } from "@/lib/global-market-brief-public";

const triggerLabels: Record<GlobalTriggerType, string> = {
  abnormal_market_move: "异常波动",
  central_bank_policy: "央行政策",
  macro_data_surprise: "宏观数据意外",
  geopolitical_risk: "地缘风险",
  major_earnings: "重大业绩",
  china_policy: "中国政策",
  theme_reversal: "主题反转",
  systemic_risk: "系统性风险",
};

const marketLabels: Record<GlobalMarketTag, string> = {
  US: "美股",
  HK: "港股",
  A_SHARE: "A股",
  GLOBAL: "全球",
};

export default function SpecialReportSection({ reports }: { reports: GlobalSpecialReportPublic[] }) {
  if (!reports.length) return null;
  return (
    <section className="global-special-report-section" aria-labelledby="global-special-report-title">
      <div className="global-special-report-heading">
        <div>
          <span className="eyebrow">MAJOR SPECIALS</span>
          <h2 id="global-special-report-title">重大专项</h2>
        </div>
        <span>仅展示预授权触发事项</span>
      </div>
      <div className="global-special-report-grid">
        {reports.map((report) => (
          <article className="global-special-report-card" key={report.articleUrl}>
            <div className="global-special-report-meta"><span><Siren size={14} />{triggerLabels[report.triggerType]}</span><span>{report.marketTags.map((tag) => marketLabels[tag]).join(" · ")}</span></div>
            <h3>{report.title}</h3>
            <p>{report.conclusion}</p>
            <Link href={report.articleUrl}>阅读专项 <ArrowUpRight size={14} /></Link>
          </article>
        ))}
      </div>
    </section>
  );
}
