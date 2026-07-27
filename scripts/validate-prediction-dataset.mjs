import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const root = process.cwd();
const datasetsRoot = path.join(root, "models", "sector-rotation", "datasets");
const schemaPath = path.join(root, "schemas", "prediction-dataset.schema.json");
const fixtureIndex = process.argv.indexOf("--fixture");
const fail = (message) => { throw new Error(`[prediction-dataset] ${message}`); };
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const required = (value, keys, label) => { for (const key of keys) if (!(key in value)) fail(`${label}.${key} missing`); };
const num = (value, label) => { const valueAsNumber = Number(value); if (!Number.isFinite(valueAsNumber)) fail(`${label} must be finite`); return valueAsNumber; };

function parsePanel(file, manifest) {
  const compressed = readFileSync(file);
  if (sha256(compressed) !== manifest.panel.sha256) fail("panel SHA-256 mismatch");
  const raw = gunzipSync(compressed);
  if (sha256(raw) !== manifest.panel.uncompressedSha256) fail("uncompressed panel SHA-256 mismatch");
  const lines = raw.toString("utf8").split("\n").filter(Boolean);
  const columns = lines[0].split(",");
  if (JSON.stringify(columns) !== JSON.stringify(manifest.panel.columns)) fail("panel column contract mismatch");
  const rows = lines.slice(1).map((line, index) => {
    const cells = line.split(",");
    if (cells.length !== columns.length) fail(`panel CSV row ${index + 2} has wrong field count`);
    return Object.fromEntries(columns.map((column, columnIndex) => [column, cells[columnIndex] === "" ? null : cells[columnIndex]]));
  });
  if (rows.length !== manifest.panel.rows) fail("manifest panel.rows mismatch");
  return rows;
}

