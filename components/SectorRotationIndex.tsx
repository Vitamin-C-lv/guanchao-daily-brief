"use client";

import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ExternalLink,
  Gauge,
  Minus,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type {
  MarketSection,
  SectorRotationConfidence,
  SectorRotationChart,
  SectorRotationCandlestickPoint,
  SectorRotationForecastDirection,
  SectorRotationForecastHorizon,
  SectorRotationForecastItem,
  SectorRotationIndex as SectorRotationIndexData,
  SectorRotationMarket,
  SectorRotationObservedDirection,
  SectorRotationObservedHorizon,
  SectorRotationObservedItem,
  SectorRotationLineSeries,
  SourceLink,
} from "@/lib/types";

export type HorizonKey = "current" | "oneWeek" | "oneMonth";

function sectorDetailHref(market: SectorRotationMarket, code: string | undefined, detailKeys: ReadonlySet<string>) {
  if (!code || market.id === "us" || !detailKeys.has(`${market.id}:${code}`)) return null;
  return `/markets/sectors/${market.id}/${encodeURIComponent(code)}`;
}

function SectorCardLink({ href, sector }: { href: string; sector: string }) {
  return (
    <Link className="rotation-card-link" href={href} aria-label={`查看${sector}板块构成与风格说明`}>
      <span>详情</span><ChevronRight size={13} aria-hidden="true" />
    </Link>
  );
}

