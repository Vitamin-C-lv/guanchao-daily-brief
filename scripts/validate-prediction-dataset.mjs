import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";

const HORIZONS = [1, 5, 20];
const FEATURE_COLUMNS = [
  "momentum5", "momentum20", "momentum60", "reversal1", "volatility20", "drawdown60",
  "amountRatio5v20", "volumeRatio5v20", "priceVolumeAcceleration",
];
const MODEL_COLUMNS = FEATURE_COLUMNS.map((feature) => `cs_${feature}`);
const LABEL_COLUMNS = HORIZONS.flatMap((horizon) => {
  const suffix = String(horizon);
  return [
    `targetDate${suffix}`, `horizonSessions${suffix}`, `sectorStartClose${suffix}`, `sectorEndClose${suffix}`,
    `benchmarkStartClose${suffix}`, `benchmarkEndClose${suffix}`, `sectorForwardReturn${suffix}`,
    `benchmarkForwardReturn${suffix}`, `excessForwardReturn${suffix}`, `absoluteUp${suffix}`,
    `outperformance${suffix}`, `topQuartile${suffix}`, `expectedExcess${suffix}`, `realizedRank${suffix}`,
    `realizedRankPercentile${suffix}`,
  ];
});
export const PANEL_COLUMNS = ["date", "code", "name", ...FEATURE_COLUMNS, ...MODEL_COLUMNS, ...LABEL_COLUMNS];

const SHA256 = /^[a-f0-9]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const TEXT_HASH_MODE = "utf8-canonical-lf-v1";
export const BINARY_HASH_MODE = "raw-bytes-v1";
const fail = (message) => { throw new Error(`[prediction-dataset] ${message}`); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(value, artifact = "text artifact") {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail(`UTF-8 BOM is not allowed [artifact=${artifact} hashMode=${TEXT_HASH_MODE}]`);
  }
  try {
    return decoder.decode(bytes);
  } catch (error) {
    fail(`invalid UTF-8 text [artifact=${artifact} hashMode=${TEXT_HASH_MODE}]`);
  }
}

export function canonicalTextBytes(value, artifact = "text artifact") {
  const normalized = decodeUtf8(value, artifact).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return Buffer.from(`${normalized.replace(/\n*$/u, "")}\n`, "utf8");
}

export function sha256Binary(value) {
  return sha256(value);
}

export function sha256CanonicalText(value, artifact = "text artifact") {
  return sha256(canonicalTextBytes(value, artifact));
}

const readJson = (file) => JSON.parse(decodeUtf8(readFileSync(file), file));
const equalCanonical = (left, right) => Buffer.compare(canonicalJson(left), canonicalJson(right)) === 0;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
}

function required(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of keys) if (!(key in value)) fail(`${label}.${key} missing`);
}

