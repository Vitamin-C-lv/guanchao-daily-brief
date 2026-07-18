import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const briefPath = path.resolve(process.cwd(), "content", "daily-brief.json");
const errors = [];
const articleIds = new Set();
const sourceEvidenceClasses = [
  "official-primary",
  "company-filing",
  "primary-research",
  "exchange-market-data",
  "vendor-market-data",
  "vendor-estimate",
  "major-media",
];

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
  if (source.evidenceClass !== undefined && !sourceEvidenceClasses.includes(source.evidenceClass)) {
    fail(`${label}.evidenceClass 非法`);
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

function validateChartItems(items, label, { min, max, allowNegative = true } = {}) {
  if (!Array.isArray(items) || items.length < min || items.length > max) {
    fail(`${label} 必须包含 ${min}–${max} 项`);
    return [];
  }

  const labels = new Set();
  items.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isObject(item)) {
      fail(`${itemLabel} 必须是对象`);
      return;
    }
    requireString(item.label, `${itemLabel}.label`, { max: 30 });
    requireString(item.display, `${itemLabel}.display`, { max: 20 });
    if (typeof item.label === "string") {
      if (labels.has(item.label)) fail(`${label} 含重复标签 ${item.label}`);
      labels.add(item.label);
    }
    if (!Number.isFinite(item.value)) fail(`${itemLabel}.value 必须是数值`);
    else if (!allowNegative && item.value < 0) fail(`${itemLabel}.value 不能为负数；有正负方向的数据应使用 diverging-bar`);
    if (!["positive", "negative", "neutral", "warning"].includes(item.tone)) fail(`${itemLabel}.tone 非法`);
  });
  return items.map((item) => item?.label);
}

function validateLegacyChart(chart, sourceCount, label) {
  if (!isObject(chart)) {
    fail(`${label} 必须是对象`);
    return;
  }
  requireString(chart.title, `${label}.title`, { max: 50 });
  requireString(chart.unit, `${label}.unit`, { max: 20 });
  validateChartItems(chart.items, `${label}.items`, { min: 3, max: 6 });
  validateSourceIndexes(chart.sourceIndexes, sourceCount, `${label}.sourceIndexes`);
}

function validateStructuredChart(chart, sourceCount, label) {
  if (!isObject(chart)) {
    fail(`${label} 必须是对象`);
    return;
  }
  if (!["bar", "diverging-bar", "line", "grouped-bar"].includes(chart.type)) {
    fail(`${label}.type 必须是 bar、diverging-bar、line 或 grouped-bar`);
    return;
  }
  requireString(chart.title, `${label}.title`, { max: 50 });
  requireString(chart.unit, `${label}.unit`, { max: 20 });
  requireDate(chart.asOf, `${label}.asOf`);
  if (chart.note !== undefined) requireString(chart.note, `${label}.note`, { max: 140 });
  validateSourceIndexes(chart.sourceIndexes, sourceCount, `${label}.sourceIndexes`);

  if (["bar", "diverging-bar"].includes(chart.type)) {
    if (chart.series !== undefined) fail(`${label}.series 不适用于 ${chart.type}`);
    const items = validateChartItems(chart.items, `${label}.items`, {
      min: 3,
      max: 6,
      allowNegative: chart.type === "diverging-bar",
    });
    if (chart.type === "diverging-bar" && items.length && chart.items.every((item) => isObject(item) && item.value === 0)) {
      fail(`${label}.items 不能全部为零`);
    }
    return;
  }

  if (chart.items !== undefined) fail(`${label}.items 不适用于 ${chart.type}，应使用 series`);
  const seriesMin = chart.type === "line" ? 1 : 2;
  const seriesMax = chart.type === "line" ? 2 : 3;
  if (!Array.isArray(chart.series) || chart.series.length < seriesMin || chart.series.length > seriesMax) {
    fail(`${label}.series 在 ${chart.type} 下必须包含 ${seriesMin}–${seriesMax} 条系列`);
    return;
  }

  const seriesNames = new Set();
  let referenceLabels;
  chart.series.forEach((series, index) => {
    const seriesLabel = `${label}.series[${index}]`;
    if (!isObject(series)) {
      fail(`${seriesLabel} 必须是对象`);
      return;
    }
    requireString(series.name, `${seriesLabel}.name`, { max: 30 });
    if (typeof series.name === "string") {
      if (seriesNames.has(series.name)) fail(`${label}.series 含重复名称 ${series.name}`);
      seriesNames.add(series.name);
    }
    if (!["positive", "negative", "neutral", "warning"].includes(series.tone)) fail(`${seriesLabel}.tone 非法`);
    if (!["observed", "institution-forecast"].includes(series.kind)) fail(`${seriesLabel}.kind 必须是 observed 或 institution-forecast`);
    if (series.kind === "institution-forecast" && (typeof chart.note !== "string" || !chart.note.trim())) {
      fail(`${seriesLabel} 是机构预测，${label}.note 必须说明预测机构和口径`);
    }
    const labels = validateChartItems(series.items, `${seriesLabel}.items`, {
      min: chart.type === "line" ? 4 : 2,
      max: chart.type === "line" ? 12 : 5,
      allowNegative: chart.type === "line",
    });
    if (referenceLabels === undefined) referenceLabels = labels;
    else if (labels.join("\u0000") !== referenceLabels.join("\u0000")) fail(`${seriesLabel}.items 标签及顺序必须与第一条系列一致`);
  });
}

