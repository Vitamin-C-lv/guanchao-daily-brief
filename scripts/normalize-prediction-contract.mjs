import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contentPath = (...segments) => path.join(root, "content", ...segments);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const dated = (value) => typeof value === "string" ? value.replaceAll("-", "") : "";
const finite = (value) => typeof value === "number" && Number.isFinite(value);

function marketState(marketId, forecast) {
  if (marketId === "a-share") {
    return forecast
      ? {
          modelAvailability: "trained",
          publicationStatus: "abstained",
          outputMode: "evidence_observation",
          calibrationStatus: "disabled",
          probabilitySource: "raw_model",
          probabilityTarget: "top_quartile",
        }
      : {
          modelAvailability: "trained",
          publicationStatus: "not_applicable",
          outputMode: "evidence_observation",
          calibrationStatus: "not_applicable",
          probabilitySource: "none",
          probabilityTarget: "none",
        };
  }
  const notImplemented = marketId === "us";
  return {
    modelAvailability: notImplemented ? "not_implemented" : "not_trained",
    publicationStatus: "not_applicable",
    outputMode: "current_observation",
    calibrationStatus: "not_applicable",
    probabilitySource: "none",
    probabilityTarget: "none",
    modelInputCompleteness: null,
    productionFeatureCoverage: null,
  };
}

function applyCoverageContract(market, horizon) {
  if (market.id !== "a-share") {
    Object.assign(horizon, {
      coverageContractVersion: null,
      modelFeatureCoverage: null,
      productionSignalCoverage: null,
      trainingReadyCoverage: null,
      providerHealthCoverage: null,
    });
    return;
  }
  const coverage = market.featureCoverage ?? {};
  const modelInputCompleteness = finite(coverage.modelInputCompleteness)
    ? coverage.modelInputCompleteness
    : finite(horizon.modelInputCompleteness) ? horizon.modelInputCompleteness : null;
  const modelFeatureCoverage = finite(coverage.modelFeatureCoverage)
    ? coverage.modelFeatureCoverage
    : finite(horizon.modelFeatureCoverage) ? horizon.modelFeatureCoverage
      : finite(horizon.productionFeatureCoverage) ? horizon.productionFeatureCoverage : null;
  const productionSignalCoverage = finite(coverage.productionSignalCoverage)
    ? coverage.productionSignalCoverage
    : finite(horizon.productionSignalCoverage) ? horizon.productionSignalCoverage : modelFeatureCoverage;
  const trainingReadyCoverage = finite(coverage.trainingReadyCoverage)
    ? coverage.trainingReadyCoverage
    : finite(horizon.trainingReadyCoverage) ? horizon.trainingReadyCoverage : modelFeatureCoverage;
  const providerHealthCoverage = finite(coverage.providerHealthCoverage)
    ? coverage.providerHealthCoverage
    : finite(horizon.providerHealthCoverage) ? horizon.providerHealthCoverage : modelFeatureCoverage;
  Object.assign(horizon, {
    coverageContractVersion: coverage.coverageContractVersion ?? horizon.coverageContractVersion ?? "prediction-feature-coverage-v2",
    modelInputCompleteness,
    modelFeatureCoverage,
    productionSignalCoverage,
    trainingReadyCoverage,
    providerHealthCoverage,
    // Compatibility only: this remains the frozen model-feature measure and is
    // intentionally not upgraded by the observation-only breadth signal.
    productionFeatureCoverage: modelFeatureCoverage,
  });
}

function ensureAshareMetadata(market) {
  if (market.id !== "a-share") return;
  const current = market.horizons?.current ?? {};
  const legacyCoverage = finite(current.productionFeatureCoverage) ? current.productionFeatureCoverage : 0;
  if (!market.featureCoverage) {
    market.featureCoverage = {
      coverageContractVersion: "prediction-feature-coverage-v2",
      modelInputCompleteness: current.modelInputCompleteness ?? null,
      modelInputCount: { available: 26, required: 26 },
      modelFeatureCoverage: legacyCoverage,
      productionSignalCoverage: legacyCoverage,
      trainingReadyCoverage: legacyCoverage,
      providerHealthCoverage: legacyCoverage,
      productionFeatureCoverage: legacyCoverage,
      deprecatedAliasOf: "modelFeatureCoverage",
      groups: {
        priceRelativeStrength: { weight: 0.25, modelRequired: true, trainingReady: true, productionStatus: "ready", providerHealth: 1 },
        turnoverAndVolume: { weight: 0.25, modelRequired: true, trainingReady: true, productionStatus: "ready", providerHealth: 1 },
        marketBreadth: { weight: 0.20, modelRequired: false, trainingReady: false, productionStatus: "unavailable", productionGroupCoverage: 0, providerHealth: 0, reason: "immutable forward snapshots begin in P1-D" },
        etfAndInstitutionFlow: { weight: 0.20, modelRequired: false, trainingReady: false, productionStatus: "not_implemented", providerHealth: 0 },
        policyAndEventMapping: { weight: 0.10, modelRequired: false, trainingReady: false, productionStatus: "not_implemented", providerHealth: 0 },
      },
    };
  }
  if (!market.marketBreadthSummary) market.marketBreadthSummary = { status: "unavailable", groupCoverage: 0, productionReady: false, trainingReady: false };
  if (!market.sourceStatus) market.sourceStatus = { marketBreadth: { status: "unavailable", reason: `no immutable market breadth snapshot for ${market.asOf}` } };
  if (!Array.isArray(market.warnings)) market.warnings = [`marketBreadth snapshot unavailable for ${market.asOf}`];
  if (!market.modelLineage) {
    const lineage = readJson(path.join(root, "models", "sector-rotation", "a-share-relative-probability-v2.lineage.json"));
    market.modelLineage = { ok: true, ...lineage };
  }
}

