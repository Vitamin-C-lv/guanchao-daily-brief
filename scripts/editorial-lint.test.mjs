import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lintEditorial } from "./editorial-lint.mjs";

const style = {
  limits: { daily: { defensivePhraseCount: 2, directnessScore: 90 }, weekly: { defensivePhraseCount: 4, directnessScore: 85 }, maxConsecutiveHedgeSentences: 2, maxSentenceCharacters: 110 },
  defensivePhrases: ["仍需观察", "不排除", "不构成投资建议"],
  emptyWatchPhrases: ["后续仍需持续关注"],
  hedgeWords: ["可能", "仍需", "不能", "尚未", "有待", "或许"],
  genericTitles: ["今日市场观察"],
  readerFacingTechnicalTerms: ["provider", "WAF", "unavailable", "lineage", "artifact", "schema"],
  maxReaderFacingTechnicalTerms: 1,
  forbiddenTitlePhrases: ["采集状态", "解读边界", "复核条件"],
  dataLimitationPhrases: ["数据缺口", "数据不完整", "未提供"],
  maxConsecutiveDataLimitationParagraphs: 1,
  maxDataLimitationRatio: 0.1,
  marketMissingExplanationLabels: { "a-share": ["A股"], hk: ["港股"], us: ["美股"] },
  maxMissingExplanationsPerMarket: 1,
  governanceLeakage: ["claimBindings"],
  tradingInstructionPatterns: [],
  strongClaimPatterns: ["稳赚"]
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const globalZero = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/writer-contexts/fixtures/p2-b1-global-baseline.json"), "utf8"));
const globalTwo = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/writer-contexts/fixtures/p2-b1-global-writer-two-special.json"), "utf8"));

function daily(title = "风险偏好回来了，但资金没有回到高估值资产") {
  return {
    meta: { title, subtitle: "资金先回到防御，科技估值仍在重定价" },
    pulse: { label: "防御先行", explanation: "风险偏好回来了，但资金没有回到高估值资产。" },
    federalReserve: { takeaway: "利率路径仍由通胀和收益率决定。", articles: [] },
    markets: [{ name: "A股", summary: "A股收盘走弱，成交额 1.20 万亿元。", articles: [{ title: "A股先跌估值", summary: "指数下跌 1.2%。", impact: "高估值方向承压。", detail: { lead: "A股先跌估值，指数下跌 1.2%。", keyPoints: ["指数下跌 1.2%", "成交额 1.20 万亿元", "防御相对占优"], sections: [{ heading: "结论", body: "风险集中在高估值方向。", sourceIndexes: [0] }, { heading: "证据", body: "成交额 1.20 万亿元。", sourceIndexes: [0] }, { heading: "条件", body: "若广度修复，压力才会减轻。", sourceIndexes: [0] }] }, sources: [{ publisher: "Source", url: "https://example.com/a", tier: "major-media" }] }] }],
    hotspots: [],
    watchlist: [{ title: "观察广度", note: "看成交和广度是否同步修复。" }]
  };
}

test("passes direct conclusion and source coverage", () => {
  const report = lintEditorial({ edition: "daily", value: daily(), style });
  assert.equal(report.conclusionFirstPass, true);
  assert.equal(report.evidenceBindingPass, true);
  assert.equal(report.stylePass, true);
});

test("counts defensive phrases and rejects repeated disclaimers", () => {
  const value = daily();
  value.markets[0].articles[0].detail.sections[0].body = "仍需观察。不排除变化。不构成投资建议。不构成投资建议。";
  const report = lintEditorial({ edition: "daily", value, style });
  assert.equal(report.duplicateDisclaimerCount, 1);
  assert.equal(report.stylePass, false);
});

test("rejects generic endings, warning leakage, and trading instructions", () => {
  const value = daily("今日市场观察");
  value.watchlist[0].note = "后续仍需持续关注，建议买入。";
  value.markets[0].articles[0].detail.sections[2].body = "claimBindings 交易稳赚。";
  const report = lintEditorial({ edition: "daily", value, style });
  assert.equal(report.titlePass, false);
  assert.ok(report.emptyWatchPhraseCount > 0);
  assert.ok(report.governanceLeakageCount > 0);
  assert.equal(report.tradingInstructionPass, false);
  assert.equal(report.stylePass, false);
});

test("weekly uses the same deterministic gates with a different threshold", () => {
  const value = {
    report: { title: "AI估值从需求交易转向回报验证", subtitle: "本周只看一个命题" },
    executiveSummary: { weekVerdict: "AI估值从需求交易转向回报验证，强业绩没有自动换来强股价。", keyTakeaways: [{ title: "需求仍强", summary: "订单证据仍在。", sourceIds: ["s1"] }] },
    sources: [{ id: "s1", publisher: "Source", url: "https://example.com/source" }],
    majorEvents: [], highValueInsights: [], markets: [], crossMarketThemes: [], nextWeekCalendar: []
  };
  const report = lintEditorial({ edition: "weekly", value, style });
  assert.equal(report.conclusionFirstPass, true);
  assert.equal(report.evidenceBindingPass, true);
});

test("explicit unchanged writer result may omit claim bindings", () => {
  const value = {
    report: { title: "AI估值从需求交易转向回报验证", subtitle: "本周只看一个命题" },
    executiveSummary: { weekVerdict: "AI估值从需求交易转向回报验证，强业绩没有自动换来强股价。", keyTakeaways: [{ title: "需求仍强", summary: "订单证据仍在。", sourceIds: ["s1"] }] },
    sources: [{ id: "s1", publisher: "Source", url: "https://example.com/source" }],
    majorEvents: [], highValueInsights: [], markets: [], crossMarketThemes: [], nextWeekCalendar: []
  };
  const report = lintEditorial({ edition: "weekly", result: { payload: value, warnings: ["no-editorial-change"], claimBindings: { quantitative: [], qualitative: [], sourceMetadata: [] } }, style });
  assert.equal(report.evidenceBindingPass, true);
});

test("rejects reader-facing technical terms above the cap", () => {
  const value = daily();
  value.pulse.explanation = "provider WAF unavailable";
  const report = lintEditorial({ edition: "daily", value, style });
  assert.equal(report.readerFacingTechnicalTermCount, 3);
  assert.equal(report.readerFacingTechnicalTermPass, false);
  assert.equal(report.stylePass, false);
});

test("reader-facing machine-language fixture fails while natural Chinese copy passes", () => {
  const strictStyle = { ...style, readerFacingTechnicalTerms: ["published model prediction", "evidence observation", "abstained", "insufficient", "authorityLevel", "schema", "artifact", "合法边界", "规则观察"], maxReaderFacingTechnicalTerms: 0 };
  for (const phrase of strictStyle.readerFacingTechnicalTerms) {
    const value = daily();
    value.pulse.explanation = `这里出现 ${phrase}。`;
    const report = lintEditorial({ edition: "daily", value, style: strictStyle });
    assert.equal(report.readerFacingTechnicalTermPass, false, phrase);
  }
  const value = daily();
  value.pulse.explanation = "模型本期没有给出概率，但成交和利率更支持大盘宽基。这里只是事实观察，不是模型预测。截至周六上午，美股周五完整收盘已经可以纳入本期。目前数据不足以支持板块轮动判断。";
  const report = lintEditorial({ edition: "daily", value, style: strictStyle });
  assert.equal(report.readerFacingTechnicalTermPass, true);
});

test("rejects forbidden title phrases", () => {
  const value = daily("采集状态决定风险偏好");
  const report = lintEditorial({ edition: "daily", value, style });
  assert.equal(report.forbiddenTitlePhraseCount, 1);
  assert.equal(report.titleForbiddenPhrasePass, false);
  assert.equal(report.stylePass, false);
});

test("rejects consecutive data-limit paragraphs and repeated market explanations", () => {
  const value = daily();
  value.markets[0].articles[0].detail.lead = "A股数据不完整。";
  value.markets[0].articles[0].detail.keyPoints[0] = "A股数据缺口仍在。";
  const report = lintEditorial({ edition: "daily", value, style });
  assert.equal(report.maxConsecutiveDataLimitationParagraphs, 2);
  assert.equal(report.consecutiveDataLimitationPass, false);
  assert.equal(report.missingExplanationCounts["a-share"], 2);
  assert.equal(report.missingExplanationPass, false);
  assert.equal(report.stylePass, false);
});

test("rejects a data-limit explanation that occupies too much of the body", () => {
  const value = daily();
  value.markets[0].summary = "A股数据缺口。".repeat(80);
  const report = lintEditorial({ edition: "daily", value, style });
  assert.ok(report.dataLimitationRatio > 0.1);
  assert.equal(report.dataLimitationRatioPass, false);
  assert.equal(report.stylePass, false);
});

test("global mode accepts zero or two authorized special reports", () => {
  assert.equal(lintEditorial({ mode: "global_market_brief", value: globalZero }).passed, true);
  assert.equal(lintEditorial({ mode: "global_market_brief", value: globalTwo }).passed, true);
});

test("global mode rejects a fixed three-market draft", () => {
  const value = structuredClone(globalZero);
  value.markets = [{}, {}, {}];
  const report = lintEditorial({ mode: "global_market_brief", value });
  assert.equal(report.fixedThreeMarketDraftPass, false);
  assert.equal(report.passed, false);
});

test("global mode rejects machine diagnostics in article prose", () => {
  const value = structuredClone(globalZero);
  value.mainArticle.conclusion = "provider coverage gateFailures 已进入正文。";
  const report = lintEditorial({ mode: "global_market_brief", value });
  assert.equal(report.machineTextPass, false);
  assert.equal(report.passed, false);
});

test("global mode rejects source-less high-impact judgement", () => {
  const value = structuredClone(globalZero);
  value.mainArticle.sourceIds = [];
  value.mainArticle.keyFacts = [];
  value.mainArticle.logicChain = [{ ...value.mainArticle.logicChain[0], supportingSourceIds: [], contradictorySourceIds: [] }];
  value.mainArticle.crossMarketTransmission = [{ ...value.mainArticle.crossMarketTransmission[0], supportingSourceIds: [] }];
  const report = lintEditorial({ mode: "global_market_brief", value });
  assert.equal(report.sourcedHighImpactPass, false);
  assert.equal(report.passed, false);
});

test("global mode rejects EvidenceScore described as probability", () => {
  const value = structuredClone(globalZero);
  value.mainArticle.conclusion = "EvidenceScore 不是概率，但这里把观察分称为概率。";
  const report = lintEditorial({ mode: "global_market_brief", value });
  assert.equal(report.evidenceScoreProbabilityPass, false);
  assert.equal(report.passed, false);
});

test("global mode rejects future outlook without invalidation", () => {
  const value = structuredClone(globalZero);
  value.mainArticle.outlook.nextSession.invalidationConditionIds = [];
  const report = lintEditorial({ mode: "global_market_brief", value });
  assert.equal(report.futureOutlookInvalidationPass, false);
  assert.equal(report.passed, false);
});
