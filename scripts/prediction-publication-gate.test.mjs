import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildLedgerStates, evaluatePublicationGate } from "./prediction-publication-gate.mjs";

const FIXTURES = path.resolve("scripts/fixtures/prediction-publication-gate");
const positive = path.join(FIXTURES, "positive");
const negative = path.join(FIXTURES, "negative");

function copyFixture(source, name) {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), `gate-${name}-`));
  for (const file of ["RUN_RESULT.json", "MODEL_CARDS.json", "OOS_METRICS.json"]) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  return target;
}

function allHorizons(results) {
  const entries = [];
  for (const market of Object.values(results.markets)) {
    for (const object of market.objects) {
      for (const horizon of object.horizons) entries.push({ market: market.marketId, object: object.objectId, horizon: horizon.horizonSessions });
    }
  }
  return entries;
}

function assertGateError(fn, code) {
  try {
    fn();
    assert.fail(`expected gate error ${code}`);
  } catch (cause) {
    assert.equal(cause.code, code);
  }
}

test("positive fixture proves the gate can publish when every threshold passes", () => {
  const results = evaluatePublicationGate({ researchOutput: positive, now: new Date("2026-08-06T00:00:00Z") });
  assert.equal(results.summary.evaluated, 15);
  assert.equal(results.summary.published, 6);
  assert.equal(results.summary.abstained, 0);
  assert.equal(results.summary.insufficient_data, 3);
  assert.equal(results.summary.unavailable, 6);
  assert.equal(results.summary.probabilitiesPublished, true);
  for (const { market, object, horizon } of allHorizons(results)) {
    const entry = results.markets[market].objects.find((item) => item.objectId === object).horizons.find((item) => item.horizonSessions === horizon);
    if (object === "hstech") {
      assert.equal(entry.publicationStatus, "insufficient_data");
      assert.equal(entry.outputMode, "none");
      assert.equal(entry.probability, null);
    } else if (object === "hk_innovative_drug" || object === "hk_tech_internet") {
      assert.equal(entry.publicationStatus, "unavailable");
      assert.equal(entry.outputMode, "none");
      assert.equal(entry.probability, null);
    } else {
      assert.equal(entry.publicationStatus, "published");
      assert.equal(entry.outputMode, "probability");
      assert.equal(entry.failedChecks.length, 0);
      assert.equal(entry.probability, 58.2);
      assert.notEqual(entry.probability, 50);
    }
  }
});

test("negative fixture reproduces the frozen stage2 expectation: all HK/US blocked", () => {
  const results = evaluatePublicationGate({ researchOutput: negative, now: new Date("2026-08-06T00:00:00Z") });
  assert.equal(results.summary.published, 0);
  assert.equal(results.summary.abstained, 6);
  assert.equal(results.summary.insufficient_data, 3);
  assert.equal(results.summary.unavailable, 6);
  assert.equal(results.summary.probabilitiesPublished, false);
  const expected = {
    "hk.hsi": "abstained",
    "hk.hstech": "insufficient_data",
    "hk.hk_innovative_drug": "unavailable",
    "hk.hk_tech_internet": "unavailable",
    "us.nasdaq_composite": "abstained",
  };
  for (const { market, object, horizon } of allHorizons(results)) {
    const entry = results.markets[market].objects.find((item) => item.objectId === object).horizons.find((item) => item.horizonSessions === horizon);
    assert.equal(entry.publicationStatus, expected[`${market}.${object}`], `${market}/${object}/${horizon}`);
    assert.equal(entry.outputMode, "none");
    assert.equal(entry.probability, null);
    assert.equal(entry.expectedReturn, null);
    assert.ok(entry.failedChecks.length > 0 || entry.publicationStatus !== "abstained", "blocked horizon must keep its gate evidence");
  }
});

test("market/object/horizon/target are isolated and never mixed", () => {
  const results = evaluatePublicationGate({ researchOutput: positive, now: new Date("2026-08-06T00:00:00Z") });
  const targetByObject = {
    hsi: "absolute_up",
    hstech: "absolute_up",
    hk_innovative_drug: "relative_outperformance_vs_hsi",
    hk_tech_internet: "relative_outperformance_vs_hsi",
    nasdaq_composite: "absolute_up",
  };
  for (const { market, object, horizon } of allHorizons(results)) {
    const entry = results.markets[market].objects.find((item) => item.objectId === object).horizons.find((item) => item.horizonSessions === horizon);
    assert.equal(entry.target, targetByObject[object]);
  }
  const hsi1 = results.markets.hk.objects.find((item) => item.objectId === "hsi").horizons.find((item) => item.horizonSessions === 1);
  const hsi5 = results.markets.hk.objects.find((item) => item.objectId === "hsi").horizons.find((item) => item.horizonSessions === 5);
  const nasdaq1 = results.markets.us.objects.find((item) => item.objectId === "nasdaq_composite").horizons.find((item) => item.horizonSessions === 1);
  assert.notDeepEqual(hsi1, hsi5);
  assert.notDeepEqual(hsi1, nasdaq1);
});

