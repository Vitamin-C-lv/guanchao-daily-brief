import { ArrowRight, CalendarRange, Sparkles } from "lucide-react";
import Link from "next/link";
import type { WeeklyReportIndex } from "@/lib/types";

export default function WeeklyTeaser({ index }: { index: WeeklyReportIndex }) {
  const latest = index.reports.find((item) => item.id === index.latestReportId) ?? index.reports[0];
  return (
    <Link className={`weekly-teaser ${latest ? "is-published" : "is-pending"}`} href={latest ? `/weekly/${latest.id}/` : "/weekly/"}>
      <span className="weekly-teaser-icon">{latest ? <Sparkles size={18} /> : <CalendarRange size={18} />}</span>
      <div>
        <span className="eyebrow">WEEKLY INTELLIGENCE</span>
        <strong>{latest ? latest.title : "每周五 20:00 · 观潮周报"}</strong>
        <p>{latest ? latest.summary : "汇总本周大事、高价值洞察、资金与板块轮动，并给出下周条件情景。首期周报将在本周五晚生成。"}</p>
      </div>
      <span className="weekly-teaser-action">{latest ? "阅读周报" : "查看说明"}<ArrowRight size={14} /></span>
    </Link>
  );
}
