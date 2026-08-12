import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPredictionReviewPacket } from "./build-market-packets.mjs";
import { validateGlobalMarketBrief } from "./global-market-brief-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repositoryRoot, "scripts", "fixtures", "global-market-brief", "valid-global-market-brief-v1.fixture.json");

function packet() {
  return buildPredictionReviewPacket({
    root: repositoryRoot,
    asOf: "2026-08-05",
    generatedAt: "2026-08-05T08:00:00.000Z",
    records: [{
      prediction_id: "global-strategy-prediction-1",
      prediction_date: "2026-08-04",
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
}

function strategy(brief, { published = false, probability = 0.61 } = {}) {
  const sourceId = brief.sourceIndex[0].id;
  const direct = published;
  return {
    schemaVersion: "investment-strategy-v1",
    asOf: brief.editionDate,
    title: "本期配置建议",
    summary: direct ? "本期模型与市场证据共同支持能源行业观察，保留风险边界。" : "本期模型未提供可发布概率，先按市场证据调整配置并保留风险边界。",
    allocationPreference: { preferredTargetIds: ["sector:a-share:000986"], underweightTargetIds: [] },
    modelContext: { status: direct ? "published" : "unavailable", signalAvailable: direct, horizonSessions: 5, sourcePredictionIds: direct ? ["global-strategy-prediction-1"] : [] },
    signalOrigin: direct ? "model_plus_writer" : "writer_only",
    overallStance: direct ? "risk_on" : "neutral",
    recommendations: [{
      market: "a-share",
      targetType: "sector_index_etf",
      targetId: "sector:a-share:000986",
      label: "能源 / 行业指数或ETF类别",
      action: "increase",
      direction: "bullish",
      conviction: 3,
      horizon: "1_5d",
      whyNow: "成交与价格表现支持能源行业观察。",
      modelEvidence: direct ? "模型信号与市场表现方向一致。" : "模型本期没有给出概率，方向由市场数据与主笔判断决定。",
      writerOverlay: "主笔维持有边界的行业配置判断。",
      supportingSourceIds: [sourceId],
      predictionIds: direct ? ["global-strategy-prediction-1"] : [],
      trigger: "若成交继续改善，可逐步增加行业配置。",
      invalidation: "若价格与成交同步走弱，回到维持配置。",
      modelAgreement: direct ? "agree" : "not_applicable",
      overrideReason: null,
      modelSignal: {
        status: direct ? "published" : "no_direct_model_signal",
        predictionIds: direct ? ["global-strategy-prediction-1"] : [],
        probability: direct ? probability : null,
        probabilityTarget: direct ? "absolute_up" : null,
        probabilityUnit: direct ? "decimal_0_1" : null,
        horizonSessions: 5,
        market: "a-share",
        predictionTargetId: "sector:a-share:000986",
      },
    }],
  };
}

function briefWithStrategy(options) {
  const brief = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  brief.mainArticle.investmentStrategy = strategy(brief, options);
  return brief;
}

test("full global-market-brief-v1 accepts writer_only strategy with null probability", () => {
  assert.doesNotThrow(() => validateGlobalMarketBrief(briefWithStrategy({ published: false }), { requireInvestmentStrategy: true, root: repositoryRoot }));
});

test("full Global Brief accepts published direct signal from a real Review Packet", () => {
  assert.doesNotThrow(() => validateGlobalMarketBrief(briefWithStrategy({ published: true }), { requireInvestmentStrategy: true, predictionRecords: packet(), root: repositoryRoot }));
});

test("arbitrary article probability remains forbidden", () => {
  const brief = briefWithStrategy({ published: false });
  brief.mainArticle.analysisSections[0].probability = 0.61;
  assert.throws(() => validateGlobalMarketBrief(brief, { requireInvestmentStrategy: true, root: repositoryRoot }), (error) => error.code === "FORBIDDEN_FIELD");
});

test("published strategy probability must match the immutable Review Packet", () => {
  const brief = briefWithStrategy({ published: true, probability: 0.62 });
  assert.throws(() => validateGlobalMarketBrief(brief, { requireInvestmentStrategy: true, predictionRecords: packet(), root: repositoryRoot }), (error) => error.code === "STRATEGY_PREDICTION_PROBABILITY_MISMATCH");
});
