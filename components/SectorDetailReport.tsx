import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  ExternalLink,
  Layers3,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import Link from "next/link";
import MobileBottomNav from "@/components/MobileBottomNav";
import { SourceMeta, sourceMetaLabel } from "@/components/SourceLink";
import type { SectorDetail, SectorDetailMarket, SourceLink } from "@/lib/types";

function formatDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value || "—";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Shanghai",
  }).format(new Date(`${value}T00:00:00+08:00`));
}

function SourceRefs({ indexes, sources }: { indexes: number[]; sources: SourceLink[] }) {
  const validIndexes = [...new Set(indexes)].filter((index) => sources[index]);
  if (!validIndexes.length) return null;
  return (
    <span className="sector-detail-inline-refs" aria-label="本段引用">
      {validIndexes.map((index) => {
        const source = sources[index];
        return (
          <a
            key={`${source.url}-${index}`}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            title={`${source.name} · ${sourceMetaLabel(source)}`}
          >
            [{index + 1}]
          </a>
        );
      })}
    </span>
  );
}

function ConstituentWeights({ detail }: { detail: SectorDetail }) {
  const snapshot = detail.constituents;
  const items = snapshot.items
    .filter((item) => Number.isFinite(item.weightPct) && item.weightPct >= 0 && item.weightPct <= 100)
    .sort((left, right) => right.weightPct - left.weightPct);
  const displayedWeight = items.reduce((sum, item) => sum + item.weightPct, 0);

  return (
    <figure className="sector-constituent-card" aria-labelledby="sector-constituent-title">
      <figcaption>
        <div>
          <span className="eyebrow">CONSTITUENTS</span>
          <h2 id="sector-constituent-title">代表性成分与权重</h2>
        </div>
        <span>{snapshot.scope}</span>
      </figcaption>

      <div className="sector-constituent-meta">
        <span>截至 {formatDate(snapshot.asOf)}</span>
        <span>单位：%</span>
        {snapshot.totalConstituents ? <span>完整样本 {snapshot.totalConstituents} 只</span> : null}
        {items.length ? <strong>展示合计约 {displayedWeight.toFixed(2)}%</strong> : null}
      </div>

      {items.length ? (
        <ol
          className="sector-constituent-list"
          aria-label={`${detail.name}${snapshot.scope}权重，条形长度按百分之百刻度显示`}
        >
          {items.map((item, index) => (
            <li key={`${item.code}-${item.name}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div className="sector-constituent-name">
                <strong>{item.name}</strong>
                <small>{item.code}</small>
              </div>
              <div className="sector-weight-track" aria-hidden="true">
                <i style={{ width: `${Math.min(100, item.weightPct)}%` }} />
              </div>
              <b>{item.weightPct.toFixed(2)}%</b>
              {item.sourceIndexes?.length ? <SourceRefs indexes={item.sourceIndexes} sources={detail.sources} /> : null}
            </li>
          ))}
        </ol>
      ) : (
        <div className="sector-detail-gap" role="status">
          <ShieldAlert size={17} />
          <p>本期没有可核验的成分权重，页面不会用估算值补位。</p>
        </div>
      )}

      <div className="sector-constituent-note">
        <p>{snapshot.weightingMethod}。{snapshot.note}</p>
        <SourceRefs indexes={snapshot.sourceIndexes} sources={detail.sources} />
      </div>
    </figure>
  );
}

function EvidenceList({
  title,
  kind,
  items,
  sources,
}: {
  title: string;
  kind: "driver" | "risk";
  items: SectorDetail["drivers"];
  sources: SourceLink[];
}) {
  return (
    <section className={`sector-evidence-panel ${kind}`}>
      <h2>{kind === "driver" ? <Layers3 size={17} /> : <ShieldAlert size={17} />}{title}</h2>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${item.title}-${index}`}>
              <strong>{item.title}</strong>
              <p>{item.detail}<SourceRefs indexes={item.sourceIndexes} sources={sources} /></p>
            </li>
          ))}
        </ul>
      ) : <p className="sector-evidence-empty">本期未形成可核验条目。</p>}
    </section>
  );
}

