import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fileArgument = process.argv.indexOf("--file");
const file = fileArgument >= 0 && process.argv[fileArgument + 1]
  ? path.resolve(root, process.argv[fileArgument + 1])
  : path.join(root, "content", "prediction-history.json");
const payload = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => { throw new Error(`[prediction-history] ${message}`); };
const finiteOrNull = (value) => value === null || (typeof value === "number" && Number.isFinite(value));
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const results = new Set(["correct", "wrong", "near-neutral", "pending", "model-abstained", "data-insufficient", "not-applicable"]);
const legacyStatuses = new Set(["published", "model-abstained", "not_applicable"]);
const publicationStatuses = new Set(["published", "abstained", "insufficient_data", "not_applicable"]);
const availability = new Set(["trained", "not_trained", "not_implemented"]);
const outputModes = new Set(["probability", "evidence_observation", "current_observation", "none"]);
const calibrations = new Set(["enabled", "disabled", "collapsed", "not_applicable", "legacy_unknown"]);
const sources = new Set(["raw_model", "calibrated_model", "historical_base_rate", "legacy_unknown", "none"]);
const targets = new Set(["absolute_up", "relative_outperformance", "top_quartile", "none"]);
const horizons = new Set([1, 5, 20]);
const probabilityFields = ["raw_probability", "calibrated_probability", "relative_outperformance_probability", "top_quartile_probability", "absolute_up_probability"];

if (payload.schemaVersion !== 1) fail("schemaVersion 必须为 1");
if (payload.policy?.immutablePublicationSnapshots !== true) fail("必须声明历史发布快照不可覆盖");
if (payload.policy?.historicalPredictionsRecomputed !== false) fail("禁止用最新模型重算历史预测");
if (payload.contract?.legacyExcludedFromCurrentModelMetrics !== true) fail("legacy 必须排除在当前模型指标之外");
if (payload.contract?.probabilityTargetsNeverFallback !== true) fail("必须声明概率目标不允许回退");
if (!Array.isArray(payload.records)) fail("records 必须为数组");

