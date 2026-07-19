import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const detailsPath = path.join(root, "content", "sector-details.json");
const rotationPath = path.join(root, "content", "sector-rotation.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function checkIndexes(indexes, sourceCount, context, { allowEmpty = false } = {}) {
  assert(Array.isArray(indexes), `${context}: sourceIndexes 必须是数组`);
  assert(allowEmpty || indexes.length > 0, `${context}: 缺少引用`);
  assert(new Set(indexes).size === indexes.length, `${context}: 引用下标重复`);
  indexes.forEach((index) => {
    assert(Number.isInteger(index) && index >= 0 && index < sourceCount, `${context}: 无效来源下标 ${index}`);
  });
}

const data = readJson(detailsPath);
const rotation = readJson(rotationPath);
assert(data.schemaVersion === 1, "sector-details.schemaVersion 必须为 1");
assert(Array.isArray(data.markets) && data.markets.length > 0, "sector-details.markets 不能为空");

const marketIds = new Set();
const detailKeys = new Set();

for (const market of data.markets) {
  assert(["a-share", "hk"].includes(market.id), `${market.id}: 详情页仅支持 A股与港股`);
  assert(!marketIds.has(market.id), `${market.id}: 市场重复`);
  marketIds.add(market.id);
  assert(typeof market.label === "string" && market.label.trim(), `${market.id}: label 不能为空`);
  assert(isDate(market.asOf), `${market.id}: asOf 必须是完整日期`);
  assert(market.taxonomy && ["owner", "name", "version", "effectiveDate"].every((key) => typeof market.taxonomy[key] === "string" && market.taxonomy[key].trim()), `${market.id}: taxonomy 不完整`);
  assert(Array.isArray(market.sectors) && market.sectors.length > 0, `${market.id}: sectors 不能为空`);

  const codes = new Set();
  for (const sector of market.sectors) {
    const context = `${market.id}/${sector.code || "unknown"}`;
    assert(typeof sector.code === "string" && sector.code.trim(), `${context}: code 不能为空`);
    assert(!codes.has(sector.code), `${context}: code 重复`);
    codes.add(sector.code);
    detailKeys.add(`${market.id}:${sector.code}`);
    assert(typeof sector.name === "string" && sector.name.trim(), `${context}: name 不能为空`);
    assert(typeof sector.description === "string" && sector.description.trim().length >= 15, `${context}: description 过短`);
    assert(Array.isArray(sector.styleTags) && sector.styleTags.length >= 1, `${context}: styleTags 不能为空`);
    assert(typeof sector.styleSummary === "string" && sector.styleSummary.trim().length >= 15, `${context}: styleSummary 过短`);
    assert(Array.isArray(sector.styleTraits) && sector.styleTraits.length >= 1, `${context}: styleTraits 不能为空`);
    assert(Array.isArray(sector.drivers) && sector.drivers.length >= 1, `${context}: drivers 不能为空`);
    assert(Array.isArray(sector.risks) && sector.risks.length >= 1, `${context}: risks 不能为空`);
    assert(Array.isArray(sector.sources) && sector.sources.length >= 1, `${context}: sources 不能为空`);

    const sourceUrls = new Set();
    sector.sources.forEach((source, index) => {
      assert(typeof source.name === "string" && source.name.trim(), `${context}: 来源 ${index + 1} 名称为空`);
      assert(typeof source.publisher === "string" && source.publisher.trim(), `${context}: 来源 ${index + 1} 发布者为空`);
      assert(typeof source.url === "string" && /^https:\/\//.test(source.url), `${context}: 来源 ${index + 1} 必须是 HTTPS 直链`);
      assert(!sourceUrls.has(source.url), `${context}: 来源 URL 重复`);
      sourceUrls.add(source.url);
      assert(["official", "authoritative", "major-media"].includes(source.tier), `${context}: 来源 ${index + 1} tier 无效`);
    });

    checkIndexes(sector.sourceIndexes, sector.sources.length, `${context} 概览`);
    for (const [sectionName, points] of [["styleTraits", sector.styleTraits], ["drivers", sector.drivers], ["risks", sector.risks]]) {
      points.forEach((point, index) => {
        assert(typeof point.title === "string" || typeof point.label === "string", `${context} ${sectionName}[${index}]: 缺少标题`);
        assert(typeof point.detail === "string" || typeof point.explanation === "string", `${context} ${sectionName}[${index}]: 缺少说明`);
        checkIndexes(point.sourceIndexes, sector.sources.length, `${context} ${sectionName}[${index}]`);
      });
    }

    const constituents = sector.constituents;
    assert(constituents && constituents.unit === "percent", `${context}: 成分权重单位必须为 percent`);
    assert(isDate(constituents.asOf), `${context}: 成分 asOf 必须是完整日期`);
    assert(typeof constituents.scope === "string" && constituents.scope.trim(), `${context}: 成分 scope 不能为空`);
    assert(typeof constituents.weightingMethod === "string" && constituents.weightingMethod.trim(), `${context}: 缺少加权方法`);
    assert(typeof constituents.note === "string" && constituents.note.trim(), `${context}: 缺少权重口径说明`);
    checkIndexes(constituents.sourceIndexes, sector.sources.length, `${context} 成分快照`);
    assert(Array.isArray(constituents.items) && constituents.items.length >= 1 && constituents.items.length <= 20, `${context}: 成分展示数量须为 1–20`);
    let previousWeight = Number.POSITIVE_INFINITY;
    let totalWeight = 0;
    const constituentCodes = new Set();
    constituents.items.forEach((item, index) => {
      assert(typeof item.code === "string" && item.code.trim(), `${context}: 成分 ${index + 1} code 为空`);
      assert(!constituentCodes.has(item.code), `${context}: 成分 ${item.code} 重复`);
      constituentCodes.add(item.code);
      assert(typeof item.name === "string" && item.name.trim(), `${context}: 成分 ${index + 1} 名称为空`);
      assert(Number.isFinite(item.weightPct) && item.weightPct >= 0 && item.weightPct <= 100, `${context}: 成分 ${item.code} 权重无效`);
      assert(item.weightPct <= previousWeight, `${context}: 成分权重必须降序`);
      previousWeight = item.weightPct;
      totalWeight += item.weightPct;
      if (item.sourceIndexes) checkIndexes(item.sourceIndexes, sector.sources.length, `${context} 成分 ${item.code}`);
    });
    assert(totalWeight <= 100.05, `${context}: 展示成分权重合计超过 100%`);
  }
}

for (const market of rotation.markets ?? []) {
  if (!["a-share", "hk"].includes(market.id)) continue;
  for (const horizon of Object.values(market.horizons ?? {})) {
    if (horizon?.status !== "ready") continue;
    for (const item of horizon.items ?? []) {
      if (!item.code) continue;
      assert(detailKeys.has(`${market.id}:${item.code}`), `${market.id}/${item.code}: 轮动排名存在但缺少详情页`);
    }
  }
}

console.log(`sector-details valid: ${detailKeys.size} pages across ${marketIds.size} markets`);