function validateEditorialVisual(visual, sourceCount, label) {
  if (!isObject(visual)) {
    fail(`${label} 必须是对象`);
    return;
  }
  if (visual.kind !== "ai-editorial-illustration") fail(`${label}.kind 必须是 ai-editorial-illustration`);
  requireString(visual.src, `${label}.src`, { max: 500 });
  if (typeof visual.src === "string" && !visual.src.startsWith("/generated/editorial/")) fail(`${label}.src 必须位于 /generated/editorial/`);
  if (typeof visual.src === "string" && visual.src.startsWith("data:")) fail(`${label}.src 不允许内嵌 data URL`);
  if (visual.width !== 1200 || visual.height !== 675) fail(`${label}.width/height 必须是 1200/675`);
  if (!Number.isInteger(visual.bytes) || visual.bytes < 1) fail(`${label}.bytes 必须是正整数`);
  if (typeof visual.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(visual.sha256)) fail(`${label}.sha256 必须是 64 位小写十六进制`);
  if (visual.generator !== "openai-image") fail(`${label}.generator 必须是 openai-image`);
  requireString(visual.generatedAt, `${label}.generatedAt`);
  if (typeof visual.generatedAt === "string" && Number.isNaN(Date.parse(visual.generatedAt))) fail(`${label}.generatedAt 必须是有效 ISO 时间`);
  if (visual.quality !== undefined && (!Number.isInteger(visual.quality) || visual.quality < 1 || visual.quality > 100)) fail(`${label}.quality 必须是 1–100 的整数`);
  requireString(visual.alt, `${label}.alt`, { max: 120 });
  requireString(visual.caption, `${label}.caption`, { max: 140 });
  validateSourceIndexes(visual.basisSourceIndexes, sourceCount, `${label}.basisSourceIndexes`);
}

