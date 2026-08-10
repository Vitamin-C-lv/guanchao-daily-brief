import assert from "node:assert/strict";
import test from "node:test";
import { buildDailyMarketPacket, buildPredictionReviewPacket } from "./build-market-packets.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";

test("daily market packet preserves writer browsing and observation boundary", () => {
  const packet = buildDailyMarketPacket({ root: process.cwd(), asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" });
  assert.equal(packet.schemaVersion, "daily-market-packet-v1");
  assert.equal(packet.writerProductName, "观潮每日晚报");
  assert.equal(packet.writerMayBrowse, true);
  assert.equal(packet.coreIndices.aShare.sse.status, "ready");
  assert.equal(packet.marketBreadth.status, "unavailable");
  assert.equal(packet.aShareObservationBoard.every((item) => item.isProbability === false), true);
  assert.doesNotThrow(() => validateEveningPacket(packet, "DAILY_MARKET_PACKET.json"));
});

test("prediction review keeps observation and abstention out of model denominator", () => {
  const packet = buildPredictionReviewPacket({ root: process.cwd(), asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" });
  assert.equal(packet.schemaVersion, "prediction-review-packet-v1");
  for (const horizon of Object.values(packet.horizons)) {
    assert.equal(horizon.evidenceObservation.notModelAccuracy, true);
    assert.equal(horizon.abstained.excludedFromModelDenominator, true);
    assert.ok(horizon.publishedModelPrediction.brier === null || (horizon.publishedModelPrediction.brier >= 0 && horizon.publishedModelPrediction.brier <= 1));
  }
  assert.doesNotThrow(() => validateEveningPacket(packet, "PREDICTION_REVIEW_PACKET.json"));
});

test("invalid evening schema remains rejected", () => {
  const packet = buildDailyMarketPacket({ root: process.cwd(), asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" });
  assert.throws(
    () => validateEveningPacket({ ...packet, schemaVersion: "writer-packet-v1" }, "DAILY_MARKET_PACKET.json"),
    /business integrity mismatch|schema mismatch/
  );
});
