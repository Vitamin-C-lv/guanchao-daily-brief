import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const moduleFile = fileURLToPath(import.meta.url);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function validDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function listGlobalBriefs(root) {
  const directory = path.join(root, "content", "global-market-briefs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => DATE.test(name.slice(0, 10)) && name.endsWith(".json")).map((name) => {
    const file = path.join(directory, name);
    const value = readJson(file);
    return { file, relativePath: path.relative(root, file).split(path.sep).join("/"), value };
  }).filter((item) => {
    const editionDate = item.value?.editionDate;
    const dataAsOf = item.value?.dataAsOf;
    return validDate(editionDate) && validDate(dataAsOf) && dataAsOf <= editionDate;
  });
}

function legacyDates(root) {
  const value = readJson(path.join(root, "content", "daily-brief.json"));
  const result = {};
  for (const market of value?.markets ?? []) if (typeof market?.id === "string" && validDate(market.sessionDate)) result[market.id] = market.sessionDate;
  return result;
}

export function resolveMarketDateContract({ root, requestedDate = null } = {}) {
  const candidates = listGlobalBriefs(root).filter((item) => !requestedDate || item.value.editionDate <= requestedDate).sort((left, right) => right.value.editionDate.localeCompare(left.value.editionDate));
  const latest = candidates[0] ?? null;
  if (latest) {
    const dataAsOf = latest.value.dataAsOf;
    const tags = new Set(latest.value.mainArticle?.marketTags ?? latest.value.marketTags ?? ["A_SHARE", "HK", "US"]);
    const marketDates = {};
    if (tags.has("A_SHARE") || tags.has("A股")) marketDates["a-share"] = dataAsOf;
    if (tags.has("HK") || tags.has("港股")) marketDates.hk = dataAsOf;
    if (tags.has("US") || tags.has("美股")) marketDates.us = dataAsOf;
    return {
      authority: "global-market-brief",
      editionDate: latest.value.editionDate,
      dataAsOf,
      sourcePath: latest.relativePath,
      marketDates,
      sourceIds: latest.value.sourceIds ?? latest.value.mainArticle?.sourceIds ?? [],
    };
  }
  const fallback = legacyDates(root);
  return {
    authority: Object.keys(fallback).length ? "legacy-daily-brief-fallback" : "unavailable",
    editionDate: null,
    dataAsOf: null,
    sourcePath: Object.keys(fallback).length ? "content/daily-brief.json" : null,
    marketDates: fallback,
    sourceIds: [],
  };
}

export function assertMarketDateContract(contract, label = "market date contract") {
  if (!contract || contract.authority === "unavailable") throw new Error(`${label} unavailable`);
  for (const [market, date] of Object.entries(contract.marketDates ?? {})) {
    if (!validDate(date)) throw new Error(`${label}.${market} invalid date: ${date}`);
    if (contract.editionDate && date > contract.editionDate) throw new Error(`${label}.${market} dataAsOf is later than editionDate`);
  }
  return contract;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(moduleFile), ".."));
  try {
    const contract = assertMarketDateContract(resolveMarketDateContract({ root, requestedDate: process.argv[3] ?? null }));
    console.log(JSON.stringify(contract, null, 2));
  } catch (error) {
    console.error(`MARKET_DATE_CONTRACT_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