function diagnosticModelVersion(rotation, marketId) {
  return marketId === "a-share" ? rotation.model.version : null;
}

function normalizeDailySourceUrls(market) {
  if (market.id !== "a-share" || market.horizons.current?.status !== "ready") return;
  for (const item of market.horizons.current.items) {
    for (const index of item.sourceIndexes ?? []) {
      const source = market.sources?.[index];
      if (!source?.url) continue;
      let url;
      try { url = new URL(source.url); } catch { continue; }
      if (!url.searchParams.has("indexCode")) continue;
      url.searchParams.set("indexCode", item.code);
      const startDate = url.searchParams.get("startDate") || dated(market.asOf);
      url.searchParams.set("startDate", startDate);
      url.searchParams.set("endDate", dated(market.asOf));
      source.url = url.toString();
    }
  }
}

function normalizeRotation(rotation) {
  const featureVersion = "a-core12-v2:price-volume-cross-section-interactions";
  for (const market of rotation.markets ?? []) {
    ensureAshareMetadata(market);
    normalizeDailySourceUrls(market);
    for (const [key, horizon] of Object.entries(market.horizons ?? {})) {
      const forecast = key !== "current";
      const state = marketState(market.id, forecast);
      const sessions = horizon.sessions ?? (key === "tomorrow" ? 1 : key === "oneWeek" ? 5 : key === "oneMonth" ? 20 : null);
      Object.assign(horizon, state, {
        modelVersion: diagnosticModelVersion(rotation, market.id),
        featureVersion: market.id === "a-share" ? featureVersion : null,
      });
      applyCoverageContract(market, horizon);

      if (forecast && market.id !== "a-share") {
        horizon.status = "insufficient";
        horizon.reason = market.id === "hk"
          ? "港股概率模型尚未建设，当前仅展示当日市场结构观察。"
          : "美股预测模型尚未实现，当前仅展示三大指数市场状态。";
        horizon.gateFailures = [market.id === "hk" ? "model_not_trained" : "model_not_implemented"];
        delete horizon.items;
        delete horizon.charts;
        delete horizon.abstainReasons;
        delete horizon.note;
        delete horizon.observationItems;
        delete horizon.availableEvidence;
        delete horizon.nextWatch;
        delete horizon.diagnostics;
        continue;
      }

      if (forecast && market.id === "a-share") {
        horizon.status = "abstained";
        horizon.gateFailures = [...new Set(horizon.abstainReasons ?? [])];
        horizon.diagnostics = {
          ...(horizon.diagnostics ?? {}),
          modelVersion: rotation.model.version,
          modelInputCompleteness: horizon.modelInputCompleteness,
          productionFeatureCoverage: horizon.productionFeatureCoverage,
          modelFeatureCoverage: horizon.modelFeatureCoverage,
          productionSignalCoverage: horizon.productionSignalCoverage,
          trainingReadyCoverage: horizon.trainingReadyCoverage,
          providerHealthCoverage: horizon.providerHealthCoverage,
        };
        delete horizon.diagnostics.dataCompleteness;
      } else {
        horizon.gateFailures = [];
      }
      if (!forecast) {
        horizon.modelVersion = diagnosticModelVersion(rotation, market.id);
      }
      if (sessions === null) delete horizon.sessions;
    }
  }
  return rotation;
}

function legacyProbabilitySource(record) {
  if (finite(record.absolute_up_probability) && finite(record.historical_base)
    && Math.abs(record.absolute_up_probability - record.historical_base) < 1e-9) return "historical_base_rate";
  return "legacy_unknown";
}

