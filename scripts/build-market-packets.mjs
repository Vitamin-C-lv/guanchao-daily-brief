import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Canonical } from "./research-contract.mjs";

export const DAILY_PACKET_SCHEMA = "daily-market-packet-v1";
export const REVIEW_PACKET_SCHEMA = "prediction-review-packet-v1";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function sha256File(file) {
  try { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); } catch { return null; }
}

function shanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function utcTimestamp(value = new Date()) {
  return new Date(value).toISOString();
}

function businessPacket(value) {
  const { packetId, integrity, ...body } = value;
  return body;
}

function withIntegrity(value) {
  const businessSha256 = sha256Canonical(businessPacket(value));
  return { ...value, packetId: businessSha256, integrity: { businessSha256, sha256: sha256Canonical({ ...businessPacket(value), packetId: businessSha256, integrity: { businessSha256, sha256: null } }) } };
}

function sourceEntry(root, relativePath, kind = "derived") {
  const file = path.join(root, ...relativePath.split("/"));
  return { path: relativePath, kind, sha256: sha256File(file), present: fs.existsSync(file) };
}

function predictionRecords(root) {
  const value = readJson(path.join(root, "content", "prediction-history.json"), {});
  return Array.isArray(value.records) ? value.records : [];
}

function predictionClass(record) {
  if (record?.publication_status === "published" && Number.isFinite(record?.raw_probability ?? record?.calibrated_probability ?? record?.absolute_up_probability ?? record?.relative_outperformance_probability ?? record?.top_quartile_probability)) return "published_model_prediction";
  if (record?.output_mode === "evidence_observation" || record?.ranking_target === "evidence-observation" || Number.isFinite(record?.observation_score)) return "evidence_observation";
  if (record?.publication_status === "abstained" || record?.prediction_status === "model-abstained" || record?.result === "model-abstained") return "abstained";
  return "not_applicable";
}

function latestRecords(records, asOf) {
  return records.filter((record) => typeof record?.prediction_date === "string" && record.prediction_date <= asOf)
    .sort((left, right) => String(right.prediction_date).localeCompare(String(left.prediction_date)) || String(left.prediction_id).localeCompare(String(right.prediction_id)));
}

function compactPrediction(record) {
  return {
    predictionId: record.prediction_id ?? null,
    predictionDate: record.prediction_date ?? null,
    market: record.market ?? null,
    horizonSessions: record.horizon ?? null,
    sectorId: record.sector_id ?? null,
    sectorName: record.sector_name ?? null,
    classification: predictionClass(record),
    publicationStatus: record.publication_status ?? null,
    outputMode: record.output_mode ?? null,
    modelVersion: record.model_version ?? null,
    dueDate: record.due_date ?? null,
    evaluatedAt: record.evaluated_at ?? null,
    result: record.result ?? null,
    observationScore: Number.isFinite(record.observation_score) ? record.observation_score : null,
    probabilityPresent: Number.isFinite(record.calibrated_probability ?? record.raw_probability ?? record.absolute_up_probability ?? record.relative_outperformance_probability ?? record.top_quartile_probability),
    targetOutcome: record.realized_top_quartile ?? null,
  };
}

