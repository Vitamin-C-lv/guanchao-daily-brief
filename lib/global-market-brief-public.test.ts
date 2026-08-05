import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner needs the explicit TS extension.
import { decodeGlobalMarketBriefPublic, GLOBAL_PUBLIC_DTO_SCHEMA_VERSION, loadGlobalMarketBriefPublic } from "./global-market-brief-public.ts";

const fixturePath = path.resolve(process.cwd(), "scripts/fixtures/global-market-brief/valid-public-dto-v1.fixture.json");

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

test("public DTO decodes into the exact UI-safe field set", () => {
  const decoded = decodeGlobalMarketBriefPublic(fixture());
  assert.equal(decoded.schemaVersion, GLOBAL_PUBLIC_DTO_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(decoded.mainArticle).sort(), [
    "articleUrl",
    "conclusion",
    "dataAsOf",
    "dek",
    "logicChainSummary",
    "marketTags",
    "sourceCount",
    "title",
  ]);
  assert.equal(decoded.mainArticle.logicChainSummary.length, 2);
  assert.deepEqual(Object.keys(decoded.mainArticle.logicChainSummary[0]).sort(), ["evidenceStatus", "from", "relation", "to"]);
  assert.deepEqual(Object.keys(decoded.specialReports[0]).sort(), ["articleUrl", "conclusion", "marketTags", "title", "triggerType"]);
});

test("zero and two special reports remain valid public states", () => {
  const zero = fixture();
  zero.specialReports = [];
  assert.equal(decodeGlobalMarketBriefPublic(zero).specialReports.length, 0);

  const two = fixture();
  const first = clone((two.specialReports as Array<Record<string, unknown>>)[0]);
  (first as Record<string, unknown>).title = "第二个专项";
  (first as Record<string, unknown>).articleUrl = "/articles/special-second-2026-08-05/";
  (two.specialReports as Array<Record<string, unknown>>).push(first);
  assert.equal(decodeGlobalMarketBriefPublic(two).specialReports.length, 2);
});

test("forbidden provider, lineage, path, stack, raw research, runtime log and Skill fields are rejected", () => {
  for (const field of ["provider", "internalLineage", "gateFailures", "path", "internalPath", "stack", "rawResearchPayload", "runtimeLogs", "skill"]) {
    const invalid = fixture();
    (invalid.mainArticle as Record<string, unknown>)[field] = "internal";
    assert.throws(() => decodeGlobalMarketBriefPublic(invalid), /GLOBAL_MARKET_BRIEF_PUBLIC_INVALID/);
  }
});

test("missing DTO returns null so the current production page can remain the fallback", () => {
  assert.equal(loadGlobalMarketBriefPublic(path.join(process.cwd(), "content", "__missing-global-public-dto__.json")), null);
});
