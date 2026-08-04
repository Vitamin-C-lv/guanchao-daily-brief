import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./research-contract.mjs";
import { loadEditorialStyle, lintEditorial } from "./editorial-lint.mjs";
import { validateCodexResearch } from "./codex-research.mjs";
import { validateVisualBundle } from "./article-visuals.mjs";
import {
  apply as applyWriterResult,
  validateRequest,
  validateResult
} from "./writer-jobs.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const PACKAGE_FILES = [
  "ARTICLE_DEPTH_RULES.json",
  "ARTICLE_VISUAL_BUNDLE.json",
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

export class CodexWriterFinalizeError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "CodexWriterFinalizeError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new CodexWriterFinalizeError(code, errorPath, message);
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fail("INPUT_JSON", file, "JSON input is missing or invalid");
  }
}

function writeJsonOutside(file, value, root) {
  if (!path.isAbsolute(file)) fail("OUTPUT", "output", "absolute output path required");
  const relation = path.relative(path.resolve(root), path.resolve(file));
  if (!relation || (!relation.startsWith("..") && !path.isAbsolute(relation))) fail("OUTPUT", "output", "report output must be outside repository");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonBytes(value));
}

function readPackage(directory) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail("PACKAGE_MISSING", root, "execution package directory is missing");
  const allowed = new Set([...PACKAGE_FILES, "MANIFEST.json", "SHA256SUMS.txt"]);
  const unexpected = fs.readdirSync(root).filter((name) => !allowed.has(name));
  if (unexpected.length) fail("PACKAGE_DIRECTORY", root, `unrelated files: ${unexpected.join(", ")}`);
  const manifest = readJson(path.join(root, "MANIFEST.json"));
  if (manifest.schemaVersion !== "codex-writer-execution-package-v1") fail("PACKAGE_SCHEMA", "MANIFEST.json", "execution package manifest schema mismatch");
  if (!Array.isArray(manifest.files) || manifest.files.length !== PACKAGE_FILES.length) fail("PACKAGE_MANIFEST", "MANIFEST.json.files", "manifest file set mismatch");
  const expectedNames = [...PACKAGE_FILES].sort();
  const actualNames = manifest.files.map((entry) => entry.path).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) fail("PACKAGE_MANIFEST", "MANIFEST.json.files", "manifest file set mismatch");
  const files = new Map();
  for (const entry of manifest.files) {
    if (!Number.isInteger(entry.bytes) || typeof entry.sha256 !== "string") fail("PACKAGE_MANIFEST", `MANIFEST.json.files.${entry.path}`, "invalid file metadata");
    const file = path.join(root, entry.path);
    if (!fs.existsSync(file)) fail("PACKAGE_MISSING", entry.path, "execution package file is missing");
    const bytes = fs.readFileSync(file);
    if (bytes.length !== entry.bytes || hashBytes(bytes) !== entry.sha256) fail("PACKAGE_SHA", entry.path, "execution package file hash mismatch");
    files.set(entry.path, bytes);
  }
  const sumsLines = fs.readFileSync(path.join(root, "SHA256SUMS.txt"), "utf8").trim().split(/\r?\n/).filter(Boolean);
  const sums = new Map();
  for (const line of sumsLines) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    if (!match) fail("PACKAGE_SUMS", "SHA256SUMS.txt", "invalid checksum line");
    sums.set(match[2], match[1]);
  }
  const sumNames = [...PACKAGE_FILES, "MANIFEST.json"].sort();
  if (sums.size !== sumNames.length || [...sums.keys()].sort().some((name, index) => name !== sumNames[index])) fail("PACKAGE_SUMS", "SHA256SUMS.txt", "checksum file set mismatch");
  for (const name of sumNames) {
    const bytes = name === "MANIFEST.json" ? fs.readFileSync(path.join(root, name)) : files.get(name);
    if (sums.get(name) !== hashBytes(bytes)) fail("PACKAGE_SUMS", name, "checksum mismatch");
  }
  return { root, manifest, files };
}

function protectedFiles(root) {
  const roots = [
    "data/prediction-ledger",
    "public/data/prediction-history",
    "data/sector-rotation",
    "data/model-research",
    "scripts/run-sector-rotation.mjs",
    "scripts/model-research.mjs",
    "scripts/prediction_ledger.py",
    "content/prediction-history",
    "content/sector-rotation"
  ];
  const files = [];
  const walk = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  for (const relative of roots) {
    const file = path.join(root, ...relative.split("/"));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) walk(file);
    else if (fs.existsSync(file)) files.push(file);
  }
  return Object.fromEntries(files.sort().map((file) => [path.relative(root, file).split(path.sep).join("/"), hashBytes(fs.readFileSync(file))]));
}

