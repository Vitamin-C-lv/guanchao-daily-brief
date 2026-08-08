import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertMarketDateContract, resolveMarketDateContract } from "./market-date-contract.mjs";

function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-date-contract-"));
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  }
  return root;
}

test("global brief authority is not blocked by stale legacy daily brief", () => {
  const root = fixture({
    "content/daily-brief.json": { markets: [{ id: "a-share", sessionDate: "2026-08-03" }] },
    "content/global-market-briefs/2026-08-07.json": { editionDate: "2026-08-07", dataAsOf: "2026-08-06", mainArticle: { marketTags: ["A_SHARE", "HK", "US"] } },
  });
  const contract = resolveMarketDateContract({ root, requestedDate: "2026-08-07" });
  assert.equal(contract.authority, "global-market-brief");
  assert.equal(contract.marketDates["a-share"], "2026-08-06");
});

test("authority cannot contain data later than its edition", () => {
  const root = fixture({ "content/global-market-briefs/2026-08-07.json": { editionDate: "2026-08-07", dataAsOf: "2026-08-08", mainArticle: { marketTags: ["US"] } } });
  const contract = resolveMarketDateContract({ root, requestedDate: "2026-08-07" });
  assert.equal(contract.authority, "unavailable");
  assert.throws(() => assertMarketDateContract(contract), /unavailable/);
});

test("legacy fallback still rejects invalid unavailable dates", () => {
  const root = fixture({ "content/daily-brief.json": { markets: [{ id: "us", sessionDate: "not-a-date" }] } });
  const contract = resolveMarketDateContract({ root });
  assert.equal(contract.authority, "unavailable");
  assert.throws(() => assertMarketDateContract(contract), /unavailable/);
});
