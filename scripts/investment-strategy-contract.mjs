export const INVESTMENT_STRATEGY_SCHEMA_VERSION = "investment-strategy-v1";

export const INSTRUMENT_CATALOG = Object.freeze([
  { targetId: "csi300", market: "a-share", targetType: "broad_index_etf", label: "沪深300 / 大盘宽基ETF" },
  { targetId: "sse50", market: "a-share", targetType: "broad_index_etf", label: "上证50 / 大盘宽基ETF" },
  { targetId: "csi500", market: "a-share", targetType: "mid_cap_index_etf", label: "中证500 / 中盘指数ETF" },
  { targetId: "hang_seng", market: "hk", targetType: "broad_index_etf", label: "恒生指数 / 港股宽基ETF" },
  { targetId: "hang_seng_tech", market: "hk", targetType: "growth_index_etf", label: "恒生科技 / 港股成长ETF" },
  { targetId: "sp500", market: "us", targetType: "broad_index_etf", label: "S&P 500 / 美股大盘指数基金" },
  { targetId: "nasdaq_100", market: "us", targetType: "growth_index_etf", label: "Nasdaq-100 / 美股成长指数基金" },
  { targetId: "sector_index", market: "global", targetType: "sector_index_etf", label: "行业指数 / 行业ETF类别" },
]);

const catalog = new Map(INSTRUMENT_CATALOG.map((instrument) => [instrument.targetId, instrument]));
const modelStatuses = new Set(["published", "abstained", "unavailable"]);
const stances = new Set(["risk_on", "neutral", "risk_off"]);
const actions = new Set(["increase", "hold", "reduce"]);
const directions = new Set(["bullish", "neutral", "bearish"]);
const horizons = new Set(["1_5d", "2_4w", "next_week", "one_month"]);
const agreements = new Set(["agree", "override", "not_applicable"]);

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

