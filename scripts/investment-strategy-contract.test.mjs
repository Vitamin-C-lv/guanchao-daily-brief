import assert from "node:assert/strict";
import test from "node:test";

import { buildPredictionReviewPacket, repositoryRoot as marketRepositoryRoot } from "./build-market-packets.mjs";
import { InvestmentStrategyContractError, validateInvestmentStrategy } from "./investment-strategy-contract.mjs";

const sources = new Set(["market-price", "rates", "breadth"]);
const records = buildPredictionReviewPacket({
  root: marketRepositoryRoot,
  asOf: "2026-08-12",
  generatedAt: "2026-08-12T08:00:00.000Z",
  records: [{
    prediction_id: "prediction-1",
    prediction_date: "2026-08-11",
    market: "a-share",
    sector_id: "000986",
    horizon: 5,
    publication_status: "published",
    probability_target: "absolute_up",
    absolute_up_probability: 61,
    probability_unit: "percent",
    model_version: "current-model-test",
  }],
});

function recommendation(overrides = {}) {
  const direct = overrides.__direct === true || overrides.modelSignal?.status === "published";
  const { __direct: _direct, ...publicOverrides } = overrides;
  return {
    market: "a-share",
    targetType: "sector_index_etf",
    targetId: "sector:a-share:000986",
    label: "能源 / 行业指数或ETF类别",
    action: "increase",
    direction: "bullish",
    conviction: 3,
    horizon: "1_5d",
    whyNow: "成交与价格表现更支持能源行业观察。",
    modelEvidence: direct ? "模型信号与市场表现方向一致。" : "模型本期没有给出概率，方向由市场数据与主笔判断决定。",
    writerOverlay: "主笔维持有边界的行业配置判断。",
    supportingSourceIds: ["market-price"],
    predictionIds: direct ? ["prediction-1"] : [],
    trigger: "若成交继续改善，可逐步增加行业配置。",
    invalidation: "若价格与成交同步走弱，回到维持配置。",
    modelAgreement: direct ? "agree" : "not_applicable",
    overrideReason: null,
    modelSignal: {
      status: direct ? "published" : "no_direct_model_signal",
      predictionIds: direct ? ["prediction-1"] : [],
      probability: direct ? 0.61 : null,
      probabilityTarget: direct ? "absolute_up" : null,
      probabilityUnit: direct ? "decimal_0_1" : null,
      horizonSessions: 5,
      market: "a-share",
      predictionTargetId: "sector:a-share:000986",
    },
    ...publicOverrides,
  };
}

function strategy(status = "published", overrides = {}) {
  const published = status === "published";
  return {
    schemaVersion: "investment-strategy-v1",
    asOf: "2026-08-12",
    title: "本期配置建议",
    summary: "本期偏向能源行业观察，保留风险边界。",
    allocationPreference: { preferredTargetIds: ["sector:a-share:000986"], underweightTargetIds: [] },
    modelContext: {
      status,
      signalAvailable: published,
      horizonSessions: 5,
      sourcePredictionIds: published ? ["prediction-1"] : [],
    },
    signalOrigin: published ? "model_plus_writer" : "writer_only",
    overallStance: published ? "risk_on" : "neutral",
    recommendations: [recommendation(published ? { __direct: true } : { modelSignal: { status: "no_direct_model_signal", predictionIds: [], probability: null, probabilityTarget: null, probabilityUnit: null, horizonSessions: 5, market: "a-share", predictionTargetId: "sector:a-share:000986" }, predictionIds: [] })],
    ...overrides,
  };
}

const validate = (value, options = {}) => validateInvestmentStrategy(value, { sourceIds: sources, edition: "daily", predictionRecords: records, ...options });

