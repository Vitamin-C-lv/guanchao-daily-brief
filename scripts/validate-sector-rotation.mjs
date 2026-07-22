import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const rotationPath = path.resolve(root, "content", "sector-rotation.json");
const schemaPath = path.resolve(root, "schemas", "sector-rotation.schema.json");
const modelArtifactPath = path.resolve(root, "models", "sector-rotation", "a-share-v1.json");
const probabilityArtifactPath = path.resolve(root, "models", "sector-rotation", "a-share-relative-probability-v2.json");
const aShareTaxonomyPath = path.resolve(root, "models", "sector-rotation", "taxonomy.a-core12-v2.json");
const featureSourceRegistryPath = path.resolve(root, "models", "sector-rotation", "feature-source-registry-v2.json");
const dailyBriefPath = path.resolve(root, "content", "daily-brief.json");
const aShareCalendarPath = path.resolve(root, "models", "sector-rotation", "cn-market-calendar-2026.json");
const MAX_ROTATION_BYTES = 384 * 1024;
const errors = [];
const seenForecastIds = new Set();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalJsonSha256(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
const sourceEvidenceClasses = new Set([
  "official-primary",
  "company-filing",
  "primary-research",
  "exchange-market-data",
  "vendor-market-data",
  "vendor-estimate",
  "major-media",
]);
const highEvidenceClasses = new Set([
  "official-primary",
  "company-filing",
  "primary-research",
  "exchange-market-data",
  "vendor-market-data",
]);
const absolutePromisePattern = /必涨|稳赚|稳赢|保证收益|无风险收益|只涨不跌|确定(?:上涨|下跌|获利|流入)|一定(?:上涨|下跌|获利|流入)|必然(?:上涨|下跌|获利|流入)|百分之百|100%\s*(?:上涨|下跌|获利|流入)|主力(?:已)?锁定|放心买入|明确买入/;

function fail(message) {
  errors.push(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, label) {
  if (!isObject(value)) {
    fail(`${label} 必须是对象`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label}.${key} 不是数据契约允许的字段`);
  }
  return true;
}

function requireString(value, label, { max = Infinity } = {}) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${label} 必须是非空字符串`);
    return false;
  }
  if (value.length > max) fail(`${label} 超过 ${max} 字符`);
  if (/TODO|TBD|待补|示例链接/i.test(value)) fail(`${label} 含未完成占位词`);
  return true;
}

function requireDate(value, label) {
  const parsed = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00Z`)
    : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} 必须是 YYYY-MM-DD 日期`);
    return false;
  }
  return true;
}

function requireIsoShanghai(value, label) {
  if (!requireString(value, label)) return false;
  if (Number.isNaN(Date.parse(value))) {
    fail(`${label} 必须是有效 ISO 时间`);
    return false;
  }
  if (!/[+]08:00$/.test(value)) fail(`${label} 必须显式使用 Asia/Shanghai 的 +08:00 偏移`);
  return true;
}

function requireFiniteRange(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) {
    fail(`${label} 必须是 ${min}–${max} 的有限数值`);
    return false;
  }
  return true;
}

function validateSource(source, label) {
  if (!exactKeys(source, ["name", "publisher", "url", "tier", "evidenceClass"], label)) return;
  requireString(source.name, `${label}.name`, { max: 80 });
  requireString(source.publisher, `${label}.publisher`, { max: 80 });
  if (requireString(source.url, `${label}.url`, { max: 600 })) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:") fail(`${label}.url 必须是可直达的 HTTPS 页面`);
      if (/google\.[^/]+$/i.test(url.hostname) && url.pathname.includes("/search")) fail(`${label}.url 不能是搜索结果页`);
      if (/github\.com$/i.test(url.hostname) && /A-stock-data/i.test(url.pathname)) fail(`${label}.url 不能用取数技能仓库替代上游证据`);
    } catch {
      fail(`${label}.url 不是有效网址`);
    }
  }
  if (!["official", "authoritative", "major-media"].includes(source.tier)) fail(`${label}.tier 非法`);
  if (source.evidenceClass !== undefined && !sourceEvidenceClasses.has(source.evidenceClass)) fail(`${label}.evidenceClass 非法`);
}

function validateSourceIndexes(indexes, sources, label) {
  if (!Array.isArray(indexes) || indexes.length < 1) {
    fail(`${label} 至少需要一个来源编号`);
    return [];
  }
  const unique = new Set();
  indexes.forEach((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= sources.length) fail(`${label} 含越界来源编号 ${index}`);
    else if (unique.has(index)) fail(`${label} 含重复来源编号 ${index}`);
    else unique.add(index);
  });
  return [...unique];
}

function validateRanksAndValues(items, label, valueKey) {
  const sectors = new Set();
  const codes = new Set();
  let previousValue = Infinity;
  items.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!Number.isInteger(item?.rank) || item.rank !== index + 1) fail(`${itemLabel}.rank 必须按展示顺序连续为 ${index + 1}`);
    if (Number.isFinite(item?.[valueKey])) {
      requireFiniteRange(item[valueKey], 0, 100, `${itemLabel}.${valueKey}`);
      if (item[valueKey] > previousValue) fail(`${label} 必须按 ${valueKey} 从高到低排序`);
      previousValue = item[valueKey];
    } else fail(`${itemLabel}.${valueKey} 必须是有限数值`);
    if (typeof item?.sector === "string") {
      const key = item.sector.trim().toLowerCase();
      if (sectors.has(key)) fail(`${label} 含重复行业/指数 ${item.sector}`);
      sectors.add(key);
    }
    if (typeof item?.code === "string") {
      const code = item.code.trim().toLowerCase();
      if (codes.has(code)) fail(`${label} 含重复代码 ${item.code}`);
      codes.add(code);
    }
  });
}

