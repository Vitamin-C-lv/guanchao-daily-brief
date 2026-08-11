import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readerRoots = ["app", "components", "lib"];
const forbidden = /from\s+["'][^"']*(?:luna|openai|codex-writer|writer-jobs|research-pipeline|model-research)[^"']*["']/iu;

function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(file) : /\.(?:ts|tsx)$/u.test(entry.name) ? [file] : [];
  });
}

test("reader render and loaders import no generation pipeline", () => {
  const violations = readerRoots.flatMap((relative) => filesBelow(path.join(root, relative)))
    .filter((file) => forbidden.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).split(path.sep).join("/"));
  assert.deepEqual(violations, []);
});
