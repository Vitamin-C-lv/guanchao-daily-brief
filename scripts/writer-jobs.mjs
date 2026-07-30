import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { validatePacket } from "./validate-writer-packet.mjs";

const modulePath = fileURLToPath(import.meta.url);
export const root = path.resolve(path.dirname(modulePath), "..");
export const requestVersion = "writer-request-v1";
export const resultVersion = "writer-result-v1";
const forbidden = new Set(["probability", "probabilities", "ranking", "rankings", "publicationstatus", "publicationgate", "modelstate", "modelstatus", "evidencescore"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const canonical = (value) => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`, "utf8");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const isoDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const isIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const error = (errorCode, field, message, expected, actual) => { const failure = new Error(JSON.stringify({ errorCode, path: field, message, expected, actual })); failure.errorCode = errorCode; throw failure; };
const rel = (rootDir, file) => path.relative(rootDir, file).replaceAll("\\", "/");
const isAbsoluteOrLocal = (value) => typeof value === "string" && (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"));

export function createWriterJobPaths(rootDir = root) {
  const base = path.join(rootDir, "data", "writer-jobs");
  return {
    base,
    packet: (id, date) => path.join(base, "packets", date.slice(0, 4), date.slice(5, 7), `${id}.json.gz`),
    request: (id, date) => path.join(base, "requests", date.slice(0, 4), date.slice(5, 7), `${id}.json`),
    accepted: (id, date) => path.join(base, "accepted", date.slice(0, 4), date.slice(5, 7), `${id}.json.gz`),
    index: path.join(base, "index.json"),
    pending: (edition) => path.join(rootDir, "content", "writer-jobs", `${edition}-pending.json`),
  };
}
function requestIdentity(request) { const { jobId, createdAt, integrity, ...identity } = request; return identity; }
function resultIdentity(result) { const { resultId, generatedAt, integrity, ...identity } = result; return identity; }
function gzip(value) { return zlib.gzipSync(jsonBytes(value), { mtime: 0 }); }
function gunzipJson(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")); }
function atomicBytes(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); const staged = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`; fs.writeFileSync(staged, bytes); fs.renameSync(staged, file); }
function writeJson(file, value) { atomicBytes(file, jsonBytes(value)); }
function assertNoAbsolute(value, field) { if (typeof value === "string" && isAbsoluteOrLocal(value)) error("LOCAL_ABSOLUTE_PATH", field, "local absolute paths are forbidden"); if (Array.isArray(value)) value.forEach((item, index) => assertNoAbsolute(item, `${field}[${index}]`)); if (object(value)) Object.entries(value).forEach(([key, item]) => assertNoAbsolute(item, `${field}.${key}`)); }
function assertNoForbidden(value, field = "payload") { if (Array.isArray(value)) return value.forEach((item, index) => assertNoForbidden(item, `${field}[${index}]`)); if (!object(value)) return; for (const [key, item] of Object.entries(value)) { if (forbidden.has(key.toLowerCase())) error("FORBIDDEN_FIELD", `${field}.${key}`, "writer results cannot modify frozen fields"); assertNoForbidden(item, `${field}.${key}`); } }
function outputTargets(edition, asOf) { if (edition === "daily") return [{ targetPath: "content/daily-brief.json", contentType: "daily-brief", required: true }]; const date = new Date(`${asOf}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7)); const week = Math.ceil((((date - new Date(Date.UTC(date.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7); return [{ targetPath: `content/weekly-reports/weekly-${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}.json`, contentType: "weekly-report", required: true }]; }

export function validateRequest(request) {
  if (!object(request) || request.schemaVersion !== requestVersion) error("REQUEST_SCHEMA", "schemaVersion", "invalid writer request schema", requestVersion, request?.schemaVersion);
  if (!/^[a-f0-9]{64}$/.test(request.jobId ?? "") || request.jobId !== hash(requestIdentity(request))) error("REQUEST_JOB_ID", "jobId", "jobId does not match stable request identity");
  if (!["daily", "weekly"].includes(request.edition) || !isoDate(request.requestedAsOf) || !isIso(request.createdAt)) error("REQUEST_FIELDS", "edition/requestedAsOf/createdAt", "invalid request metadata");
  if (!/^data\/writer-jobs\/packets\/\d{4}\/\d{2}\/[a-f0-9]{64}\.json\.gz$/.test(request.writerPacketPath ?? "")) error("REQUEST_PACKET_PATH", "writerPacketPath", "request must reference an immutable packet");
  if (!/^[a-f0-9]{64}$/.test(request.writerPacketId ?? "") || !/^[a-f0-9]{64}$/.test(request.writerPacketSha256 ?? "")) error("REQUEST_PACKET", "writerPacket", "packet identity/hash is invalid");
  if (!Array.isArray(request.targetOutputs) || !request.targetOutputs.length || new Set(request.targetOutputs.map((x) => x?.targetPath)).size !== request.targetOutputs.length || !request.targetOutputs.every((x) => object(x) && typeof x.targetPath === "string" && typeof x.contentType === "string" && typeof x.required === "boolean" && !isAbsoluteOrLocal(x.targetPath))) error("REQUEST_TARGETS", "targetOutputs", "targets are invalid");
  if (!Array.isArray(request.allowedFactIds) || !request.allowedFactIds.length || new Set(request.allowedFactIds).size !== request.allowedFactIds.length || !request.allowedFactIds.every((id) => typeof id === "string")) error("REQUEST_FACTS", "allowedFactIds", "allowed facts are invalid");
  if (!Array.isArray(request.requiredSections) || !request.requiredSections.length || !["ready", "partial"].includes(request.inputStatus) || request.integrity?.sha256 !== hash(requestIdentity(request))) error("REQUEST_INTEGRITY", "integrity", "request integrity is invalid");
  assertNoAbsolute(request, "request"); return request;
}
export function validatePacketBinding(rootDir, request, packet) {
  try { validatePacket(packet, "writer packet"); } catch (cause) { error("WRITER_PACKET_SCHEMA", "writerPacket", cause.message); }
  if (packet.writerPacketId !== request.writerPacketId) error("WRITER_PACKET_ID_MISMATCH", "writerPacketId", "packet ID differs from request", request.writerPacketId, packet.writerPacketId);
  if (hash(packet) !== request.writerPacketSha256) error("WRITER_PACKET_SHA_MISMATCH", "writerPacketSha256", "packet canonical hash differs from request", request.writerPacketSha256, hash(packet));
  if (packet.edition !== request.edition) error("WRITER_PACKET_EDITION_MISMATCH", "edition", "packet edition differs from request", request.edition, packet.edition);
  if (!isoDate(packet.marketDates?.aShare) || packet.marketDates.aShare > request.requestedAsOf) error("WRITER_PACKET_DATE_MISMATCH", "marketDates.aShare", "packet cannot be after requested date", request.requestedAsOf, packet.marketDates?.aShare);
  const expected = path.resolve(rootDir, request.writerPacketPath); if (!fs.existsSync(expected)) error("WRITER_PACKET_MISSING", "writerPacketPath", "immutable packet is missing", request.writerPacketPath);
  return packet;
}
export function makeRequest({ edition, asOf, packet, createdAt = new Date().toISOString(), rootDir = root }) {
  const paths = createWriterJobPaths(rootDir); const packetFile = paths.packet(packet.writerPacketId, asOf); const request = { schemaVersion: requestVersion, edition, requestedAsOf: asOf, createdAt, writerPacketId: packet.writerPacketId, writerPacketPath: rel(rootDir, packetFile), writerPacketSha256: hash(packet), targetOutputs: outputTargets(edition, asOf), allowedFactIds: packet.facts.map((fact) => fact.factId), requiredSections: ["facts", "explanation", "counterEvidence", "observation"], writerPromptPath: `prompts/luna-${edition}-brief.md`, inputStatus: packet.providerHealth?.status === "ready" && packet.marketSummary?.status !== "partial" ? "ready" : "partial" }; request.jobId = hash(requestIdentity(request)); request.integrity = { sha256: hash(requestIdentity(request)) }; return validateRequest(request);
}
function writeImmutablePacket(rootDir, packet, asOf, dryRun) { const paths = createWriterJobPaths(rootDir); const file = paths.packet(packet.writerPacketId, asOf); const bytes = gzip(packet); if (fs.existsSync(file)) { const existing = gunzipJson(file); if (hash(existing) !== hash(packet) || existing.writerPacketId !== packet.writerPacketId) error("WRITER_PACKET_CONFLICT", rel(rootDir, file), "immutable packet identity conflicts"); return { file, created: false }; } if (!dryRun) atomicBytes(file, bytes); return { file, created: true }; }
function walk(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]) : []; }
function derived(rootDir, acceptedOverrides = new Set()) { const paths = createWriterJobPaths(rootDir); const jobs = walk(path.join(paths.base, "requests")).map((file) => { const request = validateRequest(readJson(file)); const accepted = acceptedOverrides.has(request.jobId) || fs.existsSync(paths.accepted(request.jobId, request.requestedAsOf)); return { jobId: request.jobId, edition: request.edition, requestedAsOf: request.requestedAsOf, createdAt: request.createdAt, requestPath: rel(rootDir, file), writerPacketId: request.writerPacketId, inputStatus: request.inputStatus, accepted }; }).sort((a, b) => a.edition.localeCompare(b.edition) || a.requestedAsOf.localeCompare(b.requestedAsOf) || a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId));
  const index = { schemaVersion: "writer-job-index-v1", sort: ["edition", "requestedAsOf", "createdAt", "jobId"], jobs };
  const pending = Object.fromEntries(["daily", "weekly"].map((edition) => { const job = jobs.filter((item) => item.edition === edition && !item.accepted).sort((a, b) => a.requestedAsOf.localeCompare(b.requestedAsOf) || a.createdAt.localeCompare(b.createdAt) || a.jobId.localeCompare(b.jobId)).at(-1) ?? null; return [edition, { schemaVersion: "writer-job-pending-v1", edition, job }]; }));
  return { index, pending };
}
export function rebuild(rootDir = root) { const paths = createWriterJobPaths(rootDir); const next = derived(rootDir); writeJson(paths.index, next.index); for (const edition of ["daily", "weekly"]) writeJson(paths.pending(edition), next.pending[edition]); return next.index.jobs; }
export function prepare({ edition, asOf = new Date().toISOString().slice(0, 10), packet, dryRun = false, rootDir = root, createdAt }) {
  if (!packet) { const run = spawnSync(process.execPath, ["scripts/run-market-evidence.mjs", "run", "--edition", edition, "--as-of", asOf], { cwd: rootDir, stdio: "inherit" }); if (run.status !== 0) throw new Error("MARKET_DATA_FAILED"); packet = readJson(path.join(rootDir, "content", "writer-packets", `${edition}-latest.json`)); }
  try { validatePacket(packet, "latest writer packet"); } catch (cause) { error("WRITER_PACKET_SCHEMA", "latest writer packet", cause.message); }
  const packetWrite = writeImmutablePacket(rootDir, packet, asOf, dryRun); const request = makeRequest({ edition, asOf, packet, createdAt, rootDir }); const file = createWriterJobPaths(rootDir).request(request.jobId, asOf); const existing = fs.existsSync(file) ? readJson(file) : null;
  if (existing && hash(requestIdentity(existing)) !== hash(requestIdentity(request))) error("JOB_CONFLICT", rel(rootDir, file), "same jobId has conflicting business identity");
  const summary = { edition, requestedAsOf: asOf, writerPacketId: request.writerPacketId, jobId: request.jobId, requestPath: rel(rootDir, file), inputStatus: request.inputStatus, factCount: request.allowedFactIds.length, targetCount: request.targetOutputs.length, created: !existing, noOp: Boolean(existing), warnings: packet.warnings ?? [] };
  if (!dryRun && !existing) { writeJson(file, request); rebuild(rootDir); }
  return { request: existing ?? request, summary, packetPath: packetWrite.file };
}
function validatePayload(rootDir, output) { const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "writer-job-validator-")); try { fs.cpSync(path.join(rootDir, "content"), path.join(temporary, "content"), { recursive: true }); const target = path.join(temporary, output.targetPath); writeJson(target, output.payload); const script = output.contentType === "daily-brief" ? "validate-brief.mjs" : output.contentType === "weekly-report" ? "validate-weekly.mjs" : null; if (!script) error("TARGET_SCHEMA_UNKNOWN", "contentType", "unknown target content type", "daily-brief|weekly-report", output.contentType); const run = spawnSync(process.execPath, [path.join(root, "scripts", script)], { cwd: temporary, encoding: "utf8" }); if (run.status !== 0) error("TARGET_SCHEMA_INVALID", output.targetPath, (run.stderr || run.stdout || "target validator failed").trim()); } finally { fs.rmSync(temporary, { recursive: true, force: true }); } }
export function validateResult(rootDir, request, result, packet) {
  validateRequest(request); validatePacketBinding(rootDir, request, packet);
  if (!object(result) || result.schemaVersion !== resultVersion || !/^[a-f0-9]{64}$/.test(result.resultId ?? "") || result.resultId !== hash(resultIdentity(result)) || result.integrity?.sha256 !== hash(resultIdentity(result))) error("RESULT_INTEGRITY", "result", "invalid result identity");
  if (result.jobId !== request.jobId || result.writerPacketId !== request.writerPacketId || !isIso(result.generatedAt) || typeof result.writerEngine !== "string" || typeof result.writerVersion !== "string" || !Array.isArray(result.warnings)) error("RESULT_METADATA", "result", "invalid result metadata");
  if (!Array.isArray(result.outputs) || !result.outputs.length) error("RESULT_OUTPUTS", "outputs", "outputs are required"); const expected = new Map(request.targetOutputs.map((target) => [target.targetPath, target])); const seen = new Set();
  for (const output of result.outputs) { if (!object(output) || typeof output.targetPath !== "string" || seen.has(output.targetPath)) error("RESULT_TARGET_DUPLICATE", "outputs", "output targets must be unique"); seen.add(output.targetPath); const target = expected.get(output.targetPath); if (!target || output.contentType !== target.contentType || !object(output.payload)) error("RESULT_TARGET", "outputs", "result target is not requested"); assertNoAbsolute(output, `outputs.${output.targetPath}`); assertNoForbidden(output.payload); if (Array.isArray(output.payload.factClaims)) for (const claim of output.payload.factClaims) if (!object(claim) || typeof claim.factId !== "string" || typeof claim.targetField !== "string") error("FACT_CLAIM_SCHEMA", "payload.factClaims", "fact claims need factId and targetField"); }
  for (const target of expected.values()) if (target.required && !seen.has(target.targetPath)) error("RESULT_REQUIRED_TARGET", target.targetPath, "required target is missing");
  if (!Array.isArray(result.factReferences)) error("FACT_REFERENCES", "factReferences", "factReferences must be an array"); const facts = new Map(packet.facts.map((fact) => [fact.factId, fact])); const references = new Set();
  for (const ref of result.factReferences) { if (!object(ref) || !seen.has(ref.targetPath) || typeof ref.targetField !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$.[\]-]*$/.test(ref.targetField)) error("FACT_REFERENCE_TARGET", "factReferences", "invalid target binding"); const key = `${ref.factId}\u0000${ref.targetPath}\u0000${ref.targetField}`; if (references.has(key)) error("FACT_REFERENCE_DUPLICATE", "factReferences", "duplicate fact reference"); references.add(key); const fact = facts.get(ref.factId); if (!request.allowedFactIds.includes(ref.factId)) error("FACT_NOT_ALLOWED", "factReferences", "factId is not allowed"); if (!fact) error("FACT_MISSING", "factReferences", "fact is absent from packet"); if (ref.usedValue !== fact.value) error("FACT_VALUE", "factReferences", "used value differs from packet", fact.value, ref.usedValue); if (ref.usedUnit !== fact.unit) error("FACT_UNIT", "factReferences", "used unit differs from packet", fact.unit, ref.usedUnit); if (ref.usedAsOf !== fact.asOf) error("FACT_DATE", "factReferences", "used date differs from packet", fact.asOf, ref.usedAsOf); if (["stale", "unavailable"].includes(fact.status) && /(latest|最新|确定|必然)/i.test(`${ref.targetField} ${ref.claim ?? ""}`)) error("FACT_STATUS", "factReferences", "stale/unavailable fact cannot support latest or deterministic claim"); }
  for (const output of result.outputs) for (const claim of output.payload.factClaims ?? []) if (!references.has(`${claim.factId}\u0000${output.targetPath}\u0000${claim.targetField}`)) error("FACT_REFERENCE_MISSING", "payload.factClaims", "each structured fact claim needs a matching reference");
  return result;
}
function commit(entries, failAt) { const backups = []; try { for (const entry of entries) { if (failAt === entry.kind) throw new Error(`INJECTED_${entry.kind}`); backups.push({ file: entry.file, before: fs.existsSync(entry.file) ? fs.readFileSync(entry.file) : null }); atomicBytes(entry.file, entry.bytes); } } catch (cause) { const rollbackFailures = []; for (const backup of backups.reverse()) try { if (backup.before === null) fs.rmSync(backup.file, { force: true }); else atomicBytes(backup.file, backup.before); } catch { rollbackFailures.push(backup.file); } if (rollbackFailures.length) error("APPLY_ROLLBACK_FAILED", "apply", "rollback failed", rollbackFailures); throw cause; } }
export function apply({ request, result, packet, dryRun = false, rootDir = root, failAt }) {
  validateResult(rootDir, request, result, packet); const paths = createWriterJobPaths(rootDir); const accepted = paths.accepted(request.jobId, request.requestedAsOf);
  if (fs.existsSync(accepted)) { const existing = gunzipJson(accepted); if (hash(resultIdentity(existing)) !== hash(resultIdentity(result))) error("ACCEPTED_CONFLICT", rel(rootDir, accepted), "accepted result conflicts with stable result identity"); return { noOp: true, applied: false, files: [] }; }
  const outputs = result.outputs.map((output) => ({ file: path.join(rootDir, output.targetPath), bytes: jsonBytes(output.payload), kind: "target" })); for (const output of result.outputs) validatePayload(rootDir, output); if (dryRun) return { noOp: false, applied: false, files: outputs.map((entry) => rel(rootDir, entry.file)) };
  const next = derived(rootDir, new Set([request.jobId])); const entries = [...outputs, { file: accepted, bytes: gzip(result), kind: "accepted" }, { file: paths.index, bytes: jsonBytes(next.index), kind: "index" }, ...["daily", "weekly"].map((edition) => ({ file: paths.pending(edition), bytes: jsonBytes(next.pending[edition]), kind: "pending" }))]; commit(entries, failAt); return { noOp: false, applied: true, files: entries.map((entry) => rel(rootDir, entry.file)) };
}
function cliArgs() { const values = process.argv.slice(3); const args = {}; for (let index = 0; index < values.length; index += 1) if (values[index].startsWith("--")) args[values[index].slice(2)] = values[index + 1]?.startsWith("--") || values[index + 1] === undefined ? true : values[++index]; return args; }
if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) { const [command] = process.argv.slice(2); const args = cliArgs(); try { if (command === "prepare") console.log(JSON.stringify(prepare({ edition: args.edition, asOf: args["as-of"] === "auto" ? new Date().toISOString().slice(0, 10) : args["as-of"], dryRun: args["dry-run"] === true }).summary)); else { const request = readJson(path.resolve(root, args.request)); const result = readJson(path.resolve(root, args.result)); const packet = gunzipJson(path.resolve(root, request.writerPacketPath)); if (command === "validate") { validateResult(root, request, result, packet); console.log(JSON.stringify({ valid: true, jobId: request.jobId, resultId: result.resultId })); } else if (command === "apply") console.log(JSON.stringify(apply({ request, result, packet, dryRun: args["dry-run"] === true }))); else throw new Error("usage: writer-jobs.mjs prepare|validate|apply"); } } catch (cause) { console.error(cause.message); process.exit(1); } }
