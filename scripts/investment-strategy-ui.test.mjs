import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(path.join(root, ...file.split("/")), "utf8");

test("Daily placement is immediately after the reader introduction", () => {
  const source = read("components/GlobalBriefArticleView.tsx");
  assert.ok(source.indexOf('data-global-section="introduction"') < source.indexOf("<InvestmentStrategyCard"));
  assert.ok(source.indexOf("<InvestmentStrategyCard") < source.indexOf('{renderTransmission("03")}'));
});

test("Weekly placement is immediately after the weekly verdict and before core takeaways", () => {
  const source = read("components/WeeklyReportView.tsx");
  assert.ok(source.indexOf("weekVerdict") < source.indexOf("<InvestmentStrategyCard"));
  assert.ok(source.indexOf("<InvestmentStrategyCard") < source.indexOf("keyTakeaways"));
});

test("strategy card keeps reader wording for abstained and published model paths", () => {
  const source = read("components/InvestmentStrategyCard.tsx");
  assert.match(source, /模型本期没有给出概率/);
  assert.match(source, /模型信号/);
  assert.match(source, /非个性化市场策略/);
});
