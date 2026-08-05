import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { canonicalJson, sha256Canonical } from "./research-contract.mjs";
import { prepareWriterContext } from "./writer-context.mjs";
import { apply, createWriterJobPaths, exportWriterJob, prepare, sealWriterResult, validateResult } from "./writer-jobs.mjs";
import { lintEditorial } from "./editorial-lint.mjs";
import { GLOBAL_MARKET_BRIEF_MODE } from "./writer-context.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const ALLOWED_COMMANDS = new Set(["run", "write-result", "finalize"]);
const AS_OF = { daily: "2026-07-24", weekly: "2026-07-17" };

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function atomicWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeJson(file, value) {
  atomicWrite(file, jsonBytes(value));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--") continue;
    if (!values[index].startsWith("--")) fail(`unknown positional argument: ${values[index]}`);
    const key = values[index].slice(2);
    if (!key || Object.hasOwn(result, key)) fail(`invalid or duplicate option: ${key}`);
    result[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return result;
}

function outsideRepository(output) {
  if (!path.isAbsolute(output)) fail("output must be absolute");
  const relation = path.relative(repositoryRoot, path.resolve(output));
  if (!relation || (!relation.startsWith("..") && !path.isAbsolute(relation))) fail("output must be outside repository");
  return path.resolve(output);
}

function packetIdentity(value) {
  if (Array.isArray(value)) return value.map(packetIdentity);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !new Set(["requestedAt", "completedAt", "generatedAt", "rawSha256", "integrity", "businessIntegrity", "writerPacketId", "runId"]).has(key)).map(([key, item]) => [key, packetIdentity(item)]));
  return value;
}

function makePacket(edition, asOf) {
  const packet = {
    schemaVersion: 1,
    edition,
    generatedAt: `${asOf}T12:00:00.000Z`,
    marketDates: { aShare: asOf, us: asOf },
    marketSummary: { status: "partial" },
    providerHealth: { status: "ready" },
    sourceIndex: { "us-treasury-nominal-xml": { sourceId: "us-treasury-nominal-xml", status: "ready" } },
    facts: [{
      factId: `treasury-nominal2y-${asOf}`,
      label: "US Treasury 2Y",
      market: "US",
      topic: "treasury",
      sourceId: "us-treasury-nominal-xml",
      sourceUrl: "https://home.treasury.gov/controlled-e2e-fixture",
      status: "ready",
      unit: "percent",
      value: 4.26,
      changeUnit: "bp",
      change1d: -1,
      change5d: 2,
      change20d: 3,
      asOf,
      releasedAt: asOf
    }],
    treasuryFactor: {
      status: "ready",
      spread2s10sBp: 35,
      changesBp: {},
      nominalSource: { sourceId: "us-treasury-nominal-xml", asOf },
      realSource: { sourceId: "us-treasury-real-xml", asOf }
    },
    warnings: ["controlled-e2e-fixture"],
    writerPacketId: "",
    integrity: { businessSha256: "", sha256: "" }
  };
  const businessHash = sha256Canonical(packetIdentity(packet));
  packet.writerPacketId = businessHash;
  packet.integrity = { businessSha256: businessHash, sha256: businessHash };
  return packet;
}

