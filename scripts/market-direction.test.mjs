import test from "node:test";
import assert from "node:assert/strict";
import { formatMarketChange, getMarketDirection } from "../lib/market-direction.ts";

test("市场方向使用红涨、绿跌、灰色持平/未知三态", () => {
  assert.equal(getMarketDirection(1.2), "up");
  assert.equal(getMarketDirection(-0.3), "down");
  assert.equal(getMarketDirection(0), "flat");
  assert.equal(getMarketDirection(null), "flat");
  assert.equal(getMarketDirection(Number.NaN), "flat");
  assert.equal(formatMarketChange(1.234), "+1.23%");
  assert.equal(formatMarketChange(-1.234), "-1.23%");
  assert.equal(formatMarketChange(null), "—");
});
