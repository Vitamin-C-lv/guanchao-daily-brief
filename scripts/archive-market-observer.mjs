import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.cwd();
const sourcePath = path.join(root, "content", "market-observer.json");
const snapshot = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
const kind = process.argv[2] || snapshot.meta?.snapshotKind || "close";
if (!new Set(["morning", "close", "weekly"]).has(kind)) throw new Error(`invalid snapshot kind: ${kind}`);
const edition = snapshot.meta?.editionDate;
if (!/^\d{4}-\d{2}-\d{2}$/.test(edition || "")) throw new Error("invalid edition date");

const directory = path.join(root, "data", "market-observer-history");
fs.mkdirSync(directory, { recursive: true });
const payload = Buffer.from(JSON.stringify(snapshot));
if (payload.length > 256 * 1024) throw new Error("market observer snapshot exceeds 256 KiB size limit");
const target = path.join(directory, `${edition}-${kind}.json.gz`);
fs.writeFileSync(target, zlib.gzipSync(payload, { level: 9 }));

const files = fs.readdirSync(directory)
  .filter((name) => name.endsWith(".json.gz"))
  .sort()
  .reverse();
for (const stale of files.slice(800)) fs.rmSync(path.join(directory, stale));
console.log(`archived ${path.relative(root, target)} (${fs.statSync(target).size} bytes)`);
