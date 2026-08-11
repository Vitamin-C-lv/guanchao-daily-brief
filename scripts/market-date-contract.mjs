import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { latestATradingDay, shanghaiCalendarDate } from "./refresh-writer-packet.mjs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const moduleFile = fileURLToPath(import.meta.url);

const MARKET_HISTORY_FILES = Object.freeze({
  hk: ["hang-seng.json", "hang-seng-china-enterprises.json", "hang-seng-tech.json"],
  us: ["dow-jones.json", "nasdaq-composite.json", "sp500.json"],
});

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

export function validMarketDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function historyDates(value, requestedDate) {
  if (!value || (value.status !== undefined && value.status !== "ready")) return { dates: [], future: null, invalid: "history status is not ready" };
  const declared = value?.asOf;
  if (validMarketDate(declared) && declared > requestedDate) return { dates: [], future: declared };
  const bars = Array.isArray(value) ? value : Array.isArray(value?.bars) ? value.bars : [];
  const dates = new Set();
  for (const row of bars) {
    const date = typeof row?.time === "string" ? row.time.slice(0, 10) : null;
    if (!validMarketDate(date)) continue;
    if (date > requestedDate) return { dates: [], future: date };
    dates.add(date);
  }
  const ordered = [...dates].sort();
  if (validMarketDate(declared) && ordered.length && ordered.at(-1) !== declared) return { dates: [], future: null, invalid: `declared asOf ${declared} differs from latest bar ${ordered.at(-1)}` };
  if (!dates.size && validMarketDate(declared) && declared <= requestedDate) dates.add(declared);
  return { dates: [...dates], future: null, invalid: null };
}

function marketHistorySession(root, market, requestedDate) {
  const directory = path.join(root, "public", "data", "market-history");
  const files = MARKET_HISTORY_FILES[market] ?? [];
  const sourcePaths = files.map((name) => path.join("public", "data", "market-history", name));
  const dateSets = [];
  for (const name of files) {
    const value = readJson(path.join(directory, name));
    const result = historyDates(value, requestedDate);
    if (result.future) return { date: null, status: "future", reason: `${name} contains evidence later than requestedDate: ${result.future}`, sourcePaths };
    if (result.invalid) return { date: null, status: "invalid", reason: `${name}: ${result.invalid}`, sourcePaths };
    if (!result.dates.length) return { date: null, status: "unavailable", reason: `${name} has no validated session at or before ${requestedDate}`, sourcePaths };
    dateSets.push(new Set(result.dates));
  }
  const common = [...dateSets[0]].filter((date) => dateSets.every((dates) => dates.has(date))).sort().reverse();
  if (!common.length) return { date: null, status: "partial", reason: `${market} market series have no common complete session at or before ${requestedDate}`, sourcePaths };
  return { date: common[0], status: "ready", reason: null, sourcePaths };
}

function effectiveNow(requestedDate, now) {
  const value = now ? new Date(now) : new Date(`${requestedDate}T23:59:59+08:00`);
  if (!Number.isFinite(value.valueOf())) throw new Error(`invalid now: ${String(now)}`);
  const currentDate = shanghaiCalendarDate(value);
  if (currentDate > requestedDate) return new Date(`${requestedDate}T23:59:59+08:00`);
  return value;
}

/**
 * Resolve independent market-session authorities. Published articles are
 * deliberately absent from this function: an article is a downstream
 * consumer and cannot authorize the next prediction run's market freshness.
 */
export function resolveMarketDateContract({ root, requestedDate = null, now = null } = {}) {
  const effectiveRequestedDate = requestedDate ?? shanghaiCalendarDate(now ?? new Date());
  if (!validMarketDate(effectiveRequestedDate)) throw new Error(`requestedDate must be YYYY-MM-DD: ${effectiveRequestedDate}`);
  const referenceNow = effectiveNow(effectiveRequestedDate, now);
  const aShare = latestATradingDay(effectiveRequestedDate, root, referenceNow);
  const hk = marketHistorySession(root, "hk", effectiveRequestedDate);
  const us = marketHistorySession(root, "us", effectiveRequestedDate);
  const marketDates = { "a-share": aShare };
  if (hk.date) marketDates.hk = hk.date;
  if (us.date) marketDates.us = us.date;
  const marketStatus = { "a-share": { status: "ready", source: "frozen-cn-exchange-calendar", date: aShare }, hk, us };
  const dates = Object.values(marketDates).filter(validMarketDate).sort();
  return {
    authority: "market-evidence",
    editionDate: effectiveRequestedDate,
    dataAsOf: dates.at(-1) ?? null,
    sourcePath: "models/sector-rotation/cn-market-calendar-2026.json + public/data/market-history/*.json",
    sourcePaths: { "a-share": "models/sector-rotation/cn-market-calendar-2026.json", hk: hk.sourcePaths, us: us.sourcePaths },
    marketDates,
    marketStatus,
    sourceIds: [],
  };
}

export function assertMarketDateContract(contract, label = "market date contract") {
  if (!contract || contract.authority === "unavailable") throw new Error(`${label} unavailable`);
  for (const [market, date] of Object.entries(contract.marketDates ?? {})) {
    if (!validMarketDate(date)) throw new Error(`${label}.${market} invalid date: ${date}`);
    if (contract.editionDate && date > contract.editionDate) throw new Error(`${label}.${market} date is later than requestedDate`);
  }
  for (const [market, status] of Object.entries(contract.marketStatus ?? {})) {
    if (["future", "invalid"].includes(status?.status)) throw new Error(`${label}.${market} ${status.status} evidence: ${status.reason}`);
  }
  return contract;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(moduleFile), ".."));
  try {
    const requestedDate = process.argv[3] ?? null;
    const now = process.argv[4] ? new Date(process.argv[4]) : null;
    const contract = assertMarketDateContract(resolveMarketDateContract({ root, requestedDate, now }));
    console.log(JSON.stringify(contract, null, 2));
  } catch (error) {
    console.error(`MARKET_DATE_CONTRACT_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