function validateEvidenceForecast(forecast, sourceCount, label) {
  if (!isObject(forecast)) {
    fail(`${label} 必须是对象`);
    return;
  }
  requireString(forecast.id, `${label}.id`, { max: 80 });
  if (typeof forecast.id === "string" && !/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(forecast.id)) fail(`${label}.id 必须是稳定的字母数字标识`);
  requireDate(forecast.asOf, `${label}.asOf`);
  requireDate(forecast.dueDate, `${label}.dueDate`);
  if (typeof forecast.asOf === "string" && typeof forecast.dueDate === "string" && forecast.dueDate < forecast.asOf) fail(`${label}.dueDate 不得早于 asOf`);
  requireString(forecast.title, `${label}.title`, { max: 60 });
  if (!["1_5d", "2_4w", "3_12m"].includes(forecast.horizon)) fail(`${label}.horizon 非法`);
  if (!["upside", "range", "downside", "mixed"].includes(forecast.direction)) fail(`${label}.direction 非法`);
  if (!["low", "medium", "medium-high"].includes(forecast.confidence)) fail(`${label}.confidence 非法`);
  requireString(forecast.claim, `${label}.claim`, { max: 260 });
  requireString(forecast.trigger, `${label}.trigger`, { max: 180 });
  requireString(forecast.invalidation, `${label}.invalidation`, { max: 180 });
  requireString(forecast.riskNote, `${label}.riskNote`, { max: 220 });

  const citedSources = new Set();
  if (!Array.isArray(forecast.evidence) || forecast.evidence.length < 2 || forecast.evidence.length > 4) {
    fail(`${label}.evidence 必须包含 2–4 条证据`);
  } else {
    forecast.evidence.forEach((item, index) => {
      const itemLabel = `${label}.evidence[${index}]`;
      if (!isObject(item)) {
        fail(`${itemLabel} 必须是对象`);
        return;
      }
      requireString(item.label, `${itemLabel}.label`, { max: 40 });
      requireString(item.observation, `${itemLabel}.observation`, { max: 220 });
      validateSourceIndexes(item.sourceIndexes, sourceCount, `${itemLabel}.sourceIndexes`);
      if (Array.isArray(item.sourceIndexes)) item.sourceIndexes.forEach((sourceIndex) => citedSources.add(sourceIndex));
    });
  }
  if (citedSources.size < 2) fail(`${label} 至少需要 2 个不同引用源支撑`);

  if (!Array.isArray(forecast.counterEvidence) || forecast.counterEvidence.length < 1 || forecast.counterEvidence.length > 3) {
    fail(`${label}.counterEvidence 必须包含 1–3 条反证`);
  } else {
    forecast.counterEvidence.forEach((item, index) => {
      const itemLabel = `${label}.counterEvidence[${index}]`;
      if (!isObject(item)) {
        fail(`${itemLabel} 必须是对象`);
        return;
      }
      requireString(item.label, `${itemLabel}.label`, { max: 40 });
      requireString(item.observation, `${itemLabel}.observation`, { max: 220 });
      validateSourceIndexes(item.sourceIndexes, sourceCount, `${itemLabel}.sourceIndexes`);
    });
  }

  if (forecast.review !== undefined) {
    if (!isObject(forecast.review)) fail(`${label}.review 必须是对象`);
    else {
      if (!["pending", "confirmed", "partial", "invalidated"].includes(forecast.review.status)) fail(`${label}.review.status 非法`);
      if (forecast.review.reviewedAt !== undefined) {
        requireString(forecast.review.reviewedAt, `${label}.review.reviewedAt`);
        if (typeof forecast.review.reviewedAt === "string" && Number.isNaN(Date.parse(forecast.review.reviewedAt))) fail(`${label}.review.reviewedAt 必须是有效时间`);
      }
      requireString(forecast.review.note, `${label}.review.note`, { max: 220 });
    }
  }

  const forecastText = [
    forecast.claim,
    ...(Array.isArray(forecast.evidence) ? forecast.evidence.map((item) => item?.observation ?? "") : []),
    ...(Array.isArray(forecast.counterEvidence) ? forecast.counterEvidence.map((item) => item?.observation ?? "") : []),
    forecast.trigger,
    forecast.invalidation,
    forecast.riskNote,
    forecast.review?.note ?? "",
  ].join("");
  const absolutePromisePattern = /必涨|稳赚|稳赢|保证收益|保本收益|无风险收益|只涨不跌|确定(?:上涨|获利|流入)|一定(?:上涨|获利|流入)|必然(?:上涨|获利|流入)|百分之百(?:上涨|获利|流入)|100%\s*(?:上涨|获利|流入)|主力(?:已)?锁定|明确买入|放心买入/;
  if (absolutePromisePattern.test(forecastText)) fail(`${label} 含有绝对承诺或确定性投资措辞`);
}

function validateEvidenceForecasts(value, sourceCount, label) {
  const forecasts = Array.isArray(value) ? value : [value];
  if (Array.isArray(value) && (value.length < 1 || value.length > 3)) {
    fail(`${label} 数组必须包含 1–3 个预测窗口`);
  }

  const ids = new Set();
  forecasts.forEach((forecast, index) => {
    const forecastLabel = Array.isArray(value) ? `${label}[${index}]` : label;
    validateEvidenceForecast(forecast, sourceCount, forecastLabel);
    if (isObject(forecast) && typeof forecast.id === "string") {
      if (ids.has(forecast.id)) fail(`${label} 含重复预测 id ${forecast.id}`);
      ids.add(forecast.id);
    }
  });
}