function verifySnapshot(entry) {
  const snapshot = path.join(datasetsRoot, entry.path);
  const manifestPath = path.join(snapshot, "manifest.json");
  if (!existsSync(manifestPath)) fail(`snapshot manifest missing: ${entry.datasetId}`);
  const manifestBytes = readFileSync(manifestPath);
  if (sha256(manifestBytes) !== entry.manifestSha256) fail(`manifest SHA-256 mismatch: ${entry.datasetId}`);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  required(manifest, ["schemaVersion", "datasetId", "status", "market", "benchmark", "calendar", "contracts", "panel", "maturity", "quality", "sourceManifest"], "manifest");
  if (manifest.schemaVersion !== 1 || manifest.datasetId !== entry.datasetId || path.basename(snapshot) !== manifest.datasetId) fail("dataset identity mismatch");
  if (!/^[a-f0-9]{64}$/.test(manifest.panel.sha256) || manifest.panel.sectors !== 12 || manifest.benchmark.code !== "000985") fail("invalid fixed A-share manifest fields");
  if (manifest.contracts.labels !== "a-share-labels-v1" || manifest.contracts.features !== "a-share-price-volume-v2") fail("contract version mismatch");
  const sourcePath = path.join(snapshot, manifest.sourceManifest.path);
  if (!existsSync(sourcePath) || sha256(readFileSync(sourcePath)) !== manifest.sourceManifest.sha256) fail("source manifest SHA-256 mismatch");
  const source = readJson(sourcePath);
  if (!Array.isArray(source.files) || source.files.some((item) => !/^[a-f0-9]{64}$/.test(item.sha256))) fail("source hashes incomplete");
  if (!Array.isArray(source.marketCalendarDays) || sha256(Buffer.from(JSON.stringify(source.marketCalendarDays))) !== source.marketCalendarSha256) fail("market calendar source hash mismatch");
  const positions = new Map(source.marketCalendarDays.map((date, index) => [date, index]));
  const rows = parsePanel(path.join(snapshot, manifest.panel.path), manifest);
  const taxonomy = readJson(path.join(root, "models", "sector-rotation", "taxonomy.a-core12-v2.json"));
  const universe = new Set(taxonomy.indices.map((item) => item.code));
  if (universe.has("000985")) fail("benchmark entered ranked universe");
  const dates = new Map();
  let previous = "";
  for (const row of rows) {
    const key = `${row.date}|${row.code}`;
    if (dates.has(key)) fail("duplicate date+code key");
    dates.set(key, row);
    if (previous && key < previous) fail("panel is not stably sorted by date/code");
    previous = key;
  }
  const grouped = new Map();
  for (const row of rows) grouped.set(row.date, [...(grouped.get(row.date) ?? []), row]);
  for (const [date, dateRows] of grouped) {
    if (dateRows.length !== 12 || new Set(dateRows.map((row) => row.code)).size !== 12 || dateRows.some((row) => !universe.has(row.code))) fail(`formal date has incomplete ranked universe: ${date}`);
    for (const horizon of [1, 5, 20]) {
      const suffix = String(horizon);
      const targetDate = dateRows[0][`targetDate${suffix}`];
      if (dateRows.some((row) => row[`targetDate${suffix}`] !== targetDate)) fail(`targetDate differs within cross-section ${date} h${horizon}`);
      if (targetDate === null) {
        for (const row of dateRows) for (const field of [`absoluteUp${suffix}`, `outperformance${suffix}`, `topQuartile${suffix}`, `expectedExcess${suffix}`]) if (row[field] !== null) fail(`immature null written as label: ${field}`);
        continue;
      }
      if (!(date < targetDate) || positions.get(targetDate) !== positions.get(date) + horizon) fail(`wrong target-date trading-session advance for ${date} h${horizon}`);
      const ranked = dateRows.map((row) => {
        const sector = num(row[`sectorEndClose${suffix}`], "sector end") / num(row[`sectorStartClose${suffix}`], "sector start") - 1;
        const benchmark = num(row[`benchmarkEndClose${suffix}`], "benchmark end") / num(row[`benchmarkStartClose${suffix}`], "benchmark start") - 1;
        const excess = sector - benchmark;
        if (Math.abs(num(row[`sectorForwardReturn${suffix}`], "sector return") - sector) > 1e-12 || Math.abs(num(row[`benchmarkForwardReturn${suffix}`], "benchmark return") - benchmark) > 1e-12 || Math.abs(num(row[`expectedExcess${suffix}`], "expected excess") - excess) > 1e-12) fail("return label mismatch");
        if (num(row[`absoluteUp${suffix}`], "absoluteUp") !== Number(sector > 0)) fail("wrong absolute label");
        if (num(row[`outperformance${suffix}`], "outperformance") !== Number(excess > 0)) fail("wrong outperformance label");
        return { row, excess };
      }).sort((left, right) => right.excess - left.excess || left.row.code.localeCompare(right.row.code));
      const topCount = Math.ceil(ranked.length * 0.25);
      ranked.forEach(({ row }, index) => {
        if (num(row[`realizedRank${suffix}`], "realizedRank") !== index + 1 || num(row[`topQuartile${suffix}`], "topQuartile") !== Number(index < topCount)) fail("wrong top-quartile tie-break or rank");
      });
    }
  }
  return manifest;
}

if (fixtureIndex >= 0) {
  const fixture = readJson(path.resolve(root, process.argv[fixtureIndex + 1]));
  fail(`fixture ${fixture.name} rejected: ${fixture.expectFailure}`);
}
if (!existsSync(schemaPath)) fail("prediction dataset schema missing");
readJson(schemaPath);
const index = readJson(path.join(datasetsRoot, "index.json"));
if (index.schemaVersion !== 1 || !Array.isArray(index.datasets)) fail("dataset index schema invalid");
const identities = new Set();
for (const entry of index.datasets) {
  required(entry, ["datasetId", "market", "status", "path", "panelSha256", "manifestSha256"], "index entry");
  if (identities.has(entry.datasetId)) fail("duplicate dataset id in index");
  identities.add(entry.datasetId);
  verifySnapshot(entry);
}
if (!Array.isArray(index.legacyProduction) || !index.legacyProduction.some((item) => item.status === "reproduction_unavailable" && item.featureDataSha256 === "83d693e8f4c01dc7f50cd53f53aae66a860a428dac1449617aea0ad8a54432be")) fail("legacy production reproduction-unavailable registry missing");
console.log(`prediction datasets validated: ${index.datasets.length} immutable snapshots`);
