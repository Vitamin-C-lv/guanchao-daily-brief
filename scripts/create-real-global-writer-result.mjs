import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./research-contract.mjs";
import { sealWriterResult } from "./writer-jobs.mjs";

const moduleFile = fileURLToPath(import.meta.url);

function fail(field, message) {
  const error = new Error(message);
  error.code = "GLOBAL_WRITER_RESULT";
  error.path = field;
  throw error;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(file, "JSON input is missing or invalid");
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`, "utf8");
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function sourceIds(context, names) {
  const known = new Set(context.globalMarketBrief.sourceIndex.map((source) => source.id));
  const selected = names.filter((name) => known.has(name));
  if (selected.length !== names.length) fail("sourceIds", `writer package lacks a requested frozen source: ${names.filter((name) => !known.has(name)).join(", ")}`);
  return sorted(selected);
}

function claim(claimPath, ids) {
  return { claimPath, sourceIds: sorted(ids) };
}

function normalizeFactId(fact) {
  const id = String(fact?.id ?? "");
  const normalized = id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(normalized)) fail("mainArticle.keyFacts", `invalid frozen fact id: ${id}`);
  return normalized === id ? fact : { ...fact, id: normalized };
}

export function createRealGlobalWriterResult({ packageDirectory, output }) {
  if (typeof packageDirectory !== "string" || typeof output !== "string") fail("arguments", "packageDirectory and output are required");
  const directory = path.resolve(packageDirectory);
  const request = readJson(path.join(directory, "REQUEST.json"));
  const context = readJson(path.join(directory, "WRITER_CONTEXT.json"));
  const baseline = readJson(path.join(directory, "BASELINE_CONTENT.json"));
  if (request.mode !== "global_market_brief") fail("REQUEST.mode", "global_market_brief request required");
  const global = context.globalMarketBrief;
  const facts = structuredClone(global.keyFacts).map(normalizeFactId);
  const sources = structuredClone(global.sourceIndex);
  const allSourceIds = sourceIds(context, sources.map((source) => source.id));
  const ap = sourceIds(context, ["ap-us-stocks-2026-08-03"]);
  const hk = sourceIds(context, ["aastocks-hk-close-2026-08-03"]);
  const ashare = sourceIds(context, ["eastmoney-a-share-close-2026-08-03"]);
  const treasury = sourceIds(context, ["us-treasury-nominal-xml"]);
  const realTreasury = sourceIds(context, ["us-treasury-real-xml"]);
  const fed = sourceIds(context, ["fed-fomc-statement-2026-07-29", "fed-fomc-calendar-2026"]);
  const editionDate = baseline.payload.editionDate;
  const dataAsOf = context.asOf;
  const mainArticle = {
    id: `global-market-brief-${editionDate}`,
    slug: `global-market-brief-${editionDate}`,
    articleUrl: `/articles/global-market-brief-${editionDate}/`,
    contentKind: "global_main",
    title: "海外风险偏好回暖，估值修复仍等本地确认",
    dek: "美股逼近纪录、美国长端收益率回落，港股科技同步走强；但A股缩量回调，外部风险偏好尚未完成跨市场确认。",
    conclusion: "8月3日的核心线索不是单一市场上涨，而是折现率压力暂缓后风险偏好先在美股和港股得到价格确认；A股成交收缩说明本地资金尚未接力。下一步应先验证收益率回落能否延续，以及亚洲市场的相对强势能否扩散。",
    analysisSections: [
      {
        heading: "全球主线",
        paragraphs: [
          "截至8月3日，最强线索来自折现率压力暂缓与风险资产同步反应。美股走强，名义10年期与实际10年期收益率分别收于4.70%和2.43%，单日分别回落5bp和4bp；这让成长资产的估值约束暂时减轻。",
          "但这还不是无条件的风险偏好回归。收益率较20日前仍分别高出22bp和19bp，说明长端利率只是从短期压力位回落，尚未回到更宽松的背景。当前更稳妥的表述是估值修复获得窗口，而不是折现率风险已经消失。",
        ],
        sourceIds: sorted([...ap, ...treasury, ...realTreasury]),
      },
      {
        heading: "折现率与风险偏好",
        paragraphs: [
          "油价回落先缓解了市场对通胀的担忧，美股在这一背景下接近纪录；与此同时，2年期、10年期和30年期收益率分别为4.25%、4.70%和5.23%，较前一交易日回落3bp、5bp和4bp。价格与利率同日向有利于成长估值的一侧变化，因而风险偏好回暖有了可观察的价格证据。",
          "反证也很清楚：2s10s利差收窄2bp至45bp，且名义10年期收益率较20日前仍上行22bp。曲线与长端位置并没有共同指向彻底宽松，市场更像是在等待下一组利率数据确认，而不是已经完成政策方向切换。",
        ],
        sourceIds: sorted([...ap, ...treasury]),
      },
      {
        heading: "跨市场传导",
        paragraphs: [
          "美国市场的第一站是港股科技：8月3日恒指上涨0.48%至26009.40点，恒生科技指数上涨约1.0%，科技股表现强于大盘。美股风险偏好改善与折现率压力暂缓，为港股成长资产提供了外部顺风，但单日同步仍不足以证明传导已经稳定。",
          "传向A股时，链条出现断点。沪指、深证成指和创业板指分别下跌0.59%、0.96%和1.24%，成交额约1.9974万亿元，较前一日减少约5446亿元。外部线索已经在美股和港股得到价格回应，却尚未在本地成交中得到同方向确认。",
        ],
        sourceIds: sorted([...ap, ...hk, ...ashare]),
      },
      {
        heading: "本地确认缺口",
        paragraphs: [
          "A股的反向证据不是跌幅本身，而是下跌与成交收缩同时出现。若外部风险偏好正在形成跨市场扩散，本地市场至少需要看到成交不再继续收缩，或成长板块相对表现与港股科技同步；当前数据只支持‘尚未接力’，不支持更强的本地趋势判断。",
          "本轮市场广度数据未取得，因此这里只把成交额收缩作为反向证据，不用缺失数据推断上涨家数、内部参与度或资金净流入。这个缺口会直接影响A股是否完成全球主线确认，也意味着下一步需要等待可复核的广度与成交数据同时闭合。",
        ],
        sourceIds: ashare,
      },
      {
        heading: "下一步验证",
        paragraphs: [
          "下一交易时段先看10年期与实际10年期收益率能否继续回落，再看恒生科技相对恒指的强势是否延续。若利率回升、港股科技转弱且A股成交仍低于8月3日基线，当前的跨市场传导判断应当撤回；如果三项观察相反，估值修复线索才有机会从单日反应变成连续信号。",
          "未来一周还要把政策分歧放回定价框架：7月会议有三票异议，9月15—16日是下一次FOMC会议。收益率回落、海外风险偏好延续，并得到A/H成交或广度接力时，修复线索才可能扩展；否则，本文只保留‘折现率压力暂缓’这一有限判断。",
        ],
        sourceIds: sorted([...ap, ...hk, ...ashare, ...fed, ...treasury, ...realTreasury]),
      },
    ],
    keyFacts: facts,
    logicChain: [
      { from: "油价回落与美股走强", relation: "先给风险偏好提供价格确认", to: "海外风险偏好回暖", evidenceStatus: "confirmed", supportingSourceIds: sorted([...ap, ...treasury]), contradictorySourceIds: [] },
      { from: "名义与实际10年期收益率回落", relation: "暂缓折现率压力", to: "成长资产估值获得修复空间", evidenceStatus: "partially_confirmed", supportingSourceIds: sorted([...treasury, ...realTreasury]), contradictorySourceIds: [] },
      { from: "海外风险偏好改善", relation: "可能向亚洲风险资产传导", to: "港股科技相对走强", evidenceStatus: "partially_confirmed", supportingSourceIds: sorted([...ap, ...hk]), contradictorySourceIds: [] },
      { from: "A股成交缩量", relation: "削弱本地资金确认", to: "全球风险偏好尚未同步", evidenceStatus: "confirmed", supportingSourceIds: ashare, contradictorySourceIds: [] },
    ],
    crossMarketTransmission: [
      { fromMarket: "US", toMarket: "HK", direction: "positive", horizon: "next_session", explanation: "美股风险偏好与利率压力暂缓为港股科技提供外部顺风，但港股自身的相对表现仍需下一交易时段确认。", evidenceStatus: "partially_confirmed", supportingSourceIds: sorted([...ap, ...hk]), invalidationConditionIds: ["invalidation-asia-no-confirm"] },
      { fromMarket: "US", toMarket: "A_SHARE", direction: "mixed", horizon: "one_week", explanation: "海外折现率压力暂缓可能改善全球估值环境，但A股成交收缩与广度数据缺口意味着外部线索尚未转化为本地共振。", evidenceStatus: "pending", supportingSourceIds: sorted([...ashare, ...treasury, ...realTreasury]), invalidationConditionIds: ["invalidation-asia-no-confirm", "invalidation-rates-rebound"] },
    ],
    invalidationConditions: [
      { id: "invalidation-rates-rebound", condition: "若10年期或实际10年期收益率重新连续上行，当前折现率压力暂缓与估值修复空间的判断失效。", affectedClaims: ["折现率压力暂缓", "估值修复空间"] },
      { id: "invalidation-asia-no-confirm", condition: "若港股科技不能延续相对强势且A股成交继续低于8月3日基线，外部风险偏好向亚洲传导的判断失效。", affectedClaims: ["海外风险偏好向亚洲传导", "A股本地确认"] },
      { id: "invalidation-fed-hawkish", condition: "若后续美联储沟通强化政策分歧并伴随收益率上行，未来一周估值修复判断失效。", affectedClaims: ["未来一周估值修复扩散"] },
    ],
    outlook: {
      nextSession: { statement: "下一交易时段先看10年期与实际10年期收益率是否继续回落，再看港股科技能否延续相对恒指的强势；若利率回升而本地成交仍弱，外部情绪传导暂不确认。", supportingSourceIds: sorted([...ashare, ...hk, ...treasury, ...realTreasury]), invalidationConditionIds: ["invalidation-rates-rebound", "invalidation-asia-no-confirm"] },
      oneWeek: { statement: "未来一周，只有收益率回落、海外风险偏好延续并得到A/H成交或广度接力，估值修复才可能扩展；FOMC三票异议与9月会议日历提醒市场政策分歧仍在。", supportingSourceIds: sorted([...ap, ...fed, ...treasury, ...realTreasury]), invalidationConditionIds: ["invalidation-fed-hawkish", "invalidation-rates-rebound", "invalidation-asia-no-confirm"] },
    },
    watchItems: [
      { item: "美国10年期与实际10年期收益率", whyItMatters: "它们决定折现率压力暂缓是否能从单日变化变成可延续线索。", expectedAt: null, sourceIds: sorted([...treasury, ...realTreasury]) },
      { item: "恒生科技相对恒指的表现", whyItMatters: "它检验海外风险偏好是否继续向亚洲成长资产传导。", expectedAt: null, sourceIds: hk },
      { item: "A股成交额与市场广度是否同日闭合", whyItMatters: "成交收缩与广度缺口尚未形成完整的本地确认，不能用缺失数据替代。", expectedAt: null, sourceIds: ashare },
      { item: "FOMC异议与9月15—16日会议前的政策措辞", whyItMatters: "政策分歧是否伴随收益率上行，将决定估值修复线索能否延续。", expectedAt: "2026-09-15", sourceIds: fed },
    ],
    sourceIds: allSourceIds,
    marketTags: ["US", "HK", "A_SHARE", "GLOBAL"],
    topicTags: ["cross-market", "rates", "risk-appetite", "market-confirmation"],
  };
  const payload = {
    schemaVersion: "global-market-brief-v1",
    editionDate,
    generatedAt: `${editionDate}T14:00:00.000Z`,
    dataAsOf,
    buildStatus: baseline.payload.buildStatus,
    sourceIndex: sources,
    specialTriggerCandidates: structuredClone(global.specialTriggerCandidates),
    mainArticle,
    specialReports: [],
  };
  const result = sealWriterResult({
    schemaVersion: "writer-result-v2",
    mode: "global_market_brief",
    jobId: request.jobId,
    requestId: request.requestId,
    contextId: request.context.contextId,
    generatedAt: `${editionDate}T14:00:00.000Z`,
    writerEngine: "local-codex-writer",
    writerVersion: "p2-b4a-global-market-brief-v1",
    payload,
    claimBindings: {
      global: [
        claim("$.payload.mainArticle.conclusion", sorted([...ap, ...treasury, ...realTreasury, ...ashare])),
      claim("$.payload.mainArticle.keyFacts[0].statement", sourceIds(context, facts[0].sourceIds)),
      claim("$.payload.mainArticle.analysisSections[0].paragraphs[0]", sorted([...ap, ...treasury, ...realTreasury])),
      claim("$.payload.mainArticle.analysisSections[3].paragraphs[1]", ashare),
        claim("$.payload.mainArticle.logicChain[0].to", sorted([...ap, ...treasury])),
        claim("$.payload.mainArticle.logicChain[1].to", sorted([...treasury, ...realTreasury])),
        claim("$.payload.mainArticle.crossMarketTransmission[0].explanation", sorted([...ap, ...hk])),
        claim("$.payload.mainArticle.crossMarketTransmission[1].explanation", sorted([...ashare, ...treasury, ...realTreasury])),
        claim("$.payload.mainArticle.outlook.nextSession.statement", sorted([...ashare, ...hk, ...treasury, ...realTreasury])),
        claim("$.payload.mainArticle.outlook.oneWeek.statement", sorted([...ap, ...fed, ...treasury, ...realTreasury])),
        claim("$.payload.mainArticle.invalidationConditions[0].condition", sorted([...treasury, ...realTreasury])),
        claim("$.payload.mainArticle.watchItems[2].whyItMatters", ashare),
      ],
      quantitative: [],
      qualitative: [],
      sourceMetadata: [],
    },
    warnings: [],
  });
  writeJson(path.resolve(output), result);
  return result;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--") continue;
    if (!values[index].startsWith("--")) fail("arguments", "unknown positional argument");
    const key = values[index].slice(2);
    if (!key || Object.hasOwn(result, key)) fail("arguments", "duplicate option");
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const args = parseArgs(process.argv.slice(2));
    createRealGlobalWriterResult({ packageDirectory: args.package, output: args.output });
    console.log(canonicalJson({ schemaVersion: "global-market-brief-writer-result-summary-v1", output: path.resolve(args.output) }));
  } catch (cause) {
    console.error(cause instanceof Error ? `${cause.code ?? "GLOBAL_WRITER_RESULT_FAILURE"} ${cause.path ?? "result"} ${cause.message}` : "GLOBAL_WRITER_RESULT_FAILURE");
    process.exitCode = 1;
  }
}
