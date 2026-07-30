#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "model_research.py");
const [command, ...rest] = process.argv.slice(2);

if (!command) {
  console.error("usage: model-research.mjs <validate|train|evaluate|shadow> [explicit arguments]");
  process.exit(2);
}

const result = spawnSync(
  "uv",
  [
    "run",
    "--offline",
    "--no-project",
    "--python",
    "3.12",
    "--with",
    "requests",
    "--with",
    "numpy",
    "python",
    script,
    command,
    ...rest,
  ],
  { stdio: "inherit", windowsHide: true },
);

if (result.error) {
  console.error(`model research launcher failed: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 2);
