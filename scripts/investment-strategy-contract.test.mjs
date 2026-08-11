import assert from "node:assert/strict";
import test from "node:test";

import { InvestmentStrategyContractError, validateInvestmentStrategy } from "./investment-strategy-contract.mjs";

const sources = new Set(["market-price", "rates", "breadth"]);

function recommendation(overrides = {}) {
  return {
    market: "a-share",
    targetType: "broad_index_etf",
    targetId: "csi300",
    label: "沪深300 / 大盘宽基ETF",
    action: "increase",
    direction: "bullish",
    conviction: 3,
    horizon: "1_5d",
    whyNow: "成交与价格表现更支持大盘宽基。",
    modelEvidence: "模型信号与市场表现方向一致。",
    writerOverlay: "主笔维持偏大盘的配置判断。",
    supportingSourceIds: ["market-price"],
    predictionIds: ["prediction-1"],
    trigger: "若成交继续改善，可逐步增加大盘宽基配置。",
    invalidation: "若价格与成交同步走弱，回到维持配置。",
    modelAgreement: "agree",
    overrideReason: null,
    ...overrides
  };
}

function strategy(status = "published", overrides = {}) {
  const published = status === "published";
  return {
    schemaVersion: "investment-strategy-v1",
    asOf: "2026-08-12",
    title: "本期配置建议",
    summary: "本期偏向大盘宽基，沪深300优先于中盘成长。",
    modelContext: {
      status,
      signalAvailable: published,
      probability: published ? 0.61 : null,
      horizonSessions: 5,
      sourcePredictionIds: published ? ["prediction-1"] : []
    },
    signalOrigin: published ? "model_plus_writer" : "writer_only",
    overallStance: "risk_on",
    recommendations: [recommendation(published ? {} : { modelAgreement: "not_applicable", predictionIds: [], modelEvidence: "模型本期没有给出概率，方向由市场数据与主笔判断决定。" })],
    ...overrides
  };
}

test("published model strategy keeps a legal probability and agreement", () => {
  assert.doesNotThrow(() => validateInvestmentStrategy(strategy(), { sourceIds: sources, edition: "daily" }));
});

test("writer override needs a reason and two independent sources", () => {
  const value = strategy("published", { recommendations: [recommendation({ modelAgreement: "override", overrideReason: "利率与广度没有确认模型方向。", supportingSourceIds: ["rates", "breadth"] })] });
  assert.doesNotThrow(() => validateInvestmentStrategy(value, { sourceIds: sources, edition: "daily" }));
  value.recommendations[0].supportingSourceIds = ["rates"];
  assert.throws(() => validateInvestmentStrategy(value, { sourceIds: sources, edition: "daily" }), (error) => error instanceof InvestmentStrategyContractError && error.code === "STRATEGY_OVERRIDE_EVIDENCE");
});

test("abstained and unavailable models retain useful writer-only strategy without fabricated probability", () => {
  for (const status of ["abstained", "unavailable"]) assert.doesNotThrow(() => validateInvestmentStrategy(strategy(status), { sourceIds: sources, edition: "daily" }));
  const fabricated = strategy("abstained");
  fabricated.modelContext.probability = 0.5;
  assert.throws(() => validateInvestmentStrategy(fabricated, { sourceIds: sources, edition: "daily" }), (error) => error instanceof InvestmentStrategyContractError && error.code === "STRATEGY_PROBABILITY_FABRICATION");
});

test("single stocks and unsafe reader copy are rejected structurally", () => {
  const singleStock = strategy();
  singleStock.recommendations[0].targetType = "individual_stock";
  assert.throws(() => validateInvestmentStrategy(singleStock, { sourceIds: sources, edition: "daily" }), (error) => error instanceof InvestmentStrategyContractError && error.code === "SINGLE_STOCK_STRATEGY_FORBIDDEN");
  const unsafe = strategy();
  unsafe.summary = "本期全仓沪深300。";
  assert.throws(() => validateInvestmentStrategy(unsafe, { sourceIds: sources, edition: "daily" }), (error) => error instanceof InvestmentStrategyContractError && error.code === "STRATEGY_UNSAFE_COPY");
});
