import { ArrowLeft, ArrowRight, FileText, Sparkles } from "lucide-react";
import Link from "next/link";
import GlobalMainBriefCard from "./GlobalMainBriefCard";
import MobileBottomNav from "./MobileBottomNav";
import SpecialReportSection from "./SpecialReportSection";
import type { GlobalMarketBriefPublic, GlobalPublicArticle, GlobalSpecialReportPublic } from "@/lib/global-market-brief-public";

const triggerLabels = {
  abnormal_market_move: "异常波动",
  central_bank_policy: "央行政策",
  macro_data_surprise: "宏观数据意外",
  geopolitical_risk: "地缘风险",
  major_earnings: "重大业绩",
  china_policy: "中国政策",
  theme_reversal: "主题反转",
  systemic_risk: "系统性风险",
} as const;

const marketLabels = { US: "美股", HK: "港股", A_SHARE: "A股", GLOBAL: "全球" } as const;

function SpecialReportArticle({ article }: { article: GlobalSpecialReportPublic }) {
  return (
    <article className="global-special-article">
      <div className="global-special-article-kicker"><Sparkles size={14} />重大专项 · {triggerLabels[article.triggerType]}</div>
      <h1>{article.title}</h1>
      <div className="global-special-article-tags">{article.marketTags.map((tag) => <span key={tag}>{marketLabels[tag]}</span>)}</div>
      <section className="global-special-article-conclusion">
        <span>专项结论</span>
        <p>{article.conclusion}</p>
      </section>
      <Link className="global-article-back-to-briefs" href="/briefs/"><ArrowLeft size={15} />返回全球简报</Link>
    </article>
  );
}

export default function GlobalBriefArticleView({ article, data }: { article: GlobalPublicArticle; data: GlobalMarketBriefPublic }) {
  const isMain = article.kind === "global_main";
  return (
    <div className="article-shell global-brief-article-shell">
      <div className="page-orb page-orb-one" />
      <div className="page-orb page-orb-two" />
      <header className="article-topbar">
        <Link className="article-back-link" href="/briefs/"><ArrowLeft size={16} />返回简报</Link>
        <Link className="article-wordmark" href="/">观潮</Link>
        <span className="article-topbar-label">全球市场简报</span>
      </header>
      <main className="article-page global-brief-article-page">
        <div className="global-brief-article-heading">
          <span><FileText size={14} />公开文章视图</span>
          <small>只展示公开 DTO 字段</small>
        </div>
        {isMain ? <GlobalMainBriefCard brief={article.article} variant="detail" /> : <SpecialReportArticle article={article.article} />}
        {isMain && data.specialReports.length ? <SpecialReportSection reports={data.specialReports} /> : null}
        <footer className="global-brief-article-footer">
          <p>本文仅展示经过公开 DTO 适配的编辑判断；事实以未来文章页接入的公开内容为准，不构成投资建议。</p>
          <Link href="/briefs/">返回全球简报 <ArrowRight size={14} /></Link>
        </footer>
      </main>
      <MobileBottomNav active="briefs" />
    </div>
  );
}
