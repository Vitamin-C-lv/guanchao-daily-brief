import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "./research-contract.mjs";
import { buildAllPackets } from "./build-market-packets.mjs";
import { resolveAutomationPaths } from "./automation-paths.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(moduleFile), "..");

function fail(message) { throw new Error(message); }

export function validateEveningPacket(packet, kind = "packet") {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)) fail(`${kind} must be an object`);
  if (typeof packet.schemaVersion !== "string" || !packet.schemaVersion.endsWith("-v1")) fail(`${kind}.schemaVersion invalid`);
  if (typeof packet.packetId !== "string" || !/^[a-f0-9]{64}$/.test(packet.packetId)) fail(`${kind}.packetId invalid`);
  const { packetId, integrity, ...body } = packet;
  const expected = sha256Canonical(body);
  if (packetId !== expected || integrity?.businessSha256 !== expected) fail(`${kind} business integrity mismatch`);
  if (kind === "DAILY_MARKET_PACKET.json") {
    if (packet.schemaVersion !== "daily-market-packet-v1") fail(`${kind} schema mismatch`);
    if (packet.writerProductName !== "观潮每日晚报") fail(`${kind} product name mismatch`);
    if (packet.writerMayBrowse !== true) fail(`${kind} writerMayBrowse must be true`);
    for (const field of ["dataAsOf", "coreIndices", "rates", "volatility", "fx", "marketBreadth", "aShareObservationBoard", "sourceHealth", "knownGaps", "anomalies", "lineage"]) if (!(field in packet)) fail(`${kind}.${field} missing`);
    if (packet.marketBreadth.status !== "unavailable" && packet.marketBreadth.status !== "ready") fail(`${kind}.marketBreadth.status invalid`);
    if (packet.marketBreadth.status === "unavailable" && typeof packet.marketBreadth.reason !== "string") fail(`${kind}.marketBreadth unavailable reason missing`);
    for (const market of ["aShare", "hk", "us"]) {
      if (!packet.coreIndices?.[market] || typeof packet.coreIndices[market] !== "object") fail(`${kind}.coreIndices.${market} missing`);
      for (const item of Object.values(packet.coreIndices?.[market] ?? {})) {
        if (!["ready", "unavailable"].includes(item.status)) fail(`${kind}.coreIndices status invalid`);
        if (item.status === "unavailable" && !item.reason) fail(`${kind}.coreIndices unavailable reason missing`);
      }
    }
    if (packet.aShareObservationBoard.some((item) => item.isProbability === true || item.outputMode !== "evidence_observation")) fail(`${kind} observation board probability boundary missing`);
    if (!Array.isArray(packet.sourceIndex) || packet.sourceIndex.some((source) => source.sha256 === null && source.present)) fail(`${kind} source lineage incomplete`);
  }
  if (kind === "PREDICTION_REVIEW_PACKET.json") {
    if (packet.schemaVersion !== "prediction-review-packet-v1") fail(`${kind} schema mismatch`);
    for (const horizon of Object.values(packet.horizons ?? {})) {
      if (horizon.evidenceObservation?.notModelAccuracy !== true) fail(`${kind} observation accuracy boundary missing`);
      if (horizon.abstained?.excludedFromModelDenominator !== true) fail(`${kind} abstention denominator boundary missing`);
      for (const row of horizon.rows ?? []) {
        if (["evidence_observation", "abstained", "not_applicable"].includes(row.classification) && row.probabilityPresent === true) fail(`${kind} non-model row carries probability: ${row.predictionId}`);
        if (!["published", "abstained", "not_applicable"].includes(row.modelPublicationStatus)) fail(`${kind} model publication status invalid: ${row.predictionId}`);
        if (!["evidence_observation", "none"].includes(row.observationStatus)) fail(`${kind} observation status invalid: ${row.predictionId}`);
        if (row.modelPublicationStatus === "published" && (!Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1)) fail(`${kind} published probability must be in [0,1]: ${row.predictionId}`);
        if (!row.evaluation || !Array.isArray(row.sourceRecordIds)) fail(`${kind} evaluation trace missing: ${row.predictionId}`);
      }
      const brier = horizon.publishedModelPrediction?.brier;
      if (brier !== null && (!Number.isFinite(brier) || brier < 0 || brier > 1)) fail(`${kind} Brier must be in [0,1]`);
      if (!Array.isArray(horizon.publishedModelPrediction?.brierRecordIds)) fail(`${kind} Brier record trace missing`);
    }
  }
  return { schemaVersion: packet.schemaVersion, packetId, status: packet.status };
}

function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const directory = path.resolve(process.argv[2] ?? path.join(resolveAutomationPaths().eveningPacketsRoot, "2026-08-07"));
    const result = fs.existsSync(path.join(directory, "DAILY_MARKET_PACKET.json")) && fs.existsSync(path.join(directory, "PREDICTION_REVIEW_PACKET.json"))
      ? ["DAILY_MARKET_PACKET.json", "PREDICTION_REVIEW_PACKET.json"].map((name) => validateEveningPacket(read(path.join(directory, name)), name))
      : [validateEveningPacket(buildAllPackets({ root, asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" }).daily, "DAILY_MARKET_PACKET.json"), validateEveningPacket(buildAllPackets({ root, asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" }).review, "PREDICTION_REVIEW_PACKET.json")];
    console.log(JSON.stringify({ valid: true, packets: result }, null, 2));
  } catch (error) {
    console.error(`PACKET_CONTRACT_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
