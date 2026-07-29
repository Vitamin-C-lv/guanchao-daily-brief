"use client";

import { ArrowLeft, CheckCircle2, Clock3, Database, ExternalLink, History, Search, ShieldCheck, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import MobileBottomNav from "./MobileBottomNav";
import type { PredictionHistoryFilter, PredictionHistoryShard, PredictionLedgerPublicIndex, PredictionLedgerPublicRecord, PredictionWeeklyReview, ProbabilityTarget } from "@/lib/types";

const markets = [{ id: "a-share", label: "A股" }, { id: "hk", label: "港股" }, { id: "us", label: "美股" }] as const;
const horizons = [1, 5, 20] as const;
const statuses = [["all", "全部状态"], ["published", "已发布"], ["abstained", "模型弃权"], ["unavailable", "未训练 / 未实现"], ["evaluated", "已到期"], ["pending", "待验证"]] as const;
const targets: Array<[PredictionHistoryFilter["probabilityTarget"], string]> = [["all", "全部概率目标"], ["top_quartile", "前25%"], ["relative_outperformance", "跑赢基准"], ["absolute_up", "绝对上涨"], ["none", "无概率目标"]];
const initialFilter: PredictionHistoryFilter = { month: "", market: "a-share", horizon: 1, status: "all", modelVersion: "all", probabilityTarget: "all", lineage: "all", query: "" };

function dateLabel(value: string | null) { return value ? value.replaceAll("-", ".") : "—"; }
function pct(value: number | null, digits = 1) { return value == null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`; }
function rate(numerator: number, denominator: number) { return denominator ? `${(numerator / denominator * 100).toFixed(1)}%` : "样本不足"; }

function probability(record: PredictionLedgerPublicRecord) {
  if (record.publicationStatus !== "published") return null;
  if (record.probabilityTarget === "top_quartile") return { label: "进入前25%概率", value: record.topQuartileProbability };
  if (record.probabilityTarget === "relative_outperformance") return { label: "跑赢基准概率", value: record.outperformanceProbability };
  if (record.probabilityTarget === "absolute_up") return { label: record.probabilitySource === "historical_base_rate" ? "历史上涨基准（非模型概率）" : record.legacy ? "旧版上涨概率留档" : "上涨概率", value: record.absoluteUpProbability };
  return null;
}

function stateLabel(record: PredictionLedgerPublicRecord) {
  if (record.legacy) return "旧版留档 · 不纳入当前指标";
  if (record.modelAvailability === "not_implemented") return "模型未实现";
  if (record.modelAvailability === "not_trained") return "模型未训练";
  if (record.publicationStatus === "abstained") return "模型弃权 · 仅展示观察";
  if (record.publicationStatus === "insufficient_data") return "数据不足";
  return "已发布概率";
}

function resultLabel(record: PredictionLedgerPublicRecord) {
  const result = record.evaluation?.result;
  if (!result) return record.publicationStatus === "published" ? `待验证 · ${dateLabel(record.dueDate)}` : "不适用";
  return { correct: "判断正确", wrong: "判断错误", near_neutral: "中性区间", data_insufficient: "评价数据不足", model_abstained: "弃权未计分", not_applicable: "模型状态不适用" }[result];
}

function matchesStatus(record: PredictionLedgerPublicRecord, status: PredictionHistoryFilter["status"]) {
  if (status === "all") return true;
  if (status === "published") return record.publicationStatus === "published";
  if (status === "abstained") return record.publicationStatus === "abstained";
  if (status === "unavailable") return record.modelAvailability !== "trained";
  if (status === "evaluated") return record.evaluation != null && ["correct", "wrong", "near_neutral"].includes(record.evaluation.result);
  return record.publicationStatus === "published" && record.evaluation == null;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isPublicIndex(value: unknown): value is PredictionLedgerPublicIndex {
  if (!isObject(value) || value.schemaVersion !== 1 || value.contractVersion !== "prediction-ledger-v1") return false;
  if (!Array.isArray(value.availableMonths) || !Array.isArray(value.files) || !Array.isArray(value.modelVersions) || !isObject(value.policy) || !isObject(value.statusSummary)) return false;
  const counts = [value.recordCount, value.currentRecordCount, value.evaluatedRecordCount, value.pendingRecordCount, value.statusSummary.published, value.statusSummary.abstained];
  return counts.every((item) => typeof item === "number") && value.availableMonths.every((item) => typeof item === "string") && value.modelVersions.every((item) => typeof item === "string") && value.files.every((item) => isObject(item) && typeof item.yearMonth === "string" && typeof item.path === "string" && typeof item.sha256 === "string" && typeof item.recordCount === "number") && value.policy.completeAuthorityExport === true && value.policy.recordLimit === null;
}
function isPublicRecord(value: unknown): value is PredictionLedgerPublicRecord {
  return isObject(value) && typeof value.predictionId === "string" && typeof value.predictionDate === "string" && typeof value.market === "string" && typeof value.modelVersion === "string" && typeof value.publicationStatus === "string" && typeof value.modelAvailability === "string" && [1, 5, 20].includes(Number(value.horizonSessions)) && Array.isArray(value.abstainReasons) && Array.isArray(value.sourceUrls) && "evaluation" in value;
}
function isHistoryShard(value: unknown): value is PredictionHistoryShard {
  return isObject(value) && value.schemaVersion === 1 && value.contractVersion === "prediction-ledger-v1" && typeof value.yearMonth === "string" && isObject(value.summary) && typeof value.summary.recordCount === "number" && Array.isArray(value.records) && value.records.every(isPublicRecord);
}
function isWeeklyReview(value: unknown): value is PredictionWeeklyReview {
  return isObject(value) && value.schemaVersion === 1 && value.contractVersion === "prediction-ledger-v1" && typeof value.isoWeek === "string" && isObject(value.metrics) && Array.isArray(value.recommendations);
}

function ResultIcon({ record }: { record: PredictionLedgerPublicRecord }) {
  if (record.evaluation?.result === "correct") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (record.evaluation?.result === "wrong") return <XCircle size={16} aria-hidden="true" />;
  return <Clock3 size={16} aria-hidden="true" />;
}

export default function PredictionHistoryExplorer() {
  const [index, setIndex] = useState<PredictionLedgerPublicIndex | null>(null);
  const [review, setReview] = useState<PredictionWeeklyReview | null>(null);
  const [records, setRecords] = useState<PredictionLedgerPublicRecord[]>([]);
  const [filter, setFilter] = useState<PredictionHistoryFilter>(initialFilter);
  const [visible, setVisible] = useState(60);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadIndex() {
      try {
        const response = await fetch("/data/prediction-history/index.json", { cache: "no-cache" });
        if (!response.ok) throw new Error(`index HTTP ${response.status}`);
        const raw: unknown = await response.json();
        if (!isPublicIndex(raw)) throw new Error("公开索引契约无效");
        const payload = raw;
        const params = new URLSearchParams(window.location.search);
        const month = params.get("month");
        const market = params.get("market");
        const horizon = Number(params.get("horizon"));
        const next: PredictionHistoryFilter = {
          ...initialFilter,
          month: month && payload.availableMonths.includes(month) ? month : payload.availableMonths.at(-1) ?? "",
          market: markets.some((item) => item.id === market) ? market as PredictionHistoryFilter["market"] : "a-share",
          horizon: horizons.includes(horizon as 1 | 5 | 20) ? horizon as 1 | 5 | 20 : 1,
          status: statuses.some(([value]) => value === params.get("status")) ? params.get("status") as PredictionHistoryFilter["status"] : "all",
          modelVersion: params.get("model") || "all",
          probabilityTarget: targets.some(([value]) => value === params.get("target")) ? params.get("target") as ProbabilityTarget | "all" : "all",
          lineage: ["all", "current", "legacy"].includes(params.get("lineage") || "") ? params.get("lineage") as PredictionHistoryFilter["lineage"] : "all",
          query: params.get("q") || "",
        };
        if (!cancelled) { setIndex(payload); setFilter(next); }
        if (payload.latestReview) {
          const reviewResponse = await fetch(`/data/prediction-history/${payload.latestReview.path}`, { cache: "no-cache" });
          if (!reviewResponse.ok) throw new Error(`周报 HTTP ${reviewResponse.status}`);
          const reviewText = await reviewResponse.text();
          if (await sha256(reviewText) !== payload.latestReview.sha256) throw new Error("周报哈希校验失败");
          const reviewRaw: unknown = JSON.parse(reviewText);
          if (isWeeklyReview(reviewRaw) && !cancelled) setReview(reviewRaw);
        }
      } catch (reason) {
        if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false); }
      }
    }
    void loadIndex();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!index || !filter.month) return;
    let cancelled = false;
    const entry = index.files.find((item) => item.yearMonth === filter.month);
    if (!entry) { setError("所选月份不在公开索引中"); setLoading(false); return; }
    setLoading(true); setError(null);
    async function loadShard() {
      try {
        const response = await fetch(`/data/prediction-history/${entry!.path}`, { cache: "no-cache" });
        if (!response.ok) throw new Error(`月份分片 HTTP ${response.status}`);
        const text = await response.text();
        if (await sha256(text) !== entry!.sha256) throw new Error("月份分片哈希校验失败");
        const raw: unknown = JSON.parse(text);
        if (!isHistoryShard(raw)) throw new Error("月份分片契约无效");
        const shard = raw;
        if (shard.yearMonth !== filter.month || shard.summary.recordCount !== shard.records.length) throw new Error("月份分片契约不一致");
        if (!cancelled) { setRecords(shard.records); setLoading(false); }
      } catch (reason) {
        if (!cancelled) { setError(reason instanceof Error ? reason.message : String(reason)); setRecords([]); setLoading(false); }
      }
    }
    void loadShard();
    return () => { cancelled = true; };
  }, [filter.month, index]);

  useEffect(() => {
    if (!index) return;
    const params = new URLSearchParams();
    params.set("month", filter.month); params.set("market", filter.market); params.set("horizon", String(filter.horizon));
    if (filter.status !== "all") params.set("status", filter.status);
    if (filter.modelVersion !== "all") params.set("model", filter.modelVersion);
    if (filter.probabilityTarget !== "all") params.set("target", filter.probabilityTarget);
    if (filter.lineage !== "all") params.set("lineage", filter.lineage);
    if (filter.query) params.set("q", filter.query);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }, [filter, index]);

  const filtered = useMemo(() => {
    const query = filter.query.trim().toLocaleLowerCase("zh-CN");
    return records.filter((record) => record.market === filter.market && record.horizonSessions === filter.horizon)
      .filter((record) => matchesStatus(record, filter.status))
      .filter((record) => filter.modelVersion === "all" || record.modelVersion === filter.modelVersion)
      .filter((record) => filter.probabilityTarget === "all" || record.probabilityTarget === filter.probabilityTarget)
      .filter((record) => filter.lineage === "all" || (filter.lineage === "legacy") === record.legacy)
      .filter((record) => !query || `${record.sectorName} ${record.sectorId} ${record.modelVersion}`.toLocaleLowerCase("zh-CN").includes(query))
      .sort((left, right) => right.predictionDate.localeCompare(left.predictionDate) || left.sectorId.localeCompare(right.sectorId));
  }, [filter, records]);

  const update = <K extends keyof PredictionHistoryFilter>(key: K, value: PredictionHistoryFilter[K]) => { setFilter((current) => ({ ...current, [key]: value })); setVisible(60); };
  const currentModelRecords = index ? index.currentRecordCount : 0;
  const topHit = review?.metrics.topQuartileHitRate;

  return <div className="prediction-history-shell">
    <header className="prediction-history-header"><div className="prediction-history-header-inner">
      <Link className="prediction-history-back" href="/predictions"><ArrowLeft size={17} /> 返回当前预测</Link>
      <div className="prediction-history-brand"><History size={18} /><span>观潮 · 预测历史</span></div>
      <span className="prediction-history-contract"><ShieldCheck size={15} /> Git 不可覆盖账本</span>
    </div></header>
    <main className="prediction-history-main">
      <section className="prediction-history-hero"><div><p className="eyebrow">FORECAST LEDGER</p><h1>历史预测与到期复盘</h1><p>先加载索引，再按所选月份校验并加载单个分片。弃权、未训练、未实现、数据不足和待验证都不会被计成错误，也不会被伪装成概率。</p></div>
        <div className="prediction-history-proof"><Database size={20} /><div><strong>{index?.recordCount ?? "—"}</strong><span>条完整公开记录 · {index?.files.length ?? "—"} 个按月分片</span></div></div></section>
      <section className="prediction-history-summary" aria-label="账本摘要">
        <div><span>覆盖区间</span><strong>{dateLabel(index?.firstDate ?? null)} — {dateLabel(index?.lastDate ?? null)}</strong></div>
        <div><span>已成熟 / 有评价事件</span><strong>{index?.evaluatedRecordCount ?? "—"}</strong></div>
        <div><span>待验证</span><strong>{index?.pendingRecordCount ?? "—"}</strong></div>
        <div><span>发布率 / 弃权率</span><strong>{index ? `${rate(index.statusSummary.published, currentModelRecords)} / ${rate(index.statusSummary.abstained, currentModelRecords)}` : "—"}</strong></div>
        <div><span>当前模型 Top25% 命中率</span><strong>{typeof topHit === "number" ? `${(topHit * 100).toFixed(1)}%` : "样本不足"}</strong></div>
        <div><span>RankIC / Brier Skill</span><strong>{review && typeof review.metrics.rankIc === "number" ? review.metrics.rankIc.toFixed(3) : "样本不足"} / {review && typeof review.metrics.brierSkill === "number" ? review.metrics.brierSkill.toFixed(3) : "样本不足"}</strong></div>
      </section>
      <section className="prediction-history-review"><div><p className="eyebrow">WEEKLY REVIEW · {review?.isoWeek ?? "LOADING"}</p><h2>本周模型评价</h2></div><p>{review?.metrics.sampleSize ? `当前模型有效评价样本 ${review.metrics.sampleSize} 条。` : "当前模型尚无可计分样本，概率、排序与校准指标按契约保持为空。"}</p>{review?.recommendations.length ? <ul>{review.recommendations.map((item) => <li key={item}>{item}</li>)}</ul> : null}</section>
      <section className="prediction-history-controls" aria-label="历史预测筛选">
        <label><span className="sr-only">月份</span><select value={filter.month} onChange={(event) => update("month", event.target.value)}>{index?.availableMonths.map((month) => <option key={month} value={month}>{month}</option>)}</select></label>
        <div className="prediction-history-tabs" role="tablist" aria-label="市场">{markets.map((item) => <button key={item.id} type="button" role="tab" aria-selected={filter.market === item.id} className={filter.market === item.id ? "active" : ""} onClick={() => update("market", item.id)}>{item.label}</button>)}</div>
        <div className="prediction-history-horizons" role="tablist" aria-label="预测期限">{horizons.map((item) => <button key={item} type="button" role="tab" aria-selected={filter.horizon === item} className={filter.horizon === item ? "active" : ""} onClick={() => update("horizon", item)}>{item === 1 ? "下一交易日" : `${item}个交易日`}</button>)}</div>
        <label className="prediction-history-search"><Search size={16} /><span className="sr-only">搜索板块</span><input value={filter.query} onChange={(event) => update("query", event.target.value)} placeholder="搜索板块、代码或模型版本" /></label>
        <label><span className="sr-only">发布状态</span><select value={filter.status} onChange={(event) => update("status", event.target.value as PredictionHistoryFilter["status"])}>{statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span className="sr-only">模型版本</span><select value={filter.modelVersion} onChange={(event) => update("modelVersion", event.target.value)}><option value="all">全部模型版本</option>{index?.modelVersions.map((version) => <option key={version} value={version}>{version}</option>)}</select></label>
        <label><span className="sr-only">概率目标</span><select value={filter.probabilityTarget} onChange={(event) => update("probabilityTarget", event.target.value as PredictionHistoryFilter["probabilityTarget"])}>{targets.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span className="sr-only">新旧模型</span><select value={filter.lineage} onChange={(event) => update("lineage", event.target.value as PredictionHistoryFilter["lineage"])}><option value="all">legacy / current 全部</option><option value="current">仅当前模型</option><option value="legacy">仅 legacy</option></select></label>
      </section>
      <div className="prediction-history-result-line"><strong>{loading ? "…" : filtered.length}</strong> 条匹配记录 <span>· 当前只载入 {filter.month || "所选月份"}</span></div>
      {error ? <section className="prediction-history-empty" role="alert"><XCircle size={28} /><h2>历史分片加载失败</h2><p>{error}。账本不会退回空历史，也不会把校验失败的分片展示为有效数据。</p><button type="button" onClick={() => window.location.reload()}>重新加载</button></section> : loading ? <section className="prediction-history-empty"><Clock3 size={28} /><h2>正在校验月份分片</h2><p>先核对 SHA-256，再展示预测与到期结果。</p></section> : filtered.length ? <section className="prediction-history-list" aria-live="polite">
        {filtered.slice(0, visible).map((record) => { const probabilityValue = probability(record); return <article className={`prediction-history-card state-${record.publicationStatus}`} key={record.predictionId}>
          <header><div><span className="prediction-history-date">{dateLabel(record.predictionDate)}</span><h2>{record.sectorName}</h2><code>{record.sectorId}</code></div><span className="prediction-history-state">{stateLabel(record)}</span></header>
          <div className="prediction-history-metrics"><div><span>{probabilityValue?.label ?? (record.observationScore != null ? "观察分（不是概率）" : "概率输出")}</span><strong>{probabilityValue?.value != null ? `${probabilityValue.value.toFixed(1)}%` : record.observationScore != null ? record.observationScore.toFixed(1) : "未发布"}</strong></div><div><span>历史基准</span><strong>{record.historicalBaseRate == null ? "—" : `${record.historicalBaseRate.toFixed(1)}%`}</strong></div><div><span>到期结果</span><strong className={`result-${record.evaluation?.result ?? "pending"}`}><ResultIcon record={record} />{resultLabel(record)}</strong></div><div><span>实现超额收益</span><strong>{pct(record.evaluation?.realizedExcessReturn ?? null)}</strong></div></div>
          <p className="prediction-history-claim">{record.claim}</p>{record.abstainReasons.length ? <div className="prediction-history-reasons"><strong>未发布原因</strong>{record.abstainReasons.map((reason) => <span key={reason}>{reason}</span>)}</div> : null}
          <details><summary>查看契约与证据</summary><dl><div><dt>模型版本</dt><dd>{record.modelVersion}</dd></div><div><dt>概率目标</dt><dd>{record.probabilityTarget}</dd></div><div><dt>概率来源</dt><dd>{record.probabilitySource}</dd></div><div><dt>模型状态</dt><dd>{record.modelAvailability}</dd></div><div><dt>触发条件</dt><dd>{record.trigger}</dd></div><div><dt>失效条件</dt><dd>{record.invalidation}</dd></div></dl>{record.sourceUrls.length ? <div className="prediction-history-sources">{record.sourceUrls.map((url, sourceIndex) => <a key={url} href={url} target="_blank" rel="noreferrer">来源 {sourceIndex + 1}<ExternalLink size={13} /></a>)}</div> : <p className="prediction-history-no-source">该状态记录没有可公开的直接来源链接。</p>}</details>
        </article>; })}{visible < filtered.length ? <button className="prediction-history-more" type="button" onClick={() => setVisible((value) => value + 60)}>继续加载（尚余 {filtered.length - visible} 条）</button> : null}
      </section> : <section className="prediction-history-empty"><History size={28} /><h2>{filter.market === "us" ? "美股预测模型尚未实现" : "当前筛选没有记录"}</h2><p>{filter.market === "us" ? "页面明确保留未实现状态，不生成概率、不借用其他市场模型，也不把空白记成错误。" : "可切换月份、期限或筛选条件；权威记录未被删除。"}</p></section>}
    </main><MobileBottomNav active="predictions" />
  </div>;
}
