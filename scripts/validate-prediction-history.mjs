import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const file = path.join(root, "content", "prediction-history.json");
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => { throw new Error(`[prediction-history] ${message}`); };
const finiteOrNull = (value) => value === null || value === undefined || (typeof value === "number" && Number.isFinite(value));
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const results = new Set(["correct", "wrong", "near-neutral", "pending", "model-abstained", "data-insufficient"]);
const statuses = new Set(["published", "model-abstained"]);
const horizons = new Set([1, 5, 20]);

if (payload.schemaVersion !== 1) fail("schemaVersion 必须为 1");
if (payload.policy?.immutablePublicationSnapshots !== true) fail("必须声明历史发布快照不可覆盖");
if (payload.policy?.historicalPredictionsRecomputed !== false) fail("禁止用最新模型重算历史预测");
if (!Array.isArray(payload.records)) fail("records 必须为数组");

const ids = new Set();
let published = 0;
let abstained = 0;
for (const [index, record] of payload.records.entries()) {
  const label = `records[${index}]`;
  for (const key of ["prediction_id", "prediction_date", "market", "sector_id", "sector_name", "ranking_target", "prediction_status", "model_version", "data_as_of", "created_at", "result"]) {
    if (typeof record[key] !== "string" || !record[key]) fail(`${label}.${key} 缺失`);
  }
  if (ids.has(record.prediction_id)) fail(`prediction_id 重复：${record.prediction_id}`);
  ids.add(record.prediction_id);
  if (!isoDate.test(record.prediction_date) || !isoDate.test(record.data_as_of)) fail(`${label} 日期格式错误`);
  if (!horizons.has(record.horizon)) fail(`${label}.horizon 必须为 1/5/20`);
  if (!statuses.has(record.prediction_status)) fail(`${label}.prediction_status 非法`);
  if (!results.has(record.result)) fail(`${label}.result 非法`);
  if (!Array.isArray(record.abstain_reason) || !Array.isArray(record.evidence) || !Array.isArray(record.counter_evidence) || !Array.isArray(record.source_urls)) fail(`${label} 数组字段缺失`);
  for (const key of [
    "raw_score", "raw_probability", "calibrated_probability",
    "relative_outperformance_probability", "top_quartile_probability",
    "absolute_up_probability", "expected_excess_return", "historical_base",
    "effective_edge", "data_completeness", "observation_score",
    "realized_absolute_return", "realized_benchmark_return", "realized_excess_return",
    "realized_sector_rank", "realized_sector_count",
  ]) {
    if (!finiteOrNull(record[key])) fail(`${label}.${key} 必须是有限数值或 null`);
  }
  if (record.prediction_status === "published") {
    published += 1;
    const hasPublishedValue = finiteOrNull(record.top_quartile_probability) && record.top_quartile_probability != null
      || finiteOrNull(record.absolute_up_probability) && record.absolute_up_probability != null;
    if (!hasPublishedValue) fail(`${label} 已发布记录缺少真实发布概率`);
    if (record.observation_score != null) fail(`${label} 已发布概率不得混入观察分`);
  } else {
    abstained += 1;
    if (record.top_quartile_probability != null || record.calibrated_probability != null || record.relative_outperformance_probability != null || record.absolute_up_probability != null) {
      fail(`${label} 弃权记录不得携带概率`);
    }
    if (record.result !== "model-abstained") fail(`${label} 弃权记录结果状态错误`);
  }
  if (record.result !== "pending" && record.result !== "model-abstained" && !record.evaluated_at) fail(`${label} 已到期结果缺少 evaluated_at`);
}

if (payload.summary?.records !== payload.records.length) fail("summary.records 与实际数量不一致");
if (payload.summary?.published !== published) fail("summary.published 与实际数量不一致");
if (payload.summary?.abstained !== abstained) fail("summary.abstained 与实际数量不一致");

console.log(`预测历史校验通过：${payload.records.length} 条不可覆盖快照，发布 ${published}，弃权 ${abstained}。`);