function compactRankingItems<T extends { rank: number; code?: string; sector: string }>(items: T[], top = 3, bottom = 2) {
  const selected = [...items.slice(0, top), ...items.slice(-bottom)];
  const seen = new Set<string>();
  return selected
    .filter((item) => {
      const key = item.code ?? item.sector;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.rank - right.rank);
}

const horizonTabs: Array<{ key: HorizonKey; label: string; caption: string }> = [
  { key: "current", label: "当前", caption: "观测" },
  { key: "oneWeek", label: "一周内", caption: "5 个交易日" },
  { key: "oneMonth", label: "一个月内", caption: "20 个交易日" },
];

const observedDirectionLabel: Record<SectorRotationObservedDirection, string> = {
  leading: "领先",
  strengthening: "增强",
  neutral: "中性",
  weakening: "转弱",
  lagging: "落后",
};

const forecastDirectionLabel: Record<SectorRotationForecastDirection, string> = {
  "strong-up": "显著偏强",
  up: "偏强",
  range: "震荡",
  down: "偏弱",
  "strong-down": "显著偏弱",
};

const confidenceLabel: Record<SectorRotationConfidence, string> = {
  low: "低置信度",
  medium: "中置信度",
  "medium-high": "中高置信度",
};

function formatDate(date: string) {
  return date ? date.replaceAll("-", ".") : "—";
}

function SourceRefs({ indexes, sources }: { indexes: number[]; sources: SourceLink[] }) {
  const validIndexes = Array.from(new Set(indexes)).filter((index) => sources[index]);
  if (!validIndexes.length) return null;
  return (
    <span className="rotation-source-refs" aria-label="依据来源">
      {validIndexes.map((index) => (
        <a
          key={`${index}-${sources[index].url}`}
          href={sources[index].url}
          target="_blank"
          rel="noreferrer"
          aria-label={`打开来源 ${index + 1}：${sources[index].name}`}
          title={`${sources[index].publisher} · ${sources[index].name}`}
        >
          [{index + 1}]<ExternalLink size={9} />
        </a>
      ))}
    </span>
  );
}

function ScoreBar({ score, forecast = false }: { score: number; forecast?: boolean }) {
  const safeScore = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
  return (
    <div className="rotation-score" aria-label={`${forecast ? "条件排序分" : "轮动排序分"} ${safeScore.toFixed(0)}`}>
      <span><i style={{ width: `${safeScore}%` }} /></span>
      <strong>{safeScore.toFixed(0)}</strong>
    </div>
  );
}

type RotationChartItem = SectorRotationObservedItem | SectorRotationForecastItem;

function chartSourceIndexes(item: RotationChartItem) {
  if ("sourceIndexes" in item) return item.sourceIndexes;
  return [...item.evidence, ...item.counterEvidence].flatMap((point) => point.sourceIndexes);
}

function parseComparableMetric(value: string) {
  const normalized = value.trim().replaceAll(",", "").replaceAll("％", "%");
  const match = normalized.match(/^\+?(\d+(?:\.\d+)?)\s*(%|x|X|倍|亿元|亿|万亿元|万手|手)$/);
  if (!match) return null;
  const numericValue = Number(match[1]);
  if (!Number.isFinite(numericValue) || numericValue < 0) return null;
  return { numericValue, unit: match[2].toLowerCase(), display: value };
}

function comparableVolumeMetric(items: SectorRotationObservedItem[]) {
  const volumePattern = /(成交额|成交量|量能|turnover|volume)/i;
  const candidateLabels = Array.from(new Set(items.flatMap((item) => item.metrics.map((metric) => metric.label))))
    .filter((label) => volumePattern.test(label));

  for (const label of candidateLabels) {
    const rows = items.flatMap((item) => {
      const metric = item.metrics.find((candidate) => candidate.label === label);
      const parsed = metric ? parseComparableMetric(metric.value) : null;
      return parsed ? [{ sector: item.sector, ...parsed }] : [];
    });
    if (rows.length < 2) continue;
    if (new Set(rows.map((row) => row.unit)).size !== 1) continue;
    return { label, rows };
  }
  return null;
}

function RotationRankingChart({
  items,
  market,
  asOf,
  forecast = false,
}: {
  items: RotationChartItem[];
  market: SectorRotationMarket;
  asOf: string;
  forecast?: boolean;
}) {
  const visibleItems = market.mode === "major-index" ? items.slice(0, 3) : compactRankingItems(items);
  const scopeLabel = market.mode === "major-index"
    ? "三大指数"
    : items.length > 5
      ? "Top 3 / Bottom 2"
      : `${visibleItems.length} 项可用数据`;
  const sourceIndexes = visibleItems.flatMap(chartSourceIndexes);
  const volumeMetric = forecast
    ? null
    : comparableVolumeMetric(visibleItems.filter((item): item is SectorRotationObservedItem => "metrics" in item));

  return (
    <figure className="rotation-summary-chart">
      <figcaption>
        <div>
          <strong>{forecast ? "条件情景排名" : "当前相对强弱"}</strong>
          <span>截至 {formatDate(asOf)} · {scopeLabel}</span>
        </div>
        <em>综合分 / 100</em>
      </figcaption>
      <div
        className="rotation-chart-bars"
        role="img"
        aria-label={`${forecast ? "预测条件" : "当前观测"}综合分横向排名图，综合分不是收益率或上涨概率`}
      >
        {visibleItems.map((item) => {
          const score = Math.max(0, Math.min(100, Number.isFinite(item.score) ? item.score : 0));
          return (
            <div key={`chart-${item.rank}-${item.code ?? item.sector}`} className={`rotation-chart-row direction-${item.direction}`}>
              <span title={item.sector}>{item.sector}</span>
              <i><b style={{ width: `${score}%` }} /></i>
              <strong>{score.toFixed(0)}</strong>
            </div>
          );
        })}
      </div>
      <div className="rotation-chart-note">
        <span>综合分仅用于横截面排序，不是收益率、上涨概率或交易指令。</span>
        <SourceRefs indexes={sourceIndexes} sources={market.sources} />
      </div>
      {volumeMetric ? (
        <div className="rotation-volume-chart">
          <div><strong>{volumeMetric.label}</strong><span>同名、同单位原始值相对缩放</span></div>
          {volumeMetric.rows.map((row) => {
            const max = Math.max(...volumeMetric.rows.map((candidate) => candidate.numericValue), 1);
            return (
              <div className="rotation-volume-row" key={`${volumeMetric.label}-${row.sector}`}>
                <span>{row.sector}</span>
                <i><b style={{ width: `${(row.numericValue / max) * 100}%` }} /></i>
                <strong>{row.display}</strong>
              </div>
            );
          })}
        </div>
      ) : null}
    </figure>
  );
}

const SVG_WIDTH = 680;
const SVG_HEIGHT = 244;
const SVG_PADDING = { top: 20, right: 18, bottom: 30, left: 54 };

function isExactDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasStrictDates(points: Array<{ date: string }>, asOf: string) {
  return points.length >= 2
    && points.every((point, index) => isExactDate(point.date) && (index === 0 || point.date > points[index - 1].date))
    && points.at(-1)?.date === asOf;
}

function chartIsRenderable(chart: SectorRotationChart, asOf: string, sourceCount: number) {
  if (!chart.title.trim() || !chart.unit.trim() || !chart.note.trim() || chart.asOf !== asOf || !isExactDate(chart.asOf)) return false;
  if (!chart.sourceIndexes.length || new Set(chart.sourceIndexes).size !== chart.sourceIndexes.length) return false;
  if (chart.sourceIndexes.some((index) => !Number.isInteger(index) || index < 0 || index >= sourceCount)) return false;
  if (chart.type === "line") {
    return chart.series.length >= 1
      && chart.series.length <= 4
      && new Set(chart.series.map((series) => series.name.trim().toLowerCase())).size === chart.series.length
      && chart.series.every((series) => series.name.trim()
        && series.points.length >= 2
        && series.points.length <= 60
        && hasStrictDates(series.points, chart.asOf)
        && series.points.every((point) => Number.isFinite(point.value)));
  }
  return chart.points.length >= 2
    && chart.points.length <= 60
    && hasStrictDates(chart.points, chart.asOf)
    && chart.points.every((point) => [point.open, point.high, point.low, point.close].every(Number.isFinite)
      && point.high >= Math.max(point.open, point.close)
      && point.low <= Math.min(point.open, point.close));
}

function formatChartValue(value: number) {
  if (Math.abs(value) >= 1_000_000_000) return value.toExponential(2);
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function scaledYMapper(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const magnitude = Math.max(Math.abs(min), Math.abs(max), 1);
  const scaledMin = min / magnitude;
  const scaledMax = max / magnitude;
  const span = scaledMax - scaledMin || 1;
  const plotHeight = SVG_HEIGHT - SVG_PADDING.top - SVG_PADDING.bottom;
  return {
    min,
    max,
    y: (value: number) => SVG_PADDING.top + ((scaledMax - value / magnitude) / span) * plotHeight,
  };
}

function ChartGrid({ min, max }: { min: number; max: number }) {
  const plotHeight = SVG_HEIGHT - SVG_PADDING.top - SVG_PADDING.bottom;
  return (
    <g className="rotation-svg-grid" aria-hidden="true">
      {[0, 0.5, 1].map((ratio) => {
        const y = SVG_PADDING.top + ratio * plotHeight;
        const value = max - (max - min) * ratio;
        return (
          <g key={ratio}>
            <line x1={SVG_PADDING.left} x2={SVG_WIDTH - SVG_PADDING.right} y1={y} y2={y} />
            <text x={SVG_PADDING.left - 8} y={y + 3}>{formatChartValue(value)}</text>
          </g>
        );
      })}
    </g>
  );
}

function LineChartSvg({ series }: { series: SectorRotationLineSeries[] }) {
  const allPoints = series.flatMap((item) => item.points);
  const values = allPoints.map((point) => point.value);
  const { min, max, y } = scaledYMapper(values);
  const firstDate = allPoints.reduce((earliest, point) => point.date < earliest ? point.date : earliest, allPoints[0].date);
  const lastDate = allPoints.reduce((latest, point) => point.date > latest ? point.date : latest, allPoints[0].date);
  const firstTime = Date.parse(`${firstDate}T00:00:00Z`);
  const timeSpan = Math.max(Date.parse(`${lastDate}T00:00:00Z`) - firstTime, 1);
  const plotWidth = SVG_WIDTH - SVG_PADDING.left - SVG_PADDING.right;
  const x = (date: string) => SVG_PADDING.left + ((Date.parse(`${date}T00:00:00Z`) - firstTime) / timeSpan) * plotWidth;

  return (
    <svg className="rotation-data-svg" viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} role="img" aria-label="真实历史数据折线图">
      <ChartGrid min={min} max={max} />
      {series.map((item, seriesIndex) => {
        const points = item.points.map((point) => `${x(point.date).toFixed(2)},${y(point.value).toFixed(2)}`).join(" ");
        return (
          <g className={`rotation-line-series series-${seriesIndex + 1}`} key={item.name}>
            <polyline points={points} />
            {item.points.length <= 16 ? item.points.map((point) => (
              <circle cx={x(point.date)} cy={y(point.value)} r="2.6" key={`${item.name}-${point.date}`}>
                <title>{`${item.name} · ${point.date} · ${formatChartValue(point.value)}`}</title>
              </circle>
            )) : null}
          </g>
        );
      })}
      <g className="rotation-svg-dates" aria-hidden="true">
        <text x={SVG_PADDING.left} y={SVG_HEIGHT - 7}>{formatDate(firstDate)}</text>
        <text x={SVG_WIDTH - SVG_PADDING.right} y={SVG_HEIGHT - 7} textAnchor="end">{formatDate(lastDate)}</text>
      </g>
    </svg>
  );
}

function CandlestickChartSvg({ points }: { points: SectorRotationCandlestickPoint[] }) {
  const values = points.flatMap((point) => [point.high, point.low]);
  const { min, max, y } = scaledYMapper(values);
  const plotWidth = SVG_WIDTH - SVG_PADDING.left - SVG_PADDING.right;
  const step = plotWidth / points.length;
  const bodyWidth = Math.max(2.5, Math.min(9, step * 0.58));

  return (
    <svg className="rotation-data-svg" viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} role="img" aria-label="真实开高低收 K 线图">
      <ChartGrid min={min} max={max} />
      <g className="rotation-candles">
        {points.map((point, index) => {
          const x = SVG_PADDING.left + step * (index + 0.5);
          const openY = y(point.open);
          const closeY = y(point.close);
          const top = Math.min(openY, closeY);
          const height = Math.max(1.5, Math.abs(closeY - openY));
          const direction = point.close >= point.open ? "is-up" : "is-down";
          return (
            <g className={direction} key={point.date}>
              <line x1={x} x2={x} y1={y(point.high)} y2={y(point.low)} />
              <rect x={x - bodyWidth / 2} y={top} width={bodyWidth} height={height}>
                <title>{`${point.date} · 开 ${formatChartValue(point.open)} · 高 ${formatChartValue(point.high)} · 低 ${formatChartValue(point.low)} · 收 ${formatChartValue(point.close)}`}</title>
              </rect>
            </g>
          );
        })}
      </g>
      <g className="rotation-svg-dates" aria-hidden="true">
        <text x={SVG_PADDING.left} y={SVG_HEIGHT - 7}>{formatDate(points[0].date)}</text>
        <text x={SVG_WIDTH - SVG_PADDING.right} y={SVG_HEIGHT - 7} textAnchor="end">{formatDate(points.at(-1)?.date ?? "")}</text>
      </g>
    </svg>
  );
}

