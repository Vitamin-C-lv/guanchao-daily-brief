import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assessEditorialFreshness } from "./writer-jobs.mjs";
import { compareEditorialContent, enforceFreshEditionContent, editorialDigest } from "./editorial-freshness.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const previousGlobal = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content/global-market-briefs/2026-08-07.json"), "utf8"));

function legacyBody() {
  return {
    meta: {
      editionDate: "2026-08-07",
      generatedAt: "2026-08-07T12:00:00+08:00",
      dataThrough: "2026-08-06",
      title: "旧版标题",
      subtitle: "旧版副标题",
    },
    federalReserve: { countdownDays: 20 },
    visuals: [{ id: "frozen-visual", dataThrough: "2026-08-06" }],
    markets: [{ articles: [{ title: "旧文章", summary: "旧正文", detail: { lead: "旧导语", keyPoints: ["旧要点"], sections: [{ heading: "旧判断", body: "旧分析" }] } }] }],
  };
}

function withDate(value, editionDate) {
  const next = structuredClone(value);
  next.editionDate = editionDate;
  next.generatedAt = `${editionDate}T12:00:00.000Z`;
  return next;
}

test("A old body plus new edition date is rejected", () => {
  const candidate = withDate(previousGlobal, "2026-08-08");
  assert.throws(() => enforceFreshEditionContent(previousGlobal, candidate), (error) => error.code === "FRESH_EDITION_CONTENT_REQUIRED");
  assert.equal(editorialDigest(previousGlobal).digest, editorialDigest(candidate).digest);
});

test("B old body plus countdown-only change is rejected", () => {
  const previous = legacyBody();
  const candidate = structuredClone(previous);
  candidate.meta.editionDate = "2026-08-08";
  candidate.meta.generatedAt = "2026-08-08T12:00:00+08:00";
  candidate.federalReserve.countdownDays = 19;
  candidate.visuals[0].dataThrough = "2026-08-08";
  const comparison = compareEditorialContent(previous, candidate);
  assert.equal(comparison.contentChanged, false);
  assert.throws(() => enforceFreshEditionContent(previous, candidate), (error) => error.code === "FRESH_EDITION_CONTENT_REQUIRED");
});

test("C real editorial judgment and source change is accepted", () => {
  const candidate = withDate(previousGlobal, "2026-08-08");
  candidate.mainArticle.title = "新的跨市场判断";
  candidate.mainArticle.conclusion = "新的主结论明确指出验证条件。";
  candidate.sourceIndex = [...candidate.sourceIndex, {
    id: "new-source",
    title: "新增来源",
    publisher: "测试来源",
    url: "https://example.com/new-source",
    asOf: "2026-08-08",
  }];
  candidate.mainArticle.sourceIds = [...candidate.mainArticle.sourceIds, "new-source"].sort();
  const comparison = enforceFreshEditionContent(previousGlobal, candidate);
  assert.equal(comparison.contentChanged, true);
  assert.equal(comparison.newSourcesCount, 1);
  assert.ok(comparison.newJudgmentsCount >= 2);
});

test("D same-edition correction is allowed only when explicitly marked", () => {
  const candidate = withDate(previousGlobal, "2026-08-07");
  assert.throws(() => enforceFreshEditionContent(previousGlobal, candidate), (error) => error.code === "FRESH_EDITION_CONTENT_REQUIRED");
  assert.doesNotThrow(() => enforceFreshEditionContent(previousGlobal, candidate, { sameEdition: true, correction: true }));
});

test("history assessment separates new canonical creation from same-edition correction", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-editorial-freshness-"));
  try {
    const historyDirectory = path.join(root, "content/global-market-briefs");
    fs.mkdirSync(historyDirectory, { recursive: true });
    fs.writeFileSync(path.join(historyDirectory, "2026-08-07.json"), `${JSON.stringify(previousGlobal)}\n`);
    const fresh = withDate(previousGlobal, "2026-08-08");
    fresh.mainArticle.title = "真实新标题";
    assert.equal(assessEditorialFreshness(root, fresh).canonicalEditionCreated, true);
    const unchanged = withDate(previousGlobal, "2026-08-08");
    assert.throws(() => assessEditorialFreshness(root, unchanged), (error) => error.errorCode === "FRESH_EDITION_CONTENT_REQUIRED");
    fs.writeFileSync(path.join(historyDirectory, "2026-08-08.json"), `${JSON.stringify(fresh)}\n`);
    assert.throws(() => assessEditorialFreshness(root, unchanged), (error) => error.errorCode === "CORRECTION_MODE_REQUIRED");
    const corrected = structuredClone(fresh);
    corrected.mainArticle.title = "同版纠正后的标题";
    const correction = assessEditorialFreshness(root, corrected, { correction: true });
    assert.equal(correction.canonicalEditionCreated, false);
    assert.equal(correction.correction, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
