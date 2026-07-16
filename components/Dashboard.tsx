"use client";

import {
  Activity,
  Bell,
  Calendar,
  ChevronRight,
  ExternalLink,
  FileText,
  Flame,
  Globe2,
  Home,
  Landmark,
  LayoutDashboard,
  Link as LinkIcon,
  Menu,
  Newspaper,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import ServiceWorkerRegister from "./ServiceWorkerRegister";
import type {
  BriefArticle,
  DailyBrief,
  MarketSection,
  SourceLink,
  Tone,
} from "@/lib/types";

const navItems = [
  { href: "#overview", label: "总览", icon: Home },
  { href: "#fed", label: "美联储", icon: Landmark },
  { href: "#markets", label: "三地市场", icon: Activity },
  { href: "#briefs", label: "简报", icon: Newspaper },
  { href: "#hotspots", label: "热点", icon: Flame },
  { href: "#sources", label: "来源", icon: LinkIcon },
];

const toneText: Record<Tone, string> = {
  positive: "偏积极",
  negative: "偏谨慎",
  neutral: "中性",
  warning: "需关注",
};

function formatEditionDate(date: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${date}T00:00:00+08:00`));
}

function formatCompactDate(date: string) {
  return date.replaceAll("-", ".");
}

function Sparkline({ values, tone }: { values: number[]; tone: Tone }) {
  const width = 280;
  const height = 92;
  const padding = 8;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = padding + (index / Math.max(values.length - 1, 1)) * (width - padding * 2);
    const y = padding + ((max - value) / range) * (height - padding * 2);
    return [x, y] as const;
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `${line} L${points.at(-1)?.[0]},${height - padding} L${points[0][0]},${height - padding} Z`;
  const color = tone === "positive" ? "#e45252" : tone === "negative" ? "#25a467" : "#8a6bd0";

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="最近十个交易日趋势">
      <defs>
        <linearGradient id={`spark-${tone}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.23" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${tone})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={points.at(-1)?.[0]} cy={points.at(-1)?.[1]} r="4.5" fill="#fff" stroke={color} strokeWidth="3" />
    </svg>
  );
}

