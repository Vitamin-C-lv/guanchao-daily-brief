import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256Canonical } from "./research-contract.mjs";

const moduleFile = fileURLToPath(import.meta.url);
export const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
export const MEMORY_SCHEMA = "memory-manager-v1";
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PATH_RE = /(?:[A-Za-z]:[\\/]+Users[\\/][^\s"']+|[A-Za-z]:[\\/]+(?:周报个人网站|GuanchaoWorkspace|Guanchao-Workspace)[^\s"']*)/gi;
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const MAC_RE = /\b[0-9A-F]{2}(?::[0-9A-F]{2}){5}\b/gi;
const SECRET_VALUE_RE = /(?:bearer\s+\S{8,}|(?:authorization|password|passwd|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|machine[_-]?id|machineguid|private[_-]?key|secret)\s*[:=]\s*["']?[^\s"']{8,})/gi;
const RAW_PAYLOAD_RE = /["']?(?:rawPayload|raw_provider_payload|providerPayload)["']?\s*[:=]\s*(?:\{|\[|true|["'])/i;

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(file));
    else if (/\.(json|jsonl|md)$/i.test(entry.name)) files.push(file);
  }
  return files.sort();
}

export function sanitizeText(text, source = "memory") {
  let value = String(text).replace(PATH_RE, (match) => {
    if (/Users[\\/]/i.test(match)) return "${GUANCHAO_HOME}";
    return "${REPO_ROOT}";
  });
  const violations = [];
  if (IP_RE.test(value)) violations.push("ip");
  if (MAC_RE.test(value)) violations.push("mac");
  if (SECRET_VALUE_RE.test(value)) violations.push("credential-value");
  if (RAW_PAYLOAD_RE.test(value)) violations.push("raw-provider-payload");
  if (violations.length) throw new Error(`MEMORY_SENSITIVE_DATA ${source}: ${[...new Set(violations)].join(",")}`);
  return value;
}

function parseJsonl(text, source) {
  return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`MEMORY_INVALID_JSONL ${source}:${index + 1}`); }
  });
}

function validateEntry(entry, source) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`MEMORY_INVALID_ENTRY ${source}`);
  if (entry.id === undefined && entry.articleId === undefined && entry.threadId === undefined && entry.lessonId === undefined && entry.judgmentId === undefined && entry.eventId === undefined && entry.reviewId === undefined) throw new Error(`MEMORY_ENTRY_ID_MISSING ${source}`);
  if (entry.updatedAt !== undefined && !DATE.test(String(entry.updatedAt).slice(0, 10))) throw new Error(`MEMORY_ENTRY_DATE_INVALID ${source}`);
  return entry;
}

export function validateMemoryTree(memoryRoot = path.join(repositoryRoot, "memory")) {
  const files = walk(memoryRoot);
  const records = [];
  for (const file of files) {
    const text = sanitizeText(fs.readFileSync(file, "utf8"), file);
    if (file.endsWith(".jsonl")) records.push(...parseJsonl(text, file).map((entry) => validateEntry(entry, file)));
    else if (file.endsWith(".json")) {
      const value = JSON.parse(text);
      if (Array.isArray(value)) value.forEach((entry) => validateEntry(entry, file));
      else if (value?.entries && Array.isArray(value.entries)) value.entries.forEach((entry) => validateEntry(entry, file));
    }
  }
  return { schemaVersion: MEMORY_SCHEMA, valid: true, files: files.length, records: records.length, sensitiveValues: 0 };
}

export function sanitizeMemoryTree(memoryRoot = path.join(repositoryRoot, "memory"), { write = false } = {}) {
  const files = walk(memoryRoot);
  let changed = 0;
  for (const file of files) {
    const before = fs.readFileSync(file, "utf8");
    const after = sanitizeText(before, file);
    if (after !== before) {
      if (write) fs.writeFileSync(file, after, "utf8");
      changed += 1;
    }
    if (file.endsWith(".jsonl")) parseJsonl(after, file).forEach((entry) => validateEntry(entry, file));
    if (file.endsWith(".json")) {
      const value = JSON.parse(after);
      if (value?.entries && Array.isArray(value.entries)) value.entries.forEach((entry) => validateEntry(entry, file));
    }
  }
  return { schemaVersion: MEMORY_SCHEMA, valid: true, write, files: files.length, changed, publicPathPlaceholder: "${GUANCHAO_HOME}" };
}

