import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Canonical } from "./research-contract.mjs";
import { resolveMarketDateContract } from "./market-date-contract.mjs";

export const DAILY_PACKET_SCHEMA = "daily-market-packet-v1";
export const REVIEW_PACKET_SCHEMA = "prediction-review-packet-v1";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function sha256File(file) {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function shanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function utcTimestamp(value = new Date()) {
  return new Date(value).toISOString();
}

function businessPacket(value) {
  const { packetId, integrity, ...body } = value;
  return body;
}

function withIntegrity(value) {
  const businessSha256 = sha256Canonical(businessPacket(value));
  return { ...value, packetId: businessSha256, integrity: { businessSha256, sha256: sha256Canonical({ ...businessPacket(value), packetId: businessSha256, integrity: { businessSha256, sha256: null } }) } };
}

function sourceEntry(root, relativePath, kind = "derived") {
  const file = path.join(root, ...relativePath.split("/"));
  return { path: relativePath, kind, sha256: sha256File(file), present: fs.existsSync(file) };
}

function predictionRecords(root) {
  const value = readJson(path.join(root, "content", "prediction-history.json"), {});
  return Array.isArray(value.records) ? value.records : [];
}

const PROBABILITY_FIELDS = ["calibrated_probability", "raw_probability", "absolute_up_probability", "relative_outperformance_probability", "top_quartile_probability"];

function probabilityField(record) {
  const targetField = {
    absolute_up: "absolute_up_probability",
    relative_outperformance: "relative_outperformance_probability",
    top_quartile: "top_quartile_probability",
  }[record?.probability_target];
  if (targetField && Number.isFinite(record?.[targetField])) return targetField;
  return PROBABILITY_FIELDS.find((field) => Number.isFinite(record?.[field])) ?? null;
}

export function normalizePublishedProbability(record) {
  const field = probabilityField(record);
  const raw = field ? Number(record[field]) : null;
  if (raw === null) return { field: null, raw: null, unit: null, probability: null };
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) throw new Error(`PREDICTION_PROBABILITY_INVALID ${record?.prediction_id ?? "unknown"}: ${raw}`);
  const declared = String(record?.probability_unit ?? record?.probabilityUnit ?? record?.probability_scale ?? record?.probabilityScale ?? "").toLowerCase();
  const fraction = declared.includes("fraction") || declared === "0-1" || declared === "01";
  const percent = declared.includes("percent") || declared.includes("percentage") || declared === "0-100" || (!fraction && raw > 1);
  const probability = percent ? raw / 100 : raw;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`PREDICTION_PROBABILITY_INVALID ${record?.prediction_id ?? "unknown"}: normalized=${probability}`);
  return { field, raw, unit: fraction ? "fraction" : "percent", probability };
}

export function brierScore(probability, outcome) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`BRIER_PROBABILITY_OUT_OF_RANGE ${probability}`);
  if (outcome !== 0 && outcome !== 1) throw new Error(`BRIER_OUTCOME_INVALID ${outcome}`);
  const score = (probability - outcome) ** 2;
  if (score < 0 || score > 1) throw new Error(`BRIER_SCORE_OUT_OF_RANGE ${score}`);
  return score;
}

export function modelPublicationStatus(record) {
  if (record?.publication_status === "published") return "published";
  if (record?.publication_status === "abstained" || record?.prediction_status === "model-abstained" || record?.result === "model-abstained") return "abstained";
  return "not_applicable";
}

export function observationStatus(record) {
  return record?.output_mode === "evidence_observation" || record?.ranking_target === "evidence-observation" || Number.isFinite(record?.observation_score)
    ? "evidence_observation"
    : "none";
}

function predictionClass(record) {
  if (modelPublicationStatus(record) === "published") return "published_model_prediction";
  if (observationStatus(record) === "evidence_observation") return "evidence_observation";
  if (modelPublicationStatus(record) === "abstained") return "abstained";
  return "not_applicable";
}

function latestRecords(records, asOf) {
  return records.filter((record) => typeof record?.prediction_date === "string" && record.prediction_date <= asOf)
    .sort((left, right) => String(right.prediction_date).localeCompare(String(left.prediction_date)) || String(left.prediction_id).localeCompare(String(right.prediction_id)));
}

