import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { projectGlobalMarketBriefPublicDto, validateGlobalMarketBriefIndex, writeGlobalMarketBrief } from "./global-market-brief-storage.mjs";
import { sha256Canonical } from "./research-contract.mjs";
import { formatPacketFactStatement, validatePacketFactDirection } from "./writer-context.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(repositoryRoot, "scripts", "fixtures", "global-market-brief", "valid-global-market-brief-v1.fixture.json");

function frozenBrief() {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8"));
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : [path.relative(directory, file).split(path.sep).join("/")];
  }).sort();
}

test("frozen global fixture remains self-contained as current daily inputs advance", () => {
  const brief = frozenBrief();
  assert.equal(brief.schemaVersion, "global-market-brief-v1");
  assert.equal(brief.dataAsOf, "2026-08-04");
  assert.equal(brief.editionDate, "2026-08-05");
  assert.equal(brief.specialReports.length, 1);
  assert.equal(brief.mainArticle.crossMarketTransmission.length, 3);
  assert.equal(brief.mainArticle.analysisSections.length, 1);
  assert.equal(new Set(brief.sourceIndex.map((source) => source.url)).size, brief.sourceIndex.length);
});

test("Treasury fact direction follows its immutable sign", () => {
  const packet = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "content", "writer-packets", "daily-latest.json"), "utf8"));
  const fact = packet.facts.find((item) => item.label === "US Treasury 10Y");
  assert.ok(fact);
  const before = structuredClone(fact);
  const statement = formatPacketFactStatement(fact);
  assert.match(statement, new RegExp(String(fact.value).replace(".", "\\.")));
  assert.match(statement, fact.change1d < 0 ? /回落/ : fact.change1d > 0 ? /上行/ : /持平/);
  assert.deepEqual(fact, before);
  assert.throws(() => validatePacketFactDirection(fact, `美国10年期国债收益率较前一交易日${fact.change1d < 0 ? "上行" : "回落"}。`), (error) => error.code === "PACKET_DIRECTION_CONFLICT");

  const changed = structuredClone(fact);
  changed.value = 4.71;
  assert.notEqual(changed.value, before.value);
  changed.unit = "bp";
  assert.notEqual(changed.unit, before.unit);
  changed.change1d = 5;
  assert.notEqual(changed.change1d, before.change1d);
});

test("frozen article payload has no internal diagnostics", () => {
  const brief = frozenBrief();
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
  const brief = frozenBrief();
  const dto = projectGlobalMarketBriefPublicDto(brief);
  assert.deepEqual(Object.keys(dto).sort(), ["dataAsOf", "mainArticle", "schemaVersion", "specialReports"]);
  assert.deepEqual(Object.keys(dto.mainArticle).sort(), ["articleUrl", "conclusion", "dataAsOf", "dek", "logicChain", "marketTags", "sourceCount", "title"]);
  assert.equal(dto.specialReports.length, 1);
  assert.equal(Object.hasOwn(dto.mainArticle, "sourceIndex"), false);
  assert.equal(Object.hasOwn(dto.mainArticle, "keyFacts"), false);
});

test("global storage dry-run, atomic history/public/index write and exact rerun are idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-storage-"));
  try {
    const brief = frozenBrief();
    const before = filesBelow(root);
    const dry = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: true, write: false });
    assert.equal(dry.wrote, false);
    assert.deepEqual(filesBelow(root), before);
    const first = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true });
    assert.equal(first.wrote, true);
    assert.deepEqual(first.files.sort(), ["content/global-market-brief-index.json", "content/global-market-brief-public.json", "content/global-market-briefs/2026-08-05.json"]);
    const index = JSON.parse(fs.readFileSync(path.join(root, "content", "global-market-brief-index.json"), "utf8"));
    assert.equal(validateGlobalMarketBriefIndex(index), index);
    assert.equal(index.latestMainArticleId, brief.mainArticle.id);
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
    const brief = frozenBrief();
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

test("storage write failure rolls back history, public DTO, and archive index together", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-rollback-"));
  try {
    const brief = frozenBrief();
    assert.throws(() => writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true, failAt: 2 }), (error) => error.code === "GLOBAL_STORAGE_WRITE");
    assert.deepEqual(filesBelow(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a later canonical main becomes archive history without manual list maintenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-history-"));
  try {
    const brief = frozenBrief();
    writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true });
    const next = structuredClone(brief);
    next.editionDate = "2026-08-06";
    next.dataAsOf = "2026-08-05";
    next.generatedAt = "2026-08-06T12:00:00.000Z";
    next.mainArticle.id = "global-main-2026-08-06";
    next.mainArticle.slug = "global-main-2026-08-06";
    next.mainArticle.articleUrl = "/articles/global-main-2026-08-06/";
    next.specialReports = [];
    writeGlobalMarketBrief({ rootDir: root, brief: next, dryRun: false, write: true });
    const index = JSON.parse(fs.readFileSync(path.join(root, "content", "global-market-brief-index.json"), "utf8"));
    assert.equal(index.latestMainArticleId, "global-main-2026-08-06");
    assert.deepEqual(index.articles.filter((article) => article.kind === "global_main").map((article) => article.id), ["global-main-2026-08-06", brief.mainArticle.id]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit replacement can migrate a legacy same-edition history only with its exact business hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-global-replace-"));
  try {
    const brief = frozenBrief();
    const legacy = structuredClone(brief);
    delete legacy.mainArticle.analysisSections;
    const historyFile = path.join(root, "content", "global-market-briefs", "2026-08-05.json");
    fs.mkdirSync(path.dirname(historyFile), { recursive: true });
    fs.writeFileSync(historyFile, `${JSON.stringify(legacy)}\n`, "utf8");
    const { generatedAt, ...legacyBusiness } = legacy;
    const expected = sha256Canonical(legacyBusiness);
    assert.throws(() => writeGlobalMarketBrief({ rootDir: root, brief, dryRun: true, write: false, replaceExisting: true, expectedExistingBusinessSha256: "0".repeat(64) }), (error) => error.code === "GLOBAL_HISTORY_REPLACE_CONFLICT");
    const dry = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: true, write: false, replaceExisting: true, expectedExistingBusinessSha256: expected });
    assert.equal(dry.replacement.existingValidated, false);
    const applied = writeGlobalMarketBrief({ rootDir: root, brief, dryRun: false, write: true, replaceExisting: true, expectedExistingBusinessSha256: expected });
    assert.deepEqual(applied.files.sort(), ["content/global-market-brief-index.json", "content/global-market-brief-public.json", "content/global-market-briefs/2026-08-05.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