function reviewHorizon(records, horizon, asOf) {
  const selected = latestRecords(records, asOf).filter((record) => Number(record.horizon) === horizon);
  const byClass = Object.fromEntries(["published_model_prediction", "evidence_observation", "abstained", "not_applicable"].map((key) => [key, selected.filter((record) => predictionClass(record) === key)]));
  const maturedModels = byClass.published_model_prediction.filter((record) => record.evaluated_at || record.result);
  const outcomes = maturedModels.filter((record) => typeof record.realized_top_quartile === "boolean");
  const probabilityRecords = maturedModels.filter((record) => Number.isFinite(record.calibrated_probability ?? record.raw_probability ?? record.absolute_up_probability ?? record.relative_outperformance_probability ?? record.top_quartile_probability));
  const brier = probabilityRecords.length ? probabilityRecords.reduce((sum, record) => {
    const probability = Number(record.calibrated_probability ?? record.raw_probability ?? record.absolute_up_probability ?? record.relative_outperformance_probability ?? record.top_quartile_probability);
    const outcome = record.realized_top_quartile === true ? 1 : record.realized_top_quartile === false ? 0 : null;
    return outcome === null ? sum : sum + (probability - outcome) ** 2;
  }, 0) / Math.max(1, probabilityRecords.filter((record) => typeof record.realized_top_quartile === "boolean").length) : null;
  return {
    horizonSessions: horizon,
    counts: {
      total: selected.length,
      publishedModelPrediction: byClass.published_model_prediction.length,
      evidenceObservation: byClass.evidence_observation.length,
      abstained: byClass.abstained.length,
      notApplicable: byClass.not_applicable.length,
      maturedPublishedModelPrediction: maturedModels.length,
      maturedOutcomes: outcomes.length,
    },
    publishedModelPrediction: {
      status: outcomes.length ? "evaluated" : maturedModels.length ? "partial" : "pending",
      accuracy: null,
      brier: Number.isFinite(brier) ? Number(brier.toFixed(6)) : null,
      note: "只有 published model prediction 可进入模型评估；observation 不进入准确率/命中率分母。",
    },
    evidenceObservation: {
      count: byClass.evidence_observation.length,
      withRealizedFields: byClass.evidence_observation.filter((record) => record.evaluated_at || record.result).length,
      notModelAccuracy: true,
      note: "evidence observation 只保留事实观察与回看，不称为模型准确率或命中率。",
    },
    abstained: { count: byClass.abstained.length, excludedFromModelDenominator: true },
    notApplicable: { count: byClass.not_applicable.length, excludedFromModelDenominator: true },
    rows: selected.slice(0, 120).map(compactPrediction),
  };
}

export function buildPredictionReviewPacket({ root = repositoryRoot, asOf = shanghaiDate(), generatedAt = utcTimestamp(), records = predictionRecords(root) } = {}) {
  if (!DATE.test(asOf)) throw new Error(`invalid review asOf: ${asOf}`);
  const packet = {
    schemaVersion: REVIEW_PACKET_SCHEMA,
    asOfDate: asOf,
    generatedAt,
    status: "partial",
    classificationContract: {
      published_model_prediction: "probability-bearing published model output; eligible for model review",
      evidence_observation: "validated observation/ranking; never probability accuracy",
      abstained: "model abstention; excluded from denominator",
      not_applicable: "model unavailable or not applicable; excluded from denominator",
    },
    horizons: { "1d": reviewHorizon(records, 1, asOf), "5d": reviewHorizon(records, 5, asOf), "20d": reviewHorizon(records, 20, asOf) },
    source: { path: "content/prediction-history.json", sha256: sha256File(path.join(root, "content", "prediction-history.json")), immutableLedger: true, ledgerWrite: false },
    warnings: ["本轮为 Writer/研究回看包；不写 production prediction ledger，不自动 promotion，不发布新的 HK probability。"],
  };
  return withIntegrity(packet);
}

function newsCandidates(root, asOf) {
  const directory = path.join(root, "content", "global-market-briefs");
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name)).sort().reverse().map((name) => {
    const relativePath = `content/global-market-briefs/${name}`;
    const value = readJson(path.join(root, ...relativePath.split("/")), {});
    const article = value.mainArticle ?? value;
    return { articleId: article.id ?? value.id ?? name.slice(0, -5), editionDate: name.slice(0, 10), title: article.title ?? value.title ?? null, articleUrl: article.articleUrl ?? value.articleUrl ?? null, dataAsOf: article.dataAsOf ?? value.dataAsOf ?? null, sourceCount: Array.isArray(article.keyFacts) ? article.keyFacts.length : null, availableForResearch: name.slice(0, 10) <= asOf };
  }).filter((item) => item.availableForResearch).slice(0, 12);
}