function entryId(entry) {
  return entry.id ?? entry.threadId ?? entry.lessonId ?? entry.judgmentId ?? entry.eventId ?? entry.reviewId ?? sha256Canonical(entry).slice(0, 24);
}

const typeTargets = {
  open_thread: "editorial/OPEN_THREADS.jsonl",
  judgment: "editorial/JUDGMENTS.jsonl",
  lesson: "editorial/LESSONS.jsonl",
  policy_event: "editorial/POLICY_WATCH.jsonl",
  state_capital_event: "editorial/STATE_CAPITAL_WATCH.jsonl",
  prediction_review: "editorial/PREDICTION_REVIEWS.jsonl",
};

export function validateMemoryDelta(delta) {
  if (delta?.schemaVersion !== "memory-delta-v1") throw new Error("MEMORY_DELTA_SCHEMA");
  if (!DATE.test(delta.editionDate) || !Number.isFinite(Date.parse(delta.generatedAt))) throw new Error("MEMORY_DELTA_DATE");
  if (!Array.isArray(delta.entries)) throw new Error("MEMORY_DELTA_ENTRIES");
  const ids = new Set();
  for (const entry of delta.entries) {
    validateEntry(entry, "memory delta");
    const id = entryId(entry);
    if (ids.has(id)) throw new Error(`MEMORY_DELTA_DUPLICATE ${id}`);
    ids.add(id);
    if (!typeTargets[entry.type]) throw new Error(`MEMORY_DELTA_TYPE ${entry.type}`);
    if (!Array.isArray(entry.sourceIds) || entry.sourceIds.length === 0 || entry.sourceIds.some((id) => typeof id !== "string" || !id.length)) throw new Error(`MEMORY_DELTA_EVIDENCE ${id}`);
  }
  return { valid: true, entries: delta.entries.length };
}

export function mergeMemoryDelta(delta, memoryRoot = path.join(repositoryRoot, "memory")) {
  validateMemoryDelta(delta);
  const grouped = new Map();
  for (const entry of delta.entries) {
    const target = path.join(memoryRoot, typeTargets[entry.type]);
    const list = grouped.get(target) ?? [];
    list.push(entry);
    grouped.set(target, list);
  }
  const written = [];
  for (const [target, additions] of grouped) {
    const existing = fs.existsSync(target) ? parseJsonl(fs.readFileSync(target, "utf8"), target) : [];
    const byId = new Map(existing.map((entry) => [entryId(entry), entry]));
    for (const entry of additions) {
      const id = entryId(entry);
      const prior = byId.get(id);
      if (!prior || String(entry.updatedAt ?? "") >= String(prior.updatedAt ?? "")) byId.set(id, entry);
    }
    const output = [...byId.values()].sort((left, right) => entryId(left).localeCompare(entryId(right))).map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, sanitizeText(output, target), "utf8");
    written.push(path.relative(memoryRoot, target).replaceAll("\\", "/"));
  }
  return { schemaVersion: "memory-merge-v1", validated: true, deduped: true, sanitized: true, written };
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const memoryRoot = path.resolve(argument("--memory-root", path.join(repositoryRoot, "memory")));
    const command = process.argv[2] ?? "validate";
    if (command === "sanitize") console.log(JSON.stringify(sanitizeMemoryTree(memoryRoot, { write: !process.argv.includes("--check-only") }), null, 2));
    else if (command === "validate") console.log(JSON.stringify(validateMemoryTree(memoryRoot), null, 2));
    else if (command === "merge") {
      const delta = readJson(path.resolve(argument("--delta")));
      console.log(JSON.stringify(mergeMemoryDelta(delta, memoryRoot), null, 2));
    } else throw new Error("usage: memory-manager.mjs validate|sanitize|merge");
  } catch (error) {
    console.error(`MEMORY_MANAGER_FAILURE ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
