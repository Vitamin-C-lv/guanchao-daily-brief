import { ArrowLeft, ArrowRight, ExternalLink, FileText, Sparkles } from "lucide-react";
import Link from "next/link";
import MobileBottomNav from "./MobileBottomNav";
import InvestmentStrategyCard from "./InvestmentStrategyCard";
import GlobalMainBriefCard from "./GlobalMainBriefCard";
import SpecialReportSection from "./SpecialReportSection";
import type { GlobalMarketBriefPublic, GlobalPublicArticle, GlobalSpecialReportPublic } from "@/lib/global-market-brief-public";
import type { ArticleSource, GlobalArticlePage } from "@/lib/global-market-brief-article";

const triggerLabels: Record<string, string> = {
  abnormal_market_move: "异常波动",
  central_bank_policy: "央行政策",
  macro_data_surprise: "宏观数据意外",
  geopolitical_risk: "地缘风险",
  major_earnings: "重大业绩",
  china_policy: "中国政策",
  theme_reversal: "主题反转",
  systemic_risk: "系统性风险",
};

const marketLabels: Record<string, string> = { US: "美股", HK: "港股", A_SHARE: "A股", GLOBAL: "全球" };
const statusLabels: Record<string, string> = {
  confirmed: "已确认",
  revised: "已修订",
  delayed: "数据延迟",
  estimated: "单源/估计",
  unavailable: "不可用",
  partially_confirmed: "部分确认",
  pending: "待确认",
  reversed: "已反转",
};

function SourceLinks({ sources }: { sources: ArticleSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="global-full-source-links">
      {sources.map((source) => (
        <a key={source.sourceId} href={source.url} target="_blank" rel="noreferrer" className="global-full-source-link">
          <span>{source.publisher} · {source.title}</span><ExternalLink size={12} />
        </a>
      ))}
    </div>
  );
}

function SourceCitations({ sources, sourceNumbers }: { sources: ArticleSource[]; sourceNumbers: Map<string, number> }) {
  const uniqueSources = sources.filter((source, index, list) => list.findIndex((item) => item.sourceId === source.sourceId) === index);
  if (!uniqueSources.length) return null;
  return <span className="global-full-citations" aria-label="段落来源">{uniqueSources.map((source) => <a key={source.sourceId} href={source.url} target="_blank" rel="noreferrer" title={`${source.publisher} · ${source.title}`}>〔{sourceNumbers.get(source.sourceId) ?? "·"}〕</a>)}</span>;
}

function SourceChip({ sources }: { sources: ArticleSource[] }) {
  return sources.length ? <span className="global-full-source-chip">来源 {sources.length}</span> : null;
}