function writePacketArtifact(packet, rootDir, asOf) {
  const relativePath = `data/writer-jobs/packets/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${packet.writerPacketId}.json.gz`;
  const file = path.join(rootDir, ...relativePath.split("/"));
  const bytes = gzipSync(Buffer.from(canonicalJson(packet), "utf8"), { mtime: 0 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && Buffer.compare(fs.readFileSync(file), bytes) !== 0) fail("immutable packet conflict");
  if (!fs.existsSync(file)) atomicWrite(file, bytes);
  return relativePath;
}

function controlledCatalog() {
  return import("./research-pipeline.mjs").then(({ loadResearchSourceCatalog }) => {
    const catalog = loadResearchSourceCatalog();
    return { ...catalog, sources: catalog.sources.filter((source) => source.sourceId === "fed-press-all-rss") };
  });
}

async function generateResearchBundle(edition, asOf) {
  const { runResearchPipeline } = await import("./research-pipeline.mjs");
  const fixture = fs.readFileSync(path.join(repositoryRoot, "scripts", "fixtures", "research-pipeline", "fed-rss.xml"));
  const response = () => new Response(fixture, { status: 200, headers: { "content-type": "application/rss+xml" } });
  const summary = await runResearchPipeline({ edition, asOf, write: true, dryRun: false, root: repositoryRoot, catalog: await controlledCatalog(), fetchImpl: async () => response(), now: new Date(`${asOf}T12:00:00.000Z`) });
  return { summary, relativePath: `data/research-bundles/bundles/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${summary.bundleId}.json.gz` };
}

function filesRecursively(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesRecursively(target) : [target];
  });
}