function aShareDueDate(asOf, sessions) {
  if (!aShareCalendar || Number(asOf.slice(0, 4)) !== aShareCalendar.year) return null;
  const closed = new Set(aShareCalendar.closedWeekdays ?? []);
  const cursor = new Date(`${asOf}T00:00:00+08:00`);
  let remaining = sessions;
  while (remaining > 0) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dateText = cursor.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const weekdayName = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Asia/Shanghai" }).format(cursor);
    const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);
    if (weekday >= 1 && weekday <= 5 && !closed.has(dateText)) remaining -= 1;
    if (Number(dateText.slice(0, 4)) !== aShareCalendar.year && remaining > 0) return null;
  }
  return cursor.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function validateObservedItem(item, sources, label) {
  if (!exactKeys(item, ["sector", "code", "rank", "score", "direction", "signal", "metrics", "sourceIndexes"], label)) return;
  requireString(item.sector, `${label}.sector`, { max: 60 });
  if (item.code !== undefined) requireString(item.code, `${label}.code`, { max: 30 });
  if (!["leading", "strengthening", "neutral", "weakening", "lagging"].includes(item.direction)) fail(`${label}.direction 非法`);
  requireString(item.signal, `${label}.signal`, { max: 240 });
  if (!Array.isArray(item.metrics) || item.metrics.length < 1 || item.metrics.length > 8) {
    fail(`${label}.metrics 必须包含 1–8 项当前观测指标`);
  } else {
    const labels = new Set();
    item.metrics.forEach((metric, index) => {
      const metricLabel = `${label}.metrics[${index}]`;
      if (!exactKeys(metric, ["label", "value", "tone"], metricLabel)) return;
      requireString(metric.label, `${metricLabel}.label`, { max: 40 });
      requireString(metric.value, `${metricLabel}.value`, { max: 40 });
      if (labels.has(metric.label)) fail(`${label}.metrics 含重复指标 ${metric.label}`);
      labels.add(metric.label);
      if (metric.tone !== undefined && !["positive", "negative", "neutral", "warning"].includes(metric.tone)) fail(`${metricLabel}.tone 非法`);
    });
  }
  validateSourceIndexes(item.sourceIndexes, sources, `${label}.sourceIndexes`);
  if (absolutePromisePattern.test(`${item.signal}${JSON.stringify(item.metrics ?? [])}`)) fail(`${label} 含确定性投资措辞`);
}

function validateEvidencePoint(point, sources, label) {
  if (!exactKeys(point, ["label", "observation", "sourceIndexes"], label)) return [];
  requireString(point.label, `${label}.label`, { max: 50 });
  requireString(point.observation, `${label}.observation`, { max: 260 });
  return validateSourceIndexes(point.sourceIndexes, sources, `${label}.sourceIndexes`);
}

function validateStrictDates(points, chartAsOf, label) {
  let previousDate = "";
  points.forEach((point, index) => {
    const pointLabel = `${label}[${index}]`;
    if (!requireDate(point?.date, `${pointLabel}.date`)) return;
    if (previousDate && point.date <= previousDate) fail(`${label} 日期必须严格升序且不得重复`);
    previousDate = point.date;
  });
  if (points.length && typeof chartAsOf === "string" && points.at(-1)?.date !== chartAsOf) {
    fail(`${label} 最后一个日期必须等于图表 asOf ${chartAsOf}`);
  }
}

function validateCharts(charts, horizonAsOf, sources, label) {
  if (charts === undefined) return;
  if (!Array.isArray(charts) || charts.length < 1 || charts.length > 3) {
    fail(`${label} 必须包含 1–3 张完整图表；没有完整数据时应省略 charts`);
    return;
  }

  const titles = new Set();
  charts.forEach((chart, chartIndex) => {
    const chartLabel = `${label}[${chartIndex}]`;
    if (!isObject(chart)) {
      fail(`${chartLabel} 必须是对象`);
      return;
    }
    const allowedKeys = chart.type === "line"
      ? ["type", "title", "unit", "note", "asOf", "sourceIndexes", "series"]
      : chart.type === "candlestick"
        ? ["type", "title", "unit", "note", "asOf", "sourceIndexes", "points"]
        : ["type", "title", "unit", "note", "asOf", "sourceIndexes"];
    exactKeys(chart, allowedKeys, chartLabel);
    if (!['line', 'candlestick'].includes(chart.type)) {
      fail(`${chartLabel}.type 必须是 line 或 candlestick`);
      return;
    }
    requireString(chart.title, `${chartLabel}.title`, { max: 80 });
    requireString(chart.unit, `${chartLabel}.unit`, { max: 20 });
    requireString(chart.note, `${chartLabel}.note`, { max: 240 });
    if (typeof chart.title === "string") {
      const key = chart.title.trim().toLowerCase();
      if (titles.has(key)) fail(`${label} 含重复图名 ${chart.title}`);
      titles.add(key);
    }
    if (requireDate(chart.asOf, `${chartLabel}.asOf`) && chart.asOf !== horizonAsOf) {
      fail(`${chartLabel}.asOf 必须与所属窗口 asOf ${horizonAsOf} 一致`);
    }
    validateSourceIndexes(chart.sourceIndexes, sources, `${chartLabel}.sourceIndexes`);

    if (chart.type === "line") {
      if (!Array.isArray(chart.series) || chart.series.length < 1 || chart.series.length > 4) {
        fail(`${chartLabel}.series 必须包含 1–4 条真实序列`);
        return;
      }
      const seriesNames = new Set();
      chart.series.forEach((series, seriesIndex) => {
        const seriesLabel = `${chartLabel}.series[${seriesIndex}]`;
        if (!exactKeys(series, ["name", "points"], seriesLabel)) return;
        requireString(series.name, `${seriesLabel}.name`, { max: 40 });
        if (typeof series.name === "string") {
          const key = series.name.trim().toLowerCase();
          if (seriesNames.has(key)) fail(`${chartLabel}.series 含重复名称 ${series.name}`);
          seriesNames.add(key);
        }
        if (!Array.isArray(series.points) || series.points.length < 2 || series.points.length > 60) {
          fail(`${seriesLabel}.points 必须包含 2–60 个真实观测点`);
          return;
        }
        series.points.forEach((point, pointIndex) => {
          const pointLabel = `${seriesLabel}.points[${pointIndex}]`;
          if (!exactKeys(point, ["date", "value"], pointLabel)) return;
          if (!Number.isFinite(point.value)) fail(`${pointLabel}.value 必须是有限数值`);
        });
        validateStrictDates(series.points, chart.asOf, `${seriesLabel}.points`);
      });
      return;
    }

    if (!Array.isArray(chart.points) || chart.points.length < 2 || chart.points.length > 60) {
      fail(`${chartLabel}.points 必须包含 2–60 根完整 K 线`);
      return;
    }
    chart.points.forEach((point, pointIndex) => {
      const pointLabel = `${chartLabel}.points[${pointIndex}]`;
      if (!exactKeys(point, ["date", "open", "high", "low", "close"], pointLabel)) return;
      for (const field of ["open", "high", "low", "close"]) {
        if (!Number.isFinite(point[field])) fail(`${pointLabel}.${field} 必须是有限数值`);
      }
      if ([point.open, point.high, point.low, point.close].every(Number.isFinite)) {
        if (point.high < Math.max(point.open, point.close)) fail(`${pointLabel}.high 不得低于 open/close`);
        if (point.low > Math.min(point.open, point.close)) fail(`${pointLabel}.low 不得高于 open/close`);
      }
    });
    validateStrictDates(chart.points, chart.asOf, `${chartLabel}.points`);
  });
}

