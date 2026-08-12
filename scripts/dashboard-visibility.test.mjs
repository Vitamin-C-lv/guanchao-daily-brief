import assert from "node:assert/strict";
import test from "node:test";

import { isGlobalBriefCurrentOrNewer } from "../lib/dashboard-visibility.ts";

test("canonical publication date, not data cutoff, arbitrates current selection", () => {
  assert.equal(isGlobalBriefCurrentOrNewer({ mainArticle: { articleUrl: "/articles/global-market-brief-2026-08-12/" }, dataAsOf: "2026-08-11" }, "2026-08-12"), true);
  assert.equal(isGlobalBriefCurrentOrNewer({ mainArticle: { articleUrl: "/articles/global-market-brief-2026-08-08/" }, dataAsOf: "2026-08-08" }, "2026-08-11"), false);
  assert.equal(isGlobalBriefCurrentOrNewer({ mainArticle: { articleUrl: "/articles/global-market-brief-2026-08-12/" }, dataAsOf: "2026-08-10" }, "2026-08-11"), true);
});
