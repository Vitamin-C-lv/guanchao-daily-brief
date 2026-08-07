import assert from "node:assert/strict";
import test from "node:test";
import { brierScore, buildPredictionReviewPacket, normalizePublishedProbability } from "./build-market-packets.mjs";

test("published percentages are normalized to fractions before Brier", () => {
  const first = normalizePublishedProbability({ prediction_id: "fixture-50", probability_target: "absolute_up", absolute_up_probability: 50 });
  const second = normalizePublishedProbability({ prediction_id: "fixture-25", probability_target: "absolute_up", absolute_up_probability: 25 });
  assert.equal(first.probability, 0.5);
  assert.equal(second.probability, 0.25);
  assert.equal(brierScore(first.probability, 1), 0.25);
  assert.equal(brierScore(second.probability, 0), 0.0625);
});

test("abstained observation keeps orthogonal statuses", () => {
  const packet = buildPredictionReviewPacket({
    root: process.cwd(),
    asOf: "2026-08-07",
    generatedAt: "2026-08-07T12:00:00.000Z",
    records: [{
      prediction_id: "fixture-abstained-observation",
      prediction_date: "2026-08-06",
      due_date: "2026-08-07",
      market: "a-share",
      horizon: 1,
      publication_status: "abstained",
      prediction_status: "model-abstained",
      result: "model-abstained",
      output_mode: "evidence_observation",
      observation_score: 72,
      realized_top_quartile: null,
    }],
  });
  const row = packet.horizons["1d"].rows[0];
  assert.equal(row.modelPublicationStatus, "abstained");
  assert.equal(row.observationStatus, "evidence_observation");
  assert.equal(packet.horizons["1d"].counts.abstained, 1);
  assert.equal(packet.horizons["1d"].counts.evidenceObservation, 1);
});

test("realized review rows are traceable or explicitly unavailable", () => {
  const packet = buildPredictionReviewPacket({ root: process.cwd(), asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" });
  for (const horizon of Object.values(packet.horizons)) {
    for (const row of horizon.rows) {
      assert.ok(["pending", "evaluated", "unavailable"].includes(row.evaluation.status));
      assert.deepEqual(row.sourceRecordIds, [row.predictionId]);
    }
  }
});
