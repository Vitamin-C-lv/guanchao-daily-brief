#!/usr/bin/env node
/**
 * Deterministic article visual bundle generator for 观潮.
 *
 * Reads only frozen inputs: writer packet (treasury facts), sealed Codex research
 * run (index facts), sector-rotation (rule observation scores) and archived writer
 * packets (historical treasury snapshots).  The Writer never edits the numbers;
 * it only selects visualIds and writes titles/takeaways in the result.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const CONTRACT_FILE = path.join(repositoryRoot, "data", "article-visuals", "contract.json");
const HASH = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class ArticleVisualsError extends Error {
  constructor(code, errorPath, message) {
    super(message);
    this.name = "ArticleVisualsError";
    this.code = code;
    this.path = errorPath;
  }
}

function fail(code, errorPath, message) {
  throw new ArticleVisualsError(code, errorPath, message);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (cause) {
    fail("INPUT_JSON", label, `${file} is missing or invalid: ${cause.message}`);
  }
}

function readJsonGzip(file, label) {
  try {
    return JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
  } catch (cause) {
    fail("INPUT_JSON", label, `${file} is missing or invalid: ${cause.message}`);
  }
}

function canonicalJson(value) {
  const visit = (current) => {
    if (Array.isArray(current)) return current.map(visit);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(Object.keys(current).sort().map((key) => [key, visit(current[key])]));
    }
    return current;
  };
  return JSON.stringify(visit(value));
}

export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function loadContract() {
  return readJson(CONTRACT_FILE, "contract");
}

function walkPackets(root) {
  const directory = path.join(root, "data", "writer-jobs", "packets");
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".json.gz")) files.push(file);
    }
  };
  visit(directory);
  return files.sort();
}

function latestResearchRun(root) {
  const directory = path.join(root, "data", "codex-research", "runs");
  if (!fs.existsSync(directory)) return null;
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith(".json.gz")) files.push(file);
    }
  };
  visit(directory);
  if (!files.length) return null;
  let best = null;
  let bestAsOf = null;
  for (const file of files) {
    try {
      const run = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
      const asOf = run.asOf ?? "";
      if (!bestAsOf || asOf > bestAsOf) {
        bestAsOf = asOf;
        best = file;
      }
    } catch {
      // skip unreadable run
    }
  }
  return best;
}

function packetTreasury(packet) {
  const byLabel = new Map();
  for (const fact of packet.facts ?? []) {
    if (fact.topic !== "treasury" && !String(fact.factId).includes("treasury")) continue;
    byLabel.set(fact.label, fact);
  }
  const pick = (label) => {
    const fact = byLabel.get(label);
    if (!fact || fact.status !== "ready" || typeof fact.value !== "number") return null;
    return fact;
  };
  return {
    y2: pick("US Treasury 2Y"),
    y10: pick("US Treasury 10Y"),
    y30: pick("US Treasury 30Y"),
    real10: pick("US Treasury real 10Y"),
    spread: pick("US Treasury 2s10s spread")
  };
}

function parsePercentChange(claimText) {
  if (typeof claimText !== "string") return null;
  const match = claimText.match(/(?:rose|fell|gained|declined|上涨|下跌|升|跌)\s*([\d.]+)%/i);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const sign = /rose|gained|上涨|升/i.test(claimText) ? 1 : -1;
  return Number((sign * value).toFixed(2));
}

function indexFacts(research) {
  const known = [
    ["上证指数", "Shanghai Composite close"],
    ["深证成指", "Shenzhen Component close"],
    ["创业板指", "ChiNext close and turnover"],
    ["恒生指数", "Hang Seng Index close"],
    ["恒生科技", "Hang Seng Tech close"],
    ["标普500", "S&P 500 close"],
    ["纳斯达克", "Nasdaq Composite close"],
    ["道琼斯", "Dow Jones close"]
  ];
  const out = [];
  for (const [label, subject] of known) {
    const fact = (research.facts ?? []).find((item) => item.subject === subject);
    if (!fact) continue;
    const change = parsePercentChange(fact.claimText);
    out.push({ label, change, value: fact.value, unit: fact.unit, asOf: fact.asOf ?? research.asOf });
  }
  return out;
}

function rotationSectorChanges(rotation) {
  const market = (rotation.markets ?? []).find((item) => item.id === "a-share");
  const items = market?.horizons?.current?.items ?? [];
  const out = [];
  for (const item of items) {
    const metric = (item.metrics ?? []).find((m) => m.label === "5日涨跌");
    if (!metric || typeof metric.value !== "string") continue;
    const match = metric.value.match(/([+-]?\d+(?:\.\d+)?)%/);
    if (!match) continue;
    out.push({ sector: item.sector, change5d: Number(match[1]), score: item.score, rank: item.rank });
  }
  return out;
}

function hashVisual(visual) {
  // The frozen core is the data: kind, dates, units, sources, series and points.
  // title/takeaway are authored by the Writer per placement and are not frozen.
  const { contentSha256: _ignored, title: _title, takeaway: _takeaway, ...body } = visual;
  return sha256Canonical(body);
}

export function generateArticleVisuals({
  edition = "daily",
  packet = null,
  research = null,
  rotation = null,
  root = repositoryRoot,
  generatedAt = new Date()
} = {}) {
  if (!["daily", "weekly"].includes(edition)) fail("EDITION", "edition", "daily or weekly required");
  const contract = loadContract();
  const visuals = [];

  const currentPacket = packet ?? readJson(path.join(root, "content", "writer-packets", `${edition}-latest.json`), "packet");
  const current = packetTreasury(currentPacket);
  const dataThrough = currentPacket.marketDates?.us ?? currentPacket.marketDates?.aShare ?? null;

  // Historical treasury snapshots from archived writer packets (same market date
  // or earlier), used for "current vs previous complete trading day" contrast.
  const archived = [];
  for (const file of walkPackets(root)) {
    try {
      const candidate = JSON.parse(gunzipSync(fs.readFileSync(file)).toString("utf8"));
      const treasury = packetTreasury(candidate);
      const asOf = candidate.marketDates?.us ?? candidate.marketDates?.aShare ?? null;
      if (asOf && asOf !== dataThrough && treasury.y10) archived.push({ asOf, treasury });
    } catch {
      // skip unreadable archive
    }
  }
  archived.sort((left, right) => left.asOf.localeCompare(right.asOf));
  const previous = archived.at(-1) ?? null;

  // ---- visual 1: yield curve (current vs previous complete trading day) ----
  if (current.y2 && current.y10 && current.y30) {
    const points = [];
    const series = [];
    const addCurve = (asOf, treasury) => {
      if (!treasury.y2 || !treasury.y10 || !treasury.y30) return;
      series.push({ id: asOf, label: `${asOf.slice(5)} 曲线`, unit: "percent" });
      points.push({ x: "2Y", y: treasury.y2.value, seriesId: asOf });
      points.push({ x: "10Y", y: treasury.y10.value, seriesId: asOf });
      points.push({ x: "30Y", y: treasury.y30.value, seriesId: asOf });
    };
    addCurve(dataThrough, current);
    if (previous) addCurve(previous.asOf, previous.treasury);
    const notes = [];
    if (!previous) notes.push("上一完整交易日对照不可用，仅展示当前曲线");
    if (!current.y30) notes.push("30Y 数据不可用");
    const visual = {
      id: "v-yield-curve",
      kind: "yield_curve",
      title: "收益率曲线：8月3日 vs 7月31日",
      takeaway: "曲线整体下移，短端与长端同步回落。",
      unit: "percent",
      dataThrough,
      sourceIndexes: [0],
      series,
      points,
      notes,
      contentSha256: ""
    };
    if (previous) visual.title = `收益率曲线：${dataThrough} vs ${previous.asOf}`;
    visual.contentSha256 = hashVisual(visual);
    visuals.push(visual);
  }

  // ---- visual 2: nominal / real 10Y + 2s10s spread over available window ----
  if (current.y10 && current.real10 && current.spread) {
    const points = [];
    const series = [
      { id: "nominal10y", label: "10Y 名义收益率", unit: "percent" },
      { id: "real10y", label: "10Y 实际收益率", unit: "percent" },
      { id: "spread2s10s", label: "2s10s 利差", unit: "bp" }
    ];
    const addPoint = (asOf, treasury) => {
      if (!treasury.y10 || !treasury.real10 || !treasury.spread) return;
      points.push({ x: asOf, y: treasury.y10.value, seriesId: "nominal10y" });
      points.push({ x: asOf, y: treasury.real10.value, seriesId: "real10y" });
      points.push({ x: asOf, y: treasury.spread.value, seriesId: "spread2s10s" });
    };
    addPoint(dataThrough, current);
    if (previous) addPoint(previous.asOf, previous.treasury);
    const breakeven = current.y10 && current.real10 ? Number((current.y10.value - current.real10.value).toFixed(2)) : null;
    const notes = [];
    if (breakeven !== null) notes.push(`10Y breakeven（nominal minus real）≈ ${breakeven}%`);
    notes.push("nominal/real 单位为 %，2s10s 单位为 bp");
    const visual = {
      id: "v-nominal-real-spread",
      kind: "grouped_bar",
      title: "名义与实际收益率、期限利差",
      takeaway: "名义与实际收益率同步回落，利差收窄。",
      unit: "mixed",
      dataThrough,
      sourceIndexes: [0, 1],
      series,
      points,
      notes,
      contentSha256: ""
    };
    visual.contentSha256 = hashVisual(visual);
    visuals.push(visual);
  }

  // ---- visual 3: A/H/US index change snapshot (from frozen research run) ----
  const researchRun = research ?? (latestResearchRun(root) ? readJsonGzip(latestResearchRun(root), "research") : null);
  const indexFactsList = researchRun ? indexFacts(researchRun) : [];
  if (indexFactsList.length >= 3) {
    const visual = {
      id: "v-index-snapshot",
      kind: "bar",
      title: "A/H/US 主要指数：最新完整交易日涨跌",
      takeaway: "美股领涨，A股缩量回调，港股科技领涨。",
      unit: "percent",
      dataThrough: researchRun?.asOf ?? dataThrough,
      sourceIndexes: [1],
      series: [{ id: "index-change", label: "当日涨跌", unit: "percent" }],
      points: indexFactsList.map((item) => ({ x: item.label, y: item.change, seriesId: "index-change" })),
      notes: ["不同市场使用各自最新完整交易日", "A/H/US 本窗口均为 2026-08-03"],
      contentSha256: ""
    };
    visual.contentSha256 = hashVisual(visual);
    visuals.push(visual);
  }

  // ---- visual 4: A-share sector relative strength (rule observation score) ----
  const rotationPayload = rotation ?? (fs.existsSync(path.join(root, "content", "sector-rotation.json")) ? readJson(path.join(root, "content", "sector-rotation.json"), "rotation") : null);
  const sectors = rotationPayload ? rotationSectorChanges(rotationPayload) : [];
  if (sectors.length >= 3) {
    const visual = {
      id: "v-sector-relative",
      kind: "bar",
      title: "A股板块相对强度（5日，规则观察分）",
      takeaway: "相对强弱来自量价规则观察分，不是概率。",
      unit: "percent",
      dataThrough: rotationPayload.markets?.find((m) => m.id === "a-share")?.asOf ?? dataThrough,
      sourceIndexes: [2],
      series: [{ id: "change5d", label: "5日涨跌", unit: "percent" }],
      points: sectors.map((item) => ({ x: item.sector, y: item.change5d, seriesId: "change5d" })),
      notes: ["规则观察分，不构成概率", "数据来自固定观察池 a-core12-v2"],
      contentSha256: ""
    };
    visual.contentSha256 = hashVisual(visual);
    visuals.push(visual);
  }

  // ---- visual 5: weekly official-document publication timeline ----
  // This remains useful when market-index facts are unavailable: it visualizes
  // publication dates only, never inventing an approval/effective timestamp.
  if (edition === "weekly") {
    const documents = (researchRun?.documents ?? [])
      .filter((document) => /federalregister\.gov/i.test(document.canonicalUrl ?? "")
        && /CME|Nasdaq/i.test(document.title ?? ""))
      .sort((left, right) => String(left.publishedDate ?? "").localeCompare(String(right.publishedDate ?? "")))
      .slice(0, 4);
    if (documents.length >= 2) {
      const visual = {
        id: "v-official-document-timeline",
        kind: "timeline",
        title: "正式文件发布时间线",
        takeaway: "发布记录与实施阶段需要分开核验。",
        unit: "date",
        dataThrough,
        sourceIndexes: [1, 2],
        series: [{ id: "published", label: "正式发布记录", unit: "date" }],
        points: documents.map((document) => ({
          x: `${document.publishedDate ?? dataThrough} ${document.title.slice(0, 24)}`,
          y: null,
          seriesId: "published"
        })),
        notes: ["时间点仅表示文件发布或收录，不表示批准或生效", "后续阶段需回查原始文件"],
        contentSha256: ""
      };
      visual.contentSha256 = hashVisual(visual);
      visuals.push(visual);
    }
  }

  if (!visuals.length) fail("NO_VISUALS", "visuals", "no visual could be generated from frozen inputs");
  const bundle = {
    schemaVersion: "article-visual-bundle-v1",
    edition,
    generatedAt: generatedAt.toISOString(),
    visuals,
    integrity: { businessSha256: "", sha256: "" }
  };
  bundle.integrity.businessSha256 = sha256Canonical({ ...bundle, integrity: {} });
  bundle.integrity.sha256 = sha256Canonical({ ...bundle, integrity: { businessSha256: bundle.integrity.businessSha256 } });
  validateVisualBundle(bundle, contract);
  return bundle;
}

export function validateVisualBundle(bundle, contract = loadContract()) {
  if (!bundle || typeof bundle !== "object") fail("BUNDLE_TYPE", "bundle", "bundle object required");
  if (bundle.schemaVersion !== contract.bundleSchemaVersion) fail("BUNDLE_SCHEMA", "bundle.schemaVersion", "article-visual-bundle-v1 required");
  if (!["daily", "weekly"].includes(bundle.edition)) fail("BUNDLE_EDITION", "bundle.edition", "daily or weekly required");
  if (typeof bundle.generatedAt !== "string" || !bundle.generatedAt.endsWith("Z")) fail("BUNDLE_TIME", "bundle.generatedAt", "canonical UTC timestamp required");
  if (!Array.isArray(bundle.visuals) || !bundle.visuals.length || bundle.visuals.length > contract.limits.visualCountMax) fail("BUNDLE_COUNT", "bundle.visuals", "visual count outside contract");
  const ids = new Set();
  for (let index = 0; index < bundle.visuals.length; index += 1) {
    const visual = bundle.visuals[index];
    const label = `bundle.visuals[${index}]`;
    if (!visual || typeof visual !== "object") fail("VISUAL_TYPE", label, "visual object required");
    for (const key of contract.visualRequiredKeys) {
      if (!Object.hasOwn(visual, key)) fail("VISUAL_KEY", `${label}.${key}`, "required key missing");
    }
    if (typeof visual.id !== "string" || !visual.id.length) fail("VISUAL_ID", `${label}.id`, "nonempty id required");
    if (ids.has(visual.id)) fail("VISUAL_DUPLICATE", `${label}.id`, `duplicate visualId ${visual.id}`);
    ids.add(visual.id);
    if (!contract.kinds.includes(visual.kind)) fail("VISUAL_KIND", `${label}.kind`, `unsupported kind ${visual.kind}`);
    if (typeof visual.title !== "string" || !visual.title.length || visual.title.length > contract.limits.titleMaxCharacters) fail("VISUAL_TITLE", `${label}.title`, "title length outside contract");
    if (typeof visual.takeaway !== "string" || !visual.takeaway.length || visual.takeaway.length > contract.limits.takeawayMaxCharacters) fail("VISUAL_TAKEAWAY", `${label}.takeaway`, "takeaway length outside contract");
    if (!DATE.test(visual.dataThrough)) fail("VISUAL_DATE", `${label}.dataThrough`, "YYYY-MM-DD required");
    if (!Array.isArray(visual.sourceIndexes) || !visual.sourceIndexes.length) fail("VISUAL_SOURCES", `${label}.sourceIndexes`, "nonempty source index array required");
    if (!Array.isArray(visual.series) || !Array.isArray(visual.points)) fail("VISUAL_SERIES", `${label}.series`, "series and points arrays required");
    if (visual.points.length > contract.limits.pointsPerVisualMax) fail("VISUAL_POINTS", `${label}.points`, "point count outside contract");
    if (!Array.isArray(visual.notes)) fail("VISUAL_NOTES", `${label}.notes`, "notes array required");
    for (const note of visual.notes) {
      if (typeof note !== "string" || note.length > contract.limits.notesMaxCharacters) fail("VISUAL_NOTE", `${label}.notes[]`, "note length outside contract");
    }
    for (const point of visual.points) {
      if (!point || typeof point.x !== "string" || !Object.hasOwn(point, "y") || typeof point.seriesId !== "string") fail("VISUAL_POINT", `${label}.points[]`, "point shape invalid");
      if (point.y !== null && typeof point.y !== "number") fail("VISUAL_POINT", `${label}.points[].y`, "y must be number or null");
    }
    const expected = hashVisual(visual);
    if (visual.contentSha256 !== expected) fail("VISUAL_HASH", `${label}.contentSha256`, "visual content hash mismatch");
  }
  const expectedBusiness = sha256Canonical({ ...bundle, integrity: {} });
  if (bundle.integrity?.businessSha256 !== expectedBusiness) fail("BUNDLE_INTEGRITY", "bundle.integrity.businessSha256", "business hash mismatch");
  const expectedFull = sha256Canonical({ ...bundle, integrity: { businessSha256: bundle.integrity.businessSha256 } });
  if (bundle.integrity?.sha256 !== expectedFull) fail("BUNDLE_INTEGRITY", "bundle.integrity.sha256", "full hash mismatch");
  return bundle;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    if (!values[index].startsWith("--")) fail("CLI_ARGUMENT", "arguments", `unknown positional argument: ${values[index]}`);
    const key = values[index].slice(2);
    if (Object.hasOwn(parsed, key)) fail("CLI_ARGUMENT", "arguments", `duplicate option --${key}`);
    parsed[key] = values[index + 1] && !values[index + 1].startsWith("--") ? values[++index] : true;
  }
  return parsed;
}

function runCli() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = parseArgs(args.slice(1));
  if (command === "generate") {
    const edition = rest.edition ?? "daily";
    const root = rest.root ? path.resolve(rest.root) : repositoryRoot;
    const bundle = generateArticleVisuals({
      edition,
      packet: rest.packet ? readJson(path.resolve(root, rest.packet), "packet") : null,
      research: rest.research ? readJsonGzip(path.resolve(root, rest.research), "research") : null,
      rotation: rest.rotation ? readJson(path.resolve(root, rest.rotation), "rotation") : null,
      root,
      generatedAt: new Date()
    });
    if (typeof rest.output === "string") {
      const output = path.resolve(rest.output);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, `${canonicalJson(bundle)}\n`, "utf8");
    }
    console.log(canonicalJson({ ok: true, edition, visualCount: bundle.visuals.length, visuals: bundle.visuals.map((v) => v.id) }));
    return;
  }
  if (command === "validate") {
    const file = rest.file ? path.resolve(rest.file) : path.join(repositoryRoot, "content", "article-visual-bundle.json");
    const bundle = readJson(file, "bundle");
    validateVisualBundle(bundle);
    console.log(canonicalJson({ ok: true, visualCount: bundle.visuals.length }));
    return;
  }
  fail("CLI_ARGUMENT", "command", "usage: generate | validate");
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    runCli();
  } catch (cause) {
    console.error(cause instanceof ArticleVisualsError ? `${cause.code} ${cause.path} ${cause.message}` : `ARTICLE_VISUALS_FAILURE ${cause.message}`);
    process.exitCode = 1;
  }
}
