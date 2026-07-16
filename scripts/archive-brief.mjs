import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);
const root = process.cwd();
const sourcePath = path.join(root, "content", "daily-brief.json");
const archiveRoot = path.join(root, "data", "archive");
const indexPath = path.join(archiveRoot, "index.json");
const MAX_FILES = 400;
const MAX_BYTES = 50 * 1024 * 1024;

function collectArticles(brief) {
  return [
    ...(brief.federalReserve?.articles ?? []),
    ...(brief.markets ?? []).flatMap((market) => market.articles ?? []),
    ...(brief.hotspots ?? []),
  ];
}

function safeTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "000000";
  return `${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
}

async function readIndex() {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8"));
    if (Array.isArray(parsed.snapshots)) return parsed;
  } catch {
    // The first archive has no index yet.
  }
  return {
    schemaVersion: 1,
    policy: { maxFiles: MAX_FILES, maxBytes: MAX_BYTES, content: "structured-summary-only" },
    snapshots: [],
  };
}

async function writeIndex(index) {
  const temporary = `${indexPath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(temporary, indexPath);
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

const brief = JSON.parse(await readFile(sourcePath, "utf8"));
const articles = collectArticles(brief);
const sourceUrls = [...new Set(articles.flatMap((article) => article.sources ?? []).map((source) => source.url).filter(Boolean))];
const editionDate = brief.meta?.editionDate;

if (!/^\d{4}-\d{2}-\d{2}$/.test(editionDate ?? "")) {
  throw new Error("meta.editionDate 必须是 YYYY-MM-DD，无法创建归档。");
}

const archivedAt = new Date().toISOString();
const contentBytes = Buffer.from(`${JSON.stringify(brief)}\n`, "utf8");
const contentSha256 = createHash("sha256").update(contentBytes).digest("hex");
const snapshot = {
  schemaVersion: 1,
  archivedAt,
  contentSha256,
  storagePolicy: {
    mode: "structured-summary-only",
    copiedArticles: false,
    downloadedMedia: false,
  },
  provenance: {
    articleCount: articles.length,
    uniqueSourceCount: sourceUrls.length,
    sourceUrls,
  },
  brief,
};

const uncompressed = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
const archiveSha256 = createHash("sha256").update(uncompressed).digest("hex");
const compressed = await gzip(uncompressed, { level: 9 });
const [year, month] = editionDate.split("-");
const relativeDirectory = path.join(year, month);
const archiveDirectory = path.join(archiveRoot, relativeDirectory);
const fileName = `${editionDate}-${safeTime(brief.meta?.generatedAt)}-${contentSha256.slice(0, 10)}.json.gz`;
const relativeFile = path.join(relativeDirectory, fileName).replaceAll("\\", "/");
const archivePath = path.join(archiveRoot, relativeFile);

await mkdir(archiveDirectory, { recursive: true });
const index = await readIndex();
const duplicate = index.snapshots.find((entry) => entry.contentSha256 === contentSha256);

if (duplicate && await fileExists(path.join(archiveRoot, duplicate.file))) {
  console.log(`归档未重复写入：${duplicate.file}（内容哈希相同）`);
  process.exit(0);
}

const temporaryArchive = `${archivePath}.tmp`;
await writeFile(temporaryArchive, compressed);
await rename(temporaryArchive, archivePath);

index.policy = { maxFiles: MAX_FILES, maxBytes: MAX_BYTES, content: "structured-summary-only" };
index.snapshots.push({
  file: relativeFile,
  editionDate,
  generatedAt: brief.meta?.generatedAt,
  archivedAt,
  bytes: compressed.byteLength,
  uncompressedBytes: uncompressed.byteLength,
  contentSha256,
  archiveSha256,
  articleCount: articles.length,
  uniqueSourceCount: sourceUrls.length,
});

index.snapshots.sort((left, right) => new Date(left.archivedAt) - new Date(right.archivedAt));
let totalBytes = index.snapshots.reduce((sum, entry) => sum + (Number(entry.bytes) || 0), 0);

while (index.snapshots.length > MAX_FILES || totalBytes > MAX_BYTES) {
  const oldest = index.snapshots.shift();
  if (!oldest) break;
  const oldestPath = path.join(archiveRoot, oldest.file);
  try {
    await unlink(oldestPath);
  } catch {
    // Missing historical files should not block today's archive.
  }
  totalBytes -= Number(oldest.bytes) || 0;
}

await writeIndex(index);

console.log(`已创建轻量归档：${relativeFile}`);
console.log(`压缩后 ${compressed.byteLength} 字节，原始 ${uncompressed.byteLength} 字节，${sourceUrls.length} 个唯一来源。`);
console.log(`当前共 ${index.snapshots.length} 份归档，总计 ${totalBytes} 字节；上限 ${MAX_FILES} 份 / ${MAX_BYTES} 字节。`);
