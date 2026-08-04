import assert from "node:assert/strict";
import test from "node:test";

import { validateDepthAndVisuals } from "./codex-writer-finalize.mjs";
import { lintEditorial, loadEditorialStyle } from "./editorial-lint.mjs";
import { ArticleVisualsError, generateArticleVisuals } from "./article-visuals.mjs";

const DEPTH_RULES = {
  daily: {
    chineseCharacterCountMin: 1200,
    chineseCharacterCountMax: 1800,
    readingMinutesMin: 6,
    readingMinutesMax: 9,
    visualCountMin: 2,
    scenarioCountMin: 2,
    termExplanationCountMin: 1,
    counterEvidenceCountMin: 1,
    repetitionRatioMax: 0.12
  },
  weekly: {
    chineseCharacterCountMin: 2500,
    chineseCharacterCountMax: 4000,
    readingMinutesMin: 12,
    readingMinutesMax: 18,
    visualCountMin: 4,
    scenarioCountMin: 3,
    termExplanationCountMin: 2,
    counterEvidenceCountMin: 2,
    repetitionRatioMax: 0.12
  }
};

function articleSection(body, heading = "分析") {
  return { heading, body };
}

const BODY_SENTENCES = [
  "收益率小幅回落，成长股估值压力略有缓解。",
  "成交从高位缩量，资金在等待新方向确认。",
  "实际收益率反映剔除通胀预期后的真实贴现压力。",
  "期限利差收窄说明市场对紧缩路径的定价有所松动。",
  "油价下行若持续，通胀预期可能继续降温。",
  "跨市场看，A股缩量回调与港股科技领涨并存。",
  "美股逼近纪录，但估值安全垫依然有限。",
  "下一份通胀数据将决定实际利率的方向。",
  "企业盈利兑现是估值扩张的前提条件。",
  "广度数据暂不可用，行业轮动结论保持克制。",
  "短端利率反映政策路径，长端利率反映增长与通胀。",
  "实际利率上行时，高估值资产通常先承压。",
  "图表显示收益率下行，估值约束暂缓但未解除。"
];

function longBody() {
  const parts = [];
  for (let index = 0; index < BODY_SENTENCES.length; index += 1) {
    parts.push(`${BODY_SENTENCES[index]}（证据${index + 1}的展开说明，补充市场含义与历史对比，并解释机制传导。）`);
  }
  return parts.join("");
}

function makePayload({ sections, scenarios = 2, terms = 1, counter = 1, explanation = "利率回落缓解成长股估值压力，这是本周最关键的传导。图表显示收益率下行。" }) {
  const body = sections ?? [articleSection(longBody(), "主线分析"), articleSection(longBody(), "机制解释与情景")];
  const lead = "缩量回调与新高并存，这是本周最重要的判断。收益率小幅回落，估值约束暂缓但未解除。";
  return {
    meta: { editionDate: "2026-08-04", dataThrough: "2026-08-03", title: "缩量回调与新高并存", subtitle: "2026-08-04日报", status: "更新", curationNote: "本期数据来自8月3日。" },
    pulse: { score: 61, label: "缩量回调与新高并存", explanation: "收益率回落与缩量回调并存，风险偏好未单向扩张。", signals: [{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }, { label: "d", value: "4" }] },
    federalReserve: { takeaway: "美联储维持利率。", articles: [] },
    markets: [{
      id: "us",
      name: "美国市场",
      sessionDate: "2026-08-03",
      summary: "美股收高。",
      indices: [{ name: "标普500", value: "7,600.50", change: 1.5, date: "2026-08-03" }],
      leadIndex: { name: "标普500", value: "7,600.50", change: 1.5, date: "2026-08-03" },
      sparkline: [1, 2, 3, 4, 5, 6],
      tone: "warning",
      sources: [],
      articles: [{
        id: "us-close-0803",
        title: "油价回落安抚通胀",
        publishedAt: "2026-08-04",
        summary: "美股收高。",
        impact: "估值约束暂缓。",
        tags: ["美股"],
        sources: [],
        detail: { lead, keyPoints: ["标普+1.5%"], sections: body }
      }]
    }],
    hotspots: [],
    watchlist: [{ time: "每日", title: "复核收益率", note: "把10Y与股指放在同一窗口。" }],
    sourceDirectory: [],
    methodology: ["规则一", "规则二", "规则三", "规则四"]
  };
}

function makeResult(payload, overrides = {}) {
  return {
    articleDepth: {
      chineseCharacterCount: 1400,
      estimatedReadingMinutes: 7,
      mainThesis: "缩量回调与新高并存",
      explanationCount: 1,
      counterEvidenceCount: 1,
      scenarioCount: 2,
      termExplanationCount: 1
    },
    visualSelections: [
      { visualId: "v-yield-curve", placement: "us-close-0803", title: "收益率曲线", takeaway: "曲线下移", explanation: "图表显示收益率下行，估值约束暂缓但未解除。" },
      { visualId: "v-nominal-real-spread", placement: "us-close-0803", title: "名义与实际收益率", takeaway: "同步回落", explanation: "图表显示收益率下行，估值约束暂缓但未解除。" }
    ],
    ...overrides
  };
}

