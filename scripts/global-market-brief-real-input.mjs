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

function sourceFromDocument(document) {
  if (!document?.sourceId || !document.canonicalUrl || !document.title || !document.publisher) fail("bundle.documents", "document lacks safe source metadata");
  return {
    id: document.sourceId,
    title: document.title,
    publisher: document.publisher,
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
  for (const document of bundle.documents ?? []) {
    const source = sourceFromDocument(document);
    if (!sources.has(source.id)) sources.set(source.id, source);
  }
  for (const source of Object.values(packet.sourceIndex ?? {})) {
    if (!source?.sourceId || !source.sourceUrl) continue;
    const safe = sourceFromPacketRegistry(source);
    if (!sources.has(safe.id)) sources.set(safe.id, safe);
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
    if (!sources.has(safe.id)) sources.set(safe.id, safe);
  }
  return [...sources.values()].sort((left, right) => left.id.localeCompare(right.id) || left.url.localeCompare(right.url));
}

function sourceIdsForObservation(bundle, observation) {
  const documents = new Map((bundle.documents ?? []).map((document) => [document.documentId, document]));
  const sourceIds = (observation.basis ?? []).map((basis) => documents.get(basis.documentId)?.sourceId).filter(Boolean);
  if (!sourceIds.length) fail(`bundle.observations.${observation.observationId}`, "observation has no source-backed basis");
  return uniqueSorted(sourceIds);
}

function observationFact(bundle, observation, id, factStatus) {
  return {
    id,
    statement: observation.statement,
    asOf: observation.asOf,
    sourceIds: sourceIdsForObservation(bundle, observation),
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
  const csi = "csi-constituents";
  const all = uniqueSorted(sourceIds);
  return {
    id: `global-market-brief-${editionDate}`,
    slug: `global-market-brief-${editionDate}`,
    articleUrl: `/articles/global-market-brief-${editionDate}/`,
    contentKind: "global_main",
    title: "海外风险偏好回暖，估值修复仍等本地确认",
    dek: "美股逼近纪录、美国长端收益率回落，港股科技同步走强；但A股缩量回调，外部风险偏好尚未完成跨市场确认。",
    conclusion: "8月3日的核心线索不是单一市场上涨，而是折现率压力暂缓后风险偏好先在美股和港股得到价格确认；A股成交收缩说明本地资金尚未接力。下一步应先验证收益率回落能否延续，以及亚洲市场的相对强势能否扩散。",
    keyFacts: facts,
    logicChain: [
      { from: "油价回落与美股走强", relation: "先给风险偏好提供价格确认", to: "海外风险偏好回暖", evidenceStatus: "confirmed", supportingSourceIds: [ap, treasuryNominal].sort(), contradictorySourceIds: [] },
      { from: "名义与实际10年期收益率回落", relation: "暂缓折现率压力", to: "成长资产估值获得修复空间", evidenceStatus: "partially_confirmed", supportingSourceIds: [treasuryNominal, treasuryReal].sort(), contradictorySourceIds: [] },
      { from: "海外风险偏好改善", relation: "可能向亚洲风险资产传导", to: "港股科技相对走强", evidenceStatus: "partially_confirmed", supportingSourceIds: [ap, hk].sort(), contradictorySourceIds: [] },
      { from: "A股成交缩量", relation: "削弱本地资金确认", to: "全球风险偏好尚未同步", evidenceStatus: "confirmed", supportingSourceIds: [ashare, csi].sort(), contradictorySourceIds: [] },
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
      { item: "A股成交额与市场广度是否同日闭合", whyItMatters: "成交收缩与广度缺口尚未形成完整的本地确认，不能用缺失数据替代。", expectedAt: null, sourceIds: [ashare, csi].sort() },
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
  const sources = mergeSources(bundle, packet);
  const sourceIds = new Set(sources.map((source) => source.id));
  const observations = new Map((bundle.observations ?? []).map((observation) => [observation.marketScopes?.[0], observation]));
  const requiredMarkets = ["US", "HK", "FED", "A_SHARE"];
  for (const market of requiredMarkets) if (!observations.has(market)) fail(`bundle.observations.${market}`, "real market observation is required");
  const facts = [
    observationFact(bundle, observations.get("US"), "observation-us-risk-appetite-20260803", "confirmed"),
    observationFact(bundle, observations.get("HK"), "observation-hk-tech-strength-20260803", "estimated"),
    observationFact(bundle, observations.get("FED"), "observation-fed-hold-20260803", "confirmed"),
    observationFact(bundle, observations.get("A_SHARE"), "observation-a-share-turnover-20260803", "estimated"),
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
