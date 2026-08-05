import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  GlobalMarketBriefContractError,
  validateGlobalMarketBrief,
  validateGlobalMarketBriefPublicDto,
  validateGlobalMarketEvent,
} from "./global-market-brief-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(root, "scripts", "fixtures", "global-market-brief");

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, name), "utf8"));
}

function clone(value) {
  return structuredClone(value);
}

function tokens(pathName) {
  return pathName.replace(/\[([0-9]+)\]/g, ".$1").split(".").filter(Boolean);
}

function applyPathOperation(value, operation) {
  if (operation.type === "duplicateMainArticle") {
    value.mainArticle = [clone(value.mainArticle), clone(value.mainArticle)];
    return value;
  }
  if (operation.type === "repeatSpecialReports") {
    const first = clone(value.specialReports[0]);
    if (operation.count === 2) {
      first.id = "special-us-move-2026-08-05-second";
      first.slug = first.id;
      first.articleUrl = `/articles/${first.slug}/`;
    }
    value.specialReports = Array.from({ length: operation.count }, (_, index) => {
      if (index === 0) return clone(value.specialReports[0]);
      return clone(first);
    });
    return value;
  }
  const parts = tokens(operation.path);
  const last = parts.pop();
  let parent = value;
  for (const part of parts) parent = parent[part];
  if (operation.type === "delete") delete parent[last];
  else if (operation.type === "set") parent[last] = operation.value;
  else throw new Error(`unknown fixture operation ${operation.type}`);
  return value;
}

function validateExpectedFailure(value, fixture) {
  assert.throws(
    () => fixture.target === "public" ? validateGlobalMarketBriefPublicDto(value) : validateGlobalMarketBrief(value),
    (error) => {
      assert.ok(error instanceof GlobalMarketBriefContractError);
      assert.equal(error.code, fixture.expectedCode);
      assert.equal(error.path, fixture.expectedPath);
      assert.match(error.message, new RegExp(fixture.expectedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(error.articleId, "error must identify an article or DTO");
      assert.ok(error.reason, "error must include a failure reason");
      return true;
    },
  );
}

test("global-market-brief-v1 schema and valid fixture pass", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "global-market-brief-v1.schema.json"), "utf8"));
  assert.equal(schema.properties.mainArticle.$ref, "#/$defs/mainArticle");
  assert.equal(schema.properties.specialReports.maxItems, 2);
  const brief = readFixture("valid-global-market-brief-v1.fixture.json");
  assert.equal(validateGlobalMarketBrief(brief), brief);
});

test("negative fixtures cover the frozen article and writer boundaries", () => {
  const manifest = readFixture("negative-fixtures-v1.json");
  const base = readFixture(manifest.baseFixture);
  for (const fixture of manifest.cases) {
    const value = clone(fixture.target === "public" ? readFixture("valid-public-dto-v1.fixture.json") : base);
    applyPathOperation(value, fixture.operation);
    if (fixture.expectValid) {
      assert.equal(validateGlobalMarketBrief(value), value, fixture.id);
    } else {
      validateExpectedFailure(value, fixture);
    }
  }
});

test("zero and two special reports are both legal; no eligible trigger never becomes a report", () => {
  const base = readFixture("valid-global-market-brief-v1.fixture.json");
  const zero = clone(base);
  zero.specialReports = [];
  assert.equal(validateGlobalMarketBrief(zero), zero);

  const two = clone(base);
  const second = clone(two.specialReports[0]);
  second.id = "special-us-move-2026-08-05-second";
  second.slug = second.id;
  second.articleUrl = `/articles/${second.slug}/`;
  two.specialReports.push(second);
  assert.equal(validateGlobalMarketBrief(two), two);

  const ineligible = clone(base);
  ineligible.specialTriggerCandidates[0].eligible = false;
  assert.throws(() => validateGlobalMarketBrief(ineligible), /not marked eligible/);
});

test("public DTO exposes only future page fields and rejects internal diagnostics", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "global-market-brief-public-dto-v1.schema.json"), "utf8"));
  assert.equal(schema.properties.mainArticle.$ref, "#/$defs/mainArticleCard");
  const dto = readFixture("valid-public-dto-v1.fixture.json");
  assert.equal(validateGlobalMarketBriefPublicDto(dto), dto);
  const invalid = clone(dto);
  invalid.gateFailures = ["internal" ];
  assert.throws(() => validateGlobalMarketBriefPublicDto(invalid), /not public/);
});

test("structured event keeps the minimum event boundary without a storage system", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, "schemas", "global-market-event-v1.schema.json"), "utf8"));
  assert.deepEqual(schema.required, [
    "affectedAssets",
    "affectedThemes",
    "contradictorySourceIds",
    "direction",
    "eventType",
    "horizon",
    "marketConfirmation",
    "occurredAt",
    "region",
    "sourceConfidence",
    "status",
    "supportingSourceIds",
  ]);
  const event = readFixture("valid-event-v1.fixture.json");
  assert.equal(validateGlobalMarketEvent(event, { sourceIds: new Set(["us-session"]) }), event);
});