function fixtureBundle() {
  const packet = {
    facts: [
      { factId: "treasury-nominal2y-2026-08-03", label: "US Treasury 2Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 4.25, asOf: "2026-08-03" },
      { factId: "treasury-nominal10y-2026-08-03", label: "US Treasury 10Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 4.7, asOf: "2026-08-03" },
      { factId: "treasury-nominal30y-2026-08-03", label: "US Treasury 30Y", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 5.23, asOf: "2026-08-03" },
      { factId: "treasury-real10y-2026-08-03", label: "US Treasury real 10Y", market: "US", topic: "treasury", sourceId: "us-treasury-real-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "percent", value: 2.43, asOf: "2026-08-03" },
      { factId: "treasury-spread2s10sBp-2026-08-03", label: "US Treasury 2s10s spread", market: "US", topic: "treasury", sourceId: "us-treasury-nominal-xml", sourceUrl: "https://home.treasury.gov/fixture", status: "ready", unit: "bp", value: 45, asOf: "2026-08-03" }
    ],
    marketDates: { us: "2026-08-03", aShare: "2026-08-03" }
  };
  const research = { facts: [{ subject: "S&P 500 close", claimText: "S&P 500 rose 1.5% on 2026-08-03 to 7,600.50." }, { subject: "Shanghai Composite close", claimText: "Shanghai Composite fell 0.59% on 2026-08-03 to 3,809.66." }, { subject: "Hang Seng Index close", claimText: "Hang Seng Index rose 0.48% on 2026-08-03 to 26,009.40." }] };
  return generateArticleVisuals({ edition: "daily", packet, research, rotation: { markets: [] }, root: process.cwd(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
}

function codeOf(action) {
  try {
    action();
    return null;
  } catch (cause) {
    return cause instanceof ArticleVisualsError ? cause.code : cause.code ?? cause.message;
  }
}

test("01 daily brief below 1200 characters fails closed", () => {
  const payload = makePayload({ sections: [articleSection("收益率小幅回落，估值约束暂缓。")] });
  const bundle = fixtureBundle();
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, chineseCharacterCount: 800, estimatedReadingMinutes: 4 } });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "ARTICLE_TOO_SHALLOW");
});

test("02 weekly brief below 2500 characters fails closed", () => {
  const payload = makePayload({ sections: [articleSection("收益率小幅回落，估值约束暂缓。")] });
  const bundle = fixtureBundle();
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, chineseCharacterCount: 2000, estimatedReadingMinutes: 10 }, visualSelections: [] });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "weekly", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "ARTICLE_TOO_SHALLOW");
});

test("03 reading minutes must be consistent with character count", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, estimatedReadingMinutes: 20 } });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "ARTICLE_DEPTH");
});

test("04 missing mechanism explanation fails", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, termExplanationCount: 0 } });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "ARTICLE_DEPTH");
});

test("05 missing counterevidence fails", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, counterEvidenceCount: 0 } });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "ARTICLE_DEPTH");
});

test("06 insufficient scenarios fail", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, scenarioCount: 1 } });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "ARTICLE_DEPTH");
});

test("07 daily needs at least two visuals", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { visualSelections: [] });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "VISUAL_COUNT");
});

test("07b weekly needs at least four visuals", () => {
  const payload = makePayload({ sections: [articleSection(longBody()), articleSection(longBody()), articleSection(longBody()), articleSection(longBody(), "机制解释与情景")] });
  const bundle = fixtureBundle();
  const result = makeResult(payload, {
    articleDepth: { chineseCharacterCount: 2600, estimatedReadingMinutes: 14, mainThesis: "缩量回调与新高并存", explanationCount: 2, counterEvidenceCount: 2, scenarioCount: 3, termExplanationCount: 2 },
    visualSelections: makeResult(payload).visualSelections
  });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "weekly", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "VISUAL_COUNT");
});

test("08 unknown visualId fails", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { visualSelections: [{ visualId: "v-unknown", placement: "us-close-0803", title: "t", takeaway: "k", explanation: "图表显示收益率下行，估值约束暂缓但未解除。" }, makeResult(payload).visualSelections[0]] });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "VISUAL_UNKNOWN");
});

test("09 duplicate visualId fails", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { visualSelections: [makeResult(payload).visualSelections[0], { ...makeResult(payload).visualSelections[0] }] });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "VISUAL_DUPLICATE");
});

test("10 chart explanation must appear in the body", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload, { visualSelections: [{ ...makeResult(payload).visualSelections[0], explanation: "这段解释没有出现在正文中" }, makeResult(payload).visualSelections[1]] });
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "VISUAL_NOT_EXPLAINED");
});

test("11 chart dataThrough must match the article", () => {
  const payload = makePayload({});
  const bundle = fixtureBundle();
  const result = makeResult(payload);
  // v-yield-curve dataThrough is 2026-08-03 which matches payload meta.dataThrough, so this passes;
  // force a mismatch by changing payload meta date.
  const mismatched = { ...payload, meta: { ...payload.meta, dataThrough: "2026-08-01" } };
  assert.equal(codeOf(() => validateDepthAndVisuals({ edition: "daily", payload: mismatched, result, visualBundle: bundle, depthRules: DEPTH_RULES })), "VISUAL_DATE_CONFLICT");
});

test("12 editorial lint reports depth gates on a deep result", () => {
  const payload = makePayload({ sections: [articleSection("收益率小幅回落，估值约束暂缓。利率下行缓解成长股压力，成长股先受益。图表显示收益率下行。实际收益率是扣除通胀预期后的利率。")] });
  const result = makeResult(payload, { articleDepth: { ...makeResult(payload).articleDepth, chineseCharacterCount: 1300 } });
  const style = { ...loadEditorialStyle(), depth: DEPTH_RULES };
  const lint = lintEditorial({ edition: "daily", value: payload, style, result });
  assert.equal(lint.articleDepthPass, true);
  assert.equal(lint.visualCountPass, true);
  assert.equal(lint.scenarioPass, true);
  assert.equal(lint.termExplanationPass, true);
  assert.equal(lint.repetitionRatio <= 0.12, true);
});
