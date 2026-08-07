import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const moduleFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(moduleFile), "..");
const background = "#f1edf5";
const source = path.join(root, "public", "brand", "guanchao-logo-mark.png");

const outputs = [
  ["public/icons/apple-touch-icon.png", 180, 0.78],
  ["public/icons/icon-192.png", 192, 0.78],
  ["public/icons/icon-512.png", 512, 0.78],
  ["public/icons/icon-maskable-192.png", 192, 0.62],
  ["public/icons/icon-maskable-512.png", 512, 0.62],
  ["app/apple-icon.png", 180, 0.78],
  ["app/icon.png", 512, 0.78],
];

async function make(file, size, ratio) {
  const logo = await sharp(source).resize(Math.round(size * ratio), Math.round(size * ratio), { fit: "contain" }).png().toBuffer();
  const offset = Math.round((size - size * ratio) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: logo, left: offset, top: offset }])
    .png()
    .toFile(path.join(root, file));
}

for (const [file, size, ratio] of outputs) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  await make(file, size, ratio);
}
console.log(JSON.stringify({ background, source: "public/brand/guanchao-logo-mark.png", outputs: outputs.map(([file, size]) => ({ file, size, opaque: true })) }, null, 2));
