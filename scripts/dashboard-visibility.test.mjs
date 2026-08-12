import assert from "node:assert/strict";
import test from "node:test";

import { isGlobalBriefCurrentOrNewer } from "../lib/dashboard-visibility.ts";

test("legacy daily edition remains current when canonical global data is older", () => {
  assert.equal(isGlobalBriefCurrentOrNewer({ dataAsOf: "2026-08-08" }, "2026-08-11"), false);
  assert.equal(isGlobalBriefCurrentOrNewer({ dataAsOf: "2026-08-12" }, "2026-08-11"), true);
});