const ids = new Set();
let published = 0;
let abstained = 0;
const legacyRecords = [];
const currentRecords = [];
for (const [index, record] of payload.records.entries()) {
  const label = `records[${index}]`;
  for (const key of [
    "prediction_id", "prediction_date", "market", "sector_id", "sector_name", "ranking_target", "prediction_status",
    "model_version", "data_as_of", "created_at", "result", "model_availability", "publication_status", "output_mode",
    "calibration_status", "probability_source", "probability_target",
  ]) {
    if (typeof record[key] !== "string" || !record[key]) fail(`${label}.${key} 缺失`);
  }
  if (typeof record.legacy !== "boolean") fail(`${label}.legacy 必须为布尔值`);
  if (ids.has(record.prediction_id)) fail(`prediction_id 重复：${record.prediction_id}`);
  ids.add(record.prediction_id);
  if (!isoDate.test(record.prediction_date) || !isoDate.test(record.data_as_of)) fail(`${label} 日期格式错误`);
  if (!horizons.has(record.horizon)) fail(`${label}.horizon 必须为 1/5/20`);
  if (!legacyStatuses.has(record.prediction_status)) fail(`${label}.prediction_status 非法`);
  if (!publicationStatuses.has(record.publication_status)) fail(`${label}.publication_status 非法`);
  if (!availability.has(record.model_availability)) fail(`${label}.model_availability 非法`);
  if (!outputModes.has(record.output_mode)) fail(`${label}.output_mode 非法`);
  if (!calibrations.has(record.calibration_status)) fail(`${label}.calibration_status 非法`);
  if (!sources.has(record.probability_source)) fail(`${label}.probability_source 非法`);
  if (!targets.has(record.probability_target)) fail(`${label}.probability_target 非法`);
  if (!results.has(record.result)) fail(`${label}.result 非法`);
  if (!Array.isArray(record.abstain_reason) || !Array.isArray(record.evidence) || !Array.isArray(record.counter_evidence) || !Array.isArray(record.source_urls)) fail(`${label} 数组字段缺失`);
  for (const key of [
    "raw_score", ...probabilityFields, "expected_excess_return", "historical_base", "effective_edge",
    "data_completeness", "model_input_completeness", "production_feature_coverage", "observation_score",
    "realized_absolute_return", "realized_benchmark_return", "realized_excess_return", "realized_sector_rank", "realized_sector_count",
  ]) {
    if (!finiteOrNull(record[key])) fail(`${label}.${key} 必须是有限数值或 null`);
  }

  if (record.legacy) {
    legacyRecords.push(record);
    if (!/legacy|probability-v1/i.test(`${record.ranking_target} ${record.model_version}`)) fail(`${label} legacy 缺少明确版本标记`);
    if (record.probability_target !== "absolute_up" || record.ranking_target !== "absolute-up-legacy") fail(`${label} legacy 必须为 absolute_up`);
    if (record.top_quartile_probability !== null || record.relative_outperformance_probability !== null) fail(`${label} legacy absolute-up 不得写入其他概率目标`);
    if (!["legacy_unknown", "historical_base_rate"].includes(record.probability_source)) fail(`${label} legacy 概率来源必须明确为 unknown/base-rate`);
    if (record.probability_source === "historical_base_rate" && record.absolute_up_probability !== record.historical_base) fail(`${label} historical_base_rate 必须明确等于基准值`);
    if (record.publication_status === "published") published += 1;
    continue;
  }

  currentRecords.push(record);
  if (record.publication_status === "published") {
    published += 1;
    if (record.model_availability !== "trained" || record.output_mode !== "probability") fail(`${label} published 必须来自已训练概率模型`);
    if (!["raw_model", "calibrated_model"].includes(record.probability_source)) fail(`${label} published 不得使用 historical base 或未知概率来源`);
    const value = record.probability_target === "top_quartile" ? record.top_quartile_probability
      : record.probability_target === "absolute_up" ? record.absolute_up_probability
        : record.probability_target === "relative_outperformance" ? record.relative_outperformance_probability : null;
    if (!finiteOrNull(value) || value === null) fail(`${label} 已发布记录缺少与目标一致的模型概率`);
    if (record.observation_score != null) fail(`${label} 已发布概率不得混入观察分`);
  } else if (record.publication_status === "abstained") {
    abstained += 1;
    if (record.model_availability !== "trained" || record.output_mode !== "evidence_observation") fail(`${label} abstained 必须是已训练模型的证据观察`);
    if (!record.abstain_reason.length) fail(`${label} abstained 必须保存 gateFailures`);
    if (probabilityFields.some((key) => record[key] !== null)) fail(`${label} 弃权记录不得携带页面概率`);
    if (record.result !== "model-abstained" || record.prediction_status !== "model-abstained") fail(`${label} 弃权记录状态错误`);
  } else if (record.model_availability !== "trained") {
    if (record.publication_status !== "not_applicable" || record.output_mode !== "current_observation") fail(`${label} 未训练/未实现模型不得伪装为弃权`);
    if (record.probability_source !== "none" || record.probability_target !== "none" || record.calibration_status !== "not_applicable") fail(`${label} 无模型记录必须全部关闭概率语义`);
    if (probabilityFields.some((key) => record[key] !== null)) fail(`${label} 无模型记录的概率字段必须为 null`);
    if (record.prediction_status !== "not_applicable" || record.result !== "not-applicable") fail(`${label} 无模型记录必须标记为 not_applicable`);
  } else {
    fail(`${label} 已训练模型缺少有效 publication_status`);
  }
  if (record.result !== "pending" && record.result !== "model-abstained" && record.result !== "not-applicable" && !record.evaluated_at) fail(`${label} 已到期结果缺少 evaluated_at`);
}

if (payload.summary?.records !== payload.records.length) fail("summary.records 与实际数量不一致");
if (payload.summary?.published !== published) fail("summary.published 与实际数量不一致");
if (payload.summary?.abstained !== abstained) fail("summary.abstained 与实际数量不一致");
if (payload.summary?.legacy?.records !== legacyRecords.length || payload.summary?.legacy?.published !== legacyRecords.filter((record) => record.publication_status === "published").length) fail("summary.legacy 与实际数量不一致");
if (payload.summary?.currentModel?.records !== currentRecords.length || payload.summary?.currentModel?.abstained !== abstained) fail("summary.currentModel 与实际数量不一致");

console.log(`预测历史校验通过：${payload.records.length} 条不可覆盖快照，当前模型发布 ${payload.summary.currentModel.published}，弃权 ${abstained}，legacy ${legacyRecords.length}。`);
