import assert from "node:assert/strict";
import test from "node:test";
import {
  calibrateHeadline,
  estimateNetFlowFromAum,
  estimateNetFlowFromShares,
  renormalizePositiveWeights,
  scoreAvailableFactors,
} from "./market-observer-domain.mjs";

test("ETF share change is converted to estimated net flow", () => {
  assert.equal(estimateNetFlowFromShares(110, 100, 2.5), 25);
  assert.equal(estimateNetFlowFromShares(90, 100, 2.5), -25);
});

test("AUM fallback removes the return contribution", () => {
  assert.equal(estimateNetFlowFromAum(110, 100, 0.05), 5);
});

test("missing factor weights are renormalized without changing priority", () => {
  const result = renormalizePositiveWeights({ flow: 0.3, momentum: 0.2, breadth: 0.1 }, ["flow", "breadth"]);
  assert.ok(Math.abs(result.flow - 0.75) < 1e-12);
  assert.ok(Math.abs(result.breadth - 0.25) < 1e-12);
});

test("fewer than three factors cannot produce a score", () => {
  const result = scoreAvailableFactors({ flow: 80, momentum: 60 }, { flow: 0.6, momentum: 0.4 });
  assert.equal(result.status, "insufficient");
  assert.equal(result.score, null);
});

test("sensational headline requires measurable evidence", () => {
  const missing = calibrateHeadline("原油价格狂飙");
  assert.equal(missing.status, "needs-evidence");
  const calibrated = calibrateHeadline("原油价格狂飙", { asset: "布伦特原油", period: "当日", changePct: 4.6, historicalPercentile: 92 });
  assert.equal(calibrated.status, "calibrated");
  assert.match(calibrated.calibratedHeadline, /\+4\.60%/);
});
