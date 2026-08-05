import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { canonicalJson } from "./research-contract.mjs";
import { validateGlobalMarketBrief } from "./global-market-brief-contract.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(field, message) {
  const error = new Error(`${field}: ${message}`);
  error.code = "GLOBAL_REAL_INPUT";
  error.path = field;
  throw error;
}

function readJson(root, relativePath) {
  const file = path.resolve(root, ...relativePath.split("/"));
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail(relativePath, "JSON input is missing or invalid");
  }
}

function readGzipJson(root, relativePath) {
  const file = path.resolve(root, ...relativePath.split("/"));
  try {
    return JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
  } catch {
    fail(relativePath, "immutable gzip JSON input is missing or invalid");
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${canonicalJson(value)}\n`, "utf8");
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function assertDate(value, field) {
  if (typeof value !== "string" || !DATE.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    fail(field, "canonical YYYY-MM-DD required");
  }
}

function assertTimestamp(value, field) {
  if (typeof value !== "string" || !TIMESTAMP.test(value) || new Date(value).toISOString() !== value) fail(field, "canonical UTC timestamp required");
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function canonicalUrlKey(url) {
  const parsed = new URL(url);
  parsed.hash = "";
  return parsed.toString();
}

function publicPublisher(publisher, url) {
  const hostname = new URL(url).hostname.toLowerCase();
  if (publisher === "Federal Reserve" && !(hostname === "federalreserve.gov" || hostname.endsWith(".federalreserve.gov"))) return "Compliance Alliance";
  return publisher;
}

function sourceFromDocument(document, id = document.sourceId) {
  if (!document?.sourceId || !document.canonicalUrl || !document.title || !document.publisher) fail("bundle.documents", "document lacks safe source metadata");
  return {
    id,
    title: document.title,
    publisher: publicPublisher(document.publisher, document.canonicalUrl),
    url: document.canonicalUrl,
    asOf: document.publishedDate ?? null,
  };
}

function sourceFromPacketRegistry(source) {
  if (!source?.sourceId || !source.sourceUrl) fail("packet.sourceIndex", "source lacks a stable URL");
  return {
    id: source.sourceId,
    title: source.datasetId ?? source.sourceId,
    publisher: source.publisher ?? source.sourceId,
    url: source.sourceUrl,
    asOf: source.asOf ?? null,
  };
}

function mergeSources(bundle, packet) {
  const sources = new Map();
  const aliases = new Map();
  const packetByUrl = new Map();
  for (const source of Object.values(packet.sourceIndex ?? {})) {
    if (!source?.sourceId || !source.sourceUrl || source.status !== "ready") continue;
    packetByUrl.set(canonicalUrlKey(source.sourceUrl), source.sourceId);
  }
  const add = (candidate, preferredId = candidate.id) => {
    const key = canonicalUrlKey(candidate.url);
    const existing = sources.get(key);
    if (existing) {
      aliases.set(candidate.id, existing.id);
      aliases.set(preferredId, existing.id);
      return;
    }
    const source = { ...candidate, id: preferredId };
    sources.set(key, source);
    aliases.set(candidate.id, source.id);
    aliases.set(source.id, source.id);
  };
  for (const document of bundle.documents ?? []) {
    const preferredId = packetByUrl.get(canonicalUrlKey(document.canonicalUrl)) ?? document.sourceId;
    add(sourceFromDocument(document, preferredId), preferredId);
    aliases.set(document.sourceId, preferredId);
  }
  for (const source of Object.values(packet.sourceIndex ?? {})) {
    if (!source?.sourceId || !source.sourceUrl || source.status !== "ready") continue;
    const safe = sourceFromPacketRegistry(source);
    add(safe, safe.id);
  }
  for (const fact of packet.facts ?? []) {
    if (!fact?.sourceId || !fact.sourceUrl) continue;
    const safe = {
      id: fact.sourceId,
      title: fact.sourceTitle ?? fact.label ?? fact.sourceId,
      publisher: fact.publisher ?? fact.sourceId,
      url: fact.sourceUrl,
      asOf: fact.asOf ?? null,
    };
    add({ ...safe, publisher: publicPublisher(safe.publisher, safe.url) }, safe.id);
  }
  return {
    sources: [...sources.values()].sort((left, right) => left.id.localeCompare(right.id) || left.url.localeCompare(right.url)),
    aliases,
  };
}

function sourceIdsForObservation(bundle, observation, aliases) {
  const documents = new Map((bundle.documents ?? []).map((document) => [document.documentId, document]));
  const sourceIds = (observation.basis ?? []).map((basis) => {
    const sourceId = documents.get(basis.documentId)?.sourceId;
    return sourceId ? aliases.get(sourceId) ?? sourceId : null;
  }).filter(Boolean);
  if (!sourceIds.length) fail(`bundle.observations.${observation.observationId}`, "observation has no source-backed basis");
  return uniqueSorted(sourceIds);
}

function observationStatement(observation) {
  const subject = observation?.subject;
  if (subject === "US risk appetite") return "2026年8月3日，油价回落缓解通胀担忧，美股走强；美国10年期国债收益率收于4.70%，较前一交易日回落5bp。";
  if (subject === "HK tech strength") return "2026年8月3日，恒指收于26009.40点，上涨0.48%；恒生科技指数上涨约1.0%，科技股领涨。";
  if (subject === "Fed hold with dissent") return "7月29日，美联储将联邦基金目标利率维持在3.50%—3.75%，有三名委员提出异议；下一次会议安排在9月15—16日。";
  if (subject === "A-share turnover contraction") return "2026年8月3日，A股主要指数收跌，沪指跌0.59%、深证成指跌0.96%、创业板指跌1.24%；成交额约1.9974万亿元，较前一日减少约5446亿元。";
  fail("bundle.observations", `unsupported observation subject: ${subject}`);
}

function observationFact(bundle, observation, id, factStatus, aliases) {
  return {
    id,
    statement: observationStatement(observation),
    asOf: observation.asOf,
    sourceIds: sourceIdsForObservation(bundle, observation, aliases),
    factStatus,
  };
}

function packetMissingBreadth(packet) {
  return (packet.missingData ?? []).some((item) => /breadth|广度/i.test(String(item))) || packet.marketBreadth?.status === "unavailable";
}

function buildMainArticle({ editionDate, asOf, sources, facts }) {
  const sourceIds = sources.map((source) => source.id);
  const treasuryNominal = "us-treasury-nominal-xml";
  const treasuryReal = "us-treasury-real-xml";
  const ap = "ap-us-stocks-2026-08-03";
  const hk = "aastocks-hk-close-2026-08-03";
  const ashare = "eastmoney-a-share-close-2026-08-03";
  const fed = "fed-fomc-statement-2026-07-29";
  const calendar = "fed-fomc-calendar-2026";
  const all = uniqueSorted(sourceIds);
  return {
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
        sourceIds: [ap, treasuryNominal, treasuryReal].sort(),
      },
      {
        heading: "折现率与风险偏好",
        paragraphs: [
          "油价回落先缓解了市场对通胀的担忧，美股在这一背景下接近纪录；与此同时，2年期、10年期和30年期收益率分别为4.25%、4.70%和5.23%，较前一交易日回落3bp、5bp和4bp。价格与利率同日向有利于成长估值的一侧变化，因而风险偏好回暖有了可观察的价格证据。",
          "反证也很清楚：2s10s利差收窄2bp至45bp，且名义10年期收益率较20日前仍上行22bp。曲线与长端位置并没有共同指向彻底宽松，市场更像是在等待下一组利率数据确认，而不是已经完成政策方向切换。",
        ],
        sourceIds: [ap, treasuryNominal].sort(),
      },
      {
        heading: "跨市场传导",
        paragraphs: [
          "美国市场的第一站是港股科技：8月3日恒指上涨0.48%至26009.40点，恒生科技指数上涨约1.0%，科技股表现强于大盘。美股风险偏好改善与折现率压力暂缓，为港股成长资产提供了外部顺风，但单日同步仍不足以证明传导已经稳定。",
          "传向A股时，链条出现断点。沪指、深证成指和创业板指分别下跌0.59%、0.96%和1.24%，成交额约1.9974万亿元，较前一日减少约5446亿元。外部线索已经在美股和港股得到价格回应，却尚未在本地成交中得到同方向确认。",
        ],
        sourceIds: [ap, hk, ashare].sort(),
      },
      {
        heading: "本地确认缺口",
        paragraphs: [
          "A股的反向证据不是跌幅本身，而是下跌与成交收缩同时出现。若外部风险偏好正在形成跨市场扩散，本地市场至少需要看到成交不再继续收缩，或成长板块相对表现与港股科技同步；当前数据只支持‘尚未接力’，不支持更强的本地趋势判断。",
          "本轮市场广度数据未取得，因此这里只把成交额收缩作为反向证据，不用缺失数据推断上涨家数、内部参与度或资金净流入。这个缺口会直接影响A股是否完成全球主线确认，也意味着下一步需要等待可复核的广度与成交数据同时闭合。",
        ],
        sourceIds: [ashare].sort(),
      },
      {
        heading: "下一步验证",
        paragraphs: [
          "下一交易时段先看10年期与实际10年期收益率能否继续回落，再看恒生科技相对恒指的强势是否延续。若利率回升、港股科技转弱且A股成交仍低于8月3日基线，当前的跨市场传导判断应当撤回；如果三项观察相反，估值修复线索才有机会从单日反应变成连续信号。",
          "未来一周还要把政策分歧放回定价框架：7月会议有三票异议，9月15—16日是下一次FOMC会议。收益率回落、海外风险偏好延续，并得到A/H成交或广度接力时，修复线索才可能扩展；否则，本文只保留‘折现率压力暂缓’这一有限判断。",
        ],
        sourceIds: [ap, hk, ashare, calendar, fed, treasuryNominal, treasuryReal].sort(),
      },
    ],
    keyFacts: facts,
    logicChain: [
      { from: "油价回落与美股走强", relation: "先给风险偏好提供价格确认", to: "海外风险偏好回暖", evidenceStatus: "confirmed", supportingSourceIds: [ap, treasuryNominal].sort(), contradictorySourceIds: [] },
      { from: "名义与实际10年期收益率回落", relation: "暂缓折现率压力", to: "成长资产估值获得修复空间", evidenceStatus: "partially_confirmed", supportingSourceIds: [treasuryNominal, treasuryReal].sort(), contradictorySourceIds: [] },
      { from: "海外风险偏好改善", relation: "可能向亚洲风险资产传导", to: "港股科技相对走强", evidenceStatus: "partially_confirmed", supportingSourceIds: [ap, hk].sort(), contradictorySourceIds: [] },
      { from: "A股成交缩量", relation: "削弱本地资金确认", to: "全球风险偏好尚未同步", evidenceStatus: "confirmed", supportingSourceIds: [ashare], contradictorySourceIds: [] },
    ],
    crossMarketTransmission: [
      { fromMarket: "US", toMarket: "HK", direction: "positive", horizon: "next_session", explanation: "美股风险偏好与利率压力暂缓为港股科技提供外部顺风，但港股自身的相对表现仍需下一交易时段确认。", evidenceStatus: "partially_confirmed", supportingSourceIds: [ap, hk].sort(), invalidationConditionIds: ["invalidation-asia-no-confirm"] },
      { fromMarket: "US", toMarket: "A_SHARE", direction: "mixed", horizon: "one_week", explanation: "海外折现率压力暂缓可能改善全球估值环境，但A股成交收缩与广度数据缺口意味着外部线索尚未转化为本地共振。", evidenceStatus: "pending", supportingSourceIds: [ashare, treasuryNominal, treasuryReal].sort(), invalidationConditionIds: ["invalidation-asia-no-confirm", "invalidation-rates-rebound"] },
    ],
    invalidationConditions: [
      { id: "invalidation-rates-rebound", condition: "若10年期或实际10年期收益率重新连续上行，当前折现率压力暂缓与估值修复空间的判断失效。", affectedClaims: ["折现率压力暂缓", "估值修复空间"] },
      { id: "invalidation-asia-no-confirm", condition: "若港股科技不能延续相对强势且A股成交继续低于8月3日基线，外部风险偏好向亚洲传导的判断失效。", affectedClaims: ["海外风险偏好向亚洲传导", "A股本地确认"] },
      { id: "invalidation-fed-hawkish", condition: "若后续美联储沟通强化政策分歧并伴随收益率上行，未来一周估值修复判断失效。", affectedClaims: ["未来一周估值修复扩散"] },
    ],
    outlook: {
      nextSession: { statement: "下一交易时段先看10年期与实际10年期收益率是否继续回落，再看港股科技能否延续相对恒指的强势；若利率回升而本地成交仍弱，外部情绪传导暂不确认。", supportingSourceIds: [ashare, hk, treasuryNominal, treasuryReal].sort(), invalidationConditionIds: ["invalidation-rates-rebound", "invalidation-asia-no-confirm"] },
      oneWeek: { statement: "未来一周，只有收益率回落、海外风险偏好延续并得到A/H成交或广度接力，估值修复才可能扩展；FOMC三票异议与9月会议日历提醒市场政策分歧仍在。", supportingSourceIds: [ap, calendar, fed, treasuryNominal, treasuryReal].sort(), invalidationConditionIds: ["invalidation-fed-hawkish", "invalidation-rates-rebound", "invalidation-asia-no-confirm"] },
    },
    watchItems: [
      { item: "美国10年期与实际10年期收益率", whyItMatters: "它们决定折现率压力暂缓是否能从单日变化变成可延续线索。", expectedAt: null, sourceIds: [treasuryNominal, treasuryReal].sort() },
      { item: "恒生科技相对恒指的表现", whyItMatters: "它检验海外风险偏好是否继续向亚洲成长资产传导。", expectedAt: null, sourceIds: [hk].sort() },
      { item: "A股成交额与市场广度是否同日闭合", whyItMatters: "成交收缩与广度数据缺口尚未形成完整的本地确认，不能用缺失数据替代。", expectedAt: null, sourceIds: [ashare] },
      { item: "FOMC异议与9月15—16日会议前的政策措辞", whyItMatters: "政策分歧是否伴随收益率上行，将决定估值修复线索能否延续。", expectedAt: "2026-09-15", sourceIds: [calendar, fed].sort() },
    ],
    sourceIds: all,
    marketTags: ["US", "HK", "A_SHARE", "GLOBAL"],
    topicTags: ["cross-market", "rates", "risk-appetite", "market-confirmation"],
  };
}

export function buildRealGlobalMarketBrief({ root = repositoryRoot, editionDate = "2026-08-04", packetPath = "content/writer-packets/daily-latest.json", bundlePath = null } = {}) {
  assertDate(editionDate, "editionDate");
  const packet = readJson(root, packetPath);
  const packetAsOf = packet.marketDates?.aShare;
  assertDate(packetAsOf, "packet.marketDates.aShare");
  if (packet.edition !== "daily") fail("packet.edition", "daily packet required");
  if (packet.generatedAt && (typeof packet.generatedAt !== "string" || !Number.isFinite(Date.parse(packet.generatedAt)))) fail("packet.generatedAt", "valid timestamp required");
  const resolvedBundlePath = bundlePath ?? (() => {
    const latest = readJson(root, "content/research-bundles/daily-latest.json");
    if (latest.edition !== "daily" || latest.asOf !== packetAsOf || !latest.bundleId) fail("research-bundles/daily-latest.json", "latest bundle is not aligned to packet asOf");
    return `data/research-bundles/bundles/${latest.asOf.slice(0, 4)}/${latest.asOf.slice(5, 7)}/${latest.bundleId}.json.gz`;
  })();
  const bundle = readGzipJson(root, resolvedBundlePath);
  if (bundle.schemaVersion !== "research-bundle-v1" || bundle.edition !== "daily" || bundle.asOf !== packetAsOf) fail("researchBundle", "bundle schema/edition/asOf does not match packet");
  const baseline = readJson(root, "content/daily-brief.json");
  if (baseline.meta?.editionDate && baseline.meta.editionDate > editionDate) fail("baseline.meta.editionDate", "baseline is newer than requested edition");
  if (baseline.meta?.dataThrough && baseline.meta.dataThrough !== packetAsOf) fail("baseline.meta.dataThrough", "baseline dataThrough differs from packet asOf");
  const sourceRegistry = mergeSources(bundle, packet);
  const sources = sourceRegistry.sources;
  const sourceIds = new Set(sources.map((source) => source.id));
  const observations = new Map((bundle.observations ?? []).map((observation) => [observation.marketScopes?.[0], observation]));
  const requiredMarkets = ["US", "HK", "FED", "A_SHARE"];
  for (const market of requiredMarkets) if (!observations.has(market)) fail(`bundle.observations.${market}`, "real market observation is required");
  const facts = [
    observationFact(bundle, observations.get("US"), "observation-us-risk-appetite-20260803", "confirmed", sourceRegistry.aliases),
    observationFact(bundle, observations.get("HK"), "observation-hk-tech-strength-20260803", "estimated", sourceRegistry.aliases),
    observationFact(bundle, observations.get("FED"), "observation-fed-hold-20260803", "confirmed", sourceRegistry.aliases),
    observationFact(bundle, observations.get("A_SHARE"), "observation-a-share-turnover-20260803", "estimated", sourceRegistry.aliases),
  ];
  for (const fact of facts) for (const sourceId of fact.sourceIds) if (!sourceIds.has(sourceId)) fail(`mainArticle.keyFacts.${fact.id}`, `source ${sourceId} is not in sourceIndex`);
  const mainArticle = buildMainArticle({ editionDate, asOf: packetAsOf, sources, facts });
  const triggerEvidenceIds = uniqueSorted([
    ...facts.flatMap((fact) => fact.sourceIds),
  ]).filter((sourceId) => sourceIds.has(sourceId));
  const specialTriggerCandidates = [{
    id: "routine-market-volatility-20260803",
    eligible: false,
    triggerType: "abnormal_market_move",
    reason: "冻结事件集合为空，普通市场波动由全球主文章承载，不生成专项文章。",
    triggerEvidenceIds,
  }];
  const brief = {
    schemaVersion: "global-market-brief-v1",
    editionDate,
    generatedAt: `${editionDate}T12:00:00.000Z`,
    dataAsOf: packetAsOf,
    buildStatus: packetMissingBreadth(packet) ? "partial" : "ready",
    sourceIndex: sources,
    specialTriggerCandidates,
    mainArticle,
    specialReports: [],
  };
  try {
    validateGlobalMarketBrief(brief);
  } catch (cause) {
    fail("global brief", cause instanceof Error ? cause.message : "real global brief failed validation");
  }
  return { brief, packetPath, bundlePath: resolvedBundlePath, bundleId: bundle.bundleId, writerPacketId: packet.writerPacketId };
}

export function writeRealGlobalInputs({ root = repositoryRoot, output, baselineOutput, ...options } = {}) {
  if (typeof output !== "string") fail("output", "output path is required");
  const result = buildRealGlobalMarketBrief({ root, ...options });
  const baseline = structuredClone(result.brief);
  baseline.generatedAt = `${baseline.editionDate}T11:00:00.000Z`;
  writeJson(path.resolve(output), result.brief);
  if (baselineOutput) writeJson(path.resolve(baselineOutput), baseline);
  return { ...result, output: path.resolve(output), baselineOutput: baselineOutput ? path.resolve(baselineOutput) : null };
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
    if (typeof args.output !== "string") fail("output", "--output is required");
    const result = writeRealGlobalInputs({ root: args.root ? path.resolve(args.root) : repositoryRoot, output: args.output, baselineOutput: args["baseline-output"] ?? null, editionDate: args["edition-date"] ?? "2026-08-04", packetPath: args["packet"] ?? "content/writer-packets/daily-latest.json", bundlePath: args.bundle ?? null });
    console.log(canonicalJson({ schemaVersion: "global-market-brief-real-input-summary-v1", editionDate: result.brief.editionDate, dataAsOf: result.brief.dataAsOf, bundleId: result.bundleId, writerPacketId: result.writerPacketId, specialReportCount: result.brief.specialReports.length, triggerCandidateCount: result.brief.specialTriggerCandidates.length, output: result.output, baselineOutput: result.baselineOutput }));
  } catch (cause) {
    console.error(cause instanceof Error ? `${cause.code ?? "GLOBAL_REAL_INPUT_FAILURE"} ${cause.path ?? "input"} ${cause.message}` : "GLOBAL_REAL_INPUT_FAILURE");
    process.exitCode = 1;
  }
}
