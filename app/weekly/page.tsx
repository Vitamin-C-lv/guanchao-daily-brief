import { ArrowRight, CalendarRange, Clock3, Sparkles } from "lucide-react";
import Link from "next/link";
import MobileBottomNav from "@/components/MobileBottomNav";
import NoticePreferences from "@/components/NoticePreferences";
import { loadWeeklyIndex } from "@/lib/weekly";

export const metadata = {
  title: "观潮周报 · 每周市场情报",
  description: "每周五21:30由 GPT-5.6 Terra 汇总本周大事、高价值洞察与三地市场资金路径。",
};

export default function WeeklyIndexPage() {
  const index = loadWeeklyIndex();
  return (
    <div className="weekly-shell">
      <header className="weekly-topbar"><Link href="/briefs/">← 返回简报</Link><Link href="/" className="weekly-wordmark">观潮</Link><span>每周市场情报</span></header>
      <main className="weekly-index-page">
        <section className="weekly-index-hero">
          <span className="eyebrow">WEEKLY INTELLIGENCE</span>
          <h1>观潮周报</h1>
          <p>每周五21:30，以当日收盘晚报与最新完整交易日为边界，汇总政策、A股、港股、美股、跨市场主线及本地日报沉淀。</p>
          <div><span><Sparkles size={15} /> GPT-5.6 Terra 深度整理</span><span><Clock3 size={15} /> 北京时间每周五21:30</span><NoticePreferences /></div>
        </section>
        {index.reports.length ? (
          <section className="weekly-archive-list">
            <div className="weekly-section-heading"><div><span className="eyebrow">REPORT ARCHIVE</span><h2>历史周报</h2></div><span>{index.reports.length} 期</span></div>
            {index.reports.map((item) => <Link href={`/weekly/${item.id}/`} key={item.id}><CalendarRange size={19} /><div><span>{item.weekStart.replaceAll("-", ".")} — {item.weekEnd.replaceAll("-", ".")}</span><strong>{item.title}</strong><p>{item.summary}</p></div><ArrowRight size={16} /></Link>)}
          </section>
        ) : (
          <section className="weekly-empty"><CalendarRange size={28} /><span>FIRST EDITION PENDING</span><h2>首期周报将在本周五晚生成</h2><p>当前页面和自动化流程已经就绪。周五21:30发布后，首次打开网站会出现更新摘要弹窗。</p></section>
        )}
      </main>
      <MobileBottomNav active="briefs" />
    </div>
  );
}