function validateConfidence(item, evidenceIndexes, sources, label) {
  if (item.confidence === "low") return;
  const cited = [...new Set(evidenceIndexes)].map((index) => sources[index]).filter(Boolean);
  const publishers = new Set(cited.map((source) => source.publisher.trim().toLowerCase()));
  const evidenceClasses = new Set(cited.map((source) => source.evidenceClass).filter(Boolean));
  const highPublishers = new Set(cited.filter((source) => highEvidenceClasses.has(source.evidenceClass)).map((source) => source.publisher.trim().toLowerCase()));
  if (item.confidence === "medium") {
    if (publishers.size < 2 || evidenceClasses.size < 2 || highPublishers.size < 1) {
      fail(`${label}.confidence=medium 至少需要 2 个发布方、2 类证据且包含 1 个官方/原始/市场数据来源`);
    }
  }
  if (item.confidence === "medium-high") {
    if (publishers.size < 3 || evidenceClasses.size < 3 || highPublishers.size < 2) {
      fail(`${label}.confidence=medium-high 至少需要 3 个发布方、3 类证据且其中 2 个为官方/原始/市场数据来源`);
    }
  }
}

function validateForecastItem(item, sources, horizonDueDate, label, context) {
  if (!exactKeys(item, ["forecastId", "sector", "code", "rank", "rankingTarget", "topQuartileProbability", "outperformanceProbability", "absoluteUpProbability", "expectedExcessReturn", "rawScore", "rawProbability", "calibratedProbability", "historicalBaseRate", "effectiveEdge", "probabilityTier", "direction", "confidence", "calibrationBasis", "claim", "evidence", "counterEvidence", "trigger", "invalidation", "dueDate"], label)) return;
  if (requireString(item.forecastId, `${label}.forecastId`, { max: 100 })) {
    if (!/^fr-[a-z0-9-]+$/.test(item.forecastId)) fail(`${label}.forecastId 格式非法`);
    if (seenForecastIds.has(item.forecastId)) fail(`${label}.forecastId 与其他预测重复`);
    seenForecastIds.add(item.forecastId);
  }
  requireString(item.sector, `${label}.sector`, { max: 60 });
  if (item.code !== undefined) requireString(item.code, `${label}.code`, { max: 30 });
  if (!["strong-up", "up", "range", "down", "strong-down"].includes(item.direction)) fail(`${label}.direction 非法`);
  if (!["low", "medium", "medium-high"].includes(item.confidence)) fail(`${label}.confidence 非法`);
  if (item.rankingTarget !== "top-quartile") fail(`${label}.rankingTarget 必须是 top-quartile`);
  requireFiniteRange(item.topQuartileProbability, 0, 100, `${label}.topQuartileProbability`);
  requireFiniteRange(item.outperformanceProbability, 0, 100, `${label}.outperformanceProbability`);
  requireFiniteRange(item.absoluteUpProbability, 0, 100, `${label}.absoluteUpProbability`);
  requireFiniteRange(item.expectedExcessReturn, -100, 100, `${label}.expectedExcessReturn`);
  if (!Number.isFinite(item.rawScore)) fail(`${label}.rawScore 必须是有限数值`);
  requireFiniteRange(item.rawProbability, 0, 100, `${label}.rawProbability`);
  requireFiniteRange(item.calibratedProbability, 0, 100, `${label}.calibratedProbability`);
  requireFiniteRange(item.historicalBaseRate, 0, 100, `${label}.historicalBaseRate`);
  requireFiniteRange(item.effectiveEdge, -100, 100, `${label}.effectiveEdge`);
  if (Number.isFinite(item.topQuartileProbability) && Number.isFinite(item.historicalBaseRate)
    && Math.abs(item.effectiveEdge - (item.topQuartileProbability - item.historicalBaseRate)) > 0.11) {
    fail(`${label}.effectiveEdge 必须等于前四分位概率减历史基准（允许0.1个百分点舍入）`);
  }
  if (item.probabilityTier !== "model-calibrated") fail(`${label}.probabilityTier 必须为 model-calibrated`);
  if (requireString(item.calibrationBasis, `${label}.calibrationBasis`, { max: 360 })) {
    if (item.calibrationBasis.length < 20) fail(`${label}.calibrationBasis 少于20字符`);
    if (!/(样本外|校准|RankIC|Top-Bottom)/.test(item.calibrationBasis)) fail(`${label}.calibrationBasis 必须说明样本外质量`);
  }
  requireString(item.claim, `${label}.claim`, { max: 280 });
  requireString(item.trigger, `${label}.trigger`, { max: 220 });
  requireString(item.invalidation, `${label}.invalidation`, { max: 220 });
  requireDate(item.dueDate, `${label}.dueDate`);
  if (typeof horizonDueDate === "string" && item.dueDate !== horizonDueDate) fail(`${label}.dueDate 必须与所属窗口 dueDate 一致`);
  if (context?.market?.id === "a-share" && typeof item.code === "string") {
    const identity = [
      probabilityArtifact?.id,
      probabilityArtifact?.version,
      "a-share",
      context.horizon.asOf,
      context.horizon.dueDate,
      String(context.sessions),
      item.code,
    ].join("\0");
    const digest = createHash("sha256").update(identity, "utf8").digest("hex").slice(0, 12);
    const expected = `fr-a-${context.horizon.asOf.replaceAll("-", "")}-h${context.sessions}-${item.code}-${digest}`;
    if (item.forecastId !== expected) fail(`${label}.forecastId 必须由冻结模型版本与预测身份确定生成`);
  }

  const evidenceIndexes = [];
  if (!Array.isArray(item.evidence) || item.evidence.length < 2 || item.evidence.length > 5) {
    fail(`${label}.evidence 必须包含 2–5 条证据`);
  } else {
    item.evidence.forEach((point, index) => evidenceIndexes.push(...validateEvidencePoint(point, sources, `${label}.evidence[${index}]`)));
  }
  if (!Array.isArray(item.counterEvidence) || item.counterEvidence.length < 1 || item.counterEvidence.length > 3) {
    fail(`${label}.counterEvidence 必须包含 1–3 条反证`);
  } else {
    item.counterEvidence.forEach((point, index) => validateEvidencePoint(point, sources, `${label}.counterEvidence[${index}]`));
  }
  validateConfidence(item, evidenceIndexes, sources, label);

  const forecastText = `${item.claim}${item.trigger}${item.invalidation}${JSON.stringify(item.evidence ?? [])}${JSON.stringify(item.counterEvidence ?? [])}`;
  if (absolutePromisePattern.test(forecastText)) fail(`${label} 含确定性投资措辞`);
  if (!/(若|如果|一旦|前提|条件|情景|维持|保持)/.test(`${item.claim}${item.trigger}`)) fail(`${label} 必须提供可验证的条件或触发项`);
}

