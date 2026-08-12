import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPredictionReviewPacket } from "./build-market-packets.mjs";
import { predictionReviewRecords } from "./investment-strategy-contract.mjs";
import { resolveWeeklyPredictionReviewPacket } from "./codex-writer-prepare.mjs";
import { canonicalJson } from "./research-contract.mjs";
import { isSaturdayWeekly, isUsFridayCloseAllowed, shouldIncludeDailyEdition, weeklyRunGuard } from "./weekly-schedule.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const collectScript = path.join(root, "scripts", "collect-week-context.mjs");

function runContext(editionDate) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-weekly-context-"));
  try {
    fs.mkdirSync(path.join(repo, "content"), { recursive: true });
    fs.mkdirSync(path.join(repo, "data"), { recursive: true });
    fs.writeFileSync(path.join(repo, "content", "daily-brief.json"), `${JSON.stringify({ meta: { editionDate } })}\n`);
    const run = spawnSync(process.execPath, [collectScript, "--week-end", "2026-08-08"], { cwd: repo, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(fs.readFileSync(path.join(repo, "data", "weekly-context.json"), "utf8"));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

test("Saturday 10:00 is the weekly run boundary and Sunday is guarded", () => {
  assert.equal(isSaturdayWeekly("2026-08-08"), true);
  assert.deepEqual(weeklyRunGuard("2026-08-08"), { allowed: true, reason: null });
  assert.deepEqual(weeklyRunGuard("2026-08-09"), { allowed: false, reason: "SUNDAY_NO_REPORT" });
});

test("Saturday weekly does not require the Saturday 20:00 Daily edition", () => {
  assert.equal(shouldIncludeDailyEdition({ weekStart: "2026-08-03", weekEnd: "2026-08-08", editionDate: "2026-08-08" }), false);
  assert.equal(shouldIncludeDailyEdition({ weekStart: "2026-08-03", weekEnd: "2026-08-08", editionDate: "2026-08-07" }), true);
  assert.equal(runContext("2026-08-08").editionCount, 0);
  assert.equal(runContext("2026-08-07").editionCount, 1);
});

test("US Friday close is valid for a Saturday weekly but not a Friday weekly", () => {
  assert.equal(isUsFridayCloseAllowed({ weekEnd: "2026-08-08", sessionEnd: "2026-08-08" }), true);
  assert.equal(isUsFridayCloseAllowed({ weekEnd: "2026-08-07", sessionEnd: "2026-08-07" }), false);
});

test("weekly Review Packet resolver binds Friday, omits absent/future/fake packets", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "guanchao-weekly-review-"));
  try {
    const packetRoot = path.join(temp, "packets");
    const friday = buildPredictionReviewPacket({
      root,
      asOf: "2026-08-07",
      generatedAt: "2026-08-07T10:20:00.000Z",
      records: [{ prediction_id: "weekly-friday-review", prediction_date: "2026-08-07", market: "a-share", sector_id: "000986", horizon: 5, publication_status: "published", probability_target: "absolute_up", absolute_up_probability: 61, probability_unit: "percent" }],
    });
    const fridayFile = path.join(packetRoot, "2026-08-07", "PREDICTION_REVIEW_PACKET.json");
    fs.mkdirSync(path.dirname(fridayFile), { recursive: true });
    fs.writeFileSync(fridayFile, `${canonicalJson(friday)}\n`, "utf8");
    const paths = { eveningPacketsRoot: packetRoot, guanchaoHome: temp, repositoryPath: root };
    const resolved = resolveWeeklyPredictionReviewPacket({ root, editionDate: "2026-08-08", automationPaths: paths });
    assert.equal(resolved?.packet.packetId, friday.packetId);
    assert.equal(predictionReviewRecords(resolved.packet).records.has("weekly-friday-review"), true);

    const future = buildPredictionReviewPacket({ root, asOf: "2026-08-08", generatedAt: "2026-08-08T10:20:00.000Z", records: [] });
    const futureFile = path.join(packetRoot, "2026-08-08", "PREDICTION_REVIEW_PACKET.json");
    fs.mkdirSync(path.dirname(futureFile), { recursive: true });
    fs.writeFileSync(futureFile, `${canonicalJson(future)}\n`, "utf8");
    fs.rmSync(path.join(packetRoot, "2026-08-07"), { recursive: true, force: true });
    assert.equal(resolveWeeklyPredictionReviewPacket({ root, editionDate: "2026-08-08", automationPaths: paths }), null);

    const fakeFile = path.join(packetRoot, "2026-08-07", "PREDICTION_REVIEW_PACKET.json");
    fs.mkdirSync(path.dirname(fakeFile), { recursive: true });
    fs.writeFileSync(fakeFile, `${JSON.stringify({ schemaVersion: "weekly-no-evening-packet-v1", packetId: "weekly-fake", editionDate: "2026-08-08", status: "not-required" })}\n`, "utf8");
    fs.rmSync(futureFile, { force: true });
    assert.equal(resolveWeeklyPredictionReviewPacket({ root, editionDate: "2026-08-08", automationPaths: paths }), null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
