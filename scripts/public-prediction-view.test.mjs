import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { buildPublicPredictionView } from "./build-public-prediction-view.mjs";
import { isPublicPredictionView } from "../lib/public-prediction-view.ts";
import { validatePublicPredictionView } from "./validate-public-prediction-view.mjs";

const REPO = path.resolve(".");
const ROTATION = path.join(REPO, "content", "sector-rotation.json");
const HISTORY = path.join(REPO, "public", "data", "prediction-history", "index.json");
const FIXTURES = path.join(REPO, "scripts", "fixtures", "prediction-publication-gate");
const HISTORY_INDEX = JSON.parse(fs.readFileSync(HISTORY, "utf8"));

function schemaValidator() {
  const schema = JSON.parse(fs.readFileSync(path.join(REPO, "schemas", "public-prediction-view-v1.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T/);
  return ajv.compile(schema);
}

function tempOutput(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dto-${name}-`));
  return { dir, file: path.join(dir, "current.json") };
}

test("real A-share + blocked HK/US produces a valid public DTO without probabilities", () => {
  const { dir, file } = tempOutput("blocked");
  try {
    const report = buildPublicPredictionView({
      rotationPath: ROTATION,
      researchOutput: path.join(FIXTURES, "negative"),
      historyPath: HISTORY,
      outputPath: file,
      now: new Date("2026-08-06T00:00:00Z"),
    });
    assert.equal(report.shouldWrite, true);
    const view = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(schemaValidator()(view), true);
    assert.equal(isPublicPredictionView(view), true);
    assert.equal(view.markets.length, 3);
    const aShare = view.markets.find((market) => market.marketId === "a-share");
    assert.equal(aShare.objects[0].horizons.length, 3);
    for (const horizon of aShare.objects[0].horizons) {
      assert.equal(horizon.publicationStatus, "abstained");
      assert.equal(horizon.outputMode, "evidence_observation");
      assert.equal(horizon.probability, null);
      assert.ok(Array.isArray(horizon.observationItems) && horizon.observationItems.length === 12);
    }
    const hk = view.markets.find((market) => market.marketId === "hk");
    assert.deepEqual(hk.objects.map((object) => object.objectId), ["hsi", "hstech", "hk_innovative_drug", "hk_tech_internet"]);
    for (const object of hk.objects) {
      for (const horizon of object.horizons) {
        assert.equal(horizon.probability, null);
        assert.equal(horizon.expectedReturn, null);
        assert.equal(horizon.outputMode, "none");
      }
    }
    const us = view.markets.find((market) => market.marketId === "us");
    assert.equal(us.objects[0].objectId, "nasdaq_composite");
    for (const horizon of us.objects[0].horizons) {
      assert.equal(horizon.publicationStatus, "abstained");
      assert.equal(horizon.probability, null);
      assert.ok(horizon.statusReason.includes("门槛"));
    }
    assert.deepEqual(view.latestReview, HISTORY_INDEX.latestReview);
    assert.equal(us.sourceStatus.requiredSources.status, "ready");
    assert.ok(!us.sourceStatus.requiredSources.reason.includes("yahoo_hstech"));
    assert.ok(!us.sourceStatus.requiredSources.reason.includes("恒生科技"));
    assert.ok(hk.sourceStatus.requiredSources.reason.includes("必需历史数据源不可用"));
    for (const market of view.markets) {
      for (const object of market.objects) {
        assert.ok(["研究候选", "生产模型"].includes(object.candidateStatus), `candidateStatus ${object.candidateStatus}`);
        for (const horizon of object.horizons) {
          for (const forbidden of ["HK object panel", "OOS model trained", "candidate shadow"]) {
            assert.ok(!horizon.claim.includes(forbidden));
            assert.ok(!horizon.statusReason.includes(forbidden));
          }
        }
      }
    }
    const validated = validatePublicPredictionView({ file });
    assert.equal(validated.probabilityCount, 0);
    assert.equal(validated.blockedProbabilityCount, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("positive fixture proves the DTO can carry only gate-approved probabilities", () => {
  const { dir, file } = tempOutput("published");
  try {
    const report = buildPublicPredictionView({
      rotationPath: ROTATION,
      researchOutput: path.join(FIXTURES, "positive"),
      historyPath: HISTORY,
      outputPath: file,
      now: new Date("2026-08-06T00:00:00Z"),
    });
    assert.equal(report.shouldWrite, true);
    const view = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(schemaValidator()(view), true);
    let publishedCount = 0;
    for (const market of view.markets) {
      for (const object of market.objects) {
        for (const horizon of object.horizons) {
          if (horizon.publicationStatus === "published") {
            publishedCount += 1;
            assert.equal(horizon.outputMode, "probability");
            assert.equal(horizon.probability, 58.2);
            assert.notEqual(horizon.probability, 50);
          } else {
            assert.equal(horizon.probability, null);
          }
        }
      }
    }
    assert.equal(publishedCount, 6);
    const validated = validatePublicPredictionView({ file });
    assert.equal(validated.probabilityCount, 6);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("identical business bytes are a physical no-op", () => {
  const { dir, file } = tempOutput("noop");
  try {
    const first = buildPublicPredictionView({
      rotationPath: ROTATION,
      researchOutput: path.join(FIXTURES, "negative"),
      historyPath: HISTORY,
      outputPath: file,
      now: new Date("2026-08-06T00:00:00Z"),
    });
    const bytes = fs.readFileSync(file);
    const second = buildPublicPredictionView({
      rotationPath: ROTATION,
      researchOutput: path.join(FIXTURES, "negative"),
      historyPath: HISTORY,
      outputPath: file,
      now: new Date("2026-08-06T00:00:00Z"),
    });
    assert.equal(first.shouldWrite, true);
    assert.equal(second.shouldWrite, false);
    assert.deepEqual(fs.readFileSync(file), bytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("public DTO never leaks private research fields", () => {
  const { dir, file } = tempOutput("leak");
  try {
    buildPublicPredictionView({
      rotationPath: ROTATION,
      researchOutput: path.join(FIXTURES, "negative"),
      historyPath: HISTORY,
      outputPath: file,
      now: new Date("2026-08-06T00:00:00Z"),
    });
    const serialized = fs.readFileSync(file, "utf8");
    for (const forbidden of [
      "codeCommit", "integrity", "localPath", "sourceHashes", "researchOutput", "modelCards", "oosMetrics",
      "runResult", "rawSha256", "panelSha256", "sourceManifestSha256", "foldPredictions", "folds", "provider",
      "requestedAt", "trainingWindow", "featureMissingRates", "excludedAllNullFeatures", "evaluationRows",
      "trainingRows", "embargoSessions", "userName", "username", "skillDirectory", "manifest", "C:\\", "D:\\", "http://",
    ]) {
      assert.ok(!serialized.includes(forbidden), `DTO leaks ${forbidden}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime guard rejects a DTO with probability on a blocked horizon", () => {
  const { dir, file } = tempOutput("guard");
  try {
    buildPublicPredictionView({
      rotationPath: ROTATION,
      researchOutput: path.join(FIXTURES, "negative"),
      historyPath: HISTORY,
      outputPath: file,
      now: new Date("2026-08-06T00:00:00Z"),
    });
    const view = JSON.parse(fs.readFileSync(file, "utf8"));
    view.markets[1].objects[0].horizons[0].probability = 0.5;
    assert.equal(isPublicPredictionView(view), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("missing private research output fails closed", () => {
  const { dir, file } = tempOutput("missing");
  try {
    assert.throws(
      () => buildPublicPredictionView({
        rotationPath: ROTATION,
        researchOutput: path.join(os.tmpdir(), "does-not-exist-stage3"),
        historyPath: HISTORY,
        outputPath: file,
      }),
      (error) => error.code === "PRIVATE_OUTPUT_MISSING" || error.message.includes("PRIVATE_OUTPUT_MISSING"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
