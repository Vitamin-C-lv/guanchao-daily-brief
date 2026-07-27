import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(root, "content", "market-observer.json");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function asOfDate(dataPeriod) {
  const day = String(dataPeriod).match(/(20\d{2}-\d{2}-\d{2})/);
  if (day) return day[1];
  const month = String(dataPeriod).match(/(20\d{2})年(\d{1,2})月/);
  if (month) return new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).toISOString().slice(0, 10);
  return null;
}

function facts(data) {
  return [
    ...(data.globalOverview?.facts ?? []),
    ...(data.policyFundRadar?.facts ?? []),
    ...(data.priorityWatch ?? []).flatMap((card) => card.facts ?? []),
    ...(data.macroChain?.nodes ?? []).map((node) => node.fact).filter(Boolean),
  ];
}

function appendNote(fact, note) {
  fact.note = fact.note ? `${fact.note} ${note}` : note;
}

function main() {
  const data = read();
  const sources = new Map((data.sources ?? []).map((source) => [source.id, source]));
  data.meta.allowedUpdatedAtDelayHours = 48;
  let corrected = 0;
  for (const fact of facts(data)) {
    const asOf = asOfDate(fact.dataPeriod);
    if (!asOf) throw new Error(`无法从 dataPeriod 提取 asOfDate: ${fact.label}`);
    fact.asOfDate = asOf;
    if (String(fact.releasedAt).slice(0, 10) >= asOf) continue;
    const source = sources.get(fact.sourceId);
    if (String(source?.publishedAt ?? "").slice(0, 10) >= asOf) {
      fact.releasedAt = source.publishedAt;
    } else if (String(fact.updatedAt).slice(0, 10) >= asOf) {
      fact.releasedAt = fact.updatedAt;
      fact.status = fact.status === "official" ? "delayed" : fact.status;
      appendNote(fact, "上游精确发布时间未留存；releasedAt 按实际抓取时间列示。");
    } else {
      throw new Error(`${fact.label} 缺少不早于 asOfDate 的可核验发布时间或抓取时间`);
    }
    corrected += 1;
  }
  write(data);
  console.log(`market observer timestamps normalized: ${corrected} corrected facts`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
