import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const candidatePath = (flag) => { const index = process.argv.indexOf(flag); return index >= 0 ? path.resolve(process.argv[index + 1] ?? "") : null; };
const candidateReportPath = candidatePath("--candidate-report");
const candidateIndexPath = candidatePath("--candidate-index");
const candidateNoticesPath = candidatePath("--candidate-notices");
const candidateMode = [candidateReportPath, candidateIndexPath, candidateNoticesPath].some(Boolean);
const weeklyRoot = path.join(root, "content", "weekly-reports");
const errors = [];
const idPattern = /^weekly-\d{4}-W\d{2}$/;
const sourceEvidenceClasses = [
  "official-primary",
  "company-filing",
  "primary-research",
  "exchange-market-data",
  "vendor-market-data",
  "vendor-estimate",
  "major-media",
];

function fail(message) { errors.push(message); }
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireString(value, label, max = Infinity) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} 必须是非空字符串`);
  else if (value.length > max) fail(`${label} 超过 ${max} 字符`);
}
function requireDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) fail(`${label} 必须是 YYYY-MM-DD 日期`);
}
function requireIso(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) fail(`${label} 必须是有效 ISO 时间`);
}
function requireArray(value, label, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) { fail(`${label} 必须包含 ${min}–${max} 项`); return false; }
  return true;
}

if (candidateMode && ![candidateReportPath, candidateIndexPath, candidateNoticesPath].every(Boolean)) fail("candidate mode requires --candidate-report, --candidate-index and --candidate-notices");
let candidate = null;
let candidateSize = 0;
if (candidateMode && [candidateReportPath, candidateIndexPath, candidateNoticesPath].every(Boolean)) {
  try {
    const [raw, info] = await Promise.all([readFile(candidateReportPath, "utf8"), stat(candidateReportPath)]);
    candidate = JSON.parse(raw);
    candidateSize = info.size;
  } catch (error) { fail(`candidate weekly report 无法读取或解析：${error.message}`); }
}

const dailyBrief = JSON.parse(await readFile(path.join(root, "content", "daily-brief.json"), "utf8"));
const dailyArticles = [
  ...(dailyBrief.federalReserve?.articles ?? []),
  ...(dailyBrief.markets ?? []).flatMap((market) => market.articles ?? []),
  ...(dailyBrief.hotspots ?? []),
];

function validateNotice(item, kind, label, latestReportId) {
  if (!isObject(item)) { fail(`${label} 必须是对象或 null`); return; }
  if (item.kind !== kind) fail(`${label}.kind 必须是 ${kind}`);
  requireString(item.noticeId, `${label}.noticeId`, 90);
  if (!Number.isFinite(item.importance) || item.importance < 90 || item.importance > 100) fail(`${label}.importance 必须在 90–100`);
  requireIso(item.publishedAt, `${label}.publishedAt`);
  if (item.expiresAt !== null) requireIso(item.expiresAt, `${label}.expiresAt`);
  requireString(item.title, `${label}.title`, 42);
  requireString(item.summary, `${label}.summary`, 180);
  requireString(item.selectionReason, `${label}.selectionReason`, 140);
  if (requireArray(item.highlights, `${label}.highlights`, kind === "weekly" ? 2 : 1, 4)) item.highlights.forEach((text, index) => requireString(text, `${label}.highlights[${index}]`, 64));
  requireString(item.href, `${label}.href`, 140);
  requireString(item.ctaLabel, `${label}.ctaLabel`, 14);

  if (kind === "weekly") {
    if (item.expiresAt !== null) fail(`${label}.expiresAt 周报提醒必须为 null`);
    if (latestReportId && item.href !== `/weekly/${latestReportId}/`) fail(`${label}.href 必须指向最新周报`);
    if (!/^weekly-/.test(item.noticeId)) fail(`${label}.noticeId 必须以 weekly- 开头`);
  } else {
    if (item.expiresAt === null) fail(`${label}.expiresAt 日报提醒必须设置过期时间`);
    if (!/^daily-\d{4}-\d{2}-\d{2}-/.test(item.noticeId)) fail(`${label}.noticeId 格式非法`);
    if (item.expiresAt !== null) {
      const noticeDate = item.noticeId.slice(6, 16);
      const publishedAt = Date.parse(item.publishedAt);
      const expiresAt = Date.parse(item.expiresAt);
      const nextDate = new Date(`${noticeDate}T00:00:00Z`);
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      const nextRunDeadline = Date.parse(`${nextDate.toISOString().slice(0, 10)}T08:10:00+08:00`);
      if (item.publishedAt.slice(0, 10) !== noticeDate) fail(`${label}.noticeId 日期必须与 publishedAt 一致`);
      if (Number.isFinite(publishedAt) && Number.isFinite(expiresAt) && expiresAt <= publishedAt) fail(`${label}.expiresAt 必须晚于 publishedAt`);
      if (Number.isFinite(expiresAt) && Number.isFinite(nextRunDeadline) && expiresAt > nextRunDeadline) fail(`${label}.expiresAt 不得晚于次日日报运行时间`);
    }
    const match = /^\/articles\/([^/]+)\/$/.exec(item.href);
    if (!match) fail(`${label}.href 必须指向一篇精读文章`);
    else {
      const article = dailyArticles.find((candidate) => candidate.id === match[1]);
      if (!article) fail(`${label}.href 指向的文章不在当前日报中`);
      else if (new Set((article.sources ?? []).map((source) => source.publisher)).size < 2) fail(`${label} 对应重大新闻文章至少需要 2 个独立发布方`);
    }
  }
}

const index = JSON.parse(await readFile(candidateMode ? candidateIndexPath : path.join(weeklyRoot, "index.json"), "utf8"));
if (index.schemaVersion !== 1) fail("weekly index.schemaVersion 必须为 1");
if (!Array.isArray(index.reports)) fail("weekly index.reports 必须是数组");
const indexIds = new Set();
for (const [position, entry] of (index.reports ?? []).entries()) {
  const label = `weekly index.reports[${position}]`;
  if (!isObject(entry)) { fail(`${label} 必须是对象`); continue; }
  if (!idPattern.test(entry.id ?? "")) fail(`${label}.id 格式非法`);
  if (indexIds.has(entry.id)) fail(`${label}.id 重复`);
  indexIds.add(entry.id);
  requireDate(entry.weekStart, `${label}.weekStart`);
  requireDate(entry.weekEnd, `${label}.weekEnd`);
  requireIso(entry.publishedAt, `${label}.publishedAt`);
  requireString(entry.title, `${label}.title`, 60);
  requireString(entry.summary, `${label}.summary`, 220);
  if (!Number.isInteger(entry.revision) || entry.revision < 1) fail(`${label}.revision 必须是正整数`);
}
if (index.latestReportId !== null && !indexIds.has(index.latestReportId)) fail("weekly index.latestReportId 不在 reports 中");

const notices = JSON.parse(await readFile(candidateMode ? candidateNoticesPath : path.join(root, "public", "update-notices.json"), "utf8"));
if (notices.schemaVersion !== 1) fail("update-notices.schemaVersion 必须为 1");
if (notices.daily !== null) validateNotice(notices.daily, "daily", "update-notices.daily", index.latestReportId);
if (notices.weekly !== null) validateNotice(notices.weekly, "weekly", "update-notices.weekly", index.latestReportId);
if (index.reports?.length && notices.weekly === null) fail("已有周报时 update-notices.weekly 不能为 null");
if (candidateMode && index.latestReportId) {
  const latest = index.reports.find((entry) => entry.id === index.latestReportId);
  if (!latest) fail("candidate index latest report is absent");
  else if (notices.weekly?.href !== `/weekly/${latest.id}/` || notices.weekly?.noticeId !== `${latest.id}-r${latest.revision}` || notices.weekly?.publishedAt !== latest.publishedAt) fail("candidate weekly notice does not match latest report");
}

function validateReport(data, entry, fileSize) {
  const label = entry.id;
  if (fileSize > 150 * 1024) fail(`${label} JSON 超过 150KB`);
  if (data.schemaVersion !== 1) fail(`${label}.schemaVersion 必须为 1`);
  const report = data.report;
  if (!isObject(report)) { fail(`${label}.report 缺失`); return; }
  if (report.id !== entry.id) fail(`${label}.report.id 与索引不一致`);
  if (report.revision !== entry.revision) fail(`${label}.report.revision 与索引不一致`);
  requireDate(report.weekStart, `${label}.report.weekStart`);
  requireDate(report.weekEnd, `${label}.report.weekEnd`);
  if (report.weekStart !== entry.weekStart || report.weekEnd !== entry.weekEnd) fail(`${label} 周区间与索引不一致`);
  requireIso(report.generatedAt, `${label}.report.generatedAt`);
  if (report.timezone !== "Asia/Shanghai") fail(`${label}.report.timezone 必须是 Asia/Shanghai`);
  if (report.model !== "gpt-5.6-terra") fail(`${label}.report.model 必须是 gpt-5.6-terra`);
  if (report.status !== "complete") fail(`${label}.report.status 必须是 complete`);
  requireString(report.title, `${label}.report.title`, 60);
  requireString(report.subtitle, `${label}.report.subtitle`, 80);

  const coverageScopes = new Set();
  if (requireArray(report.coverage, `${label}.report.coverage`, 4, 4)) report.coverage.forEach((item, position) => {
    const itemLabel = `${label}.report.coverage[${position}]`;
    if (!["fed", "a-share", "hk", "us"].includes(item.scope)) fail(`${itemLabel}.scope 非法`);
    if (coverageScopes.has(item.scope)) fail(`${itemLabel}.scope 重复`);
    coverageScopes.add(item.scope);
    requireDate(item.dataThrough, `${itemLabel}.dataThrough`);
    if (!["complete", "partial-by-schedule", "insufficient"].includes(item.status)) fail(`${itemLabel}.status 非法`);
    requireString(item.note, `${itemLabel}.note`, 140);
    if (item.scope === "us" && item.dataThrough >= report.weekEnd && item.status !== "insufficient") fail(`${itemLabel} 周五20:00生成时不得声称包含美股周五完整收盘`);
  });

  const sourceMap = new Map();
  if (requireArray(data.sources, `${label}.sources`, 8, 40)) data.sources.forEach((source, position) => {
    const sourceLabel = `${label}.sources[${position}]`;
    requireString(source.id, `${sourceLabel}.id`, 50);
    if (sourceMap.has(source.id)) fail(`${sourceLabel}.id 重复`);
    sourceMap.set(source.id, source);
    requireString(source.name, `${sourceLabel}.name`, 100);
    requireString(source.publisher, `${sourceLabel}.publisher`, 80);
    requireString(source.url, `${sourceLabel}.url`, 500);
    try { const url = new URL(source.url); if (url.protocol !== "https:") fail(`${sourceLabel}.url 必须使用 HTTPS`); } catch { fail(`${sourceLabel}.url 非法`); }
    if (!["official", "authoritative", "major-media"].includes(source.tier)) fail(`${sourceLabel}.tier 非法`);
    if (source.evidenceClass !== undefined && !sourceEvidenceClasses.includes(source.evidenceClass)) fail(`${sourceLabel}.evidenceClass 非法`);
    requireIso(source.publishedAt, `${sourceLabel}.publishedAt`);
    requireIso(source.accessedAt, `${sourceLabel}.accessedAt`);
  });
  const usedSources = new Set();
  const refs = (ids, refLabel, min = 1) => {
    if (!Array.isArray(ids) || ids.length < min) { fail(`${refLabel} 至少需要 ${min} 个引用`); return; }
    for (const id of ids) { if (!sourceMap.has(id)) fail(`${refLabel} 含未知来源 ${id}`); else usedSources.add(id); }
  };
  const indexRefs = (indexes, refLabel, min = 1) => {
    if (!Array.isArray(indexes) || indexes.length < min) { fail(`${refLabel} 至少需要 ${min} 个引用`); return; }
    const seen = new Set();
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0 || index >= data.sources.length) fail(`${refLabel} 含越界索引 ${index}`);
      else {
        if (seen.has(index)) fail(`${refLabel} 含重复索引 ${index}`);
        seen.add(index);
        usedSources.add(data.sources[index].id);
      }
    }
  };
  const chartItems = (items, itemLabel, min, max, allowNegative) => {
    if (!requireArray(items, itemLabel, min, max)) return [];
    const labels = new Set();
    items.forEach((item, position) => {
      const pointLabel = `${itemLabel}[${position}]`;
      if (!isObject(item)) { fail(`${pointLabel} 必须是对象`); return; }
      requireString(item.label, `${pointLabel}.label`, 30);
      requireString(item.display, `${pointLabel}.display`, 20);
      if (labels.has(item.label)) fail(`${itemLabel} 含重复标签 ${item.label}`);
      labels.add(item.label);
      if (!Number.isFinite(item.value)) fail(`${pointLabel}.value 必须是有限数值`);
      else if (!allowNegative && item.value < 0) fail(`${pointLabel}.value 不能为负；有正负方向时使用 diverging-bar`);
      if (!["positive", "negative", "neutral", "warning"].includes(item.tone)) fail(`${pointLabel}.tone 非法`);
    });
    return items.map((item) => item?.label);
  };
  const validateChart = (chart, chartLabel) => {
    if (!isObject(chart)) { fail(`${chartLabel} 必须是对象`); return; }
    if (!["bar", "diverging-bar", "line", "grouped-bar"].includes(chart.type)) { fail(`${chartLabel}.type 非法`); return; }
    requireString(chart.title, `${chartLabel}.title`, 50);
    requireString(chart.unit, `${chartLabel}.unit`, 20);
    requireDate(chart.asOf, `${chartLabel}.asOf`);
    if (chart.note !== undefined) requireString(chart.note, `${chartLabel}.note`, 140);
    indexRefs(chart.sourceIndexes, `${chartLabel}.sourceIndexes`);
    if (chart.type === "bar" || chart.type === "diverging-bar") {
      if (chart.series !== undefined) fail(`${chartLabel}.series 不适用于 ${chart.type}`);
      const labels = chartItems(chart.items, `${chartLabel}.items`, 3, 6, chart.type === "diverging-bar");
      if (chart.type === "diverging-bar" && labels.length && chart.items.every((item) => item?.value === 0)) fail(`${chartLabel}.items 不能全部为零`);
      return;
    }
    if (chart.items !== undefined) fail(`${chartLabel}.items 不适用于 ${chart.type}`);
    const minSeries = chart.type === "line" ? 1 : 2;
    const maxSeries = chart.type === "line" ? 2 : 3;
    if (!requireArray(chart.series, `${chartLabel}.series`, minSeries, maxSeries)) return;
    const names = new Set();
    let referenceLabels;
    chart.series.forEach((series, position) => {
      const seriesLabel = `${chartLabel}.series[${position}]`;
      if (!isObject(series)) { fail(`${seriesLabel} 必须是对象`); return; }
      requireString(series.name, `${seriesLabel}.name`, 30);
      if (names.has(series.name)) fail(`${chartLabel}.series 含重复名称 ${series.name}`);
      names.add(series.name);
      if (!["positive", "negative", "neutral", "warning"].includes(series.tone)) fail(`${seriesLabel}.tone 非法`);
      if (!["observed", "institution-forecast"].includes(series.kind)) fail(`${seriesLabel}.kind 非法`);
      if (series.kind === "institution-forecast" && !chart.note?.trim()) fail(`${chartLabel}.note 必须说明机构预测口径`);
      const labels = chartItems(series.items, `${seriesLabel}.items`, chart.type === "line" ? 4 : 2, chart.type === "line" ? 12 : 5, chart.type === "line");
      if (referenceLabels === undefined) referenceLabels = labels;
      else if (labels.join("\u0000") !== referenceLabels.join("\u0000")) fail(`${seriesLabel}.items 标签及顺序必须一致`);
    });
  };

  if (data.charts !== undefined) {
    if (requireArray(data.charts, `${label}.charts`, 1, 4)) data.charts.forEach((chart, position) => validateChart(chart, `${label}.charts[${position}]`));
  }
  if (data.visual !== undefined) {
    const visual = data.visual;
    const visualLabel = `${label}.visual`;
    if (!isObject(visual)) fail(`${visualLabel} 必须是对象`);
    else {
      if (visual.kind !== "ai-editorial-illustration") fail(`${visualLabel}.kind 非法`);
      requireString(visual.src, `${visualLabel}.src`, 500);
      if (typeof visual.src === "string" && !visual.src.startsWith("/generated/editorial/")) fail(`${visualLabel}.src 必须位于 /generated/editorial/`);
      if (visual.width !== 1200 || visual.height !== 675) fail(`${visualLabel}.width/height 必须是 1200/675`);
      if (!Number.isInteger(visual.bytes) || visual.bytes < 1) fail(`${visualLabel}.bytes 必须是正整数`);
      if (typeof visual.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(visual.sha256)) fail(`${visualLabel}.sha256 非法`);
      if (visual.generator !== "openai-image") fail(`${visualLabel}.generator 必须是 openai-image`);
      requireIso(visual.generatedAt, `${visualLabel}.generatedAt`);
      if (visual.quality !== undefined && (!Number.isInteger(visual.quality) || visual.quality < 1 || visual.quality > 100)) fail(`${visualLabel}.quality 非法`);
      requireString(visual.alt, `${visualLabel}.alt`, 120);
      requireString(visual.caption, `${visualLabel}.caption`, 140);
      indexRefs(visual.basisSourceIndexes, `${visualLabel}.basisSourceIndexes`);
    }
  }

  const summary = data.executiveSummary;
  if (!isObject(summary)) fail(`${label}.executiveSummary 缺失`);
  else {
    if (!Number.isFinite(summary.editorialScore) || summary.editorialScore < 0 || summary.editorialScore > 100) fail(`${label}.editorialScore 必须在 0–100`);
    requireString(summary.weekVerdict, `${label}.weekVerdict`, 500);
    if (requireArray(summary.keyTakeaways, `${label}.keyTakeaways`, 3, 5)) summary.keyTakeaways.forEach((item, position) => {
      requireString(item.id, `${label}.keyTakeaways[${position}].id`, 50);
      requireString(item.title, `${label}.keyTakeaways[${position}].title`, 80);
      requireString(item.summary, `${label}.keyTakeaways[${position}].summary`, 260);
      if (!Number.isFinite(item.importance) || item.importance < 0 || item.importance > 100) fail(`${label}.keyTakeaways[${position}].importance 非法`);
      refs(item.sourceIds, `${label}.keyTakeaways[${position}].sourceIds`);
    });
  }

  if (requireArray(data.majorEvents, `${label}.majorEvents`, 5, 12)) data.majorEvents.forEach((item, position) => {
    const itemLabel = `${label}.majorEvents[${position}]`;
    requireString(item.id, `${itemLabel}.id`, 50); requireDate(item.date, `${itemLabel}.date`); requireString(item.title, `${itemLabel}.title`, 100); requireString(item.whyItMatters, `${itemLabel}.whyItMatters`, 500);
    if (!Number.isFinite(item.importance) || item.importance < 0 || item.importance > 100) fail(`${itemLabel}.importance 非法`);
    if (!requireArray(item.facts, `${itemLabel}.facts`, 1, 4)) return;
    item.facts.forEach((fact, factIndex) => { requireString(fact.text, `${itemLabel}.facts[${factIndex}].text`, 280); refs(fact.sourceIds, `${itemLabel}.facts[${factIndex}].sourceIds`); });
    refs(item.basisSourceIds, `${itemLabel}.basisSourceIds`, item.importance >= 90 ? 2 : 1);
  });

  if (requireArray(data.highValueInsights, `${label}.highValueInsights`, 3, 6)) data.highValueInsights.forEach((item, position) => {
    const itemLabel = `${label}.highValueInsights[${position}]`;
    requireString(item.id, `${itemLabel}.id`, 50); requireString(item.title, `${itemLabel}.title`, 100); requireString(item.insight, `${itemLabel}.insight`, 500); requireString(item.whyHighValue, `${itemLabel}.whyHighValue`, 300); requireString(item.watchNext, `${itemLabel}.watchNext`, 240);
    if (requireArray(item.evidence, `${itemLabel}.evidence`, 1, 4)) item.evidence.forEach((fact, factIndex) => { requireString(fact.text, `${itemLabel}.evidence[${factIndex}].text`, 260); refs(fact.sourceIds, `${itemLabel}.evidence[${factIndex}].sourceIds`); });
    if (!Array.isArray(item.counterEvidence)) fail(`${itemLabel}.counterEvidence 必须是数组`); else item.counterEvidence.forEach((fact, factIndex) => { requireString(fact.text, `${itemLabel}.counterEvidence[${factIndex}].text`, 240); refs(fact.sourceIds, `${itemLabel}.counterEvidence[${factIndex}].sourceIds`); });
    refs(item.basisSourceIds, `${itemLabel}.basisSourceIds`, 2);
  });

  const marketIds = new Set();
  if (requireArray(data.markets, `${label}.markets`, 3, 3)) data.markets.forEach((market, position) => {
    const marketLabel = `${label}.markets[${position}]`;
    if (!["a-share", "hk", "us"].includes(market.id)) fail(`${marketLabel}.id 非法`);
    if (marketIds.has(market.id)) fail(`${marketLabel}.id 重复`); marketIds.add(market.id);
    requireDate(market.sessionStart, `${marketLabel}.sessionStart`); requireDate(market.sessionEnd, `${marketLabel}.sessionEnd`);
    ["label", "summary", "weeklyPerformance", "rotation", "capitalFlow", "nextWeekScenario", "trigger", "invalidation"].forEach((field) => requireString(market[field], `${marketLabel}.${field}`, field === "label" ? 20 : 500));
    if (!["low", "medium", "medium-high"].includes(market.confidence)) fail(`${marketLabel}.confidence 非法`);
    refs(market.sourceIds, `${marketLabel}.sourceIds`, 2);
    if (market.id === "us" && market.sessionEnd >= report.weekEnd && market.coverageStatus !== "insufficient") fail(`${marketLabel} 不得包含未完成的周五美股收盘`);
  });

  if (requireArray(data.crossMarketThemes, `${label}.crossMarketThemes`, 2, 5)) data.crossMarketThemes.forEach((item, position) => {
    const itemLabel = `${label}.crossMarketThemes[${position}]`;
    requireString(item.id, `${itemLabel}.id`, 50); requireString(item.title, `${itemLabel}.title`, 100); requireString(item.thesis, `${itemLabel}.thesis`, 500); requireString(item.counterEvidence, `${itemLabel}.counterEvidence`, 300); requireString(item.nextSignal, `${itemLabel}.nextSignal`, 240);
    if (!requireArray(item.causalChain, `${itemLabel}.causalChain`, 2, 5)) return; item.causalChain.forEach((text, step) => requireString(text, `${itemLabel}.causalChain[${step}]`, 220));
    refs(item.sourceIds, `${itemLabel}.sourceIds`, 2);
  });

  if (requireArray(data.nextWeekCalendar, `${label}.nextWeekCalendar`, 3, 12)) data.nextWeekCalendar.forEach((item, position) => {
    const itemLabel = `${label}.nextWeekCalendar[${position}]`;
    requireString(item.id, `${itemLabel}.id`, 50); requireIso(item.startsAt, `${itemLabel}.startsAt`); requireString(item.title, `${itemLabel}.title`, 100); requireString(item.whyWatch, `${itemLabel}.whyWatch`, 300); refs(item.sourceIds, `${itemLabel}.sourceIds`);
  });

  if (!isObject(data.localSynthesis)) fail(`${label}.localSynthesis 缺失`);
  else { if (!Array.isArray(data.localSynthesis.editionDates)) fail(`${label}.localSynthesis.editionDates 必须是数组`); if (!Number.isInteger(data.localSynthesis.archiveSnapshots) || data.localSynthesis.archiveSnapshots < 0) fail(`${label}.localSynthesis.archiveSnapshots 非法`); requireString(data.localSynthesis.note, `${label}.localSynthesis.note`, 500); }
  if (!isObject(data.methodology)) fail(`${label}.methodology 缺失`);
  for (const sourceId of sourceMap.keys()) if (!usedSources.has(sourceId)) fail(`${label}.sources 中 ${sourceId} 未被正文引用`);

  const visibleText = JSON.stringify({ executiveSummary: data.executiveSummary, majorEvents: data.majorEvents, highValueInsights: data.highValueInsights, markets: data.markets, crossMarketThemes: data.crossMarketThemes, nextWeekCalendar: data.nextWeekCalendar }).replace(/\s/g, "").length;
  if (visibleText < 3500) fail(`${label} 可见内容约 ${visibleText} 字，低于 3500 字`);
  if (visibleText > 8500) fail(`${label} 可见内容约 ${visibleText} 字，超过 8500 字硬上限`);
  const certaintyPattern = /必涨|稳赚|保证收益|确定流入|主力(?:已)?锁定|放心买入/;
  if (certaintyPattern.test(JSON.stringify(data))) fail(`${label} 含确定性投资措辞`);
}

for (const entry of index.reports ?? []) {
  const isCandidate = candidate?.report?.id === entry.id;
  const filePath = isCandidate ? candidateReportPath : path.join(weeklyRoot, `${entry.id}.json`);
  try {
    if (isCandidate) validateReport(candidate, entry, candidateSize);
    else { const [raw, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]); validateReport(JSON.parse(raw), entry, info.size); }
  } catch (error) {
    fail(`${entry.id} 无法读取或解析：${error.message}`);
  }
}

if (candidateMode && candidate) {
  const report = candidate.report ?? {};
  const entry = index.reports?.find((item) => item.id === report.id);
  if (!entry) fail("candidate report is absent from candidate index");
  else if (entry.id !== report.id || entry.revision !== report.revision || entry.weekStart !== report.weekStart || entry.weekEnd !== report.weekEnd || entry.publishedAt !== report.generatedAt || entry.title !== report.title) fail("candidate report and candidate index differ");
}

if (errors.length) {
  console.error(`\n周报校验失败（${errors.length} 项）：`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}
console.log(`周报校验通过：已发布 ${index.reports?.length ?? 0} 期；日报重大提醒 ${notices.daily ? "开启" : "关闭"}，周报提醒 ${notices.weekly ? "开启" : "待首期"}。`);