export function validateInvestmentStrategy(value, { sourceIds = null, requireStrategy = true, edition = null } = {}) {
  if (value === undefined || value === null) {
    if (requireStrategy) fail("INVESTMENT_STRATEGY_REQUIRED", "investmentStrategy", "formal Daily and Weekly publication requires investmentStrategy");
    return null;
  }
  const sourceSet = sourceIds ? new Set(sourceIds) : null;
  exactKeys(value, ["asOf", "modelContext", "overallStance", "recommendations", "schemaVersion", "signalOrigin", "summary", "title"], "investmentStrategy");
  if (value.schemaVersion !== INVESTMENT_STRATEGY_SCHEMA_VERSION) fail("STRATEGY_SCHEMA", "investmentStrategy.schemaVersion", `${INVESTMENT_STRATEGY_SCHEMA_VERSION} required`);
  if (typeof value.asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.asOf)) fail("STRATEGY_DATE", "investmentStrategy.asOf", "YYYY-MM-DD required");
  if (edition === "daily" && value.title !== "本期配置建议") fail("STRATEGY_TITLE", "investmentStrategy.title", "Daily title must be 本期配置建议");
  if (edition === "weekly" && value.title !== "下周配置建议") fail("STRATEGY_TITLE", "investmentStrategy.title", "Weekly title must be 下周配置建议");
  string(value.title, "investmentStrategy.title", 40);
  readerCopy(value.summary, "investmentStrategy.summary");
  if (!stances.has(value.overallStance)) fail("STRATEGY_STANCE", "investmentStrategy.overallStance", "risk_on, neutral, or risk_off required");
  if (!new Set(["model_plus_writer", "writer_only"]).has(value.signalOrigin)) fail("STRATEGY_ORIGIN", "investmentStrategy.signalOrigin", "model_plus_writer or writer_only required");

  exactKeys(value.modelContext, ["horizonSessions", "probability", "signalAvailable", "sourcePredictionIds", "status"], "investmentStrategy.modelContext");
  if (!modelStatuses.has(value.modelContext.status)) fail("STRATEGY_MODEL_STATUS", "investmentStrategy.modelContext.status", "published, abstained, or unavailable required");
  if (typeof value.modelContext.signalAvailable !== "boolean") fail("STRATEGY_MODEL_SIGNAL", "investmentStrategy.modelContext.signalAvailable", "boolean required");
  if (!Number.isInteger(value.modelContext.horizonSessions) || value.modelContext.horizonSessions < 1 || value.modelContext.horizonSessions > 30) fail("STRATEGY_HORIZON", "investmentStrategy.modelContext.horizonSessions", "integer 1–30 required");
  predictionIds(value.modelContext.sourcePredictionIds, "investmentStrategy.modelContext.sourcePredictionIds");
  const probability = value.modelContext.probability;
  if (value.modelContext.status === "published") {
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0 || probability >= 1) fail("STRATEGY_PUBLISHED_PROBABILITY", "investmentStrategy.modelContext.probability", "published model signal requires a legal probability between 0 and 1");
    if (!value.modelContext.signalAvailable || value.modelContext.sourcePredictionIds.length < 1) fail("STRATEGY_PUBLISHED_SIGNAL", "investmentStrategy.modelContext", "published signal requires availability and prediction IDs");
    if (value.signalOrigin !== "model_plus_writer") fail("STRATEGY_PUBLISHED_ORIGIN", "investmentStrategy.signalOrigin", "published model signal must remain model_plus_writer");
  } else {
    if (probability !== null) fail("STRATEGY_PROBABILITY_FABRICATION", "investmentStrategy.modelContext.probability", "abstained or unavailable model must preserve probability as null");
    if (value.modelContext.signalAvailable || value.modelContext.sourcePredictionIds.length !== 0) fail("STRATEGY_MODEL_ABSENT", "investmentStrategy.modelContext", "non-published model cannot expose a signal or prediction IDs");
    if (value.signalOrigin !== "writer_only") fail("STRATEGY_WRITER_ONLY", "investmentStrategy.signalOrigin", "abstained or unavailable model requires writer_only");
  }

  if (!Array.isArray(value.recommendations) || value.recommendations.length < 1 || value.recommendations.length > 5) fail("STRATEGY_RECOMMENDATIONS", "investmentStrategy.recommendations", "one to five recommendations required");
  const targets = new Set();
  value.recommendations.forEach((item, index) => {
    const field = `investmentStrategy.recommendations[${index}]`;
    exactKeys(item, ["action", "conviction", "direction", "horizon", "invalidation", "label", "market", "modelAgreement", "modelEvidence", "overrideReason", "predictionIds", "supportingSourceIds", "targetId", "targetType", "trigger", "whyNow", "writerOverlay"], field);
    const instrument = catalog.get(item.targetId);
    if (!instrument) fail("STRATEGY_TARGET", `${field}.targetId`, "target must come from the controlled index/ETF catalog");
    if (item.targetType === "individual_stock" || item.targetType !== instrument.targetType) fail("SINGLE_STOCK_STRATEGY_FORBIDDEN", `${field}.targetType`, "individual stocks and arbitrary target types are forbidden");
    if (item.market !== instrument.market || item.label !== instrument.label) fail("STRATEGY_TARGET", field, "market and label must match the controlled catalog");
    if (targets.has(item.targetId)) fail("STRATEGY_TARGET", `${field}.targetId`, "recommendation targets must be unique");
    targets.add(item.targetId);
    if (!actions.has(item.action) || !directions.has(item.direction) || !horizons.has(item.horizon)) fail("STRATEGY_ENUM", field, "invalid action, direction, or horizon");
    if (!Number.isInteger(item.conviction) || item.conviction < 1 || item.conviction > 5) fail("STRATEGY_CONVICTION", `${field}.conviction`, "integer 1–5 required");
    readerCopy(item.whyNow, `${field}.whyNow`);
    readerCopy(item.modelEvidence, `${field}.modelEvidence`);
    readerCopy(item.writerOverlay, `${field}.writerOverlay`);
    readerCopy(item.trigger, `${field}.trigger`);
    readerCopy(item.invalidation, `${field}.invalidation`);
    ids(item.supportingSourceIds, `${field}.supportingSourceIds`, sourceSet, { min: item.conviction >= 4 ? 2 : 1 });
    predictionIds(item.predictionIds, `${field}.predictionIds`);
    if (!agreements.has(item.modelAgreement)) fail("STRATEGY_AGREEMENT", `${field}.modelAgreement`, "agree, override, or not_applicable required");
    if (item.modelAgreement === "override") {
      string(item.overrideReason, `${field}.overrideReason`, 600);
      if (item.supportingSourceIds.length < 2) fail("STRATEGY_OVERRIDE_EVIDENCE", `${field}.supportingSourceIds`, "model override requires at least two independent supporting sources");
    } else if (item.overrideReason !== null) fail("STRATEGY_OVERRIDE_REASON", `${field}.overrideReason`, "overrideReason must be null unless modelAgreement is override");
    if (value.modelContext.status === "published" && item.modelAgreement === "not_applicable") fail("STRATEGY_AGREEMENT", `${field}.modelAgreement`, "published model requires agree or override");
    if (value.modelContext.status !== "published" && (item.modelAgreement !== "not_applicable" || item.predictionIds.length !== 0)) fail("STRATEGY_MODEL_ABSENT", field, "writer-only strategy cannot claim model agreement or prediction IDs");
  });
  return value;
}

export function projectInvestmentStrategyPreview(strategy) {
  validateInvestmentStrategy(strategy, { requireStrategy: true });
  return {
    summary: strategy.summary,
    overallStance: strategy.overallStance,
    signalOrigin: strategy.signalOrigin,
    modelStatus: strategy.modelContext.status,
    recommendations: strategy.recommendations.slice(0, 3).map((item) => ({ label: item.label, action: item.action, direction: item.direction, conviction: item.conviction })),
  };
}
