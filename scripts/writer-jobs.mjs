import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const requestVersion = "writer-request-v1";
const resultVersion = "writer-result-v1";
const forbidden = /(^|\.)(probability|probabilities|ranking|rankings|publicationStatus|publicationGate|modelState|modelStatus|evidenceScore)(\.|$)/i;
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : object(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
export const hash = (v) => crypto.createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = `${p}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(canonical(v))}\n`, "utf8"); fs.renameSync(tmp, p); };
const relative = (p) => path.relative(root, p).replaceAll("\\", "/");
const requestPath = (jobId, date) => path.join(root, "data/writer-jobs/requests", date.slice(0, 4), date.slice(5, 7), `${jobId}.json`);
const acceptedPath = (jobId, date) => path.join(root, "data/writer-jobs/accepted", date.slice(0, 4), date.slice(5, 7), `${jobId}.json.gz`);
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const fail = (errorCode, field, message, expected, actual) => { const err = new Error(JSON.stringify({ errorCode, path: field, message, expected, actual })); err.errorCode = errorCode; throw err; };
const packetPath = (edition) => path.join(root, "content/writer-packets", `${edition}-latest.json`);

function requestIdentity(r) { const { jobId, createdAt, integrity, writerPacketPath, ...business } = r; return business; }
function resultIdentity(r) { const { resultId, generatedAt, integrity, ...business } = r; return business; }
export function validateRequest(r) {
  if (!object(r) || r.schemaVersion !== requestVersion) fail("REQUEST_SCHEMA", "schemaVersion", "invalid writer request schema", requestVersion, r?.schemaVersion);
  if (!/^[a-f0-9]{64}$/.test(r.jobId ?? "")) fail("REQUEST_JOB_ID", "jobId", "jobId must be SHA-256", "64 hex", r.jobId);
  if (!["daily", "weekly"].includes(r.edition) || !isDate(r.requestedAsOf)) fail("REQUEST_FIELDS", "edition/requestedAsOf", "invalid request fields");
  if (!Number.isFinite(Date.parse(r.createdAt))) fail("REQUEST_CREATED_AT", "createdAt", "createdAt must be a real ISO timestamp");
  if (!/^[a-f0-9]{64}$/.test(r.writerPacketId ?? "") || !/^[a-f0-9]{64}$/.test(r.writerPacketSha256 ?? "")) fail("REQUEST_PACKET", "writerPacket", "packet identity is invalid");
  if (!Array.isArray(r.targetOutputs) || !r.targetOutputs.length || !r.targetOutputs.every((x) => object(x) && typeof x.targetPath === "string" && typeof x.targetSchemaVersion === "string" && typeof x.contentType === "string" && typeof x.required === "boolean")) fail("REQUEST_TARGETS", "targetOutputs", "invalid target outputs");
  if (!Array.isArray(r.allowedFactIds) || new Set(r.allowedFactIds).size !== r.allowedFactIds.length || !r.allowedFactIds.every((x) => typeof x === "string")) fail("REQUEST_FACTS", "allowedFactIds", "invalid allowed fact IDs");
  if (!Array.isArray(r.requiredSections) || !r.requiredSections.length || !["ready", "partial"].includes(r.inputStatus)) fail("REQUEST_INPUT", "inputStatus", "invalid input status");
  if (r.jobId !== hash(requestIdentity(r)) || r.integrity?.sha256 !== hash(requestIdentity(r))) fail("REQUEST_INTEGRITY", "integrity", "request identity mismatch");
  return r;
}
export function validateResult(request, result, packet) {
  validateRequest(request);
  if (!object(result) || result.schemaVersion !== resultVersion) fail("RESULT_SCHEMA", "schemaVersion", "invalid writer result schema", resultVersion, result?.schemaVersion);
  if (result.jobId !== request.jobId || result.writerPacketId !== request.writerPacketId) fail("RESULT_REQUEST_MISMATCH", "jobId/writerPacketId", "result does not match request");
  if (!/^[a-f0-9]{64}$/.test(result.resultId ?? "") || result.resultId !== hash(resultIdentity(result)) || result.integrity?.sha256 !== hash(resultIdentity(result))) fail("RESULT_INTEGRITY", "integrity", "result identity mismatch");
  if (!Number.isFinite(Date.parse(result.generatedAt)) || typeof result.writerEngine !== "string" || typeof result.writerVersion !== "string") fail("RESULT_METADATA", "generatedAt/writerEngine", "invalid result metadata");
  const targets = new Map(request.targetOutputs.map((x) => [x.targetPath, x]));
  if (!Array.isArray(result.outputs) || !result.outputs.length) fail("RESULT_OUTPUTS", "outputs", "outputs are required");
  for (const output of result.outputs) { if (!targets.has(output?.targetPath) || output.targetSchemaVersion !== targets.get(output.targetPath).targetSchemaVersion || !object(output.payload)) fail("RESULT_TARGET", "outputs", "output is not an allowed target"); assertNoForbidden(output.payload, `outputs.${output.targetPath}`); }
  const facts = new Map((packet.facts ?? []).map((f) => [f.factId, f]));
  for (const ref of result.factReferences ?? []) { const fact = facts.get(ref.factId); if (!request.allowedFactIds.includes(ref.factId)) fail("FACT_NOT_ALLOWED", "factReferences", "factId is not allowed", request.allowedFactIds, ref.factId); if (!fact) fail("FACT_MISSING", "factReferences", "fact is absent from packet", "packet fact", ref.factId); if (ref.usedValue !== fact.value) fail("FACT_VALUE", "factReferences", "used value differs from packet", fact.value, ref.usedValue); if (ref.usedUnit !== fact.unit) fail("FACT_UNIT", "factReferences", "used unit differs from packet", fact.unit, ref.usedUnit); if (ref.usedAsOf !== fact.asOf || (fact.asOf && ref.usedAsOf > fact.asOf)) fail("FACT_DATE", "factReferences", "used date differs from packet", fact.asOf, ref.usedAsOf); if (["unavailable", "stale"].includes(fact.status) && /latest|最新|确定|必然/i.test(JSON.stringify(ref))) fail("FACT_STATUS", "factReferences", "unavailable or stale fact has a deterministic/latest conclusion"); }
  return result;
}
function assertNoForbidden(value, prefix = "") { if (Array.isArray(value)) return value.forEach((v, i) => assertNoForbidden(v, `${prefix}.${i}`)); if (!object(value)) return; for (const [k, v] of Object.entries(value)) { if (forbidden.test(`${prefix}.${k}`)) fail("FORBIDDEN_FIELD", `${prefix}.${k}`, "writer result cannot modify frozen model or publication fields"); assertNoForbidden(v, `${prefix}.${k}`); } }
function targets(edition, asOf) { return edition === "daily" ? [{ targetPath: "content/daily-brief.json", targetSchemaVersion: "daily-brief-v1", contentType: "daily-brief", required: true }] : [{ targetPath: `content/weekly-reports/weekly-${asOf.slice(0,4)}-W${String(isoWeek(asOf)).padStart(2, "0")}.json`, targetSchemaVersion: "weekly-report-v1", contentType: "weekly-report", required: true }]; }
function isoWeek(date) { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); return Math.ceil((((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7); }
export function makeRequest({ edition, asOf, packet, createdAt = new Date().toISOString() }) { const allowedFactIds = (packet.facts ?? []).map((f) => f.factId); const inputStatus = packet.providerHealth?.status === "ready" && packet.marketSummary?.status !== "partial" ? "ready" : "partial"; const r = { schemaVersion: requestVersion, edition, requestedAsOf: asOf, createdAt, writerPacketId: packet.writerPacketId, writerPacketPath: `content/writer-packets/${edition}-latest.json`, writerPacketSha256: hash(packet), targetOutputs: targets(edition, asOf), allowedFactIds, requiredSections: ["facts", "explanation", "counterEvidence", "observation"], writerPromptPath: `prompts/luna-${edition}-brief.md`, inputStatus }; r.jobId = hash(requestIdentity(r)); r.integrity = { sha256: hash(requestIdentity(r)) }; return validateRequest(r); }
export function rebuild(rootDir = root) { const requestRoot = path.join(rootDir, "data/writer-jobs/requests"); const entries = []; if (fs.existsSync(requestRoot)) for (const p of walk(requestRoot)) { const r = read(p); entries.push({ jobId: r.jobId, edition: r.edition, requestedAsOf: r.requestedAsOf, requestPath: relative(p), writerPacketId: r.writerPacketId, inputStatus: r.inputStatus, accepted: fs.existsSync(acceptedPath(r.jobId, r.requestedAsOf)) }); } entries.sort((a,b) => a.jobId.localeCompare(b.jobId)); write(path.join(rootDir, "data/writer-jobs/index.json"), { schemaVersion: "writer-job-index-v1", jobs: entries }); for (const edition of ["daily", "weekly"]) { const pending = entries.filter((x) => x.edition === edition && !x.accepted).at(-1) ?? null; write(path.join(rootDir, "content/writer-jobs", `${edition}-pending.json`), { schemaVersion: "writer-job-pending-v1", edition, job: pending }); } return entries; }
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir,e.name)) : [path.join(dir,e.name)]); }
export function prepare({ edition, asOf = new Date().toISOString().slice(0,10), packet, dryRun = false }) { if (!packet) { const command = spawnSync(process.execPath, ["scripts/run-market-evidence.mjs", "run", "--edition", edition, "--as-of", asOf], { cwd: root, stdio: "inherit" }); if (command.status !== 0) throw new Error("MARKET_DATA_FAILED"); packet = read(packetPath(edition)); } const req = makeRequest({ edition, asOf, packet }); const dest = requestPath(req.jobId, asOf); const existing = fs.existsSync(dest) ? read(dest) : null; if (existing && JSON.stringify(canonical(existing)) !== JSON.stringify(canonical(req))) fail("JOB_CONFLICT", relative(dest), "same jobId has different request content"); const summary = { edition, requestedAsOf: asOf, writerPacketId: req.writerPacketId, jobId: req.jobId, requestPath: relative(dest), inputStatus: req.inputStatus, factCount: req.allowedFactIds.length, targetCount: req.targetOutputs.length, created: !existing, noOp: Boolean(existing), warnings: packet.warnings ?? [] }; if (!dryRun && !existing) { write(dest, req); rebuild(); } return { request: req, summary }; }
function gzipDeterministic(value) { return zlib.gzipSync(Buffer.from(`${JSON.stringify(canonical(value))}\n`, "utf8"), { mtime: 0 }); }
export function apply({ request, result, packet, dryRun = false }) { validateResult(request, result, packet); const dest = acceptedPath(request.jobId, request.requestedAsOf); if (fs.existsSync(dest)) { const old = fs.readFileSync(dest); const fresh = gzipDeterministic(result); if (!old.equals(fresh)) fail("ACCEPTED_CONFLICT", relative(dest), "same jobId has a different accepted result"); return { noOp: true, applied: false }; }
  const staged = []; for (const output of result.outputs) { const target = path.join(root, output.targetPath); staged.push({ target, payload: output.payload }); }
  if (dryRun) return { noOp: false, applied: false, files: staged.map((x) => relative(x.target)) };
  for (const item of staged) write(item.target, item.payload); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, gzipDeterministic(result)); rebuild(); return { noOp: false, applied: true, files: staged.map((x) => relative(x.target)) };
}
function args() { const a = process.argv.slice(3); return Object.fromEntries(a.map((v,i) => v.startsWith("--") ? [v.slice(2), a[i+1]?.startsWith("--") ? true : (a[i+1] ?? true)] : null).filter(Boolean)); }
if (process.argv[1]?.endsWith("writer-jobs.mjs")) { const [command] = process.argv.slice(2); const a = args(); try { if (command === "prepare") console.log(JSON.stringify(prepare({ edition:a.edition, asOf:a["as-of"] === "auto" ? new Date().toISOString().slice(0,10) : a["as-of"], dryRun:Boolean(a["dry-run"]) }).summary)); else if (command === "validate") { const request = read(path.resolve(root,a.request)); const result = read(path.resolve(root,a.result)); const packet = read(path.join(root, request.writerPacketPath)); validateResult(request,result,packet); console.log(JSON.stringify({valid:true,jobId:request.jobId,resultId:result.resultId})); } else if (command === "apply") { const request = read(path.resolve(root,a.request)); const result = read(path.resolve(root,a.result)); const packet = read(path.join(root, request.writerPacketPath)); console.log(JSON.stringify(apply({request,result,packet,dryRun:Boolean(a["dry-run"])}))); } else throw new Error("usage: writer-jobs.mjs prepare|validate|apply"); } catch (error) { console.error(error.message); process.exit(1); } }
