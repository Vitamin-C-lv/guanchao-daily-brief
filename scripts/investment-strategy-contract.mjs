import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INVESTMENT_STRATEGY_SCHEMA_VERSION = "investment-strategy-v1";
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const INSTRUMENT_CATALOG = Object.freeze([
  { targetId: "csi300", market: "a-share", targetType: "broad_index_etf", label: "沪深300 / 大盘宽基ETF" },
  { targetId: "sse50", market: "a-share", targetType: "broad_index_etf", label: "上证50 / 大盘宽基ETF" },
  { targetId: "csi500", market: "a-share", targetType: "mid_cap_index_etf", label: "中证500 / 中盘指数ETF" },
  { targetId: "hang_seng", market: "hk", targetType: "broad_index_etf", label: "恒生指数 / 港股宽基ETF" },
  { targetId: "hang_seng_tech", market: "hk", targetType: "growth_index_etf", label: "恒生科技 / 港股成长ETF" },
  { targetId: "sp500", market: "us", targetType: "broad_index_etf", label: "S&P 500 / 美股大盘指数基金" },
  { targetId: "nasdaq_100", market: "us", targetType: "growth_index_etf", label: "Nasdaq-100 / 美股成长指数基金" },
]);

const modelStatuses = new Set(["published", "abstained", "unavailable", "no_direct_model_signal"]);
const strategyModelStatuses = new Set(["published", "abstained", "unavailable"]);
const stances = new Set(["risk_on", "neutral", "risk_off"]);
const actions = new Set(["increase", "hold", "reduce"]);
const directions = new Set(["bullish", "neutral", "bearish"]);
const horizons = new Set(["1_5d", "2_4w", "next_week", "one_month"]);
const agreements = new Set(["agree", "override", "not_applicable"]);
const probabilityTargets = new Set(["absolute_up", "relative_outperformance", "top_quartile"]);

export class InvestmentStrategyContractError extends Error {
  constructor(code, field, message) {
    super(message);
    this.name = "InvestmentStrategyContractError";
    this.code = code;
    this.path = field;
  }
}

function fail(code, field, message) {
  throw new InvestmentStrategyContractError(code, field, message);
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("STRATEGY_TYPE", field, "object required");
  return value;
}

function exactKeys(value, keys, field) {
  const actual = Object.keys(object(value, field)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("STRATEGY_FIELDS", field, "unexpected or missing fields");
}

function string(value, field, max = 600) {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("STRATEGY_STRING", field, `non-empty string up to ${max} characters required`);
  return value;
}

function ids(value, field, sourceIds, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || !item.trim())) fail("STRATEGY_SOURCE_IDS", field, `array with at least ${min} source IDs required`);
  if (new Set(value).size !== value.length) fail("STRATEGY_SOURCE_IDS", field, "source IDs must be unique");
  if (sourceIds) for (const id of value) if (!sourceIds.has(id)) fail("STRATEGY_SOURCE_IDS", field, `unknown source ID ${id}`);
  return value;
}

function predictionIds(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) fail("STRATEGY_PREDICTION_IDS", field, "prediction ID array required");
  if (new Set(value).size !== value.length) fail("STRATEGY_PREDICTION_IDS", field, "prediction IDs must be unique");
  return value;
}

function readerCopy(value, field) {
  string(value, field, 900);
  if (/(?:必涨|稳赚|保证收益|无风险|全仓|梭哈|杠杆\s*ETF|融资|期权|做空)/u.test(value)) fail("STRATEGY_UNSAFE_COPY", field, "guaranteed-return or leveraged speculation language is forbidden");
}

function readSectorCatalog(root) {
  const file = path.join(root, "content", "sector-details.json");
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return (value.markets ?? []).flatMap((market) => (market.sectors ?? []).map((sector) => ({
      targetId: `sector:${market.id}:${sector.code}`,
      market: market.id,
      targetType: "sector_index_etf",
      label: `${sector.name} / 行业指数或ETF类别`,
      sourceSectorId: sector.code,
      sourceSectorName: sector.name,
    })));
  } catch {
    return [];
  }
}

export function controlledInvestmentTargets(root = moduleRoot) {
  return [...INSTRUMENT_CATALOG, ...readSectorCatalog(root)];
}

export function resolveControlledInvestmentTarget(targetId, root = moduleRoot) {
  return controlledInvestmentTargets(root).find((target) => target.targetId === targetId) ?? null;
}

function sourcePredictionId(record) {
  return record?.prediction_id ?? record?.predictionId ?? record?.id ?? null;
}

