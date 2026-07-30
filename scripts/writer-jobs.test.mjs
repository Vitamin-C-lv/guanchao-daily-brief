import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { hash, makeRequest, validateRequest, validateResult } from "./writer-jobs.mjs";

const packet = JSON.parse(fs.readFileSync("content/writer-packets/daily-latest.json", "utf8"));
const make = () => makeRequest({ edition: "daily", asOf: "2026-07-29", packet, createdAt: "2026-07-30T01:02:03.000Z" });
function result(request) {
  const value = { schemaVersion: "writer-result-v1", jobId: request.jobId, writerPacketId: request.writerPacketId, generatedAt: "2026-07-30T01:02:04.000Z", writerEngine: "luna", writerVersion: "v1", outputs: [{ targetPath: request.targetOutputs[0].targetPath, targetSchemaVersion: request.targetOutputs[0].targetSchemaVersion, payload: { title: "structured payload" } }], factReferences: packet.facts.map((f) => ({ factId: f.factId, usedValue: f.value, usedUnit: f.unit, usedAsOf: f.asOf, targetPath: request.targetOutputs[0].targetPath, targetField: "facts" })), warnings: [] };
  const identity = (({ generatedAt, ...rest }) => rest)(value); value.resultId = hash(identity); value.integrity = { sha256: hash(identity) }; return value;
}
const resultHash = (v) => { const { resultId, generatedAt, integrity, ...identity } = v; return hash(identity); };
const reseal = (v) => { v.resultId = resultHash(v); v.integrity = { sha256: resultHash(v) }; };
test("request identity is deterministic, partial-safe and complete", () => { const a = make(); const b = makeRequest({ edition: "daily", asOf: "2026-07-29", packet, createdAt: "2026-08-01T01:02:03.000Z" }); assert.equal(a.jobId, b.jobId); assert.equal(a.inputStatus, "partial"); assert.deepEqual(a.allowedFactIds, packet.facts.map((f) => f.factId)); validateRequest(a); });
test("malformed requests fail closed", () => { const a = make(); a.allowedFactIds = []; assert.throws(() => validateRequest(a), /REQUEST_/); });
test("result identity is deterministic and valid facts pass", () => { const a = make(); const one = result(a); assert.equal(one.resultId, result(a).resultId); assert.doesNotThrow(() => validateResult(a, one, packet)); });
test("unknown facts, changed values, units, and dates fail", () => { const a = make(); for (const change of [{ factId: "missing" }, { usedValue: 99 }, { usedUnit: "bp" }, { usedAsOf: "2026-07-30" }]) { const r = result(a); Object.assign(r.factReferences[0], change); reseal(r); assert.throws(() => validateResult(a, r, packet)); } });
test("unavailable deterministic wording and frozen fields fail", () => { const a = make(); const unavailablePacket = { ...packet, facts: [...packet.facts, { factId: "unavailable", value: null, unit: "percent", asOf: null, status: "unavailable" }] }; const r = result(a); r.factReferences.push({ factId: "unavailable", usedValue: null, usedUnit: "percent", usedAsOf: null, targetPath: r.outputs[0].targetPath, targetField: "latest conclusion" }); reseal(r); assert.throws(() => validateResult(a, r, unavailablePacket), /FACT_NOT_ALLOWED/); const bad = result(a); bad.outputs[0].payload.probability = 0.5; reseal(bad); assert.throws(() => validateResult(a, bad, packet), /FORBIDDEN_FIELD/); });