function validateHorizon(horizon, market, sources, label, { kind, sessions }) {
  if (!isObject(horizon)) {
    fail(`${label} 必须是对象`);
    return;
  }
  if (horizon.kind !== kind) fail(`${label}.kind 必须是 ${kind}`);
  if (!["ready", "abstained", "insufficient"].includes(horizon.status)) fail(`${label}.status 必须是 ready、abstained 或 insufficient`);
  requireDate(horizon.asOf, `${label}.asOf`);
  if (horizon.asOf !== market.asOf) fail(`${label}.asOf 必须与 market.asOf 一致`);

  if (horizon.status === "insufficient") {
    const allowed = kind === "forecast" ? ["kind", "status", "asOf", "dueDate", "sessions", "reason"] : ["kind", "status", "asOf", "reason"];
    exactKeys(horizon, allowed, label);
    requireString(horizon.reason, `${label}.reason`, { max: 300 });
    if (horizon.items !== undefined) fail(`${label} 证据不足时不得伪造 items`);
    if (kind === "forecast") {
      if (horizon.sessions !== sessions) fail(`${label}.sessions 必须是 ${sessions}`);
      if (horizon.dueDate !== undefined) requireDate(horizon.dueDate, `${label}.dueDate`);
    }
    return;
  }

  if (horizon.status === "abstained") {
    if (kind !== "forecast") fail(`${label} 只有预测窗口可以abstained`);
    exactKeys(horizon, ["kind", "status", "asOf", "dueDate", "sessions", "reason", "abstainReasons", "note", "observationItems", "availableEvidence", "nextWatch", "diagnostics"], label);
    if (horizon.sessions !== sessions) fail(`${label}.sessions 必须是 ${sessions}`);
    if (horizon.dueDate !== undefined) requireDate(horizon.dueDate, `${label}.dueDate`);
    requireString(horizon.reason, `${label}.reason`, { max: 300 });
    requireString(horizon.note, `${label}.note`, { max: 400 });
    if (!Array.isArray(horizon.abstainReasons) || !horizon.abstainReasons.length) fail(`${label}.abstainReasons 不得为空`);
    if (!Array.isArray(horizon.observationItems) || horizon.observationItems.length < 3) fail(`${label}.observationItems 至少3项`);
    else {
      validateRanksAndValues(horizon.observationItems, `${label}.observationItems`, "score");
      horizon.observationItems.forEach((item, index) => validateObservedItem(item, sources, `${label}.observationItems[${index}]`));
    }
    if (!Array.isArray(horizon.availableEvidence) || !horizon.availableEvidence.length) fail(`${label}.availableEvidence 不得为空`);
    if (!Array.isArray(horizon.nextWatch) || !horizon.nextWatch.length) fail(`${label}.nextWatch 不得为空`);
    if (!isObject(horizon.diagnostics)) fail(`${label}.diagnostics 必须是对象`);
    else {
      requireString(horizon.diagnostics.modelVersion, `${label}.diagnostics.modelVersion`, { max: 80 });
      requireFiniteRange(horizon.diagnostics.dataCompleteness, 0, 1, `${label}.diagnostics.dataCompleteness`);
      for (const key of ["rankIc", "topBottomSpreadAfterCosts", "predictionCrossSectionStd"]) {
        if (horizon.diagnostics[key] !== null && !Number.isFinite(horizon.diagnostics[key])) fail(`${label}.diagnostics.${key} 必须是数值或null`);
      }
    }
    return;
  }

  if (kind === "observed") {
    exactKeys(horizon, ["kind", "status", "asOf", "note", "items", "charts"], label);
    requireString(horizon.note, `${label}.note`, { max: 300 });
  } else {
    exactKeys(horizon, ["kind", "status", "asOf", "dueDate", "sessions", "note", "items", "charts"], label);
    requireDate(horizon.dueDate, `${label}.dueDate`);
    if (horizon.sessions !== sessions) fail(`${label}.sessions 必须是 ${sessions}`);
    if (typeof horizon.dueDate === "string" && horizon.dueDate <= horizon.asOf) fail(`${label}.dueDate 必须晚于 asOf，并由对应市场交易日历计算`);
    if (market.id === "a-share") {
      const expectedDueDate = aShareDueDate(horizon.asOf, sessions);
      if (!expectedDueDate) fail(`${label} 缺少覆盖该窗口的A股官方交易日历，必须降级 insufficient`);
      else if (horizon.dueDate !== expectedDueDate) fail(`${label}.dueDate 应为第 ${sessions} 个A股交易日 ${expectedDueDate}`);
    }
    if (!/(前25%|前四分位|概率)/.test(`${market.note}${horizon.note}`) || !/(基准|样本外|校准)/.test(`${market.note}${horizon.note}`)) {
      fail(`${label}.note 必须说明主目标和样本外校准口径`);
    }
    requireString(horizon.note, `${label}.note`, { max: 300 });
  }

  if (!Array.isArray(horizon.items) || horizon.items.length < 3 || horizon.items.length > (kind === "observed" ? 50 : 30)) {
    fail(`${label}.items 必须包含 3–${kind === "observed" ? 50 : 30} 项`);
    return;
  }
  validateRanksAndValues(horizon.items, `${label}.items`, kind === "observed" ? "score" : "topQuartileProbability");
  horizon.items.forEach((item, index) => {
    if (kind === "observed") validateObservedItem(item, sources, `${label}.items[${index}]`);
    else validateForecastItem(item, sources, horizon.dueDate, `${label}.items[${index}]`, { market, horizon, sessions });
  });
  validateCharts(horizon.charts, horizon.asOf, sources, `${label}.charts`);
}

