import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Link as LinkIcon,
} from "lucide-react";
import Link from "next/link";
import ServiceWorkerRegister from "@/components/ServiceWorkerRegister";
import MobileBottomNav, { type MobileNavView } from "@/components/MobileBottomNav";
import { countArticleCharacters, type ArticleRecord } from "@/lib/articles";
import type { BriefArticle, SourceLink } from "@/lib/types";

function formatArticleDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function SourceRefs({ indexes, sources }: { indexes: number[]; sources: SourceLink[] }) {
  return (
    <span className="article-inline-refs" aria-label="本段引用">
      {[...new Set(indexes)].map((index) => {
        const source = sources[index];
        if (!source) return null;
        return (
          <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" title={source.name}>
            [{index + 1}]
          </a>
        );
      })}
    </span>
  );
}

function DetailChart({ article }: { article: BriefArticle }) {
  const chart = article.detail.chart;
  if (!chart) return null;
  const maxValue = Math.max(...chart.items.map((item) => Math.abs(item.value)), 1);

  return (
    <figure className="article-chart-card">
      <figcaption>
        <div><BarChart3 size={17} /><strong>{chart.title}</strong></div>
        <span>{chart.unit}</span>
      </figcaption>
      <div className="article-bars">
        {chart.items.map((item) => (
          <div className="article-bar-row" key={`${item.label}-${item.display}`}>
            <span>{item.label}</span>
            <div className="article-bar-track">
              <i className={`tone-${item.tone}`} style={{ width: item.value === 0 ? "0" : `${Math.max(3, Math.abs(item.value) / maxValue * 100)}%` }} />
            </div>
            <strong>{item.display}</strong>
          </div>
        ))}
      </div>
      <p>图表数据来源 <SourceRefs indexes={chart.sourceIndexes} sources={article.sources} /></p>
    </figure>
  );
}

export default function ArticleReport({ record }: { record: ArticleRecord }) {
  const { article } = record;
  const characterCount = countArticleCharacters(article);
  const readingMinutes = Math.max(2, Math.ceil(characterCount / 350));
  const activeNav: MobileNavView = record.sectionId === "fed" ? "fed" : record.sectionId === "hotspot" ? "hotspots" : "markets";

  return (
    <div className="article-shell">
      <ServiceWorkerRegister />
      <div className="page-orb page-orb-one" />
      <div className="page-orb page-orb-two" />

      <header className="article-topbar">
        <Link className="article-back-link" href={record.backHref}><ArrowLeft size={16} />{record.backLabel}</Link>
        <Link className="article-wordmark" href="/">观潮</Link>
        <span className="article-topbar-label">每日市场简报</span>
      </header>

      <main className="article-page">
        <article className="article-report">
          <header className="article-report-header">
            <div className="article-kicker-row">
              <span>{record.category}</span>
              <time dateTime={article.publishedAt}>{formatArticleDate(article.publishedAt)}</time>
            </div>
            <h1>{article.title}</h1>
            <p className="article-lead">{article.detail.lead}</p>
            <div className="article-reading-meta">
              <span><Clock3 size={14} />约 {readingMinutes} 分钟</span>
              <span><FileText size={14} />正文 {characterCount} 字</span>
              <span><LinkIcon size={14} />{article.sources.length} 个可追溯来源</span>
            </div>
          </header>

          <section className="article-key-points" aria-labelledby="key-points-title">
            <div><span className="eyebrow">KEY POINTS</span><h2 id="key-points-title">先看结论</h2></div>
            <ul>
              {article.detail.keyPoints.map((point) => <li key={point}><CheckCircle2 size={16} /><span>{point}</span></li>)}
            </ul>
          </section>

          <DetailChart article={article} />

          <div className="article-body">
            {article.detail.sections.map((section) => (
              <section key={section.heading}>
                <h2>{section.heading}</h2>
                <p>{section.body}<SourceRefs indexes={section.sourceIndexes} sources={article.sources} /></p>
              </section>
            ))}
          </div>

          <aside className="article-impact-box">
            <span>市场观察</span>
            <p>{article.impact}</p>
          </aside>

          <div className="article-tags">{article.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>

          <section className="article-sources" aria-labelledby="article-sources-title">
            <div className="article-sources-heading">
              <div><span className="eyebrow">SOURCES</span><h2 id="article-sources-title">引用与原文</h2></div>
              <span>点击跳转源网站</span>
            </div>
            <ol>
              {article.sources.map((source, index) => (
                <li key={source.url}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    <div><strong>{source.name}</strong><small>{source.publisher} · {source.tier === "official" ? "官方" : source.tier === "authoritative" ? "权威" : "主流媒体"}</small></div>
                    <ExternalLink size={15} />
                  </a>
                </li>
              ))}
            </ol>
          </section>

          <footer className="article-report-footer">
            <p>本文为 AI 辅助整理的原创中文简报，事实以所列原始来源为准，不构成投资建议。</p>
            <Link href={record.backHref}>{record.backLabel}<ArrowRight size={15} /></Link>
          </footer>
        </article>
      </main>
      <MobileBottomNav active={activeNav} />
    </div>
  );
}
