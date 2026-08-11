import { validMarketDate } from "./market-date-contract.mjs";

const HANG_SENG_PUBLISHER = "Hang Seng Indexes Company Limited";
const REQUIRED_EVIDENCE_CLASSES = ["official-primary", "exchange-market-data"];

/**
 * HK has two valid clocks: the common historical core-index session and the
 * official current industry observation. They must be compared explicitly;
 * the latter must not be rewritten to the former.
 */
export function validateHkIndustryObservation({ market, marketDateContract, editionDate, label = "rotation.markets.hk" } = {}) {
  const errors = [];
  const add = (message) => errors.push(message);
  const current = market?.horizons?.current;
  const marketAsOf = market?.asOf ?? null;
  const sourceAsOf = market?.sourceAsOf ?? null;
  const currentAsOf = current?.asOf ?? null;
  const currentSourceAsOf = current?.sourceAsOf ?? null;
  const dateFields = [
    ["asOf", marketAsOf],
    ["sourceAsOf", sourceAsOf],
    ["horizons.current.asOf", currentAsOf],
    ["horizons.current.sourceAsOf", currentSourceAsOf],
  ];
  for (const [field, value] of dateFields) {
    if (!validMarketDate(value)) add(`${label}.${field} 必须是有效 YYYY-MM-DD 日期`);
  }
  if (marketAsOf !== sourceAsOf) add(`${label}.asOf 必须与 sourceAsOf 完全一致`);
  if (marketAsOf !== currentAsOf) add(`${label}.asOf 必须与 horizons.current.asOf 完全一致`);
  if (marketAsOf !== currentSourceAsOf) add(`${label}.asOf 必须与 horizons.current.sourceAsOf 完全一致`);

  if (current?.status === "ready" && (!Array.isArray(current.items) || current.items.length !== 12)) {
    add(`${label}.horizons.current 必须完整覆盖12个恒生一级行业`);
  }

  const hkCoreIndexCommonDate = marketDateContract?.marketDates?.hk ?? null;
  if (validMarketDate(sourceAsOf) && validMarketDate(hkCoreIndexCommonDate) && sourceAsOf < hkCoreIndexCommonDate) {
    add(`${label}.sourceAsOf 不得早于港股核心指数共同交易日 ${hkCoreIndexCommonDate}`);
  }
  if (validMarketDate(sourceAsOf) && validMarketDate(editionDate) && sourceAsOf > editionDate) {
    add(`${label}.sourceAsOf 不得晚于日报生成日期 ${editionDate}`);
  }

  const sources = Array.isArray(market?.sources) ? market.sources : [];
  if (!sources.some((source) => source?.publisher === HANG_SENG_PUBLISHER)) {
    add(`${label}.sources 必须包含 publisher=${HANG_SENG_PUBLISHER}`);
  }
  for (const evidenceClass of REQUIRED_EVIDENCE_CLASSES) {
    if (!sources.some((source) => source?.publisher === HANG_SENG_PUBLISHER && source?.evidenceClass === evidenceClass)) {
      add(`${label}.sources 必须包含 ${HANG_SENG_PUBLISHER} 的 evidenceClass=${evidenceClass}`);
    }
  }
  return errors;
}