function usIndexKind(name) {
  const normalized = name.replace(/[\s._-]/g, "").toLowerCase();
  if (/纳斯达克|纳指|nasdaq/.test(normalized)) return "nasdaq";
  if (/道琼斯|道指|dowjones|dow30/.test(normalized)) return "dow";
  if (/标普500|标普|s&p500|sp500/.test(normalized)) return "sp500";
  return null;
}

function validateUsItems(horizon, label) {
  if (horizon?.status !== "ready") return;
  if (horizon.items.length !== 3) fail(`${label} 美股只允许纳斯达克、道琼斯、标普500三大指数`);
  const kinds = horizon.items.map((item) => usIndexKind(item.sector));
  if (kinds.some((kind) => kind === null) || new Set(kinds).size !== 3) fail(`${label} 必须且只能包含纳斯达克、道琼斯、标普500三大指数，不得混入行业板块`);
}

function validateDirectCodeEvidence(horizon, sources, label) {
  if (horizon?.status !== "ready") return;
  horizon.items.forEach((item, index) => {
    if (!item.code) return;
    const nestedIndexes = [
      ...(item.sourceIndexes ?? []),
      ...(item.evidence ?? []).flatMap((point) => point.sourceIndexes ?? []),
      ...(item.counterEvidence ?? []).flatMap((point) => point.sourceIndexes ?? []),
    ];
    const hasDirectCodeLink = nestedIndexes.some((sourceIndex) => {
      const url = sources[sourceIndex]?.url ?? "";
      return url.toLowerCase().includes(encodeURIComponent(item.code).toLowerCase())
        || url.toLowerCase().includes(item.code.toLowerCase());
    });
    if (!hasDirectCodeLink) fail(`${label}.items[${index}] 缺少包含代码 ${item.code} 的直达数据来源`);
  });
}

function validateMarket(market, label) {
  if (!exactKeys(market, ["id", "label", "mode", "asOf", "status", "taxonomy", "note", "reason", "sources", "horizons"], label)) return;
  requireString(market.label, `${label}.label`, { max: 30 });
  requireDate(market.asOf, `${label}.asOf`);
  if (!["ready", "insufficient"].includes(market.status)) fail(`${label}.status 非法`);
  requireString(market.note, `${label}.note`, { max: 400 });
  if (market.status === "insufficient") requireString(market.reason, `${label}.reason`, { max: 400 });

  if (!exactKeys(market.taxonomy, ["owner", "name", "version", "effectiveDate"], `${label}.taxonomy`)) return;
  requireString(market.taxonomy.owner, `${label}.taxonomy.owner`, { max: 80 });
  requireString(market.taxonomy.name, `${label}.taxonomy.name`, { max: 100 });
  requireString(market.taxonomy.version, `${label}.taxonomy.version`, { max: 50 });
  requireDate(market.taxonomy.effectiveDate, `${label}.taxonomy.effectiveDate`);

  if (!Array.isArray(market.sources) || market.sources.length > 40) fail(`${label}.sources 必须是最多 40 项的数组`);
  else market.sources.forEach((source, index) => validateSource(source, `${label}.sources[${index}]`));
  const sources = Array.isArray(market.sources) ? market.sources : [];

  if (!exactKeys(market.horizons, ["current", "tomorrow", "oneWeek", "oneMonth"], `${label}.horizons`)) return;
  validateHorizon(market.horizons.current, market, sources, `${label}.horizons.current`, { kind: "observed" });
  validateHorizon(market.horizons.tomorrow, market, sources, `${label}.horizons.tomorrow`, { kind: "forecast", sessions: 1 });
  validateHorizon(market.horizons.oneWeek, market, sources, `${label}.horizons.oneWeek`, { kind: "forecast", sessions: 5 });
  validateHorizon(market.horizons.oneMonth, market, sources, `${label}.horizons.oneMonth`, { kind: "forecast", sessions: 20 });

  if (market.status === "ready" && market.horizons.current?.status !== "ready") fail(`${label}.status=ready 时当前观测必须 ready`);
  if (market.status === "insufficient" && market.horizons.current?.status === "ready") fail(`${label}.status=insufficient 时不得隐藏 ready 的当前观测`);
  if (market.id === "a-share") {
    if (market.mode !== "industry") fail(`${label}.mode 必须是 industry`);
    if (!/中证|CSI/i.test(market.taxonomy.owner) || !/(核心行业.*观察池|中证全指.*二级|CSI All Share)/i.test(market.taxonomy.name)) {
      fail(`${label}.taxonomy 必须明确使用中证指数固定行业观察池`);
    }
    const fixedCodes = new Set((modelArtifact?.taxonomy?.indices ?? []).map((item) => item.code));
    const fixedUniverseCount = fixedCodes.size;
    const requiredFocusCodes = ["000991", "399967", "399970"];
    if (fixedUniverseCount < 3 || fixedUniverseCount > 20) fail(`${label} 冻结观察池必须包含3–20项`);
    if (requiredFocusCodes.some((code) => !fixedCodes.has(code))) fail(`${label} 冻结观察池必须包含医疗、军工、互联网三个重点代码`);
    if (modelArtifact?.taxonomy?.documentVersion && market.taxonomy.version !== modelArtifact.taxonomy.documentVersion) {
      fail(`${label}.taxonomy.version 必须与冻结模型观察池版本一致`);
    }
    if (market.horizons.current?.status === "ready") {
      const currentItems = market.horizons.current.items;
      if (currentItems.length > fixedUniverseCount) fail(`${label}.horizons.current 不得超出冻结观察池${fixedUniverseCount}项`);
      if (currentItems.some((item) => !fixedCodes.has(item.code))) fail(`${label}.horizons.current 含观察池外代码`);
      if (currentItems.length < fixedUniverseCount && !market.horizons.current.note.includes(`${currentItems.length}/${fixedUniverseCount}`)) {
        fail(`${label}.horizons.current 部分覆盖必须在note明确写出${currentItems.length}/${fixedUniverseCount}`);
      }
    }
    for (const [horizonKey, sessions, horizon] of [["tomorrow", 1, market.horizons.tomorrow], ["oneWeek", 5, market.horizons.oneWeek], ["oneMonth", 20, market.horizons.oneMonth]]) {
      if (horizon?.status !== "ready") continue;
      const forecastCodes = new Set(horizon.items.map((item) => item.code));
      if (horizon.items.length !== fixedUniverseCount || forecastCodes.size !== fixedUniverseCount
        || [...fixedCodes].some((code) => !forecastCodes.has(code))) {
        fail(`${label}.horizons.${horizonKey} 预测必须完整覆盖冻结观察池${fixedUniverseCount}项，部分覆盖只能用于当前观测`);
      }
      const currentCodes = new Set((market.horizons.current?.items ?? []).map((item) => item.code));
      if (market.horizons.current?.status !== "ready" || currentCodes.size !== fixedUniverseCount
        || [...fixedCodes].some((code) => !currentCodes.has(code))) {
        fail(`${label}.horizons.${horizonKey} 发布预测时当前截面必须完整覆盖冻结观察池，部分当前观测不得升级为预测`);
      }
      const probabilityHorizon = probabilityArtifact?.horizons?.[String(sessions)];
      if (probabilityHorizon?.status !== "ready") fail(`${label}.horizons.${horizonKey} 对应上涨概率模型未就绪`);
    }
    validateDirectCodeEvidence(market.horizons.current, sources, `${label}.horizons.current`);
    validateDirectCodeEvidence(market.horizons.tomorrow, sources, `${label}.horizons.tomorrow`);
    validateDirectCodeEvidence(market.horizons.oneWeek, sources, `${label}.horizons.oneWeek`);
    validateDirectCodeEvidence(market.horizons.oneMonth, sources, `${label}.horizons.oneMonth`);
  } else if (market.id === "hk") {
    if (market.mode !== "industry") fail(`${label}.mode 必须是 industry`);
    if (!/恒生|Hang Seng/i.test(`${market.taxonomy.owner}${market.taxonomy.name}`) || !/一级|level.?1/i.test(market.taxonomy.name)) {
      fail(`${label}.taxonomy 必须明确使用恒生行业分类一级行业`);
    }
    if (market.horizons.current?.status === "ready" && market.horizons.current.items.length !== 12) fail(`${label}.horizons.current 必须完整覆盖12个恒生一级行业`);
  } else if (market.id === "us") {
    if (market.mode !== "major-index") fail(`${label}.mode 必须是 major-index，美股不得作为行业轮动模型`);
    validateUsItems(market.horizons.current, `${label}.horizons.current`);
    validateUsItems(market.horizons.tomorrow, `${label}.horizons.tomorrow`);
    validateUsItems(market.horizons.oneWeek, `${label}.horizons.oneWeek`);
    validateUsItems(market.horizons.oneMonth, `${label}.horizons.oneMonth`);
  }
}

