import assert from "node:assert/strict";
import test from "node:test";
import {
  getCommonDataThrough,
  getMarketCoreDisplay,
  getMarketOverviewFactStatus,
  getMarketOverviewFactStatusLabel,
  getMarketOverviewFreshnessLabel,
  getMarketOverviewSessionDetail,
  hasMismatchedDataThrough,
} from "../lib/market-overview.ts";

function snapshot(overrides = {}) {
  return {
    status: "ready",
    asOf: "2026-08-07",
    latestClose: 100,
    previousClose: 99,
    pointChange: 1,
    percentChange: 1.0101,
    trend: [99, 100],
    ...overrides,
  };
}

test("market common data through uses the earliest valid core-index date", () => {
  const hk = [
    snapshot({ asOf: "2026-08-06" }),
    snapshot({ asOf: "2026-08-07" }),
    snapshot({ asOf: "2026-08-06" }),
  ];
  const us = [
    snapshot({ asOf: "2026-08-06" }),
    snapshot({ asOf: "2026-08-05" }),
    snapshot({ asOf: "2026-08-06" }),
  ];

  assert.equal(getCommonDataThrough(hk), "2026-08-06");
  assert.equal(getCommonDataThrough(us), "2026-08-05");
  assert.equal(hasMismatchedDataThrough(hk), true);
  assert.equal(hasMismatchedDataThrough(us), true);
  assert.equal(getMarketOverviewFreshnessLabel(hk), "部分指数晚于/早于共同交易日");
});

test("equal core-index dates remain a normal synchronized snapshot", () => {
  const snapshots = [snapshot(), snapshot(), snapshot()];
  assert.equal(getCommonDataThrough(snapshots), "2026-08-07");
  assert.equal(hasMismatchedDataThrough(snapshots), false);
  assert.equal(getMarketOverviewFactStatus(snapshots), "verified");
  assert.equal(getMarketOverviewFactStatusLabel("verified"), "核心指数数据已校验");
  assert.equal(getMarketOverviewSessionDetail(snapshots), "三核心指数共同有效日线");
});

test("a one-row partial HSTECH snapshot keeps unavailable changes unavailable", () => {
  const hstech = snapshot({
    status: "partial",
    asOf: "2026-08-06",
    latestClose: 4813.830078125,
    previousClose: 4813.830078125,
    pointChange: null,
    percentChange: null,
    trend: [4813.830078125],
  });
  const display = getMarketCoreDisplay(hstech);

  assert.deepEqual(display, {
    latestClose: 4813.830078125,
    pointChange: null,
    percentChange: null,
  });
  const delayedSnapshots = [snapshot({ asOf: "2026-08-06" }), snapshot({ asOf: "2026-08-06" }), hstech];
  assert.equal(getMarketOverviewFactStatus(delayedSnapshots), "delayed");
  assert.equal(getMarketOverviewFreshnessLabel(delayedSnapshots), "部分指数历史不足一年");
});

test("an unavailable snapshot cannot fall back to legacy DailyBrief index values", () => {
  assert.deepEqual(getMarketCoreDisplay(null), {
    latestClose: null,
    pointChange: null,
    percentChange: null,
  });
  assert.equal(getMarketOverviewFactStatus([snapshot(), snapshot(), null]), "incomplete");
  assert.equal(getMarketOverviewFactStatusLabel("incomplete"), "核心指数数据不完整");
});
