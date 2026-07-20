import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clock3,
  ExternalLink,
  FileText,
  Gauge,
  Link as LinkIcon,
  Route,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { EvidenceForecastPanel, GeneratedEditorialVisualFigure } from "@/components/ArticleEnhancements";
import MobileBottomNav, { type MobileNavView } from "@/components/MobileBottomNav";
import { SourceMeta, sourceMetaLabel } from "@/components/SourceLink";
import StructuredChartFigure from "@/components/StructuredChart";
import { countArticleCharacters, type ArticleRecord } from "@/lib/articles";
import type { BriefArticle, SourceLink, StructuredChart } from "@/lib/types";

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
          <a key={`${source.url}-${index}`} href={source.url} target="_blank" rel="noreferrer" title={`${source.name} · ${sourceMetaLabel(source)}`}>
            [{index + 1}]
          </a>
        );
      })}
    </span>
  );
}

function getStructuredCharts(article: BriefArticle): StructuredChart[] {
  if (article.detail.charts?.length) return article.detail.charts;
  const legacy = article.detail.chart;
  if (!legacy) return [];
  return [{
    type: legacy.items.some((item) => item.value < 0) ? "diverging-bar" : "bar",
    title: legacy.title,
    unit: legacy.unit,
    asOf: article.publishedAt,
    items: legacy.items,
    sourceIndexes: legacy.sourceIndexes,
  }];
}

const rotationStageLabel = {
  early: "早期扩散",
  accelerating: "加速",
  diverging: "高位分歧",
  fading: "退潮",
  rebound: "修复",
} as const;

const flowDirectionLabel = {
  inflow: "流入线索",
  outflow: "流出线索",
  mixed: "方向分化",
} as const;

const evidenceClassLabel = {
  official: "官方披露",
  "vendor-market-data": "数据商行情",
  "vendor-estimate": "数据商估算",
  proxy: "价格/资金代理",
} as const;

function formatRatio(value: number | undefined) {
  return Number.isFinite(value) ? `${value!.toFixed(2)}×` : "—";
}

const rotationBiasLabel = {
  strengthening: "偏强情景",
  range: "震荡情景",
  weakening: "转弱情景",
} as const;

const confidenceLabel = {
  low: "低置信度",
  medium: "中置信度",
  "medium-high": "中高置信度",
} as const;