function assertProtectedEqual(before, after) {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changed = names.filter((name) => before[name] !== after[name]);
  if (changed.length) fail("PROTECTED_BOUNDARY", changed.join(","), "protected prediction/model/ledger files changed");
  return { checked: names.length, changed: [] };
}

function allowedApplyFile(file, request, root) {
  const relative = file.replaceAll("\\", "/");
  const target = request.targetOutputs[0].targetPath;
  if (relative === target) return true;
  if (relative === `data/writer-jobs/accepted/${request.requestedAsOf.slice(0, 4)}/${request.requestedAsOf.slice(5, 7)}/${request.jobId}.json.gz`) return true;
  if (relative === "data/writer-jobs/index.json" || relative === "content/writer-jobs/daily-pending.json" || relative === "content/writer-jobs/weekly-pending.json") return true;
  if (request.edition === "weekly" && (relative === "content/weekly-reports/index.json" || relative === "public/update-notices.json")) return true;
  return false;
}

function validateTargetAfterApply(root, request) {
  const target = request.targetOutputs[0];
  const run = spawnSync(process.execPath, [path.join(root, ...target.validatorPath.split("/"))], { cwd: root, encoding: "utf8" });
  if (run.status !== 0) fail("TARGET_VALIDATOR", target.targetPath, (run.stderr || run.stdout || "target validator failed").trim());
  return { validatorPath: target.validatorPath, status: run.status, stdout: (run.stdout || "").trim().slice(0, 500) };
}

export function countChinese(text) {
  return [...String(text)].filter((char) => /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)).length;
}

export function collectBodyText(payload) {
  const parts = [];
  const push = (value) => {
    if (typeof value === "string" && value.trim()) parts.push(value);
  };
  const walkArticle = (article) => {
    push(article?.detail?.lead);
    for (const keyPoint of article?.detail?.keyPoints ?? []) push(keyPoint);
    for (const section of article?.detail?.sections ?? []) {
      push(section?.heading);
      push(section?.body);
    }
  };
  for (const article of payload?.federalReserve?.articles ?? []) walkArticle(article);
  for (const market of payload?.markets ?? []) {
    for (const article of market.articles ?? []) walkArticle(article);
  }
  for (const article of payload?.hotspots ?? []) walkArticle(article);
  push(payload?.pulse?.explanation);
  for (const item of payload?.watchlist ?? []) push(item?.note);
  return parts.join("\n");
}

