import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

import { canonicalJson } from "./research-contract.mjs";
import { validatePacket } from "./validate-writer-packet.mjs";
import {
  prepareWriterContext,
  readJsonOrGzip
} from "./writer-context.mjs";
import {
  exportWriterJob,
  prepare as prepareWriterJob,
  validateRequest
} from "./writer-jobs.mjs";
import {
  buildResearchBundleFromCodexRun,
  storeCodexResearchRun,
  validateCodexResearch
} from "./codex-research.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PACKAGE_FILES = [
  "BASELINE_CONTENT.json",
  "CODEX_RESEARCH.json",
  "EDITORIAL_STYLE.json",
  "PROMPT.md",
  "QUANTITATIVE_PACKET.json",
  "REQUEST.json",
  "RESEARCH_BUNDLE.json",
  "RESULT_TEMPLATE.json",
  "TARGET_SCHEMA.json",
  "WRITER_CONTEXT.json"
];

export class CodexWriterPrepareError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "CodexWriterPrepareError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new CodexWriterPrepareError(code, errorPath, message);
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function gzipJsonBytes(value) {
  return gzipSync(Buffer.from(canonicalJson(value), "utf8"), { mtime: 0 });
}

function atomicBytes(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("INPUT_JSON", file, "JSON input is missing or invalid");
  }
}

function readJsonOrGzipInput(file) {
  try {
    if (file.endsWith(".gz")) return JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
    return readJson(file);
  } catch {
    fail("INPUT_JSON", file, "JSON or gzip JSON input is missing or invalid");
  }
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function resolveRootFile(root, value, errorPath) {
  if (typeof value !== "string" || !value.length) fail("ARGUMENT", errorPath, "path is required");
  const file = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, ...value.split("/"));
  const relation = path.relative(path.resolve(root), file);
  if (!path.isAbsolute(value) && (!relation || relation.startsWith("..") || path.isAbsolute(relation))) fail("PATH", errorPath, "path escapes repository");
  return file;
}

function ensureOutsideRoot(file, root, errorPath) {
  if (!path.isAbsolute(file)) fail("PATH", errorPath, "absolute path required");
  const relation = path.relative(path.resolve(root), path.resolve(file));
  if (!relation || (!relation.startsWith("..") && !path.isAbsolute(relation))) fail("PATH", errorPath, "execution package must be outside repository");
}

function loadPacket(file) {
  const packet = readJsonOrGzipInput(file);
  validatePacket(packet, file);
  return packet;
}

export function packetArtifactPlan(packet, root) {
  const date = packet.marketDates?.aShare;
  if (typeof date !== "string" || !DATE.test(date)) fail("PACKET_DATE", "packet.marketDates.aShare", "valid A-share market date required");
  const file = path.join(root, "data", "writer-jobs", "packets", date.slice(0, 4), date.slice(5, 7), `${packet.writerPacketId}.json.gz`);
  const bytes = gzipJsonBytes(packet);
  if (!fs.existsSync(file)) return { file, bytes, created: true, reused: false, shouldWrite: true };
  let existing;
  try {
    existing = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
    validatePacket(existing, relative(root, file));
  } catch (cause) {
    fail("PACKET_ARTIFACT_CORRUPT", relative(root, file), cause instanceof Error ? cause.message : "packet artifact invalid");
  }
  const existingBytes = fs.readFileSync(file);
  if (Buffer.compare(existingBytes, bytes) === 0) return { file, bytes: existingBytes, created: false, reused: true, shouldWrite: false };
  if (existing.writerPacketId !== packet.writerPacketId) fail("PACKET_IMMUTABLE_CONFLICT", relative(root, file), "packet path identity differs");
  fail("PACKET_IMMUTABLE_CONFLICT", relative(root, file), "same writerPacketId has different bytes");
}

function packageManifest(request, context, packet, bundle, run, styleBytes, files) {
  return {
    schemaVersion: "codex-writer-execution-package-v1",
    requestId: request.requestId,
    jobId: request.jobId,
    contextId: context.contextId,
    contentIdentity: context.baselineContent.contentIdentity,
    writerPacketId: packet.writerPacketId,
    bundleId: bundle.bundleId,
    codexResearchRunId: run.researchRunId,
    editorialStyleSha256: hashBytes(styleBytes),
    files: files.map(({ name, bytes }) => ({ path: name, bytes: bytes.length, sha256: hashBytes(bytes) })).sort((left, right) => left.path.localeCompare(right.path))
  };
}

