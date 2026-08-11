import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { latestATradingDay } from "./refresh-writer-packet.mjs";
import { assertMarketDateContract, resolveMarketDateContract } from "./market-date-contract.mjs";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-date-contract-"));
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  return root;
}

function history(dates) {
  return { schemaVersion: "public-market-history-v1", status: "ready", asOf: dates.at(-1), bars: dates.map((time, index) => ({ time, close: index + 1 })) };
}

function marketFixture({ futureUs = false } = {}) {
  return fixture({
    "models/sector-rotation/cn-market-calendar-2026.json": {
      schemaVersion: 1,
      market: "A-share",
      year: 2026,
      closedWeekdays: ["2026-02-16"],
    },
    "content/global-market-briefs/2026-08-08.json": {
      editionDate: "2026-08-08",
      dataAsOf: "2026-08-08",
      mainArticle: { marketTags: ["A_SHARE", "HK", "US"] },
    },
    "public/data/market-history/hang-seng.json": history(["2026-08-06", "2026-08-07"]),
    "public/data/market-history/hang-seng-china-enterprises.json": history(["2026-08-06", "2026-08-07"]),
    "public/data/market-history/hang-seng-tech.json": history(["2026-08-06", "2026-08-07"]),
    "public/data/market-history/dow-jones.json": history(["2026-08-05", futureUs ? "2026-08-11" : "2026-08-06"]),
    "public/data/market-history/nasdaq-composite.json": history(["2026-08-05", futureUs ? "2026-08-11" : "2026-08-06"]),
    "public/data/market-history/sp500.json": history(["2026-08-05", futureUs ? "2026-08-11" : "2026-08-06"]),
  });
}

test("2026-08-10 18:20 uses the calendar-based A-share session", () => {
  const root = marketFixture();
  try {
    assert.equal(latestATradingDay("2026-08-10", root, new Date("2026-08-10T18:20:00+08:00")), "2026-08-10");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("A-share freshness is independent of the stale 2026-08-08 global brief", () => {
  const root = marketFixture();
  try {
    const contract = assertMarketDateContract(resolveMarketDateContract({ root, requestedDate: "2026-08-10", now: new Date("2026-08-10T18:20:00+08:00") }));
    assert.equal(contract.authority, "market-evidence");
    assert.equal(contract.marketDates["a-share"], "2026-08-10");
    assert.equal(contract.marketDates.hk, "2026-08-07");
    assert.equal(contract.marketDates.us, "2026-08-06");
    assert.equal(contract.editionDate, "2026-08-10");
    assert.doesNotMatch(JSON.stringify(contract), /global-market-brief/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Saturday and exchange holiday never become A-share sessions", () => {
  const root = marketFixture();
  try {
    assert.equal(latestATradingDay("2026-08-08", root, new Date("2026-08-08T18:20:00+08:00")), "2026-08-07");
    assert.equal(latestATradingDay("2026-02-16", root, new Date("2026-02-16T18:20:00+08:00")), "2026-02-13");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("before the 17:00 publication buffer the A-share session falls back", () => {
  const root = marketFixture();
  try {
    assert.equal(latestATradingDay("2026-08-10", root, new Date("2026-08-10T16:59:00+08:00")), "2026-08-07");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("future market evidence is fail-closed", () => {
  const root = marketFixture({ futureUs: true });
  try {
    const contract = resolveMarketDateContract({ root, requestedDate: "2026-08-10", now: new Date("2026-08-10T18:20:00+08:00") });
    assert.equal(contract.marketStatus.us.status, "future");
    assert.equal(contract.marketDates.us, undefined);
    assert.throws(() => assertMarketDateContract(contract), /future evidence/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("stale or internally inconsistent market evidence is fail-closed", () => {
  const root = marketFixture();
  try {
    const file = path.join(root, "public/data/market-history/dow-jones.json");
    fs.writeFileSync(file, JSON.stringify({ ...history(["2026-08-05", "2026-08-07"]), asOf: "2026-08-06" }), "utf8");
    const contract = resolveMarketDateContract({ root, requestedDate: "2026-08-10", now: new Date("2026-08-10T18:20:00+08:00") });
    assert.equal(contract.marketStatus.us.status, "invalid");
    assert.throws(() => assertMarketDateContract(contract), /invalid evidence/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a market with no common series session remains unavailable", () => {
  const root = marketFixture();
  try {
    const file = path.join(root, "public/data/market-history/sp500.json");
    fs.writeFileSync(file, JSON.stringify(history(["2026-08-04"])), "utf8");
    const contract = resolveMarketDateContract({ root, requestedDate: "2026-08-10", now: new Date("2026-08-10T18:20:00+08:00") });
    assert.equal(contract.marketStatus.us.status, "partial");
    assert.equal(contract.marketDates.us, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
