import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Canonical } from "./research-contract.mjs";
import { buildAllPackets } from "./build-market-packets.mjs";

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
    if (!Array.isArray(packet.sourceIndex) || packet.sourceIndex.some((source) => source.sha256 === null && source.present)) fail(`${kind} source lineage incomplete`);
  }
  if (kind === "PREDICTION_REVIEW_PACKET.json") {
    if (packet.schemaVersion !== "prediction-review-packet-v1") fail(`${kind} schema mismatch`);
    for (const horizon of Object.values(packet.horizons ?? {})) {
      if (horizon.evidenceObservation?.notModelAccuracy !== true) fail(`${kind} observation accuracy boundary missing`);
      if (horizon.abstained?.excludedFromModelDenominator !== true) fail(`${kind} abstention denominator boundary missing`);
      for (const row of horizon.rows ?? []) {
        if (["evidence_observation", "abstained", "not_applicable"].includes(row.classification) && row.probabilityPresent === true) fail(`${kind} non-model row carries probability: ${row.predictionId}`);
      }
    }
  }
  return { schemaVersion: packet.schemaVersion, packetId, status: packet.status };
}

function read(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const directory = path.resolve(process.argv[2] ?? path.join("D:\\Guanchao-Workspace", "runtime", "packets", "2026-08-07"));
    const result = fs.existsSync(path.join(directory, "DAILY_MARKET_PACKET.json")) && fs.existsSync(path.join(directory, "PREDICTION_REVIEW_PACKET.json"))
      ? ["DAILY_MARKET_PACKET.json", "PREDICTION_REVIEW_PACKET.json"].map((name) => validateEveningPacket(read(path.join(directory, name)), name))
      : [validateEveningPacket(buildAllPackets({ root, asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" }).daily, "DAILY_MARKET_PACKET.json"), validateEveningPacket(buildAllPackets({ root, asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" }).review, "PREDICTION_REVIEW_PACKET.json")];
    console.log(JSON.stringify({ valid: true, packets: result }, null, 2));
  } catch (error) {
    console.error(`PACKET_CONTRACT_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
