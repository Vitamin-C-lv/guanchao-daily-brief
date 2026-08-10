import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAllPackets, writePackets } from "./build-market-packets.mjs";
import { EveningPacketStorageError, sealEveningPackets } from "./evening-packet-storage.mjs";

function fixture() {
  const root = process.cwd();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evening-packet-storage-"));
  const sourceDirectory = path.join(tempRoot, "recovery", "prediction");
  const eveningPacketsRoot = path.join(tempRoot, "runtime", "packets");
  const packets = buildAllPackets({ root, asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:00.000Z" });
  writePackets(sourceDirectory, packets);
  return { tempRoot, sourceDirectory, eveningPacketsRoot, packets };
}

function cleanup(value) {
  fs.rmSync(value.tempRoot, { recursive: true, force: true });
}

test("valid Recovery packets seal to canonical root with identical bytes and hashes", () => {
  const value = fixture();
  try {
    const result = sealEveningPackets({ sourceDirectory: value.sourceDirectory, editionDate: "2026-08-07", eveningPacketsRoot: value.eveningPacketsRoot });
    assert.equal(result.packets.daily.status, "sealed");
    assert.equal(result.packets.review.status, "sealed");
    for (const name of ["DAILY_MARKET_PACKET.json", "PREDICTION_REVIEW_PACKET.json"]) {
      const source = fs.readFileSync(path.join(value.sourceDirectory, name));
      const canonical = fs.readFileSync(path.join(value.eveningPacketsRoot, "2026-08-07", name));
      assert.deepEqual(canonical, source, name);
      assert.equal(result.packets[name.startsWith("DAILY") ? "daily" : "review"].sourceSha256, result.packets[name.startsWith("DAILY") ? "daily" : "review"].canonicalSha256, name);
    }
  } finally {
    cleanup(value);
  }
});

test("same packetId and bytes are idempotent", () => {
  const value = fixture();
  try {
    const first = sealEveningPackets({ sourceDirectory: value.sourceDirectory, editionDate: "2026-08-07", eveningPacketsRoot: value.eveningPacketsRoot });
    const second = sealEveningPackets({ sourceDirectory: value.sourceDirectory, editionDate: "2026-08-07", eveningPacketsRoot: value.eveningPacketsRoot });
    assert.equal(first.packets.daily.status, "sealed");
    assert.equal(second.packets.daily.status, "idempotent");
    assert.equal(second.packets.review.status, "idempotent");
  } finally {
    cleanup(value);
  }
});

test("different business bytes at an existing canonical path fail closed", () => {
  const value = fixture();
  try {
    sealEveningPackets({ sourceDirectory: value.sourceDirectory, editionDate: "2026-08-07", eveningPacketsRoot: value.eveningPacketsRoot });
    writePackets(value.sourceDirectory, buildAllPackets({ root: process.cwd(), asOf: "2026-08-07", generatedAt: "2026-08-07T12:00:01.000Z" }));
    assert.throws(
      () => sealEveningPackets({ sourceDirectory: value.sourceDirectory, editionDate: "2026-08-07", eveningPacketsRoot: value.eveningPacketsRoot }),
      (error) => error instanceof EveningPacketStorageError && error.code === "EVENING_PACKET_IMMUTABLE_CONFLICT"
    );
  } finally {
    cleanup(value);
  }
});