function normalizeHistory(history, rotation) {
  for (const record of history.records ?? []) {
    for (const key of [
      "raw_score", "raw_probability", "calibrated_probability", "relative_outperformance_probability", "top_quartile_probability",
      "absolute_up_probability", "expected_excess_return", "historical_base", "effective_edge", "data_completeness",
      "observation_score", "realized_absolute_return", "realized_benchmark_return", "realized_excess_return",
      "realized_sector_rank", "realized_sector_count",
    ]) {
      if (!(key in record)) record[key] = null;
    }
    const legacy = record.ranking_target === "absolute-up-legacy" || /probability-v1/.test(record.model_version ?? "");
    if (legacy) {
      Object.assign(record, {
        legacy: true,
        model_availability: "trained",
        publication_status: "published",
        output_mode: "probability",
        calibration_status: "legacy_unknown",
        probability_source: legacyProbabilitySource(record),
        probability_target: "absolute_up",
        model_input_completeness: record.data_completeness,
        production_feature_coverage: null,
      });
      continue;
    }
    if (record.market === "a-share" && /relative-v2/.test(record.model_version ?? "")) {
      Object.assign(record, {
        legacy: false,
        model_availability: "trained",
        publication_status: "abstained",
        output_mode: "evidence_observation",
        calibration_status: "disabled",
        probability_source: "raw_model",
        probability_target: "top_quartile",
        model_input_completeness: 1,
        production_feature_coverage: 0.5,
      });
      continue;
    }
    if (record.market === "hk") {
      Object.assign(record, {
        legacy: false,
        model_availability: "not_trained",
        publication_status: "not_applicable",
        output_mode: "current_observation",
        calibration_status: "not_applicable",
        probability_source: "none",
        probability_target: "none",
        model_input_completeness: null,
        production_feature_coverage: null,
        prediction_status: "not_applicable",
        result: "not-applicable",
        abstain_reason: ["港股概率模型尚未建设；当前记录仅为市场结构观察。"],
      });
    }
  }
  const legacyRecords = history.records.filter((record) => record.legacy === true);
  const currentRecords = history.records.filter((record) => record.legacy !== true);
  history.summary = {
    ...history.summary,
    records: history.records.length,
    published: history.records.filter((record) => record.publication_status === "published").length,
    abstained: history.records.filter((record) => record.publication_status === "abstained").length,
    evaluated: history.records.filter((record) => !["pending", "model-abstained", "not-applicable"].includes(record.result)).length,
    legacy: {
      records: legacyRecords.length,
      published: legacyRecords.filter((record) => record.publication_status === "published").length,
      evaluated: legacyRecords.filter((record) => record.result !== "pending").length,
    },
    currentModel: {
      records: currentRecords.length,
      published: currentRecords.filter((record) => record.publication_status === "published").length,
      abstained: currentRecords.filter((record) => record.publication_status === "abstained").length,
      evaluated: currentRecords.filter((record) => !["pending", "model-abstained", "not-applicable"].includes(record.result)).length,
    },
  };
  history.contract = {
    modelStateVersion: "p0-v1",
    currentModelVersion: rotation.model.version,
    legacyExcludedFromCurrentModelMetrics: true,
    probabilityTargetsNeverFallback: true,
  };
  return history;
}

function probabilitySummary(predictions, key) {
  const values = predictions
    .map((item) => item.probabilities?.topQuartile?.[key])
    .filter(finite);
  if (!values.length) return null;
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
  };
}

function oosMetrics(artifactHorizon) {
  if (!artifactHorizon) return null;
  const metrics = artifactHorizon.audit?.rankingMetrics;
  const calibration = artifactHorizon.calibrations?.topQuartile;
  return {
    brier: calibration?.rawMetrics?.brier ?? null,
    baselineBrier: calibration?.rawMetrics?.baselineBrier ?? null,
    brierSkill: calibration?.rawMetrics?.brierSkill ?? null,
    auc: calibration?.rawMetrics?.auc ?? null,
    rankIc: metrics?.rankIc ?? null,
    topBottomSpreadAfterCosts: metrics?.topBottomSpreadAfterCosts ?? null,
    predictionCrossSectionStd: metrics?.predictionCrossSectionStd ?? null,
  };
}

