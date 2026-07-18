import { ArrowLeft, CalendarDays, ExternalLink, Gauge, Layers3, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { GeneratedEditorialVisualFigure } from "@/components/ArticleEnhancements";
import MobileBottomNav from "@/components/MobileBottomNav";
import { SourceMeta, sourceMetaLabel } from "@/components/SourceLink";
import StructuredChart from "@/components/StructuredChart";
import type { WeeklyReport } from "@/lib/types";

const confidenceLabel = { low: "低", medium: "中", "medium-high": "中高" } as const;

function formatDate(value: string) {
  return value.replaceAll("-", ".");
}

function SourceRefs({ ids, report }: { ids: string[]; report: WeeklyReport }) {
  const positions = new Map(report.sources.map((source, index) => [source.id, index + 1]));
  return <span className="weekly-inline-refs">{[...new Set(ids)].map((id) => {
    const source = report.sources.find((item) => item.id === id);
    if (!source) return null;
    return <a key={id} href={source.url} target="_blank" rel="noreferrer" title={`${source.name} · ${sourceMetaLabel(source)}`}>[{positions.get(id)}]</a>;
  })}</span>;
}

export default function WeeklyReportView({ data }: { data: WeeklyReport }) {
  const { report } = data;
  return (
    <div className="weekly-shell">
      <header className="weekly-topbar">
        <Link href="/weekly/"><ArrowLeft size={15} />全部周报</Link>
        <Link href="/" className="weekly-wordmark">观潮</Link>
        <span>每周市场情报</span>
      </header>
      <main className="weekly-page">
        <article className="weekly-report">
          <header className="weekly-hero">
            <div className="weekly-hero-meta"><span>WEEKLY REPORT</span><time>{formatDate(report.weekStart)} — {formatDate(report.weekEnd)}</time></div>
            <h1>{report.title}</h1>
            <p>{report.subtitle}</p>
            <div className="weekly-coverage">
              {report.coverage.map((item) => <div key={item.scope}><span>{item.scope === "fed" ? "美联储" : item.scope === "a-share" ? "A股" : item.scope === "hk" ? "港股" : "美股"}</span><strong>截至 {formatDate(item.dataThrough)}</strong><small>{item.note || (item.status === "complete" ? "完整周度数据" : "数据覆盖有限")}</small></div>)}
            </div>
          </header>

          <section className="weekly-executive">
            <div className="weekly-score"><span>编辑重要度</span><strong>{data.executiveSummary.editorialScore}</strong><small>/ 100</small></div>
            <div><span className="eyebrow">EXECUTIVE SUMMARY</span><h2>一周核心判断</h2><p>{data.executiveSummary.weekVerdict}</p></div>
          </section>

          <section className="weekly-takeaways">
            {data.executiveSummary.keyTakeaways.map((item, index) => <article key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{item.title}</strong><p>{item.summary}<SourceRefs ids={item.sourceIds} report={data} /></p></div><b>{item.importance}</b></article>)}
          </section>

          {data.visual ? <div className="weekly-editorial-visual"><GeneratedEditorialVisualFigure visual={data.visual} sources={data.sources} /></div> : null}

          {data.charts?.length ? (
            <section className="weekly-chart-section" aria-labelledby="weekly-chart-title">
              <div className="weekly-section-heading"><div><span className="eyebrow">DATA VIEWS</span><h2 id="weekly-chart-title">本周关键图表</h2></div><Gauge size={20} /></div>
              <div className="weekly-chart-grid">{data.charts.map((chart, index) => <StructuredChart key={`${chart.type}-${chart.title}-${index}`} chart={chart} sources={data.sources} />)}</div>
            </section>
          ) : null}

          <section className="weekly-section" id="major-events">
            <div className="weekly-section-heading"><div><span className="eyebrow">MAJOR EVENTS</span><h2>本周大事</h2></div><CalendarDays size={20} /></div>
            <div className="weekly-event-list">
              {data.majorEvents.map((event) => <article id={event.id} key={event.id}><div className="weekly-event-top"><time>{formatDate(event.date)}</time><span>重要度 {event.importance}</span><em>{confidenceLabel[event.confidence]}置信度</em></div><h3>{event.title}</h3><ul>{event.facts.map((fact) => <li key={fact.text}>{fact.text}<SourceRefs ids={fact.sourceIds} report={data} /></li>)}</ul><div className="weekly-why"><strong>为什么重要</strong><p>{event.whyItMatters}<SourceRefs ids={event.basisSourceIds} report={data} /></p></div></article>)}
            </div>
          </section>

          <section className="weekly-section" id="high-value">
            <div className="weekly-section-heading"><div><span className="eyebrow">HIGH-VALUE INSIGHTS</span><h2>高含金量洞察</h2></div><Sparkles size={20} /></div>
            <div className="weekly-insight-grid">
              {data.highValueInsights.map((item) => <article id={item.id} key={item.id}><div><span>{confidenceLabel[item.confidence]}置信度</span><Gauge size={16} /></div><h3>{item.title}</h3><p>{item.insight}</p><ul>{item.evidence.map((fact) => <li key={fact.text}>{fact.text}<SourceRefs ids={fact.sourceIds} report={data} /></li>)}</ul><dl><div><dt>价值所在</dt><dd>{item.whyHighValue}</dd></div><div><dt>反向证据</dt><dd>{item.counterEvidence.map((fact) => fact.text).join("；") || "暂未发现足以推翻的独立证据"}</dd></div><div><dt>下周验证</dt><dd>{item.watchNext}</dd></div></dl></article>)}
            </div>
          </section>

          <section className="weekly-section" id="markets">
            <div className="weekly-section-heading"><div><span className="eyebrow">MARKET MAP</span><h2>三地市场与资金路径</h2></div><Layers3 size={20} /></div>
            <div className="weekly-market-grid">
              {data.markets.map((market) => <article key={market.id} id={`weekly-${market.id}`}><div className="weekly-market-title"><span>{market.label}</span><em>{confidenceLabel[market.confidence]}置信度</em></div><h3>{market.weeklyPerformance}</h3><p>{market.summary}<SourceRefs ids={market.sourceIds} report={data} /></p><dl><div><dt>板块轮动</dt><dd>{market.rotation}</dd></div><div><dt>资金线索</dt><dd>{market.capitalFlow}</dd></div><div><dt>下周情景</dt><dd>{market.nextWeekScenario}</dd></div><div><dt>触发</dt><dd>{market.trigger}</dd></div><div><dt>失效</dt><dd>{market.invalidation}</dd></div></dl></article>)}
            </div>
          </section>

          <section className="weekly-section" id="cross-market">
            <div className="weekly-section-heading"><div><span className="eyebrow">CROSS-MARKET</span><h2>跨市场主线</h2></div><ShieldCheck size={20} /></div>
            <div className="weekly-theme-list">{data.crossMarketThemes.map((theme) => <article key={theme.id} id={theme.id}><h3>{theme.title}</h3><p>{theme.thesis}<SourceRefs ids={theme.sourceIds} report={data} /></p><ol>{theme.causalChain.map((step) => <li key={step}>{step}</li>)}</ol><div><span>反向证据：{theme.counterEvidence}</span><strong>下个信号：{theme.nextSignal}</strong></div></article>)}</div>
          </section>

          <section className="weekly-section weekly-calendar" id="next-week">
            <div className="weekly-section-heading"><div><span className="eyebrow">NEXT WEEK</span><h2>下周重要日历</h2></div><CalendarDays size={20} /></div>
            <div>{data.nextWeekCalendar.map((item) => <article key={item.id}><time>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }).format(new Date(item.startsAt))}</time><span className={`importance-${item.importance}`} /><div><strong>{item.title}</strong><p>{item.whyWatch}<SourceRefs ids={item.sourceIds} report={data} /></p></div></article>)}</div>
          </section>

          <section className="weekly-local-note"><span>LOCAL SYNTHESIS</span><p>{data.localSynthesis.note}</p><small>已使用 {data.localSynthesis.editionDates.length} 个日报版本、{data.localSynthesis.archiveSnapshots} 份本地快照；本地线索仍需回查上游原始来源。</small></section>

          <section className="weekly-sources">
            <div className="weekly-section-heading"><div><span className="eyebrow">SOURCES</span><h2>引用与原文</h2></div><span>{data.sources.length} 个来源</span></div>
            <ol>{data.sources.map((source, index) => <li key={source.id}><span>{String(index + 1).padStart(2, "0")}</span><a href={source.url} target="_blank" rel="noreferrer"><div><strong>{source.name}</strong><SourceMeta source={source} /></div><ExternalLink size={14} /></a></li>)}</ol>
          </section>
        </article>
      </main>
      <MobileBottomNav active="briefs" />
    </div>
  );
}
