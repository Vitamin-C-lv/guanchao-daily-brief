import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const briefPath = path.resolve(process.cwd(), "content", "daily-brief.json");
const errors = [];
const articleIds = new Set();

function fail(message) {
  errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label, { max = Infinity } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} 必须是非空字符串`);
    return;
  }
  if (value.length > max) fail(`${label} 超过 ${max} 字符`);
  if (/TODO|TBD|待补|示例链接/i.test(value)) fail(`${label} 含有未完成占位词`);
}

function requireDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    fail(`${label} 必须是 YYYY-MM-DD 日期`);
  }
}

function validateSource(source, label) {
  if (!isObject(source)) {
    fail(`${label} 必须是对象`);
    return;
  }
  requireString(source.name, `${label}.name`, { max: 40 });
  requireString(source.publisher, `${label}.publisher`, { max: 60 });
  requireString(source.url, `${label}.url`, { max: 500 });
  if (typeof source.url === "string") {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") fail(`${label}.url 必须使用 HTTPS`);
      if (url.hostname.includes("google.com") && url.pathname.includes("/search")) fail(`${label}.url 不能是搜索结果页`);
    } catch {
      fail(`${label}.url 不是有效网址`);
    }
  }
  if (!["official", "authoritative", "major-media"].includes(source.tier)) {
    fail(`${label}.tier 必须是 official、authoritative 或 major-media`);
  }
}

function validateSourceIndexes(indexes, sourceCount, label) {
  if (!Array.isArray(indexes) || indexes.length < 1) {
    fail(`${label} 至少需要 1 个引用编号`);
    return;
  }
  indexes.forEach((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= sourceCount) {
      fail(`${label} 含有越界引用编号 ${index}`);
    }
  });
}

function validateArticleDetail(detail, sourceCount, label) {
  if (!isObject(detail)) {
    fail(`${label} 必须是对象`);
    return;
  }
  requireString(detail.lead, `${label}.lead`, { max: 220 });
  if (!Array.isArray(detail.keyPoints) || detail.keyPoints.length !== 3) {
    fail(`${label}.keyPoints 必须正好有 3 条`);
  } else {
    detail.keyPoints.forEach((point, index) => requireString(point, `${label}.keyPoints[${index}]`, { max: 80 }));
  }
  if (!Array.isArray(detail.sections) || detail.sections.length !== 3) {
    fail(`${label}.sections 必须正好有 3 段`);
  } else {
    detail.sections.forEach((section, index) => {
      const sectionLabel = `${label}.sections[${index}]`;
      if (!isObject(section)) {
        fail(`${sectionLabel} 必须是对象`);
        return;
      }
      requireString(section.heading, `${sectionLabel}.heading`, { max: 30 });
      requireString(section.body, `${sectionLabel}.body`, { max: 420 });
      validateSourceIndexes(section.sourceIndexes, sourceCount, `${sectionLabel}.sourceIndexes`);
    });
  }
  if (detail.chart !== undefined) {
    if (!isObject(detail.chart)) {
      fail(`${label}.chart 必须是对象`);
    } else {
      requireString(detail.chart.title, `${label}.chart.title`, { max: 50 });
      requireString(detail.chart.unit, `${label}.chart.unit`, { max: 20 });
      if (!Array.isArray(detail.chart.items) || detail.chart.items.length < 3 || detail.chart.items.length > 6) {
        fail(`${label}.chart.items 必须包含 3–6 项`);
      } else {
        detail.chart.items.forEach((item, index) => {
          const itemLabel = `${label}.chart.items[${index}]`;
          if (!isObject(item)) {
            fail(`${itemLabel} 必须是对象`);
            return;
          }
          requireString(item.label, `${itemLabel}.label`, { max: 30 });
          requireString(item.display, `${itemLabel}.display`, { max: 20 });
          if (!Number.isFinite(item.value)) fail(`${itemLabel}.value 必须是数值`);
          if (!["positive", "negative", "neutral", "warning"].includes(item.tone)) fail(`${itemLabel}.tone 非法`);
        });
      }
      validateSourceIndexes(detail.chart.sourceIndexes, sourceCount, `${label}.chart.sourceIndexes`);
    }
  }

  const characterCount = [
    detail.lead ?? "",
    ...(Array.isArray(detail.keyPoints) ? detail.keyPoints : []),
    ...(Array.isArray(detail.sections) ? detail.sections.flatMap((section) => [section?.heading ?? "", section?.body ?? ""]) : []),
  ].join("").replace(/\s/g, "").length;
  if (characterCount < 450) fail(`${label} 正文仅 ${characterCount} 字，低于 450 字`);
  if (characterCount > 1000) fail(`${label} 正文 ${characterCount} 字，超过 1000 字硬上限`);
}

function validateArticle(article, label) {
  if (!isObject(article)) {
    fail(`${label} 必须是对象`);
    return;
  }
  requireString(article.id, `${label}.id`, { max: 80 });
  if (typeof article.id === "string") {
    if (articleIds.has(article.id)) fail(`${label}.id 与其他文章重复`);
    articleIds.add(article.id);
  }
  requireString(article.title, `${label}.title`, { max: 70 });
  requireString(article.summary, `${label}.summary`, { max: 260 });
  requireString(article.impact, `${label}.impact`, { max: 180 });
  requireDate(article.publishedAt, `${label}.publishedAt`);
  if (!Array.isArray(article.tags) || article.tags.length < 1 || article.tags.length > 6) {
    fail(`${label}.tags 必须包含 1–6 个标签`);
  }
  if (!Array.isArray(article.sources) || article.sources.length < 1) {
    fail(`${label}.sources 至少需要 1 个引用源`);
  } else {
    article.sources.forEach((source, index) => validateSource(source, `${label}.sources[${index}]`));
    const urls = article.sources.map((source) => source?.url).filter(Boolean);
    if (new Set(urls).size !== urls.length) fail(`${label}.sources 含重复链接`);
  }
  validateArticleDetail(article.detail, Array.isArray(article.sources) ? article.sources.length : 0, `${label}.detail`);
}

let data;
try {
  data = JSON.parse(await readFile(briefPath, "utf8"));
} catch (error) {
  console.error(`无法读取 ${briefPath}:`, error.message);
  process.exit(1);
}

if (!isObject(data.meta)) fail("meta 缺失");
else {
  requireDate(data.meta.editionDate, "meta.editionDate");
  requireString(data.meta.generatedAt, "meta.generatedAt");
  if (Number.isNaN(Date.parse(data.meta.generatedAt))) fail("meta.generatedAt 必须是有效 ISO 时间");
  requireDate(data.meta.dataThrough, "meta.dataThrough");
  requireString(data.meta.title, "meta.title", { max: 40 });
  requireString(data.meta.subtitle, "meta.subtitle", { max: 50 });
  requireString(data.meta.status, "meta.status", { max: 30 });
  requireString(data.meta.curationNote, "meta.curationNote", { max: 220 });
}

if (!isObject(data.pulse)) fail("pulse 缺失");
else {
  if (!Number.isFinite(data.pulse.score) || data.pulse.score < 0 || data.pulse.score > 100) fail("pulse.score 必须在 0–100 之间");
  requireString(data.pulse.label, "pulse.label", { max: 20 });
  requireString(data.pulse.explanation, "pulse.explanation", { max: 220 });
  if (!Array.isArray(data.pulse.signals) || data.pulse.signals.length !== 4) fail("pulse.signals 必须正好有 4 条");
}

if (!isObject(data.federalReserve)) fail("federalReserve 缺失");
else {
  requireString(data.federalReserve.targetRange, "federalReserve.targetRange", { max: 30 });
  requireString(data.federalReserve.stance, "federalReserve.stance", { max: 20 });
  requireDate(data.federalReserve.lastDecisionDate, "federalReserve.lastDecisionDate");
  if (!Array.isArray(data.federalReserve.path) || data.federalReserve.path.length < 3) fail("federalReserve.path 至少需要 3 个数据点");
  if (!Array.isArray(data.federalReserve.articles) || data.federalReserve.articles.length < 1) fail("federalReserve.articles 至少需要 1 条");
  else data.federalReserve.articles.forEach((article, index) => validateArticle(article, `federalReserve.articles[${index}]`));
}

const expectedMarkets = new Set(["a-share", "hk", "us"]);
if (!Array.isArray(data.markets) || data.markets.length !== 3) fail("markets 必须包含 A 股、港股、美股 3 个市场");
else {
  data.markets.forEach((market, marketIndex) => {
    const label = `markets[${marketIndex}]`;
    if (!expectedMarkets.has(market.id)) fail(`${label}.id 非法`);
    else expectedMarkets.delete(market.id);
    requireString(market.name, `${label}.name`, { max: 30 });
    requireDate(market.sessionDate, `${label}.sessionDate`);
    requireString(market.summary, `${label}.summary`, { max: 240 });
    if (!Array.isArray(market.indices) || market.indices.length < 3) fail(`${label}.indices 至少需要 3 个指数`);
    if (!Array.isArray(market.sparkline) || market.sparkline.length < 5 || market.sparkline.some((value) => !Number.isFinite(value))) fail(`${label}.sparkline 至少需要 5 个数值`);
    if (!Array.isArray(market.sources) || market.sources.length < 1) fail(`${label}.sources 至少需要 1 个来源`);
    else market.sources.forEach((source, index) => validateSource(source, `${label}.sources[${index}]`));
    if (!Array.isArray(market.articles) || market.articles.length < 1) fail(`${label}.articles 至少需要 1 条`);
    else market.articles.forEach((article, index) => validateArticle(article, `${label}.articles[${index}]`));
  });
}

if (!Array.isArray(data.hotspots) || data.hotspots.length < 3) fail("hotspots 至少需要 3 条");
else data.hotspots.forEach((item, index) => {
  validateArticle(item, `hotspots[${index}]`);
  if (!Number.isFinite(item.priority) || item.priority < 0 || item.priority > 100) fail(`hotspots[${index}].priority 必须在 0–100 之间`);
  if (!Array.isArray(item.affectedMarkets) || item.affectedMarkets.length < 1) fail(`hotspots[${index}].affectedMarkets 至少需要 1 项`);
});

if (!Array.isArray(data.watchlist) || data.watchlist.length < 1) fail("watchlist 至少需要 1 条");
if (!Array.isArray(data.sourceDirectory) || data.sourceDirectory.length < 5) fail("sourceDirectory 至少需要 5 个来源");
if (!Array.isArray(data.methodology) || data.methodology.length < 4) fail("methodology 至少需要 4 条规则");

if (errors.length) {
  console.error(`\n每日简报校验失败（${errors.length} 项）：`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const articleCount = data.federalReserve.articles.length + data.markets.reduce((sum, market) => sum + market.articles.length, 0) + data.hotspots.length;
const citationCount = [
  ...data.federalReserve.articles,
  ...data.markets.flatMap((market) => market.articles),
  ...data.hotspots,
].reduce((sum, article) => sum + article.sources.length, 0);

console.log(`每日简报校验通过：${data.meta.editionDate}，${articleCount} 条内容，${citationCount} 个可追溯引用。`);