function predictionTargetId(record) {
  if (typeof record?.predictionTargetId === "string") return record.predictionTargetId;
  if (typeof record?.sectorId === "string" && typeof record?.market === "string") return `sector:${record.market}:${record.sectorId}`;
  if (typeof record?.sector_id === "string" && typeof record?.market === "string") return `sector:${record.market}:${record.sector_id}`;
  if (typeof record?.target_id === "string") return record.target_id;
  return null;
}

function predictionStatus(record) {
  if (record?.classification === "published_model_prediction") return "published";
  if (record?.classification === "abstained") return "abstained";
  if (record?.publication_status === "published" || record?.prediction_status === "published" || record?.status === "published" || record?.modelPublicationStatus === "published") return "published";
  if (record?.publication_status === "abstained" || record?.prediction_status === "model-abstained" || record?.status === "abstained") return "abstained";
  if (record?.publication_status === "unavailable" || record?.status === "unavailable") return "unavailable";
  return null;
}

function sourceProbability(record, target) {
  // PREDICTION_REVIEW_PACKET rows are the compact, already-normalized output of
  // build-market-packets.normalizePublishedProbability; formal strategy binding
  // never reads the raw prediction ledger or applies a second normalization.
  if (typeof record?.probability === "number") {
    return record.probability;
  }
  return null;
}

function predictionRecordsMap(predictionRecords) {
  if (!predictionRecords) return null;
  const packet = Array.isArray(predictionRecords) ? null : predictionRecords;
  const records = packet?.rows ?? packet?.records;
  if (!packet || !Array.isArray(records) || typeof packet.asOfDate !== "string") fail("STRATEGY_PREDICTION_SOURCE", "predictionRecords", "sealed PREDICTION_REVIEW_PACKET rows with asOfDate required");
  return { asOfDate: packet.asOfDate, records: new Map(records.map((record) => [sourcePredictionId(record), record]).filter(([id]) => typeof id === "string")) };
}

