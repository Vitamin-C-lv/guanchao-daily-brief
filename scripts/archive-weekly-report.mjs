import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gzip = promisify(gzipCallback);
const root = process.cwd();
const contentRoot = path.join(root, "content", "weekly-reports");
const archiveRoot = path.join(root, "data", "weekly-archive");
const indexPath = path.join(archiveRoot, "index.json");
const MAX_FILES = 104;
const MAX_BYTES = 20 * 1024 * 1024;

async function exists(filePath) { try { await stat(filePath); return true; } catch { return false; } }
async function readIndex() {
  try { const value = JSON.parse(await readFile(indexPath, "utf8")); if (Array.isArray(value.snapshots)) return value; } catch {}
  return { schemaVersion: 1, policy: { maxFiles: MAX_FILES, maxBytes: MAX_BYTES }, snapshots: [] };
}

const published = JSON.parse(await readFile(path.join(contentRoot, "index.json"), "utf8"));
if (!published.latestReportId) {
  console.log("尚无已发布周报，跳过周报归档。");
  process.exit(0);
}

const reportPath = path.join(contentRoot, `${published.latestReportId}.json`);
const report = JSON.parse(await readFile(reportPath, "utf8"));
const bytes = Buffer.from(`${JSON.stringify(report)}\n`, "utf8");
const contentSha256 = createHash("sha256").update(bytes).digest("hex");
const compressed = await gzip(bytes, { level: 9 });
const year = report.report.weekEnd.slice(0, 4);
const fileName = `${report.report.id}-r${report.report.revision}-${contentSha256.slice(0, 10)}.json.gz`;
const relativeFile = `${year}/${fileName}`;
const outputPath = path.join(archiveRoot, relativeFile);
const index = await readIndex();
const duplicate = index.snapshots.find((item) => item.contentSha256 === contentSha256);
if (duplicate && await exists(path.join(archiveRoot, duplicate.file))) {
  console.log(`周报归档未重复写入：${duplicate.file}`);
  process.exit(0);
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(`${outputPath}.tmp`, compressed);
await rename(`${outputPath}.tmp`, outputPath);
index.policy = { maxFiles: MAX_FILES, maxBytes: MAX_BYTES };
index.snapshots.push({ file: relativeFile, reportId: report.report.id, revision: report.report.revision, weekEnd: report.report.weekEnd, archivedAt: new Date().toISOString(), bytes: compressed.byteLength, contentSha256 });
index.snapshots.sort((a, b) => new Date(a.archivedAt) - new Date(b.archivedAt));
let totalBytes = index.snapshots.reduce((sum, item) => sum + item.bytes, 0);
while (index.snapshots.length > MAX_FILES || totalBytes > MAX_BYTES) {
  const oldest = index.snapshots.shift();
  if (!oldest) break;
  try { await unlink(path.join(archiveRoot, oldest.file)); } catch {}
  totalBytes -= oldest.bytes;
}
await mkdir(archiveRoot, { recursive: true });
await writeFile(`${indexPath}.tmp`, `${JSON.stringify(index, null, 2)}\n`, "utf8");
await rename(`${indexPath}.tmp`, indexPath);
console.log(`已创建周报轻量归档：${relativeFile}；当前 ${index.snapshots.length} 份，共 ${totalBytes} 字节。`);
