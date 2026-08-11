import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { selectRelevantPolicyStateResearchTargets } from "./build-policy-state-research-targets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("selector sends only matched policy/state targets and never exceeds eight", () => {
  const selected = selectRelevantPolicyStateResearchTargets({ root, checkedAt: "2026-08-12", articleTopics: ["央行监管政策与ETF异常资金"], packet: { marketScopes: ["A_SHARE"] } });
  assert.ok(selected.selectedCount <= 8);
  assert.equal(selected.maximumCount, 8);
});

test("selector permits no policy/state target for an unrelated brief", () => {
  const selected = selectRelevantPolicyStateResearchTargets({ root, checkedAt: "2026-08-12", articleTopics: ["海外科技公司财报"], packet: { marketScopes: ["US"] } });
  assert.equal(selected.selectedCount, 0);
});
