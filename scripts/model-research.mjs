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

const pythonArgs = (target, targetCommand, extra = []) => [
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
  target,
  targetCommand,
  ...extra,
];

const result = spawnSync("uv", pythonArgs(script, command, rest), { stdio: "inherit", windowsHide: true });

if (result.error) {
  console.error(`model research launcher failed: ${result.error.message}`);
  process.exit(2);
}
if ((result.status ?? 2) !== 0) process.exit(result.status ?? 2);

// HK research is validated as a separate candidate-only boundary.  Training,
// evaluation and shadow inference remain the existing explicit A-share CLI;
// no HK data is discovered or fetched implicitly here.
if (command === "validate") {
  const hkScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "hk_model_research.py");
  const hkResult = spawnSync("uv", pythonArgs(hkScript, "validate"), { stdio: "inherit", windowsHide: true });
  if (hkResult.error) {
    console.error(`HK model research validation failed: ${hkResult.error.message}`);
    process.exit(2);
  }
  process.exit(hkResult.status ?? 2);
}
process.exit(0);
