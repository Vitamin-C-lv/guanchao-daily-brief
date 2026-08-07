import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import { validateLedger } from "./validate-prediction-ledger.mjs";

const fixtureRoot = join(import.meta.dirname, "fixtures", "prediction-ledger");
const repoRoot = join(import.meta.dirname, "..");
const index = JSON.parse(readFileSync(join(repoRoot, "public", "data", "prediction-history", "index.json"), "utf8"));
const shard = JSON.parse(readFileSync(join(repoRoot, "public", "data", "prediction-history", index.files[0].path), "utf8"));
const records = shard.records;
const explorerSource = readFileSync(join(repoRoot, "components", "PredictionHistoryExplorer.tsx"), "utf8");
const dashboardSource = readFileSync(join(repoRoot, "components", "Dashboard.tsx"), "utf8");

test("authoritative ledger, manifests, schemas, review and public shards agree", () => {
  const report = validateLedger();
  assert.equal(report.ok, true);
  assert.equal(report.predictionRecordCount, 408);
  assert.equal(report.evaluationEventCount, 300);
});

test("state-only snapshot identity schema accepts statePayloadSha256 and keeps old snapshots valid", () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, "schemas", "prediction-snapshot.schema.json"), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/u);
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T/u);
  ajv.addFormat("uri", /^https?:\/\//u);
  const validate = ajv.compile(schema);
  const state = {
    stateId: "state-hk-hsi-20260806-h1-hk-regularized-logistic-shadow-v1-aaaaaaaaaaaa",
    recordDate: "2026-08-06",
    market: "hk",
    objectId: "hsi",
    objectLabel: "恒生指数",
    horizonSessions: 1,
    target: "absolute_up",
    modelVersion: "hk-regularized-logistic-shadow-v1",
    modelAvailability: "trained",
    datasetId: "hk-panel-5a1325340d0c",
    datasetStatus: "partial",
    publicationStatus: "abstained",
    outputMode: "none",
    probability: null,
    expectedReturn: null,
    probabilitySource: "none",
    probabilityTarget: "none",
    calibrationStatus: "disabled",
    abstainReasons: ["未通过全部生产发布门槛"],
    statusReason: "模型已完成样本外研究，但未通过全部生产发布门槛，暂不发布概率。",
    asOf: "2026-08-06",
    dueDate: null,
    sourceUrls: ["https://www.hsi.com.hk/eng/indexes/all-indexes/hang-seng-index"],
    legacy: false,
  };
  const models = [{ market: "hk", modelVersion: "hk-regularized-logistic-shadow-v1", artifactSha256: null, availability: "trained" }];
  const identityWithState = {
    markets: ["hk"],
    dataAsOf: "2026-08-06",
    publicationEdition: "daily",
    publicationVersion: "2026-08-06T20:00:00+08:00",
    models,
    horizons: [1],
    predictionPayloadSha256: "0".repeat(64),
    statePayloadSha256: "1".repeat(64),
  };
  const document = {
    schemaVersion: 1,
    runId: "prun-20260806-aaaaaaaaaaaaaaaaaaaa",
    createdAt: "2026-08-06T20:00:00+08:00",
    dataAsOf: "2026-08-06",
    edition: "daily",
    codeCommit: "a".repeat(40),
    markets: ["hk"],
    models,
    predictions: [],
    states: [state],
    identity: identityWithState,
    integrity: {
      contractVersion: "prediction-ledger-v1",
      hashMode: {
        text: "utf8-canonical-lf-v1",
        binary: "raw-bytes-v1",
        gzip: "deterministic-gzip-v1",
        selfHashExclusion: "integrity-digests-zeroed-v1",
      },
      payloadSha256: "2".repeat(64),
      compressedSha256: "3".repeat(64),
    },
  };
  assert.equal(validate(document), true);
  const legacyDocument = {
    ...document,
    states: undefined,
    identity: { ...identityWithState, statePayloadSha256: undefined },
  };
  assert.equal(validate(legacyDocument), true);
});

test("public index exposes selectable months and complete-history policy", () => {
  assert.deepEqual(index.availableMonths, ["2026-07", "2026-08"]);
  assert.equal(index.policy.completeAuthorityExport, true);
  assert.equal(index.policy.recordLimit, null);
});

test("month selection resolves exactly one indexed shard", () => {
  const entry = index.files.find((item) => item.yearMonth === "2026-07");
  assert.equal(entry.path, "2026-07.json");
  assert.equal(shard.yearMonth, entry.yearMonth);
  assert.equal(shard.records.length, entry.recordCount);
});

test("combined market horizon status model target and lineage filters are satisfiable", () => {
  const filtered = records.filter((item) => item.market === "a-share" && item.horizonSessions === 1 && item.publicationStatus === "published" && item.modelVersion.includes("probability-v1") && item.probabilityTarget === "absolute_up" && item.legacy);
  assert.ok(filtered.length > 0);
});

test("legacy and current records remain explicitly separated", () => {
  assert.equal(records.filter((item) => item.legacy).length, shard.summary.legacyRecordCount);
  assert.equal(records.filter((item) => !item.legacy).length, shard.summary.currentRecordCount);
});