export function buildDailyMarketPacket({ root = repositoryRoot, asOf = shanghaiDate(), generatedAt = utcTimestamp(), writerPacket = null, sectorRotation = null } = {}) {
  const packetPath = path.join(root, "content", "writer-packets", "daily-latest.json");
  const rotationPath = path.join(root, "content", "sector-rotation.json");
  const historyPath = path.join(root, "public", "data", "market-history", "hang-seng-tech.json");
  const packetSource = writerPacket ?? readJson(packetPath, {});
  const rotation = sectorRotation ?? readJson(rotationPath, {});
  const hstech = readJson(historyPath, {});
  const aShare = rotation.markets?.find?.((market) => market.id === "a-share") ?? rotation.markets?.[0] ?? {};
  const marketDates = packetSource.marketDates ?? {};
  const packet = {
    schemaVersion: DAILY_PACKET_SCHEMA,
    edition: "daily",
    editionDate: asOf,
    generatedAt,
    status: packetSource.providerHealth?.status === "ready" && packetSource.marketSummary?.status === "latest" ? "ready" : "partial",
    writerProductName: "观潮每日晚报",
    writerMayBrowse: true,
    browseTriggers: ["疑点", "缺失", "未更新", "数据和新闻冲突", "重大政策", "异常行情", "值得深入研究的话题", "18:20–20:00 新发生事件"],
    markets: {
      aShare: { status: aShare.status ?? packetSource.marketSummary?.status ?? "partial", asOf: aShare.asOf ?? marketDates.aShare ?? null, modelFeatureIncluded: true },
      hk: { status: hstech.status ?? "unavailable", asOf: hstech.asOf ?? null, hstechRows: Array.isArray(hstech.bars) ? hstech.bars.length : 0, modelFeatureIncluded: false },
      us: { status: marketDates.us ? "ready" : "unavailable", asOf: marketDates.us ?? null, modelFeatureIncluded: false },
    },
    facts: Array.isArray(packetSource.facts) ? packetSource.facts.slice(0, 80).map((fact) => ({ factId: fact.factId, label: fact.label, market: fact.market, value: fact.value, unit: fact.unit, asOf: fact.asOf, status: fact.status, sourceId: fact.sourceId, sourceUrl: fact.sourceUrl })) : [],
    predictionState: {
      outputMode: "probability_or_evidence_observation_by_gate",
      note: "规则门禁失败时只能写规则观察分，不是概率；abstained 不等于预测错误。",
      horizons: [1, 5, 20],
      recordsAvailable: predictionRecords(root).filter((record) => record.prediction_date <= asOf).length,
    },
    newsCandidates: newsCandidates(root, asOf),
    sourceIndex: [sourceEntry(root, "content/writer-packets/daily-latest.json"), sourceEntry(root, "content/sector-rotation.json"), sourceEntry(root, "public/data/market-history/hang-seng-tech.json")],
    missingData: [...(packetSource.missingData ?? []), ...(hstech.status !== "ready" ? ["HSTECH"] : [])].filter((value, index, array) => array.indexOf(value) === index).sort(),
    warnings: ["Packet 是已验证事实底座，不是 Writer 信息上限；Writer 必须在触发条件下主动联网搜索。", "Policy/State Capital Watch 只供 Writer/研究记忆，不进入 production model feature。"],
  };
  return withIntegrity(packet);
}

export function buildAllPackets(options = {}) {
  return { daily: buildDailyMarketPacket(options), review: buildPredictionReviewPacket(options) };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

export function writePackets(output, value) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, "DAILY_MARKET_PACKET.json"), `${canonicalJson(value.daily)}\n`, "utf8");
  fs.writeFileSync(path.join(output, "PREDICTION_REVIEW_PACKET.json"), `${canonicalJson(value.review)}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const root = path.resolve(argument("--root", repositoryRoot));
    const asOf = argument("--date", shanghaiDate());
    const output = path.resolve(argument("--output", path.join("D:\\Guanchao-Workspace", "runtime", "packets", asOf)));
    const packets = buildAllPackets({ root, asOf, generatedAt: argument("--generated-at", utcTimestamp()) });
    writePackets(output, packets);
    console.log(JSON.stringify({ output, daily: { packetId: packets.daily.packetId, status: packets.daily.status }, review: { packetId: packets.review.packetId, status: packets.review.status } }, null, 2));
  } catch (error) {
    console.error(`PACKET_BUILD_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
