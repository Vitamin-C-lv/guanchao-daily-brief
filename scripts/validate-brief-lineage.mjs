#!/usr/bin/env node
/**
 * Daily brief source-lineage consistency gate.
 *
 * Independent of scripts/validate-brief.mjs on purpose: the writer-context target
 * validator SHA is frozen, so this gate must not change that file.  It catches the
 * P0 class of defect where visible market numbers (2026-08-03) are paired with
 * stale sources/status (2026-07-31) or where status text claims "no new close"
 * while indices/sparkline carry a fresh session.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const inputIndex = process.argv.indexOf("--input");
const briefPath = inputIndex >= 0
  ? path.resolve(process.argv[inputIndex + 1] ?? "")
  : path.join(repositoryRoot, "content", "daily-brief.json");
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : null;

if (mode === "global_market_brief") {
  try {
    const { validateGlobalMarketBrief } = await import("./global-market-brief-contract.mjs");
    const value = JSON.parse(fs.readFileSync(briefPath, "utf8"));
    validateGlobalMarketBrief(value);
    console.log(`全球整合简报来源/时间线校验通过：${value.editionDate}，来源 ${value.sourceIndex.length} 个。`);
    process.exit(0);
  } catch (cause) {
    console.error(`全球整合简报来源/时间线校验失败：${cause instanceof Error ? cause.message : "输入无效"}`);
    process.exit(1);
  }
}

const errors = [];

function fail(message) {
  errors.push(message);
}

function statusDateParts(text) {
  const iso = String(text).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]), exact: iso[0] };
  const cn = String(text).match(/(\d{1,2})月(\d{1,2})日/);
  if (cn) {
    const month = Number(cn[1]);
    const day = Number(cn[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return { year: null, month, day, exact: `${cn[1]}月${cn[2]}日` };
  }
  return null;
}

function sessionParts(date) {
  const match = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null;
}

function hasNoNewCloseWording(text) {
  return /未接收|未更新|没有新|未收到|无新收盘|旧收盘不替代|仍为历史/i.test(String(text));
}

function numericValue(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/,/g, "");
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const brief = JSON.parse(fs.readFileSync(briefPath, "utf8"));
const dataThrough = brief.meta?.dataThrough;
const sessionDate = String(brief.meta?.editionDate ?? "");

if (!Array.isArray(brief.markets)) fail("markets 必须是数组");

for (const market of brief.markets ?? []) {
  const label = `markets.${market.id}`;
  const marketSession = market.sessionDate;
  const session = sessionParts(marketSession);

  // 1. A status that names a date must match the market session date.
  const statusDate = statusDateParts(market.status ?? "");
  if (statusDate && session) {
    const mismatch = statusDate.year !== null
      ? statusDate.year !== session.year || statusDate.month !== session.month || statusDate.day !== session.day
      : statusDate.month !== session.month || statusDate.day !== session.day;
    if (mismatch) fail(`${label}.status 引用的日期 ${statusDate.exact} 与 sessionDate ${marketSession} 不一致`);
  }

  // 2. "No new close" wording is invalid while the market carries a fresh session
  //    whose date is at or before the brief dataThrough.
  if (hasNoNewCloseWording(market.status ?? "") && marketSession && dataThrough && marketSession <= dataThrough && Array.isArray(market.indices) && market.indices.length) {
    fail(`${label}.status 声称未接收新收盘，但 sessionDate=${marketSession} 已有指数数据`);
  }

  // 3. Every visible article source whose name contains a close date must not be
  //    older than the market session date.
  for (const article of market.articles ?? []) {
    for (const source of article.sources ?? []) {
      const sourceDate = statusDateParts(source?.name ?? "");
      if (/收盘|收市/.test(source?.name ?? "") && sourceDate && session && sourceDate.year === null && (sourceDate.month !== session.month || sourceDate.day !== session.day)) {
        fail(`${label}.articles[].sources 名称 ${source.name} 与 sessionDate ${marketSession} 不一致`);
      }
    }
  }

  // 4. Sparkline must end at the lead index value so the visible chart is not stale.
  if (Array.isArray(market.sparkline) && market.sparkline.length >= 5) {
    const leadValue = market.leadIndex && typeof market.leadIndex === "object" ? numericValue(market.leadIndex.value) : null;
    const last = market.sparkline[market.sparkline.length - 1];
    if (leadValue !== null && Number(last) !== leadValue) {
      fail(`${label}.sparkline 末值 ${last} 与 leadIndex ${market.leadIndex.value} 不一致`);
    }
  }
}

// 5. Source directory must not list an older close entry than the dataThrough date.
for (const source of brief.sourceDirectory ?? []) {
  const sourceDate = statusDateParts(source?.name ?? "");
  const through = sessionParts(dataThrough);
  if (/收盘|收市/.test(source?.name ?? "") && sourceDate && through && sourceDate.year === null && (sourceDate.month !== through.month || sourceDate.day !== through.day)) {
    fail(`sourceDirectory 名称 ${source.name} 早于 dataThrough ${dataThrough}`);
  }
}

if (errors.length) {
  console.error(`来源一致性校验失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`来源一致性校验通过：${sessionDate}，${(brief.markets ?? []).length} 个市场。`);
}
