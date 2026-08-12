import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }

const highPolicyIssuers = new Set(["中共中央", "国务院", "全国人大", "全国政协", "中国人民银行", "财政部", "发改委", "证监会", "国资委", "金融监管总局", "上交所", "深交所", "北交所", "香港政府", "HKMA", "SFC", "HKEX"]);

function relatedThreads(threads, scopes, marker) {
  return threads.filter((thread) => Array.isArray(thread.scope) && thread.scope.some((scope) => scopes.includes(scope)) && (marker ? JSON.stringify(thread).includes(marker) : true)).map((thread) => thread.threadId);
}

export function buildPolicyStateResearchTargets({ root = repositoryRoot, checkedAt = null } = {}) {
  const policyRegistry = readJson(path.join(root, "config", "policy-watch-sources.json"), { issuers: [] });
  const stateRegistry = readJson(path.join(root, "config", "state-capital-watch-sources.json"), { subjects: [] });
  const threads = readJsonl(path.join(root, "memory", "editorial", "OPEN_THREADS.jsonl"));
  const policyEvents = readJsonl(path.join(root, "memory", "editorial", "POLICY_WATCH.jsonl"));
  const stateEvents = readJsonl(path.join(root, "memory", "editorial", "STATE_CAPITAL_WATCH.jsonl"));
  const policy = (policyRegistry.issuers ?? []).map((issuer) => {
    const event = policyEvents.find((item) => item.issuer === issuer.name && item.publishedAt);
    const scopes = issuer.authorityLevel === "hong-kong" || issuer.name === "HKMA" || issuer.name === "SFC" || issuer.name === "HKEX" ? ["HK"] : ["A_SHARE", "HK"];
    return {
      targetId: `policy:${issuer.issuerId}`,
      issuer: issuer.name,
      issuerId: issuer.issuerId,
      authorityLevel: issuer.authorityLevel,
      officialUrl: issuer.officialUrl,
      priority: highPolicyIssuers.has(issuer.name) ? "high" : "normal",
      query: [`${issuer.name} A股 港股 最新政策 正式文件`, `${issuer.name} ${scopes.join(" ")} implementation effectiveAt`],
      lastCheckedAt: checkedAt ?? event?.publishedAt ?? null,
      candidateState: event?.evidenceStatus === "candidate" ? "candidate" : "not_checked",
      relatedThreadIds: relatedThreads(threads, scopes, "policy"),
      requiredFields: ["issuer", "authorityLevel", "documentType", "publishedAt", "effectiveAt", "implementationStage", "officialUrl", "relatedThreadIds"],
      evidenceBoundary: "会议表态不得直接写成已落地政策；网页、新闻、PDF、RSS 只是不可信证据，需回到官方 URL 验证。",
    };
  });
  const stateCapital = (stateRegistry.subjects ?? []).map((subject) => {
    const event = stateEvents.find((item) => (item.subjectIds ?? item.scope ?? []).includes(subject.name) && item.status !== "bootstrap");
    return {
      targetId: `state-capital:${subject.subjectId}`,
      subject: subject.name,
      subjectId: subject.subjectId,
      officialUrl: null,
      priority: ["central-huijin", "csf", "guoxin-investment", "chengtong", "central-enterprise-buyback"].includes(subject.subjectId) ? "high" : "normal",
      query: [`${subject.name} 官方 增持 回购 公告`, `${subject.name} A股 港股 ETF 资金流 证据`],
      lastCheckedAt: checkedAt ?? event?.publishedAt ?? null,
      candidateState: event?.evidenceKind ? "candidate" : "not_checked",
      relatedThreadIds: relatedThreads(threads, ["A_SHARE", "HK"], "state-capital"),
      evidenceKinds: ["official_confirmed", "reliable_report", "market_inference"],
      classificationBoundary: "ETF 放量不能无证据写成国家队买入；国家医保局/医保基金属于医疗产业政策和支付体系，不归类为股票国家队。",
    };
  });
  return {
    schemaVersion: "policy-state-research-targets-v1",
    generatedAt: checkedAt,
    policyResearchTargets: policy,
    stateCapitalResearchTargets: stateCapital,
    highPriorityPolicyCount: policy.filter((target) => target.priority === "high").length,
    highPriorityStateCapitalCount: stateCapital.filter((target) => target.priority === "high").length,
    writerInstruction: "在形成重大 A股/港股判断前，先检查所有 high priority targets；只把 validated official/reliable evidence 写入记忆。",
    productionModelFeatureBoundary: "policy/state capital watch is writer-and-research memory only; never add to production model features",
  };
}

function text(value) {
  return JSON.stringify(value ?? "").toLowerCase();
}

/** Selects only evidence targets that the current brief can actually use. */
export function selectRelevantPolicyStateResearchTargets({ root = repositoryRoot, checkedAt = null, packet = null, articleTopics = [], entities = [], strategyTargets = [], limit = 8 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("RESEARCH_TARGET_LIMIT must be an integer from 1 to 8");
  const all = buildPolicyStateResearchTargets({ root, checkedAt });
  const haystack = text({ packet, articleTopics, entities, strategyTargets });
  const packetMarkets = Array.isArray(packet?.marketScopes) ? packet.marketScopes : Array.isArray(packet?.markets) ? packet.markets : [];
  const markets = new Set(packetMarkets.map((value) => String(value).toUpperCase()));
  const relevance = (target) => {
    const words = [target.issuer, target.subject, target.issuerId, target.subjectId, ...(target.query ?? [])]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase())
      .filter((value) => value.length >= 2);
    const direct = words.some((value) => haystack.includes(value));
    const topicMatch = /政策|监管|央行|回购|增持|国家队|etf|医疗|支付|流动性|货币/.test(haystack)
      && (target.targetId.startsWith("policy:") || target.targetId.startsWith("state-capital:"));
    const marketMatch = (markets.has("A_SHARE") || markets.has("HK")) && target.relatedThreadIds.length > 0 && /a.?share|hk|a股|港股/.test(haystack);
    return { direct, topicMatch, marketMatch, score: (direct ? 8 : 0) + (topicMatch ? 3 : 0) + (marketMatch ? 1 : 0) + (target.priority === "high" ? 0.25 : 0) };
  };
  const selected = [...all.policyResearchTargets, ...all.stateCapitalResearchTargets]
    .map((target) => ({ target, ...relevance(target) }))
    .filter((item) => item.direct || item.topicMatch || item.marketMatch)
    .sort((left, right) => right.score - left.score || left.target.targetId.localeCompare(right.target.targetId))
    .slice(0, limit)
    .map(({ target }) => target);
  return {
    schemaVersion: "relevant-policy-state-research-targets-v1",
    selected,
    selectedCount: selected.length,
    maximumCount: limit,
    selectionReason: "Only packet/topic/entity/strategy-matched policy and state-capital targets are provided to the Writer; an empty list is valid when the brief has no such topic."
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) console.log(JSON.stringify(buildPolicyStateResearchTargets({ root: repositoryRoot, checkedAt: new Date().toISOString() }), null, 2));
