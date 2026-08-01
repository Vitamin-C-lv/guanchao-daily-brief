import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleFile = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(moduleFile), "..");

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function countOccurrences(text, phrase) {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(phrase, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(phrase.length, 1);
  }
  return count;
}

function countOccurrencesInsensitive(text, phrase) {
  return countOccurrences(text.toLocaleLowerCase("en-US"), phrase.toLocaleLowerCase("en-US"));
}

function maxConsecutiveTrue(values) {
  let current = 0;
  let maximum = 0;
  for (const value of values) {
    if (value) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else current = 0;
  }
  return maximum;
}

function pushText(target, value) {
  if (typeof value === "string" && value.trim()) target.push(value.trim());
}

function pushArticle(target, article) {
  if (!object(article)) return;
  for (const key of ["title", "summary", "impact"]) pushText(target, article[key]);
  const detail = article.detail;
  if (!object(detail)) return;
  for (const key of ["lead"]) pushText(target, detail[key]);
  for (const value of detail.keyPoints ?? []) pushText(target, value);
  for (const section of detail.sections ?? []) {
    if (!object(section)) continue;
    pushText(target, section.heading);
    pushText(target, section.body);
  }
  const rotation = detail.rotationAnalysis;
  if (object(rotation)) {
    for (const key of ["regime", "riskNote"]) pushText(target, rotation[key]);
    for (const item of rotation.flowSignals ?? []) if (object(item)) pushText(target, item.evidence);
    for (const item of rotation.outlooks ?? []) {
      if (!object(item)) continue;
      for (const key of ["reason", "flowPath", "trigger", "invalidation"]) pushText(target, item[key]);
    }
  }
  for (const forecast of Array.isArray(detail.evidenceForecast) ? detail.evidenceForecast : detail.evidenceForecast ? [detail.evidenceForecast] : []) {
    if (!object(forecast)) continue;
    for (const key of ["title", "claim", "trigger", "invalidation", "riskNote"]) pushText(target, forecast[key]);
    for (const item of [...(forecast.evidence ?? []), ...(forecast.counterEvidence ?? [])]) if (object(item)) pushText(target, item.observation);
  }
}

function visibleParagraphs(edition, payload) {
  const paragraphs = [];
  if (edition === "daily") {
    const meta = payload.meta ?? {};
    pushText(paragraphs, meta.title);
    pushText(paragraphs, meta.subtitle);
    const pulse = payload.pulse ?? {};
    pushText(paragraphs, pulse.label);
    pushText(paragraphs, pulse.explanation);
    const fed = payload.federalReserve ?? {};
    pushText(paragraphs, fed.takeaway);
    for (const article of fed.articles ?? []) pushArticle(paragraphs, article);
    for (const market of payload.markets ?? []) {
      pushText(paragraphs, market.name);
      pushText(paragraphs, market.summary);
      for (const article of market.articles ?? []) pushArticle(paragraphs, article);
    }
    for (const article of payload.hotspots ?? []) pushArticle(paragraphs, article);
    for (const item of payload.watchlist ?? []) {
      if (!object(item)) continue;
      pushText(paragraphs, item.title);
      pushText(paragraphs, item.note);
    }
  } else {
    const report = payload.report ?? {};
    pushText(paragraphs, report.title);
    pushText(paragraphs, report.subtitle);
    const summary = payload.executiveSummary ?? {};
    pushText(paragraphs, summary.weekVerdict);
    for (const item of summary.keyTakeaways ?? []) {
      if (!object(item)) continue;
      pushText(paragraphs, item.title);
      pushText(paragraphs, item.summary);
    }
    for (const event of payload.majorEvents ?? []) {
      if (!object(event)) continue;
      pushText(paragraphs, event.title);
      pushText(paragraphs, event.whyItMatters);
      for (const fact of event.facts ?? []) if (object(fact)) pushText(paragraphs, fact.text);
    }
    for (const insight of payload.highValueInsights ?? []) {
      if (!object(insight)) continue;
      for (const key of ["title", "insight", "whyHighValue", "watchNext"]) pushText(paragraphs, insight[key]);
      for (const fact of [...(insight.evidence ?? []), ...(insight.counterEvidence ?? [])]) if (object(fact)) pushText(paragraphs, fact.text);
    }
    for (const market of payload.markets ?? []) {
      if (!object(market)) continue;
      for (const key of ["label", "summary", "weeklyPerformance", "rotation", "capitalFlow", "nextWeekScenario", "trigger", "invalidation"]) pushText(paragraphs, market[key]);
    }
    for (const theme of payload.crossMarketThemes ?? []) {
      if (!object(theme)) continue;
      for (const key of ["title", "thesis", "counterEvidence", "nextSignal"]) pushText(paragraphs, theme[key]);
      for (const step of theme.causalChain ?? []) pushText(paragraphs, step);
    }
    for (const item of payload.nextWeekCalendar ?? []) {
      if (!object(item)) continue;
      for (const key of ["title", "whyWatch"]) pushText(paragraphs, item[key]);
    }
  }
  return paragraphs;
}

