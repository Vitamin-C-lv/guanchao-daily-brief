#!/usr/bin/env node
/**
 * Deterministic PublicPredictionView builder.
 *
 * Reads only:
 *   1. content/sector-rotation.json           -> A-share production state
 *   2. stage-2 private research outputs       -> HK/US gate results (via the gate)
 *   3. public/data/prediction-history/index.json -> history summary
 *
 * Writes public/data/predictions/current.json atomically.  Identical business
 * bytes (ignoring generatedAt) are a physical no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePublicationGate } from "./prediction-publication-gate.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

const HORIZON_KEYS = [
  ["tomorrow", 1, "下一交易日"],
  ["oneWeek", 5, "5个交易日"],
  ["oneMonth", 20, "20个交易日"],
];

const A_SHARE_OBJECT = {
  objectId: "a-share-sector-rotation",
  label: "A股核心行业与重点主题观察池（12项）",
  objectType: "sector-rotation",
  benchmarkLabel: "中证全指",
};

export class PublicPredictionViewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicPredictionViewError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new PublicPredictionViewError(code, message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("INPUT_MISSING", `${label} is missing or invalid: ${file}`);
  }
}

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === "object") {
    const copy = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "generatedAt") continue;
      copy[key] = stripTimestamps(item);
    }
    return copy;
  }
  return value;
}

function businessEquivalent(left, right) {
  try {
    return JSON.stringify(stripTimestamps(JSON.parse(left))) === JSON.stringify(stripTimestamps(JSON.parse(right)));
  } catch {
    return left === right;
  }
}

function aShareMarket(rotation) {
  const market = rotation.markets?.find((item) => item.id === "a-share");
  if (!market) fail("INPUT_MISSING", "sector-rotation.json has no a-share market");
  const object = { ...A_SHARE_OBJECT, modelAvailability: "trained", candidateStatus: "production" };
  const horizons = [];
  for (const [key, sessions, label] of HORIZON_KEYS) {
    const horizon = market.horizons?.[key];
    if (!horizon) fail("INPUT_MISSING", `a-share horizon missing: ${key}`);
    const availableMonths = [];
    const items = Array.isArray(horizon.observationItems) ? horizon.observationItems : [];
    horizons.push({
      horizonSessions: sessions,
      label,
      target: horizon.probabilityTarget ?? "top_quartile",
      modelVersion: horizon.modelVersion ?? null,
      publicationStatus: horizon.publicationStatus ?? "abstained",
      outputMode: horizon.outputMode ?? "none",
      probabilitySource: horizon.probabilitySource ?? "none",
      calibrationStatus: horizon.calibrationStatus ?? "not_applicable",
      probability: null,
      expectedReturn: null,
      evidenceScore: null,
      claim: String(horizon.note ?? "规则观察分，不是概率。"),
      statusReason: String(horizon.reason ?? "暂不发布概率。"),
      asOf: horizon.asOf ?? market.asOf ?? null,
      dueDate: horizon.dueDate ?? null,
      historyUrl: historyUrlFor("a-share", horizon.asOf ?? market.asOf, sessions, availableMonths),
      observationItems: items.map((item) => ({
        rank: item.rank,
        sector: item.sector,
        code: item.code ?? undefined,
        score: item.score,
        signal: item.signal,
        direction: item.direction ?? undefined,
      })),
    });
  }
  const sourceStatus = {};
  if (market.sourceStatus && typeof market.sourceStatus === "object") {
    for (const [name, entry] of Object.entries(market.sourceStatus)) {
      sourceStatus[name] = { status: String(entry?.status ?? "unknown"), reason: entry?.reason ? String(entry.reason) : undefined };
    }
  }
  return {
    marketId: "a-share",
    label: "A股",
    datasetStatus: market.status ?? "ready",
    dataAsOf: market.asOf ?? rotation.generatedAt?.slice(0, 10) ?? null,
    datasetId: market.modelLineage?.datasetId ?? null,
    sourceStatus,
    objects: [{ ...object, horizons }],
  };
}

function historyUrlFor(marketId, asOf, horizon, availableMonths) {
  const month = String(asOf ?? "").slice(0, 7);
  const effectiveMonth = availableMonths.length && availableMonths.includes(month) ? month : availableMonths.at(-1) ?? "";
  return `/predictions/history/?month=${effectiveMonth}&market=${marketId}&horizon=${horizon}`;
}

function gateMarketToDto(gateMarket, availableMonths) {
  return {
    marketId: gateMarket.marketId,
    label: gateMarket.label,
    datasetStatus: gateMarket.datasetStatus,
    dataAsOf: gateMarket.dataAsOf,
    datasetId: gateMarket.datasetId,
    sourceStatus: {
      requiredSources: {
        status: gateMarket.sourceStatus?.requiredFailures?.length ? "partial" : "ready",
        reason: gateMarket.sourceStatus?.requiredFailures?.length
          ? `required research sources unavailable: ${gateMarket.sourceStatus.requiredFailures.join(", ")}`
          : undefined,
      },
    },
    objects: gateMarket.objects.map((object) => ({
      objectId: object.objectId,
      label: object.label,
      objectType: object.objectType,
      benchmarkLabel: object.benchmarkLabel,
      modelAvailability: object.modelAvailability,
      candidateStatus: object.candidateStatus,
      horizons: object.horizons.map((horizon) => ({
        horizonSessions: horizon.horizonSessions,
        label: `${horizon.horizonSessions === 1 ? "下一交易日" : `${horizon.horizonSessions}个交易日`}`,
        target: horizon.target,
        modelVersion: horizon.modelVersion,
        publicationStatus: horizon.publicationStatus,
        outputMode: horizon.outputMode,
        probabilitySource: horizon.probabilitySource,
        calibrationStatus: horizon.calibrationStatus,
        probability: horizon.probability,
        expectedReturn: horizon.expectedReturn,
        evidenceScore: null,
        claim: horizon.statusReason,
        statusReason: horizon.statusReason,
        asOf: horizon.asOf,
        dueDate: horizon.dueDate,
        historyUrl: historyUrlFor(gateMarket.marketId, horizon.asOf, horizon.horizonSessions, availableMonths),
      })),
    })),
  };
}

export function buildPublicPredictionView({
  rotationPath = path.join(repositoryRoot, "content", "sector-rotation.json"),
  researchOutput = null,
  historyPath = path.join(repositoryRoot, "public", "data", "prediction-history", "index.json"),
  outputPath = path.join(repositoryRoot, "public", "data", "predictions", "current.json"),
  now = new Date(),
  registryPath = path.join(repositoryRoot, "data", "model-research", "prediction-publication-gates-v1.json"),
} = {}) {
  const rotation = readJson(rotationPath, "sector-rotation.json");
  const history = readJson(historyPath, "public history index");
  const availableMonths = Array.isArray(history.availableMonths) ? history.availableMonths : [];
  const gateResults = evaluatePublicationGate({ registryPath, researchOutput, rotationPath, now });
  const markets = [
    aShareMarket(rotation),
    gateMarketToDto(gateResults.markets.hk, availableMonths),
    gateMarketToDto(gateResults.markets.us, availableMonths),
  ];
  const view = {
    schemaVersion: "public-prediction-view-v1",
    contractVersion: "public-prediction-view-v1",
    generatedAt: now.toISOString(),
    asOf: markets[0].dataAsOf ?? now.toISOString().slice(0, 10),
    historyUrl: "/predictions/history/",
    latestReview: history.latestReview ?? null,
    markets,
  };
  const serialized = `${JSON.stringify(view, null, 2)}\n`;
  let shouldWrite = true;
  if (fs.existsSync(outputPath)) {
    shouldWrite = !businessEquivalent(fs.readFileSync(outputPath, "utf8"), serialized);
  }
  if (shouldWrite) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, serialized, "utf8");
    fs.renameSync(temporary, outputPath);
  }
  return { view, shouldWrite, outputPath };
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

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  const args = parseArgs(process.argv.slice(2));
  const researchOutput = args["research-output"] ? path.resolve(args["research-output"]) : process.env.GUANCHAO_STAGE2_RESEARCH_OUTPUT ?? null;
  const report = buildPublicPredictionView({
    rotationPath: args.rotation ? path.resolve(args.rotation) : path.join(repositoryRoot, "content", "sector-rotation.json"),
    researchOutput,
    historyPath: args.history ? path.resolve(args.history) : path.join(repositoryRoot, "public", "data", "prediction-history", "index.json"),
    outputPath: args.output ? path.resolve(args.output) : path.join(repositoryRoot, "public", "data", "predictions", "current.json"),
    now: args.now ? new Date(args.now) : new Date(),
  });
  console.log(JSON.stringify({ schemaVersion: "public-prediction-view-build-report-v1", shouldWrite: report.shouldWrite, outputPath: report.outputPath }, null, 2));
}
