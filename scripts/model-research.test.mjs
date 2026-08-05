import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import test from "node:test";

const contract = JSON.parse(readFileSync(new URL("../data/model-research/contract.json", import.meta.url), "utf8"));
const hkContract = JSON.parse(readFileSync(new URL("../data/model-research/hk-contract.json", import.meta.url), "utf8"));
const hkPublicUniverse = JSON.parse(readFileSync(new URL("../models/sector-rotation/hk-public-universe-v1.json", import.meta.url), "utf8"));
const hkTrainingUniverse = JSON.parse(readFileSync(new URL("../models/sector-rotation/hk-training-universe-v1.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const source = readFileSync(new URL("./model_research.py", import.meta.url), "utf8");
const attributes = readFileSync(new URL("../.gitattributes", import.meta.url), "utf8");

test("package exposes all model research commands", () => {
  for (const name of ["model-research:validate", "model-research:train", "model-research:evaluate", "model-research:shadow", "test:model-research"]) {
    assert.equal(typeof packageJson.scripts[name], "string");
  }
});

test("contract freezes all artifact schemas", () => {
  assert.deepEqual(Object.values(contract.artifactSchemas).sort(), [
    "model-candidate-v1",
    "model-evaluation-v1",
    "model-promotion-decision-v1",
    "model-training-run-v1",
    "shadow-inference-v1",
  ].sort());
});

test("HK research contract keeps public and training universes separate", () => {
  assert.equal(hkContract.market, "HK");
  assert.deepEqual(hkContract.horizons, [1, 5, 20]);
  assert.deepEqual(hkPublicUniverse.objects.map((item) => item.id), ["hsi", "hstech", "hk_innovative_drug", "hk_tech_internet"]);
  assert.equal(hkTrainingUniverse.officialIndustryCount, 12);
  assert.equal(hkContract.targets.theme.binary[0], "relative_outperformance_vs_hsi");
  assert.equal(hkContract.targets.theme.continuous[0], "expected_excess_vs_hsi");
  assert.equal(hkContract.targets.topQuartile.role, "research-only");
});

test("production capabilities remain disabled", () => {
  assert.ok(Object.values(contract.productionBoundary).every((value) => value === false));
});

test("training source has no network client imports", () => {
  assert.doesNotMatch(source, /^import (requests|urllib|httpx|socket)$/m);
  assert.match(source, /networkAccessDuringTraining/);
});

test("train CLI rejects omitted explicit paths", () => {
  const result = spawnSync(process.execPath, ["scripts/model-research.mjs", "train"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--dataset/);
});

test("shadow CLI rejects omitted explicit paths", () => {
  const result = spawnSync(process.execPath, ["scripts/model-research.mjs", "shadow"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--candidate/);
});

test("validate CLI succeeds without automatic dataset discovery", () => {
  const result = spawnSync(process.execPath, ["scripts/model-research.mjs", "validate"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"status": "valid"/);
});

test("validate CLI reports the HK candidate as shadow without applying it", () => {
  const result = spawnSync(process.execPath, ["scripts/model-research.mjs", "validate"], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /"candidateStatus": "shadow"/);
  assert.match(result.stdout, /"productionApply": \{/);
  assert.match(result.stdout, /"applied": false/);
});

test("check gate includes model research validation and tests", () => {
  assert.match(packageJson.scripts.check, /model-research:validate/);
  assert.match(packageJson.scripts.check, /test:model-research/);
});

test("candidate index is complete and sorted", () => {
  const index = JSON.parse(readFileSync(new URL("../models/sector-rotation/candidates/index.json", import.meta.url), "utf8"));
  assert.equal(index.candidates.length, 23);
  assert.deepEqual(index.candidates.map((item) => item.candidateId), [...index.candidates.map((item) => item.candidateId)].sort());
  assert.equal(index.activeCandidateId, null);
});

test("candidate index hashes bind committed artifacts", () => {
  const index = JSON.parse(readFileSync(new URL("../models/sector-rotation/candidates/index.json", import.meta.url), "utf8"));
  for (const entry of index.candidates) {
    const bytes = readFileSync(new URL(`../${entry.path}`, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
  }
});

test("shadow configuration cannot publish", () => {
  const shadow = JSON.parse(readFileSync(new URL("../models/sector-rotation/shadow-config.json", import.meta.url), "utf8"));
  assert.equal(shadow.active, false);
  assert.equal(shadow.publicationEnabled, false);
  assert.match(shadow.reason, /separate reviewed PR/);
});

test("model research and frozen production artifacts retain portable line endings", () => {
  assert.match(attributes, /^models\/sector-rotation\/candidates\/\*\*\/\*\.json text eol=lf$/m);
  assert.match(attributes, /^models\/sector-rotation\/shadow-config\.json text eol=lf$/m);
  assert.match(attributes, /^data\/model-research\/\*\*\/\*\.json text eol=lf$/m);
  assert.match(attributes, /^models\/sector-rotation\/a-share-v1\.json text eol=lf$/m);
  assert.match(attributes, /^models\/sector-rotation\/a-share-up-probability-v1\.json text eol=lf$/m);
  assert.match(attributes, /^models\/sector-rotation\/a-share-relative-probability-v2\.json text eol=crlf$/m);
});
