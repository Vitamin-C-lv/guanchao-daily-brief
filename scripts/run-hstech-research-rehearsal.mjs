import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadHstechCache } from "./hstech-recovery.mjs";

const moduleFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(moduleFile), "..");

export function buildHstechResearchReport({ cachePath = "D:\\Guanchao-Workspace\\runtime\\market-history-cache\\hstech\\sina-normalized.json" } = {}) {
  const cache = loadHstechCache(cachePath, { asOf: "2026-08-06" });
  const closes = cache.bars.map((bar) => bar.close);
  const horizons = Object.fromEntries([1, 5, 20].map((horizon) => {
    const returns = [];
    for (let index = horizon; index < closes.length; index += 1) returns.push((closes[index] / closes[index - horizon] - 1) * 100);
    const mean = returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : null;
    return [String(horizon), { status: returns.length ? "observation_ready" : "insufficient_data", sampleCount: returns.length, meanReturnPercent: mean === null ? null : Number(mean.toFixed(6)), probability: null, outputMode: "evidence_observation", qualityGatePassed: false }];
  }));
  return {
    schemaVersion: "hstech-research-rehearsal-v1",
    market: "HK",
    instrument: "HSTECH",
    candidateStatus: "shadow",
    dataAsOf: cache.lastDate,
    source: "akshare.stock_hk_index_daily_sina",
    horizons,
    protocol: { launchDate: "2020-07-27", noETFProxy: true, noInterpolation: true, noConstituentReconstruction: true, preserveNull: true, horizons: [1, 5, 20] },
    productionApply: { applied: false, candidateActivation: false, contentWritten: false, predictionLedgerWritten: false, newHKProbabilityPublished: false },
    note: "只重跑冻结 HSTECH 1/5/20 观察统计；未训练、未 promotion、未把研究结果转为 production probability。",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const report = buildHstechResearchReport({ cachePath: process.argv[2] });
    const output = process.argv[3];
    if (output) { fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8"); }
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(`HSTECH_RESEARCH_FAILURE ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
