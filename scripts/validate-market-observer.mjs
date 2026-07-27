import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const fileArgument = process.argv.indexOf("--file");
const file = fileArgument >= 0 && process.argv[fileArgument + 1]
  ? path.resolve(root, process.argv[fileArgument + 1])
  : path.join(root, "content", "market-observer.json");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const errors = [];
const requiredFactFields = [
  "label", "currentValue", "previousValue", "expectedValue", "surprise", "dataPeriod", "asOfDate",
  "sourceId", "releasedAt", "updatedAt", "status",
];
const validStatuses = new Set(["official", "revised", "estimated", "delayed"]);
const weakConclusionTerms = /可能|或许|不排除|尚难判断|似乎|大概|仍需谨慎|仅供参考/;

function check(condition, message) {
  if (!condition) errors.push(message);
}

function validDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function validIso(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function checkCard(card, label, sourceIds) {
  check(card && typeof card === "object", `${label} must be an object`);
  if (!card) return;
  check(typeof card.conclusion === "string" && card.conclusion.trim().length >= 8, `${label}.conclusion is too short`);
  check(!weakConclusionTerms.test(card.conclusion || ""), `${label}.conclusion contains hedging language`);
  check(Array.isArray(card.facts) && card.facts.length > 0, `${label} must contain at least one fact`);
  for (const [index, fact] of (card.facts || []).entries()) {
    for (const field of requiredFactFields) {
      check(typeof fact[field] === "string" && fact[field].trim().length > 0, `${label}.facts[${index}].${field} is required`);
    }
    check(validStatuses.has(fact.status), `${label}.facts[${index}].status is invalid`);
    check(sourceIds.has(fact.sourceId), `${label}.facts[${index}] references unknown source ${fact.sourceId}`);
    check(validDate(fact.asOfDate), `${label}.facts[${index}].asOfDate is invalid`);
    check(validIso(fact.releasedAt), `${label}.facts[${index}].releasedAt is invalid`);
    check(validIso(fact.updatedAt), `${label}.facts[${index}].updatedAt is invalid`);
    if (validDate(fact.asOfDate) && validIso(fact.releasedAt)) {
      check(fact.releasedAt.slice(0, 10) >= fact.asOfDate, `${label}.facts[${index}].releasedAt must not precede asOfDate`);
    }
    if (validIso(fact.releasedAt) && validIso(fact.updatedAt)) {
      check(Date.parse(fact.releasedAt) <= Date.parse(fact.updatedAt), `${label}.facts[${index}].updatedAt must not precede releasedAt`);
    }
  }
  check(Array.isArray(card.explanation) && card.explanation.length > 0, `${label}.explanation is required`);
  check(Array.isArray(card.counterEvidence) && card.counterEvidence.length > 0, `${label}.counterEvidence is required`);
  check(Array.isArray(card.watchItems) && card.watchItems.length > 0, `${label}.watchItems is required`);
}

check(data.schemaVersion === 1, "schemaVersion must be 1");
check(Number.isFinite(data.meta?.allowedUpdatedAtDelayHours) && data.meta.allowedUpdatedAtDelayHours >= 0 && data.meta.allowedUpdatedAtDelayHours <= 72, "allowedUpdatedAtDelayHours must be explicit and between 0 and 72");
const snapshotCreatedAtMs = Date.parse(data.meta?.snapshotCreatedAt ?? "");
const allowedUpdatedAtDelayMs = Number(data.meta?.allowedUpdatedAtDelayHours ?? 0) * 3_600_000;
check(data.meta?.coverage === "global-with-priority-watch", "coverage must remain global-with-priority-watch");
check(data.homeObservation?.href === "/briefs/#daily-macro", "home observation must link to /briefs/#daily-macro");
const sourceIds = new Set((data.sources || []).map((source) => source.id));
check(sourceIds.size === (data.sources || []).length, "source ids must be unique");
checkCard(data.globalOverview, "globalOverview", sourceIds);
checkCard(data.policyFundRadar, "policyFundRadar", sourceIds);
check(Array.isArray(data.priorityWatch) && data.priorityWatch.length >= 6, "priorityWatch must contain the six configured focus groups");
for (const [index, card] of (data.priorityWatch || []).entries()) checkCard(card, `priorityWatch[${index}]`, sourceIds);

const nodeIds = new Set((data.macroChain?.nodes || []).map((node) => node.id));
check(nodeIds.size === 7, "macroChain must contain exactly seven nodes in the first version");
for (const [index, node] of (data.macroChain?.nodes || []).entries()) {
  checkCard({ conclusion: `${node.label}数据状态已记录`, facts: [node.fact], explanation: [node.role], counterEvidence: ["由关系状态表达"], watchItems: [{ indicator: node.label }] }, `macroChain.nodes[${index}]`, sourceIds);
}
for (const [index, edge] of (data.macroChain?.relationships || []).entries()) {
  check(nodeIds.has(edge.from) && nodeIds.has(edge.to), `macroChain.relationships[${index}] references unknown node`);
  check(["confirmed", "partial", "unconfirmed", "reverse"].includes(edge.status), `macroChain.relationships[${index}].status is invalid`);
}
for (const [index, item] of (data.headlineCalibrations || []).entries()) {
  check(Array.isArray(item.detectedTerms) && item.detectedTerms.length > 0, `headlineCalibrations[${index}] must contain detected terms`);
  for (const sourceId of item.sourceIds || []) check(sourceIds.has(sourceId), `headlineCalibrations[${index}] references unknown source ${sourceId}`);
}
for (const [index, card] of [data.globalOverview, data.policyFundRadar, ...(data.priorityWatch ?? [])].entries()) {
  for (const [factIndex, fact] of (card?.facts ?? []).entries()) {
    if (validIso(fact.updatedAt) && !Number.isNaN(snapshotCreatedAtMs)) {
      check(Date.parse(fact.updatedAt) <= snapshotCreatedAtMs + allowedUpdatedAtDelayMs, `facts[${index}:${factIndex}].updatedAt exceeds snapshotCreatedAt allowance`);
    }
  }
}
for (const [index, node] of (data.macroChain?.nodes ?? []).entries()) {
  const fact = node.fact;
  if (validIso(fact?.updatedAt) && !Number.isNaN(snapshotCreatedAtMs)) {
    check(Date.parse(fact.updatedAt) <= snapshotCreatedAtMs + allowedUpdatedAtDelayMs, `macroChain.nodes[${index}].fact.updatedAt exceeds snapshotCreatedAt allowance`);
  }
}
check(typeof data.disclaimer === "string" && data.disclaimer.length > 0, "one page-level disclaimer is required");

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}
console.log(`market observer validated: ${data.priorityWatch.length} focus cards, ${data.macroChain.nodes.length} macro nodes, ${data.sources.length} sources`);