function validateModelSignal(signal, item, field, packet, modelContext, strategyAsOf) {
  exactKeys(signal, ["horizonSessions", "market", "predictionIds", "predictionTargetId", "probability", "probabilityTarget", "probabilityUnit", "status"], `${field}.modelSignal`);
  if (!modelStatuses.has(signal.status)) fail("STRATEGY_MODEL_SIGNAL_STATUS", `${field}.modelSignal.status`, "invalid model signal status");
  predictionIds(signal.predictionIds, `${field}.modelSignal.predictionIds`);
  if (signal.market !== item.market) fail("STRATEGY_PREDICTION_MARKET_MISMATCH", `${field}.modelSignal.market`, "prediction market must match recommendation market");
  if (signal.predictionTargetId !== item.targetId) fail("STRATEGY_PREDICTION_TARGET_MISMATCH", `${field}.modelSignal.predictionTargetId`, "prediction target must match recommendation target");
  if (!Number.isInteger(signal.horizonSessions) || signal.horizonSessions < 1 || signal.horizonSessions > 30) fail("STRATEGY_PREDICTION_HORIZON_MISMATCH", `${field}.modelSignal.horizonSessions`, "integer 1–30 required");
  if (signal.horizonSessions !== modelContext.horizonSessions) fail("STRATEGY_PREDICTION_HORIZON_MISMATCH", `${field}.modelSignal.horizonSessions`, "recommendation horizon must match strategy model context");
  if (signal.status === "no_direct_model_signal") {
    if (signal.predictionIds.length || signal.probability !== null || signal.probabilityTarget !== null || signal.probabilityUnit !== null) fail("STRATEGY_NO_DIRECT_MODEL_SIGNAL", `${field}.modelSignal`, "no direct signal must preserve empty IDs and null probability");
    return;
  }
  if (signal.probabilityUnit !== "decimal_0_1") fail("STRATEGY_PREDICTION_PROBABILITY_MISMATCH", `${field}.modelSignal.probabilityUnit`, "prediction probability must use decimal_0_1");
  if (!probabilityTargets.has(signal.probabilityTarget)) fail("STRATEGY_PREDICTION_TARGET_SEMANTICS_MISMATCH", `${field}.modelSignal.probabilityTarget`, "probability target must be explicit");
  if (signal.status !== "published") {
    if (signal.predictionIds.length || signal.probability !== null) fail("STRATEGY_MODEL_ABSENT", `${field}.modelSignal`, "non-published signal cannot expose IDs or probability");
    return;
  }
  if (!packet) fail("STRATEGY_PREDICTION_SOURCE_REQUIRED", `${field}.modelSignal.predictionIds`, "published strategy requires sealed PREDICTION_REVIEW_PACKET records");
  if (typeof signal.probability !== "number" || signal.probability <= 0 || signal.probability >= 1) fail("STRATEGY_PREDICTION_PROBABILITY_MISMATCH", `${field}.modelSignal.probability`, "published probability must be decimal between 0 and 1");
  if (signal.predictionIds.length !== 1) fail("STRATEGY_PREDICTION_BINDING", `${field}.modelSignal.predictionIds`, "each recommendation must bind exactly one prediction");
  const record = packet.records.get(signal.predictionIds[0]);
  if (!record) fail("STRATEGY_PREDICTION_ID_UNKNOWN", `${field}.modelSignal.predictionIds`, "prediction ID is absent from the sealed review packet");
  if (record.classification !== "published_model_prediction") fail("STRATEGY_LEGACY_PREDICTION_FORBIDDEN", `${field}.modelSignal.predictionIds`, "only current sealed published_model_prediction records may bind");
  if (typeof record.predictionDate !== "string" || record.predictionDate > strategyAsOf || record.predictionDate > packet.asOfDate) fail("STRATEGY_PREDICTION_DATE_MISMATCH", `${field}.modelSignal.predictionIds`, "prediction date must not be later than strategy or packet asOf");
  if (predictionStatus(record) !== "published") fail("STRATEGY_PREDICTION_STATUS_MISMATCH", `${field}.modelSignal.status`, "strategy status differs from immutable prediction status");
  if (record.market !== signal.market) fail("STRATEGY_PREDICTION_MARKET_MISMATCH", `${field}.modelSignal.market`, "prediction market differs from immutable record");
  if (Number(record.horizonSessions ?? record.horizon) !== signal.horizonSessions) fail("STRATEGY_PREDICTION_HORIZON_MISMATCH", `${field}.modelSignal.horizonSessions`, "horizon differs from immutable record");
  if ((record.probabilityTarget ?? record.probability_target) !== signal.probabilityTarget) fail("STRATEGY_PREDICTION_TARGET_SEMANTICS_MISMATCH", `${field}.modelSignal.probabilityTarget`, "probability target semantics differ from immutable record");
  if (predictionTargetId(record) !== signal.predictionTargetId) fail("STRATEGY_PREDICTION_TARGET_MISMATCH", `${field}.modelSignal.predictionTargetId`, "prediction target differs from immutable record");
  const expectedProbability = sourceProbability(record, signal.probabilityTarget);
  if (expectedProbability === null || Math.abs(expectedProbability - signal.probability) > 1e-12) fail("STRATEGY_PREDICTION_PROBABILITY_MISMATCH", `${field}.modelSignal.probability`, "probability differs from immutable record or is unavailable");
}

