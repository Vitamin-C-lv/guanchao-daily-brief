import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const node = process.execPath;
const validator = path.join(root, "scripts", "validate-prediction-dataset.mjs");
test("validates every registered immutable snapshot", () => {
  const result = spawnSync(node, [validator], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
for (const fixture of readdirSync(path.join(root, "scripts", "fixtures", "prediction-dataset")).filter((name) => name.endsWith(".json"))) {
  test(`rejects ${fixture}`, () => {
    const result = spawnSync(node, [validator, "--fixture", path.join("scripts", "fixtures", "prediction-dataset", fixture)], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0, `${fixture} must fail validation`);
  });
}
