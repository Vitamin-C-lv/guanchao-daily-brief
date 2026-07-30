import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isoDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const isoTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = (value) => crypto.createHash("sha256").update(JSON.stringify(value, Object.keys(value).sort())).digest("hex");
// JSON.stringify's replacer does not recursively sort.  Keep the canonicalizer explicit and aligned
// with scripts/market_evidence_packet.py.
const normalize = (value) => Array.isArray(value) ? value.map(normalize) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
const identity = (value) => Array.isArray(value) ? value.map(identity) : isObject(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => !new Set(["requestedAt", "completedAt", "generatedAt", "rawSha256", "integrity", "businessIntegrity", "writerPacketId", "runId"]).has(key)).map(([key, item]) => [key, identity(item)])) : value;
const allowedStatus = new Set(["ready", "partial", "stale", "unavailable", "rate_limited", "schema_changed"]);

export function validatePacket(packet, path = "writer packet") {
  const errors = [];
  const fail = (message) => errors.push(message);
  if (packet.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (!["daily", "weekly"].includes(packet.edition)) fail("edition is invalid");
  if (!isoTime(packet.generatedAt)) fail("generatedAt is invalid");
  const business = identity(packet);
  if (packet.writerPacketId !== hash(business)) fail("writerPacketId does not match business content");
  if (packet.integrity?.businessSha256 !== hash(business)) fail("business integrity mismatch");
  if (packet.integrity?.sha256 !== hash(business)) fail("integrity mismatch");
  if (!isObject(packet.sourceIndex) || Object.keys(packet.sourceIndex).length === 0) fail("sourceIndex is required");
  const ids = new Set();
  for (const fact of packet.facts ?? []) {
    if (!fact.factId || ids.has(fact.factId)) fail(`duplicate or missing factId: ${fact.factId}`);
    ids.add(fact.factId);
    if (!Object.hasOwn(packet.sourceIndex ?? {}, fact.sourceId)) fail(`${fact.factId} references missing sourceIndex sourceId`);
    if (!(Number.isFinite(fact.value) || fact.value === null)) fail(`${fact.factId} value must be finite or null`);
    if (fact.value === null && fact.status === "ready") fail(`${fact.factId} null cannot be ready`);
    if (!allowedStatus.has(fact.status)) fail(`${fact.factId} status is invalid`);
    if (!["percent", "bp"].includes(fact.unit)) fail(`${fact.factId} unit is invalid`);
    if (fact.changeUnit !== "bp") fail(`${fact.factId} changeUnit must be bp`);
    for (const key of ["change1d", "change5d", "change20d"]) if (!(Number.isFinite(fact[key]) || fact[key] === null)) fail(`${fact.factId} ${key} must be finite or null`);
    if (fact.unit === "bp" && fact.value !== null && fact.value !== Math.round(fact.value * 100) / 100) fail(`${fact.factId} bp value must be rounded to at most 2 decimal places`);
    for (const key of ["change1d", "change5d", "change20d"]) if (fact[key] !== null && fact[key] !== Math.round(fact[key] * 100) / 100) fail(`${fact.factId} ${key} bp change must be rounded to at most 2 decimal places`);
    if (fact.status === "unavailable") {
      if (fact.asOf !== null || fact.releasedAt !== null) fail(`${fact.factId} unavailable dates must be null`);
    } else if (!isoDate(fact.asOf) || !isoDate(fact.releasedAt) || fact.releasedAt < fact.asOf) fail(`${fact.factId} dates are invalid`);
    if (fact.status === "unavailable" && fact.value !== null) fail(`${fact.factId} unavailable cannot contain a deterministic value`);
    if (fact.status === "stale" && packet.marketSummary?.status === "latest") fail(`${fact.factId} stale cannot be described as latest`);
    if (fact.factId.startsWith("treasury-real10y-") && fact.sourceId !== "us-treasury-real-xml") fail("real10y must use real Treasury source");
    if (fact.status !== "unavailable" && fact.asOf !== packet.marketDates?.us) fail(`${fact.factId} must match marketDates.us`);
  }
  const treasury = packet.treasuryFactor ?? {};
  if (treasury.spread2s10sBp !== null && treasury.spread2s10sBp !== undefined && treasury.spread2s10sBp !== Math.round(treasury.spread2s10sBp * 100) / 100) fail("Treasury 2s10s bp spread must be rounded to at most 2 decimal places");
  for (const [series, changes] of Object.entries(treasury.changesBp ?? {})) for (const [window, value] of Object.entries(changes ?? {})) if (value !== null && value !== Math.round(value * 100) / 100) fail(`Treasury ${series} ${window} bp change must be rounded to at most 2 decimal places`);
  if (treasury.nominalSource?.sourceId !== "us-treasury-nominal-xml") fail("nominal source lineage is invalid");
  if (treasury.realSource?.sourceId !== "us-treasury-real-xml") fail("real source lineage is invalid");
  if (treasury.status === "ready" && treasury.nominalSource?.asOf !== treasury.realSource?.asOf) fail("nominal and real dates may not differ when ready");
  if (packet.generatedAt.slice(0, 10) < (packet.marketDates?.us ?? "0000-00-00")) fail("generatedAt predates market date");
  if (errors.length) throw new Error(`${path}:\n- ${errors.join("\n- ")}`);
  return { path, writerPacketId: packet.writerPacketId, facts: packet.facts.length, status: packet.providerHealth?.status };
}

function validate(path) {
  return validatePacket(JSON.parse(fs.readFileSync(path, "utf8")), path);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = [];
  for (const edition of ["daily", "weekly"]) {
    const path = `content/writer-packets/${edition}-latest.json`;
    if (!fs.existsSync(path)) throw new Error(`${path} is missing; run market-data first`);
    results.push(validate(path));
  }
  console.log(JSON.stringify({ writerPackets: results }, null, 2));
}
