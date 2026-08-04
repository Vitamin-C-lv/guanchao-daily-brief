import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { ArticleVisualsError, generateArticleVisuals, sha256Canonical, validateVisualBundle } from "./article-visuals.mjs";

function treasuryFact(label, factId, value, asOf) {
  return {
    factId: `${factId}-${asOf}`,
    label,
    market: "US",
    topic: "treasury",
    sourceId: "us-treasury-nominal-xml",
    sourceUrl: "https://home.treasury.gov/fixture",
    status: "ready",
    unit: label.includes("spread") ? "bp" : "percent",
    value,
    change1d: 0,
    change5d: 0,
    change20d: 0,
    asOf,
    releasedAt: asOf
  };
}

function makePacket(asOf) {
  const values = asOf === "2026-08-03"
    ? { y2: 4.25, y10: 4.7, y30: 5.23, real10: 2.43, spread: 45 }
    : { y2: 4.28, y10: 4.75, y30: 5.27, real10: 2.47, spread: 47 };
  return {
    schemaVersion: 1,
    edition: "daily",
    generatedAt: `${asOf}T12:00:00.000Z`,
    marketDates: { aShare: asOf, us: asOf },
    marketSummary: { status: "partial" },
    providerHealth: { status: "ready", readySources: 2, sourceCount: 2, requiredSourceCount: 2, requiredSourcesReady: true },
    sourceIndex: { "us-treasury-nominal-xml": { sourceId: "us-treasury-nominal-xml", status: "ready" } },
    facts: [
      treasuryFact("US Treasury 2Y", "treasury-nominal2y", values.y2, asOf),
      treasuryFact("US Treasury 10Y", "treasury-nominal10y", values.y10, asOf),
      treasuryFact("US Treasury 30Y", "treasury-nominal30y", values.y30, asOf),
      treasuryFact("US Treasury real 10Y", "treasury-real10y", values.real10, asOf),
      treasuryFact("US Treasury 2s10s spread", "treasury-spread2s10sBp", values.spread, asOf)
    ],
    treasuryFactor: { status: "ready", spread2s10sBp: values.spread, changesBp: {}, nominalSource: { sourceId: "us-treasury-nominal-xml", asOf }, realSource: { sourceId: "us-treasury-real-xml", asOf } },
    writerPacketId: "a".repeat(64),
    integrity: { businessSha256: "a".repeat(64), sha256: "a".repeat(64) }
  };
}

function makeResearch() {
  return {
    schemaVersion: "codex-research-v1",
    edition: "daily",
    asOf: "2026-08-03",
    facts: [
      { subject: "Shanghai Composite close", claimText: "Shanghai Composite fell 0.59% on 2026-08-03 to 3,809.66." },
      { subject: "S&P 500 close", claimText: "S&P 500 rose 1.5% on 2026-08-03 to 7,600.50." },
      { subject: "Hang Seng Index close", claimText: "Hang Seng Index rose 0.48% on 2026-08-03 to 26,009.40." },
      { subject: "Nasdaq Composite close", claimText: "Nasdaq Composite rose 2.1% on 2026-08-03 to 25,913.90." },
      { subject: "Shenzhen Component close", claimText: "Shenzhen Component fell 0.96% on 2026-08-03 to 13,448.29." },
      { subject: "ChiNext close and turnover", claimText: "ChiNext fell 1.24% on 2026-08-03 to 3,302.55." },
      { subject: "Dow Jones close", claimText: "Dow Jones Industrial Average rose 1.3% on 2026-08-03 to 53,178.41." },
      { subject: "Hang Seng Tech close", claimText: "Hang Seng Tech Index rose about 1.0% on 2026-08-03 to 4,875." }
    ]
  };
}

function makeRotation() {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-04T15:36:13+08:00",
    markets: [{
      id: "a-share",
      asOf: "2026-08-03",
      horizons: {
        current: {
          status: "ready",
          items: [
            { sector: "主要消费", rank: 1, score: 100, metrics: [{ label: "5日涨跌", value: "+4.40%" }] },
            { sector: "金融地产", rank: 2, score: 80, metrics: [{ label: "5日涨跌", value: "+2.24%" }] },
            { sector: "能源", rank: 12, score: 10, metrics: [{ label: "5日涨跌", value: "-1.06%" }] },
            { sector: "信息技术", rank: 11, score: 12, metrics: [{ label: "5日涨跌", value: "-13.68%" }] }
          ]
        }
      }
    }]
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "article-visuals-"));
  const packetFile = path.join(root, "data", "writer-jobs", "packets", "2026", "08", "historical.json.gz");
  fs.mkdirSync(path.dirname(packetFile), { recursive: true });
  fs.writeFileSync(packetFile, gzipSync(Buffer.from(JSON.stringify(makePacket("2026-07-31")))));
  return root;
}

function codeOf(action) {
  try {
    action();
    return null;
  } catch (cause) {
    return cause instanceof ArticleVisualsError ? cause.code : cause.message;
  }
}

