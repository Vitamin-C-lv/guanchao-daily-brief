import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const root = process.cwd();
const generatedRoot = path.join(root, "public", "generated", "editorial");
const stagingRoot = path.join(root, ".generated-staging");
const OUTPUT_WIDTH = 1200;
const OUTPUT_HEIGHT = 675;
const MAX_OUTPUT_BYTES = 180 * 1024;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 64 * 1024 * 1024;
const QUALITIES = [82, 78, 74, 70, 66, 62, 58, 54, 50, 46, 42];

function usage() {
  return [
    "用法：",
    "  pnpm visual:publish -- --input <图片路径> --date YYYY-MM-DD --slug <ascii-slug>",
    "",
    "输出：1200×675 WebP，并在 stdout 打印可写入 visual 字段的 JSON 元数据。",
  ].join("\n");
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") continue;
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`未知参数：${token}\n${usage()}`);
    const key = token.slice(2);
    if (!["input", "date", "slug"].includes(key)) throw new Error(`未知参数：${token}\n${usage()}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} 缺少值。\n${usage()}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function renderAtQuality(inputPath, quality) {
  return sharp(inputPath, {
    animated: false,
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .resize(OUTPUT_WIDTH, OUTPUT_HEIGHT, { fit: "cover", position: "centre" })
    .flatten({ background: "#f5f2f7" })
    .webp({ quality, alphaQuality: quality, effort: 6, smartSubsample: true })
    .toBuffer();
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}
if (!args.input || !args.date || !args.slug) throw new Error(`--input、--date 和 --slug 均为必填。\n${usage()}`);
if (!isValidDate(args.date)) throw new Error("--date 必须是真实存在的 YYYY-MM-DD 日期。");
if (!/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/.test(args.slug)) {
  throw new Error("--slug 只能包含 1–80 个小写英文字母、数字和中划线，且不能以中划线开头或结尾。");
}

const inputPath = path.resolve(root, args.input);
const inputInfo = await stat(inputPath).catch(() => null);
if (!inputInfo?.isFile()) throw new Error(`输入文件不存在或不是普通文件：${inputPath}`);
if (inputInfo.size <= 0 || inputInfo.size > MAX_INPUT_BYTES) {
  throw new Error(`输入文件必须大于 0 且不超过 ${MAX_INPUT_BYTES} 字节；当前为 ${inputInfo.size} 字节。`);
}

const inputMetadata = await sharp(inputPath, {
  animated: false,
  failOn: "error",
  limitInputPixels: MAX_INPUT_PIXELS,
}).metadata();
if (!inputMetadata.width || !inputMetadata.height) throw new Error("无法读取输入图片尺寸。");
if ((inputMetadata.pages ?? 1) !== 1) throw new Error("不接受动画或多页图片。");

let outputBuffer;
let selectedQuality;
let smallestAttempt;
for (const quality of QUALITIES) {
  const candidate = await renderAtQuality(inputPath, quality);
  if (!smallestAttempt || candidate.byteLength < smallestAttempt.byteLength) smallestAttempt = candidate;
  if (candidate.byteLength <= MAX_OUTPUT_BYTES) {
    outputBuffer = candidate;
    selectedQuality = quality;
    break;
  }
}
if (!outputBuffer) {
  throw new Error(`降至质量 ${QUALITIES.at(-1)} 后仍有 ${smallestAttempt?.byteLength ?? 0} 字节，超过 180KB，拒绝发布。`);
}

const outputMetadata = await sharp(outputBuffer).metadata();
if (outputMetadata.format !== "webp" || outputMetadata.width !== OUTPUT_WIDTH || outputMetadata.height !== OUTPUT_HEIGHT) {
  throw new Error("内部错误：生成文件不是预期的 1200×675 WebP。");
}
if (outputMetadata.exif || outputMetadata.icc || outputMetadata.iptc || outputMetadata.xmp) {
  throw new Error("内部错误：输出文件仍包含 EXIF/ICC/IPTC/XMP 元数据。");
}

const digest = sha256(outputBuffer);
const [year, month] = args.date.split("-");
const fileName = `${args.date}-${args.slug}-${digest.slice(0, 12)}.webp`;
const outputDirectory = path.join(generatedRoot, year, month);
const outputPath = path.join(outputDirectory, fileName);
const publicPath = `/generated/editorial/${year}/${month}/${fileName}`;

await mkdir(outputDirectory, { recursive: true });
await mkdir(stagingRoot, { recursive: true });

if (await exists(outputPath)) {
  const existing = await readFile(outputPath);
  if (sha256(existing) !== digest) throw new Error(`哈希文件名发生冲突，拒绝覆盖：${outputPath}`);
} else {
  const stagingPath = path.join(stagingRoot, `${process.pid}-${Date.now()}-${digest.slice(0, 12)}.webp`);
  try {
    await writeFile(stagingPath, outputBuffer, { flag: "wx" });
    await rename(stagingPath, outputPath);
  } catch (error) {
    await unlink(stagingPath).catch(() => {});
    throw error;
  }
}

console.log(JSON.stringify({
  kind: "ai-editorial-illustration",
  src: publicPath,
  width: OUTPUT_WIDTH,
  height: OUTPUT_HEIGHT,
  bytes: outputBuffer.byteLength,
  sha256: digest,
  generator: "openai-image",
  generatedAt: new Date().toISOString(),
  quality: selectedQuality,
}, null, 2));