function FullGlobalArticle({ article, relatedSpecialReports }: { article: GlobalArticlePage; relatedSpecialReports?: GlobalArticlePage[] }) {
  const isSpecial = article.kind === "special_report";
  const sourceNumbers = new Map(article.sources.map((source, index) => [source.sourceId, index + 1]));
  const invalidations = new Map(article.invalidationConditions.map((condition) => [condition.id, condition.condition]));

  const renderAnalysisSections = (sectionNumber: string) => article.analysisSections.length ? (
    <section className="global-full-section global-full-prose-section" data-global-section="analysis">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>分析正文</h2></div>
      <div className="global-full-analysis-sections">
        {article.analysisSections.map((section) => (
          <section key={section.heading} className="global-full-analysis-block">
            <h3>{section.heading}</h3>
            {section.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}<SourceCitations sources={section.sources} sourceNumbers={sourceNumbers} /></p>)}
          </section>
        ))}
      </div>
    </section>
  ) : null;

  const renderSpecialAnalysis = () => isSpecial && article.analysis.length ? (
    <section className="global-full-section" data-global-section="special-analysis">
      <div className="global-full-section-heading"><span>01</span><h2>专项分析</h2></div>
      <div className="global-full-analysis-list">{article.analysis.map((paragraph, index) => <p key={`${index}-${paragraph}`}>{paragraph}</p>)}</div>
    </section>
  ) : null;

  const renderFacts = (sectionNumber: string) => (
    <section className="global-full-section" data-global-section="facts">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>核心事实</h2></div>
      <div className="global-full-facts-grid">
        {article.keyFacts.map((fact) => (
          <article className="global-full-fact" key={fact.id}>
            <div className="global-full-fact-topline"><span>{statusLabels[fact.factStatus] ?? fact.factStatus}</span><span>{fact.asOf}</span></div>
            <p>{fact.statement}<SourceCitations sources={fact.sources} sourceNumbers={sourceNumbers} /></p>
            {fact.value !== null ? <strong>{fact.value}{fact.unit === "percent" ? "%" : fact.unit ? ` ${fact.unit}` : ""}</strong> : null}
          </article>
        ))}
      </div>
    </section>
  );

  const renderLogic = (sectionNumber: string) => (
    <section className="global-full-section" data-global-section="logic-chain">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>逻辑链</h2></div>
      <ol className="global-full-logic-list">
        {article.logicChain.map((edge, index) => (
          <li key={`${edge.from}-${edge.to}-${index}`}>
            <span className="global-full-step-number">{index + 1}</span>
            <div><p><strong>{edge.from}</strong><em>{edge.relation}</em><strong>{edge.to}</strong><SourceCitations sources={[...edge.supportingSources, ...edge.contradictorySources]} sourceNumbers={sourceNumbers} /></p><div className="global-full-status-line"><span>{statusLabels[edge.evidenceStatus] ?? edge.evidenceStatus}</span><SourceChip sources={edge.supportingSources} /></div></div>
          </li>
        ))}
      </ol>
    </section>
  );

  const renderTransmission = (sectionNumber: string) => (
    <section className="global-full-section" data-global-section="transmission">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>跨市场传导</h2></div>
      <div className="global-full-transmission-grid">
        {article.crossMarketTransmission.map((item, index) => (
          <article className="global-full-transmission" key={`${item.fromMarket}-${item.toMarket}-${index}`}>
            <div className="global-full-transmission-route"><strong>{marketLabels[item.fromMarket] ?? item.fromMarket}</strong><span>→</span><strong>{marketLabels[item.toMarket] ?? item.toMarket}</strong></div>
            <p>{item.explanation}<SourceCitations sources={item.sources} sourceNumbers={sourceNumbers} /></p>
            <div className="global-full-status-line"><span>{item.direction} · {item.horizon} · {statusLabels[item.evidenceStatus] ?? item.evidenceStatus}</span><SourceChip sources={item.sources} /></div>
          </article>
        ))}
      </div>
    </section>
  );

  const renderOutlook = (sectionNumber: string) => (
    <section className="global-full-section" data-global-section="outlook">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>展望</h2></div>
      <div className="global-full-outlook-grid">
        {(["nextSession", "oneWeek"] as const).map((horizon) => {
          const item = article.outlook[horizon];
          return <article className="global-full-outlook" key={horizon}><span>{horizon === "nextSession" ? "下一交易时段" : "未来一周"}</span><p>{item.statement}<SourceCitations sources={item.sources} sourceNumbers={sourceNumbers} /></p><div className="global-full-invalidation-ref">失效条件：{item.invalidationConditionIds.map((id) => invalidations.get(id) ?? id).join("；")}</div></article>;
        })}
      </div>
    </section>
  );

  const renderInvalidations = (sectionNumber: string) => (
    <section className="global-full-section" data-global-section="invalidation-conditions">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>失效条件</h2></div>
      <div className="global-full-invalidation-list">{article.invalidationConditions.map((condition) => <article key={condition.id}><strong>{condition.condition}</strong><p>影响判断：{condition.affectedClaims.join("、")}</p></article>)}</div>
    </section>
  );

  const renderWatch = (sectionNumber: string) => (
    <section className="global-full-section" data-global-section="watch-items">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>观察清单</h2></div>
      <div className="global-full-watch-grid">{article.watchItems.map((item) => <article className="global-full-watch" key={item.item}><strong>{item.item}</strong><p>{item.whyItMatters}<SourceCitations sources={item.sources} sourceNumbers={sourceNumbers} /></p><span>{item.expectedAt ? `观察时间：${item.expectedAt}` : "观察时间：下一次可验证数据"}</span></article>)}</div>
    </section>
  );

  const renderSources = (sectionNumber: string) => (
    <section className="global-full-section global-full-sources-section" data-global-section="sources">
      <div className="global-full-section-heading"><span>{sectionNumber}</span><h2>来源</h2></div>
      <SourceLinks sources={article.sources} />
    </section>
  );

  return (
    <article className="global-full-article">
      <header className="global-full-article-header">
        <div className="global-full-article-kicker"><FileText size={14} />{isSpecial ? `重大专项 · ${triggerLabels[article.triggerType ?? ""] ?? article.triggerType}` : "今日全球判断"}</div>
        <div className="global-full-article-meta"><span>数据截至 {article.dataAsOf}</span><span>{article.sourceCount} 个来源</span></div>
        <h1>{article.title}</h1>
        <p className="global-full-article-dek">{article.dek}</p>
        {isSpecial && article.triggerReason ? <p className="global-full-trigger-reason">触发理由：{article.triggerReason}</p> : null}
      </header>

      {isSpecial ? (
        <>
          <section className="global-full-conclusion" aria-labelledby="global-full-conclusion-title" data-global-section="conclusion">
            <span id="global-full-conclusion-title">结论</span>
            <p>{article.conclusion}</p>
          </section>
          {renderSpecialAnalysis()}
          {renderFacts("02")}
          {renderLogic("03")}
          {renderTransmission("04")}
          {renderOutlook("05")}
          {renderInvalidations("06")}
          {renderWatch("07")}
          {renderSources("08")}
        </>
      ) : (
        <>
          {renderLogic("01")}
          <section className="global-full-section global-full-intro-section" aria-labelledby="global-full-introduction-title" data-global-section="introduction">
            <div className="global-full-section-heading"><span>02</span><h2 id="global-full-introduction-title">引言</h2></div>
            <p>{article.conclusion}</p>
          </section>
          {article.investmentStrategy ? <InvestmentStrategyCard strategy={article.investmentStrategy} /> : null}
          {renderTransmission("03")}
          {renderAnalysisSections("04")}
          {renderFacts("05")}
          {renderOutlook("06")}
          {renderInvalidations("07")}
          {renderWatch("08")}
          {renderSources("09")}
        </>
      )}

      {relatedSpecialReports?.length ? <section className="global-full-related"><div><span>继续阅读</span><h2>重大专项</h2></div>{relatedSpecialReports.map((report) => <Link key={report.id} href={report.articleUrl}>{report.title}<ArrowRight size={14} /></Link>)}</section> : null}
    </article>
  );
}