test("published recommendation binds to immutable ledger ID, status, target, horizon, semantics and probability", () => {
  assert.doesNotThrow(() => validate(strategy()));
  for (const [field, bad, code] of [
    ["predictionIds", ["unknown-id"], "STRATEGY_PREDICTION_ID_UNKNOWN"],
    ["market", "hk", "STRATEGY_PREDICTION_MARKET_MISMATCH"],
    ["predictionTargetId", "sector:a-share:000987", "STRATEGY_PREDICTION_TARGET_MISMATCH"],
    ["horizonSessions", 4, "STRATEGY_PREDICTION_HORIZON_MISMATCH"],
    ["probability", 0.62, "STRATEGY_PREDICTION_PROBABILITY_MISMATCH"],
    ["probabilityTarget", "top_quartile", "STRATEGY_PREDICTION_TARGET_SEMANTICS_MISMATCH"],
  ]) {
    const value = strategy();
    if (field === "predictionIds") {
      value.recommendations[0].modelSignal.predictionIds = bad;
      value.recommendations[0].predictionIds = bad;
    } else value.recommendations[0].modelSignal[field] = bad;
    assert.throws(() => validate(value), (error) => error instanceof InvestmentStrategyContractError && error.code === code);
  }
});

test("legacy historical prediction cannot bind as a current strategy signal", () => {
  const value = strategy();
  const real = "fr-a-20260721-h1-000986-f39443581583";
  value.modelContext.horizonSessions = 1;
  value.modelContext.sourcePredictionIds = [real];
  value.recommendations[0].predictionIds = [real];
  value.recommendations[0].modelSignal.predictionIds = [real];
  value.recommendations[0].modelSignal.horizonSessions = 1;
  value.recommendations[0].modelSignal.probability = 0.501;
  const legacyPacket = { ...records, horizons: { ...records.horizons, "1d": { ...records.horizons["1d"], rows: [{ predictionId: real, predictionDate: "2026-07-21", market: "a-share", sectorId: "000986", horizonSessions: 1, classification: "evidence_observation", modelPublicationStatus: "published", probabilityTarget: "absolute_up", probability: 0.501, probabilityUnit: "fraction" }] } } };
  assert.throws(() => validateInvestmentStrategy(value, { sourceIds: sources, edition: "daily", predictionRecords: legacyPacket }), (error) => error instanceof InvestmentStrategyContractError && error.code === "STRATEGY_LEGACY_PREDICTION_FORBIDDEN");
});

test("writer override needs a reason and two independent sources", () => {
  const value = strategy("published", { recommendations: [recommendation({ __direct: true, modelAgreement: "override", overrideReason: "利率与广度没有确认模型方向。", supportingSourceIds: ["rates", "breadth"] })] });
  assert.doesNotThrow(() => validate(value));
  value.recommendations[0].supportingSourceIds = ["rates"];
  assert.throws(() => validate(value), (error) => error.code === "STRATEGY_OVERRIDE_EVIDENCE");
});

test("model abstain still requires writer action when evidence is usable", () => {
  assert.doesNotThrow(() => validate(strategy("abstained")));
  const neutral = strategy("abstained");
  neutral.recommendations[0].action = "hold";
  neutral.recommendations[0].direction = "neutral";
  assert.throws(() => validate(neutral), (error) => error.code === "STRATEGY_WRITER_ABSTAINED_NEUTRAL");
  const unavailable = strategy("unavailable", { summary: "维持基础配置，不新增风险暴露。" });
  unavailable.recommendations[0].action = "hold";
  unavailable.recommendations[0].direction = "neutral";
  assert.doesNotThrow(() => validate(unavailable, { sourceIds: null }));
  const fabricated = strategy("abstained");
  fabricated.modelContext.sourcePredictionIds = ["forbidden"];
  assert.throws(() => validate(fabricated), (error) => error.code === "STRATEGY_MODEL_ABSENT");
});

test("sector taxonomy rejects generic and fake targets, and individual stocks", () => {
  const fake = strategy();
  fake.recommendations[0].targetId = "sector:a-share:fake";
  assert.throws(() => validate(fake), (error) => error.code === "STRATEGY_PREDICTION_TARGET_MISMATCH" || error.code === "STRATEGY_TARGET");
  const singleStock = strategy();
  singleStock.recommendations[0].targetType = "individual_stock";
  assert.throws(() => validate(singleStock), (error) => error.code === "SINGLE_STOCK_STRATEGY_FORBIDDEN");
  const generic = strategy();
  generic.recommendations[0].targetId = "sector_index";
  assert.throws(() => validate(generic), (error) => error.code === "STRATEGY_TARGET");
});