function sensitiveSnapshot() {
  const entries = [];
  for (const file of filesRecursively(repositoryRoot)) {
    const relativePath = path.relative(repositoryRoot, file).split(path.sep).join("/");
    const lower = relativePath.toLowerCase();
    if (lower.startsWith("node_modules/") || lower.startsWith(".next/")) continue;
    if (!/(^|\/|[-_.])(model|prediction|ledger)([-_.\/]|$)/i.test(relativePath)) continue;
    const bytes = fs.readFileSync(file);
    entries.push({ path: relativePath, bytes: bytes.length, sha256: sha256(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { fileCount: entries.length, aggregateSha256: sha256(Buffer.from(canonicalJson(entries), "utf8")), entries };
}

function operationLog(operation, startedAt, endedAt, extra = {}) {
  return { schemaVersion: "writer-e2e-operation-log-v1", operation, startedAt, endedAt, ...extra };
}

function productionBoundarySnapshot() {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repositoryRoot, encoding: "utf8" });
  const contentFile = path.join(repositoryRoot, "content", "daily-brief.json");
  return {
    gitStatus: status.stdout ?? "",
    dailyBriefSha256: fs.existsSync(contentFile) ? sha256(fs.readFileSync(contentFile)) : null
  };
}

function copyIntoIsolatedRoot(relativePath, isolatedRoot) {
  const source = path.join(repositoryRoot, ...relativePath.split("/"));
  const target = path.join(isolatedRoot, ...relativePath.split("/"));
  if (!fs.existsSync(source)) fail(`required global dry-run input is missing: ${relativePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function globalInputFiles() {
  const packetPath = "data/writer-jobs/packets/2026/08/b2d544c8fc01b1dae46ee0fe42a0215c43beb7ef2121555e67bd4883d838b752.json.gz";
  const bundlePath = "data/research-bundles/bundles/2026/08/4c06451a13ac33985c4f8058247d3342e646608ba4cd2df62e4829157759c1d7.json.gz";
  return {
    packetPath,
    bundlePath,
    baselinePath: "content/writer-contexts/fixtures/p2-b1-global-baseline.json",
    seedPath: "content/writer-contexts/fixtures/p2-b1-global-writer-two-special.json",
    resultPath: "content/writer-contexts/fixtures/p2-b1-global-writer-two-special.json"
  };
}

export function runGlobalMarketBriefDryRun({ outputDirectory, sourceHead }) {
  if (typeof sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(sourceHead)) fail("sourceHead must be a full Git commit");
  const output = outsideRepository(outputDirectory);
  fs.mkdirSync(output, { recursive: true });
  if (fs.readdirSync(output).length) fail("global dry-run output directory must be empty");
  const before = productionBoundarySnapshot();
  const isolatedRoot = path.join(output, "isolated-root");
  const files = [
    "data/writer-contexts/contract.json",
    "data/research-bundles/contract.json",
    "data/writer-jobs/contract.json",
    "prompts/luna-daily-brief.md",
    "schemas/global-market-brief-v1.schema.json",
    "schemas/global-market-brief-writer-output-v1.schema.json",
    "scripts/editorial-lint.mjs",
    "scripts/global-market-brief-contract.mjs",
    "scripts/research-contract.mjs",
    "scripts/validate-brief.mjs",
    "scripts/validate-writer-packet.mjs",
    "scripts/writer-context.mjs",
    "scripts/writer-jobs.mjs",
    "content/writer-contexts/fixtures/p2-b1-global-baseline.json",
    "content/writer-contexts/fixtures/p2-b1-global-writer-two-special.json",
    globalInputFiles().packetPath,
    globalInputFiles().bundlePath
  ];
  for (const file of files) copyIntoIsolatedRoot(file, isolatedRoot);
  const input = globalInputFiles();
  const contextSummary = prepareWriterContext({
    edition: "daily",
    asOf: "2026-08-03",
    writerPacketPath: input.packetPath,
    researchBundlePath: input.bundlePath,
    baselineSource: input.baselinePath,
    mode: GLOBAL_MARKET_BRIEF_MODE,
    globalInputPath: input.seedPath,
    write: true,
    root: isolatedRoot,
    now: new Date("2026-08-04T04:30:00.000Z"),
    warnings: []
  });
  const job = prepare({ mode: GLOBAL_MARKET_BRIEF_MODE, edition: "daily", contextPath: contextSummary.contextPath, write: true, rootDir: isolatedRoot, createdAt: "2026-08-04T04:40:00.000Z" });
  const packageDirectory = path.join(output, "execution-package");
  exportWriterJob({ request: job.request, outputDirectory: packageDirectory, rootDir: isolatedRoot });
  const payload = readJson(path.join(repositoryRoot, ...input.resultPath.split("/")));
  const result = sealWriterResult({
    schemaVersion: "writer-result-v2",
    mode: GLOBAL_MARKET_BRIEF_MODE,
    jobId: job.request.jobId,
    requestId: job.request.requestId,
    contextId: job.request.context.contextId,
    generatedAt: "2026-08-04T05:00:00.000Z",
    writerEngine: "luna-max-dry-run-fixture",
    writerVersion: "gpt-5.6-luna-max",
    payload,
    claimBindings: { global: [], quantitative: [], qualitative: [], sourceMetadata: [] },
    warnings: [],
    resultId: "",
    integrity: { businessSha256: "", sha256: "" }
  });
  const resultFile = path.join(output, "writer-result.json");
  writeJson(resultFile, result);
  validateResult(isolatedRoot, job.request, result);
  const editorialLint = lintEditorial({ mode: GLOBAL_MARKET_BRIEF_MODE, value: result.payload, result });
  if (!editorialLint.passed) fail(`global editorial lint failed: ${editorialLint.errors.join("; ")}`);
  const dryRunApply = apply({ request: job.request, result, dryRun: true, write: false, rootDir: isolatedRoot });
  const after = productionBoundarySnapshot();
  const unchanged = before.gitStatus === after.gitStatus && before.dailyBriefSha256 === after.dailyBriefSha256;
  if (!unchanged) fail("production boundary changed during global dry-run");
  const report = {
    schemaVersion: "global-market-brief-dry-run-report-v1",
    mode: GLOBAL_MARKET_BRIEF_MODE,
    sourceHead,
    inputSchemas: { writerContext: "writer-context-v1", writerRequest: "writer-request-v2", writerResult: "writer-result-v2", target: "global-market-brief-v1", writerOutput: "global-market-brief-writer-output-v1" },
    contextId: contextSummary.contextId,
    requestId: job.request.requestId,
    resultId: result.resultId,
    specialReports: result.payload.specialReports.length,
    validators: { globalMarketBrief: true, sourceScope: true, triggerEligibility: true, logicChainEvidence: true, timeOrdering: true, editorialLint: editorialLint.passed },
    editorialLint,
    wrote: false,
    productionApply: { applied: false, reason: "global_market_brief is dry-run only in P2-B1" },
    productionBoundary: { unchanged, before, after },
    isolationRoot: isolatedRoot,
    executionPackage: packageDirectory
  };
  writeJson(path.join(output, "DRY_RUN_RESULT.json"), report);
  return report;
}

function verifyExecutionPackage(packageDirectory) {
  const lines = fs.readFileSync(path.join(packageDirectory, "SHA256SUMS.txt"), "utf8").trim().split("\n");
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) fail("execution package SHA256SUMS is malformed");
    const file = path.join(packageDirectory, match[2]);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== match[1]) fail(`execution package hash mismatch: ${match[2]}`);
  }
}

export function deterministicWriterFromPackage(packageDirectory) {
  verifyExecutionPackage(packageDirectory);
  const request = readJson(path.join(packageDirectory, "REQUEST.json"));
  const packet = readJson(path.join(packageDirectory, "QUANTITATIVE_PACKET.json"));
  const bundle = readJson(path.join(packageDirectory, "RESEARCH_BUNDLE.json"));
  const baseline = readJson(path.join(packageDirectory, "BASELINE_CONTENT.json"));
  const context = readJson(path.join(packageDirectory, "WRITER_CONTEXT.json"));
  if (request.context.contextId !== context.contextId || baseline.contentIdentity !== context.baselineContent.contentIdentity || packet.writerPacketId !== context.quantitativeWriterPacket.writerPacketId || bundle.bundleId !== context.qualitativeResearchBundle.bundleId) fail("execution package internal identity mismatch");
  const fact = packet.facts[0];
  if (!fact || fact.status !== "ready" || typeof fact.value !== "number") fail("deterministic test writer requires one ready numeric fact");
  const renderedValue = `${Number(fact.value.toFixed(2)).toString()}${fact.unit === "percent" ? "%" : "bp"}`;
  const payload = structuredClone(baseline.payload);
  const claimPath = request.edition === "daily" ? "$.payload.meta.subtitle" : "$.payload.report.subtitle";
  if (request.edition === "daily") payload.meta.subtitle = renderedValue;
  else {
    payload.report.subtitle = renderedValue;
    payload.report.revision += 1;
    payload.report.generatedAt = `${baseline.asOf}T21:00:00+08:00`;
  }
  return sealWriterResult({
    schemaVersion: "writer-result-v2",
    jobId: request.jobId,
    requestId: request.requestId,
    contextId: context.contextId,
    generatedAt: `${baseline.asOf}T13:00:00.000Z`,
    writerEngine: "deterministic-test-writer",
    writerVersion: "writer-e2e-v1",
    payload,
    claimBindings: { quantitative: [{ claimPath, claimText: renderedValue, factId: fact.factId, renderedValue }], qualitative: [], sourceMetadata: [] },
    warnings: bundle.observations.length ? [] : ["no-new-qualitative-observations"],
    resultId: "",
    integrity: { businessSha256: "", sha256: "" }
  });
}

function runValidator(edition) {
  const startedAt = new Date().toISOString();
  const args = edition === "daily" ? ["scripts/validate-brief.mjs"] : ["scripts/validate-weekly.mjs"];
  const run = spawnSync(process.execPath, args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const endedAt = new Date().toISOString();
  return operationLog(`validate-${edition}`, startedAt, endedAt, { command: `${process.execPath} ${args.join(" ")}`, exitCode: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" });
}

function writeContentDiff(outputDirectory, baselinePayload, appliedPayload) {
  const before = path.join(outputDirectory, ".baseline-content.tmp.json");
  const after = path.join(outputDirectory, ".applied-content.tmp.json");
  fs.writeFileSync(before, `${JSON.stringify(baselinePayload, null, 2)}\n`, "utf8");
  fs.writeFileSync(after, `${JSON.stringify(appliedPayload, null, 2)}\n`, "utf8");
  const diff = spawnSync("git", ["diff", "--no-index", "--", before, after], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (![0, 1].includes(diff.status ?? 2)) fail(`git diff failed: ${diff.stderr}`);
  atomicWrite(path.join(outputDirectory, "content.diff"), Buffer.from(diff.stdout || "no differences\n", "utf8"));
  fs.unlinkSync(before);
  fs.unlinkSync(after);
}

export function finalizeDirectory(directory, metadata = null) {
  const manifestFile = path.join(directory, "manifest.json");
  const existing = fs.existsSync(manifestFile) ? readJson(manifestFile) : {};
  const base = metadata ?? Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "files"));
  const files = filesRecursively(directory).filter((file) => !["manifest.json", "SHA256SUMS.txt"].includes(path.basename(file))).map((file) => {
    const bytes = fs.readFileSync(file);
    return { path: path.relative(directory, file).split(path.sep).join("/"), bytes: bytes.length, sha256: sha256(bytes) };
  }).sort((left, right) => left.path.localeCompare(right.path));
  const manifest = { ...base, files };
  atomicWrite(manifestFile, jsonBytes(manifest));
  const sumEntries = [...files, { path: "manifest.json", bytes: fs.statSync(manifestFile).size, sha256: sha256(fs.readFileSync(manifestFile)) }].sort((left, right) => left.path.localeCompare(right.path));
  atomicWrite(path.join(directory, "SHA256SUMS.txt"), Buffer.from(`${sumEntries.map((item) => `${item.sha256}  ${item.path}`).join("\n")}\n`, "utf8"));
  return manifest;
}

export async function runRehearsal({ edition, outputDirectory, sourceHead }) {
  if (!["daily", "weekly"].includes(edition)) fail("edition must be daily or weekly");
  if (typeof sourceHead !== "string" || !/^[a-f0-9]{40}$/.test(sourceHead)) fail("sourceHead must be a full Git commit");
  const output = outsideRepository(outputDirectory);
  fs.mkdirSync(output, { recursive: true });
  if (fs.readdirSync(output).length) fail("rehearsal output directory must be empty");
  const beforeSensitive = sensitiveSnapshot();
  const asOf = AS_OF[edition];
  const research = await generateResearchBundle(edition, asOf);
  const packet = makePacket(edition, asOf);
  const packetPath = writePacketArtifact(packet, repositoryRoot, asOf);
  const baselineSource = edition === "daily" ? "content/daily-brief.json" : "content/weekly-reports/weekly-2026-W29.json";
  const contextSummary = prepareWriterContext({ edition, asOf, writerPacketPath: packetPath, researchBundlePath: research.relativePath, baselineSource, write: true, root: repositoryRoot, now: new Date(`${asOf}T12:30:00.000Z`), warnings: ["controlled-e2e-rehearsal"] });
  const prepared = prepare({ edition, contextPath: contextSummary.contextPath, write: true, rootDir: repositoryRoot, createdAt: `${asOf}T12:40:00.000Z` });
  const requestPath = createWriterJobPaths(repositoryRoot).request(prepared.request.jobId, prepared.request.requestedAsOf);
  const executionPackage = path.join(output, "execution-package");
  exportWriterJob({ request: prepared.request, outputDirectory: executionPackage, rootDir: repositoryRoot });
  const writerResultPath = path.join(output, "writer-result.json");
  const writerRun = spawnSync(process.execPath, [moduleFile, "write-result", "--package", executionPackage, "--output", writerResultPath], { cwd: output, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (writerRun.status !== 0) fail(`deterministic writer failed: ${writerRun.stderr || writerRun.stdout}`);
  const writerResult = readJson(writerResultPath);
  const validateStarted = new Date().toISOString();
  validateResult(repositoryRoot, prepared.request, writerResult);
  writeJson(path.join(output, "validate-result.log"), operationLog("validate-writer-result-v2", validateStarted, new Date().toISOString(), { exitCode: 0, requestPath: path.relative(repositoryRoot, requestPath).split(path.sep).join("/"), resultId: writerResult.resultId }));
  const dryRun = apply({ request: prepared.request, result: writerResult, dryRun: true, rootDir: repositoryRoot });
  writeJson(path.join(output, "apply-dry-run.json"), dryRun);
  const applied = apply({ request: prepared.request, result: writerResult, write: true, rootDir: repositoryRoot });
  if (!applied.applied) fail("real sandbox apply did not apply");
  const targetPath = prepared.request.targetOutputs[0].targetPath;
  const appliedPayload = readJson(path.join(repositoryRoot, ...targetPath.split("/")));
  writeJson(path.join(output, "applied-content.json"), appliedPayload);
  const baselinePayload = readJson(path.join(executionPackage, "BASELINE_CONTENT.json")).payload;
  writeContentDiff(output, baselinePayload, appliedPayload);
  const validator = runValidator(edition);
  writeJson(path.join(output, "validator.log"), validator);
  if (validator.exitCode !== 0) fail(`${edition} content validator failed`);
  const afterSensitive = sensitiveSnapshot();
  if (beforeSensitive.aggregateSha256 !== afterSensitive.aggregateSha256) fail("model/prediction/ledger boundary changed during rehearsal");
  const metadata = {
    schemaVersion: "writer-e2e-rehearsal-manifest-v1",
    edition,
    asOf,
    sourceHead,
    writerIsolation: "logical-only",
    contentQuality: "contentQualityNotEvaluated",
    deterministicTestWriter: true,
    controlledResearchFixture: "scripts/fixtures/research-pipeline/fed-rss.xml",
    contextId: contextSummary.contextId,
    requestId: prepared.request.requestId,
    resultId: writerResult.resultId,
    researchBundleId: research.summary.bundleId,
    writerPacketId: packet.writerPacketId,
    targetPath,
    modelPredictionLedgerBoundary: { unchanged: true, before: beforeSensitive.aggregateSha256, after: afterSensitive.aggregateSha256, fileCount: beforeSensitive.fileCount }
  };
  finalizeDirectory(output, metadata);
  return metadata;
}

async function runCli() {
  const command = process.argv[2];
  if (!ALLOWED_COMMANDS.has(command)) fail("usage: run | write-result | finalize");
  const args = parseArgs(process.argv.slice(3));
  if (command === "run") {
    if (args.mode === GLOBAL_MARKET_BRIEF_MODE) {
      if (typeof args.output !== "string" || typeof args["source-head"] !== "string" || args["dry-run"] !== true || Object.keys(args).some((key) => !["mode", "output", "source-head", "dry-run"].includes(key))) fail("global_market_brief run requires --mode global_market_brief --dry-run --output --source-head");
      console.log(canonicalJson(runGlobalMarketBriefDryRun({ outputDirectory: path.resolve(args.output), sourceHead: args["source-head"] })));
      return;
    }
    if (typeof args.edition !== "string" || typeof args.output !== "string" || typeof args["source-head"] !== "string" || Object.keys(args).some((key) => !["edition", "output", "source-head"].includes(key))) fail("run requires --edition --output --source-head");
    console.log(canonicalJson(await runRehearsal({ edition: args.edition, outputDirectory: path.resolve(args.output), sourceHead: args["source-head"] })));
    return;
  }
  if (command === "write-result") {
    if (typeof args.package !== "string" || typeof args.output !== "string" || Object.keys(args).some((key) => !["package", "output"].includes(key))) fail("write-result requires --package --output");
    const packageDirectory = path.resolve(args.package);
    const result = deterministicWriterFromPackage(packageDirectory);
    atomicWrite(path.resolve(args.output), jsonBytes(result));
    console.log(canonicalJson({ resultId: result.resultId, output: path.resolve(args.output) }));
    return;
  }
  if (command === "finalize") {
    if (typeof args.directory !== "string" || Object.keys(args).some((key) => key !== "directory")) fail("finalize requires --directory");
    console.log(canonicalJson(finalizeDirectory(path.resolve(args.directory))));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  runCli().catch((cause) => {
    console.error(cause instanceof Error ? cause.stack ?? cause.message : "writer e2e failure");
    process.exitCode = 1;
  });
}
