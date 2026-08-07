import assert from "node:assert/strict";
import test from "node:test";
import { exponentialMovingAverage, movingAverageConvergenceDivergence, simpleMovingAverage } from "../lib/market-indicators.ts";

const values = Array.from({ length: 40 }, (_, index) => ({ time: `2026-01-${String(index + 1).padStart(2, "0")}`, value: index + 1 }));

test("MA and MACD indicator calculations are deterministic pure functions", () => {
  assert.deepEqual(simpleMovingAverage(values.map(({ time, value }) => ({ time, close: value })), 5).slice(0, 2), [
    { time: "2026-01-05", value: 3 },
    { time: "2026-01-06", value: 4 },
  ]);
  assert.deepEqual(exponentialMovingAverage(values, 5)[0], { time: "2026-01-05", value: 3 });
  const result = movingAverageConvergenceDivergence(values);
  assert.ok(result.line.length > 0);
  assert.ok(result.signal.length > 0);
  assert.ok(result.histogram.length > 0);
  assert.equal(result.histogram.at(-1)?.time, result.signal.at(-1)?.time);
});