function RotationDataCharts({ charts, market, asOf }: { charts?: SectorRotationChart[]; market: SectorRotationMarket; asOf: string }) {
  const validCharts = (charts ?? []).filter((chart) => chartIsRenderable(chart, asOf, market.sources.length));
  if (!validCharts.length) return null;
  return (
    <div className="rotation-data-charts">
      {validCharts.map((chart) => (
        <figure className="rotation-data-chart" key={`${chart.type}-${chart.title}-${chart.asOf}`}>
          <figcaption>
            <div><strong>{chart.title}</strong><span>{chart.type === "line" ? "折线" : "K 线"}</span></div>
            <em>单位：{chart.unit}</em>
          </figcaption>
          {chart.type === "line" ? (
            <>
              <div className="rotation-chart-legend" aria-label="图例">
                {chart.series.map((series, index) => <span className={`series-${index + 1}`} key={series.name}><i />{series.name}</span>)}
              </div>
              <div className="rotation-svg-scroll"><LineChartSvg series={chart.series} /></div>
            </>
          ) : (
            <div className="rotation-svg-scroll"><CandlestickChartSvg points={chart.points} /></div>
          )}
          <div className="rotation-data-chart-meta">
            <span>截至 {formatDate(chart.asOf)} · {chart.note}</span>
            <SourceRefs indexes={chart.sourceIndexes} sources={market.sources} />
          </div>
        </figure>
      ))}
    </div>
  );
}