function validateRotationAnalysis(rotation, sourceCount, label, sessionDate) {
  if (!isObject(rotation)) {
    fail(`${label} 必须是对象`);
    return;
  }

  requireDate(rotation.asOf, `${label}.asOf`);
  if (typeof rotation.asOf === "string" && typeof sessionDate === "string" && rotation.asOf !== sessionDate) {
    fail(`${label}.asOf 必须与市场 sessionDate ${sessionDate} 一致`);
  }
  if (rotation.window !== "5d_vs_20d") fail(`${label}.window 必须是 5d_vs_20d`);
  requireString(rotation.regime, `${label}.regime`, { max: 180 });

  const validVolumeStatuses = ["verified", "none", "insufficient"];
  if (!validVolumeStatuses.includes(rotation.volumeStatus)) {
    fail(`${label}.volumeStatus 必须是 verified、none 或 insufficient`);
  }

  if (!Array.isArray(rotation.volumeLeaders)) {
    fail(`${label}.volumeLeaders 必须是数组`);
  } else {
    if (rotation.volumeStatus === "verified" && (rotation.volumeLeaders.length < 1 || rotation.volumeLeaders.length > 4)) {
      fail(`${label}.volumeLeaders 在 verified 状态下必须包含 1–4 个板块`);
    }
    if (["none", "insufficient"].includes(rotation.volumeStatus) && rotation.volumeLeaders.length !== 0) {
      fail(`${label}.volumeLeaders 在 ${rotation.volumeStatus} 状态下必须为空`);
    }

    const sectors = new Set();
    rotation.volumeLeaders.forEach((item, index) => {
      const itemLabel = `${label}.volumeLeaders[${index}]`;
      if (!isObject(item)) {
        fail(`${itemLabel} 必须是对象`);
        return;
      }
      requireString(item.sector, `${itemLabel}.sector`, { max: 30 });
      if (typeof item.sector === "string") {
        if (sectors.has(item.sector)) fail(`${label}.volumeLeaders 含重复板块 ${item.sector}`);
        sectors.add(item.sector);
      }
      if (!["early", "accelerating", "diverging", "fading", "rebound"].includes(item.stage)) {
        fail(`${itemLabel}.stage 非法`);
      }
      if (!Number.isFinite(item.turnoverAmountRatio20d) || item.turnoverAmountRatio20d < 1.35) {
        fail(`${itemLabel}.turnoverAmountRatio20d 必须是大于或等于 1.35 的数值`);
      }
      if (!Number.isFinite(item.tradingVolumeRatio20d) || item.tradingVolumeRatio20d < 1.2) {
        fail(`${itemLabel}.tradingVolumeRatio20d 必须是大于或等于 1.20 的数值`);
      }
      if (!Number.isFinite(item.turnoverShareRatio20d) || item.turnoverShareRatio20d < 1.15) {
        fail(`${itemLabel}.turnoverShareRatio20d 必须是大于或等于 1.15 的数值`);
      }
      if (!Number.isInteger(item.historySessions) || item.historySessions < 25) {
        fail(`${itemLabel}.historySessions 必须是大于或等于 25 的完整交易日数`);
      }
      if (!Number.isFinite(item.breadthPct) || item.breadthPct < 0 || item.breadthPct > 100) {
        fail(`${itemLabel}.breadthPct 必须是 0–100 的数值`);
      }
      if (!Number.isFinite(item.top3ConcentrationPct) || item.top3ConcentrationPct < 0 || item.top3ConcentrationPct > 100) {
        fail(`${itemLabel}.top3ConcentrationPct 必须是 0–100 的数值`);
      }
      if (!Number.isFinite(item.relativeReturn5d)) {
        fail(`${itemLabel}.relativeReturn5d 必须是数值`);
      }
      validateSourceIndexes(item.sourceIndexes, sourceCount, `${itemLabel}.sourceIndexes`);
    });
  }

  if (!Array.isArray(rotation.flowSignals) || rotation.flowSignals.length < 1 || rotation.flowSignals.length > 4) {
    fail(`${label}.flowSignals 必须包含 1–4 条资金线索`);
  } else {
    rotation.flowSignals.forEach((signal, index) => {
      const signalLabel = `${label}.flowSignals[${index}]`;
      if (!isObject(signal)) {
        fail(`${signalLabel} 必须是对象`);
        return;
      }
      requireString(signal.sector, `${signalLabel}.sector`, { max: 30 });
      if (!["inflow", "outflow", "mixed"].includes(signal.direction)) {
        fail(`${signalLabel}.direction 必须是 inflow、outflow 或 mixed`);
      }
      if (!["official", "vendor-market-data", "vendor-estimate", "proxy"].includes(signal.evidenceClass)) {
        fail(`${signalLabel}.evidenceClass 必须是 official、vendor-market-data、vendor-estimate 或 proxy`);
      }
      requireString(signal.evidence, `${signalLabel}.evidence`, { max: 220 });
      validateSourceIndexes(signal.sourceIndexes, sourceCount, `${signalLabel}.sourceIndexes`);
    });
  }

  if (!Array.isArray(rotation.outlooks) || rotation.outlooks.length !== 2) {
    fail(`${label}.outlooks 必须正好包含 1_5d 和 2_4w 两个周期`);
  } else {
    const horizons = new Set();
    rotation.outlooks.forEach((outlook, index) => {
      const outlookLabel = `${label}.outlooks[${index}]`;
      if (!isObject(outlook)) {
        fail(`${outlookLabel} 必须是对象`);
        return;
      }
      if (!["1_5d", "2_4w"].includes(outlook.horizon)) {
        fail(`${outlookLabel}.horizon 必须是 1_5d 或 2_4w`);
      } else {
        if (horizons.has(outlook.horizon)) fail(`${label}.outlooks 含重复周期 ${outlook.horizon}`);
        horizons.add(outlook.horizon);
      }
      const outlookStatus = outlook.status ?? "active";
      if (!["active", "insufficient"].includes(outlookStatus)) {
        fail(`${outlookLabel}.status 必须是 active 或 insufficient`);
      }
      const candidateSectorsRequired = outlookStatus === "active";
      const hasCandidateSectors = Array.isArray(outlook.candidateSectors);
      if (candidateSectorsRequired && (!hasCandidateSectors || outlook.candidateSectors.length < 1 || outlook.candidateSectors.length > 4)) {
        fail(`${outlookLabel}.candidateSectors 在 active 状态下必须包含 1–4 个板块`);
      } else if (!candidateSectorsRequired && outlook.candidateSectors !== undefined && !hasCandidateSectors) {
        fail(`${outlookLabel}.candidateSectors 在 insufficient 状态下若提供则必须是数组`);
      } else if (hasCandidateSectors && outlook.candidateSectors.length > 4) {
        fail(`${outlookLabel}.candidateSectors 最多包含 4 个板块`);
      } else if (hasCandidateSectors) {
        const candidateSectors = new Set();
        outlook.candidateSectors.forEach((sector, sectorIndex) => {
          requireString(sector, `${outlookLabel}.candidateSectors[${sectorIndex}]`, { max: 30 });
          if (typeof sector === "string") {
            if (candidateSectors.has(sector)) fail(`${outlookLabel}.candidateSectors 含重复板块 ${sector}`);
            candidateSectors.add(sector);
          }
        });
      }
      if (outlookStatus === "insufficient") {
        requireString(outlook.reason, `${outlookLabel}.reason`, { max: 220 });
      } else if (outlook.reason !== undefined) {
        requireString(outlook.reason, `${outlookLabel}.reason`, { max: 220 });
      }
      if (!["strengthening", "range", "weakening"].includes(outlook.bias)) {
        fail(`${outlookLabel}.bias 必须是 strengthening、range 或 weakening`);
      }
      if (!["low", "medium", "medium-high"].includes(outlook.confidence)) {
        fail(`${outlookLabel}.confidence 必须是 low、medium 或 medium-high`);
      }
      requireString(outlook.flowPath, `${outlookLabel}.flowPath`, { max: 240 });
      requireString(outlook.trigger, `${outlookLabel}.trigger`, { max: 160 });
      requireString(outlook.invalidation, `${outlookLabel}.invalidation`, { max: 160 });
      validateSourceIndexes(outlook.sourceIndexes, sourceCount, `${outlookLabel}.sourceIndexes`);
    });
    if (!horizons.has("1_5d") || !horizons.has("2_4w")) {
      fail(`${label}.outlooks 必须各有一个 1_5d 与 2_4w 周期`);
    }
  }

  requireString(rotation.riskNote, `${label}.riskNote`, { max: 220 });

  const rotationText = [
    rotation.regime ?? "",
    ...(Array.isArray(rotation.flowSignals) ? rotation.flowSignals.map((item) => item?.evidence ?? "") : []),
    ...(Array.isArray(rotation.outlooks) ? rotation.outlooks.flatMap((item) => [item?.reason ?? "", item?.flowPath ?? "", item?.trigger ?? "", item?.invalidation ?? ""]) : []),
    rotation.riskNote ?? "",
  ].join("");
  const absolutePromisePattern = /必涨|稳赚|稳赢|保证收益|保本收益|无风险收益|只涨不跌|确定(?:上涨|获利|流入)|一定(?:上涨|获利|流入)|必然(?:上涨|获利|流入)|百分之百(?:上涨|获利|流入)|100%\s*(?:上涨|获利|流入)|主力(?:已)?锁定|明确买入|放心买入/;
  if (absolutePromisePattern.test(rotationText)) {
    fail(`${label} 含有绝对承诺或确定性投资措辞`);
  }
}