test("a single failing horizon changes only that horizon", () => {
  const root = copyFixture(positive, "isolation");
  try {
    const cardsPath = path.join(root, "MODEL_CARDS.json");
    const cards = JSON.parse(fs.readFileSync(cardsPath, "utf8"));
    const card = cards.cardData["HK_hsi_1"];
    card.calibrationStatus = "disabled";
    card.calibrationSlope = undefined;
    card.calibrationIntercept = undefined;
    card.leakageVerified = undefined;
    fs.writeFileSync(cardsPath, JSON.stringify(cards, null, 2) + "\n", "utf8");
    const results = evaluatePublicationGate({ researchOutput: root, now: new Date("2026-08-06T00:00:00Z") });
    const hsi1 = results.markets.hk.objects.find((item) => item.objectId === "hsi").horizons.find((item) => item.horizonSessions === 1);
    const hsi5 = results.markets.hk.objects.find((item) => item.objectId === "hsi").horizons.find((item) => item.horizonSessions === 5);
    const nasdaq20 = results.markets.us.objects.find((item) => item.objectId === "nasdaq_composite").horizons.find((item) => item.horizonSessions === 20);
    assert.equal(hsi1.publicationStatus, "abstained");
    assert.ok(hsi1.failedChecks.some((check) => check.startsWith("calibration_slope")));
    assert.equal(hsi5.publicationStatus, "published");
    assert.equal(nasdaq20.publicationStatus, "published");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no-50 rule: blocked horizons never carry a probability or default 50", () => {
  for (const fixture of [positive, negative]) {
    const results = evaluatePublicationGate({ researchOutput: fixture, now: new Date("2026-08-06T00:00:00Z") });
    for (const { market, object, horizon } of allHorizons(results)) {
      const entry = results.markets[market].objects.find((item) => item.objectId === object).horizons.find((item) => item.horizonSessions === horizon);
      if (entry.publicationStatus !== "published") {
        assert.equal(entry.probability, null);
        assert.equal(entry.probabilitySource, "none");
        assert.equal(entry.outputMode, "none");
      } else {
        assert.equal(typeof entry.probability, "number");
        assert.notEqual(entry.probability, 50);
      }
    }
  }
});

test("missing private research output fails closed", () => {
  assertGateError(() => evaluatePublicationGate({ researchOutput: path.join(os.tmpdir(), "does-not-exist-stage3") }), "PRIVATE_OUTPUT_MISSING");
});

test("invalid registry fails closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gate-registry-"));
  try {
    const registryPath = path.join(root, "bad-registry.json");
    fs.writeFileSync(registryPath, JSON.stringify({ schemaVersion: "wrong" }), "utf8");
    assertGateError(() => evaluatePublicationGate({ registryPath, researchOutput: positive }), "REGISTRY_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ledger states are deterministic, null-probability and private-free", () => {
  const results = evaluatePublicationGate({ researchOutput: negative, now: new Date("2026-08-06T00:00:00Z") });
  results.registry = JSON.parse(fs.readFileSync("data/model-research/prediction-publication-gates-v1.json", "utf8"));
  const states = buildLedgerStates(results);
  assert.equal(states.length, 15);
  const again = buildLedgerStates(results);
  assert.deepEqual(states, again);
  const serialized = JSON.stringify(states);
  for (const forbidden of ["C:\\", "D:\\", "rawSha256", "panelSha256", "provider", "requestedAt", "folds"]) {
    assert.ok(!serialized.includes(forbidden), `state leaks ${forbidden}`);
  }
  for (const state of states) {
    assert.equal(state.probability, null);
    assert.equal(state.expectedReturn, null);
    assert.equal(state.probabilitySource, "none");
    assert.equal(state.probabilityTarget, "none");
    assert.equal(state.legacy, false);
    assert.match(state.stateId, /^state-[a-z0-9_]+-[a-z0-9_]+-[0-9]{8}-h(1|5|20)-/);
  }
});
