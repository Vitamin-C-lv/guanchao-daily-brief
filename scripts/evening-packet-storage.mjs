import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveAutomationPaths } from "./automation-paths.mjs";
import { validateEveningPacket } from "./validate-evening-packets.mjs";

export const EVENING_PACKET_FILES = Object.freeze([
  ["daily", "DAILY_MARKET_PACKET.json"],
  ["review", "PREDICTION_REVIEW_PACKET.json"],
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class EveningPacketStorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EveningPacketStorageError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new EveningPacketStorageError(code, message);
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readValidatedPacket(file, name, editionDate) {
  if (!fs.existsSync(file)) fail("EVENING_PACKET_MISSING", `${name} is missing: ${file}`);
  let packet;
  let bytes;
  try {
    bytes = fs.readFileSync(file);
    packet = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("EVENING_PACKET_INVALID", `${name} cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    validateEveningPacket(packet, name);
  } catch (error) {
    fail("EVENING_PACKET_CONTRACT", `${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (name === "DAILY_MARKET_PACKET.json" && packet.editionDate !== editionDate) {
    fail("EVENING_PACKET_DATE", `${name}.editionDate=${packet.editionDate} differs from ${editionDate}`);
  }
  if (name === "PREDICTION_REVIEW_PACKET.json" && (typeof packet.asOfDate !== "string" || packet.asOfDate > editionDate)) {
    fail("EVENING_PACKET_DATE", `${name}.asOfDate=${packet.asOfDate} is later than ${editionDate}`);
  }
  return { packet, bytes, sha256: hashBytes(bytes) };
}

function targetPath(root, editionDate, name) {
  return path.join(root, editionDate, name);
}

function immutableConflict(file, message) {
  fail("EVENING_PACKET_IMMUTABLE_CONFLICT", `${file}: ${message}`);
}

function atomicCreate(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx" });
    try {
      fs.renameSync(temporary, file);
      return "sealed";
    } catch (error) {
      if (fs.existsSync(file)) {
        let existing;
        try { existing = fs.readFileSync(file); } catch { existing = null; }
        if (existing && Buffer.compare(existing, bytes) === 0) return "idempotent";
        immutableConflict(file, "a concurrent writer installed different bytes");
      }
      throw error;
    }
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* the rename already consumed it */ }
  }
}

/**
 * Validate the two Recovery packet files and atomically seal the exact source
 * bytes into the canonical runtime packet root. Existing bytes are immutable.
 */
export function sealEveningPackets({
  sourceDirectory,
  editionDate,
  eveningPacketsRoot = resolveAutomationPaths().eveningPacketsRoot,
} = {}) {
  if (!DATE.test(String(editionDate ?? ""))) fail("EVENING_PACKET_DATE", `invalid editionDate: ${editionDate}`);
  if (typeof sourceDirectory !== "string" || !sourceDirectory.length) fail("EVENING_PACKET_SOURCE", "sourceDirectory is required");
  if (typeof eveningPacketsRoot !== "string" || !eveningPacketsRoot.length) fail("EVENING_PACKET_ROOT", "eveningPacketsRoot is required");

  const sourceRoot = path.resolve(sourceDirectory);
  const canonicalRoot = path.resolve(eveningPacketsRoot);
  const targetDirectory = path.join(canonicalRoot, editionDate);
  const values = EVENING_PACKET_FILES.map(([key, name]) => {
    const sourcePath = path.join(sourceRoot, name);
    const canonicalPath = targetPath(canonicalRoot, editionDate, name);
    const value = readValidatedPacket(sourcePath, name, editionDate);
    return { key, name, sourcePath, canonicalPath, ...value };
  });

  // Inspect every existing target before creating the directory or installing
  // either file, so a conflict fails closed without a partial new seal.
  for (const value of values) {
    if (!fs.existsSync(value.canonicalPath)) continue;
    let existing;
    try { existing = fs.readFileSync(value.canonicalPath); } catch (error) {
      immutableConflict(value.canonicalPath, `cannot read existing bytes: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (Buffer.compare(existing, value.bytes) !== 0) {
      immutableConflict(value.canonicalPath, `existing bytes differ (existingSha256=${hashBytes(existing)} incomingSha256=${value.sha256})`);
    }
  }

  if (values.some((value) => !fs.existsSync(value.canonicalPath))) fs.mkdirSync(targetDirectory, { recursive: true });
  const packets = {};
  for (const value of values) {
    const alreadyPresent = fs.existsSync(value.canonicalPath);
    const status = alreadyPresent ? "idempotent" : atomicCreate(value.canonicalPath, value.bytes);
    const canonicalBytes = fs.readFileSync(value.canonicalPath);
    if (Buffer.compare(canonicalBytes, value.bytes) !== 0) {
      immutableConflict(value.canonicalPath, "canonical bytes changed during seal");
    }
    packets[value.key] = {
      name: value.name,
      sourcePath: value.sourcePath,
      canonicalPath: value.canonicalPath,
      schemaVersion: value.packet.schemaVersion,
      packetId: value.packet.packetId,
      businessSha256: value.packet.integrity.businessSha256,
      sourceSha256: value.sha256,
      canonicalSha256: hashBytes(canonicalBytes),
      bytes: value.bytes.length,
      status,
      bytesEqual: true,
    };
  }
  return { editionDate, canonicalRoot, targetDirectory, packets };
}
