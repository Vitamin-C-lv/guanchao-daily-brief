import assert from "node:assert/strict";
import test from "node:test";
import { validateHkIndustryObservation } from "./hk-industry-date-contract.mjs";

const BASE_SOURCE = [
  { publisher: "Hang Seng Indexes Company Limited", evidenceClass: "official-primary" },
  { publisher: "Hang Seng Indexes Company Limited", evidenceClass: "exchange-market-data" },
];

function market({ date = "2026-08-11", currentDate = date, currentSourceAsOf = date, items = 12, sources = BASE_SOURCE } = {}) {
  return {
    id: "hk",
    asOf: date,
    sourceAsOf: date,
    sources,
    horizons: { current: { status: "ready", asOf: currentDate, sourceAsOf: currentSourceAsOf, items: Array.from({ length: items }, () => ({})) } },
  };
}

const contract = { marketDates: { hk: "2026-08-06" } };
const errors = (value, editionDate = "2026-08-11") => validateHkIndustryObservation({ market: value, marketDateContract: contract, editionDate });

test("HK core index 2026-08-06 plus official industry observation 2026-08-11 passes", () => {
  assert.deepEqual(errors(market()), []);
});

test("industry observation earlier than core-index common date fails", () => {
  assert.match(errors(market({ date: "2026-08-05" })).join("\n"), /不得早于港股核心指数共同交易日/);
});

test("industry observation later than edition date fails closed", () => {
  assert.match(errors(market({ date: "2026-08-12" }), "2026-08-11").join("\n"), /不得晚于日报生成日期/);
});

test("market and current source dates must remain identical", () => {
  const result = errors(market({ currentDate: "2026-08-10", currentSourceAsOf: "2026-08-09" })).join("\n");
  assert.match(result, /horizons\.current\.asOf/);
  assert.match(result, /horizons\.current\.sourceAsOf/);
});

test("12 of 12 current industries remain required", () => {
  assert.match(errors(market({ items: 11 })).join("\n"), /完整覆盖12个恒生一级行业/);
});

test("non-official HK source evidence fails closed", () => {
  const sources = [{ publisher: "第三方数据商", evidenceClass: "vendor-market-data" }];
  const result = errors(market({ sources })).join("\n");
  assert.match(result, /Hang Seng Indexes Company Limited/);
  assert.match(result, /official-primary/);
  assert.match(result, /exchange-market-data/);
});