function RotationRadar({ article }: { article: BriefArticle }) {
  const rotation = article.detail.rotationAnalysis;
  if (!rotation) return null;

  return (
    <section className="rotation-radar" aria-labelledby="rotation-radar-title">
      <header className="rotation-radar-heading">
        <div><span className="eyebrow">ROTATION RADAR</span><h2 id="rotation-radar-title">板块轮动与资金路径</h2></div>
        <span>{rotation.window === "5d_vs_20d" ? "近5日 vs 前20日" : rotation.window}</span>
      </header>

      <div className="rotation-regime">
        <Activity size={17} />
        <div><span>当前轮动阶段 · 截至 {rotation.asOf}</span><p>{rotation.regime}</p></div>
      </div>

      <div className="rotation-evidence-grid">
        <section className="rotation-subpanel">
          <h3><Gauge size={15} />近期明显放量</h3>
          {rotation.volumeStatus === "verified" && rotation.volumeLeaders.length ? (
            <div className="rotation-volume-list">
              {rotation.volumeLeaders.map((item) => (
                <div key={item.sector} className="rotation-volume-item">
                  <div><strong>{item.sector}</strong><span>{rotationStageLabel[item.stage]}</span></div>
                  <dl>
                    <div><dt>成交额比</dt><dd>{formatRatio(item.turnoverAmountRatio20d ?? item.turnoverRatio20d)}</dd></div>
                    <div><dt>成交量比</dt><dd>{formatRatio(item.tradingVolumeRatio20d)}</dd></div>
                    <div><dt>成交额份额比</dt><dd>{formatRatio(item.turnoverShareRatio20d)}</dd></div>
                    <div><dt>同口径样本</dt><dd>{Number.isFinite(item.historySessions) ? `${item.historySessions}日` : "—"}</dd></div>
                    <div><dt>上涨广度</dt><dd>{item.breadthPct.toFixed(0)}%</dd></div>
                    <div><dt>5日相对收益</dt><dd>{item.relativeReturn5d >= 0 ? "+" : ""}{item.relativeReturn5d.toFixed(1)}%</dd></div>
                    <div><dt>前三成交集中度</dt><dd>{item.top3ConcentrationPct.toFixed(0)}%</dd></div>
                  </dl>
                  <SourceRefs indexes={item.sourceIndexes} sources={article.sources} />
                </div>
              ))}
            </div>
          ) : (
            <div className="rotation-data-gap">
              <ShieldAlert size={16} />
              <p>{rotation.volumeStatus === "none" ? "按统一口径，近期未发现达到阈值的明显放量板块。" : "缺少可比的板块成交历史序列，本期不强行认定“明显放量”。"}</p>
            </div>
          )}
        </section>

        <section className="rotation-subpanel">
          <h3><Route size={15} />可观察资金线索</h3>
          <div className="rotation-flow-list">
            {rotation.flowSignals.map((signal) => (
              <div key={`${signal.sector}-${signal.direction}`}>
                <div><strong>{signal.sector}</strong><span className={`flow-${signal.direction}`}>{flowDirectionLabel[signal.direction]}</span></div>
                <p>{signal.evidence}<SourceRefs indexes={signal.sourceIndexes} sources={article.sources} /></p>
                <small>{evidenceClassLabel[signal.evidenceClass]}</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="rotation-outlooks">
        {rotation.outlooks.map((outlook) => {
          const isInsufficient = outlook.status === "insufficient";
          const candidateSectors = outlook.candidateSectors ?? [];
          return (
            <article key={outlook.horizon} className={isInsufficient ? "rotation-outlook-insufficient" : undefined}>
              <div className="rotation-outlook-topline">
                <span>{outlook.horizon === "1_5d" ? "未来 1–5 个交易日" : "未来 2–4 周"}</span>
                <div><b>{isInsufficient ? "证据不足" : rotationBiasLabel[outlook.bias]}</b><em>{confidenceLabel[outlook.confidence]}</em></div>
              </div>
              {candidateSectors.length ? <div className="rotation-sector-chips">{candidateSectors.map((sector) => <span key={sector}>{sector}</span>)}</div> : null}
              {isInsufficient ? <div className="rotation-outlook-reason"><ShieldAlert size={14} /><p>{outlook.reason}</p></div> : null}
              <p>{outlook.flowPath}<SourceRefs indexes={outlook.sourceIndexes} sources={article.sources} /></p>
              <dl>
                <div><dt>触发条件</dt><dd>{outlook.trigger}</dd></div>
                <div><dt>失效条件</dt><dd>{outlook.invalidation}</dd></div>
              </dl>
            </article>
          );
        })}
      </div>

      <p className="rotation-risk-note"><ShieldAlert size={14} />{rotation.riskNote}</p>
    </section>
  );
}

export default function ArticleReport({ record }: { record: ArticleRecord }) {
  const { article } = record;
  const charts = getStructuredCharts(article);
  const forecasts = article.detail.evidenceForecast
    ? (Array.isArray(article.detail.evidenceForecast) ? article.detail.evidenceForecast : [article.detail.evidenceForecast])
    : [];
  const characterCount = countArticleCharacters(article);
  const readingMinutes = Math.max(2, Math.ceil(characterCount / 350));
  const activeNav: MobileNavView = record.sectionId === "fed" ? "overview" : record.sectionId === "hotspot" ? "hotspots" : "markets";

  return (
    <div className="article-shell">
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

          {article.detail.visual ? <GeneratedEditorialVisualFigure visual={article.detail.visual} sources={article.sources} /> : null}

          <section className="article-key-points" aria-labelledby="key-points-title">
            <div><span className="eyebrow">KEY POINTS</span><h2 id="key-points-title">先看结论</h2></div>
            <ul>
              {article.detail.keyPoints.map((point) => <li key={point}><CheckCircle2 size={16} /><span>{point}</span></li>)}
            </ul>
          </section>

          {charts.length ? (
            <div className="article-structured-charts">
              {charts.map((chart, index) => <StructuredChartFigure key={`${chart.type}-${chart.title}-${index}`} chart={chart} sources={article.sources} />)}
            </div>
          ) : null}

          <RotationRadar article={article} />

          {forecasts.map((forecast) => <EvidenceForecastPanel key={forecast.id} forecast={forecast} sources={article.sources} />)}

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
                    <div><strong>{source.name}</strong><SourceMeta source={source} /></div>
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
