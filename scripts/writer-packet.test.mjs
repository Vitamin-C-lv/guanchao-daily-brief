import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { validatePacket } from "./validate-writer-packet.mjs";

const normalize = (value) => Array.isArray(value) ? value.map(normalize) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
const identity = (value) => Array.isArray(value) ? value.map(identity) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([key]) => !new Set(["requestedAt", "completedAt", "generatedAt", "rawSha256", "integrity", "businessIntegrity", "writerPacketId", "runId"]).has(key)).map(([key, item]) => [key, identity(item)])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");

test("writer packet validator rejects a Treasury bp floating-point residual", () => {
  const packet = JSON.parse(fs.readFileSync("content/writer-packets/daily-latest.json", "utf8"));
  packet.facts.find((fact) => fact.factId.startsWith("treasury-spread2s10sBp-")).value = 35.00000000000006;
  packet.treasuryFactor.spread2s10sBp = 35.00000000000006;
  const business = identity(packet);
  packet.writerPacketId = hash(business);
  packet.integrity = { sha256: hash(business), businessSha256: hash(business) };
  assert.throws(() => validatePacket(packet), /bp (value|spread) must be rounded/);
});