function diagnosticEntry(rotation, artifact, market, key, horizon) {
  const sessionHorizon = key === "current" ? "current" : horizon.sessions;
  const artifactHorizon = market.id === "a-share" && Number.isInteger(horizon.sessions)
    ? artifact.horizons?.[String(horizon.sessions)]
    : null;
  const latest = artifactHorizon?.latestPredictions ?? [];
  return {
    market: market.id,
    horizon: sessionHorizon,
    modelAvailability: horizon.modelAvailability,
    modelVersion: horizon.modelVersion,
    featureVersion: horizon.featureVersion,
    dataAsOf: horizon.asOf,
    snapshotCreatedAt: rotation.generatedAt,
    probabilityTarget: horizon.probabilityTarget,
    probabilitySource: horizon.probabilitySource,
    calibrationStatus: horizon.calibrationStatus,
    publicationStatus: horizon.publicationStatus,
    outputMode: horizon.outputMode,
    rawScoreAvailable: market.id === "a-share" && key !== "current" && latest.some((item) => finite(item.probabilities?.topQuartile?.rawScore)),
    rawProbabilityAvailable: market.id === "a-share" && key !== "current" && latest.some((item) => finite(item.probabilities?.topQuartile?.rawProbability)),
    calibratedProbabilityAvailable: market.id === "a-share" && key !== "current" && artifactHorizon?.calibrations?.topQuartile?.enabled === true,
    modelInputCompleteness: horizon.modelInputCompleteness,
    productionFeatureCoverage: horizon.productionFeatureCoverage,
    coverageContractVersion: horizon.coverageContractVersion,
    modelFeatureCoverage: horizon.modelFeatureCoverage,
    productionSignalCoverage: horizon.productionSignalCoverage,
    trainingReadyCoverage: horizon.trainingReadyCoverage,
    providerHealthCoverage: horizon.providerHealthCoverage,
    oosMetrics: market.id === "a-share" && key !== "current" ? oosMetrics(artifactHorizon) : null,
    gateThresholds: artifactHorizon?.audit?.qualityGate?.thresholds ?? null,
    gateActuals: market.id === "a-share" && key !== "current" ? {
      modelInputCompleteness: horizon.modelInputCompleteness,
      productionFeatureCoverage: horizon.productionFeatureCoverage,
      qualityGatePassed: artifactHorizon?.audit?.qualityGate?.passed ?? null,
    } : null,
    gateFailures: horizon.gateFailures ?? [],
    sourceFailures: market.id === "a-share" ? [
      ...(artifact.dataDiagnostics?.sourceHealth?.failures ?? []),
      ...(market.sourceStatus?.marketBreadth?.reason ? [market.sourceStatus.marketBreadth.reason] : []),
    ] : [],
    warnings: market.id === "a-share" && key !== "current"
      ? ["原始分数与概率仅用于机器诊断，页面不读取或展示被弃权概率。", ...(market.warnings ?? [])]
      : market.id === "hk"
        ? ["港股没有训练面板、标签、训练器或样本外指标。"]
        : market.id === "us"
          ? ["美股仅保留三大指数当前观察，预测模型尚未实现。"]
          : [],
    rawScoreDistribution: market.id === "a-share" && key !== "current" ? probabilitySummary(latest, "rawScore") : null,
    rawProbabilityDistribution: market.id === "a-share" && key !== "current" ? probabilitySummary(latest, "rawProbability") : null,
  };
}

function buildDiagnostics(rotation, artifact) {
  const aShare = (rotation.markets ?? []).find((market) => market.id === "a-share");
  return {
    schemaVersion: 2,
    generatedAt: rotation.generatedAt,
    policy: {
      immutableSnapshotLedger: "data/predictions/snapshots.jsonl.gz",
      pageReadsDiagnostics: false,
      unavailableValuesAreNull: true,
    },
    featureCoverage: aShare?.featureCoverage ?? null,
    marketBreadthSummary: aShare?.marketBreadthSummary ?? null,
    sourceStatus: aShare?.sourceStatus ?? null,
    warnings: aShare?.warnings ?? [],
    modelLineage: aShare?.modelLineage ?? null,
    entries: (rotation.markets ?? []).flatMap((market) => Object.entries(market.horizons ?? {})
      .map(([key, horizon]) => diagnosticEntry(rotation, artifact, market, key, horizon))),
  };
}

function main() {
  const rotationFile = contentPath("sector-rotation.json");
  const historyFile = contentPath("prediction-history.json");
  const artifactFile = path.join(root, "models", "sector-rotation", "a-share-relative-probability-v2.json");
  const rotation = normalizeRotation(readJson(rotationFile));
  const history = normalizeHistory(readJson(historyFile), rotation);
  const artifact = readJson(artifactFile);
  writeJson(rotationFile, rotation);
  writeJson(historyFile, history);
  writeJson(contentPath("prediction-diagnostics.json"), buildDiagnostics(rotation, artifact));
  console.log("prediction contract normalized: sector rotation, history, diagnostics");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { buildDiagnostics, normalizeHistory, normalizeRotation };
