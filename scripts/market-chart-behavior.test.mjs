import assert from "node:assert/strict";
import test from "node:test";
import {
  clampMarketLogicalRange,
  marketRangeCount,
  sameMarketLogicalRange,
  visibleRangeForMarketRange,
} from "../lib/market-chart-behavior.ts";

test("range controls always end at the last real bar", () => {
  for (const range of ["1M", "3M", "6M", "1Y", "ALL"]) {
    const visible = visibleRangeForMarketRange(range, 601);
    assert.equal(visible.to, 600);
    assert.equal(visible.from >= 0, true);
  }
  assert.equal(marketRangeCount("1Y", 100), 100);
});

test("right drag clamps to the last real bar without disabling left history", () => {
  const clamped = clampMarketLogicalRange({ from: 510, to: 740 }, 601);
  assert.deepEqual(clamped, { from: 370, to: 600 });
  assert.equal(clampMarketLogicalRange({ from: 50, to: 100 }, 601).to, 100);
  assert.equal(clampMarketLogicalRange({ from: -1, to: 601 }, 601, 1).to, 601);
});

test("five fullscreen enter/exit cycles preserve the saved logical range", () => {
  const saved = visibleRangeForMarketRange("1Y", 601);
  let restored = saved;
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const fullscreenResizeRange = clampMarketLogicalRange({ from: restored.from - 0.2, to: restored.to + 18 }, 601);
    restored = clampMarketLogicalRange(saved, 601);
    assert.equal(fullscreenResizeRange.to, 600);
    assert.equal(sameMarketLogicalRange(restored, saved), true);
  }
});
