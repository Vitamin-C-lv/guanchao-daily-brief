import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildAllPackets, buildPredictionReviewPacket } from "./build-market-packets.mjs";
import { publishWriterResult, syncRuntimeToRemote } from "./content-publisher.mjs";
import { runGlobalMarketBriefDryRun } from "./writer-e2e-rehearsal.mjs";
import { sealWriterResult } from "./writer-jobs.mjs";
import { canonicalJson } from "./research-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true }).trim();
}

function configure(cwd) {
  git(cwd, ["config", "user.email", "publisher-e2e@example.invalid"]);
  git(cwd, ["config", "user.name", "Publisher E2E"]);
}

test("publisher git/runtime integration test writes, pushes, verifies and ff-only syncs", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-full-e2e-"));
  const remote = path.join(staging, "remote.git");
  const canonical = path.join(staging, "canonical");
  const runtime = path.join(staging, "runtime");
  const racer = path.join(staging, "racer");
  try {
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", windowsHide: true });
    execFileSync("git", ["clone", remote, canonical], { encoding: "utf8", windowsHide: true });
    configure(canonical);
    fs.mkdirSync(path.join(canonical, "content", "weekly-reports"), { recursive: true });
    fs.mkdirSync(path.join(canonical, "public"), { recursive: true });
    fs.writeFileSync(path.join(canonical, "README.md"), "publisher e2e\n");
    git(canonical, ["add", "README.md"]);
    git(canonical, ["commit", "-m", "init"]);
    git(canonical, ["branch", "-M", "main"]);
    git(canonical, ["push", "origin", "main"]);
    execFileSync("git", ["clone", remote, runtime], { encoding: "utf8", windowsHide: true });
    configure(runtime);
    fs.writeFileSync(path.join(canonical, "content", "weekly-reports", "weekly-2026-W99.json"), "{\"revision\":1}\n");
    fs.writeFileSync(path.join(canonical, "content", "weekly-reports", "index.json"), "{\"latestReportId\":\"weekly-2026-W99\"}\n");
    fs.writeFileSync(path.join(canonical, "public", "update-notices.json"), "{\"latest\":\"weekly-2026-W99\"}\n");
    git(canonical, ["add", "content/weekly-reports/weekly-2026-W99.json", "content/weekly-reports/index.json", "public/update-notices.json"]);
    git(canonical, ["commit", "-m", "publish: weekly 2026-08-08"]);
    const commitSha = git(canonical, ["rev-parse", "HEAD"]);
    git(canonical, ["push", "origin", "main"]);
    assert.equal(git(canonical, ["status", "--porcelain=v1"]), "");
    syncRuntimeToRemote({ runtimePath: runtime }, commitSha);
    assert.equal(git(runtime, ["rev-parse", "HEAD"]), commitSha);
    assert.equal(git(runtime, ["status", "--porcelain=v1"]), "");
    for (const file of ["content/weekly-reports/weekly-2026-W99.json", "content/weekly-reports/index.json", "public/update-notices.json"]) assert.equal(fs.existsSync(path.join(runtime, file)), true);
    syncRuntimeToRemote({ runtimePath: runtime }, commitSha);
    execFileSync("git", ["clone", "-b", "main", remote, racer], { encoding: "utf8", windowsHide: true });
    configure(racer);
    fs.writeFileSync(path.join(racer, "RACE.txt"), "remote advanced\n");
    git(racer, ["add", "RACE.txt"]);
    git(racer, ["commit", "-m", "remote advance"]);
    git(racer, ["push", "origin", "main"]);
    assert.throws(() => syncRuntimeToRemote({ runtimePath: runtime }, commitSha), (error) => error.code === "PUBLISHER_RUNTIME_REMOTE_MISMATCH");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

function strategyFor(payload) {
  const sourceId = payload.sourceIndex[0].id;
  return {
    schemaVersion: "investment-strategy-v1",
    asOf: payload.editionDate,
    title: "本期配置建议",
    summary: "本期模型与市场证据共同支持能源行业观察，保留风险边界。",
    allocationPreference: { preferredTargetIds: ["sector:a-share:000986"], underweightTargetIds: [] },
    modelContext: { status: "published", signalAvailable: true, horizonSessions: 5, sourcePredictionIds: ["publisher-e2e-prediction"] },
    signalOrigin: "model_plus_writer",
    overallStance: "risk_on",
    recommendations: [{
      market: "a-share", targetType: "sector_index_etf", targetId: "sector:a-share:000986", label: "能源 / 行业指数或ETF类别",
      action: "increase", direction: "bullish", conviction: 3, horizon: "1_5d",
      whyNow: "成交与价格表现支持能源行业观察。", modelEvidence: "模型信号与市场表现方向一致。", writerOverlay: "主笔维持有边界的行业配置判断。",
      supportingSourceIds: [sourceId], predictionIds: ["publisher-e2e-prediction"], trigger: "若成交继续改善，可逐步增加行业配置。", invalidation: "若价格与成交同步走弱，回到维持配置。", modelAgreement: "agree", overrideReason: null,
      modelSignal: { status: "published", predictionIds: ["publisher-e2e-prediction"], probability: 0.61, probabilityTarget: "absolute_up", probabilityUnit: "decimal_0_1", horizonSessions: 5, market: "a-share", predictionTargetId: "sector:a-share:000986" },
    }],
  };
}

function addPacketToGlobalPackage(directory, name, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  fs.writeFileSync(path.join(directory, name), bytes);
  const manifestFile = path.join(directory, "MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const hash = (buffer) => createHash("sha256").update(buffer).digest("hex");
  manifest.files = [...manifest.files.filter((entry) => entry.path !== name), { path: name, bytes: bytes.length, sha256: hash(bytes) }].sort((left, right) => left.path.localeCompare(right.path));
  const manifestBytes = Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
  fs.writeFileSync(manifestFile, manifestBytes);
  const names = [...manifest.files.map((entry) => entry.path), "MANIFEST.json"].sort();
  fs.writeFileSync(path.join(directory, "SHA256SUMS.txt"), `${names.map((item) => `${hash(item === "MANIFEST.json" ? manifestBytes : fs.readFileSync(path.join(directory, item)))}  ${item}`).join("\n")}\n`, "utf8");
}

test("publishWriterResult actual full E2E publishes a real strategy and is idempotent", () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "publisher-actual-e2e-"));
  const remote = path.join(staging, "remote.git");
  const rehearsalRoot = path.join(staging, "rehearsal");
  const runtime = path.join(staging, "runtime");
  try {
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8", windowsHide: true });
    const rehearsal = runGlobalMarketBriefDryRun({ outputDirectory: rehearsalRoot, sourceHead: git(repositoryRoot, ["rev-parse", "HEAD"]) });
    fs.mkdirSync(path.join(rehearsal.isolationRoot, "content"), { recursive: true });
    fs.copyFileSync(path.join(repositoryRoot, "content", "sector-details.json"), path.join(rehearsal.isolationRoot, "content", "sector-details.json"));
    const packets = buildAllPackets({ root: repositoryRoot, asOf: "2026-08-04", generatedAt: "2026-08-04T12:00:00.000Z" });
    const review = buildPredictionReviewPacket({ root: repositoryRoot, asOf: "2026-08-04", generatedAt: "2026-08-04T08:00:00.000Z", records: [{ prediction_id: "publisher-e2e-prediction", prediction_date: "2026-08-03", market: "a-share", sector_id: "000986", horizon: 5, publication_status: "published", probability_target: "absolute_up", absolute_up_probability: 61, probability_unit: "percent" }] });
    addPacketToGlobalPackage(rehearsal.executionPackage, "DAILY_MARKET_PACKET.json", packets.daily);
    addPacketToGlobalPackage(rehearsal.executionPackage, "PREDICTION_REVIEW_PACKET.json", review);

    const resultBefore = JSON.parse(fs.readFileSync(path.join(rehearsalRoot, "writer-result.json"), "utf8"));
    const payload = structuredClone(resultBefore.payload);
    payload.mainArticle.investmentStrategy = strategyFor(payload);
    const result = sealWriterResult({ ...resultBefore, payload, resultId: "", integrity: { businessSha256: "", sha256: "" } });
    fs.writeFileSync(path.join(rehearsalRoot, "writer-result.json"), `${canonicalJson(result)}\n`, "utf8");

    git(rehearsal.isolationRoot, ["init"]);
    configure(rehearsal.isolationRoot);
    git(rehearsal.isolationRoot, ["add", "."]);
    git(rehearsal.isolationRoot, ["commit", "-m", "fixture baseline"]);
    git(rehearsal.isolationRoot, ["branch", "-M", "main"]);
    git(rehearsal.isolationRoot, ["remote", "add", "origin", remote]);
    git(rehearsal.isolationRoot, ["push", "-u", "origin", "main"]);
    execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], { encoding: "utf8", windowsHide: true });
    execFileSync("git", ["clone", remote, runtime], { encoding: "utf8", windowsHide: true });
    configure(runtime);

    const automationPaths = { repositoryPath: rehearsal.isolationRoot, runtimePath: runtime, guanchaoHome: staging, eveningPacketsRoot: path.join(staging, "packets") };
    const receipt = publishWriterResult({ packageDirectory: rehearsal.executionPackage, resultFile: path.join(rehearsalRoot, "writer-result.json"), root: rehearsal.isolationRoot, production: true, automationPaths, productionRemote: remote });
    assert.equal(receipt.publicationStatus, "pushed");
    assert.equal(receipt.runtimeSyncStatus, "synced");
    assert.ok(["degraded", "writer_only"].includes(receipt.availabilityReceipt.publicationQuality));
    assert.ok(["partial", "missing"].includes(receipt.availabilityReceipt.reviewStatus));
    assert.equal(fs.existsSync(receipt.availabilityReceipt.path), true);
    const history = JSON.parse(fs.readFileSync(path.join(rehearsal.isolationRoot, "content", "global-market-briefs", `${payload.editionDate}.json`), "utf8"));
    const publicDto = JSON.parse(fs.readFileSync(path.join(rehearsal.isolationRoot, "content", "global-market-brief-public.json"), "utf8"));
    const index = JSON.parse(fs.readFileSync(path.join(rehearsal.isolationRoot, "content", "global-market-brief-index.json"), "utf8"));
    assert.equal(history.mainArticle.id, payload.mainArticle.id);
    assert.equal(publicDto.mainArticle.articleUrl, history.mainArticle.articleUrl);
    assert.ok(index.articles.some((article) => article.id === history.mainArticle.id));
    const pushedSha = git(rehearsal.isolationRoot, ["rev-parse", "HEAD"]);
    assert.equal(git(runtime, ["rev-parse", "HEAD"]), pushedSha);
    assert.equal(git(rehearsal.isolationRoot, ["ls-remote", "origin", "refs/heads/main"]).split(/\s+/u)[0], pushedSha);
    assert.equal(git(rehearsal.isolationRoot, ["status", "--porcelain=v1"]), "");
    assert.equal(git(runtime, ["status", "--porcelain=v1"]), "");
    assert.deepEqual(git(rehearsal.isolationRoot, ["show", "--format=", "--name-only", pushedSha]).split(/\r?\n/).filter(Boolean).sort(), ["content/global-market-brief-index.json", "content/global-market-brief-public.json", `content/global-market-briefs/${payload.editionDate}.json`].sort());

    const second = publishWriterResult({ packageDirectory: rehearsal.executionPackage, resultFile: path.join(rehearsalRoot, "writer-result.json"), root: rehearsal.isolationRoot, production: true, automationPaths, productionRemote: remote });
    assert.equal(second.publicationStatus, "no-op");
    assert.equal(second.idempotent, true);
    assert.equal(git(rehearsal.isolationRoot, ["rev-parse", "HEAD"]), pushedSha);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});
