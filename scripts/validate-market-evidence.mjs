import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "data", "market-evidence", "latest.json");

if (!fs.existsSync(target)) {
  console.log("市场证据包尚未在本机生成；跳过本地快照校验。自动化会先运行 market:data:daily。");
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(target, "utf8"));
const errors = [];
const fail = (message) => errors.push(message);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isoDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

if (data.schemaVersion !== 1) fail("schemaVersion 必须为 1");
if (!isObject(data.sourceCatalog)) fail("sourceCatalog 必须存在");
if (!isObject(data.markets?.["a-share"])) fail("markets.a-share 必须存在");
if (!isObject(data.markets?.hk)) fail("markets.hk 必须存在");
if (!isObject(data.writerPacket)) fail("writerPacket 必须存在");

const aShare = data.markets?.["a-share"];
if (aShare) {
  if (!isoDate(aShare.asOf)) fail("A 股 asOf 必须是 ISO 日期");
  if (!Array.isArray(aShare.sectors) || aShare.sectors.length !== 12) {
    fail("A 股固定观察池必须正好 12 项");
  } else {
    const codes = new Set();
    const requiredMetrics = [
      "turnoverAmountRatio20d",
      "tradingVolumeRatio20d",
      "turnoverShareRatio20d",
      "breadthPct",
      "relativeReturn5d",
      "top3ConcentrationPct",
    ];
    for (const [index, sector] of aShare.sectors.entries()) {
      const label = `markets.a-share.sectors[${index}]`;
      if (!/^\d{6}$/.test(sector.code ?? "")) fail(`${label}.code 非法`);
      if (codes.has(sector.code)) fail(`${label}.code 重复`);
      codes.add(sector.code);
      if (sector.asOf !== aShare.asOf) fail(`${label}.asOf 未与市场日期一致`);
      if (!Number.isInteger(sector.historySessions) || sector.historySessions < 0) {
        fail(`${label}.historySessions 非法`);
      }
      for (const metricName of requiredMetrics) {
        const metric = sector.metrics?.[metricName];
        if (!isObject(metric)) {
          fail(`${label}.metrics.${metricName} 缺失`);
          continue;
        }
        if (!["verified", "insufficient"].includes(metric.status)) {
          fail(`${label}.metrics.${metricName}.status 非法`);
        }
        if (metric.status === "verified" && !Number.isFinite(metric.value)) {
          fail(`${label}.metrics.${metricName} verified 时必须有有限数值`);
        }
        if (metric.status === "insufficient" && metric.value !== null) {
          fail(`${label}.metrics.${metricName} insufficient 时 value 必须为 null`);
        }
        if (!Array.isArray(metric.sourceKeys) || metric.sourceKeys.length === 0) {
          fail(`${label}.metrics.${metricName}.sourceKeys 不能为空`);
        }
        for (const key of metric.sourceKeys ?? []) {
          if (!data.sourceCatalog[key]) fail(`${label} 引用了未知 sourceKey ${key}`);
        }
      }
      const publication = sector.publication;
      if (!["verified", "none", "insufficient"].includes(publication?.volumeStatus)) {
        fail(`${label}.publication.volumeStatus 非法`);
      }
      const allReady = requiredMetrics.every(
        (metricName) => sector.metrics?.[metricName]?.status === "verified",
      );
      if (publication?.strictPublicationEligible !== allReady) {
        fail(`${label}.publication.strictPublicationEligible 与字段状态不一致`);
      }
      if (publication?.volumeStatus === "verified") {
        if (sector.historySessions < 25) fail(`${label} verified 但不足 25 个交易日`);
        if (sector.metrics.turnoverAmountRatio20d.value < 1.35) fail(`${label} 成交额比未过门槛`);
        if (sector.metrics.tradingVolumeRatio20d.value < 1.2) fail(`${label} 成交量比未过门槛`);
        if (sector.metrics.turnoverShareRatio20d.value < 1.15) fail(`${label} 成交份额比未过门槛`);
      }
    }
  }
  const summary = aShare.publicationSummary;
  if (!["verified", "none", "insufficient"].includes(summary?.volumeStatus)) {
    fail("A 股 publicationSummary.volumeStatus 非法");
  }
  if (!Array.isArray(summary?.volumeLeaders) || summary.volumeLeaders.length > 4) {
    fail("A 股 publicationSummary.volumeLeaders 必须为最多 4 项数组");
  }
}

if (errors.length) {
  console.error(`市场证据包校验失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `市场证据包校验通过：A 股 ${aShare.sectors.length}/12，严格可发布 ${aShare.publicationSummary.eligibleSectors}/12，港股 ${data.markets.hk.coverage}。`,
);
