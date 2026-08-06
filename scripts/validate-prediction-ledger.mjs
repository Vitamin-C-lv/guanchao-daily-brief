#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function walk(root, suffix) {
  const results = [];
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) results.push(...walk(path, suffix));
    else if (path.endsWith(suffix)) results.push(path);
  }
  return results.sort();
}

function json(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function validator(schemaName) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/u);
  ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T/u);
  ajv.addFormat("uri", /^https?:\/\//u);
  return ajv.compile(json(join(REPO_ROOT, "schemas", schemaName)));
}

function assertSchema(validate, value, label) {
  if (!validate(value)) {
    throw new Error(`${label} schema failed: ${JSON.stringify(validate.errors)}`);
  }
}

export function validateLedger({
  ledgerRoot = join(REPO_ROOT, "data", "prediction-ledger"),
  publicRoot = join(REPO_ROOT, "public", "data", "prediction-history"),
  reviewPath = join(REPO_ROOT, "content", "prediction-review-latest.json"),
} = {}) {
  const snapshotSchema = validator("prediction-snapshot.schema.json");
  const contractSchema = validator("prediction-ledger-contract.schema.json");
  const evaluationSchema = validator("prediction-evaluation.schema.json");
  const indexSchema = validator("prediction-ledger-index.schema.json");
  const reviewSchema = validator("prediction-weekly-review.schema.json");
  const publicSchema = validator("prediction-public-shard.schema.json");
  const snapshotFiles = walk(join(ledgerRoot, "snapshots"), ".json.gz");
  const evaluationFiles = walk(join(ledgerRoot, "evaluations"), ".json.gz");
  let predictionCount = 0;
  let stateCount = 0;
  const publicationVersions = new Set();
  assertSchema(contractSchema, json(join(ledgerRoot, "contract.json")), "ledger contract");
  for (const path of snapshotFiles) {
    const compressed = readFileSync(path);
    if (compressed.readUInt32LE(4) !== 0 || (compressed[3] & 0x08) !== 0) throw new Error(`nondeterministic gzip: ${relative(ledgerRoot, path)}`);
    const document = JSON.parse(gunzipSync(compressed).toString("utf8"));
    assertSchema(snapshotSchema, document, relative(ledgerRoot, path));
    predictionCount += document.predictions.length;
    stateCount += document.states?.length ?? 0;
    publicationVersions.add(`${document.dataAsOf}\u0000${document.createdAt}`);
  }
  for (const path of evaluationFiles) {
    const compressed = readFileSync(path);
    if (compressed.readUInt32LE(4) !== 0 || (compressed[3] & 0x08) !== 0) throw new Error(`nondeterministic gzip: ${relative(ledgerRoot, path)}`);
    assertSchema(evaluationSchema, JSON.parse(gunzipSync(compressed).toString("utf8")), relative(ledgerRoot, path));
  }
  const index = json(join(ledgerRoot, "index.json"));
  assertSchema(indexSchema, index, "ledger index");
  if (index.snapshotCount !== snapshotFiles.length || index.evaluationEventCount !== evaluationFiles.length || index.predictionRecordCount !== predictionCount || index.stateRecordCount !== stateCount) {
    throw new Error("ledger index counts do not match immutable files");
  }
  const currentPublication = json(join(REPO_ROOT, "content", "sector-rotation.json"));
  const publicationDate = String(currentPublication.generatedAt || "").slice(0, 10);
  if (!publicationVersions.has(`${publicationDate}\u0000${currentPublication.generatedAt}`)) {
    throw new Error("current prediction publication has no matching immutable ledger snapshot");
  }
  for (const month of index.months) {
    const manifestPath = join(ledgerRoot, month.manifestPath);
    if (sha256(readFileSync(manifestPath)) !== month.manifestSha256) throw new Error(`manifest hash mismatch: ${month.manifestPath}`);
    const manifest = json(manifestPath);
    for (const entry of manifest.entries) {
      const artifact = join(ledgerRoot, entry.path);
      if (!statSync(artifact).isFile() || sha256(readFileSync(artifact)) !== entry.sha256) throw new Error(`manifest artifact mismatch: ${entry.path}`);
    }
  }
  assertSchema(reviewSchema, json(reviewPath), "latest weekly review");
  const publicIndex = json(join(publicRoot, "index.json"));
  if (publicIndex.recordCount !== index.predictionRecordCount + (index.stateRecordCount ?? 0) || publicIndex.policy.recordLimit !== null) throw new Error("public history is truncated");
  for (const file of publicIndex.files) {
    const shardPath = join(publicRoot, file.path);
    const shard = json(shardPath);
    assertSchema(publicSchema, shard, file.path);
    if (sha256(readFileSync(shardPath)) !== file.sha256) throw new Error(`public shard hash mismatch: ${file.path}`);
    const serialized = JSON.stringify(shard);
    for (const field of ["codeCommit", "sourceHashes", "integrity", "localPath"]) {
      if (serialized.includes(`\"${field}\"`)) throw new Error(`public shard leaks ${field}`);
    }
  }
  return {
    ok: true,
    contractVersion: index.contractVersion,
    snapshotCount: snapshotFiles.length,
    predictionRecordCount: index.predictionRecordCount,
    evaluationEventCount: evaluationFiles.length,
    publicShardCount: publicIndex.files.length,
  };
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(validateLedger(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
