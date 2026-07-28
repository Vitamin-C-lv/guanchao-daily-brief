import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { parsePanel, serializePanel, verifyDatasetRoot } from "./validate-prediction-dataset.mjs";

const repositoryRoot = process.cwd();
const sourceDatasetsRoot = path.join(repositoryRoot, "models", "sector-rotation", "datasets");
const fixtureRoot = path.join(repositoryRoot, "scripts", "fixtures", "prediction-dataset");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function sortedValue(value) {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedValue(value[key])]));
  return value;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(sortedValue(value), null, 2)}\n`, "utf8");
}

function setPath(target, dotted, value) {
  const keys = dotted.split(".");
  const leaf = keys.pop();
  let cursor = target;
  for (const key of keys) {
    if (!(key in cursor)) cursor[key] = {};
    cursor = cursor[key];
  }
  const before = cursor[leaf];
  cursor[leaf] = value;
  return before !== value;
}

function deletePath(target, dotted) {
  const keys = dotted.split(".");
  const leaf = keys.pop();
  let cursor = target;
  for (const key of keys) {
    if (!cursor || !(key in cursor)) return false;
    cursor = cursor[key];
  }
  if (!(leaf in cursor)) return false;
  delete cursor[leaf];
  return true;
}

function treeDigest(directory) {
  const digest = createHash("sha256");
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const item = path.join(current, name);
      const relative = path.relative(directory, item).replaceAll("\\", "/");
      const stat = statSync(item);
      if (stat.isDirectory()) walk(item);
      else {
        digest.update(relative);
        digest.update("\0");
        digest.update(readFileSync(item));
        digest.update("\0");
      }
    }
  };
  walk(directory);
  return digest.digest("hex");
}

function makeTemporaryDatasetRoot(datasetId) {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "guanchao-prediction-dataset-fixture-"));
  const datasetsRoot = path.join(temporary, "datasets");
  const sourceIndex = JSON.parse(readFileSync(path.join(sourceDatasetsRoot, "index.json"), "utf8"));
  const entry = sourceIndex.datasets.find((item) => item.datasetId === datasetId);
  assert.ok(entry, `fixture base dataset must exist: ${datasetId}`);
  const sourceSnapshot = path.join(sourceDatasetsRoot, entry.path);
  const destination = path.join(datasetsRoot, entry.path);
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(sourceSnapshot)) {
    copyFileSync(path.join(sourceSnapshot, name), path.join(destination, name));
  }
  writeJson(path.join(datasetsRoot, "index.json"), {
    schemaVersion: 1,
    datasets: [entry],
    legacyProduction: sourceIndex.legacyProduction,
  });
  return { temporary, datasetsRoot, entry: JSON.parse(JSON.stringify(entry)), snapshot: destination };
}

function loadContext(context) {
  const manifestPath = path.join(context.snapshot, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const sourcePath = path.join(context.snapshot, manifest.sourceManifest.path);
  const diagnosticsPath = path.join(context.snapshot, manifest.labelDiagnostics.path);
  const source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const diagnostics = JSON.parse(readFileSync(diagnosticsPath, "utf8"));
  const panelPath = path.join(context.snapshot, manifest.panel.path);
  const { rows } = parsePanel(panelPath, manifest);
  return { ...context, manifestPath, sourcePath, diagnosticsPath, panelPath, manifest, source, diagnostics, rows };
}

function rowAt(rows, date, code) {
  const index = rows.findIndex((row) => row.date === date && row.code === code);
  assert.notEqual(index, -1, `fixture row must exist: ${date}/${code}`);
  return index;
}

function applyMutation(context, mutation) {
  switch (mutation.type) {
    case "duplicate-panel-row": {
      const index = rowAt(context.rows, mutation.date, mutation.code);
      context.rows.splice(index + 1, 0, { ...context.rows[index] });
      return true;
    }
    case "swap-panel-rows": {
      const left = rowAt(context.rows, mutation.left.date, mutation.left.code);
      const right = rowAt(context.rows, mutation.right.date, mutation.right.code);
      [context.rows[left], context.rows[right]] = [context.rows[right], context.rows[left]];
      return true;
    }
    case "remove-panel-row": {
      const index = rowAt(context.rows, mutation.date, mutation.code);
      context.rows.splice(index, 1);
      return true;
    }
    case "set-panel-value": {
      const index = rowAt(context.rows, mutation.date, mutation.code);
      const before = context.rows[index][mutation.field];
      context.rows[index][mutation.field] = mutation.value;
      return before !== mutation.value;
    }
    case "set-cross-section-field": {
      const matched = context.rows.filter((row) => row.date === mutation.date);
      assert.equal(matched.length, 12, "cross-section mutation requires a complete base date");
      let changed = false;
      for (const row of matched) {
        changed ||= row[mutation.field] !== mutation.value;
        row[mutation.field] = mutation.value;
      }
      return changed;
    }
    case "append-source-universe-code": {
      if (context.source.rankedUniverse.codes.includes(mutation.value)) return false;
      context.source.rankedUniverse.codes.push(mutation.value);
      return true;
    }
    case "set-manifest-value": return setPath(context.manifest, mutation.field, mutation.value);
    case "delete-manifest-value": return deletePath(context.manifest, mutation.field);
    case "set-source-value": return setPath(context.source, mutation.field, mutation.value);
    case "set-diagnostics-value": return setPath(context.diagnostics, mutation.field, mutation.value);
    default: throw new Error(`unsupported fixture mutation: ${mutation.type}`);
  }
}

function writePanel(context, updateMetadata) {
  const raw = serializePanel(context.rows);
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  compressed.writeUInt32LE(0, 4);
  compressed[3] &= ~0x08;
  writeFileSync(context.panelPath, compressed);
  if (!updateMetadata) return;
  context.manifest.panel.sha256 = sha256(compressed);
  context.manifest.panel.uncompressedSha256 = sha256(raw);
  context.manifest.panel.compressedBytes = compressed.length;
  context.manifest.panel.uncompressedBytes = raw.length;
  context.manifest.panel.rows = context.rows.length;
  context.manifest.panel.dates = new Set(context.rows.map((row) => row.date)).size;
}

function persistMutation(context, mutation) {
  if (["duplicate-panel-row", "swap-panel-rows", "remove-panel-row", "set-panel-value", "set-cross-section-field"].includes(mutation.type)) {
    writePanel(context, false);
  } else if (["set-manifest-value", "delete-manifest-value"].includes(mutation.type)) {
    writeJson(context.manifestPath, context.manifest);
  } else if (mutation.type === "append-source-universe-code" || mutation.type === "set-source-value") {
    writeJson(context.sourcePath, context.source);
  } else if (mutation.type === "set-diagnostics-value") {
    writeJson(context.diagnosticsPath, context.diagnostics);
  }
}

function refreshIdentity(context) {
  const manifest = context.manifest;
  const identity = {
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
  manifest.identityComponents = identity;
  manifest.identitySha256 = sha256(Buffer.from(JSON.stringify(sortedValue(identity)), "utf8"));
  const nextId = `a-share-${manifest.dataAsOf}-${manifest.identitySha256.slice(0, 12)}`;
  if (nextId === manifest.datasetId) return;
  const nextSnapshot = path.join(context.datasetsRoot, "a-share", nextId);
  renameSync(context.snapshot, nextSnapshot);
  context.snapshot = nextSnapshot;
  context.manifestPath = path.join(nextSnapshot, "manifest.json");
  context.sourcePath = path.join(nextSnapshot, manifest.sourceManifest.path);
  context.diagnosticsPath = path.join(nextSnapshot, manifest.labelDiagnostics.path);
  context.panelPath = path.join(nextSnapshot, manifest.panel.path);
  manifest.datasetId = nextId;
}

function rehash(context, stages, fixture) {
  for (const stage of stages) {
    if (stage === "panel") writePanel(context, true);
    else if (stage === "source") {
      writeJson(context.sourcePath, context.source);
      context.manifest.sourceManifest.sha256 = sha256(readFileSync(context.sourcePath));
    } else if (stage === "labelDiagnostics") {
      writeJson(context.diagnosticsPath, context.diagnostics);
      context.manifest.labelDiagnostics.sha256 = sha256(readFileSync(context.diagnosticsPath));
    } else if (stage === "manifest") {
      if (fixture.name !== "dataset-identity-mismatch") refreshIdentity(context);
      writeJson(context.manifestPath, context.manifest);
    } else if (stage === "index") {
      const indexPath = path.join(context.datasetsRoot, "index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const entry = index.datasets.find((item) => item.datasetId === context.entry.datasetId);
      assert.ok(entry, "fixture index entry must still exist");
      entry.datasetId = context.manifest.datasetId;
      entry.path = `a-share/${context.manifest.datasetId}`;
      entry.panelSha256 = context.manifest.panel.sha256;
      entry.manifestSha256 = sha256(readFileSync(context.manifestPath));
      context.entry.datasetId = entry.datasetId;
      writeJson(indexPath, index);
    } else {
      throw new Error(`unsupported rehash stage: ${stage}`);
    }
  }
}

function runFixture(fixture) {
  const context = loadContext(makeTemporaryDatasetRoot(fixture.baseDatasetId));
  try {
    verifyDatasetRoot({ repositoryRoot, datasetsRoot: context.datasetsRoot });
    const before = treeDigest(context.datasetsRoot);
    const changed = applyMutation(context, fixture.mutation);
    if (!changed) throw new Error(`fixture mutation did not modify any bytes: ${fixture.name}`);
    persistMutation(context, fixture.mutation);
    rehash(context, fixture.rehash ?? [], fixture);
    if (treeDigest(context.datasetsRoot) === before) throw new Error(`fixture mutation did not modify any bytes: ${fixture.name}`);
    assert.throws(
      () => verifyDatasetRoot({ repositoryRoot, datasetsRoot: context.datasetsRoot }),
      new RegExp(fixture.expectedErrorPattern),
      `fixture ${fixture.name} must fail for its declared contract reason`,
    );
  } finally {
    rmSync(context.temporary, { recursive: true, force: true });
  }
}

test("formal verifier accepts the control snapshot and rejects every real mutation", { concurrency: false }, () => {
  const control = makeTemporaryDatasetRoot("a-share-2026-07-21-3448b55c8ae4");
  try {
    assert.doesNotThrow(() => verifyDatasetRoot({ repositoryRoot, datasetsRoot: control.datasetsRoot }));
  } finally {
    rmSync(control.temporary, { recursive: true, force: true });
  }

  const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  assert.ok(packageJson.devDependencies.ajv?.startsWith("^8."));
  assert.ok(packageJson.scripts["validate:prediction-dataset"]);
  assert.ok(packageJson.scripts["test:prediction-dataset"]);
  assert.equal("rotation:train" in packageJson.scripts, false);
  assert.equal("rotation:pipeline" in packageJson.scripts, false);
  const productionModel = readFileSync(path.join(repositoryRoot, "models", "sector-rotation", "a-share-relative-probability-v2.json"));
  assert.equal(sha256(productionModel), "358e19ae3dacbfdba71db195c0171c627646f33aaadf39250fb0f7b7cbb994d8");
  const production = JSON.parse(productionModel.toString("utf8"));
  assert.equal(production.featureDataSha256, "83d693e8f4c01dc7f50cd53f53aae66a860a428dac1449617aea0ad8a54432be");
  for (const horizon of ["1", "5", "20"]) assert.equal(production.horizons[horizon].publicationStatus, "abstained");

  const noOp = loadContext(makeTemporaryDatasetRoot("a-share-2026-07-21-3448b55c8ae4"));
  try {
    const row = noOp.rows.find((item) => item.date === "2016-04-05" && item.code === "000990");
    assert.ok(row);
    assert.throws(
      () => {
        const changed = applyMutation(noOp, {
          type: "set-panel-value", date: row.date, code: row.code, field: "absoluteUp1", value: row.absoluteUp1,
        });
        if (!changed) throw new Error("fixture mutation did not modify any bytes");
      },
      /fixture mutation did not modify any bytes/,
    );
  } finally {
    rmSync(noOp.temporary, { recursive: true, force: true });
  }

  for (const filename of readdirSync(fixtureRoot).filter((name) => name.endsWith(".json")).sort()) {
    const fixture = JSON.parse(readFileSync(path.join(fixtureRoot, filename), "utf8"));
    runFixture(fixture);
  }
});