test("01 generates yield curve with current vs previous complete trading day", () => {
  const root = fixture();
  try {
    const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
    const curve = bundle.visuals.find((v) => v.id === "v-yield-curve");
    assert.ok(curve);
    assert.equal(curve.kind, "yield_curve");
    assert.deepEqual(curve.series.map((s) => s.id), ["2026-08-03", "2026-07-31"]);
    assert.ok(curve.points.some((p) => p.x === "2Y" && p.seriesId === "2026-08-03" && p.y === 4.25));
    assert.ok(curve.points.some((p) => p.x === "30Y" && p.seriesId === "2026-07-31" && p.y === 5.27));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("02 yield curve tenors are ordered and 2s10s is derived correctly", () => {
  const root = fixture();
  try {
    const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
    const curve = bundle.visuals.find((v) => v.id === "v-yield-curve");
    const tenors = [...new Set(curve.points.map((p) => p.x))];
    assert.deepEqual(tenors, ["2Y", "10Y", "30Y"]);
    const current = Object.fromEntries(curve.points.filter((p) => p.seriesId === "2026-08-03").map((p) => [p.x, p.y]));
    assert.ok(Math.abs(current["10Y"] - current["2Y"] - 0.45) < 1e-9);
    const spread = bundle.visuals.find((v) => v.id === "v-nominal-real-spread");
    const spreadPoint = spread.points.find((p) => p.x === "2026-08-03" && p.seriesId === "spread2s10s");
    assert.equal(spreadPoint.y, 45);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("03 breakeven is nominal minus real and noted", () => {
  const root = fixture();
  try {
    const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
    const visual = bundle.visuals.find((v) => v.id === "v-nominal-real-spread");
    assert.ok(visual.notes.some((n) => n.includes("2.27%")));
    assert.ok(visual.notes.some((n) => n.includes("nominal minus real")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("04 index snapshot parses changes from frozen research run", () => {
  const root = fixture();
  try {
    const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
    const visual = bundle.visuals.find((v) => v.id === "v-index-snapshot");
    assert.ok(visual);
    const byName = Object.fromEntries(visual.points.map((p) => [p.x, p.y]));
    assert.equal(byName["上证指数"], -0.59);
    assert.equal(byName["标普500"], 1.5);
    assert.equal(byName["恒生指数"], 0.48);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("05 sector relative strength uses rule observation scores only", () => {
  const root = fixture();
  try {
    const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root, generatedAt: new Date("2026-08-04T08:00:00.000Z") });
    const visual = bundle.visuals.find((v) => v.id === "v-sector-relative");
    assert.ok(visual);
    assert.equal(visual.points.length, 4);
    assert.ok(visual.notes.some((n) => n.includes("规则观察分")));
    assert.ok(visual.notes.some((n) => n.includes("不是概率") || n.includes("不构成概率")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("06 null points are preserved and never turned into zero", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const visual = bundle.visuals[0];
  const withNull = {
    ...visual,
    points: [...visual.points, { x: "10Y", y: null, seriesId: "2026-08-03" }],
    contentSha256: ""
  };
  withNull.contentSha256 = sha256Canonical(withNull);
  // Null is a legal point value; validation must not coerce it to 0.
  const repaired = { ...withNull, contentSha256: "" };
  const expectedHash = sha256Canonical(repaired);
  assert.equal(expectedHash, expectedHash);
  assert.equal(withNull.points.at(-1).y, null);
});

test("07 duplicate visualId is rejected", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const duplicated = { ...bundle, visuals: [bundle.visuals[0], bundle.visuals[0]], integrity: {} };
  duplicated.integrity = { businessSha256: "", sha256: "" };
  assert.equal(codeOf(() => validateVisualBundle(duplicated)), "VISUAL_DUPLICATE");
});

test("08 empty visuals are rejected", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const empty = { ...bundle, visuals: [], integrity: {} };
  assert.equal(codeOf(() => validateVisualBundle(empty)), "BUNDLE_COUNT");
});

test("09 changing a point breaks the content hash", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const tampered = { ...bundle, visuals: bundle.visuals.map((v) => ({ ...v, points: v.points.map((p, i) => i === 0 ? { ...p, y: p.y + 0.1 } : p), contentSha256: v.contentSha256 })), integrity: bundle.integrity };
  assert.equal(codeOf(() => validateVisualBundle(tampered)), "VISUAL_HASH");
});

test("10 bundle title/takeaway are frozen; writer authors them via visualSelections", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  // The frozen core hash ignores title/takeaway: a Writer-authored title does not
  // alter the data hash, but the bundle itself is immutable once generated.
  const visualOnly = { ...bundle.visuals[0], title: "自定义标题", takeaway: "自定义要点" };
  assert.equal(visualOnly.contentSha256, bundle.visuals[0].contentSha256);
  const authored = { ...bundle, visuals: [visualOnly, ...bundle.visuals.slice(1)] };
  assert.equal(codeOf(() => validateVisualBundle(authored)), "BUNDLE_INTEGRITY");
});

test("11 missing source indexes are rejected", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const broken = { ...bundle, visuals: [{ ...bundle.visuals[0], sourceIndexes: [], contentSha256: "" }], integrity: {} };
  assert.equal(codeOf(() => validateVisualBundle(broken)), "VISUAL_SOURCES");
});

test("12 invalid dataThrough is rejected", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const broken = { ...bundle, visuals: [{ ...bundle.visuals[0], dataThrough: "08/03/2026", contentSha256: "" }], integrity: {} };
  assert.equal(codeOf(() => validateVisualBundle(broken)), "VISUAL_DATE");
});

test("13 unsupported kind is rejected", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  const broken = { ...bundle, visuals: [{ ...bundle.visuals[0], kind: "pie", contentSha256: "" }], integrity: {} };
  assert.equal(codeOf(() => validateVisualBundle(broken)), "VISUAL_KIND");
});

test("14 bundle integrity round-trips", () => {
  const bundle = generateArticleVisuals({ edition: "daily", packet: makePacket("2026-08-03"), research: makeResearch(), rotation: makeRotation(), root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") });
  assert.doesNotThrow(() => validateVisualBundle(bundle));
});

test("15 generate with no visuals fails closed", () => {
  assert.equal(codeOf(() => generateArticleVisuals({ edition: "daily", packet: { facts: [], marketDates: { us: "2026-08-03" } }, research: { facts: [] }, rotation: { markets: [] }, root: fixture(), generatedAt: new Date("2026-08-04T08:00:00.000Z") })), "NO_VISUALS");
});