function evaluationFor(record, asOf) {
  const realizedReturn = Number.isFinite(record?.realized_absolute_return) ? record.realized_absolute_return : null;
  const benchmarkReturn = Number.isFinite(record?.realized_benchmark_return) ? record.realized_benchmark_return : null;
  const relativeReturn = Number.isFinite(record?.realized_excess_return) ? record.realized_excess_return : null;
  const rank = Number.isFinite(record?.realized_sector_rank) ? record.realized_sector_rank : null;
  const sectorCount = Number.isFinite(record?.realized_sector_count) ? record.realized_sector_count : null;
  const quartile = typeof record?.realized_top_quartile === "boolean"
    ? (record.realized_top_quartile ? "top_quartile" : "not_top_quartile")
    : rank !== null && sectorCount !== null && sectorCount > 0 ? (rank <= Math.ceil(sectorCount / 4) ? "top_quartile" : "not_top_quartile") : null;
  const mature = typeof record?.evaluated_at === "string" || (typeof record?.due_date === "string" && record.due_date <= asOf);
  const hasRealized = realizedReturn !== null || benchmarkReturn !== null || relativeReturn !== null || rank !== null || quartile !== null;
  return {
    status: !mature ? "pending" : hasRealized ? "evaluated" : "unavailable",
    reason: !mature ? "maturity_not_reached" : hasRealized ? null : "mature_record_has_no_realized_return_or_rank_fields",
    maturityDate: record?.due_date ?? null,
    evaluatedAt: record?.evaluated_at ?? null,
    realizedReturn,
    benchmarkReturn,
    relativeReturn,
    rank,
    sectorCount,
    quartile,
    sourceRecordIds: [record?.prediction_id].filter(Boolean),
  };
}

function compactPrediction(record, asOf) {
  const probability = normalizePublishedProbability(record);
  const modelStatus = modelPublicationStatus(record);
  const observation = observationStatus(record);
  return {
    predictionId: record.prediction_id ?? null,
    predictionDate: record.prediction_date ?? null,
    market: record.market ?? null,
    horizonSessions: record.horizon ?? null,
    sectorId: record.sector_id ?? null,
    sectorName: record.sector_name ?? null,
    classification: predictionClass(record),
    modelPublicationStatus: modelStatus,
    observationStatus: observation,
    publicationStatus: record.publication_status ?? null,
    outputMode: record.output_mode ?? null,
    modelVersion: record.model_version ?? null,
    dueDate: record.due_date ?? null,
    evaluatedAt: record.evaluated_at ?? null,
    result: record.result ?? null,
    observationScore: Number.isFinite(record.observation_score) ? record.observation_score : null,
    probabilityPresent: modelStatus === "published" && probability.probability !== null,
    probabilityRaw: modelStatus === "published" ? probability.raw : null,
    probabilityUnit: modelStatus === "published" ? probability.unit : null,
    probability: modelStatus === "published" ? probability.probability : null,
    targetOutcome: record.realized_top_quartile ?? null,
    evaluation: evaluationFor(record, asOf),
    sourceRecordIds: [record?.prediction_id].filter(Boolean),
  };
}

