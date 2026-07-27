"use client";

import {
  Activity,
  ArrowLeft,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  Gauge,
  History,
  Layers3,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import MobileBottomNav from "@/components/MobileBottomNav";
import type {
  SectorDetail,
  SectorDetailMarket,
  SectorPredictionHistoryRecord,
  SectorRotationMarket,
} from "@/lib/types";

type Horizon = 1 | 5 | 20;
type ActualMetric = "excess" | "absolute" | "rank";

const horizonLabels: Record<Horizon, string> = { 1: "明日", 5: "一周内", 20: "一个月内" };
const resultLabels = {
  correct: "正确",
  wrong: "错误",
  "near-neutral": "接近中性",
  pending: "尚未到期",
  "model-abstained": "模型弃权",
  "data-insufficient": "数据不足",
  "not-applicable": "模型尚未建设",
} as const;

function formatDate(value: string | null | undefined) {
  return value ? value.replaceAll("-", ".") : "—";
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function predictionValue(record: SectorPredictionHistoryRecord) {
  if (record.probability_target === "top_quartile" && record.publication_status === "published" && finite(record.top_quartile_probability)) {
    return record.top_quartile_probability;
  }
  return null;
}

function predictionDisplay(record: SectorPredictionHistoryRecord | undefined) {
  if (!record) return "—";
  if (record.publication_status === "abstained") return `观察分 ${record.observation_score?.toFixed(0) ?? "—"}`;
  if (record.probability_target === "top_quartile" && finite(record.top_quartile_probability)) return `${record.top_quartile_probability.toFixed(1)}%`;
  if (record.legacy && record.probability_target === "absolute_up" && finite(record.absolute_up_probability)) return `旧绝对上涨 ${record.absolute_up_probability.toFixed(1)}%`;
  return "不可用";
}

function actualValue(record: SectorPredictionHistoryRecord, metric: ActualMetric) {
  if (metric === "excess") return finite(record.realized_excess_return) ? record.realized_excess_return : null;
  if (metric === "absolute") return finite(record.realized_absolute_return) ? record.realized_absolute_return : null;
  if (!finite(record.realized_sector_rank) || !finite(record.realized_sector_count) || record.realized_sector_count <= 1) return null;
  return (1 - (record.realized_sector_rank - 1) / (record.realized_sector_count - 1)) * 100;
}

function outcomeIcon(result: SectorPredictionHistoryRecord["result"]) {
  if (result === "correct") return <CheckCircle2 size={14} />;
  if (result === "wrong") return <XCircle size={14} />;
  if (result === "model-abstained") return <ShieldCheck size={14} />;
  return <CircleAlert size={14} />;
}

function SyncedLineChart({
  title,
  unit,
  records,
  selectedDate,
  onSelect,
  valueFor,
  empty,
}: {
  title: string;
  unit: string;
  records: SectorPredictionHistoryRecord[];
  selectedDate: string | null;
  onSelect: (date: string) => void;
  valueFor: (record: SectorPredictionHistoryRecord) => number | null;
  empty: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const ordered = [...records].sort((a, b) => a.prediction_date.localeCompare(b.prediction_date));
  const points = ordered.map((record, index) => ({ record, index, value: valueFor(record) }));
  const finitePoints = points.filter((item): item is typeof item & { value: number } => finite(item.value));
  const values = finitePoints.map((item) => item.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 1;
  const padding = Math.max((max - min) * 0.18, unit === "%" ? 1 : 3);
  const low = min - padding;
  const high = max + padding;
  const width = 720;
  const height = 190;
  const left = 52;
  const right = 18;
  const top = 22;
  const bottom = 34;
  const x = (index: number) => left + (ordered.length <= 1 ? (width - left - right) / 2 : index / (ordered.length - 1) * (width - left - right));
  const y = (value: number) => top + (high - value) / Math.max(high - low, 1e-9) * (height - top - bottom);
  const path = finitePoints.map((item, index) => `${index === 0 ? "M" : "L"}${x(item.index).toFixed(1)},${y(item.value).toFixed(1)}`).join(" ");
  const selected = selectedDate ? points.find((item) => item.record.prediction_date === selectedDate) : undefined;

  function handlePointer(clientX: number) {
    if (!svgRef.current || !ordered.length) return;
    const rect = svgRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const index = Math.round(ratio * Math.max(0, ordered.length - 1));
    onSelect(ordered[index].prediction_date);
  }

  return (
    <figure className="prediction-history-chart">
      <figcaption><div><strong>{title}</strong><span>时间轴与下图同步</span></div><em>{unit}</em></figcaption>
      {ordered.length ? (
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`${title}，可触摸查看历史值`}
          onPointerMove={(event) => handlePointer(event.clientX)}
          onPointerDown={(event) => handlePointer(event.clientX)}
        >
          {[0, 0.5, 1].map((ratio) => {
            const value = high - ratio * (high - low);
            const yy = top + ratio * (height - top - bottom);
            return <g key={ratio}><line x1={left} x2={width - right} y1={yy} y2={yy} className="grid" /><text x={left - 8} y={yy + 4} textAnchor="end">{value.toFixed(1)}</text></g>;
          })}
          {path ? <path d={path} className="series" /> : null}
          {points.map((item) => {
            const xx = x(item.index);
            if (item.record.prediction_status === "model-abstained") {
              return <g key={item.record.prediction_id} className="abstain-marker"><line x1={xx - 4} x2={xx + 4} y1={height / 2 - 4} y2={height / 2 + 4} /><line x1={xx - 4} x2={xx + 4} y1={height / 2 + 4} y2={height / 2 - 4} /></g>;
            }
            if (!finite(item.value)) return null;
            return <circle key={item.record.prediction_id} cx={xx} cy={y(item.value)} r={item.record.result === "wrong" ? 5 : 4} className={`result-${item.record.result}`} />;
          })}
          {selected ? <line x1={x(selected.index)} x2={x(selected.index)} y1={top} y2={height - bottom} className="cursor" /> : null}
          <text x={left} y={height - 10}>{ordered[0]?.prediction_date.slice(5).replace("-", ".")}</text>
          <text x={width - right} y={height - 10} textAnchor="end">{ordered.at(-1)?.prediction_date.slice(5).replace("-", ".")}</text>
        </svg>
      ) : <p className="prediction-chart-empty">{empty}</p>}
      {selected ? (
        <div className="prediction-chart-tooltip">
          <strong>{formatDate(selected.record.prediction_date)}</strong>
          <span>{finite(selected.value) ? `${selected.value.toFixed(2)}${unit}` : resultLabels[selected.record.result]}</span>
          <em>{selected.record.model_version}</em>
        </div>
      ) : null}
    </figure>
  );
}

function SnapshotEvidence({ record }: { record: SectorPredictionHistoryRecord }) {
  return (
    <details className="prediction-history-details">
      <summary>查看当时证据与模型分项 <ChevronDown size={14} /></summary>
      <div className="prediction-history-detail-grid">
        <section><strong>主要证据</strong>{record.evidence.length ? record.evidence.map((item) => <p key={`${item.label}-${item.observation}`}><b>{item.label}</b>{item.observation}</p>) : <p>{record.claim || "该快照只保存了观察分与弃权状态。"}</p>}</section>
        <section><strong>反向证据</strong>{record.counter_evidence.length ? record.counter_evidence.map((item) => <p key={`${item.label}-${item.observation}`}><b>{item.label}</b>{item.observation}</p>) : <p>{record.abstain_reason.join("；") || "当时未记录额外反证。"}</p>}</section>
      </div>
      <dl>
        <div><dt>观察条件</dt><dd>{record.trigger || "—"}</dd></div>
        <div><dt>失效条件</dt><dd>{record.invalidation || "—"}</dd></div>
        <div><dt>数据时间</dt><dd>{formatDate(record.data_as_of)}</dd></div>
        <div><dt>数据完整度</dt><dd>{finite(record.data_completeness) ? `${(record.data_completeness * 100).toFixed(0)}%` : "旧版未保存"}</dd></div>
        <div><dt>raw score / probability</dt><dd>{finite(record.raw_score) ? record.raw_score.toFixed(4) : "—"} / {finite(record.raw_probability) ? `${record.raw_probability.toFixed(2)}%` : "—"}</dd></div>
        <div><dt>{record.legacy ? "旧绝对上涨模型输出（非前25%概率）" : "calibrated probability"}</dt><dd>{finite(record.calibrated_probability) ? `${record.calibrated_probability.toFixed(2)}%` : "—"}</dd></div>
      </dl>
      {record.source_urls.length ? <div className="prediction-history-source-links">{record.source_urls.map((url, index) => <a href={url} key={url} target="_blank" rel="noreferrer">来源 {index + 1}<ExternalLink size={11} /></a>)}</div> : null}
    </details>
  );
}

export default function SectorPredictionDetail({
  market,
  detail,
  rotationMarket,
  records,
}: {
  market: SectorDetailMarket;
  detail: SectorDetail;
  rotationMarket?: SectorRotationMarket;
  records: SectorPredictionHistoryRecord[];
}) {
  const [horizon, setHorizon] = useState<Horizon>(5);
  const [actualMetric, setActualMetric] = useState<ActualMetric>("excess");
  const horizonRecords = useMemo(() => records.filter((item) => item.horizon === horizon), [records, horizon]);
  const [selectedDate, setSelectedDate] = useState<string | null>(horizonRecords[0]?.prediction_date ?? null);
  const latest = horizonRecords[0];
  const currentHorizon = horizon === 1 ? rotationMarket?.horizons.tomorrow : horizon === 5 ? rotationMarket?.horizons.oneWeek : rotationMarket?.horizons.oneMonth;
  const currentStatus = currentHorizon?.status ?? "insufficient";
  const currentLabel = currentStatus === "ready"
    ? "概率已发布"
    : currentStatus === "abstained"
      ? "概率已弃权"
      : currentHorizon?.modelAvailability === "not_trained"
        ? "港股概率模型尚未建设"
        : currentHorizon?.modelAvailability === "not_implemented"
          ? "美股预测模型尚未实现"
          : "数据建设中";
  const currentModelRecords = horizonRecords.filter((record) => !record.legacy);

  function switchHorizon(next: Horizon) {
    setHorizon(next);
    setSelectedDate(records.find((item) => item.horizon === next)?.prediction_date ?? null);
  }

  return (
    <div className="prediction-detail-shell">
      <header className="article-topbar prediction-detail-topbar">
        <Link className="article-back-link" href="/predictions"><ArrowLeft size={16} />返回预测榜</Link>
        <Link className="article-wordmark" href="/">观潮</Link>
        <span className="article-topbar-label">预测历史</span>
      </header>

      <main className="prediction-detail-page">
        <article className="prediction-detail-report">
          <header className="prediction-detail-hero">
            <div className="prediction-detail-kicker"><span>{market.label}</span><code>{detail.code}</code><time>截至 {formatDate(rotationMarket?.asOf)}</time></div>
            <h1>{detail.name}</h1>
            <p>{detail.description}</p>
            <div className={`prediction-model-state status-${currentStatus}`}><Gauge size={16} /><strong>{currentLabel}</strong><span>{currentHorizon?.status === "abstained" ? currentHorizon.reason : currentHorizon?.status === "ready" ? currentHorizon.note : currentHorizon?.reason ?? "尚无记录"}</span></div>
          </header>

          <div className="prediction-horizon-tabs" role="tablist" aria-label="预测周期">
            {([1, 5, 20] as Horizon[]).map((item) => <button type="button" key={item} className={horizon === item ? "active" : ""} onClick={() => switchHorizon(item)}><strong>{horizonLabels[item]}</strong><small>{item} 个交易日</small></button>)}
          </div>

          <section className="prediction-latest-card" aria-labelledby="prediction-latest-title">
            <div><span className="eyebrow">LATEST SNAPSHOT</span><h2 id="prediction-latest-title">最新真实快照</h2></div>
            <dl>
              <div><dt>当前状态</dt><dd>{latest ? resultLabels[latest.result] : currentLabel}</dd></div>
              <div><dt>最新预测</dt><dd>{predictionDisplay(latest)}</dd></div>
              <div><dt>历史基准</dt><dd>{finite(latest?.historical_base) ? `${latest.historical_base.toFixed(1)}%` : "—"}</dd></div>
              <div><dt>有效优势</dt><dd>{finite(latest?.effective_edge) ? `${latest.effective_edge >= 0 ? "+" : ""}${latest.effective_edge.toFixed(1)}pct` : "—"}</dd></div>
              <div><dt>模型版本</dt><dd>{latest?.model_version ?? "尚未建立"}</dd></div>
              <div><dt>数据截至</dt><dd>{formatDate(latest?.data_as_of ?? rotationMarket?.asOf)}</dd></div>
            </dl>
          </section>

          <section className="prediction-chart-section" aria-labelledby="prediction-chart-title">
            <header><div><span className="eyebrow">PREDICTION VS REALITY</span><h2 id="prediction-chart-title">历史预测与实际结果</h2></div><span><History size={14} />发布时快照，不事后重算</span></header>
            <SyncedLineChart title="图表一 · 当前模型历史预测线" unit="%" records={currentModelRecords} selectedDate={selectedDate} onSelect={setSelectedDate} valueFor={predictionValue} empty="当前模型还没有可画成折线的已发布前25%概率；弃权日会以叉号保留。" />
            <div className="prediction-actual-tabs" role="group" aria-label="选择实际表现口径">
              <button type="button" className={actualMetric === "excess" ? "active" : ""} onClick={() => setActualMetric("excess")}>相对收益</button>
              <button type="button" className={actualMetric === "absolute" ? "active" : ""} onClick={() => setActualMetric("absolute")}>绝对收益</button>
              <button type="button" className={actualMetric === "rank" ? "active" : ""} onClick={() => setActualMetric("rank")}>排名百分位</button>
            </div>
            <SyncedLineChart title={actualMetric === "rank" ? "图表二 · 实际行业排名百分位" : actualMetric === "absolute" ? "图表二 · 到期实际绝对收益" : "图表二 · 到期实际相对基准收益"} unit="%" records={horizonRecords} selectedDate={selectedDate} onSelect={setSelectedDate} valueFor={(record) => actualValue(record, actualMetric)} empty="现有快照尚未到期；到期后自动补充实际结果，不修改原预测。" />
            <p className="prediction-chart-note">两图只共享日期和光标，不共用纵轴。圆点颜色表示正确、错误或中性；叉号表示当天模型主动弃权。</p>
          </section>

          <section className="prediction-record-section" aria-labelledby="prediction-record-title">
            <header><div><span className="eyebrow">AUDIT TRAIL</span><h2 id="prediction-record-title">历史记录</h2></div><span>{horizonRecords.length} 条</span></header>
            {horizonRecords.length ? <ol>{horizonRecords.map((record) => <li key={record.prediction_id}>
              <div className="prediction-record-head"><time>{formatDate(record.prediction_date)}</time><span className={`result-${record.result}`}>{outcomeIcon(record.result)}{resultLabels[record.result]}</span></div>
              <div className="prediction-record-values">
                <div><span>当时预测</span><strong>{predictionDisplay(record)}</strong></div>
                <div><span>历史基准</span><strong>{finite(record.historical_base) ? `${record.historical_base.toFixed(1)}%` : "—"}</strong></div>
                <div><span>实际相对收益</span><strong>{finite(record.realized_excess_return) ? `${record.realized_excess_return >= 0 ? "+" : ""}${record.realized_excess_return.toFixed(2)}%` : "—"}</strong></div>
                <div><span>实际排名</span><strong>{finite(record.realized_sector_rank) ? `${record.realized_sector_rank}/${record.realized_sector_count}` : "—"}</strong></div>
              </div>
              <p>{record.claim || record.abstain_reason.join("；")}</p>
              <div className="prediction-record-meta"><span>{record.model_version}</span><span>完整度 {finite(record.data_completeness) ? `${(record.data_completeness * 100).toFixed(0)}%` : "—"}</span><span><CalendarDays size={11} />到期 {formatDate(record.due_date)}</span></div>
              <SnapshotEvidence record={record} />
            </li>)}</ol> : <p className="prediction-record-empty">这个周期尚无真实发布快照。历史从系统开始保存之日起积累，不回填伪造结果。</p>}
          </section>

          <section className="prediction-sector-context" aria-labelledby="prediction-sector-context-title">
            <header><div><span className="eyebrow">SECTOR CONTEXT</span><h2 id="prediction-sector-context-title">板块构成与风格</h2></div><Layers3 size={18} /></header>
            <div className="prediction-sector-tags">{detail.styleTags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <p>{detail.styleSummary}</p>
            <ol>{detail.constituents.items.slice(0, 5).map((item) => <li key={item.code}><span>{item.name}<small>{item.code}</small></span><i><b style={{ width: `${Math.min(item.weightPct * 2.5, 100)}%` }} /></i><strong>{item.weightPct.toFixed(2)}%</strong></li>)}</ol>
            <Link href={`/markets/sectors/${market.id}/${encodeURIComponent(detail.code)}`}>查看完整成分与风格说明<ExternalLink size={13} /></Link>
          </section>

          <footer className="prediction-detail-footer"><BarChart3 size={15} /><p>概率、观察分与实际收益使用不同口径展示。模型弃权不等于看空；它表示当时没有达到发布概率排名的证据门槛。</p></footer>
        </article>
      </main>
      <MobileBottomNav active="predictions" />
    </div>
  );
}