function validateArticleDetail(detail, sourceCount, label, { requireRotation = false, sessionDate } = {}) {
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
    validateLegacyChart(detail.chart, sourceCount, `${label}.chart`);
  }
  if (detail.charts !== undefined) {
    if (!Array.isArray(detail.charts) || detail.charts.length < 1 || detail.charts.length > 3) {
      fail(`${label}.charts 必须包含 1–3 张结构化图表`);
    } else {
      detail.charts.forEach((chart, index) => validateStructuredChart(chart, sourceCount, `${label}.charts[${index}]`));
    }
  }
  if (detail.chart !== undefined && detail.charts !== undefined) {
    fail(`${label} 不能同时写 legacy chart 与 charts`);
  }

  if (detail.visual !== undefined) validateEditorialVisual(detail.visual, sourceCount, `${label}.visual`);
  if (detail.evidenceForecast !== undefined) validateEvidenceForecasts(detail.evidenceForecast, sourceCount, `${label}.evidenceForecast`);

  if (detail.rotationAnalysis === undefined) {
    if (requireRotation) fail(`${label}.rotationAnalysis 是 A股和港股文章的必填项`);
  } else {
    validateRotationAnalysis(detail.rotationAnalysis, sourceCount, `${label}.rotationAnalysis`, sessionDate);
  }

  const characterCount = [
    detail.lead ?? "",
    ...(Array.isArray(detail.keyPoints) ? detail.keyPoints : []),
    ...(Array.isArray(detail.sections) ? detail.sections.flatMap((section) => [section?.heading ?? "", section?.body ?? ""]) : []),
    ...(isObject(detail.rotationAnalysis) ? [
      detail.rotationAnalysis.regime ?? "",
      ...(Array.isArray(detail.rotationAnalysis.volumeLeaders) ? detail.rotationAnalysis.volumeLeaders.map((item) => item?.sector ?? "") : []),
      ...(Array.isArray(detail.rotationAnalysis.flowSignals) ? detail.rotationAnalysis.flowSignals.flatMap((item) => [item?.sector ?? "", item?.evidence ?? ""]) : []),
      ...(Array.isArray(detail.rotationAnalysis.outlooks) ? detail.rotationAnalysis.outlooks.flatMap((item) => [
        item?.horizon ?? "",
        ...(Array.isArray(item?.candidateSectors) ? item.candidateSectors : []),
        item?.reason ?? "",
        item?.flowPath ?? "",
        item?.trigger ?? "",
        item?.invalidation ?? "",
      ]) : []),
      detail.rotationAnalysis.riskNote ?? "",
    ] : []),
    ...(
      Array.isArray(detail.evidenceForecast)
        ? detail.evidenceForecast
        : isObject(detail.evidenceForecast)
          ? [detail.evidenceForecast]
          : []
    ).flatMap((forecast) => [
      forecast?.title ?? "",
      forecast?.claim ?? "",
      ...(Array.isArray(forecast?.evidence) ? forecast.evidence.flatMap((item) => [item?.label ?? "", item?.observation ?? ""]) : []),
      ...(Array.isArray(forecast?.counterEvidence) ? forecast.counterEvidence.flatMap((item) => [item?.label ?? "", item?.observation ?? ""]) : []),
      forecast?.trigger ?? "",
      forecast?.invalidation ?? "",
      forecast?.riskNote ?? "",
      forecast?.review?.note ?? "",
    ]),
  ].join("").replace(/\s/g, "").length;
  if (characterCount < 450) fail(`${label} 正文仅 ${characterCount} 字，低于 450 字`);
  if (characterCount > 1000) fail(`${label} 正文 ${characterCount} 字，超过 1000 字硬上限`);
}

function validateArticle(article, label, options = {}) {
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
  validateArticleDetail(article.detail, Array.isArray(article.sources) ? article.sources.length : 0, `${label}.detail`, options);
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
    else market.articles.forEach((article, index) => validateArticle(article, `${label}.articles[${index}]`, {
      requireRotation: market.id === "a-share" || market.id === "hk",
      sessionDate: market.sessionDate,
    }));
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
else data.sourceDirectory.forEach((source, index) => {
  if (source?.evidenceClass !== undefined && !sourceEvidenceClasses.includes(source.evidenceClass)) {
    fail(`sourceDirectory[${index}].evidenceClass 非法`);
  }
});
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
