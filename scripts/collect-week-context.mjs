import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(gunzipCallback);
const root = process.cwd();
const archiveRoot = path.join(root, "data", "archive");
const outputPath = path.join(root, "data", "weekly-context.json");

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function shanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function mondayFor(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function compactBrief(brief, provenance) {
  const articles = [
    ...(brief.federalReserve?.articles ?? []).map((article) => ({ ...article, section: "fed" })),
    ...(brief.markets ?? []).flatMap((market) => (market.articles ?? []).map((article) => ({ ...article, section: market.id }))),
    ...(brief.hotspots ?? []).map((article) => ({ ...article, section: "hotspot" })),
  ].map((article) => ({
    id: article.id,
    section: article.section,
    title: article.title,
    summary: article.summary,
    impact: article.impact,
    publishedAt: article.publishedAt,
    tags: article.tags,
    sources: (article.sources ?? []).map(({ name, publisher, url, tier }) => ({ name, publisher, url, tier })),
    rotationAnalysis: article.detail?.rotationAnalysis ?? undefined,
  }));

  return {
    editionDate: brief.meta?.editionDate,
    generatedAt: brief.meta?.generatedAt,
    dataThrough: brief.meta?.dataThrough,
    pulse: brief.pulse,
    markets: (brief.markets ?? []).map((market) => ({ id: market.id, sessionDate: market.sessionDate, status: market.status, summary: market.summary, indices: market.indices })),
    articles,
    watchlist: brief.watchlist ?? [],
    provenance,
  };
}

const weekEnd = argValue("--week-end") ?? shanghaiDate();
if (!/^\d{4}-\d{2}-\d{2}$/.test(weekEnd)) throw new Error("--week-end 必须是 YYYY-MM-DD");
const weekStart = mondayFor(weekEnd);
const candidates = new Map();

try {
  const index = JSON.parse(await readFile(path.join(archiveRoot, "index.json"), "utf8"));
  for (const entry of index.snapshots ?? []) {
    if (entry.editionDate < weekStart || entry.editionDate > weekEnd) continue;
    const previous = candidates.get(entry.editionDate);
    if (!previous || new Date(entry.archivedAt) > new Date(previous.archivedAt)) candidates.set(entry.editionDate, entry);
  }
} catch {
  // A new installation may not have daily archives yet.
}

const editions = [];
for (const entry of [...candidates.values()].sort((a, b) => a.editionDate.localeCompare(b.editionDate))) {
  try {
    const compressed = await readFile(path.join(archiveRoot, entry.file));
    const snapshot = JSON.parse((await gunzip(compressed)).toString("utf8"));
    editions.push(compactBrief(snapshot.brief, { kind: "daily-archive", file: entry.file, contentSha256: entry.contentSha256 }));
  } catch {
    // A missing or damaged archive is recorded as a coverage gap below.
  }
}

const current = JSON.parse(await readFile(path.join(root, "content", "daily-brief.json"), "utf8"));
if (current.meta?.editionDate >= weekStart && current.meta?.editionDate <= weekEnd) {
  const compact = compactBrief(current, { kind: "current-daily", file: "content/daily-brief.json" });
  const existing = editions.findIndex((item) => item.editionDate === compact.editionDate);
  if (existing >= 0) editions[existing] = compact;
  else editions.push(compact);
}
editions.sort((a, b) => a.editionDate.localeCompare(b.editionDate));

let previousWeekly = null;
try {
  const weeklyIndex = JSON.parse(await readFile(path.join(root, "content", "weekly-reports", "index.json"), "utf8"));
  if (weeklyIndex.latestReportId) {
    const latest = JSON.parse(await readFile(path.join(root, "content", "weekly-reports", `${weeklyIndex.latestReportId}.json`), "utf8"));
    previousWeekly = {
      id: latest.report?.id,
      weekVerdict: latest.executiveSummary?.weekVerdict,
      keyTakeaways: latest.executiveSummary?.keyTakeaways,
      crossMarketThemes: latest.crossMarketThemes,
      localSynthesis: latest.localSynthesis,
    };
  }
} catch {
  // The first weekly run has no previous report.
}

const context = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  weekStart,
  weekEnd,
  editionCount: editions.length,
  archiveSnapshotsRead: editions.filter((item) => item.provenance.kind === "daily-archive").length,
  coverageGaps: editions.length < 3 ? ["本周本地日报沉淀不足3个独立日期，需以全网原始来源补齐并明确披露。"] : [],
  editions,
  previousWeekly,
};

await writeFile(outputPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
console.log(`周报本地上下文已生成：${path.relative(root, outputPath)}，${editions.length} 个日报日期，${context.archiveSnapshotsRead} 份归档。`);