test("probability mode and evidence observation mode cannot be confused", () => {
  const probability = records.find((item) => item.publicationStatus === "published");
  const observation = records.find((item) => item.publicationStatus === "abstained");
  assert.equal(probability.outputMode, "probability");
  assert.equal(observation.outputMode, "evidence_observation");
  assert.equal(observation.topQuartileProbability, null);
  assert.equal(typeof observation.observationScore, "number");
});

test("abstention rendering includes reasons and non-probability wording", () => {
  assert.match(explorerSource, /未发布原因/u);
  assert.match(explorerSource, /观察分（不是概率）/u);
  assert.ok(records.some((item) => item.publicationStatus === "abstained" && item.abstainReasons.length));
});

test("pending records are rendered as pending instead of wrong", () => {
  assert.ok(records.some((item) => item.publicationStatus === "published" && item.evaluation == null));
  assert.match(explorerSource, /待验证/u);
});

test("data insufficient has a dedicated visible label", () => {
  assert.match(explorerSource, /评价数据不足/u);
  assert.doesNotMatch("评价数据不足", /判断错误/u);
});

test("insufficient weekly sample displays text instead of numeric zero", () => {
  const review = JSON.parse(readFileSync(join(repoRoot, "content", "prediction-review-latest.json"), "utf8"));
  assert.equal(review.metrics.brierSkill, null);
  assert.equal(review.metricReasons.brierSkill, "insufficient_sample");
  assert.match(explorerSource, /样本不足/u);
});

test("prediction page exposes the history route", () => {
  assert.match(dashboardSource, /href="\/predictions\/history"/u);
  assert.match(dashboardSource, /查看历史预测/u);
});

test("URL query state is restored and persisted", () => {
  assert.match(explorerSource, /new URLSearchParams\(window\.location\.search\)/u);
  assert.match(explorerSource, /window\.history\.replaceState/u);
});

test("mobile navigation remains exactly five items", () => {
  const source = readFileSync(join(repoRoot, "components", "MobileBottomNav.tsx"), "utf8");
  assert.equal((source.match(/\{ href:/gu) || []).length, 5);
  assert.doesNotMatch(source, /predictions\/history/u);
});

test("history route is a static app page without a server database", () => {
  const page = readFileSync(join(repoRoot, "app", "predictions", "history", "page.tsx"), "utf8");
  assert.match(page, /PredictionHistoryExplorer/u);
  assert.doesNotMatch(page, /readFile|database|dynamic\s*=/u);
});

test("missing shard has an explicit load failure state", () => {
  assert.match(explorerSource, /月份分片 HTTP/u);
  assert.match(explorerSource, /历史分片加载失败/u);
});

test("wrong public shard hash is rejected before display", () => {
  assert.match(explorerSource, /await sha256\(text\) !== entry!\.sha256/u);
  assert.match(explorerSource, /月份分片哈希校验失败/u);
});

test("weekly review is loaded from the indexed review artifact", () => {
  assert.ok(index.latestReview.path.startsWith("reviews/"));
  assert.match(explorerSource, /payload\.latestReview\.path/u);
  assert.match(explorerSource, /await sha256\(reviewText\) !== payload\.latestReview\.sha256/u);
  assert.match(explorerSource, /周报哈希校验失败/u);
});

test("missing probability never falls back to a 0 or 50 percent bar", () => {
  assert.match(explorerSource, /概率输出/u);
  assert.match(explorerSource, /未发布/u);
  assert.doesNotMatch(explorerSource, /\?\?\s*(0|50)/u);
});

test("public source links open safely in a new tab", () => {
  assert.match(explorerSource, /target="_blank" rel="noreferrer"/u);
});

test("history page only fetches the selected month shard", () => {
  assert.match(explorerSource, /index\.files\.find\(\(item\) => item\.yearMonth === filter\.month\)/u);
  assert.doesNotMatch(explorerSource, /Promise\.all\(index\.files/u);
});

test("public shard excludes internal commit, hashes, integrity and local paths", () => {
  const serialized = JSON.stringify(shard);
  for (const field of ["codeCommit", "sourceHashes", "integrity", "localPath"]) assert.equal(serialized.includes(`\"${field}\"`), false);
});

test("adversarial fixture catalog is complete and executable", () => {
  const fixtures = readdirSync(fixtureRoot).filter((name) => name.endsWith(".json")).sort();
  assert.ok(fixtures.length >= 20);
  const mutations = new Set();
  for (const name of fixtures) {
    const fixture = JSON.parse(readFileSync(join(fixtureRoot, name), "utf8"));
    assert.equal(fixture.fixtureVersion, 1);
    assert.match(fixture.mutation, /^[a-z0-9_]+$/u);
    assert.ok(fixture.expectedError.length > 4);
    assert.ok(fixture.description.length > 10);
    assert.equal(mutations.has(fixture.mutation), false, `duplicate mutation ${fixture.mutation}`);
    mutations.add(fixture.mutation);
  }
});