function reviewHorizon(records, horizon, asOf) {
  const selected = latestRecords(records, asOf).filter((record) => Number(record.horizon) === horizon);
  const byClass = Object.fromEntries(["published_model_prediction", "evidence_observation", "abstained", "not_applicable"].map((key) => [key, selected.filter((record) => predictionClass(record) === key)]));
  const published = selected.filter((record) => modelPublicationStatus(record) === "published");
  const abstained = selected.filter((record) => modelPublicationStatus(record) === "abstained");
  const observations = selected.filter((record) => observationStatus(record) === "evidence_observation");
  const maturedModels = published.filter((record) => evaluationFor(record, asOf).status !== "pending");
  const evaluatedModels = maturedModels.filter((record) => evaluationFor(record, asOf).status === "evaluated");
  const outcomes = evaluatedModels.filter((record) => typeof record.realized_top_quartile === "boolean");
  const probabilityRecords = evaluatedModels.map((record) => ({ record, probability: normalizePublishedProbability(record) })).filter(({ probability }) => probability.probability !== null && typeof probability.probability === "number");
  const brierRows = probabilityRecords.filter(({ record }) => typeof record.realized_top_quartile === "boolean").map(({ record, probability }) => ({ predictionId: record.prediction_id, score: brierScore(probability.probability, record.realized_top_quartile ? 1 : 0) }));
  const brier = brierRows.length ? brierRows.reduce((sum, row) => sum + row.score, 0) / brierRows.length : null;
  const allEvaluationRows = selected.map((record) => ({ predictionId: record.prediction_id, evaluation: evaluationFor(record, asOf) }));
  return {
    horizonSessions: horizon,
    counts: {
      total: selected.length,
      publishedModelPrediction: published.length,
      evidenceObservation: observations.length,
      abstained: abstained.length,
      notApplicable: selected.filter((record) => modelPublicationStatus(record) === "not_applicable").length,
      maturedPublishedModelPrediction: maturedModels.length,
      maturedOutcomes: outcomes.length,
      modelPublication: { published: published.length, abstained: abstained.length, notApplicable: selected.length - published.length - abstained.length },
      observations: observations.length,
      observationWithRealizedFields: observations.filter((record) => evaluationFor(record, asOf).status === "evaluated").length,
    },
    publishedModelPrediction: {
      status: outcomes.length ? "evaluated" : maturedModels.length ? "partial" : "pending",
      accuracy: null,
      brier: Number.isFinite(brier) ? Number(brier.toFixed(6)) : null,
      brierDenominator: brierRows.length,
      brierRecordIds: brierRows.map((row) => row.predictionId),
      probabilityScale: "fraction_0_to_1",
      note: "只有 published model prediction 可进入模型评估；observation 不进入准确率/命中率分母。",
    },
    evidenceObservation: {
      count: byClass.evidence_observation.length,
      withRealizedFields: observations.filter((record) => evaluationFor(record, asOf).status === "evaluated").length,
      notModelAccuracy: true,
      note: "evidence observation 只保留事实观察与回看，不称为模型准确率或命中率。",
    },
    abstained: { count: abstained.length, excludedFromModelDenominator: true, recordIds: abstained.map((record) => record.prediction_id) },
    notApplicable: { count: byClass.not_applicable.length, excludedFromModelDenominator: true },
    evaluation: {
      status: maturedModels.length === published.length && published.length ? (evaluatedModels.length ? "evaluated_or_unavailable" : "unavailable") : published.length ? "partial" : "pending",
      evaluatedRecordIds: evaluatedModels.map((record) => record.prediction_id),
      unavailableRecordIds: maturedModels.filter((record) => evaluationFor(record, asOf).status === "unavailable").map((record) => record.prediction_id),
      rows: allEvaluationRows.slice(0, 120),
    },
    rows: selected.slice(0, 120).map((record) => compactPrediction(record, asOf)),
  };
}

export function buildPredictionReviewPacket({ root = repositoryRoot, asOf = shanghaiDate(), generatedAt = utcTimestamp(), records = predictionRecords(root) } = {}) {
  if (!DATE.test(asOf)) throw new Error(`invalid review asOf: ${asOf}`);
  const packet = {
    schemaVersion: REVIEW_PACKET_SCHEMA,
    asOfDate: asOf,
    generatedAt,
    status: "partial",
    classificationContract: {
      published_model_prediction: "probability-bearing published model output; eligible for model review",
      evidence_observation: "validated observation/ranking; never probability accuracy",
      abstained: "model abstention; excluded from denominator",
      not_applicable: "model unavailable or not applicable; excluded from denominator",
    },
    horizons: { "1d": reviewHorizon(records, 1, asOf), "5d": reviewHorizon(records, 5, asOf), "20d": reviewHorizon(records, 20, asOf) },
    source: { path: "content/prediction-history.json", sha256: sha256File(path.join(root, "content", "prediction-history.json")), immutableLedger: true, ledgerWrite: false },
    warnings: ["本轮为 Writer/研究回看包；不写 production prediction ledger，不自动 promotion，不发布新的 HK probability。"],
  };
  return withIntegrity(packet);
}