function PolicyPathChart({ path }: { path: DailyBrief["federalReserve"]["path"] }) {
  const width = 680;
  const height = 230;
  const padding = { top: 18, right: 20, bottom: 42, left: 42 };
  const minY = 3.25;
  const maxY = 5.25;
  const x = (index: number) => padding.left + (index / (path.length - 1)) * (width - padding.left - padding.right);
  const y = (value: number) => padding.top + ((maxY - value) / (maxY - minY)) * (height - padding.top - padding.bottom);
  const upper = path.map((item, index) => [x(index), y(item.upper)] as const);
  const lower = path.map((item, index) => [x(index), y(item.lower)] as const);
  const upperLine = upper.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const lowerLine = lower.map(([px, py], index) => `${index === 0 ? "M" : "L"}${px},${py}`).join(" ");
  const area = `${upperLine} ${[...lower].reverse().map(([px, py]) => `L${px},${py}`).join(" ")} Z`;
  const ticks = [3.5, 4, 4.5, 5];

  return (
    <div className="policy-chart-wrap">
      <div className="chart-title-row">
        <div>
          <span className="eyebrow">POLICY PATH</span>
          <h3>目标利率区间路径</h3>
        </div>
        <span className="chart-unit">单位：%</span>
      </div>
      <svg className="policy-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="2024 年 9 月至 2026 年 6 月美联储目标利率区间路径">
        <defs>
          <linearGradient id="policy-area" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="#ff9585" stopOpacity="0.42" />
            <stop offset="0.5" stopColor="#f2d66e" stopOpacity="0.38" />
            <stop offset="1" stopColor="#9fe7a5" stopOpacity="0.48" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} stroke="#ebe7ee" strokeDasharray="4 6" />
            <text x={padding.left - 10} y={y(tick) + 4} textAnchor="end" className="axis-label">{tick.toFixed(1)}</text>
          </g>
        ))}
        <path d={area} fill="url(#policy-area)" />
        <path d={upperLine} fill="none" stroke="#1b191d" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={lowerLine} fill="none" stroke="#8b8790" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        {path.map((item, index) => (
          <g key={item.label}>
            <circle cx={x(index)} cy={y(item.upper)} r={index === path.length - 1 ? 5 : 3.5} fill={index === path.length - 1 ? "#1b191d" : "#fff"} stroke="#1b191d" strokeWidth="2" />
            <text x={x(index)} y={height - 15} textAnchor="middle" className="axis-label">{item.label}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function SourceLinks({ sources, compact = false }: { sources: SourceLink[]; compact?: boolean }) {
  return (
    <div className={`source-links ${compact ? "source-links-compact" : ""}`} aria-label="引用来源">
      <span className="source-prefix"><LinkIcon size={13} /> 引用</span>
      {sources.map((source) => (
        <a key={`${source.publisher}-${source.url}`} href={source.url} target="_blank" rel="noreferrer" title={`打开 ${source.publisher} 原文`}>
          {source.name}
          <ExternalLink size={12} />
        </a>
      ))}
    </div>
  );
}

function SectionHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

function MarketCard({ market }: { market: MarketSection }) {
  const lead = market.indices[0];
  const isUp = lead.change >= 0;
  return (
    <article className={`market-card tone-${market.tone}`}>
      <div className="market-card-head">
        <div>
          <span className="market-name">{market.name}</span>
          <span className="session-date">{formatCompactDate(market.sessionDate)} · {market.status}</span>
        </div>
        <span className={`tone-badge tone-badge-${market.tone}`}>{toneText[market.tone]}</span>
      </div>
      <div className="market-lead">
        <div>
          <span className="lead-label">{lead.name}</span>
          <strong>{lead.value}</strong>
          <span className={`change ${isUp ? "up" : "down"}`}>
            {isUp ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
            {isUp ? "+" : ""}{lead.change.toFixed(2)}%
          </span>
        </div>
        <Sparkline values={market.sparkline} tone={market.tone} />
      </div>
      <div className="sub-indices">
        {market.indices.slice(1).map((index) => (
          <div key={index.name}>
            <span>{index.name}</span>
            <strong>{index.value}</strong>
            <em className={index.change >= 0 ? "up" : "down"}>{index.change >= 0 ? "+" : ""}{index.change.toFixed(2)}%</em>
          </div>
        ))}
      </div>
      <p className="market-summary">{market.summary}</p>
      <SourceLinks sources={market.sources} compact />
    </article>
  );
}

function ArticleCard({ article, label }: { article: BriefArticle; label: string }) {
  return (
    <article className="brief-card">
      <div className="brief-date">
        <span>{formatCompactDate(article.publishedAt).slice(5)}</span>
        <small>{label}</small>
      </div>
      <div className="brief-content">
        <div className="brief-title-row">
          <h3>{article.title}</h3>
          <span className="source-count">{article.sources.length} 个来源</span>
        </div>
        <p>{article.summary}</p>
        <div className="impact-note">
          <Sparkles size={15} />
          <span><b>关注：</b>{article.impact}</span>
        </div>
        <div className="tag-row">
          {article.tags.map((tag) => <span key={tag}>#{tag}</span>)}
        </div>
        <SourceLinks sources={article.sources} />
      </div>
    </article>
  );
}

function HotspotCard({ item, rank }: { item: DailyBrief["hotspots"][number]; rank: number }) {
  return (
    <article className="hotspot-card">
      <div className="hotspot-rank">{String(rank + 1).padStart(2, "0")}</div>
      <div className="hotspot-body">
        <div className="hotspot-meta">
          <span>编辑优先级</span>
          <div className="priority-track"><i style={{ width: `${item.priority}%` }} /></div>
          <strong>{item.priority}</strong>
        </div>
        <h3>{item.title}</h3>
        <p>{item.summary}</p>
        <div className="affected-markets">
          {item.affectedMarkets.map((market) => <span key={market}>{market}</span>)}
        </div>
        <SourceLinks sources={item.sources} compact />
      </div>
    </article>
  );
}

export default function Dashboard({ data }: { data: DailyBrief }) {
  const [query, setQuery] = useState("");
  const [selectedMarket, setSelectedMarket] = useState("all");

  const articles = useMemo(() => {
    const combined = [
      ...data.federalReserve.articles.map((article) => ({ article, label: "美联储", market: "fed" })),
      ...data.markets.flatMap((market) => market.articles.map((article) => ({ article, label: market.shortName, market: market.id }))),
    ];
    const normalizedQuery = query.trim().toLowerCase();
    return combined.filter(({ article, market }) => {
      const matchesMarket = selectedMarket === "all" || selectedMarket === market;
      const haystack = `${article.title} ${article.summary} ${article.impact} ${article.tags.join(" ")}`.toLowerCase();
      return matchesMarket && (!normalizedQuery || haystack.includes(normalizedQuery));
    });
  }, [data, query, selectedMarket]);

  const filteredHotspots = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return data.hotspots;
    return data.hotspots.filter((item) => `${item.title} ${item.summary} ${item.tags.join(" ")} ${item.affectedMarkets.join(" ")}`.toLowerCase().includes(normalizedQuery));
  }, [data.hotspots, query]);

  return (
    <>
      <ServiceWorkerRegister />
      <div className="page-orb page-orb-one" />
      <div className="page-orb page-orb-two" />
      <aside className="sidebar" aria-label="主导航">
        <a className="brand-mark" href="#overview" aria-label="观潮首页">
          <Sparkles size={20} />
        </a>
        <nav>
          {navItems.map((item) => {
            const Icon = item.icon;
            return <a key={item.href} href={item.href} aria-label={item.label} data-tooltip={item.label}><Icon size={19} /></a>;
          })}
        </nav>
        <div className="sidebar-foot"><ShieldCheck size={18} /><span>来源可追溯</span></div>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div className="mobile-brand"><span><Sparkles size={17} /></span><b>观潮</b></div>
          <div className="title-lockup">
            <span className="eyebrow">DAILY MARKET INTELLIGENCE</span>
            <strong>观潮 · 每日市场情报</strong>
          </div>
          <label className="search-box">
            <Search size={17} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索政策、市场或热点…" aria-label="搜索简报" />
            {query ? <button type="button" onClick={() => setQuery("")} aria-label="清空搜索">×</button> : <kbd>⌘ K</kbd>}
          </label>
          <div className="topbar-actions">
            <span className="verified-pill"><i />{data.meta.status}</span>
            <button type="button" className="icon-button" onClick={() => window.location.reload()} aria-label="刷新页面"><RefreshCw size={17} /></button>
            <button type="button" className="icon-button notification-button" aria-label="通知"><Bell size={17} /><i /></button>
            <div className="avatar">AI</div>
          </div>
          <button className="mobile-menu" type="button" aria-label="打开导航"><Menu size={20} /></button>
        </header>

        <div className="dashboard-content">
          <section className="hero-grid" id="overview">
            <article className="hero-card">
              <div className="hero-orbit" aria-hidden="true"><span /><span /></div>
              <div className="hero-copy">
                <div className="hero-kicker"><Sparkles size={15} /> AI 每日精选 · {formatEditionDate(data.meta.editionDate)}</div>
                <h1>{data.meta.title}<br /><span>{data.meta.subtitle}</span></h1>
                <p>{data.meta.curationNote}</p>
              </div>
              <div className="pulse-panel">
                <div className="pulse-score">
                  <strong>{data.pulse.score}</strong><span>/ 100</span>
                  <small>{data.pulse.label}</small>
                </div>
                <div className="pulse-meter" aria-label={`风险信号 ${data.pulse.score} 分`}>
                  <div className="pulse-gradient" />
                  <i style={{ left: `${data.pulse.score}%` }} />
                </div>
                <p>{data.pulse.explanation}</p>
              </div>
              <div className="signal-strip">
                {data.pulse.signals.map((signal) => (
                  <div key={signal.label}>
                    <span>{signal.label}</span>
                    <strong className={`text-${signal.tone}`}>{signal.value}</strong>
                  </div>
                ))}
              </div>
            </article>

            <article className="fed-summary-card" id="fed">
              <div className="card-topline">
                <span className="icon-tile"><Landmark size={18} /></span>
                <div><span className="eyebrow">FEDERAL RESERVE</span><h2>美联储政策</h2></div>
                <span className={`tone-badge tone-badge-${data.federalReserve.stanceTone}`}>{data.federalReserve.stance}</span>
              </div>
              <div className="rate-display">
                <span>联邦基金目标利率</span>
                <strong>{data.federalReserve.targetRange}</strong>
                <small>截至 {formatCompactDate(data.federalReserve.lastDecisionDate)}</small>
              </div>
              <div className="decision-row">
                <div><span>最近决议</span><b>{data.federalReserve.lastDecision}</b></div>
                <div><span>下次会议</span><b>{data.federalReserve.nextMeeting}</b></div>
              </div>
              <div className="countdown-box">
                <Calendar size={18} />
                <span>距下次 FOMC 会议</span>
                <strong>{data.federalReserve.countdownDays}</strong>
                <small>天</small>
              </div>
              <p className="fed-takeaway">{data.federalReserve.takeaway}</p>
              <SourceLinks sources={data.federalReserve.articles[0].sources} compact />
            </article>
          </section>

          <section className="policy-card">
            <PolicyPathChart path={data.federalReserve.path} />
            <div className="policy-side">
              <span className="eyebrow">AI TAKEAWAY</span>
              <h2>今天怎样理解政策信号</h2>
              <div className="policy-points">
                {data.federalReserve.articles.map((article, index) => (
                  <div key={article.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div><strong>{article.title}</strong><p>{article.impact}</p></div>
                  </div>
                ))}
              </div>
              <a className="primary-link" href={data.federalReserve.articles[0].sources[0].url} target="_blank" rel="noreferrer">查看美联储原文 <ExternalLink size={14} /></a>
            </div>
          </section>

          <section id="markets" className="section-block">
            <SectionHeading eyebrow="THREE MARKETS" title="三地股市简报" description="每个市场使用各自最新完整交易日，避免盘中与收盘数据混用。" action={<span className="updated-label"><RefreshCw size={13} /> 数据截至 {formatCompactDate(data.meta.dataThrough)}</span>} />
            <div className="market-grid">
              {data.markets.map((market) => <MarketCard key={market.id} market={market} />)}
            </div>
          </section>

          <div className="content-grid">
            <section id="briefs" className="briefs-panel">
              <SectionHeading eyebrow="CURATED BRIEFS" title="今日精选简报" description="只保留会改变政策预期、风险偏好或行业定价的信息。" />
              <div className="filter-row" role="tablist" aria-label="简报市场筛选">
                {[
                  ["all", "全部"],
                  ["fed", "美联储"],
                  ["a-share", "A股"],
                  ["hk", "港股"],
                  ["us", "美股"],
                ].map(([value, label]) => (
                  <button key={value} type="button" className={selectedMarket === value ? "active" : ""} onClick={() => setSelectedMarket(value)} role="tab" aria-selected={selectedMarket === value}>{label}</button>
                ))}
              </div>
              <div className="brief-list">
                {articles.length ? articles.map(({ article, label }) => <ArticleCard key={article.id} article={article} label={label} />) : <div className="empty-state"><Search size={22} /><strong>没有找到相关简报</strong><p>换一个关键词或清除筛选条件。</p></div>}
              </div>
            </section>

            <aside className="right-rail">
              <section id="hotspots" className="hotspots-panel">
                <SectionHeading eyebrow="HOT TOPICS" title="近期热点" description="按对三地市场的潜在影响排序。" />
                <div className="hotspot-list">
                  {filteredHotspots.length ? filteredHotspots.map((item, index) => <HotspotCard key={item.id} item={item} rank={index} />) : <div className="empty-state compact"><Search size={20} /><strong>未找到相关热点</strong></div>}
                </div>
              </section>

              <section className="watchlist-panel">
                <div className="panel-title"><Calendar size={18} /><div><span className="eyebrow">WATCHLIST</span><h2>后续观察</h2></div></div>
                <div className="watchlist">
                  {data.watchlist.map((item) => (
                    <div key={`${item.time}-${item.title}`}>
                      <time>{item.time}</time>
                      <span className={`watch-dot tone-${item.tone}`} />
                      <div><strong>{item.title}</strong><p>{item.note}</p></div>
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>

          <section id="sources" className="sources-panel">
            <SectionHeading eyebrow="SOURCE LIBRARY" title="可信信息源" description="每日自动化从这里开始检索；重要结论仍需回到原始公告或官方文件。" action={<span className="source-standard"><ShieldCheck size={14} /> 可追溯引用</span>} />
            <div className="source-directory">
              {data.sourceDirectory.map((source) => (
                <a href={source.url} key={source.name} target="_blank" rel="noreferrer">
                  <span className={`source-tier tier-${source.tier}`}>{source.tier === "official" ? "官方" : source.tier === "authoritative" ? "权威" : "主流"}</span>
                  <div><strong>{source.name}</strong><small>{source.category}</small><p>{source.description}</p></div>
                  <ExternalLink size={15} />
                </a>
              ))}
            </div>
            <div className="methodology-box">
              <div className="methodology-title"><ShieldCheck size={19} /><div><strong>编辑与引用原则</strong><span>Automation guardrails</span></div></div>
              <ol>{data.methodology.map((rule) => <li key={rule}>{rule}</li>)}</ol>
            </div>
          </section>

          <footer>
            <div><span className="footer-mark"><Sparkles size={15} /></span><strong>观潮</strong><span>个人市场信息工作台</span></div>
            <p>本页面仅作信息整理，不构成投资建议。所有摘要请以引用原文为准。</p>
            <span>Edition {data.meta.editionDate}</span>
          </footer>
        </div>
      </main>

      <nav className="mobile-bottom-nav" aria-label="手机导航">
        {navItems.slice(0, 5).map((item) => {
          const Icon = item.icon;
          return <a key={item.href} href={item.href}><Icon size={19} /><span>{item.label === "三地市场" ? "市场" : item.label}</span></a>;
        })}
      </nav>
    </>
  );
}