function sentenceList(text) {
  return text.split(/[。！？!?；;\n]+/u).map((item) => item.trim()).filter(Boolean);
}

function numericTokens(text) {
  return [...new Set((text.match(/(?<!\d)\d+(?:\.\d+)?%?/gu) ?? []).filter((token) => !/^20\d{2}$/.test(token)))];
}

function titleFor(edition, payload) {
  return edition === "daily" ? payload.meta?.title ?? "" : payload.report?.title ?? "";
}

function firstJudgement(edition, payload) {
  if (edition === "daily") return [payload.meta?.title, payload.pulse?.label, payload.pulse?.explanation].filter(Boolean).join("。 ");
  return [payload.report?.title, payload.executiveSummary?.weekVerdict].filter(Boolean).join("。 ");
}

function bindingPass(result, body) {
  if (!object(result)) return false;
  const bindings = result.claimBindings;
  if (!object(bindings)) return false;
  const all = [...(bindings.quantitative ?? []), ...(bindings.qualitative ?? []), ...(bindings.sourceMetadata ?? [])];
  if (!all.length || all.some((item) => !object(item) || typeof item.claimPath !== "string" || typeof item.claimText !== "string")) return false;
  const claimText = all.map((item) => item.claimText).join("\n");
  // writer-jobs already proves every changed primitive path and its numeric
  // binding.  The editorial lint only needs one numeric lineage witness here;
  // unchanged baseline fields may contain many unrelated numbers.
  const numbers = numericTokens(body);
  return !numbers.length || numericTokens(claimText).some((token) => numbers.includes(token));
}

function sourceCoverage(payload, edition) {
  const articles = edition === "daily"
    ? [...(payload.federalReserve?.articles ?? []), ...(payload.markets ?? []).flatMap((market) => market.articles ?? []), ...(payload.hotspots ?? [])]
    : [];
  if (edition === "weekly") {
    const sources = payload.sources ?? [];
    return sources.length > 0 && (payload.executiveSummary?.keyTakeaways ?? []).every((item) => (item.sourceIds ?? []).length > 0);
  }
  return articles.length > 0 && articles.every((article) => Array.isArray(article.sources) && article.sources.length > 0);
}

function latestWeeklyReportInput(root) {
  const indexPath = path.join(root, "content", "weekly-reports", "index.json");
  if (!fs.existsSync(indexPath)) return path.join(root, "content", "weekly-reports", "weekly-2026-W29.json");
  const index = readJson(indexPath);
  const reportId = index.latestReportId ?? index.reports?.[0]?.id;
  return typeof reportId === "string"
    ? path.join(root, "content", "weekly-reports", `${reportId}.json`)
    : path.join(root, "content", "weekly-reports", "weekly-2026-W29.json");
}

