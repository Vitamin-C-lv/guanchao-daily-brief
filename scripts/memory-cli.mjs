import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateMemoryTree } from "./memory-manager.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");
const memoryRoot = path.join(repositoryRoot, "memory");

function json(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function jsonl(file) { return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
function allRecords() {
  const records = [];
  for (const file of ["editorial/OPEN_THREADS.jsonl", "editorial/JUDGMENTS.jsonl", "editorial/LESSONS.jsonl", "editorial/POLICY_WATCH.jsonl", "editorial/STATE_CAPITAL_WATCH.jsonl", "editorial/PREDICTION_REVIEWS.jsonl"]) {
    const full = path.join(memoryRoot, file);
    if (fs.existsSync(full)) records.push(...jsonl(full).map((record) => ({ ...record, _path: file })));
  }
  return records;
}

function requireArg(name) {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function search(query) {
  const normalized = String(query).toLowerCase();
  const matches = allRecords().filter((record) => JSON.stringify(record).toLowerCase().includes(normalized)).slice(0, 50);
  return { schemaVersion: "memory-search-v1", query, count: matches.length, results: matches };
}

function expandThread(id) {
  const thread = allRecords().find((record) => record.threadId === id || record.id === id);
  if (!thread) throw new Error(`MEMORY_THREAD_NOT_FOUND ${id}`);
  return { schemaVersion: "memory-thread-v1", thread, related: allRecords().filter((record) => (thread.sourceIds ?? []).some((sourceId) => JSON.stringify(record).includes(sourceId))).slice(0, 20) };
}

function openArticle(id) {
  const index = json(path.join(memoryRoot, "editorial", "ARTICLE_INDEX.json"));
  const entry = index.entries?.find((item) => item.articleId === id);
  if (!entry) throw new Error(`MEMORY_ARTICLE_NOT_FOUND ${id}`);
  const target = path.resolve(repositoryRoot, ...entry.path.split("/"));
  const relation = path.relative(repositoryRoot, target);
  if (relation.startsWith("..") || path.isAbsolute(relation)) throw new Error("MEMORY_ARTICLE_UNSAFE_PATH");
  return { schemaVersion: "memory-article-v1", index: entry, article: json(target) };
}

try {
  validateMemoryTree(memoryRoot);
  const command = process.argv[2];
  const result = command === "search" ? search(requireArg("--query")) : command === "expand-thread" ? expandThread(requireArg("--id")) : command === "open-article" ? openArticle(requireArg("--id")) : (() => { throw new Error("usage: memory-cli.mjs search --query <text> | expand-thread --id <id> | open-article --id <id>"); })();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`MEMORY_QUERY_FAILURE ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