function shaSums(files) {
  return `${files.map(({ name, bytes }) => `${hashBytes(bytes)}  ${name}`).sort((left, right) => left.localeCompare(right)).join("\n")}\n`;
}

function packageDirectoryIsValid(directory, requestId) {
  const manifestFile = path.join(directory, "MANIFEST.json");
  if (!fs.existsSync(manifestFile)) return false;
  try {
    const manifest = readJson(manifestFile);
    return manifest.schemaVersion === "codex-writer-execution-package-v1" && manifest.requestId === requestId && PACKAGE_FILES.every((name) => fs.existsSync(path.join(directory, name))) && fs.existsSync(path.join(directory, "SHA256SUMS.txt"));
  } catch {
    return false;
  }
}

function writeExecutionPackage({ directory, request, context, packet, bundle, baseline, promptBytes, targetSchema, resultTemplate, run, styleBytes }) {
  fs.mkdirSync(directory, { recursive: true });
  const values = new Map([
    ["REQUEST.json", jsonBytes(request)],
    ["WRITER_CONTEXT.json", jsonBytes(context)],
    ["QUANTITATIVE_PACKET.json", jsonBytes(packet)],
    ["RESEARCH_BUNDLE.json", jsonBytes(bundle)],
    ["BASELINE_CONTENT.json", jsonBytes(baseline)],
    ["PROMPT.md", promptBytes],
    ["TARGET_SCHEMA.json", jsonBytes(targetSchema)],
    ["RESULT_TEMPLATE.json", jsonBytes(resultTemplate)],
    ["CODEX_RESEARCH.json", jsonBytes(run)],
    ["EDITORIAL_STYLE.json", styleBytes]
  ]);
  const files = [...values.entries()].map(([name, bytes]) => ({ name, bytes }));
  const manifest = packageManifest(request, context, packet, bundle, run, styleBytes, files);
  const manifestBytes = jsonBytes(manifest);
  const sumsBytes = Buffer.from(shaSums([...files, { name: "MANIFEST.json", bytes: manifestBytes }]), "utf8");
  for (const { name, bytes } of files) atomicBytes(path.join(directory, name), bytes);
  atomicBytes(path.join(directory, "MANIFEST.json"), manifestBytes);
  atomicBytes(path.join(directory, "SHA256SUMS.txt"), sumsBytes);
  return { directory, manifest, files: [...PACKAGE_FILES, "MANIFEST.json", "SHA256SUMS.txt"].sort() };
}

function defaultBaselineSource(root, edition) {
  if (edition === "daily") return "content/daily-brief.json";
  const index = readJson(path.join(root, "content", "weekly-reports", "index.json"));
  if (!index.latestReportId) fail("BASELINE", "content/weekly-reports/index.json", "latest weekly report is missing");
  return `content/weekly-reports/${index.latestReportId}.json`;
}

function existingBundlePath(root, edition, asOf) {
  const latest = path.join(root, "content", "research-bundles", `${edition}-latest.json`);
  if (fs.existsSync(latest)) {
    const bundle = readJson(latest);
    if (bundle.edition === edition && bundle.asOf === asOf) return relative(root, latest);
  }
  const directory = path.join(root, "data", "research-bundles", "bundles", asOf.slice(0, 4), asOf.slice(5, 7));
  if (!fs.existsSync(directory)) return null;
  const matches = fs.readdirSync(directory).filter((name) => name.endsWith(".json.gz")).sort();
  return matches.length ? relative(root, path.join(directory, matches.at(-1))) : null;
}

