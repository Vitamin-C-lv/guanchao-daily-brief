const SENSATIONAL_TERMS = ["暴涨", "暴跌", "崩盘", "狂飙", "血洗", "史诗级", "全面爆发"];

function finiteNumber(value, label) {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number`);
  return value;
}

export function estimateNetFlowFromShares(currentShares, previousShares, currentNav) {
  finiteNumber(currentShares, "currentShares");
  finiteNumber(previousShares, "previousShares");
  finiteNumber(currentNav, "currentNav");
  if (currentShares < 0 || previousShares < 0 || currentNav <= 0) {
    throw new RangeError("shares must be non-negative and NAV must be positive");
  }
  return (currentShares - previousShares) * currentNav;
}

export function estimateNetFlowFromAum(currentAum, previousAum, dailyReturn) {
  finiteNumber(currentAum, "currentAum");
  finiteNumber(previousAum, "previousAum");
  finiteNumber(dailyReturn, "dailyReturn");
  if (currentAum < 0 || previousAum < 0 || dailyReturn <= -1) {
    throw new RangeError("AUM must be non-negative and dailyReturn must exceed -100%");
  }
  return currentAum - previousAum * (1 + dailyReturn);
}

export function renormalizePositiveWeights(weights, availableKeys) {
  const available = new Set(availableKeys);
  const selected = Object.entries(weights).filter(([key, value]) => available.has(key) && Number.isFinite(value) && value > 0);
  const total = selected.reduce((sum, [, value]) => sum + value, 0);
  if (total === 0) return {};
  return Object.fromEntries(selected.map(([key, value]) => [key, value / total]));
}

export function scoreAvailableFactors(factors, weights, minimumFactors = 3) {
  const availableKeys = Object.keys(factors).filter((key) => Number.isFinite(factors[key]));
  if (availableKeys.length < minimumFactors) {
    return { status: "insufficient", score: null, availableFactors: availableKeys };
  }
  const normalized = renormalizePositiveWeights(weights, availableKeys);
  const score = Object.entries(normalized).reduce((sum, [key, weight]) => sum + factors[key] * weight, 0);
  return { status: "ready", score, availableFactors: availableKeys, normalizedWeights: normalized };
}

export function calibrateHeadline(originalHeadline, evidence) {
  const detectedTerms = SENSATIONAL_TERMS.filter((term) => originalHeadline.includes(term));
  if (!detectedTerms.length) {
    return { status: "not-triggered", detectedTerms, calibratedHeadline: originalHeadline };
  }
  if (!evidence || !evidence.asset || !Number.isFinite(evidence.changePct) || !evidence.period) {
    return {
      status: "needs-evidence",
      detectedTerms,
      calibratedHeadline: "缺少可核验的资产、统计期或涨跌幅，暂不发布方向性标题。",
    };
  }
  const sign = evidence.changePct > 0 ? "+" : "";
  const percentile = Number.isFinite(evidence.historicalPercentile)
    ? `，位于指定历史样本的前 ${Math.max(1, Math.round(100 - evidence.historicalPercentile))}%`
    : "";
  return {
    status: "calibrated",
    detectedTerms,
    calibratedHeadline: `${evidence.asset}${evidence.period}${sign}${evidence.changePct.toFixed(2)}%${percentile}。`,
  };
}

export const sensationalHeadlineTerms = [...SENSATIONAL_TERMS];
