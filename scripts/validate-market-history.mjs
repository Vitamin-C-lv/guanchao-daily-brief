import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd(), "public", "data", "market-history");
const index = JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
assert.equal(index.schemaVersion, "public-market-history-v1");
assert.equal(index.instruments.length, 9);
assert.deepEqual(
  index.instruments.map((entry) => entry.instrument.id).sort(),
  ["chinext", "dow-jones", "hang-seng", "hang-seng-china-enterprises", "hang-seng-tech", "nasdaq-composite", "sp500", "sse-composite", "szse-component"],
);
assert.equal(index.instruments.some((entry) => entry.instrument.id === "hang-seng-composite"), false);
const today = "2026-08-07";

for (const entry of index.instruments) {
  const document = JSON.parse(await readFile(path.join(root, entry.path), "utf8"));
  assert.equal(document.schemaVersion, index.schemaVersion, entry.instrument.id);
  assert.equal(document.instrument.id, entry.instrument.id, entry.instrument.id);
  assert.equal(document.bars.length, entry.rowCount, entry.instrument.id);
  assert.equal(entry.firstDate, document.bars[0]?.time ?? null, entry.instrument.id);
  assert.equal(entry.lastDate, document.bars.at(-1)?.time ?? null, entry.instrument.id);
  for (let i = 0; i < document.bars.length; i += 1) {
    const bar = document.bars[i];
    assert.match(bar.time, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(bar.time <= today, `${entry.instrument.id} has future date ${bar.time}`);
    assert.ok(bar.high >= Math.max(bar.open, bar.close, bar.low));
    assert.ok(bar.low <= Math.min(bar.open, bar.close, bar.high));
    if (i > 0) assert.ok(document.bars[i - 1].time < bar.time, `${entry.instrument.id} dates are not unique/sorted`);
  }
  if (document.status === "ready") assert.ok(document.bars.length >= index.minimumReadyRows, `${entry.instrument.id} is ready with too few rows`);
  if (document.status === "unavailable") assert.equal(document.bars.length, 0, `${entry.instrument.id} unavailable must not retain unmarked bars`);
}

console.log(`market-history contract valid: ${index.instruments.length} instruments`);
