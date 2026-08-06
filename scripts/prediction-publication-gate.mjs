#!/usr/bin/env node
/**
 * HK/US prediction publication gate v1.
 *
 * Reads the frozen gate registry and the stage-2 private research outputs
 * (MODEL_CARDS.json / OOS_METRICS.json / GATE_RESULTS.json / RUN_RESULT.json)
 * and evaluates every market/object/horizon independently.  A-share keeps the
 * existing frozen production gate; this script never copies or loosens it.
 *
 * Any failing threshold yields publicationStatus abstained | insufficient_data
 * | unavailable with outputMode=none and probability=null.  The gate never
 * fabricates a pass and never emits a default 50% probability.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const REGISTRY_PATH = path.join(repositoryRoot, "data", "model-research", "prediction-publication-gates-v1.json");
const LOG2 = Math.log(2);

export class PublicationGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicationGateError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicationGateError(code, message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("INPUT_MISSING", `${label} is missing or invalid: ${file}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function validateRegistry(registry) {
  const schema = readJson(path.join(repositoryRoot, "schemas", "prediction-publication-gate-v1.schema.json"), "gate schema");
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T/);
  const validate = ajv.compile(schema);
  if (!validate(registry)) {
    fail("REGISTRY_INVALID", `gate registry failed schema: ${JSON.stringify(validate.errors)}`);
  }
}

function researchInputs(researchOutput) {
  const runResult = readJson(path.join(researchOutput, "RUN_RESULT.json"), "RUN_RESULT.json");
  const modelCards = readJson(path.join(researchOutput, "MODEL_CARDS.json"), "MODEL_CARDS.json");
  const oosMetrics = readJson(path.join(researchOutput, "OOS_METRICS.json"), "OOS_METRICS.json");
  if (modelCards.schemaVersion !== "three-market-model-cards-index-v1") fail("INPUT_SCHEMA", "MODEL_CARDS.json has an unexpected schemaVersion");
  if (oosMetrics.schemaVersion !== "three-market-oos-metrics-v1") fail("INPUT_SCHEMA", "OOS_METRICS.json has an unexpected schemaVersion");
  if (runResult.schemaVersion !== "three-market-run-result-v1") fail("INPUT_SCHEMA", "RUN_RESULT.json has an unexpected schemaVersion");
  return { runResult, modelCards, oosMetrics };
}

function requiredSourceHealth(registryObject, runResult) {
  const sources = Array.isArray(runResult.sourceAudit?.sources) ? runResult.sourceAudit.sources : [];
  const byRole = new Map(sources.filter((entry) => entry && typeof entry.role === "string").map((entry) => [entry.role, entry]));
  const failures = [];
  for (const role of registryObject.requiredSourceRoles) {
    const entry = byRole.get(role);
    if (!entry || entry.status !== "ready") failures.push(`${role}:${entry?.status ?? "missing"}`);
  }
  return { ok: failures.length === 0, failures };
}

const SOURCE_ROLE_LABELS = {
  hsi_ohlcv: "恒生指数历史行情",
  hstech_ohlcv: "恒生科技指数历史行情",
  nasdaq_composite_close_fallback: "纳斯达克综合指数历史行情",
  sox_ohlcv: "费城半导体指数历史行情",
  vix_close: "CBOE 波动率指数历史行情",
};

function marketSourceStatus(registryMarket, runResult) {
  const sources = Array.isArray(runResult.sourceAudit?.sources) ? runResult.sourceAudit.sources : [];
  const byRole = new Map(sources.filter((entry) => entry && typeof entry.role === "string").map((entry) => [entry.role, entry]));
  const roles = [];
  for (const object of registryMarket.objects ?? []) {
    for (const role of object.requiredSourceRoles ?? []) {
      if (!roles.includes(role)) roles.push(role);
    }
  }
  const failures = [];
  for (const role of roles) {
    const entry = byRole.get(role);
    if (!entry || entry.status !== "ready") failures.push({ role, status: entry?.status ?? "missing" });
  }
  if (!failures.length) {
    return { status: "ready", reason: "该市场必需数据源全部可用。" };
  }
  const names = failures.map((failure) => SOURCE_ROLE_LABELS[failure.role] ?? "必需历史数据源").join("、");
  return { status: "partial", reason: `必需历史数据源不可用（${names}），暂不发布预测。` };
}

function logLossSkill(logLoss) {
  if (!finiteNumber(logLoss)) return null;
  return 1 - logLoss / LOG2;
}

function foldChecks(card, oosEntry, policy) {
  const folds = Array.isArray(card.folds) ? card.folds : [];
  const foldSkills = folds
    .map((fold) => fold?.metrics?.brierSkill)
    .filter((value) => finiteNumber(value));
  const foldBrierPassShare = foldSkills.length ? foldSkills.filter((value) => value > policy.brierSkillMin).length / foldSkills.length : 0;
  const improvements = folds
    .map((fold) => {
      const baseline = fold?.metrics?.baselineBrier;
      const brier = fold?.metrics?.brier;
      return finiteNumber(baseline) && finiteNumber(brier) ? baseline - brier : null;
    })
    .filter((value) => value !== null);
  const totalPositiveImprovement = improvements.reduce((sum, value) => sum + Math.max(0, value), 0);
  const maxSingleFoldImprovementShare = totalPositiveImprovement > 0
    ? Math.max(...improvements.map((value) => Math.max(0, value))) / totalPositiveImprovement
    : null;
  return {
    foldBrierPassShare,
    totalPositiveImprovement,
    maxSingleFoldImprovementShare,
    validFoldCount: folds.length,
    strictOos: oosEntry?.strictOos === true,
  };
}

function evaluateHorizon({ registryObject, card, oosEntry, runResult, policy, horizon, recordDate, officialSources }) {
  const checks = [];
  const addCheck = (name, passed, detail) => checks.push({ name, passed: Boolean(passed), detail });
  const objectDatasetStatus = card?.objectDatasetStatus ?? card?.datasetStatus ?? "unknown";
  const rawAvailability = card?.modelAvailability ?? "not_trained";
  const modelAvailability = ["trained", "not_trained", "not_implemented"].includes(rawAvailability) ? rawAvailability : "not_trained";

  // Short circuit: object data is unavailable -> unavailable (never a probability).
  if (objectDatasetStatus === "unavailable" || modelAvailability === "not_implemented") {
    return {
      horizonSessions: horizon,
      target: registryObject.target,
      modelVersion: card?.modelVersion ?? null,
      datasetId: card?.datasetId ?? null,
      datasetStatus: card?.datasetStatus ?? null,
      modelAvailability,
      publicationStatus: "unavailable",
      outputMode: "none",
      probability: null,
      expectedReturn: null,
      probabilitySource: "none",
      calibrationStatus: card?.calibrationStatus ?? "not_applicable",
      statusReason: "该对象尚无可验证的连续历史数据，未使用未标记代理，暂不发布预测。",
      failedChecks: [],
      passedChecks: [],
      asOf: recordDate,
      dueDate: null,
      sourceUrls: officialSources,
    };
  }

  const metrics = card?.metrics ?? {};
  const oosSampleCount = finiteNumber(metrics.oosSampleCount) ? metrics.oosSampleCount : finiteNumber(oosEntry?.oosSampleCount) ? oosEntry.oosSampleCount : 0;
  const validFoldCount = Array.isArray(card?.folds) ? card.folds.length : finiteNumber(oosEntry?.oosWindowCount) ? oosEntry.oosWindowCount : 0;
  const brierSkill = finiteNumber(metrics.brierSkill) ? metrics.brierSkill : null;
  const logLoss = finiteNumber(metrics.logLoss) ? metrics.logLoss : null;
  const auc = finiteNumber(metrics.auc) ? metrics.auc : null;
  const dispersion = finiteNumber(metrics.predictionDispersion) ? metrics.predictionDispersion : null;
  const coverage = finiteNumber(metrics.coverage) ? metrics.coverage : null;
  const calibrationStatus = card?.calibrationStatus ?? "not_applicable";
  const calibrationSlope = finiteNumber(card?.calibrationSlope) ? card.calibrationSlope : null;
  const calibrationIntercept = finiteNumber(card?.calibrationIntercept) ? card.calibrationIntercept : null;
  const sourceHealth = requiredSourceHealth(registryObject, runResult);
  const folds = foldChecks(card, oosEntry, policy);
  const [slopeMin, slopeMax] = policy.calibrationSlopeRange;

  const datasetReady = card?.datasetStatus === "ready";
  const modelTrained = modelAvailability === "trained";
  const enoughFolds = validFoldCount >= policy.minValidFolds;
  const enoughSamples = oosSampleCount >= policy.minOosSamples[String(horizon)];
  const brierOk = brierSkill !== null && brierSkill > policy.brierSkillMin;
  const logLossOk = logLossSkill(logLoss) !== null && logLossSkill(logLoss) > policy.logLossSkillMin;
  const foldShareOk = folds.validFoldCount > 0 && folds.foldBrierPassShare >= policy.foldBrierSkillPassShare;
  const aucOk = auc === null || auc > policy.aucMin;
  const calibrationSlopeOk = calibrationSlope !== null && calibrationSlope >= slopeMin && calibrationSlope <= slopeMax;
  const calibrationInterceptOk = calibrationIntercept !== null && Math.abs(calibrationIntercept) <= policy.calibrationInterceptAbsMax;
  const dispersionOk = dispersion !== null && dispersion >= policy.probabilityStdMin;
  const coverageOk = coverage !== null && coverage >= policy.coverageMin;
  const leakageVerified = card?.leakageVerified === true || (folds.strictOos && calibrationStatus !== "enabled");
  const foldStabilityOk = folds.totalPositiveImprovement > 0
    && folds.maxSingleFoldImprovementShare !== null
    && folds.maxSingleFoldImprovementShare <= policy.maxSingleFoldImprovementShare;

  addCheck("dataset_status_ready", datasetReady, `datasetStatus=${card?.datasetStatus ?? "unknown"}`);
  addCheck("model_availability_trained", modelTrained, `modelAvailability=${card?.modelAvailability ?? "unknown"}`);
  addCheck("required_source_health", sourceHealth.ok, sourceHealth.failures.join(", ") || "all required sources ready");
  addCheck("valid_fold_count", enoughFolds, `validFolds=${validFoldCount} min=${policy.minValidFolds}`);
  addCheck("oos_sample_count", enoughSamples, `oosSamples=${oosSampleCount} min=${policy.minOosSamples[String(horizon)]}`);
  addCheck("aggregate_brier_skill", brierOk, `brierSkill=${String(brierSkill)} min=${policy.brierSkillMin}`);
  addCheck("aggregate_log_loss_skill", logLossOk, `logLossSkill=${String(logLossSkill(logLoss))} min=${policy.logLossSkillMin}`);
  addCheck("fold_brier_skill_share", foldShareOk, `foldPassShare=${folds.foldBrierPassShare.toFixed(4)} min=${policy.foldBrierSkillPassShare}`);
  addCheck("auc_above_minimum", aucOk, `auc=${String(auc)} min=${policy.aucMin}`);
  addCheck("calibration_slope", calibrationSlopeOk, `slope=${String(calibrationSlope)} range=[${slopeMin},${slopeMax}]`);
  addCheck("calibration_intercept", calibrationInterceptOk, `intercept=${String(calibrationIntercept)} absMax=${policy.calibrationInterceptAbsMax}`);
  addCheck("probability_std", dispersionOk, `std=${String(dispersion)} min=${policy.probabilityStdMin}`);
  addCheck("coverage", coverageOk, `coverage=${String(coverage)} min=${policy.coverageMin}`);
  addCheck("no_cross_fold_leakage", leakageVerified, leakageVerified ? "strict OOS with no enabled cross-fold calibration" : "leakage not verified");
  addCheck("fold_stability", foldStabilityOk, `maxSingleFoldShare=${String(folds.maxSingleFoldImprovementShare)} max=${policy.maxSingleFoldImprovementShare}`);

  const failed = checks.filter((check) => !check.passed);
  let publicationStatus;
  let statusReason;
  if (!modelTrained || !enoughFolds || !enoughSamples) {
    publicationStatus = "insufficient_data";
    statusReason = "有效历史样本或样本外窗口不足，暂不训练或发布概率。";
  } else if (failed.length) {
    publicationStatus = "abstained";
    statusReason = "模型已完成样本外研究，但未通过全部生产发布门槛，暂不发布概率。";
  } else {
    publicationStatus = "published";
    statusReason = "全部发布门槛通过。";
  }

  return {
    horizonSessions: horizon,
    target: registryObject.target,
    modelVersion: card?.modelVersion ?? null,
    datasetId: card?.datasetId ?? null,
    datasetStatus: card?.datasetStatus ?? null,
    modelAvailability,
    publicationStatus,
    outputMode: publicationStatus === "published" ? "probability" : "none",
    probability: publicationStatus === "published" && finiteNumber(metrics.topQuartileProbability) ? metrics.topQuartileProbability : null,
    expectedReturn: null,
    probabilitySource: publicationStatus === "published" ? "raw_model" : "none",
    calibrationStatus,
    statusReason,
    failedChecks: failed.map((check) => `${check.name}:${check.detail}`),
    passedChecks: checks.filter((check) => check.passed).map((check) => check.name),
    asOf: recordDate,
    dueDate: null,
    sourceUrls: officialSources,
  };
}

const OFFICIAL_SOURCES = {
  hsi: ["https://www.hsi.com.hk/eng/indexes/all-indexes/hang-seng-index"],
  hstech: ["https://www.hsi.com.hk/eng/indexes/all-indexes/hang-seng-tech-index"],
  hk_innovative_drug: [],
  hk_tech_internet: [],
  nasdaq_composite: ["https://www.nasdaq.com/market-activity/index/comp"],
};

function stateRecordForHorizon(result, marketId, registryObject, recordDate) {
  const identity = {
    recordDate,
    market: marketId,
    objectId: registryObject.objectId,
    horizon: result.horizonSessions,
    modelVersion: result.modelVersion ?? "none",
  };
  const digest = sha256(JSON.stringify(identity)).slice(0, 12);
  const modelSlug = String(result.modelVersion ?? "none").replace(/[^a-z0-9_-]+/gi, "-");
  return {
    stateId: `state-${marketId}-${registryObject.objectId}-${recordDate.replaceAll("-", "")}-h${result.horizonSessions}-${modelSlug}-${digest}`,
    recordDate,
    market: marketId,
    objectId: registryObject.objectId,
    objectLabel: registryObject.label,
    horizonSessions: result.horizonSessions,
    target: registryObject.target,
    modelVersion: result.modelVersion ?? "none",
    modelAvailability: result.modelAvailability,
    datasetId: result.datasetId,
    datasetStatus: result.datasetStatus,
    publicationStatus: result.publicationStatus,
    outputMode: result.outputMode,
    probability: null,
    expectedReturn: null,
    probabilitySource: "none",
    probabilityTarget: "none",
    calibrationStatus: result.calibrationStatus,
    abstainReasons: [{
      abstained: "未通过全部生产发布门槛",
      insufficient_data: "有效历史样本或样本外窗口不足",
      unavailable: "该对象数据不可用",
      not_applicable: "模型未实现",
    }[result.publicationStatus] ?? result.publicationStatus],
    statusReason: result.statusReason,
    asOf: result.asOf,
    dueDate: null,
    sourceUrls: result.sourceUrls,
    legacy: false,
  };
}

export function evaluatePublicationGate({
  registryPath = REGISTRY_PATH,
  researchOutput = null,
  rotationPath = null,
  now = new Date(),
} = {}) {
  const registry = readJson(registryPath, "gate registry");
  validateRegistry(registry);
  if (!researchOutput || !fs.existsSync(path.join(researchOutput, "RUN_RESULT.json"))) {
    fail("PRIVATE_OUTPUT_MISSING", `stage2 private research output is required: ${String(researchOutput)}`);
  }
  const { runResult, modelCards, oosMetrics } = researchInputs(researchOutput);
  const recordDate = String(runResult.generatedAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate)) fail("INPUT_SCHEMA", "RUN_RESULT.generatedAt has no usable date");

  const markets = {};
  let evaluated = 0;
  let published = 0;
  let abstained = 0;
  let insufficient = 0;
  let unavailable = 0;
  for (const registryMarket of registry.markets) {
    const marketKey = registryMarket.researchMarketKey;
    const objects = [];
    for (const registryObject of registryMarket.objects) {
      const horizons = [];
      for (const horizon of registryObject.horizons) {
        const card = modelCards.cardData?.[`${marketKey}_${registryObject.objectId}_${horizon}`];
        const oosEntry = oosMetrics.markets?.[`${marketKey}/${registryObject.objectId}/${horizon}`];
        const result = evaluateHorizon({
          registryObject,
          card,
          oosEntry,
          runResult,
          policy: registry.policy,
          horizon,
          recordDate,
          officialSources: OFFICIAL_SOURCES[registryObject.objectId] ?? [],
        });
        horizons.push(result);
        evaluated += 1;
        if (result.publicationStatus === "published") published += 1;
        if (result.publicationStatus === "abstained") abstained += 1;
        if (result.publicationStatus === "insufficient_data") insufficient += 1;
        if (result.publicationStatus === "unavailable") unavailable += 1;
      }
      objects.push({
        objectId: registryObject.objectId,
        label: registryObject.label,
        objectType: "index",
        benchmarkLabel: registryObject.objectId === "hsi" ? "恒生指数" : registryObject.objectId === "hstech" ? "恒生科技指数" : registryObject.objectId === "nasdaq_composite" ? "纳斯达克综合指数" : "恒生指数",
        modelAvailability: horizons[0]?.modelAvailability ?? "not_trained",
        candidateStatus: "shadow",
        horizons,
      });
    }
    markets[registryMarket.marketId] = {
      marketId: registryMarket.marketId,
      label: registryMarket.label,
      datasetStatus: runResult.datasets?.[marketKey]?.status ?? "unknown",
      dataAsOf: recordDate,
      datasetId: runResult.datasets?.[marketKey]?.datasetId ?? null,
      sourceStatus: marketSourceStatus(registryMarket, runResult),
      objects,
    };
  }

  return {
    schemaVersion: "prediction-publication-gate-results-v1",
    generatedAt: now.toISOString(),
    registrySha256: sha256(fs.readFileSync(registryPath)),
    researchOutput: researchOutput,
    recordDate,
    policy: {
      minValidFolds: registry.policy.minValidFolds,
      minOosSamples: registry.policy.minOosSamples,
      probabilitiesPublished: published > 0,
    },
    markets,
    summary: {
      evaluated,
      published,
      abstained,
      insufficient_data: insufficient,
      unavailable,
      probabilitiesPublished: published > 0,
      default50Forbidden: true,
    },
  };
}

export function buildLedgerStates(gateResults) {
  const registry = gateResults.registry;
  const states = [];
  for (const market of Object.values(gateResults.markets)) {
    const registryMarket = registry.markets.find((item) => item.marketId === market.marketId);
    for (const object of market.objects) {
      const registryObject = registryMarket.objects.find((item) => item.objectId === object.objectId);
      for (const horizon of object.horizons) {
        states.push(stateRecordForHorizon(horizon, market.marketId, registryObject, gateResults.recordDate));
      }
    }
  }
  return states.sort((left, right) => left.stateId.localeCompare(right.stateId));
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) fail("CLI_ARGUMENT", `unknown positional argument: ${values[index]}`);
    const key = values[index].slice(2);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const args = parseArgs(process.argv.slice(2));
  const researchOutput = args["research-output"] ? path.resolve(args["research-output"]) : process.env.GUANCHAO_STAGE2_RESEARCH_OUTPUT ?? null;
  const registry = readJson(path.resolve(args.registry ?? REGISTRY_PATH), "gate registry");
  const gateResults = evaluatePublicationGate({
    registryPath: path.resolve(args.registry ?? REGISTRY_PATH),
    researchOutput,
    rotationPath: args.rotation ? path.resolve(args.rotation) : null,
  });
  gateResults.registry = registry;
  if (args.output) writeJsonAtomic(path.resolve(args.output), gateResults);
  if (args["states-output"]) {
    writeJsonAtomic(path.resolve(args["states-output"]), { schemaVersion: "ledger-state-records-v1", states: buildLedgerStates(gateResults) });
  }
  const report = {
    ...gateResults,
    generatedAt: gateResults.generatedAt,
  };
  delete report.registry;
  console.log(JSON.stringify(report, null, 2));
  if (args["forbid-published"] === true && gateResults.summary.probabilitiesPublished) {
    console.error("HK/US probabilities published; stage2 frozen results must remain blocked.");
    process.exitCode = 1;
  }
}
