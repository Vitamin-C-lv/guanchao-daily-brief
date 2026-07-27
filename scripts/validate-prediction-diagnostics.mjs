import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fileArgument = process.argv.indexOf("--file");
const file = fileArgument >= 0 && process.argv[fileArgument + 1]
  ? path.resolve(root, process.argv[fileArgument + 1])
  : path.join(root, "content", "prediction-diagnostics.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => { throw new Error(`[prediction-diagnostics] ${message}`); };
const finiteOrNull = (value) => value === null || (typeof value === "number" && Number.isFinite(value));
const required = [
  "market", "horizon", "modelAvailability", "modelVersion", "featureVersion", "dataAsOf", "snapshotCreatedAt",
  "probabilityTarget", "probabilitySource", "calibrationStatus", "publicationStatus", "outputMode", "rawScoreAvailable",
  "rawProbabilityAvailable", "calibratedProbabilityAvailable", "modelInputCompleteness", "productionFeatureCoverage", "oosMetrics",
  "gateThresholds", "gateActuals", "gateFailures", "sourceFailures", "warnings", "rawScoreDistribution", "rawProbabilityDistribution",
];

if (data.schemaVersion !== 1) fail("schemaVersion 必须为 1");
if (!Array.isArray(data.entries) || data.entries.length !== 12) fail("必须为三个市场的 current/1/5/20 共12个诊断条目");
const identities = new Set();
for (const [index, entry] of data.entries.entries()) {
  const label = `entries[${index}]`;
  for (const key of required) if (!(key in entry)) fail(`${label}.${key} 缺失`);
  if (!["a-share", "hk", "us"].includes(entry.market)) fail(`${label}.market 非法`);
  if (!(entry.horizon === "current" || [1, 5, 20].includes(entry.horizon))) fail(`${label}.horizon 非法`);
  const identity = `${entry.market}|${entry.horizon}`;
  if (identities.has(identity)) fail(`${label} 重复 market/horizon`);
  identities.add(identity);
  for (const key of ["modelInputCompleteness", "productionFeatureCoverage"]) {
    if (!finiteOrNull(entry[key]) || (entry[key] !== null && (entry[key] < 0 || entry[key] > 1))) fail(`${label}.${key} 必须为0-1或null`);
  }
  for (const key of ["rawScoreAvailable", "rawProbabilityAvailable", "calibratedProbabilityAvailable"]) {
    if (typeof entry[key] !== "boolean") fail(`${label}.${key} 必须为布尔值`);
  }
  if (!Array.isArray(entry.gateFailures) || !Array.isArray(entry.sourceFailures) || !Array.isArray(entry.warnings)) fail(`${label} 数组诊断字段非法`);
  if (entry.modelAvailability !== "trained") {
    if (entry.modelVersion !== null || entry.rawScoreAvailable || entry.rawProbabilityAvailable || entry.calibratedProbabilityAvailable || entry.oosMetrics !== null) {
      fail(`${label} 无模型状态不得填充模型概率、版本或OOS指标`);
    }
    if (entry.probabilitySource !== "none" || entry.probabilityTarget !== "none" || entry.calibrationStatus !== "not_applicable") fail(`${label} 无模型状态必须关闭概率血缘`);
  }
  if (entry.publicationStatus === "abstained") {
    if (entry.modelAvailability !== "trained" || !entry.modelVersion || !entry.gateFailures.length) fail(`${label} abstained 必须有训练模型、版本和 gateFailures`);
    if (entry.outputMode !== "evidence_observation") fail(`${label} abstained 不得在页面输出概率`);
  }
}
console.log(`prediction diagnostics validated: ${data.entries.length} market-horizon entries`);
