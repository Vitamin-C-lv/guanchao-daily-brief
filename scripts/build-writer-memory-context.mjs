import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Canonical } from "./research-contract.mjs";
import { validateMemoryTree } from "./memory-manager.mjs";
import { selectRelevantPolicyStateResearchTargets } from "./build-policy-state-research-targets.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function readJsonl(file) { try { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; } }
function shanghaiDate(value = new Date()) { return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function articleValue(root, entry) { return entry?.path ? readJson(path.join(root, ...entry.path.split("/")), null) : null; }
function fullArticle(root, entry) { return { ...entry, content: articleValue(root, entry) }; }
function articleSummary(root, entry) {
  const content = articleValue(root, entry);
  return { ...entry, summary: content ? { title: content.title ?? entry.title ?? null, dek: content.dek ?? null, conclusion: content.conclusion ?? content.mainArticle?.conclusion ?? null, dataAsOf: content.dataAsOf ?? content.mainArticle?.dataAsOf ?? entry.dataAsOf ?? null, sourceIds: content.sourceIds ?? content.mainArticle?.sourceIds ?? [] } : null };
}

export function buildWriterMemoryContext({ root = repositoryRoot, editionDate = shanghaiDate(), dailyPacketPath = null, reviewPacketPath = null } = {}) {
  const memoryRoot = path.join(root, "memory", "editorial");
  const validation = validateMemoryTree(path.join(root, "memory"));
  const index = readJson(path.join(memoryRoot, "ARTICLE_INDEX.json"), { entries: [] });
  const dailies = (index.entries ?? []).filter((entry) => entry.type === "daily" && entry.editionDate <= editionDate).sort((left, right) => String(right.editionDate).localeCompare(String(left.editionDate)));
  const weeklies = (index.entries ?? []).filter((entry) => entry.type === "weekly").sort((left, right) => String(right.editionDate).localeCompare(String(left.editionDate)));
  const openThreads = readJsonl(path.join(memoryRoot, "OPEN_THREADS.jsonl"));
  const lessons = readJsonl(path.join(memoryRoot, "LESSONS.jsonl")).filter((entry) => entry.status === "confirmed");
  const judgments = readJsonl(path.join(memoryRoot, "JUDGMENTS.jsonl"));
  const policy = readJsonl(path.join(memoryRoot, "POLICY_WATCH.jsonl"));
  const stateCapital = readJsonl(path.join(memoryRoot, "STATE_CAPITAL_WATCH.jsonl"));
  const reviews = readJsonl(path.join(memoryRoot, "PREDICTION_REVIEWS.jsonl"));
  const dailyPacket = dailyPacketPath ? readJson(dailyPacketPath, null) : null;
  const reviewPacket = reviewPacketPath ? readJson(reviewPacketPath, null) : null;
  const researchTargets = selectRelevantPolicyStateResearchTargets({
    root,
    checkedAt: editionDate,
    packet: dailyPacket,
    articleTopics: dailyPacket?.topics ?? dailyPacket?.newsCandidates?.map((item) => item.title ?? item.topic) ?? [],
    entities: dailyPacket?.entities ?? [],
    strategyTargets: dailyPacket?.investmentStrategy?.recommendations?.map((item) => item.targetId) ?? []
  });
  const recentDailyFull = dailies.slice(0, 3).map((entry) => fullArticle(root, entry));
  const priorDailySummaries = dailies.slice(3, 7).map((entry) => articleSummary(root, entry));
  const recentWeeklyFull = weeklies.slice(0, 2).map((entry) => fullArticle(root, entry));
  const body = {
    schemaVersion: "writer-memory-context-v1",
    editionDate,
    writerProductName: "观潮每日晚报",
    writerMayBrowse: true,
    operationsMemoryLoaded: false,
    bootstrap: {
      recentDailyFull,
      priorDailySummaries,
      recentWeeklyFull,
      openThreads: openThreads.slice(0, 20),
      confirmedLessons: lessons,
      judgments,
      policyWatch: policy,
      stateCapitalWatch: stateCapital,
      predictionReviews: reviews,
      dailyPacket: dailyPacket ?? { required: true, available: false },
      predictionReviewPacket: reviewPacket ?? { required: true, available: false },
      newsCandidates: dailyPacket?.newsCandidates ?? [],
      relevantPolicyStateResearchTargets: researchTargets.selected,
      researchTargetSummary: { selectedCount: researchTargets.selectedCount, maximumCount: researchTargets.maximumCount, selectionReason: researchTargets.selectionReason },
    },
    counts: {
      recentDailyFull: recentDailyFull.length,
      priorDailySummaries: Math.max(0, Math.min(4, dailies.length - 3)),
      recentWeeklyFull: recentWeeklyFull.length,
      openThreads: openThreads.length,
      confirmedLessons: lessons.length,
      policyWatch: policy.length,
      stateCapitalWatch: stateCapital.length,
      predictionReviews: reviews.length,
      memoryRecordsValidated: validation.records,
    },
    deepDive: {
      commands: ["pnpm memory:search", "pnpm memory:expand-thread", "pnpm memory:open-article"],
      activeResearchTriggers: ["疑点", "缺失", "未更新", "数据和新闻冲突", "重大政策", "异常行情", "值得深入研究的话题", "18:20–20:00 新发生事件"],
      packetIsFactBaseNotInformationCeiling: true,
      policyStateResearchIsTargeted: true,
    },
    memoryDelta: { schemaVersion: "memory-delta-v1", path: "memory/editorial/daily/MEMORY_DELTA-YYYY-MM-DD.json", managerOrder: ["validate", "dedupe", "sanitize", "merge"] },
    boundaries: { noProductionLedgerWrite: true, noAutomaticHKProbabilityPromotion: true, noNullToZero: true, noOperationsMemoryInDefaultContext: true },
  };
  return { ...body, contextId: sha256Canonical(body) };
}

function argument(name, fallback = null) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] ?? fallback : fallback; }

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const root = path.resolve(argument("--root", repositoryRoot));
    const editionDate = argument("--date", shanghaiDate());
    const context = buildWriterMemoryContext({ root, editionDate, dailyPacketPath: argument("--daily-packet"), reviewPacketPath: argument("--review-packet") });
    const output = argument("--output");
    if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(path.resolve(output), `${canonicalJson(context)}\n`, "utf8"); }
    console.log(JSON.stringify({ schemaVersion: context.schemaVersion, contextId: context.contextId, counts: context.counts, writerMayBrowse: context.writerMayBrowse, operationsMemoryLoaded: context.operationsMemoryLoaded }, null, 2));
  } catch (error) {
    console.error(`WRITER_MEMORY_CONTEXT_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