export function validateDepthAndVisuals({ edition, payload, result, visualBundle, depthRules }) {
  const bodyText = collectBodyText(payload);
  const chineseCharacterCount = countChinese(bodyText);
  const depth = depthRules?.[edition];
  if (!depth) fail("ARTICLE_DEPTH_RULES", "ARTICLE_DEPTH_RULES.json", `depth rules missing for ${edition}`);
  if (chineseCharacterCount < depth.chineseCharacterCountMin) {
    fail("ARTICLE_TOO_SHALLOW", "articleDepth.chineseCharacterCount", `正文仅 ${chineseCharacterCount} 字，低于 ${depth.chineseCharacterCountMin} 字`);
  }
  if (chineseCharacterCount > depth.chineseCharacterCountMax) {
    fail("ARTICLE_TOO_VERBOSE", "articleDepth.chineseCharacterCount", `正文 ${chineseCharacterCount} 字，超过 ${depth.chineseCharacterCountMax} 字`);
  }
  const articleDepth = result.articleDepth;
  if (!articleDepth || typeof articleDepth !== "object") fail("ARTICLE_DEPTH", "articleDepth", "articleDepth object required in writer result");
  if (typeof articleDepth.estimatedReadingMinutes !== "number" || articleDepth.estimatedReadingMinutes < depth.readingMinutesMin || articleDepth.estimatedReadingMinutes > depth.readingMinutesMax) {
    fail("ARTICLE_DEPTH", "articleDepth.estimatedReadingMinutes", `阅读时间需在 ${depth.readingMinutesMin}–${depth.readingMinutesMax} 分钟`);
  }
  if (Math.abs(articleDepth.estimatedReadingMinutes - chineseCharacterCount / 200) > 1) {
    fail("ARTICLE_DEPTH", "articleDepth.estimatedReadingMinutes", "阅读时间与正文字数不一致");
  }
  if (typeof articleDepth.mainThesis !== "string" || !articleDepth.mainThesis.trim()) fail("ARTICLE_DEPTH", "articleDepth.mainThesis", "mainThesis required");
  if (typeof articleDepth.scenarioCount !== "number" || articleDepth.scenarioCount < depth.scenarioCountMin) fail("ARTICLE_DEPTH", "articleDepth.scenarioCount", `情景数量需至少 ${depth.scenarioCountMin}`);
  if (typeof articleDepth.termExplanationCount !== "number" || articleDepth.termExplanationCount < depth.termExplanationCountMin) fail("ARTICLE_DEPTH", "articleDepth.termExplanationCount", `机制解释需至少 ${depth.termExplanationCountMin} 段`);
  if (typeof articleDepth.counterEvidenceCount !== "number" || articleDepth.counterEvidenceCount < depth.counterEvidenceCountMin) fail("ARTICLE_DEPTH", "articleDepth.counterEvidenceCount", `反证需至少 ${depth.counterEvidenceCountMin} 条`);

  validateVisualBundle(visualBundle);
  const selections = Array.isArray(result.visualSelections) ? result.visualSelections : [];
  if (selections.length < depth.visualCountMin) fail("VISUAL_COUNT", "visualSelections", `日报需至少 ${depth.visualCountMin} 张图（实际 ${selections.length}）`);
  const visuals = new Map(visualBundle.visuals.map((visual) => [visual.id, visual]));
  const seen = new Set();
  for (let index = 0; index < selections.length; index += 1) {
    const selection = selections[index];
    const label = `visualSelections[${index}]`;
    if (!selection || typeof selection !== "object") fail("VISUAL_SELECTION", label, "selection object required");
    const visual = visuals.get(selection.visualId);
    if (!visual) fail("VISUAL_UNKNOWN", `${label}.visualId`, `visualId ${selection.visualId} 不在冻结 bundle 中`);
    if (seen.has(selection.visualId)) fail("VISUAL_DUPLICATE", `${label}.visualId`, `visualId ${selection.visualId} 重复使用`);
    seen.add(selection.visualId);
    if (typeof selection.title !== "string" || !selection.title.trim()) fail("VISUAL_TITLE", `${label}.title`, "图表标题不能为空");
    if (typeof selection.takeaway !== "string" || !selection.takeaway.trim()) fail("VISUAL_TAKEAWAY", `${label}.takeaway`, "图表要点不能为空");
    if (typeof selection.explanation !== "string" || !selection.explanation.trim()) fail("VISUAL_EXPLANATION", `${label}.explanation`, "图表解释不能为空");
    if (!bodyText.includes(selection.explanation)) fail("VISUAL_NOT_EXPLAINED", `${label}.explanation`, "图表解释必须出现在正文中");
    if (visual.dataThrough !== payload?.meta?.dataThrough) fail("VISUAL_DATE_CONFLICT", `${label}.visualId`, `图表 dataThrough ${visual.dataThrough} 与文章 ${payload?.meta?.dataThrough} 不一致`);
  }
  return { chineseCharacterCount, bodyCharacters: countChinese(bodyText), visualsSelected: selections.map((item) => item.visualId) };
}

function resolveVisuals(result, visualBundle) {
  const byId = new Map(visualBundle.visuals.map((visual) => [visual.id, visual]));
  return (result.visualSelections ?? []).map((selection) => {
    const visual = byId.get(selection.visualId);
    return {
      visualId: selection.visualId,
      kind: visual.kind,
      title: selection.title,
      takeaway: selection.takeaway,
      explanation: selection.explanation,
      placement: selection.placement,
      unit: visual.unit,
      dataThrough: visual.dataThrough,
      sourceIndexes: visual.sourceIndexes,
      series: visual.series,
      points: visual.points,
      notes: visual.notes
    };
  });
}

function injectVisuals(targetFile, visuals, root) {
  if (!path.isAbsolute(targetFile)) fail("TARGET", "target", "absolute target path required");
  const relative = path.relative(path.resolve(root), path.resolve(targetFile));
  if (relative.startsWith("..") || path.isAbsolute(relative)) fail("APPLY_BOUNDARY", targetFile, "visual injection target outside repository");
  const payload = readJson(targetFile);
  payload.visuals = visuals;
  const temporary = `${targetFile}.visuals.tmp`;
  fs.writeFileSync(temporary, `${canonicalJson(payload)}\n`, "utf8");
  fs.renameSync(temporary, targetFile);
  return targetFile;
}

