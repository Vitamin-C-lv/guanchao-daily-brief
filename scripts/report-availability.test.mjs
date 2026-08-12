import assert from "node:assert/strict";
import test from "node:test";

import {
  assessReportAvailability,
  buildDegradedWriterContext,
  buildDeterministicDailyFallback,
  buildDeterministicWeeklyFallback,
  buildReportAvailabilityReceipt,
  loadAvailabilityConfig,
  runWriterWithAvailability,
  strategyAvailability,
  validateAvailabilityConfig,
} from "./report-availability.mjs";

const validDaily = { status: "valid", editionDate: "2026-08-12", sourceHealth: { status: "partial" } };
const validReview = { status: "valid", asOfDate: "2026-08-12" };

test("availability config is long-lived and manual-disable-only", () => {
  const config = loadAvailabilityConfig();
  assert.deepEqual(config, { schemaVersion: "guanchao-report-availability-v1", enabled: true, mode: "availability_first", manualDisableOnly: true });
  assert.throws(() => validateAvailabilityConfig({ ...config, expiresAt: null }), (error) => error?.code === "AVAILABILITY_AUTO_EXPIRY_FORBIDDEN");
});

test("normal, degraded and writer_only modes preserve hard data boundaries", () => {
  assert.equal(assessReportAvailability({ editionDate: "2026-08-12", dailyPacket: validDaily, reviewPacket: validReview }).publicationQuality, "normal");
  const degraded = assessReportAvailability({ editionDate: "2026-08-12", dailyPacket: { ...validDaily, status: "partial" }, reviewPacket: validReview });
  assert.equal(degraded.publicationQuality, "degraded");
  const writerOnly = assessReportAvailability({ editionDate: "2026-08-12", dailyPacket: validDaily, reviewPacket: null });
  assert.equal(writerOnly.publicationQuality, "writer_only");
  assert.deepEqual(strategyAvailability("missing"), { mode: "writer_only", probabilityAllowed: false });
  const context = buildDegradedWriterContext({ editionDate: "2026-08-12", dailyPacket: null, reviewPacket: null, previousArticle: { id: "old", editionDate: "2026-08-11", title: "old" } });
  assert.equal(context.strategy.probability, null);
  assert.equal(context.previousArticle.asOf, "2026-08-11");
  assert.equal(context.latestMarketHistory.length, 0);
});

test("writer retries once then deterministic fallback", async () => {
  let attempts = 0;
  const result = await runWriterWithAvailability({ edition: "daily", writer: async () => { attempts += 1; throw new Error("writer unavailable"); }, fallback: async ({ attempts: count }) => buildDeterministicDailyFallback({ editionDate: "2026-08-12", reviewStatus: "missing", knownGaps: [`writer attempts=${count}`] }) });
  assert.equal(attempts, 2);
  assert.equal(result.fallbackRendererUsed, true);
  assert.equal(result.writerAttemptCount, 2);
  assert.equal(result.result.modelStatus.probability, null);
});

test("weekly fallback states that no model Review is publishable and Sunday has no report", () => {
  const weekly = buildDeterministicWeeklyFallback({ weekStart: "2026-08-03", weekEnd: "2026-08-08", reviewStatus: "missing" });
  assert.match(weekly.sections[4].text, /无可发布模型 Review/);
  const receipt = buildReportAvailabilityReceipt({ editionDate: "2026-08-08", reportType: "weekly", publicationQuality: "fallback", writerAttemptCount: 2, fallbackRendererUsed: true });
  assert.equal(receipt.schemaVersion, "report-availability-receipt-v1");
  assert.equal(assessReportAvailability({ editionDate: "2026-08-09", reportType: "weekly" }).publicationQuality, "no_report");
});
