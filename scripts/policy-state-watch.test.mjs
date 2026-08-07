import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { validatePolicyRegistry, validatePolicyWatchEvent } from "./policy-watch.mjs";
import { validateStateCapitalEvent, validateStateCapitalRegistry } from "./state-capital-watch.mjs";

test("policy watch validates authority, dates and implementation stage", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "policy-watch-sources.json"), "utf8"));
  assert.equal(validatePolicyRegistry(registry).valid, true);
  assert.doesNotThrow(() => validatePolicyWatchEvent({ eventId: "x", issuer: "国务院", authorityLevel: "central", documentType: "meeting_statement", publishedAt: "2026-08-07", effectiveAt: null, implementationStage: "meeting_statement", officialUrl: "https://www.gov.cn/", relatedThreadIds: ["t"] }, { registry }));
  assert.throws(() => validatePolicyWatchEvent({ eventId: "x", issuer: "国务院", authorityLevel: "central", documentType: "meeting_statement", publishedAt: "2026-08-07", effectiveAt: "2026-08-07", implementationStage: "implemented", officialUrl: "https://www.gov.cn/", relatedThreadIds: ["t"] }, { registry }), /POLICY_WATCH_INVALID/);
});

test("state capital watch distinguishes evidence kinds and excludes medical payment", () => {
  const registry = JSON.parse(fs.readFileSync(path.join(process.cwd(), "config", "state-capital-watch-sources.json"), "utf8"));
  assert.equal(validateStateCapitalRegistry(registry).valid, true);
  assert.doesNotThrow(() => validateStateCapitalEvent({ eventId: "x", subjectIds: ["broad-etf-flow"], evidenceKind: "market_inference", officialUrl: null, relatedThreadIds: ["t"] }));
  assert.throws(() => validateStateCapitalEvent({ eventId: "x", scope: ["国家医保局支付政策"], evidenceKind: "market_inference", officialUrl: null, relatedThreadIds: ["t"], note: "国家队买入" }), /STATE_CAPITAL_WATCH_INVALID/);
});
