import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

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
  assert.equal(report.predictionRecordCount, 366);
  assert.equal(report.evaluationEventCount, 300);
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
