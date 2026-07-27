import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(root, relativePath), "utf8"));
const getAt = (value, segments) => segments.reduce((current, segment) => current[segment], value);
const clone = (value) => JSON.parse(JSON.stringify(value));

function runFixture(name) {
  const fixture = readJson(`scripts/fixtures/prediction-contract/${name}.fixture.json`);
  const source = fixture.validator === "rotation"
    ? readJson("content/sector-rotation.json")
    : readJson("content/market-observer.json");
  Object.assign(getAt(source, fixture.path), fixture.set);
  const directory = mkdtempSync(path.join(tmpdir(), "guanchao-p0-fixture-"));
  const file = path.join(directory, `${fixture.validator}.json`);
  writeFileSync(file, `${JSON.stringify(source, null, 2)}\n`);
  try {
    const script = fixture.validator === "rotation"
      ? "scripts/validate-sector-rotation.mjs"
      : "scripts/validate-market-observer.mjs";
    const result = spawnSync(process.execPath, [script, "--file", file], {
      cwd: root,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${name} must be rejected`);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(fixture.expected));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("A-share v2 is trained but abstained, with separated completeness measures", () => {
  const rotation = readJson("content/sector-rotation.json");
  for (const key of ["tomorrow", "oneWeek", "oneMonth"]) {
    const horizon = rotation.markets.find((market) => market.id === "a-share").horizons[key];
    assert.equal(horizon.modelAvailability, "trained");
    assert.equal(horizon.publicationStatus, "abstained");
    assert.equal(horizon.outputMode, "evidence_observation");
    assert.equal(horizon.probabilityTarget, "top_quartile");
    assert.equal(horizon.modelInputCompleteness, 1);
    assert.equal(horizon.productionFeatureCoverage, 0.5);
    assert.ok(horizon.gateFailures.length > 0);
  }
});

test("HK and US do not impersonate trained-but-abstained models", () => {
  const rotation = readJson("content/sector-rotation.json");
  const hk = rotation.markets.find((market) => market.id === "hk");
  const us = rotation.markets.find((market) => market.id === "us");
  for (const horizon of [hk.horizons.tomorrow, hk.horizons.oneWeek, hk.horizons.oneMonth]) {
    assert.equal(horizon.modelAvailability, "not_trained");
    assert.equal(horizon.publicationStatus, "not_applicable");
    assert.equal(horizon.probabilitySource, "none");
    assert.equal(horizon.calibrationStatus, "not_applicable");
  }
  for (const horizon of [us.horizons.tomorrow, us.horizons.oneWeek, us.horizons.oneMonth]) {
    assert.equal(horizon.modelAvailability, "not_implemented");
    assert.equal(horizon.outputMode, "current_observation");
    assert.equal(horizon.probabilitySource, "none");
  }
});

test("legacy absolute-up records retain values and expose lineage without cross-target fallback", () => {
  const history = readJson("content/prediction-history.json");
  const legacy = history.records.filter((record) => record.ranking_target === "absolute-up-legacy");
  const frozenNumbers = legacy.map((record) => [
    record.prediction_id,
    record.raw_score,
    record.raw_probability,
    record.calibrated_probability,
    record.absolute_up_probability,
    record.historical_base,
    record.effective_edge,
  ]);
  assert.equal(legacy.length, 36);
  assert.equal(createHash("sha256").update(JSON.stringify(frozenNumbers)).digest("hex"), "34d16c19f10274eb8f5307001e9e31bdb3d2acc799c7c059153ed79ea15c9b05");
  for (const record of legacy) {
    assert.equal(record.legacy, true);
    assert.equal(record.probability_target, "absolute_up");
    assert.equal(record.top_quartile_probability, null);
    assert.ok(["legacy_unknown", "historical_base_rate"].includes(record.probability_source));
  }
  const detailSource = readFileSync(path.join(root, "components/SectorPredictionDetail.tsx"), "utf8");
  assert.equal(detailSource.includes("if (finite(record.calibrated_probability)) return"), false);
});

test("history treats model availability and publication status as independent", () => {
  const history = readJson("content/prediction-history.json");
  const aV2 = history.records.filter((record) => record.model_version === "2026-07-21-relative-v2");
  const hk = history.records.filter((record) => record.market === "hk");
  assert.ok(aV2.every((record) => record.model_availability === "trained" && record.publication_status === "abstained"));
  assert.ok(hk.every((record) => record.model_availability === "not_trained" && record.publication_status === "not_applicable"));
  assert.ok(hk.every((record) => [record.raw_probability, record.calibrated_probability, record.top_quartile_probability, record.absolute_up_probability].every((value) => value === null)));
});

test("diagnostics are generated separately from page data", () => {
  const diagnostics = readJson("content/prediction-diagnostics.json");
  assert.ok(Array.isArray(diagnostics.entries));
  assert.equal(diagnostics.entries.length, 12);
  const hk = diagnostics.entries.find((entry) => entry.market === "hk" && entry.horizon === 1);
  const aShare = diagnostics.entries.find((entry) => entry.market === "a-share" && entry.horizon === 1);
  assert.equal(hk.rawProbabilityAvailable, false);
  assert.equal(hk.oosMetrics, null);
  assert.equal(aShare.modelInputCompleteness, 1);
  assert.equal(aShare.productionFeatureCoverage, 0.5);
});

test("observation-only preview uses observation wording, not a probability title", () => {
  const previewSource = readFileSync(path.join(root, "components/PredictionRankingPreview.tsx"), "utf8");
  assert.ok(previewSource.includes("先看板块观察榜"));
  assert.ok(previewSource.includes("证据分，不是概率"));
});

for (const fixture of [
  "released-before-asof",
  "updated-before-released",
  "source-end-before-asof",
  "source-index-mismatch",
]) {
  test(`rejects ${fixture} fixture`, () => runFixture(fixture));
}