export function loadEditorialStyle(root = repositoryRoot) {
  return readJson(path.join(root, "config", "editorial-style.json"));
}

export function lintEditorial({ edition, value, style = loadEditorialStyle(), result = null } = {}) {
  if (!['daily', 'weekly'].includes(edition)) throw new Error("edition must be daily or weekly");
  const payload = result?.payload ?? value;
  if (!object(payload)) throw new Error("editorial payload must be an object");
  const paragraphs = visibleParagraphs(edition, payload);
  const body = paragraphs.join("\n");
  const sentences = sentenceList(body);
  const title = titleFor(edition, payload);
  const limit = style.limits[edition];
  const defensivePhraseCounts = Object.fromEntries(style.defensivePhrases.map((phrase) => [phrase, countOccurrences(body, phrase)]));
  const defensivePhraseCount = Object.values(defensivePhraseCounts).reduce((sum, count) => sum + count, 0);
  const duplicateDisclaimerCount = Object.values(defensivePhraseCounts).reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const emptyWatchPhraseCount = style.emptyWatchPhrases.reduce((sum, phrase) => sum + countOccurrences(body, phrase), 0);
  const readerFacingTechnicalTerms = style.readerFacingTechnicalTerms ?? [];
  const readerFacingTechnicalTermCounts = Object.fromEntries(readerFacingTechnicalTerms.map((term) => [term, countOccurrencesInsensitive(body, term)]));
  const readerFacingTechnicalTermCount = Object.values(readerFacingTechnicalTermCounts).reduce((sum, count) => sum + count, 0);
  const forbiddenTitlePhrases = style.forbiddenTitlePhrases ?? [];
  const forbiddenTitlePhraseCounts = Object.fromEntries(forbiddenTitlePhrases.map((phrase) => [phrase, countOccurrences(title, phrase)]));
  const forbiddenTitlePhraseCount = Object.values(forbiddenTitlePhraseCounts).reduce((sum, count) => sum + count, 0);
  const dataLimitationPhrases = style.dataLimitationPhrases ?? [];
  const dataLimitationFlags = paragraphs.map((paragraph) => dataLimitationPhrases.some((phrase) => countOccurrences(paragraph, phrase) > 0));
  const dataLimitationParagraphCount = dataLimitationFlags.filter(Boolean).length;
  const dataLimitationCharacterCount = paragraphs.reduce((sum, paragraph, index) => sum + (dataLimitationFlags[index] ? [...paragraph].length : 0), 0);
  const bodyCharacterCount = [...body].length;
  const dataLimitationRatio = Number((dataLimitationCharacterCount / Math.max(bodyCharacterCount, 1)).toFixed(4));
  const maxConsecutiveDataLimitationParagraphs = maxConsecutiveTrue(dataLimitationFlags);
  const missingExplanationLabels = style.marketMissingExplanationLabels ?? {};
  const missingExplanationCounts = Object.fromEntries(Object.entries(missingExplanationLabels).map(([market, labels]) => [
    market,
    dataLimitationFlags.reduce((sum, isLimitation, index) => {
      if (!isLimitation) return sum;
      const paragraph = paragraphs[index];
      return sum + (labels.some((label) => paragraph.includes(label)) ? 1 : 0);
    }, 0)
  ]));
  const maxMissingExplanationsPerMarket = style.maxMissingExplanationsPerMarket ?? Infinity;
  const missingExplanationPass = Object.values(missingExplanationCounts).every((count) => count <= maxMissingExplanationsPerMarket);
  const consecutiveDataLimitationPass = maxConsecutiveDataLimitationParagraphs <= (style.maxConsecutiveDataLimitationParagraphs ?? Infinity);
  const dataLimitationRatioPass = dataLimitationRatio <= (style.maxDataLimitationRatio ?? Infinity);
  const readerFacingTechnicalTermPass = readerFacingTechnicalTermCount <= (style.maxReaderFacingTechnicalTerms ?? Infinity);
  const titleForbiddenPhrasePass = forbiddenTitlePhraseCount === 0;
  const hedgeRegex = new RegExp(style.hedgeWords.join("|"), "u");
  let consecutiveHedgeSentences = 0;
  let maxConsecutiveHedgeSentences = 0;
  for (const sentence of sentences) {
    if (hedgeRegex.test(sentence)) {
      consecutiveHedgeSentences += 1;
      maxConsecutiveHedgeSentences = Math.max(maxConsecutiveHedgeSentences, consecutiveHedgeSentences);
    } else consecutiveHedgeSentences = 0;
  }
  const normalizedSentences = sentences.map((sentence) => sentence.replace(/[“”"'「」]/gu, "").replace(/\s+/gu, "")).filter((sentence) => sentence.length >= 16);
  const sentenceCounts = new Map();
  for (const sentence of normalizedSentences) sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
  const duplicateFactCount = [...sentenceCounts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  const averageSentenceLength = sentences.length ? Number((sentences.reduce((sum, sentence) => sum + [...sentence].length, 0) / sentences.length).toFixed(2)) : 0;
  const longSentenceCount = sentences.filter((sentence) => [...sentence].length > style.limits.maxSentenceCharacters).length;
  const genericTitle = style.genericTitles.some((candidate) => title.trim() === candidate || title.includes(candidate));
  const lastSentence = sentences.at(-1) ?? "";
  const genericEnding = style.emptyWatchPhrases.some((phrase) => lastSentence.includes(phrase)) || /^(?:总之|综上|总体而言|以上)[，。]/u.test(lastSentence);
  const tradingInstructionCount = style.tradingInstructionPatterns.reduce((sum, source) => {
    try {
      return sum + (body.match(new RegExp(source, "gu")) ?? []).length;
    } catch {
      return sum;
    }
  }, 0);
  const tradingInstructionPass = !/(?:建议|应该|应当|可以|适合|不妨)[，、 ]*(?:买入|卖出|加仓|减仓|做多|做空|建仓|止损)|(?:买入|卖出|加仓|减仓|做多|做空|建仓|止损)[^，。；\n]{0,8}(?:股票|个股|板块|仓位|机会)/u.test(body);
  const strongClaimCount = style.strongClaimPatterns.reduce((sum, phrase) => sum + countOccurrences(body, phrase), 0);
  const governanceLeakageCount = style.governanceLeakage.reduce((sum, phrase) => sum + countOccurrences(body, phrase), 0);
  const conclusionFirstPass = !genericTitle && title.trim().length >= 8 && firstJudgement(edition, payload).length >= 18 && firstJudgement(edition, payload).slice(0, 120).includes(title.trim().slice(0, Math.min(8, title.trim().length)));
  const evidenceBindingPass = result ? bindingPass(result, body) : sourceCoverage(payload, edition);
  let directnessScore = 100;
  directnessScore -= Math.min(20, Math.max(0, defensivePhraseCount - limit.defensivePhraseCount) * 8);
  directnessScore -= duplicateDisclaimerCount * 10;
  directnessScore -= emptyWatchPhraseCount * 8;
  directnessScore -= Math.max(0, maxConsecutiveHedgeSentences - style.limits.maxConsecutiveHedgeSentences) * 5;
  directnessScore -= Math.min(15, longSentenceCount * 2);
  directnessScore -= duplicateFactCount * 5;
  if (genericTitle) directnessScore -= 12;
  if (genericEnding) directnessScore -= 10;
  directnessScore -= strongClaimCount * 15;
  directnessScore -= tradingInstructionCount * 20;
  directnessScore -= governanceLeakageCount * 12;
  if (!readerFacingTechnicalTermPass) directnessScore -= 10;
  if (!titleForbiddenPhrasePass) directnessScore -= 10;
  if (!consecutiveDataLimitationPass) directnessScore -= 8;
  if (!dataLimitationRatioPass) directnessScore -= 10;
  if (!missingExplanationPass) directnessScore -= 8;
  if (!conclusionFirstPass) directnessScore -= 12;
  if (!evidenceBindingPass) directnessScore -= 15;
  if (!tradingInstructionPass) directnessScore -= 25;
  directnessScore = Math.max(0, Math.min(100, Math.round(directnessScore)));
  const stylePass = defensivePhraseCount <= limit.defensivePhraseCount
    && duplicateDisclaimerCount === 0
    && emptyWatchPhraseCount === 0
    && maxConsecutiveHedgeSentences <= style.limits.maxConsecutiveHedgeSentences
    && !genericTitle
    && !genericEnding
    && strongClaimCount === 0
    && tradingInstructionPass
    && governanceLeakageCount === 0
    && readerFacingTechnicalTermPass
    && titleForbiddenPhrasePass
    && consecutiveDataLimitationPass
    && dataLimitationRatioPass
    && missingExplanationPass
    && directnessScore >= limit.directnessScore;
  return {
    schemaVersion: "editorial-lint-result-v1",
    edition,
    directnessScore,
    defensivePhraseCount,
    defensivePhraseCounts,
    duplicateDisclaimerCount,
    emptyWatchPhraseCount,
    readerFacingTechnicalTermCount,
    readerFacingTechnicalTermCounts,
    readerFacingTechnicalTermPass,
    forbiddenTitlePhraseCount,
    forbiddenTitlePhraseCounts,
    titleForbiddenPhrasePass,
    dataLimitationParagraphCount,
    dataLimitationCharacterCount,
    dataLimitationRatio,
    maxConsecutiveDataLimitationParagraphs,
    consecutiveDataLimitationPass,
    missingExplanationCounts,
    missingExplanationPass,
    dataLimitationRatioPass,
    conclusionFirstPass,
    titlePass: !genericTitle && title.trim().length >= 8,
    duplicateFactCount,
    maxConsecutiveHedgeSentences,
    longSentenceCount,
    averageSentenceLength,
    genericEndingPass: !genericEnding,
    unsupportedStrongClaimCount: strongClaimCount,
    tradingInstructionCount,
    tradingInstructionPass,
    governanceLeakageCount,
    evidenceBindingPass,
    sourceCoveragePass: sourceCoverage(payload, edition),
    stylePass,
    passed: conclusionFirstPass && evidenceBindingPass && stylePass,
    errors: [
      ...(conclusionFirstPass ? [] : ["conclusion-first failed"]),
      ...(evidenceBindingPass ? [] : ["evidence binding/source coverage failed"]),
      ...(stylePass ? [] : ["editorial style gate failed"])
    ]
  };
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--") continue;
    if (!args[index].startsWith("--")) throw new Error("unknown positional argument");
    const key = args[index].slice(2);
    if (Object.hasOwn(parsed, key)) throw new Error(`duplicate option --${key}`);
    parsed[key] = args[index + 1] && !args[index + 1].startsWith("--") ? args[++index] : true;
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const edition = args.edition === "weekly" ? "weekly" : "daily";
    const input = typeof args.input === "string" ? path.resolve(args.input) : edition === "daily"
      ? path.join(repositoryRoot, "content/daily-brief.json")
      : latestWeeklyReportInput(repositoryRoot);
    const value = readJson(input);
    const result = value?.schemaVersion === "writer-result-v2" ? value : null;
    const report = lintEditorial({ edition, value: result ? null : value, result });
    console.log(JSON.stringify(report));
    if (!report.passed) process.exitCode = 1;
  } catch (cause) {
    console.error(`EDITORIAL_LINT_FAILURE ${cause instanceof Error ? cause.message : "unexpected failure"}`);
    process.exitCode = 1;
  }
}