function newsCandidates(root, asOf) {
  const directory = path.join(root, "content", "global-market-briefs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse().map((name) => {
    const relativePath = `content/global-market-briefs/${name}`;
    const value = readJson(path.join(root, ...relativePath.split("/")), {});
    const article = value.mainArticle ?? value;
    return { articleId: article.id ?? value.id ?? name.slice(0, -5), editionDate: name.slice(0, 10), title: article.title ?? value.title ?? null, articleUrl: article.articleUrl ?? value.articleUrl ?? null, dataAsOf: article.dataAsOf ?? value.dataAsOf ?? null, sourceCount: Array.isArray(article.keyFacts) ? article.keyFacts.length : null, availableForResearch: name.slice(0, 10) <= asOf };
  }).filter((item) => item.availableForResearch).slice(0, 12);
}

function latestGlobalBrief(root, asOf) {
  const directory = path.join(root, "content", "global-market-briefs");
  if (!fs.existsSync(directory)) return null;
  return fs.readdirSync(directory).filter((name) => DATE.test(name.slice(0, 10)) && name.endsWith(".json")).sort().reverse().map((name) => ({ name, value: readJson(path.join(directory, name), null) })).find(({ value }) => value?.editionDate <= asOf && DATE.test(value?.dataAsOf ?? "") && value.dataAsOf <= value.editionDate) ?? null;
}

function sourceUrlById(brief, sourceId) {
  return brief?.value?.sourceIndex?.find((source) => source.id === sourceId)?.url ?? null;
}

function historyBars(root, slug) {
  const value = readJson(path.join(root, "public", "data", "market-history", `${slug}.json`), null);
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.bars)) return value.bars;
  return [];
}

function parseIndexFact(facts, pattern) {
  for (const fact of facts) {
    const match = String(fact.statement ?? "").match(pattern);
    if (!match) continue;
    const direction = match[1] === "下跌" ? -1 : 1;
    return { fact, value: Number(String(match[3]).replaceAll(",", "")), percentChange: direction * Number(match[2]) };
  }
  return null;
}

function indexObservation(root, brief, { key, label, slug, factPattern, dataAsOf }) {
  const facts = brief?.value?.mainArticle?.keyFacts ?? [];
  const parsed = parseIndexFact(facts, factPattern);
  const rows = historyBars(root, slug).filter((row) => typeof row?.time === "string" && row.time <= dataAsOf).sort((left, right) => left.time.localeCompare(right.time));
  const current = rows.at(-1);
  const previous = rows.at(-2);
  const sameSession = current?.time === dataAsOf && Number.isFinite(current?.close);
  const historyValue = sameSession ? Number(current.close) : null;
  const value = parsed?.value ?? historyValue;
  const pointChange = sameSession && Number.isFinite(previous?.close) ? Number((current.close - previous.close).toFixed(6)) : null;
  const historyPercentChange = sameSession && Number.isFinite(previous?.close) && previous.close !== 0
    ? Number((((current.close / previous.close) - 1) * 100).toFixed(6))
    : null;
  const percentChange = parsed?.percentChange ?? historyPercentChange;
  const sourceId = parsed?.fact?.sourceIds?.[0] ?? (sameSession ? `market-history:${slug}` : null);
  const status = value !== null && Number.isFinite(value) ? "ready" : "unavailable";
  const crossCheckConflict = parsed?.value !== null && parsed?.value !== undefined && historyValue !== null
    && Math.abs(parsed.value - historyValue) > 0.01;
  return {
    key,
    label,
    value,
    pointChange,
    percentChange,
    asOf: sameSession ? current.time : parsed?.fact?.asOf ?? dataAsOf,
    status,
    unit: "index_point",
    sourceId,
    sourceUrl: sourceUrlById(brief, sourceId),
    evidenceStatus: parsed?.fact?.factStatus ?? (sameSession ? "derived" : null),
    crossCheck: sameSession ? {
      sourceId: `market-history:${slug}`,
      value: historyValue,
      percentChange: historyPercentChange,
      asOf: current.time,
      status: crossCheckConflict ? "conflict" : "consistent",
    } : null,
    anomaly: crossCheckConflict ? "authoritative_fact_history_conflict" : null,
    reason: status === "ready" && pointChange === null ? "cited evidence has no prior-point delta" : status === "unavailable" ? "no validated value in current authoritative evidence" : null,
  };
}