export function finalizeCodexWriter({ packageDirectory, resultFile, dryRun = false, write = false, root = repositoryRoot, output = null } = {}) {
  if (dryRun === write) fail("MODE", "mode", "exactly one of dryRun or write is required");
  if (typeof packageDirectory !== "string" || typeof resultFile !== "string") fail("ARGUMENT", "arguments", "packageDirectory and resultFile are required");
  const packageValue = readPackage(packageDirectory);
  const request = JSON.parse(packageValue.files.get("REQUEST.json").toString("utf8"));
  validateRequest(request, { rootDir: root });
  const result = readJson(path.resolve(resultFile));
  const bundleRegistry = JSON.parse(fs.readFileSync(path.join(root, "data", "research-bundles", "contract.json"), "utf8"));
  const codexResearch = JSON.parse(packageValue.files.get("CODEX_RESEARCH.json").toString("utf8"));
  if (codexResearch.schemaVersion === "codex-research-v1") validateCodexResearch(codexResearch, { bundleRegistry, contract: JSON.parse(fs.readFileSync(path.join(root, "data", "codex-research", "contract.json"), "utf8")) });
  else fail("RESEARCH_PACKAGE", "CODEX_RESEARCH.json", "sealed codex-research-v1 is required");
  const style = JSON.parse(packageValue.files.get("EDITORIAL_STYLE.json").toString("utf8"));
  const baselineStyle = loadEditorialStyle(root);
  if (hashBytes(packageValue.files.get("EDITORIAL_STYLE.json")) !== hashBytes(fs.readFileSync(path.join(root, "config", "editorial-style.json")))) fail("STYLE_SHA", "EDITORIAL_STYLE.json", "package style differs from repository style");
  if (JSON.stringify(style) !== JSON.stringify(baselineStyle)) fail("STYLE_CONTENT", "EDITORIAL_STYLE.json", "package style content differs from repository style");
  const beforeProtected = protectedFiles(root);
  validateResult(root, request, result);
  const lint = lintEditorial({ edition: request.edition, value: result.payload, style, result });
  if (!lint.passed) fail("EDITORIAL_LINT", "result.payload", lint.errors.join("; "));
  const visualBundle = JSON.parse(packageValue.files.get("ARTICLE_VISUAL_BUNDLE.json").toString("utf8"));
  const depthRules = JSON.parse(packageValue.files.get("ARTICLE_DEPTH_RULES.json").toString("utf8"));
  const depthAndVisuals = validateDepthAndVisuals({ edition: request.edition, payload: result.payload, result, visualBundle, depthRules });
  const simulation = applyWriterResult({ request, result, dryRun: true, write: false, rootDir: root });
  for (const file of simulation.files) if (!allowedApplyFile(file, request, root)) fail("APPLY_BOUNDARY", file, "production apply proposed an unapproved file");
  let applied = simulation;
  let targetValidation = null;
  if (write) {
    applied = applyWriterResult({ request, result, dryRun: false, write: true, rootDir: root });
    for (const file of applied.files) if (!allowedApplyFile(file, request, root)) fail("APPLY_BOUNDARY", file, "production apply wrote an unapproved file");
    injectVisuals(path.join(root, ...request.targetOutputs[0].targetPath.split("/")), resolveVisuals(result, visualBundle), root);
    targetValidation = validateTargetAfterApply(root, request);
    const afterProtected = protectedFiles(root);
    assertProtectedEqual(beforeProtected, afterProtected);
  }
  const report = {
    schemaVersion: "codex-writer-finalize-report-v1",
    edition: request.edition,
    requestedAsOf: request.requestedAsOf,
    requestId: request.requestId,
    jobId: request.jobId,
    contextId: request.context.contextId,
    resultId: result.resultId,
    codexResearchRunId: codexResearch.researchRunId,
    bundleId: codexResearch.bundleId,
    editorialLint: lint,
    articleDepth: depthAndVisuals,
    productionApply: applied,
    protectedBoundary: { checked: Object.keys(beforeProtected).length, unchanged: true },
    targetValidation,
    dryRun,
    wrote: write,
    output: output ?? null
  };
  if (output) writeJsonOutside(path.resolve(output), report, root);
  return report;
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

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const root = args.root ? path.resolve(args.root) : repositoryRoot;
    if (args["dry-run"] !== true && args.write !== true || args["dry-run"] === true && args.write === true) fail("CLI_ARGUMENT", "mode", "exactly one of --dry-run or --write is required");
    const report = finalizeCodexWriter({ packageDirectory: args.package, resultFile: args.result, dryRun: args["dry-run"] === true, write: args.write === true, root, output: args.output ? path.resolve(args.output) : null });
    console.log(canonicalJson(report));
  } catch (cause) {
    console.error(cause instanceof Error ? `${cause.code ?? "CODEX_WRITER_FINALIZE_FAILURE"} ${cause.path ?? "finalize"} ${cause.message}` : "CODEX_WRITER_FINALIZE_FAILURE");
    process.exitCode = 1;
  }
}