function DirectionIcon({ direction }: { direction: SectorRotationForecastDirection }) {
  if (direction === "strong-up" || direction === "up") return <ArrowUpRight size={15} />;
  if (direction === "strong-down" || direction === "down") return <ArrowDownRight size={15} />;
  return <Minus size={15} />;
}

function InsufficientState({
  reason,
  compact = false,
  title = "本期暂无可发布结果",
}: {
  reason: string;
  compact?: boolean;
  title?: string;
}) {
  return (
    <div className={`rotation-insufficient ${compact ? "compact" : ""}`} role="status">
      <CircleAlert size={20} />
      <div>
        <strong>{title}</strong>
        <details>
          <summary>查看原因</summary>
          <p>{reason}</p>
        </details>
      </div>
    </div>
  );
}

const aShareFocus = [
  { code: "000991", label: "医疗" },
  { code: "399967", label: "军工" },
  { code: "399970", label: "互联网" },
] as const;

function FocusObservations({ items }: { items: SectorRotationObservedItem[] }) {
  const focusItems = aShareFocus.flatMap((focus) => {
    const item = items.find((candidate) => candidate.code === focus.code);
    return item ? [{ focus, item }] : [];
  });
  if (!focusItems.length) return null;
  return (
    <section className="rotation-focus" aria-labelledby="rotation-focus-title">
      <header>
        <div><span>FOCUS</span><strong id="rotation-focus-title">重点观察</strong></div>
        <p>固定展示，不加分、不改变原始排名</p>
      </header>
      <ul>
        {focusItems.map(({ focus, item }) => {
          const metric = item.metrics.find((candidate) => candidate.label === "成交额比") ?? item.metrics[0];
          return (
            <li key={focus.code} className={`direction-${item.direction}`}>
              <span>{focus.label}</span>
              <div><strong>{item.sector}</strong><small>原始排名 #{item.rank}</small></div>
              <em>{metric?.value ?? "—"}<small>{metric?.label ?? "当前观测"}</small></em>
              <b>{observedDirectionLabel[item.direction]}</b>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ObservedRanking({
  horizon,
  market,
  detailKeys,
}: {
  horizon: SectorRotationObservedHorizon;
  market: SectorRotationMarket;
  detailKeys: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (horizon.status === "insufficient") {
    return <InsufficientState title="本期暂无可比观测" reason={horizon.reason} compact={market.mode === "major-index"} />;
  }

  const items = [...horizon.items].sort((left, right) => left.rank - right.rank);
  if (!items.length) return <InsufficientState reason="观测结果为空，未发布不可复核的占位排名。" />;
  const visibleItems = expanded || market.mode === "major-index" ? items : compactRankingItems(items);

  return (
    <>
      <div className="rotation-context-note">
        <Activity size={15} />
        <p><strong>只描述当前相对强弱</strong>{horizon.note}</p>
      </div>
      {market.id === "a-share" ? <FocusObservations items={items} /> : null}
      <RotationRankingChart items={items} market={market} asOf={horizon.asOf} />
      {horizon.charts?.length ? (
        <details className="rotation-supporting-charts">
          <summary>展开支撑图表 <ChevronDown size={13} /></summary>
          <RotationDataCharts charts={horizon.charts} market={market} asOf={horizon.asOf} />
        </details>
      ) : null}
      <ol id="rotation-observed-list" className={`rotation-ranking observed ${market.mode === "major-index" ? "compact" : ""}`}>
        {visibleItems.map((item) => {
          const detailHref = sectorDetailHref(market, item.code, detailKeys);
          return (
          <li key={`${item.rank}-${item.code ?? item.sector}`} className={`rotation-rank-item observed direction-${item.direction} ${detailHref ? "has-detail" : ""}`}>
            <span className="rotation-rank-number">{String(item.rank).padStart(2, "0")}</span>
            <div className="rotation-rank-main">
              <div className="rotation-rank-title">
                <div><strong>{item.sector}</strong>{item.code ? <small>{item.code}</small> : null}</div>
                <div className="rotation-rank-actions">
                  <span className={`rotation-direction direction-${item.direction}`}>{observedDirectionLabel[item.direction]}</span>
                  {detailHref ? <SectorCardLink href={detailHref} sector={item.sector} /> : null}
                </div>
              </div>
              <ScoreBar score={item.score} />
              <p className="rotation-signal">{item.signal}<SourceRefs indexes={item.sourceIndexes} sources={market.sources} /></p>
              {item.metrics.length ? (
                <dl className="rotation-metrics">
                  {item.metrics.slice(0, market.mode === "major-index" ? 2 : 3).map((metric) => (
                    <div key={`${item.sector}-${metric.label}`}>
                      <dt>{metric.label}</dt>
                      <dd className={metric.tone ? `tone-${metric.tone}` : undefined}>{metric.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </li>
          );
        })}
      </ol>
      {market.mode !== "major-index" && items.length > visibleItems.length ? (
        <button
          type="button"
          className="rotation-expand"
          aria-expanded={expanded}
          aria-controls="rotation-observed-list"
          onClick={() => setExpanded(true)}
        >
          展开全部可用板块（{items.length}）<ChevronDown size={16} />
        </button>
      ) : market.mode !== "major-index" && expanded && items.length > 5 ? (
        <button
          type="button"
          className="rotation-expand"
          aria-expanded={expanded}
          aria-controls="rotation-observed-list"
          onClick={() => setExpanded(false)}
        >
          收起为 Top 3 / Bottom 2<ChevronDown className="is-up" size={16} />
        </button>
      ) : null}
    </>
  );
}

function ForecastEvidence({
  title,
  points,
  sources,
  counter = false,
}: {
  title: string;
  points: Array<{ label: string; observation: string; sourceIndexes: number[] }>;
  sources: SourceLink[];
  counter?: boolean;
}) {
  return (
    <div className={`rotation-evidence ${counter ? "counter" : ""}`}>
      <strong>{title}</strong>
      {points.map((point, index) => (
        <p key={`${point.label}-${index}`}>
          <b>{point.label}</b>{point.observation}
          <SourceRefs indexes={point.sourceIndexes} sources={sources} />
        </p>
      ))}
    </div>
  );
}

function ForecastRanking({
  horizon,
  market,
  detailKeys,
}: {
  horizon: SectorRotationForecastHorizon;
  market: SectorRotationMarket;
  detailKeys: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (horizon.status === "insufficient") {
    return <InsufficientState title="本期未发布条件排序" reason={horizon.reason} compact={market.mode === "major-index"} />;
  }

  const items = [...horizon.items].sort((left, right) => left.rank - right.rank);
  if (!items.length) return <InsufficientState reason="模型没有形成满足证据门槛的条件情景，未发布空白预测。" />;
  const isCompact = market.mode === "major-index";
  const visibleItems = expanded || isCompact ? items : compactRankingItems(items);

  return (
    <>
      <div className="rotation-context-note forecast">
        <ShieldCheck size={15} />
        <p><strong>条件情景，不是收益承诺</strong>{horizon.note}</p>
      </div>
      <RotationRankingChart items={items} market={market} asOf={horizon.asOf} forecast />
      <RotationDataCharts charts={horizon.charts} market={market} asOf={horizon.asOf} />
      <ol id="rotation-forecast-list" className={`rotation-ranking forecast ${isCompact ? "compact" : ""}`}>
        {visibleItems.map((item) => {
          const detailHref = sectorDetailHref(market, item.code, detailKeys);
          return (
          <li key={`${item.rank}-${item.code ?? item.sector}`} className={`rotation-rank-item forecast direction-${item.direction} ${detailHref ? "has-detail" : ""}`}>
            <span className="rotation-rank-number">{String(item.rank).padStart(2, "0")}</span>
            <div className="rotation-rank-main">
              <div className="rotation-rank-title">
                <div><strong>{item.sector}</strong>{item.code ? <small>{item.code}</small> : null}</div>
                <div className="rotation-rank-actions">
                  <span className={`rotation-direction direction-${item.direction}`}><DirectionIcon direction={item.direction} />{forecastDirectionLabel[item.direction]}</span>
                  {detailHref ? <SectorCardLink href={detailHref} sector={item.sector} /> : null}
                </div>
              </div>
              <div className="rotation-forecast-score">
                <ScoreBar score={item.score} forecast />
                <span
                  className={`rotation-confidence confidence-${item.confidence}`}
                  title={item.confidenceBasis}
                  aria-label={`${confidenceLabel[item.confidence]}置信度，证据强度 ${item.confidenceScore} 分（满分 100 分）；该分数不是上涨概率或胜率`}
                >
                  {confidenceLabel[item.confidence]} · {item.confidenceScore}/100
                </span>
                <time dateTime={item.dueDate}><CalendarDays size={11} /> 至 {formatDate(item.dueDate)}</time>
              </div>
              <p className="rotation-claim">{item.claim}</p>
              <details className="rotation-audit-details">
                <summary>查看支持证据、反证与失效条件 <ChevronDown size={13} /></summary>
                <div className="rotation-evidence-grid">
                  <ForecastEvidence title="支持证据" points={item.evidence} sources={market.sources} />
                  <ForecastEvidence title="反证 / 风险" points={item.counterEvidence} sources={market.sources} counter />
                </div>
                <dl className="rotation-conditions">
                  <div><dt>触发</dt><dd>{item.trigger}</dd></div>
                  <div><dt>失效</dt><dd>{item.invalidation}</dd></div>
                  <div className="rotation-confidence-explain"><dt>置信度</dt><dd>{item.confidenceBasis}</dd></div>
                </dl>
              </details>
            </div>
          </li>
          );
        })}
      </ol>
      {!isCompact && items.length > visibleItems.length ? (
        <button type="button" className="rotation-expand" aria-expanded={expanded} aria-controls="rotation-forecast-list" onClick={() => setExpanded(true)}>
          展开全部条件情景（{items.length}）<ChevronDown size={16} />
        </button>
      ) : !isCompact && expanded && items.length > 5 ? (
        <button type="button" className="rotation-expand" aria-expanded={expanded} aria-controls="rotation-forecast-list" onClick={() => setExpanded(false)}>
          收起为 Top 3 / Bottom 2<ChevronDown className="is-up" size={16} />
        </button>
      ) : null}
    </>
  );
}

export default function SectorRotationIndex({
  data,
  activeMarketId,
  detailKeys,
  availableHorizons = ["current", "oneWeek", "oneMonth"],
  initialHorizon,
}: {
  data?: SectorRotationIndexData;
  activeMarketId: MarketSection["id"];
  detailKeys?: string[];
  availableHorizons?: HorizonKey[];
  initialHorizon?: HorizonKey;
}) {
  const tabs = horizonTabs.filter((tab) => availableHorizons.includes(tab.key));
  const firstHorizon = initialHorizon && availableHorizons.includes(initialHorizon) ? initialHorizon : (tabs[0]?.key ?? "current");
  const [activeHorizon, setActiveHorizon] = useState<HorizonKey>(firstHorizon);
  const market = useMemo(
    () => data?.markets.find((candidate) => candidate.id === activeMarketId),
    [activeMarketId, data],
  );
  const detailKeySet = useMemo(() => new Set(detailKeys ?? []), [detailKeys]);
  const activeTab = tabs.find((tab) => tab.key === activeHorizon) ?? tabs[0] ?? horizonTabs[0];
  const horizon = market?.horizons[activeHorizon];
  const isForecast = activeHorizon !== "current";
  const isUS = activeMarketId === "us";

  function handleHorizonKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = horizonTabs.length - 1;
    else return;
    event.preventDefault();
    const nextKey = tabs[nextIndex].key;
    setActiveHorizon(nextKey);
    requestAnimationFrame(() => document.getElementById(`rotation-tab-${nextKey}`)?.focus());
  }

  return (
    <section className={`sector-rotation-index ${isUS ? "market-us" : ""}`} aria-labelledby="sector-rotation-title">
      <header className="rotation-header">
        <div>
          <span className="eyebrow">ROTATION RANKING</span>
          <h2 id="sector-rotation-title">{availableHorizons.includes("current") ? (isUS ? "三大指数相对强弱" : "行业板块轮动指数") : (isUS ? "三大指数预测排行榜" : "行业板块预测排行榜")}</h2>
          <p>{availableHorizons.includes("current") ? (isUS ? "仅比较纳斯达克、道琼斯与标普 500，保持精简。" : "当前为可复核观测；未来窗口仅展示有证据、可失效的条件情景。") : "先展示方向、综合分与置信度；支持证据、反证和失效条件按需展开。"}</p>
        </div>
        {market ? (
          <div className="rotation-market-meta">
            <strong>{market.label}</strong>
            <span>截至 {formatDate(market.asOf)}</span>
          </div>
        ) : null}
      </header>

      <div className="rotation-horizon-tabs" role="tablist" aria-label="选择轮动指数时间窗口">
        {tabs.map((tab, index) => (
          <button
            key={tab.key}
            type="button"
            id={`rotation-tab-${tab.key}`}
            role="tab"
            aria-selected={activeHorizon === tab.key}
            aria-controls="rotation-ranking-panel"
            tabIndex={activeHorizon === tab.key ? 0 : -1}
            className={activeHorizon === tab.key ? "active" : ""}
            onClick={() => setActiveHorizon(tab.key)}
            onKeyDown={(event) => handleHorizonKeyDown(event, index)}
          >
            <strong>{tab.label}</strong><small>{tab.caption}</small>
          </button>
        ))}
      </div>

      <div
        id="rotation-ranking-panel"
        className="rotation-panel"
        role="tabpanel"
        aria-labelledby={`rotation-tab-${activeHorizon}`}
      >
        {!data || !market ? (
          <InsufficientState reason={`${isUS ? "三大指数" : "行业轮动"}模型产物尚未接入；页面不会用占位数据伪造结果。`} compact={isUS} />
        ) : !horizon ? (
          <InsufficientState reason={`${activeTab.label}窗口没有可验证数据。`} compact={isUS} />
        ) : horizon.kind === "observed" ? (
          <ObservedRanking key={`${market.id}-${horizon.asOf}`} horizon={horizon} market={market} detailKeys={detailKeySet} />
        ) : (
          <ForecastRanking key={`${market.id}-${activeHorizon}-${horizon.asOf}`} horizon={horizon} market={market} detailKeys={detailKeySet} />
        )}
      </div>

      {market ? (
        <footer className="rotation-footer">
          <p><Gauge size={13} />{market.taxonomy.name} · {market.taxonomy.version} · {market.note}</p>
          {isForecast && data ? <p>模型 {data.model.version} · {data.model.backtest.summary}</p> : <p>排序分只表示横截面相对位置，不代表收益率或概率。</p>}
        </footer>
      ) : null}
    </section>
  );
}