export async function prepareCodexWriter({
  edition,
  marketPacket,
  codexResearch = null,
  researchBundle = null,
  baselineSource = null,
  outputDirectory,
  dryRun = false,
  write = false,
  root = repositoryRoot,
  now = new Date()
} = {}) {
  if (dryRun === write) fail("MODE", "mode", "exactly one of dryRun or write is required");
  if (!["daily", "weekly"].includes(edition)) fail("EDITION", "edition", "daily or weekly required");
  const packetFile = resolveRootFile(root, marketPacket ?? `content/writer-packets/${edition}-latest.json`, "marketPacket");
  const packet = loadPacket(packetFile);
  if (packet.edition !== edition) fail("PACKET_EDITION", "packet.edition", "packet edition differs from requested edition");
  const asOf = packet.marketDates?.aShare;
  if (typeof asOf !== "string" || !DATE.test(asOf)) fail("PACKET_DATE", "packet.marketDates.aShare", "packet market date is required");
  const packetPlan = packetArtifactPlan(packet, root);
  const baseline = baselineSource ?? defaultBaselineSource(root, edition);
  const baselineFile = resolveRootFile(root, baseline, "baselineSource");
  if (!fs.existsSync(baselineFile)) fail("BASELINE", baseline, "baseline source is missing");
  if (typeof outputDirectory !== "string") fail("OUTPUT", "outputDirectory", "absolute execution package directory is required");
  const output = path.resolve(outputDirectory);
  ensureOutsideRoot(output, root, "outputDirectory");

  let run = null;
  let researchStore = null;
  let bundlePath = researchBundle;
  if (codexResearch) {
    const researchFile = path.isAbsolute(codexResearch) ? path.resolve(codexResearch) : path.resolve(root, ...codexResearch.split("/"));
    run = readJson(researchFile);
    validateCodexResearch(run, { contract: JSON.parse(fs.readFileSync(path.join(root, "data", "codex-research", "contract.json"), "utf8")), bundleRegistry: JSON.parse(fs.readFileSync(path.join(root, "data", "research-bundles", "contract.json"), "utf8")) });
    if (run.edition !== edition || run.asOf !== asOf) fail("RESEARCH_COMPATIBILITY", "codexResearch", "research edition/asOf must match packet");
    researchStore = await storeCodexResearchRun({ run, root, dryRun, write });
    bundlePath = `data/research-bundles/bundles/${asOf.slice(0, 4)}/${asOf.slice(5, 7)}/${run.bundleId}.json.gz`;
  }
  if (!bundlePath) bundlePath = existingBundlePath(root, edition, asOf);
  if (typeof bundlePath !== "string") fail("RESEARCH_BUNDLE", "researchBundle", "an immutable research bundle or sealed Codex research run is required");
  const bundleFile = resolveRootFile(root, bundlePath, "researchBundle");
  const bundleExists = fs.existsSync(bundleFile);
  if (!bundleExists && !(dryRun && codexResearch)) fail("RESEARCH_BUNDLE", bundlePath, "immutable research bundle is missing");
  if (!run && bundleExists) {
    run = { schemaVersion: "codex-research-reference-v1", researchRunId: "unavailable", edition, asOf, status: "reference-only", bundleId: readJsonOrGzip(bundleFile).bundleId, reason: "prepared from existing immutable research bundle" };
  }
  if (dryRun) {
    const contextReady = fs.existsSync(packetPlan.file) && bundleExists;
    let contextSummary = null;
    if (contextReady) {
      contextSummary = prepareWriterContext({ edition, asOf, writerPacketPath: relative(root, packetPlan.file), researchBundlePath: bundlePath, baselineSource: baseline, dryRun: true, write: false, root, now });
    }
    return {
      schemaVersion: "codex-writer-prepare-summary-v1",
      edition,
      asOf,
      packetPath: relative(root, packetPlan.file),
      packetPlan: { created: packetPlan.created, reused: packetPlan.reused, wouldWrite: packetPlan.shouldWrite ? [relative(root, packetPlan.file)] : [] },
      researchStore,
      contextReady,
      contextSummary: contextSummary ?? null,
      outputDirectory: output,
      dryRun: true,
      wrote: false
    };
  }

  if (packetPlan.shouldWrite) atomicBytes(packetPlan.file, packetPlan.bytes);
  const contextSummary = prepareWriterContext({ edition, asOf, writerPacketPath: relative(root, packetPlan.file), researchBundlePath: bundlePath, baselineSource: baseline, write: true, dryRun: false, root, now });
  const jobSummary = prepareWriterJob({ edition, contextPath: contextSummary.contextPath, write: true, dryRun: false, rootDir: root, createdAt: now.toISOString() });
  const request = jobSummary.request;
  validateRequest(request, { rootDir: root });
  if (packageDirectoryIsValid(output, request.requestId)) {
    return {
      schemaVersion: "codex-writer-prepare-summary-v1",
      edition,
      asOf,
      requestId: request.requestId,
      jobId: request.jobId,
      contextId: request.context.contextId,
      packetPath: relative(root, packetPlan.file),
      bundlePath,
      outputDirectory: output,
      contextSummary,
      jobSummary: jobSummary.summary,
      researchStore,
      dryRun: false,
      wrote: false,
      noOp: true
    };
  }
  if (fs.existsSync(output)) {
    const unexpected = fs.readdirSync(output).filter((name) => ![...PACKAGE_FILES, "MANIFEST.json", "SHA256SUMS.txt"].includes(name));
    if (unexpected.length) fail("OUTPUT_DIRECTORY", output, "execution package contains unrelated files");
  }
  exportWriterJob({ request, outputDirectory: output, rootDir: root });
  const context = readJsonOrGzip(path.join(root, ...contextSummary.contextPath.split("/")));
  const packetValue = loadPacket(packetPlan.file);
  const bundle = readJsonOrGzip(bundleFile);
  const baselineValue = readJsonOrGzip(path.join(root, ...contextSummary.baselinePath.split("/")));
  const promptBytes = fs.readFileSync(path.join(root, ...request.writerPromptPath.split("/")));
  const styleBytes = fs.readFileSync(path.join(root, "config", "editorial-style.json"));
  const targetSchemaBytes = fs.readFileSync(path.join(root, ...request.targetValidatorPath.split("/")));
  const targetSchemaReference = { schemaVersion: "writer-target-schema-reference-v1", targetSchemaVersion: request.targetSchemaVersion, targetPath: request.targetOutputs[0].targetPath, validator: { path: request.targetValidatorPath, sha256: request.targetValidatorSha256 }, validatorSourceBytes: targetSchemaBytes.length };
  const resultTemplate = readJson(path.join(output, "RESULT_TEMPLATE.json"));
  writeExecutionPackage({ directory: output, request, context, packet: packetValue, bundle, baseline: baselineValue, promptBytes, targetSchema: targetSchemaReference, resultTemplate, run, styleBytes });
  return {
    schemaVersion: "codex-writer-prepare-summary-v1",
    edition,
    asOf,
    requestId: request.requestId,
    jobId: request.jobId,
    contextId: request.context.contextId,
    packetPath: relative(root, packetPlan.file),
    bundlePath,
    outputDirectory: output,
    contextSummary,
    jobSummary: jobSummary.summary,
    researchStore,
    dryRun: false,
    wrote: true,
    noOp: false,
    packageFiles: [...PACKAGE_FILES, "MANIFEST.json", "SHA256SUMS.txt"].sort()
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") continue;
    if (!args[index].startsWith("--")) fail("CLI_ARGUMENT", "arguments", "unknown positional argument");
    const key = args[index].slice(2);
    if (!key || Object.hasOwn(parsed, key)) fail("CLI_ARGUMENT", "arguments", "duplicate option");
    parsed[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

async function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const root = args.root ? path.resolve(args.root) : repositoryRoot;
  if (args["dry-run"] !== true && args.write !== true || args["dry-run"] === true && args.write === true) fail("CLI_ARGUMENT", "mode", "exactly one of --dry-run or --write is required");
  if (typeof args.edition !== "string" || typeof args.output !== "string") fail("CLI_ARGUMENT", "arguments", "--edition and --output are required");
  const summary = await prepareCodexWriter({ edition: args.edition, marketPacket: args["market-packet"], codexResearch: args["codex-research"], researchBundle: args["research-bundle"], baselineSource: args["baseline-source"], outputDirectory: path.resolve(args.output), dryRun: args["dry-run"] === true, write: args.write === true, root });
  console.log(canonicalJson(summary));
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    await runCli();
  } catch (cause) {
    console.error(cause instanceof Error ? `${cause.code ?? "CODEX_WRITER_PREPARE_FAILURE"} ${cause.path ?? "prepare"} ${cause.message}` : "CODEX_WRITER_PREPARE_FAILURE");
    process.exitCode = 1;
  }
}