function SpecialSummaryArticle({ article }: { article: GlobalSpecialReportPublic }) {
  return (
    <article className="global-special-article">
      <div className="global-special-article-kicker"><Sparkles size={14} />重大专项 · {triggerLabels[article.triggerType] ?? article.triggerType}</div>
      <h1>{article.title}</h1>
      <div className="global-special-article-tags">{article.marketTags.map((tag) => <span key={tag}>{marketLabels[tag] ?? tag}</span>)}</div>
      <section className="global-special-article-conclusion"><span>专项结论</span><p>{article.conclusion}</p></section>
      <Link className="global-article-back-to-briefs" href="/briefs/"><ArrowLeft size={15} />返回全球简报</Link>
    </article>
  );
}

function isFullArticle(article: GlobalArticlePage | GlobalPublicArticle): article is GlobalArticlePage {
  return "keyFacts" in article && Array.isArray(article.keyFacts);
}

type Props =
  | { article: GlobalArticlePage; relatedSpecialReports?: GlobalArticlePage[]; data?: never }
  | { article: GlobalPublicArticle; data: GlobalMarketBriefPublic; relatedSpecialReports?: never };

export default function GlobalBriefArticleView({ article, data, relatedSpecialReports }: Props) {
  const full = isFullArticle(article);
  const fallbackData = data as GlobalMarketBriefPublic;
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
        {full ? <FullGlobalArticle article={article} relatedSpecialReports={relatedSpecialReports} /> : <><div className="global-brief-article-heading"><span><FileText size={14} />全球市场文章</span><small>文章摘要</small></div>{article.kind === "global_main" ? <GlobalMainBriefCard brief={article.article} variant="detail" /> : <SpecialSummaryArticle article={article.article} />}{article.kind === "global_main" && fallbackData.specialReports.length ? <SpecialReportSection reports={fallbackData.specialReports} /> : null}</>}
        <footer className="global-brief-article-footer"><p>{full ? `数据截至 ${article.dataAsOf}；本文仅作信息参考，不构成投资建议。` : "本文为全球市场文章摘要，仅作信息参考，不构成投资建议。"}</p><Link href="/briefs/">返回全球简报 <ArrowRight size={14} /></Link></footer>
      </main>
      <MobileBottomNav active="briefs" />
    </div>
  );
}