export default function SectorDetailReport({ market, detail }: { market: SectorDetailMarket; detail: SectorDetail }) {
  return (
    <div className="sector-detail-shell">
      <div className="page-orb page-orb-one" />
      <div className="page-orb page-orb-two" />

      <header className="article-topbar sector-detail-topbar">
        <Link className="article-back-link" href="/markets"><ArrowLeft size={16} />返回三地市场</Link>
        <Link className="article-wordmark" href="/">观潮</Link>
        <span className="article-topbar-label">板块研究卡</span>
      </header>

      <main className="sector-detail-page">
        <article className="sector-detail-report">
          <header className="sector-detail-hero">
            <div className="sector-detail-kicker">
              <span>{market.label}</span>
              <code>{detail.code}</code>
              <time dateTime={market.asOf}>截至 {formatDate(market.asOf)}</time>
            </div>
            <h1>{detail.name}</h1>
            {detail.aliases?.length ? <p className="sector-detail-alias">亦称：{detail.aliases.join("、")}</p> : null}
            <p className="sector-detail-lead">{detail.description}<SourceRefs indexes={detail.sourceIndexes} sources={detail.sources} /></p>
            <div className="sector-detail-taxonomy">
              <span>{market.taxonomy.owner}</span>
              <strong>{market.taxonomy.name}</strong>
              <span>{market.taxonomy.version}</span>
            </div>
          </header>

          <ConstituentWeights detail={detail} />

          <section className="sector-style-card" aria-labelledby="sector-style-title">
            <header>
              <div><span className="eyebrow">STYLE PROFILE</span><h2 id="sector-style-title">这个板块是什么风格</h2></div>
              <SlidersHorizontal size={18} />
            </header>
            {detail.styleTags.length ? <div className="sector-style-tags">{detail.styleTags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
            <p>{detail.styleSummary}<SourceRefs indexes={detail.sourceIndexes} sources={detail.sources} /></p>
            {detail.styleTraits.length ? (
              <dl className="sector-style-traits">
                {detail.styleTraits.map((trait) => (
                  <div key={trait.label}>
                    <dt>{trait.label}</dt>
                    <dd><strong>{trait.assessment}</strong><span>{trait.explanation}<SourceRefs indexes={trait.sourceIndexes} sources={detail.sources} /></span></dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>

          <div className="sector-evidence-grid">
            <EvidenceList title="主要驱动" kind="driver" items={detail.drivers} sources={detail.sources} />
            <EvidenceList title="需要留意的风险" kind="risk" items={detail.risks} sources={detail.sources} />
          </div>

          <section className="sector-detail-sources" aria-labelledby="sector-detail-sources-title">
            <div className="sector-detail-sources-heading">
              <div><span className="eyebrow">SOURCES</span><h2 id="sector-detail-sources-title">定义、权重与解释依据</h2></div>
              <span>{detail.sources.length} 个来源</span>
            </div>
            <ol>
              {detail.sources.map((source, index) => (
                <li key={`${source.url}-${index}`}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <a href={source.url} target="_blank" rel="noreferrer">
                    <div><strong>{source.name}</strong><SourceMeta source={source} /></div>
                    <ExternalLink size={15} />
                  </a>
                </li>
              ))}
            </ol>
          </section>

          <footer className="sector-detail-footer">
            <div><BarChart3 size={15} /><p>{market.dataNote ? `${market.dataNote} ` : ""}成分权重是指数在所示日期的结构快照，不代表资金正在买入，也不是持仓建议；风格与驱动用于理解板块，不改变轮动模型原始排名。</p></div>
            <Link href="/markets">返回轮动排名<ArrowRight size={15} /></Link>
          </footer>
        </article>
      </main>

      <MobileBottomNav active="markets" />
    </div>
  );
}
