import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const root = process.cwd();
const publicRoot = path.join(root, "public");
const generatedRoot = path.join(publicRoot, "generated");
const editorialRoot = path.join(generatedRoot, "editorial");
const dailyPath = path.join(root, "content", "daily-brief.json");
const weeklyRoot = path.join(root, "content", "weekly-reports");
const MAX_ASSETS_PER_YEAR = 104;
const MAX_BYTES_PER_YEAR = 20 * 1024 * 1024;
const MAX_ASSET_BYTES = 180 * 1024;
const REQUIRED_WIDTH = 1200;
const REQUIRED_HEIGHT = 675;
const prune = process.argv.slice(2).includes("--prune");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--prune");

if (unknownArgs.length) {
  console.error(`未知参数：${unknownArgs.join(" ")}。仅支持 --prune。`);
  process.exit(1);
}

const errors = [];
const visualReferences = [];
const referencedSources = new Set();

function fail(message) {
  errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function collectVisuals(value, label) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectVisuals(item, `${label}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childLabel = `${label}.${key}`;
    if (key === "visual") {
      if (child === null || child === undefined) continue;
      if (!isObject(child)) fail(`${childLabel} 必须是对象或省略`);
      else visualReferences.push({ visual: child, label: childLabel });
      continue;
    }
    collectVisuals(child, childLabel);
  }
}

function parseAssetSource(src, label) {
  if (typeof src !== "string" || !src) {
    fail(`${label}.src 必须是站内图片路径`);
    return null;
  }
  if (src.includes("\\") || src.includes("?") || src.includes("#") || src.includes("%")) {
    fail(`${label}.src 不得包含反斜线、查询参数、锚点或编码转义`);
    return null;
  }
  const match = src.match(/^\/generated\/editorial\/(\d{4})\/(0[1-9]|1[0-2])\/(\d{4}-\d{2}-\d{2})-([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)-([a-f0-9]{12})\.webp$/);
  if (!match) {
    fail(`${label}.src 必须符合 /generated/editorial/YYYY/MM/YYYY-MM-DD-slug-<12位哈希>.webp`);
    return null;
  }
  const [, directoryYear, directoryMonth, date, slug, shortHash] = match;
  if (!isValidDate(date) || date.slice(0, 4) !== directoryYear || date.slice(5, 7) !== directoryMonth) {
    fail(`${label}.src 的目录年月必须与文件日期一致`);
    return null;
  }
  const filePath = path.resolve(publicRoot, `.${src}`);
  const relative = path.relative(editorialRoot, filePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(`${label}.src 逃逸了 public/generated/editorial`);
    return null;
  }
  return { src, filePath, year: directoryYear, slug, shortHash };
}

async function listFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(entryPath));
    else files.push(entryPath);
  }
  return files;
}

async function listJsonFiles() {
  const files = [dailyPath];
  try {
    const weeklyFiles = await readdir(weeklyRoot, { withFileTypes: true });
    files.push(...weeklyFiles.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => path.join(weeklyRoot, entry.name)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return files;
}

async function removeEmptyDirectories(directory, keepRoot = true) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await removeEmptyDirectories(path.join(directory, entry.name), false);
  }
  if (!keepRoot && (await readdir(directory)).length === 0) await rmdir(directory);
}

for (const jsonPath of await listJsonFiles()) {
  const relative = path.relative(root, jsonPath).replaceAll("\\", "/");
  try {
    collectVisuals(JSON.parse(await readFile(jsonPath, "utf8")), relative);
  } catch (error) {
    fail(`${relative} 无法读取或解析：${error.message}`);
  }
}

for (const reference of visualReferences) {
  const parsed = parseAssetSource(reference.visual.src, reference.label);
  if (parsed) {
    reference.asset = parsed;
    referencedSources.add(parsed.src);
  }
}

let generatedFiles = await listFiles(generatedRoot);
const webpFiles = [];
for (const filePath of generatedFiles) {
  const relative = path.relative(publicRoot, filePath).replaceAll("\\", "/");
  if (path.basename(filePath) === ".gitkeep") continue;
  if (path.extname(filePath).toLowerCase() !== ".webp") fail(`public/${relative} 不是允许的 WebP 资产`);
  else webpFiles.push(filePath);
}

if (prune && errors.length) {
  console.error("资产清理已取消：内容引用或目录结构存在错误，避免误删。\n");
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

let pruned = 0;
if (prune) {
  for (const filePath of webpFiles) {
    const src = `/${path.relative(publicRoot, filePath).replaceAll("\\", "/")}`;
    if (!referencedSources.has(src)) {
      await unlink(filePath);
      pruned += 1;
    }
  }
  await removeEmptyDirectories(generatedRoot);
  generatedFiles = await listFiles(generatedRoot);
}

const remainingWebpFiles = generatedFiles.filter((filePath) => path.extname(filePath).toLowerCase() === ".webp");
const inspections = new Map();

async function inspectAsset(asset, label) {
  if (inspections.has(asset.src)) return inspections.get(asset.src);
  const inspection = (async () => {
    let info;
    try {
      info = await stat(asset.filePath);
    } catch {
      fail(`${label}.src 指向的文件不存在：${asset.src}`);
      return null;
    }
    if (!info.isFile()) {
      fail(`${label}.src 不是普通文件：${asset.src}`);
      return null;
    }
    try {
      const [realFile, realRoot] = await Promise.all([realpath(asset.filePath), realpath(editorialRoot)]);
      const relative = path.relative(realRoot, realFile);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        fail(`${label}.src 通过符号链接逃逸了生成目录`);
        return null;
      }
    } catch (error) {
      fail(`${label}.src 无法安全解析：${error.message}`);
      return null;
    }
    const buffer = await readFile(asset.filePath);
    const digest = hash(buffer);
    let metadata;
    try {
      metadata = await sharp(buffer).metadata();
    } catch (error) {
      fail(`${label}.src 不是可读取的图片：${error.message}`);
      return null;
    }
    return { info, buffer, digest, metadata };
  })();
  inspections.set(asset.src, inspection);
  return inspection;
}

for (const reference of visualReferences) {
  const { visual, label, asset } = reference;
  if (!asset) continue;
  const inspected = await inspectAsset(asset, label);
  if (!inspected) continue;
  const { info, digest, metadata } = inspected;
  if (metadata.format !== "webp") fail(`${label}.src 实际格式不是 WebP`);
  if (metadata.width !== REQUIRED_WIDTH || metadata.height !== REQUIRED_HEIGHT) fail(`${label}.src 必须是 1200×675，当前为 ${metadata.width}×${metadata.height}`);
  if ((metadata.pages ?? 1) !== 1) fail(`${label}.src 不得是动画或多页图片`);
  if (metadata.exif || metadata.icc || metadata.iptc || metadata.xmp) fail(`${label}.src 仍包含 EXIF/ICC/IPTC/XMP 元数据`);
  if (info.size <= 0 || info.size > MAX_ASSET_BYTES) fail(`${label}.src 必须大于0且不超过180KB，当前为 ${info.size} 字节`);
  if (visual.width !== REQUIRED_WIDTH || visual.height !== REQUIRED_HEIGHT) fail(`${label}.width/height 必须精确为 1200/675`);
  if (!Number.isInteger(visual.bytes) || visual.bytes !== info.size) fail(`${label}.bytes 必须等于实际文件大小 ${info.size}`);
  if (typeof visual.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(visual.sha256) || visual.sha256 !== digest) fail(`${label}.sha256 必须等于文件 SHA256`);
  if (asset.shortHash !== digest.slice(0, 12)) fail(`${label}.src 文件名哈希与文件内容不一致`);
}

const annual = new Map();
for (const filePath of remainingWebpFiles) {
  const src = `/${path.relative(publicRoot, filePath).replaceAll("\\", "/")}`;
  const parsed = parseAssetSource(src, `资产 ${src}`);
  if (!parsed) continue;
  const info = await stat(filePath);
  const current = annual.get(parsed.year) ?? { count: 0, bytes: 0 };
  current.count += 1;
  current.bytes += info.size;
  annual.set(parsed.year, current);
  if (!referencedSources.has(src) && !prune) fail(`未引用的生成资产：${src}；运行 pnpm assets:prune 可安全清理`);
}

for (const [year, usage] of [...annual.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  if (usage.count > MAX_ASSETS_PER_YEAR) fail(`${year} 年生成资产 ${usage.count} 张，超过 ${MAX_ASSETS_PER_YEAR} 张上限`);
  if (usage.bytes > MAX_BYTES_PER_YEAR) fail(`${year} 年生成资产 ${usage.bytes} 字节，超过 ${MAX_BYTES_PER_YEAR} 字节上限`);
}

if (errors.length) {
  console.error(`\nAI 配图资产校验失败（${errors.length} 项）：`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const annualSummary = [...annual.entries()]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([year, usage]) => `${year}: ${usage.count}张 / ${(usage.bytes / 1024 / 1024).toFixed(2)}MB`)
  .join("；") || "暂无资产";
console.log(`AI 配图资产校验通过：${visualReferences.length} 处引用，${remainingWebpFiles.length} 个发布文件；${annualSummary}。${prune ? `已清理 ${pruned} 个未引用文件。` : ""}`);
