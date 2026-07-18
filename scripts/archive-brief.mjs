import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);
const root = process.cwd();
const sourcePath = path.join(root, "content", "daily-brief.json");
const rotationPath = path.join(root, "content", "sector-rotation.json");
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

function collectUrls(value, urls = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, urls);
    return urls;
  }
  if (!value || typeof value !== "object") return urls;
  if (typeof value.url === "string" && /^https?:\/\//i.test(value.url)) {
    urls.push(value.url);
  }
  for (const child of Object.values(value)) collectUrls(child, urls);
  return urls;
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
    policy: { maxFiles: MAX_FILES, maxBytes: MAX_BYTES, content: "structured-brief-only" },
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

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const brief = JSON.parse(await readFile(sourcePath, "utf8"));
const sectorRotation = await readOptionalJson(rotationPath);
const articles = collectArticles(brief);
const briefSourceUrls = collectUrls(brief);
const rotationSourceUrls = sectorRotation ? collectUrls(sectorRotation) : [];
const sourceUrls = [...new Set([...briefSourceUrls, ...rotationSourceUrls])];
const editionDate = brief.meta?.editionDate;

if (!/^\d{4}-\d{2}-\d{2}$/.test(editionDate ?? "")) {
  throw new Error("meta.editionDate 必须是 YYYY-MM-DD，无法创建归档。");
}

const archivedAt = new Date().toISOString();
// Keep the old brief-only byte representation when rotation is absent so
// schema-v1 hashes and duplicate detection remain backward compatible.
const hashPayload = sectorRotation ? { brief, sectorRotation } : brief;
const contentBytes = Buffer.from(`${JSON.stringify(hashPayload)}\n`, "utf8");
const contentSha256 = createHash("sha256").update(contentBytes).digest("hex");
const briefSha256 = createHash("sha256").update(Buffer.from(`${JSON.stringify(brief)}\n`, "utf8")).digest("hex");
const rotationSha256 = sectorRotation
  ? createHash("sha256").update(Buffer.from(`${JSON.stringify(sectorRotation)}\n`, "utf8")).digest("hex")
  : null;
const snapshot = {
  schemaVersion: 2,
  archivedAt,
  contentSha256,
  hashScope: sectorRotation ? "brief+sector-rotation" : "brief-only",
  briefSha256,
  ...(rotationSha256 ? { rotationSha256 } : {}),
  storagePolicy: {
    mode: sectorRotation ? "structured-brief-and-rotation" : "structured-brief-only",
    copiedArticles: false,
    downloadedMedia: false,
  },
  provenance: {
    articleCount: articles.length,
    uniqueSourceCount: sourceUrls.length,
    sourceUrls,
  },
  brief,
  ...(sectorRotation ? { sectorRotation } : {}),
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

index.schemaVersion = 2;
index.policy = { maxFiles: MAX_FILES, maxBytes: MAX_BYTES, content: "structured-brief-and-optional-rotation" };
index.snapshots.push({
  file: relativeFile,
  editionDate,
  generatedAt: brief.meta?.generatedAt,
  archivedAt,
  bytes: compressed.byteLength,
  uncompressedBytes: uncompressed.byteLength,
  contentSha256,
  hashScope: snapshot.hashScope,
  briefSha256,
  ...(rotationSha256 ? { rotationSha256 } : {}),
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
