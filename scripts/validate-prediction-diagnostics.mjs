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
  "rawProbabilityAvailable", "calibratedProbabilityAvailable", "modelInputCompleteness", "productionFeatureCoverage", "coverageContractVersion", "modelFeatureCoverage", "productionSignalCoverage", "trainingReadyCoverage", "providerHealthCoverage", "oosMetrics",
  "gateThresholds", "gateActuals", "gateFailures", "sourceFailures", "warnings", "rawScoreDistribution", "rawProbabilityDistribution",
];

if (data.schemaVersion !== 2) fail("schemaVersion 必须为 2");
for (const key of ["featureCoverage", "marketBreadthSummary", "sourceStatus", "warnings", "modelLineage"]) if (!(key in data)) fail(`顶层${key}缺失`);
if (data.featureCoverage?.coverageContractVersion !== "prediction-feature-coverage-v2") fail("顶层featureCoverage必须为覆盖契约v2");
if (!data.marketBreadthSummary || !["ready", "partial", "stale", "unavailable"].includes(data.marketBreadthSummary.status)) fail("顶层marketBreadthSummary非法");
if (!data.sourceStatus || !data.sourceStatus.marketBreadth || !Array.isArray(data.warnings)) fail("顶层生产信号状态字段非法");
if (data.modelLineage?.ok !== true) fail("顶层modelLineage必须为已验证sidecar");
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
  for (const key of ["modelInputCompleteness", "productionFeatureCoverage", "modelFeatureCoverage", "productionSignalCoverage", "trainingReadyCoverage", "providerHealthCoverage"]) {
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
  if (entry.modelAvailability === "trained") {
    if (entry.coverageContractVersion !== "prediction-feature-coverage-v2") fail(`${label}.coverageContractVersion非法`);
    if (entry.productionFeatureCoverage !== entry.modelFeatureCoverage || entry.modelFeatureCoverage !== 0.5) fail(`${label} 兼容覆盖别名或冻结模型覆盖非法`);
    if (entry.trainingReadyCoverage !== 0.5 || entry.productionSignalCoverage > 0.7) fail(`${label} P1-D覆盖边界非法`);
  }
  if (entry.publicationStatus === "abstained") {
    if (entry.modelAvailability !== "trained" || !entry.modelVersion || !entry.gateFailures.length) fail(`${label} abstained 必须有训练模型、版本和 gateFailures`);
    if (entry.outputMode !== "evidence_observation") fail(`${label} abstained 不得在页面输出概率`);
  }
}
console.log(`prediction diagnostics validated: ${data.entries.length} market-horizon entries`);
