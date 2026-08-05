import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildRealGlobalMarketBrief } from "./global-market-brief-real-input.mjs";
import { projectGlobalMarketBriefPublicDto, writeGlobalMarketBrief } from "./global-market-brief-storage.mjs";

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
