import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRealGlobalMarketBrief } from "./global-market-brief-real-input.mjs";
import { projectGlobalMarketBriefPublicDto, writeGlobalMarketBrief } from "./global-market-brief-storage.mjs";
import { sha256Canonical } from "./research-contract.mjs";
import { formatPacketFactStatement, validatePacketFactDirection } from "./writer-context.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [path.relative(directory, file).split(path.sep).join("/")];
  }).sort();
}

test("real frozen inputs build one coherent main article and no eligible special", () => {
  const result = buildRealGlobalMarketBrief({ root: repositoryRoot });
  assert.equal(result.brief.schemaVersion, "global-market-brief-v1");
  assert.equal(result.brief.dataAsOf, "2026-08-03");
  assert.equal(result.brief.editionDate, "2026-08-04");
  assert.equal(result.brief.specialReports.length, 0);
  assert.equal(result.brief.specialTriggerCandidates.length, 1);
  assert.equal(result.brief.specialTriggerCandidates[0].eligible, false);
  assert.equal(result.brief.mainArticle.crossMarketTransmission.length, 2);
  assert.equal(result.brief.mainArticle.watchItems.length, 4);
  assert.equal(result.brief.buildStatus, "partial");
  assert.equal(result.brief.mainArticle.analysisSections.length, 5);
  assert.equal(result.brief.sourceIndex.length, 7);
  assert.equal(new Set(result.brief.sourceIndex.map((source) => source.url)).size, 7);
  assert.equal(result.brief.sourceIndex.some((source) => source.id === "csi-constituents"), false);
  const fomcSource = result.brief.sourceIndex.find((source) => source.id === "fed-fomc-statement-2026-07-29");
  assert.deepEqual(fomcSource, {
    asOf: "2026-07-29",
    id: "fed-fomc-statement-2026-07-29",
    publisher: "Federal Reserve",
    title: "Federal Reserve issues FOMC statement",
    url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  });
  assert.equal(result.brief.sourceIndex.some((source) => source.url.includes("compliancealliance.com")), false);
  const packet = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content", "writer-packets", "daily-latest.json"), "utf8"));
  assert.equal(packet.sourceIndex["csi-constituents"].status, "unavailable");
});

test("negative Treasury change renders as a fall and frozen value/unit/change remain read-only", () => {
  const packet = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content", "writer-packets", "daily-latest.json"), "utf8"));
  const fact = packet.facts.find((item) => item.label === "US Treasury 10Y");
  assert.ok(fact);
  const before = structuredClone(fact);
  const statement = formatPacketFactStatement(fact);
  assert.match(statement, /4\.70%/);
  assert.match(statement, /回落5bp/);
  assert.doesNotMatch(statement, /上行|上升|走高|升至/);
  assert.deepEqual(fact, before);
  assert.throws(() => validatePacketFactDirection(fact, "美国10年期国债收益率为4.70%，较前一交易日上行5bp。"), (error) => error.code === "PACKET_DIRECTION_CONFLICT");

  const changed = structuredClone(fact);
  changed.value = 4.71;
  assert.notEqual(changed.value, before.value);
  changed.unit = "bp";
  assert.notEqual(changed.unit, before.unit);
  changed.change1d = 5;
  assert.notEqual(changed.change1d, before.change1d);
});

test("real input has no internal diagnostics in the article payload", () => {
  const { brief } = buildRealGlobalMarketBrief({ root: repositoryRoot });
  const forbidden = /provider|lineage|gateFailures|runtimeLog|rawResearch|contextId|writerPacketId|productionApply|localPath|stack/i;
  const scan = (value) => {
    if (Array.isArray(value)) return value.forEach(scan);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `forbidden field ${key}`);
      scan(child);
    }
  };
  scan(brief);
});

test("public DTO is a deterministic whitelist projection", () => {
  const { brief } = buildRealGlobalMarketBrief({ root: repositoryRoot });
  const dto = projectGlobalMarketBriefPublicDto(brief);
  assert.deepEqual(Object.keys(dto).sort(), ["dataAsOf", "mainArticle", "schemaVersion", "specialReports"]);
  assert.deepEqual(Object.keys(dto.mainArticle).sort(), ["articleUrl", "conclusion", "dataAsOf", "dek", "logicChain", "marketTags", "sourceCount", "title"]);
  assert.equal(dto.specialReports.length, 0);
  assert.equal(Object.hasOwn(dto.mainArticle, "sourceIndex"), false);
  assert.equal(Object.hasOwn(dto.mainArticle, "keyFacts"), false);
});

test("global storage dry-run, atomic write and exact rerun touch only two files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-storage-"));
  try {
    const { brief } = buildRealGlobalMarketBrief({ root: repositoryRoot });
    const before = filesBelow(root);
    const dry = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: true, write: false });
    assert.equal(dry.wrote, false);
    assert.deepEqual(filesBelow(root), before);
    const first = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true });
    assert.equal(first.wrote, true);
    assert.deepEqual(first.files.sort(), ["content/global-market-brief-public.json", "content/global-market-briefs/2026-08-04.json"]);
    const second = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true });
    assert.equal(second.noOp, true);
    assert.equal(second.wrote, false);
    assert.deepEqual(second.files, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("history business conflict and source scope fail closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-conflict-"));
  try {
    const { brief } = buildRealGlobalMarketBrief({ root: repositoryRoot });
    writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true });
    const changed = structuredClone(brief);
    changed.mainArticle.title = "业务内容冲突";
    assert.throws(() => writeGlobalMarketBrief({ rootDir: root, brief: changed, dryRun: true, write: false }), (error) => error.code === "GLOBAL_HISTORY_CONFLICT");
    const outOfScope = structuredClone(brief);
    outOfScope.mainArticle.sourceIds = [...outOfScope.mainArticle.sourceIds, "outside-source"];
    assert.throws(() => writeGlobalMarketBrief({ rootDir: root, brief: outOfScope, dryRun: true, write: false }), (error) => error.code === "GLOBAL_BRIEF_INVALID");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit replacement can migrate a legacy same-edition history only with its exact business hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-replace-"));
  try {
    const { brief } = buildRealGlobalMarketBrief({ root: repositoryRoot });
    const legacy = structuredClone(brief);
    delete legacy.mainArticle.analysisSections;
    const historyFile = path.join(root, "content", "global-market-briefs", "2026-08-04.json");
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const { generatedAt, ...legacyBusiness } = legacy;
    const expected = sha256Canonical(legacyBusiness);
    assert.throws(() => writeGlobalMarketBrief({ rootDir: root, brief, dryRun: true, write: false, replaceExisting: true, expectedExistingBusinessSha256: "0".repeat(64) }), (error) => error.code === "GLOBAL_HISTORY_REPLACE_CONFLICT");
    const dry = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: true, write: false, replaceExisting: true, expectedExistingBusinessSha256: expected });
    assert.equal(dry.replacement.existingValidated, false);
    const applied = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true, replaceExisting: true, expectedExistingBusinessSha256: expected });
    assert.deepEqual(applied.files.sort(), ["content/global-market-brief-public.json", "content/global-market-briefs/2026-08-04.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