export function validateInvestmentStrategy(value, { sourceIds = null, requireStrategy = true, edition = null, predictionRecords = null, root = moduleRoot } = {}) {
  if (value === undefined || value === null) {
    if (requireStrategy) fail("INVESTMENT_STRATEGY_REQUIRED", "investmentStrategy", "formal Daily and Weekly publication requires investmentStrategy");
    return null;
  }
  const sourceSet = sourceIds ? new Set(sourceIds) : null;
  const packet = predictionRecordsMap(predictionRecords);
  exactKeys(value, ["allocationPreference", "asOf", "modelContext", "overallStance", "recommendations", "schemaVersion", "signalOrigin", "summary", "title"], "investmentStrategy");
  if (value.schemaVersion !== INVESTMENT_STRATEGY_SCHEMA_VERSION) fail("STRATEGY_SCHEMA", "investmentStrategy.schemaVersion", `${INVESTMENT_STRATEGY_SCHEMA_VERSION} required`);
  if (typeof value.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)) fail("STRATEGY_DATE", "investmentStrategy.asOf", "YYYY-MM-DD required");
  if (edition === "daily" && value.title !== "本期配置建议") fail("STRATEGY_TITLE", "investmentStrategy.title", "Daily title must be 本期配置建议");
  if (edition === "weekly" && value.title !== "下周配置建议") fail("STRATEGY_TITLE", "investmentStrategy.title", "Weekly title must be 下周配置建议");
  string(value.title, "investmentStrategy.title", 40);
  readerCopy(value.summary, "investmentStrategy.summary");
  if (!stances.has(value.overallStance)) fail("STRATEGY_STANCE", "investmentStrategy.overallStance", "risk_on, neutral, or risk_off required");
  if (!["model_plus_writer", "writer_only"].includes(value.signalOrigin)) fail("STRATEGY_ORIGIN", "investmentStrategy.signalOrigin", "model_plus_writer or writer_only required");

  exactKeys(value.modelContext, ["horizonSessions", "signalAvailable", "sourcePredictionIds", "status"], "investmentStrategy.modelContext");
  if (!strategyModelStatuses.has(value.modelContext.status)) fail("STRATEGY_MODEL_STATUS", "investmentStrategy.modelContext.status", "published, abstained, or unavailable required");
  if (typeof value.modelContext.signalAvailable !== "boolean") fail("STRATEGY_MODEL_SIGNAL", "investmentStrategy.modelContext.signalAvailable", "boolean required");
  if (!Number.isInteger(value.modelContext.horizonSessions) || value.modelContext.horizonSessions < 1 || value.modelContext.horizonSessions > 30) fail("STRATEGY_HORIZON", "investmentStrategy.modelContext.horizonSessions", "integer 1–30 required");
  predictionIds(value.modelContext.sourcePredictionIds, "investmentStrategy.modelContext.sourcePredictionIds");
  if (value.modelContext.status === "published") {
    if (!value.modelContext.signalAvailable || value.modelContext.sourcePredictionIds.length < 1) fail("STRATEGY_PUBLISHED_SIGNAL", "investmentStrategy.modelContext", "published model signal requires availability and prediction IDs");
    if (value.signalOrigin !== "model_plus_writer") fail("STRATEGY_PUBLISHED_ORIGIN", "investmentStrategy.signalOrigin", "published model signal must remain model_plus_writer");
  } else {
    if (value.modelContext.signalAvailable || value.modelContext.sourcePredictionIds.length !== 0) fail("STRATEGY_MODEL_ABSENT", "investmentStrategy.modelContext", "non-published model cannot expose a signal or prediction IDs");
    if (value.signalOrigin !== "writer_only") fail("STRATEGY_WRITER_ONLY", "investmentStrategy.signalOrigin", "abstained or unavailable model requires writer_only");
  }

  exactKeys(value.allocationPreference, ["preferredTargetIds", "underweightTargetIds"], "investmentStrategy.allocationPreference");
  const preferred = ids(value.allocationPreference.preferredTargetIds, "investmentStrategy.allocationPreference.preferredTargetIds", null);
  const underweight = ids(value.allocationPreference.underweightTargetIds, "investmentStrategy.allocationPreference.underweightTargetIds", null);
  const targetSet = new Set();
  for (const targetId of [...preferred, ...underweight]) {
    if (!resolveControlledInvestmentTarget(targetId, root)) fail("STRATEGY_TARGET", "investmentStrategy.allocationPreference", `unknown controlled target ${targetId}`);
    if (targetSet.has(targetId)) fail("STRATEGY_TARGET", "investmentStrategy.allocationPreference", "allocation targets must be unique");
    targetSet.add(targetId);
  }

  if (!Array.isArray(value.recommendations) || value.recommendations.length < 1 || value.recommendations.length > 5) fail("STRATEGY_RECOMMENDATIONS", "investmentStrategy.recommendations", "one to five recommendations required");
  const targets = new Set();
  const publishedSignalIds = [];
  value.recommendations.forEach((item, index) => {
    const field = `investmentStrategy.recommendations[${index}]`;
    exactKeys(item, ["action", "conviction", "direction", "horizon", "invalidation", "label", "market", "modelAgreement", "modelEvidence", "modelSignal", "overrideReason", "predictionIds", "supportingSourceIds", "targetId", "targetType", "trigger", "whyNow", "writerOverlay"], field);
    const instrument = resolveControlledInvestmentTarget(item.targetId, root);
    if (!instrument) fail("STRATEGY_TARGET", `${field}.targetId`, "target must come from the controlled index/ETF or sector taxonomy catalog");
    if (item.targetType === "individual_stock" || item.targetType !== instrument.targetType) fail("SINGLE_STOCK_STRATEGY_FORBIDDEN", `${field}.targetType`, "individual stocks and arbitrary target types are forbidden");
    if (item.market !== instrument.market || item.label !== instrument.label) fail("STRATEGY_TARGET", field, "market and label must match the controlled catalog");
    if (targets.has(item.targetId)) fail("STRATEGY_TARGET", `${field}.targetId`, "recommendation targets must be unique");
    targets.add(item.targetId);
    if (!actions.has(item.action) || !directions.has(item.direction) || !horizons.has(item.horizon)) fail("STRATEGY_ENUM", field, "invalid action, direction, or horizon");
    if (!Number.isInteger(item.conviction) || item.conviction < 1 || item.conviction > 5) fail("STRATEGY_CONVICTION", `${field}.conviction`, "integer 1–5 required");
    readerCopy(item.whyNow, `${field}.whyNow`); readerCopy(item.modelEvidence, `${field}.modelEvidence`); readerCopy(item.writerOverlay, `${field}.writerOverlay`); readerCopy(item.trigger, `${field}.trigger`); readerCopy(item.invalidation, `${field}.invalidation`);
    ids(item.supportingSourceIds, `${field}.supportingSourceIds`, sourceSet, { min: item.conviction >= 4 ? 2 : 1 });
    predictionIds(item.predictionIds, `${field}.predictionIds`);
    validateModelSignal(item.modelSignal, item, field, packet, value.modelContext, value.asOf);
    if (JSON.stringify(item.predictionIds) !== JSON.stringify(item.modelSignal.predictionIds)) fail("STRATEGY_PREDICTION_BINDING", `${field}.predictionIds`, "legacy predictionIds must equal modelSignal.predictionIds");
    if (item.modelSignal.status === "published") publishedSignalIds.push(...item.modelSignal.predictionIds);
    if (item.modelAgreement === "override") {
      string(item.overrideReason, `${field}.overrideReason`, 600);
      if (item.supportingSourceIds.length < 2) fail("STRATEGY_OVERRIDE_EVIDENCE", `${field}.supportingSourceIds`, "model override requires at least two independent supporting sources");
    } else if (!agreements.has(item.modelAgreement)) fail("STRATEGY_AGREEMENT", `${field}.modelAgreement`, "agree, override, or not_applicable required");
    else if (item.overrideReason !== null) fail("STRATEGY_OVERRIDE_REASON", `${field}.overrideReason`, "overrideReason must be null unless modelAgreement is override");
    if (value.modelContext.status === "published" && item.modelSignal.status === "published" && !["agree", "override"].includes(item.modelAgreement)) fail("STRATEGY_AGREEMENT", `${field}.modelAgreement`, "published model requires agree or override");
    if (item.modelSignal.status !== "published" && item.modelAgreement !== "not_applicable") fail("STRATEGY_MODEL_ABSENT", field, "recommendation without direct model signal requires not_applicable");
    if (item.modelSignal.status !== "published" && item.predictionIds.length !== 0) fail("STRATEGY_MODEL_ABSENT", `${field}.predictionIds`, "writer-only recommendation cannot claim prediction IDs");
  });

  const expectedModelIds = [...new Set(publishedSignalIds)].sort();
  if (JSON.stringify(expectedModelIds) !== JSON.stringify([...value.modelContext.sourcePredictionIds].sort())) fail("STRATEGY_PREDICTION_BINDING", "investmentStrategy.modelContext.sourcePredictionIds", "strategy model IDs must equal the recommendation-level immutable bindings");
  if (value.modelContext.status === "published" && publishedSignalIds.length === 0) fail("STRATEGY_PREDICTION_BINDING", "investmentStrategy.recommendations", "published strategy requires at least one direct recommendation signal");
  const usableEvidence = Boolean(sourceSet?.size);
  const allNeutral = value.recommendations.every((item) => item.action === "hold" && item.direction === "neutral");
  if (value.modelContext.status !== "published" && usableEvidence && allNeutral) fail("STRATEGY_WRITER_ABSTAINED_NEUTRAL", "investmentStrategy.recommendations", "model abstain does not permit writer abstain when market evidence is usable");
  if (value.modelContext.status !== "published" && !usableEvidence && allNeutral && !/维持基础配置，不新增风险暴露/u.test(value.summary)) fail("STRATEGY_UNAVAILABLE_COPY", "investmentStrategy.summary", "fully unavailable evidence must state the retained base allocation");
  return value;
}

export function projectInvestmentStrategyPreview(strategy, options = {}) {
  validateInvestmentStrategy(strategy, { ...options, requireStrategy: true });
  return {
    summary: strategy.summary,
    overallStance: strategy.overallStance,
    signalOrigin: strategy.signalOrigin,
    modelStatus: strategy.modelContext.status,
    recommendations: strategy.recommendations.slice(0, 3).map((item) => ({ label: item.label, action: item.action, direction: item.direction, conviction: item.conviction })),
  };
}