function hash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} must be a 64-character SHA-256`);
  return value;
}

function number(value, label) {
  if (value === null || value === "" || value === undefined) fail(`${label} must be finite`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) fail(`${label} must be finite`);
  return parsed;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (quoted) fail("panel CSV contains an unterminated quoted field");
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeCsv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function serializePanel(rows, columns = PANEL_COLUMNS) {
  return Buffer.from(
    [columns, ...rows.map((row) => columns.map((column) => escapeCsv(row[column])))]
      .map((cells) => cells.join(","))
      .join("\n") + "\n",
    "utf8",
  );
}

export function parsePanel(file, manifest) {
  const compressed = readFileSync(file);
  if (compressed.length < 10 || (compressed[3] & 0x08) !== 0 || compressed.readUInt32LE(4) !== 0) {
    fail("snapshot gzip must use mtime=0 and an empty filename");
  }
  const compressedHash = sha256Binary(compressed);
  if (compressedHash !== manifest.panel.sha256) {
    fail(`panel SHA-256 mismatch [artifact=${file} hashMode=${BINARY_HASH_MODE} expected=${manifest.panel.sha256} actual=${compressedHash}]`);
  }
  const raw = gunzipSync(compressed);
  const rawHash = sha256Binary(raw);
  if (rawHash !== manifest.panel.uncompressedSha256) {
    fail(`uncompressed panel SHA-256 mismatch [artifact=${file} hashMode=${BINARY_HASH_MODE} expected=${manifest.panel.uncompressedSha256} actual=${rawHash}]`);
  }
  if (raw.length !== manifest.panel.uncompressedBytes || compressed.length !== manifest.panel.compressedBytes) {
    fail("panel byte count mismatch");
  }
  const csvRows = parseCsv(raw.toString("utf8"));
  if (csvRows.length < 2) fail("panel CSV must contain a header and rows");
  const columns = csvRows[0];
  if (!equalCanonical(columns, PANEL_COLUMNS) || !equalCanonical(columns, manifest.panel.columns)) {
    fail("panel column contract mismatch");
  }
  const rows = csvRows.slice(1).map((cells, index) => {
    if (cells.length !== columns.length) fail(`panel CSV row ${index + 2} has wrong field count`);
    return Object.fromEntries(columns.map((column, columnIndex) => [column, cells[columnIndex] === "" ? null : cells[columnIndex]]));
  });
  if (rows.length !== manifest.panel.rows) fail("manifest panel.rows mismatch");
  if (new Set(rows.map((row) => row.date)).size !== manifest.panel.dates) fail("manifest panel.dates mismatch");
  return { rows, raw, compressed };
}

function compileSchema(repositoryRoot) {
  const schemaPath = path.join(repositoryRoot, "schemas", "prediction-dataset.schema.json");
  if (!existsSync(schemaPath)) fail("prediction dataset schema missing");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(schemaPath));
}

function assertSchema(manifest, validate) {
  if (validate(manifest)) return;
  const errors = (validate.errors ?? []).map((error) => {
    const instancePath = error.instancePath || "/";
    return `${instancePath} ${error.keyword} ${error.message}`;
  });
  fail(`manifest schema validation failed: ${errors.join("; ")}`);
}

function verifySourceFiles(source) {
  required(source, ["schemaVersion", "featureFile", "files", "rankedUniverse", "marketCalendarDays", "marketCalendarSha256"], "sourceManifest");
  if (source.schemaVersion !== 1 || !Array.isArray(source.files) || source.files.length === 0) {
    fail("source manifest schema invalid");
  }
  const seen = new Set();
  for (const item of source.files) {
    required(item, ["kind", "path", "bytes", "sha256", "fullFileSha256", "usedContentSha256", "usedRows", "usedStart", "usedEnd"], "source file");
    if (typeof item.kind !== "string" || !item.kind || typeof item.path !== "string" || !item.path) fail("source manifest file path/kind invalid");
    const key = `${item.kind}\u0000${item.path}`;
    if (seen.has(key)) fail("source manifest contains duplicate path/kind entries");
    seen.add(key);
    hash(item.sha256, "source sha256");
    hash(item.fullFileSha256, "source fullFileSha256");
    hash(item.usedContentSha256, "source usedContentSha256");
    if (!Number.isInteger(item.bytes) || item.bytes < 0 || !Number.isInteger(item.usedRows) || item.usedRows < 0) {
      fail("source manifest bytes/usedRows invalid");
    }
    for (const field of ["usedStart", "usedEnd"]) if (item[field] !== null && (typeof item[field] !== "string" || !DATE.test(item[field]))) fail(`source ${field} invalid`);
  }
  const matches = source.files.filter((item) => equalCanonical(item, source.featureFile));
  if (matches.length !== 1 || source.featureFile.kind !== "feature-panel") {
    fail("sourceManifest.featureFile does not match exactly one feature-panel file");
  }
  if (!Array.isArray(source.marketCalendarDays) || source.marketCalendarDays.some((date) => typeof date !== "string" || !DATE.test(date))) {
    fail("source market calendar is invalid");
  }
  const sorted = [...source.marketCalendarDays].sort();
  if (!equalCanonical(sorted, source.marketCalendarDays) || new Set(source.marketCalendarDays).size !== source.marketCalendarDays.length) {
    fail("source market calendar must be unique and sorted");
  }
  if (sha256(canonicalJson(source.marketCalendarDays)) !== source.marketCalendarSha256) fail("source manifest market calendar hash mismatch");
}

function assertIndexEntry(entry) {
  required(entry, ["datasetId", "market", "creationStatus", "lifecycleStatus", "statusHistory", "path", "panelSha256", "manifestSha256"], "index entry");
  if (entry.market !== "A_SHARE" || !SHA256.test(entry.panelSha256) || !SHA256.test(entry.manifestSha256)) fail("index entry fixed fields invalid");
  if (!["candidate", "active", "legacy_recovered"].includes(entry.creationStatus)) fail("index creationStatus invalid");
  if (!["candidate", "active", "superseded", "retired", "legacy_recovered"].includes(entry.lifecycleStatus)) fail("index lifecycleStatus invalid");
  if (!Array.isArray(entry.statusHistory) || entry.statusHistory.length === 0) fail("index statusHistory missing");
  const transitions = { candidate: new Set(["active", "superseded"]), active: new Set(["retired"]) };
  let current = null;
  for (const event of entry.statusHistory) {
    required(event, ["from", "to", "changedAt", "codeCommit", "reason"], "index statusHistory event");
    if (event.from !== current || typeof event.to !== "string" || typeof event.reason !== "string" || !event.reason.trim() || !/^[a-f0-9]{40}$/.test(event.codeCommit)) {
      fail("index statusHistory is invalid");
    }
    if (current === null && event.to !== entry.creationStatus) fail("index statusHistory initial state mismatch");
    if (current !== null && !transitions[current]?.has(event.to)) fail("index statusHistory illegal lifecycle transition");
    current = event.to;
  }
  if (current !== entry.lifecycleStatus) fail("index lifecycleStatus does not match statusHistory");
}

function labelDiagnostics(rows) {
  const grouped = new Map();
  for (const row of rows) grouped.set(row.date, [...(grouped.get(row.date) ?? []), row]);
  const horizons = {};
  for (const horizon of HORIZONS) {
    const suffix = String(horizon);
    const matureDates = [...grouped.entries()].filter(([, dateRows]) => dateRows[0][`targetDate${suffix}`] !== null).map(([date]) => date);
    const mature = matureDates.flatMap((date) => grouped.get(date));
    const rate = (field) => mature.length ? mature.reduce((total, row) => total + number(row[`${field}${suffix}`], field), 0) / mature.length : null;
    horizons[suffix] = {
      matureRows: mature.length,
      matureDates: matureDates.length,
      absoluteUpPositiveRate: rate("absoluteUp"),
      outperformancePositiveRate: rate("outperformance"),
      topQuartilePositiveRate: rate("topQuartile"),
      crossSectionSizeMin: matureDates.length ? Math.min(...matureDates.map((date) => grouped.get(date).length)) : 0,
      crossSectionSizeMax: matureDates.length ? Math.max(...matureDates.map((date) => grouped.get(date).length)) : 0,
    };
  }
  return { schemaVersion: 1, horizons };
}

function maturitySummary(rows) {
  const grouped = new Map();
  for (const row of rows) grouped.set(row.date, [...(grouped.get(row.date) ?? []), row]);
  const maturity = {};
  const missing = {};
  for (const horizon of HORIZONS) {
    const suffix = String(horizon);
    const matureDates = [...grouped.entries()].filter(([, dateRows]) => dateRows[0][`targetDate${suffix}`] !== null).map(([date]) => date);
    const matureRows = matureDates.reduce((total, date) => total + grouped.get(date).length, 0);
    const positives = matureDates.flatMap((date) => grouped.get(date)).reduce((total, row) => total + number(row[`topQuartile${suffix}`], "topQuartile"), 0);
    const targetDates = matureDates.map((date) => grouped.get(date)[0][`targetDate${suffix}`]);
    maturity[suffix] = {
      matureDates: matureDates.length,
      matureRows,
      immatureDates: grouped.size - matureDates.length,
      firstTargetDate: targetDates.length ? [...targetDates].sort()[0] : null,
      lastTargetDate: targetDates.length ? [...targetDates].sort().at(-1) : null,
      topQuartilePositiveRate: matureRows ? positives / matureRows : null,
    };
    missing[suffix] = rows.length - matureRows;
  }
  return { maturity, missing };
}

function verifyRows(rows, manifest, source, repositoryRoot) {
  const taxonomyPath = path.join(repositoryRoot, "models", "sector-rotation", "taxonomy.a-core12-v2.json");
  const taxonomy = readJson(taxonomyPath);
  const universe = new Set(taxonomy.indices.map((item) => item.code));
  const rankedUniverse = source.rankedUniverse;
  required(rankedUniverse, ["taxonomyId", "codes"], "source rankedUniverse");
  if (!Array.isArray(rankedUniverse.codes)) fail("source ranked universe codes invalid");
  if (rankedUniverse.codes.includes(manifest.benchmark.code)) fail("benchmark entered ranked universe");
  if (!equalCanonical([...rankedUniverse.codes].sort(), [...universe].sort())) fail("source ranked universe does not match taxonomy");
  const keys = new Set();
  let previous = "";
  const grouped = new Map();
  for (const row of rows) {
    const key = `${row.date}|${row.code}`;
    if (keys.has(key)) fail("duplicate date+code key");
    keys.add(key);
    if (previous && key < previous) fail("panel is not stably sorted by date/code");
    previous = key;
    grouped.set(row.date, [...(grouped.get(row.date) ?? []), row]);
  }
  const positions = new Map(source.marketCalendarDays.map((date, index) => [date, index]));
  for (const [date, dateRows] of grouped) {
    const codes = new Set(dateRows.map((row) => row.code));
    if (dateRows.length !== 12 || codes.size !== 12 || [...codes].some((code) => !universe.has(code))) {
      fail(`formal date has incomplete ranked universe: ${date}`);
    }
    if (!positions.has(date)) fail(`feature date is absent from source calendar: ${date}`);
    for (const horizon of HORIZONS) {
      const suffix = String(horizon);
      const targetDate = dateRows[0][`targetDate${suffix}`];
      if (dateRows.some((row) => row[`targetDate${suffix}`] !== targetDate)) fail(`target date differs within cross-section: ${date} h${horizon}`);
      const horizonFields = LABEL_COLUMNS.filter((field) => field.endsWith(suffix));
      if (targetDate === null) {
        if (dateRows.some((row) => horizonFields.some((field) => row[field] !== null))) fail(`immature label is not null: ${date} h${horizon}`);
        continue;
      }
      if (!(date < targetDate) || positions.get(targetDate) !== positions.get(date) + horizon) {
        fail(`wrong target-date trading-session advance for ${date} h${horizon}`);
      }
      const ranked = dateRows.map((row) => {
        for (const field of horizonFields) if (row[field] === null) fail(`mature label field is null: ${date} ${field}`);
        if (number(row[`horizonSessions${suffix}`], "horizonSessions") !== horizon) fail(`wrong horizon session count: ${date} h${horizon}`);
        const sector = number(row[`sectorEndClose${suffix}`], "sector end") / number(row[`sectorStartClose${suffix}`], "sector start") - 1;
        const benchmark = number(row[`benchmarkEndClose${suffix}`], "benchmark end") / number(row[`benchmarkStartClose${suffix}`], "benchmark start") - 1;
        const excess = sector - benchmark;
        if (
          Math.abs(number(row[`sectorForwardReturn${suffix}`], "sector return") - sector) > 1e-12
          || Math.abs(number(row[`benchmarkForwardReturn${suffix}`], "benchmark return") - benchmark) > 1e-12
          || Math.abs(number(row[`excessForwardReturn${suffix}`], "excess return") - excess) > 1e-12
          || Math.abs(number(row[`expectedExcess${suffix}`], "expected excess") - excess) > 1e-12
        ) fail(`wrong return/excess label: ${date} ${row.code} h${horizon}`);
        if (number(row[`absoluteUp${suffix}`], "absoluteUp") !== Number(sector > 0)) fail(`wrong absolute label: ${date} ${row.code} h${horizon}`);
        if (number(row[`outperformance${suffix}`], "outperformance") !== Number(excess > 0)) fail(`wrong outperformance label: ${date} ${row.code} h${horizon}`);
        // Rank from the serialized expectedExcess value after checking that it
        // agrees with the close-derived excess.  This preserves the exact
        // deterministic order that entered the immutable panel.
        return { row, excess: number(row[`expectedExcess${suffix}`], "expected excess") };
      }).sort((left, right) => right.excess - left.excess || left.row.code.localeCompare(right.row.code));
      const topCount = Math.ceil(ranked.length * 0.25);
      ranked.forEach(({ row }, index) => {
        const rank = index + 1;
        if (number(row[`realizedRank${suffix}`], "realizedRank") !== rank || number(row[`topQuartile${suffix}`], "topQuartile") !== Number(index < topCount)) {
          fail(`wrong top-quartile tie-break or rank: ${date} ${row.code} h${horizon}`);
        }
        const percentile = 1 - index / Math.max(1, ranked.length - 1);
        if (Math.abs(number(row[`realizedRankPercentile${suffix}`], "realizedRankPercentile") - percentile) > 1e-12) {
          fail(`wrong realized rank percentile: ${date} ${row.code} h${horizon}`);
        }
      });
    }
  }
}

function identityFromManifest(manifest) {
  return {
    market: manifest.market,
    dataAsOf: manifest.dataAsOf,
    panelUncompressedSha256: manifest.panel.uncompressedSha256,
    datasetSchemaVersion: manifest.schemaVersion,
    labelContractVersion: manifest.contracts.labels,
    featureContractVersion: manifest.contracts.features,
    benchmarkContractVersion: manifest.contracts.benchmark,
    benchmarkCode: manifest.benchmark.code,
    taxonomySha256: manifest.taxonomy.canonicalSha256,
    calendarSha256: manifest.calendar.sessionCalendarSha256,
  };
}

export function verifySnapshot({ repositoryRoot, datasetsRoot, entry, schemaValidate = compileSchema(repositoryRoot) }) {
  required(entry, ["datasetId", "path", "manifestSha256"], "index entry");
  const snapshot = path.join(datasetsRoot, entry.path);
  const manifestPath = path.join(snapshot, "manifest.json");
  if (!existsSync(manifestPath)) fail(`snapshot manifest missing: ${entry.datasetId}`);
  const manifestBytes = readFileSync(manifestPath);
  const manifestHash = sha256CanonicalText(manifestBytes, manifestPath);
  if (manifestHash !== entry.manifestSha256) {
    fail(`manifest SHA-256 mismatch: ${entry.datasetId} [artifact=${manifestPath} hashMode=${TEXT_HASH_MODE} expected=${entry.manifestSha256} actual=${manifestHash}]`);
  }
  const manifest = JSON.parse(decodeUtf8(manifestBytes, manifestPath));
  assertSchema(manifest, schemaValidate);
  assertIndexEntry(entry);
  if (manifest.datasetId !== entry.datasetId || path.basename(snapshot) !== manifest.datasetId) fail("dataset identity mismatch");
  if (entry.panelSha256 !== manifest.panel.sha256) fail("index panel hash mismatch");
  if (manifest.market !== "A_SHARE" || manifest.benchmark.code !== "000985") fail("invalid fixed A-share manifest fields");
  const sourcePath = path.join(snapshot, manifest.sourceManifest.path);
  const sourceHash = existsSync(sourcePath) ? sha256CanonicalText(readFileSync(sourcePath), sourcePath) : null;
  if (sourceHash !== manifest.sourceManifest.sha256) {
    fail(`source manifest SHA-256 mismatch [artifact=${sourcePath} hashMode=${TEXT_HASH_MODE} expected=${manifest.sourceManifest.sha256} actual=${sourceHash ?? "missing"}]`);
  }
  const diagnosticsPath = path.join(snapshot, manifest.labelDiagnostics.path);
  const diagnosticsHash = existsSync(diagnosticsPath) ? sha256CanonicalText(readFileSync(diagnosticsPath), diagnosticsPath) : null;
  if (diagnosticsHash !== manifest.labelDiagnostics.sha256) {
    fail(`label diagnostics hash mismatch [artifact=${diagnosticsPath} hashMode=${TEXT_HASH_MODE} expected=${manifest.labelDiagnostics.sha256} actual=${diagnosticsHash ?? "missing"}]`);
  }
  const source = readJson(sourcePath);
  verifySourceFiles(source);
  const taxonomyPath = path.join(repositoryRoot, "models", "sector-rotation", "taxonomy.a-core12-v2.json");
  const calendarPath = path.join(repositoryRoot, "models", "sector-rotation", "cn-market-calendar-2026.json");
  const taxonomy = readJson(taxonomyPath);
  if (manifest.taxonomy.canonicalSha256 !== sha256(canonicalJson(taxonomy))) fail("taxonomy canonical hash mismatch");
  const taxonomySourceHash = sha256CanonicalText(readFileSync(taxonomyPath), taxonomyPath);
  if (manifest.taxonomy.sourceFileSha256 !== taxonomySourceHash) {
    fail(`taxonomy source file hash mismatch [artifact=${taxonomyPath} hashMode=${TEXT_HASH_MODE} expected=${manifest.taxonomy.sourceFileSha256} actual=${taxonomySourceHash}]`);
  }
  const sessionHash = sha256(canonicalJson(source.marketCalendarDays));
  if (
    manifest.calendar.sha256 !== sessionHash
    || manifest.calendar.sessionCalendarSha256 !== sessionHash
    || source.marketCalendarSha256 !== sessionHash
    || manifest.calendar.sessions !== source.marketCalendarDays.length
    || manifest.calendar.firstDate !== source.marketCalendarDays[0]
    || manifest.calendar.lastDate !== source.marketCalendarDays.at(-1)
  ) fail("calendar hash or benchmark session lineage mismatch");
  if (
    manifest.calendar.holidayArtifact.path !== "models/sector-rotation/cn-market-calendar-2026.json"
    || manifest.calendar.holidayArtifact.sha256 !== manifest.calendar.holidayArtifactSha256
    || manifest.calendar.holidayArtifact.sha256 !== sha256CanonicalText(readFileSync(calendarPath), calendarPath)
  ) {
    const holidaySourceHash = sha256CanonicalText(readFileSync(calendarPath), calendarPath);
    fail(`holiday calendar artifact lineage mismatch [artifact=${calendarPath} hashMode=${TEXT_HASH_MODE} expected=${manifest.calendar.holidayArtifact.sha256} actual=${holidaySourceHash}]`);
  }
  const identity = identityFromManifest(manifest);
  if (!equalCanonical(identity, manifest.identityComponents) || sha256(canonicalJson(identity)) !== manifest.identitySha256) fail("dataset identity mismatch");
  if (manifest.datasetId !== `a-share-${manifest.dataAsOf}-${manifest.identitySha256.slice(0, 12)}`) fail("dataset identity mismatch");
  const { rows } = parsePanel(path.join(snapshot, manifest.panel.path), manifest);
  verifyRows(rows, manifest, source, repositoryRoot);
  const diagnostics = readJson(diagnosticsPath);
  if (!equalCanonical(diagnostics, labelDiagnostics(rows))) fail("label diagnostics content mismatch");
  const { maturity, missing } = maturitySummary(rows);
  if (!equalCanonical(manifest.maturity, maturity) || !equalCanonical(manifest.quality.missingLabelValuesByHorizon, missing)) {
    fail("manifest maturity summary mismatch");
  }
  return manifest;
}

export function verifyDatasetRoot({ repositoryRoot = process.cwd(), datasetsRoot = path.join(repositoryRoot, "models", "sector-rotation", "datasets") } = {}) {
  const indexPath = path.join(datasetsRoot, "index.json");
  if (!existsSync(indexPath)) fail("dataset index missing");
  const index = readJson(indexPath);
  required(index, ["schemaVersion", "datasets", "legacyProduction"], "dataset index");
  if (index.schemaVersion !== 1 || !Array.isArray(index.datasets) || !Array.isArray(index.legacyProduction)) fail("dataset index schema invalid");
  const identities = new Set();
  const schemaValidate = compileSchema(repositoryRoot);
  for (const entry of index.datasets) {
    if (identities.has(entry.datasetId)) fail("duplicate dataset id in index");
    identities.add(entry.datasetId);
    verifySnapshot({ repositoryRoot, datasetsRoot, entry, schemaValidate });
  }
  if (!index.legacyProduction.some((item) => item.status === "reproduction_unavailable" && item.featureDataSha256 === "83d693e8f4c01dc7f50cd53f53aae66a860a428dac1449617aea0ad8a54432be")) {
    fail("legacy production reproduction-unavailable registry missing");
  }
  return index;
}

function main() {
  const root = process.cwd();
  const datasetsIndex = process.argv.indexOf("--datasets-root");
  const datasetsRoot = datasetsIndex >= 0 ? path.resolve(root, process.argv[datasetsIndex + 1]) : path.join(root, "models", "sector-rotation", "datasets");
  const index = verifyDatasetRoot({ repositoryRoot: root, datasetsRoot });
  console.log(`prediction datasets validated: ${index.datasets.length} immutable snapshots`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