let data;
let aShareCalendar;
let modelArtifact;
let probabilityArtifact;
let aShareTaxonomy;
let dailyBrief;
let featureSourceRegistry;
try {
  const [info, raw, schemaRaw, calendarRaw, modelRaw, probabilityRaw, taxonomyRaw, dailyBriefRaw, registryRaw] = await Promise.all([
    stat(rotationPath),
    readFile(rotationPath, "utf8"),
    readFile(schemaPath, "utf8"),
    readFile(aShareCalendarPath, "utf8"),
    readFile(modelArtifactPath, "utf8"),
    readFile(probabilityArtifactPath, "utf8"),
    readFile(aShareTaxonomyPath, "utf8"),
    readFile(dailyBriefPath, "utf8"),
    readFile(featureSourceRegistryPath, "utf8"),
  ]);
  if (info.size > MAX_ROTATION_BYTES) fail(`sector-rotation.json 为 ${info.size} 字节，超过 ${MAX_ROTATION_BYTES} 字节低内存上限`);
  JSON.parse(schemaRaw);
  aShareCalendar = JSON.parse(calendarRaw);
  modelArtifact = JSON.parse(modelRaw);
  probabilityArtifact = JSON.parse(probabilityRaw);
  aShareTaxonomy = JSON.parse(taxonomyRaw);
  dailyBrief = JSON.parse(dailyBriefRaw);
  featureSourceRegistry = JSON.parse(registryRaw);
  data = JSON.parse(raw);
} catch (error) {
  console.error(`行业轮动数据无法读取或解析：${error.message}`);
  process.exit(1);
}

if (!isObject(modelArtifact) || !isObject(modelArtifact.backtest) || !isObject(modelArtifact.models)) {
  fail("A股冻结模型 artifact 缺少 models/backtest，不能验证内容来源");
} else {
  if (!isObject(aShareTaxonomy) || !isObject(modelArtifact.taxonomy) || typeof modelArtifact.taxonomyHash !== "string") {
    fail("A股冻结模型或固定观察池缺少可验证 taxonomy/taxonomyHash");
  } else {
    const currentTaxonomyHash = canonicalJsonSha256(aShareTaxonomy);
    if (modelArtifact.taxonomyHash !== currentTaxonomyHash) fail("A股冻结模型 taxonomyHash 与当前固定观察池不一致");
    if (canonicalJsonSha256(modelArtifact.taxonomy) !== currentTaxonomyHash) fail("A股冻结模型内嵌 taxonomy 与当前固定观察池不一致");
  }
  const artifactCoverageComplete = modelArtifact.data?.coverageCount === modelArtifact.data?.universeCount
    && modelArtifact.data?.trainingCoverageComplete === true;
  const featureManifest = modelArtifact.data?.featureManifest;
  if (artifactCoverageComplete && (
    !isObject(featureManifest)
    || featureManifest.sourceCoverageCount !== modelArtifact.data.universeCount
    || featureManifest.coverageCount !== modelArtifact.data.universeCount
    || featureManifest.featureDateMinCount !== modelArtifact.data.universeCount
    || featureManifest.featureDateMaxCount !== modelArtifact.data.universeCount
    || featureManifest.featurePanelComplete !== true
  )) fail("A股冻结模型声明全覆盖，但历史特征横截面并非逐日完整");
  if (!artifactCoverageComplete && modelArtifact.backtest.status !== "insufficient") fail("A股冻结模型未全分类覆盖时 backtest.status 必须降级 insufficient");
  for (const sessions of [5, 20]) {
    const horizon = modelArtifact.backtest?.horizons?.[String(sessions)];
    if (!isObject(horizon) || !Array.isArray(horizon.folds) || !horizon.folds.length) {
      fail(`A股冻结模型缺少 ${sessions} 日 walk-forward folds`);
      continue;
    }
    horizon.folds.forEach((fold, index) => {
      const label = `artifact.backtest.${sessions}.folds[${index}]`;
      if (!requireDate(fold.start, `${label}.start`)) return;
      requireDate(fold.end, `${label}.end`);
      if (!requireDate(fold.trainingTargetDateMax, `${label}.trainingTargetDateMax`)) return;
      if (fold.trainingTargetDateMax >= fold.start) fail(`${label} 存在未到期标签越过测试边界`);
      if (fold.purgeSessions !== sessions) fail(`${label}.purgeSessions 必须是 ${sessions}`);
    });
  }
}

