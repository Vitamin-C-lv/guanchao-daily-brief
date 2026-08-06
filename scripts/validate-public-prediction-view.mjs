#!/usr/bin/env node
/**
 * Validates public/data/predictions/current.json against the
 * public-prediction-view-v1 schema and the public leak boundary.
 * Runs before every page build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const moduleFile = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(moduleFile), "..");

const FORBIDDEN_FRAGMENTS = [
  "codeCommit", "integrity", "localPath", "sourceHashes", "researchOutput", "modelCards", "oosMetrics",
  "runResult", "rawSha256", "panelSha256", "sourceManifestSha256", "foldPredictions", "folds", "provider", "requestedAt",
  "trainingWindow", "featureMissingRates", "excludedAllNullFeatures", "evaluationRows", "trainingRows", "embargoSessions", "userName", "username",
  "skillDirectory", "writer", "manifest", "predictionLedger", "C:\\", "D:\\", "\\\\", "http://",
];

export function validatePublicPredictionView({ file = path.join(REPO_ROOT, "public", "data", "predictions", "current.json") } = {}) {
  if (!fs.existsSync(file)) throw new Error(`current.json missing: ${file}`);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "public-prediction-view-v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T/);
  const validate = ajv.compile(schema);
  if (!validate(payload)) {
    throw new Error(`current.json schema failed: ${JSON.stringify(validate.errors)}`);
  }
  const serialized = JSON.stringify(payload);
  const leaked = FORBIDDEN_FRAGMENTS.filter((fragment) => serialized.includes(fragment));
  if (leaked.length) throw new Error(`current.json leaks forbidden fields: ${leaked.join(", ")}`);
  let probabilityCount = 0;
  for (const market of payload.markets) {
    for (const object of market.objects) {
      for (const horizon of object.horizons) {
        if (horizon.probability !== null && horizon.probability !== undefined) {
          if (horizon.publicationStatus !== "published" || horizon.outputMode !== "probability") {
            throw new Error(`probability on non-published horizon: ${market.marketId}/${object.objectId}/${horizon.horizonSessions}`);
          }
          probabilityCount += 1;
        }
        if (horizon.outputMode === "probability" && horizon.publicationStatus !== "published") {
          throw new Error(`blocked horizon exposes probability output: ${market.marketId}/${object.objectId}/${horizon.horizonSessions}`);
        }
      }
    }
  }
  return {
    ok: true,
    schemaVersion: payload.schemaVersion,
    generatedAt: payload.generatedAt,
    asOf: payload.asOf,
    marketCount: payload.markets.length,
    probabilityCount,
    blockedProbabilityCount: 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fileArgument = process.argv.indexOf("--file");
  const file = fileArgument >= 0 && process.argv[fileArgument + 1]
    ? path.resolve(process.argv[fileArgument + 1])
    : path.join(REPO_ROOT, "public", "data", "predictions", "current.json");
  try {
    console.log(JSON.stringify(validatePublicPredictionView({ file }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