function unavailableMetric(key, label, asOf, reason) {
  return { key, label, value: null, pointChange: null, percentChange: null, asOf, status: "unavailable", unit: null, sourceId: null, sourceUrl: null, reason };
}

function buildCoreIndices(root, brief, dataAsOf) {
  const specs = [
    ["aShare", "sse", "上证指数", "sse-composite", /上证指数(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["aShare", "szse", "深证成指", "szse-component", /深证成指(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["aShare", "chinext", "创业板指", "chinext", /创业板指(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["hk", "hsi", "恒生指数", "hang-seng", /恒生指数(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["hk", "hscei", "恒生中国企业指数", "hang-seng-china-enterprises", /恒生中国企业指数(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["hk", "hstech", "恒生科技指数", "hang-seng-tech", /恒生科技指数(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["us", "dow", "道琼斯", "dow-jones", /道指(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["us", "nasdaq", "纳斯达克", "nasdaq-composite", /纳指(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
    ["us", "sp500", "标普500", "sp500", /标普500(上涨|下跌)([\d.]+)%至([\d,.]+)点/],
  ];
  const result = { aShare: {}, hk: {}, us: {} };
  for (const [market, key, label, slug, pattern] of specs) result[market][key] = indexObservation(root, brief, { key, label, slug, factPattern: pattern, dataAsOf });
  return result;
}

function buildRates(packetSource, asOf) {
  const values = [
    ["twoYear", "US Treasury 2Y", "2年期国债收益率"],
    ["tenYear", "US Treasury 10Y", "10年期国债收益率"],
    ["thirtyYear", "US Treasury 30Y", "30年期国债收益率"],
    ["realTenYear", "US Treasury real 10Y", "实际10年期国债收益率"],
    ["twoTenSpread", "US Treasury 2s10s spread", "2年期与10年期国债收益率利差"],
  ];
  return Object.fromEntries(values.map(([key, label, factLabel]) => {
    const fact = (packetSource.facts ?? []).find((item) => item.label === label || String(item.label ?? "").includes(factLabel));
    return [key, fact ? { key, label, value: fact.value, unit: fact.unit, asOf: fact.asOf, status: fact.status, sourceId: fact.sourceId, sourceUrl: fact.sourceUrl, change1d: fact.change1d, change5d: fact.change5d, change20d: fact.change20d } : { key, label, value: null, unit: null, asOf, status: "unavailable", sourceId: null, sourceUrl: null, reason: "current writer packet has no validated rate fact" }];
  }));
}

function buildObservationBoard(rotation) {
  const market = rotation.markets?.find?.((item) => item.id === "a-share");
  const sources = market?.sources ?? [];
  const items = market?.horizons?.current?.items ?? [];
  return items.map((item) => ({
    sector: item.sector ?? null,
    code: item.code ?? null,
    rank: item.rank ?? null,
    score: item.score ?? null,
    direction: item.direction ?? null,
    signal: item.signal ?? null,
    asOf: market?.horizons?.current?.asOf ?? market?.asOf ?? null,
    isProbability: false,
    outputMode: "evidence_observation",
    sourceLineage: (item.sourceIndexes ?? []).map((index) => sources[index]?.url ?? null).filter(Boolean),
  }));
}

function marketPredictionState(rotation, marketId) {
  const market = rotation.markets?.find?.((item) => item.id === marketId);
  const horizons = Object.fromEntries([[1, "tomorrow"], [5, "oneWeek"], [20, "oneMonth"]].map(([sessions, key]) => {
    const horizon = market?.horizons?.[key] ?? null;
    return [String(sessions), horizon ? {
      status: horizon.status ?? "unavailable",
      modelPublicationStatus: horizon.publicationStatus === "published" ? "published" : horizon.publicationStatus === "abstained" ? "abstained" : "not_applicable",
      observationStatus: horizon.outputMode === "evidence_observation" || horizon.outputMode === "current_observation" ? "evidence_observation" : "none",
      outputMode: horizon.outputMode ?? null,
      asOf: horizon.asOf ?? market?.asOf ?? null,
      dueDate: horizon.dueDate ?? null,
      gateFailures: horizon.gateFailures ?? horizon.abstainReasons ?? [],
    } : { status: "unavailable", modelPublicationStatus: "not_applicable", observationStatus: "none", outputMode: "none", asOf: null, dueDate: null, gateFailures: ["market horizon unavailable"] }];
  }));
  return { market: marketId, currentStatus: market?.status ?? "unavailable", currentAsOf: market?.horizons?.current?.asOf ?? market?.asOf ?? null, horizons };
}

export function buildDailyMarketPacket({ root = repositoryRoot, asOf = shanghaiDate(), generatedAt = utcTimestamp(), writerPacket = null, sectorRotation = null } = {}) {
  const packetPath = path.join(root, "content", "writer-packets", "daily-latest.json");
  const rotationPath = path.join(root, "content", "sector-rotation.json");
  const historyPath = path.join(root, "public", "data", "market-history", "hang-seng-tech.json");
  const packetSource = writerPacket ?? readJson(packetPath, {});
  const rotation = sectorRotation ?? readJson(rotationPath, {});
  const hstech = readJson(historyPath, {});
  const aShare = rotation.markets?.find?.((market) => market.id === "a-share") ?? rotation.markets?.[0] ?? {};
  const marketDates = packetSource.marketDates ?? {};
  const brief = latestGlobalBrief(root, asOf);
  const dateContract = resolveMarketDateContract({ root, requestedDate: asOf });
  const dataAsOf = brief?.value?.dataAsOf ?? dateContract.dataAsOf ?? marketDates.aShare ?? asOf;
  const coreIndices = buildCoreIndices(root, brief, dataAsOf);
  const allCoreIndices = Object.values(coreIndices).flatMap((group) => Object.values(group));
  const knownGaps = [...(packetSource.missingData ?? []), ...allCoreIndices.filter((item) => item.status === "unavailable").map((item) => `coreIndices.${item.key}`), ...(hstech.status !== "ready" ? ["HSTECH"] : [])].filter((value, index, array) => array.indexOf(value) === index).sort();
  const sourceIndex = [
    sourceEntry(root, "content/writer-packets/daily-latest.json"),
    sourceEntry(root, "content/sector-rotation.json"),
    sourceEntry(root, "public/data/market-history/index.json"),
    sourceEntry(root, "public/data/market-history/hang-seng-tech.json"),
    ...(brief ? [sourceEntry(root, `content/global-market-briefs/${brief.name}`, "evidence")] : []),
  ];
  const packet = {
    schemaVersion: DAILY_PACKET_SCHEMA,
    edition: "daily",
    editionDate: asOf,
    generatedAt,
    status: packetSource.providerHealth?.requiredSourcesReady === true && knownGaps.length === 0 ? "ready" : "partial",
    writerProductName: "观潮每日晚报",
    dataAsOf,
    writerMayBrowse: true,
    browseTriggers: ["疑点", "缺失", "未更新", "数据和新闻冲突", "重大政策", "异常行情", "值得深入研究的话题", "18:20–20:00 新发生事件"],
    markets: {
      aShare: { status: aShare.status ?? packetSource.marketSummary?.status ?? "partial", asOf: aShare.asOf ?? dataAsOf, modelFeatureIncluded: true },
      hk: { status: hstech.status ?? "unavailable", asOf: hstech.asOf ?? null, hstechRows: Array.isArray(hstech.bars) ? hstech.bars.length : 0, modelFeatureIncluded: false },
      us: { status: allCoreIndices.filter((item) => item.key === "dow" || item.key === "nasdaq" || item.key === "sp500").every((item) => item.status === "ready") ? "ready" : "partial", asOf: dataAsOf, modelFeatureIncluded: false },
    },
    coreIndices,
    rates: buildRates(packetSource, dataAsOf),
    volatility: { vix: { key: "vix", label: "CBOE VIX", value: null, unit: "index_point", asOf: dataAsOf, status: "unavailable", sourceId: null, sourceUrl: null, reason: "current validated packet has no VIX observation" } },
    fx: { usdHkd: unavailableMetric("usdHkd", "USD/HKD", dataAsOf, "current validated packet has no USD/HKD observation"), usdCnh: unavailableMetric("usdCnh", "USD/CNH", dataAsOf, "current validated packet has no USD/CNH observation") },
    marketBreadth: { status: "unavailable", asOf: dataAsOf, sourceId: null, sourceUrl: null, reason: "市场广度数据未取得；不得用缺失数据推断上涨家数、内部参与度或资金净流入" },
    aShareObservationBoard: buildObservationBoard(rotation),
    facts: Array.isArray(packetSource.facts) ? packetSource.facts.slice(0, 80).map((fact) => ({ factId: fact.factId, label: fact.label, market: fact.market, value: fact.value, unit: fact.unit, asOf: fact.asOf, status: fact.status, sourceId: fact.sourceId, sourceUrl: fact.sourceUrl })) : [],
    predictionState: {
      outputMode: "probability_or_evidence_observation_by_gate",
      note: "规则门禁失败时只能写规则观察分，不是概率；abstained 不等于预测错误。",
      horizons: [1, 5, 20],
      recordsAvailable: predictionRecords(root).filter((record) => record.prediction_date <= asOf).length,
      markets: { aShare: marketPredictionState(rotation, "a-share"), hk: marketPredictionState(rotation, "hk"), us: marketPredictionState(rotation, "us") },
    },
    newsCandidates: newsCandidates(root, asOf),
    sourceIndex,
    sourceHealth: { writerPacket: packetSource.providerHealth ?? { status: "unavailable" }, hstech: { status: hstech.status ?? "unavailable", rows: Array.isArray(hstech.bars) ? hstech.bars.length : 0 }, dateContract: { authority: dateContract.authority, sourcePath: dateContract.sourcePath, dataAsOf: dateContract.dataAsOf } },
    knownGaps,
    anomalies: [
      packetSource.providerHealth?.status === "partial" ? "writer-packet-provider-health-partial" : null,
      hstech.status !== "ready" ? "hstech-not-ready" : null,
      ...allCoreIndices.filter((item) => item.anomaly).map((item) => `coreIndices.${item.key}:${item.anomaly}`),
    ].filter(Boolean),
    lineage: { authority: dateContract, sourceIndex },
    missingData: knownGaps,
    warnings: ["Packet 是已验证事实底座，不是 Writer 信息上限；Writer 必须在触发条件下主动联网搜索。", "Policy/State Capital Watch 只供 Writer/研究记忆，不进入 production model feature。"],
  };
  return withIntegrity(packet);
}

export function buildAllPackets(options = {}) {
  return { daily: buildDailyMarketPacket(options), review: buildPredictionReviewPacket(options) };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

export function writePackets(output, value) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "DAILY_MARKET_PACKET.json"), `${canonicalJson(value.daily)}\n`, "utf8");
  fs.writeFileSync(path.join(output, "PREDICTION_REVIEW_PACKET.json"), `${canonicalJson(value.review)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const root = path.resolve(argument("--root", repositoryRoot));
    const asOf = argument("--date", shanghaiDate());
    const output = path.resolve(argument("--output", path.join("D:\\Guanchao-Workspace", "runtime", "packets", asOf)));
    const packets = buildAllPackets({ root, asOf, generatedAt: argument("--generated-at", utcTimestamp()) });
    writePackets(output, packets);
    console.log(JSON.stringify({ output, daily: { packetId: packets.daily.packetId, status: packets.daily.status }, review: { packetId: packets.review.packetId, status: packets.review.status } }, null, 2));
  } catch (error) {
    console.error(`PACKET_BUILD_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