if (!isObject(probabilityArtifact) || !isObject(probabilityArtifact.horizons)) {
  fail("A股多目标相对收益 artifact 缺少 horizons");
} else {
  if (probabilityArtifact.schemaVersion !== 2) fail("A股多目标 artifact.schemaVersion 必须为2");
  requireString(probabilityArtifact.id, "probabilityArtifact.id", { max: 80 });
  requireString(probabilityArtifact.version, "probabilityArtifact.version", { max: 60 });
  requireIsoShanghai(probabilityArtifact.trainedAt, "probabilityArtifact.trainedAt");
  requireDate(probabilityArtifact.trainingStart, "probabilityArtifact.trainingStart");
  requireDate(probabilityArtifact.trainingEnd, "probabilityArtifact.trainingEnd");
  if (probabilityArtifact.taxonomyHash !== canonicalJsonSha256(aShareTaxonomy)) fail("A股多目标 artifact taxonomyHash 与当前固定观察池不一致");
  if (probabilityArtifact.benchmark?.code !== "000985") fail("A股相对收益基准必须是中证全指000985");
  if (!isObject(probabilityArtifact.dataDiagnostics)) fail("A股多目标 artifact 缺少dataDiagnostics");
  else {
    const diagnostics = probabilityArtifact.dataDiagnostics;
    if (diagnostics.expectedFeatureCount < 1) fail("dataDiagnostics.expectedFeatureCount 非法");
    if (!Array.isArray(diagnostics.sectors) || diagnostics.sectors.length !== 12) fail("dataDiagnostics.sectors 必须覆盖12项");
    if (!Array.isArray(diagnostics.sourceHealth?.failures)) fail("dataDiagnostics 必须保存数据源失败记录");
    if (diagnostics.enhancedFeatureGroups?.missingIsNeverZero !== true) fail("dataDiagnostics 必须声明缺失值不填0");
  }
  for (const sessions of [1, 5, 20]) {
    const horizon = probabilityArtifact.horizons[String(sessions)];
    const label = `probabilityArtifact.horizons.${sessions}`;
    if (!isObject(horizon) || horizon.status !== "ready") {
      fail(`${label} 必须存在且ready`);
      continue;
    }
    if (horizon.horizonSessions !== sessions) fail(`${label}.horizonSessions 必须为${sessions}`);
    if (!["published", "abstained"].includes(horizon.publicationStatus)) fail(`${label}.publicationStatus 非法`);
    if (horizon.primaryTarget !== "topQuartileProbability") fail(`${label}.primaryTarget 必须为topQuartileProbability`);
    for (const target of ["absoluteUp", "outperformance", "topQuartile", "expectedExcess"]) {
      const model = horizon.models?.[target];
      if (!isObject(model) || model.trainingDates !== 504 || model.horizonSessions !== sessions) fail(`${label}.models.${target} 必须是独立504交易日模型`);
    }
    for (const target of ["absoluteUp", "outperformance", "topQuartile"]) {
      const calibration = horizon.calibrations?.[target];
      if (!isObject(calibration) || !isObject(calibration.rawMetrics) || !isObject(calibration.calibratedMetrics)) fail(`${label}.calibrations.${target} 不完整`);
      for (const key of ["brier", "baselineBrier", "brierSkill", "auc"]) {
        if (!Number.isFinite(calibration?.rawMetrics?.[key])) fail(`${label}.calibrations.${target}.rawMetrics.${key} 必须是有限数值`);
      }
    }
    const metrics = horizon.audit?.rankingMetrics;
    for (const key of ["rankIc", "crossSectionSpearman", "topQuartileHitRate", "topBottomSpread", "topBottomSpreadAfterCosts", "predictionCrossSectionStd", "positiveWindowShare"]) {
      if (!Number.isFinite(metrics?.[key])) fail(`${label}.audit.rankingMetrics.${key} 必须是有限数值`);
    }
    if (horizon.audit?.evaluationDates < 100) fail(`${label}.audit.evaluationDates 必须至少100个独立交易日`);
    if (!Array.isArray(horizon.audit?.rankingMetrics?.windows) || !horizon.audit.rankingMetrics.windows.length) fail(`${label} 缺少walk-forward窗口指标`);
    if (horizon.publicationStatus === "abstained" && (!Array.isArray(horizon.abstainReasons) || !horizon.abstainReasons.length)) fail(`${label} 弃权时必须列明原因`);
    if (horizon.publicationStatus === "published" && horizon.audit?.qualityGate?.passed !== true) fail(`${label} 质量闸门未通过不得发布`);
  }
}

if (!isObject(featureSourceRegistry) || featureSourceRegistry.schemaVersion !== 2) {
  fail("行业轮动特征数据源清单缺失或版本错误");
} else {
  if (featureSourceRegistry.policy?.coverage !== "global") fail("重点观察不得把网站改成局部市场覆盖");
  if (featureSourceRegistry.policy?.focusChangesScore !== false) fail("重点观察池不得改变模型评分");
  if (featureSourceRegistry.policy?.nullPolicy !== "preserve-null-never-zero") fail("特征缺失必须保留null，禁止填0");
  const featureIds = new Set((featureSourceRegistry.features ?? []).map((item) => item?.id));
  for (const required of [
    "relative-strength-5-20", "turnover-and-volume-change", "constituent-breadth-above-ma20",
    "etf-subscription-1-3-5", "etf-flow-as-fund-size", "leader-contribution",
    "internal-return-dispersion", "policy-and-news-event-map", "crowding-risk",
    "southbound-flow-1-3-5-20", "southbound-flow-as-hk-turnover", "hk-short-selling-ratio",
    "hk-company-buybacks", "us-2y-treasury", "hibor-overnight-1m", "hk-aggregate-balance",
    "usd-hkd", "usd-cnh", "top5-weight-contribution", "equal-vs-cap-weight-gap",
  ]) {
    if (!featureIds.has(required)) fail(`特征数据源清单缺少 ${required}`);
  }
  const usdCnh = (featureSourceRegistry.features ?? []).find((item) => item?.id === "usd-cnh");
  if (usdCnh?.status !== "source-required" || usdCnh?.primary !== null) fail("USD/CNH 未有合格源时必须保持缺失，禁止用USD/CNY冒充");
}

if (exactKeys(data, ["schemaVersion", "generatedAt", "model", "markets"], "rotation")) {
  if (data.schemaVersion !== 1) fail("rotation.schemaVersion 必须是 1");
  requireIsoShanghai(data.generatedAt, "rotation.generatedAt");

  if (exactKeys(data.model, ["id", "version", "trainedAt", "trainingStart", "trainingEnd", "method", "features", "backtest"], "rotation.model")) {
    requireString(data.model.id, "rotation.model.id", { max: 80 });
    requireString(data.model.version, "rotation.model.version", { max: 40 });
    requireIsoShanghai(data.model.trainedAt, "rotation.model.trainedAt");
    requireDate(data.model.trainingStart, "rotation.model.trainingStart");
    requireDate(data.model.trainingEnd, "rotation.model.trainingEnd");
    if (data.model.trainingEnd < data.model.trainingStart) fail("rotation.model.trainingEnd 不得早于 trainingStart");
    if (Date.parse(data.model.trainedAt) > Date.parse(data.generatedAt)) fail("rotation.model.trainedAt 不得晚于 generatedAt");
    requireString(data.model.method, "rotation.model.method", { max: 1000 });
    if (!Array.isArray(data.model.features) || data.model.features.length < 1 || data.model.features.length > 64) fail("rotation.model.features 必须包含 1–64 个冻结特征名");
    else if (new Set(data.model.features).size !== data.model.features.length) fail("rotation.model.features 不得重复");
    if (exactKeys(data.model.backtest, ["status", "summary"], "rotation.model.backtest")) {
      if (!["passed", "limited", "insufficient"].includes(data.model.backtest.status)) fail("rotation.model.backtest.status 非法");
      requireString(data.model.backtest.summary, "rotation.model.backtest.summary", { max: 1000 });
    }
    for (const key of ["id", "version", "trainedAt", "trainingStart", "trainingEnd"]) {
      if (data.model[key] !== probabilityArtifact?.[key]) fail(`rotation.model.${key} 与上涨概率 artifact 不一致`);
    }
    if (data.model.backtest?.status !== "limited") fail("rotation.model.backtest.status 必须标记为limited，概率质量由逐窗口审计字段表达");
  }

  if (!Array.isArray(data.markets) || data.markets.length !== 3) {
    fail("rotation.markets 必须正好包含 A股、港股、美股三项");
  } else {
    const ids = data.markets.map((market) => market?.id);
    for (const requiredId of ["a-share", "hk", "us"]) {
      if (ids.filter((id) => id === requiredId).length !== 1) fail(`rotation.markets 必须且只能包含一个 ${requiredId}`);
    }
    data.markets.forEach((market, index) => validateMarket(market, `rotation.markets[${index}]`));
    const aShareMarket = data.markets.find((market) => market.id === "a-share");
    const artifactCoverageComplete = modelArtifact?.data?.coverageCount === modelArtifact?.data?.universeCount
      && modelArtifact?.data?.trainingCoverageComplete === true;
    if (!artifactCoverageComplete && [aShareMarket?.horizons?.tomorrow, aShareMarket?.horizons?.oneWeek, aShareMarket?.horizons?.oneMonth].some((horizon) => horizon?.status === "ready")) {
      fail("A股冻结模型训练分类不完整时不得发布预测窗口");
    }
    const dailyMarkets = new Map((dailyBrief?.markets ?? []).map((market) => [market.id, market]));
    data.markets.forEach((market) => {
      if (market.status !== "ready") return;
      const expected = dailyMarkets.get(market.id)?.sessionDate;
      if (!requireDate(expected, `daily-brief.markets.${market.id}.sessionDate`)) return;
      if (market.asOf !== expected || market.horizons.current?.asOf !== expected) fail(`rotation.markets.${market.id} ready 数据必须与日报完整交易日 ${expected} 精确一致`);
      if (market.id === "us") {
        const dates = new Set((dailyMarkets.get("us")?.indices ?? []).map((item) => item.date));
        if (dates.size !== 1 || !dates.has(expected)) fail("美股三大指数必须全部使用同一个日报完整交易日");
      }
    });
    const generatedAtMs = Date.parse(data.generatedAt);
    data.markets.forEach((market) => {
      if (!["a-share", "hk"].includes(market.id) || market.status !== "ready" || Number.isNaN(generatedAtMs)) return;
      const asOfMs = Date.parse(`${market.asOf}T23:59:59+08:00`);
      const ageDays = (generatedAtMs - asOfMs) / 86_400_000;
      if (ageDays > 7) fail(`rotation.markets.${market.id} 当前观测已滞后 ${ageDays.toFixed(1)} 天，必须降级 insufficient`);
      if (ageDays < -1) fail(`rotation.markets.${market.id}.asOf 晚于生成时间`);
    });
  }
}

if (absolutePromisePattern.test(JSON.stringify(data))) fail("sector-rotation.json 含确定性投资措辞");

if (errors.length) {
  console.error(`\n行业轮动数据校验失败（${errors.length} 项）：`);
  errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
  process.exit(1);
}

const readyForecasts = data.markets.reduce((count, market) => count + [market.horizons.tomorrow, market.horizons.oneWeek, market.horizons.oneMonth].filter((horizon) => horizon.status === "ready").length, 0);
console.log(`行业轮动数据校验通过：${data.markets.length} 个市场，${readyForecasts} 个可用预测窗口，文件上限 ${MAX_ROTATION_BYTES / 1024} KB。`);
