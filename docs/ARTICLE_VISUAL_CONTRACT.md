# 文章图表契约（Article Visual Contract）

schema 版本：

- `article-visual-contract-v1`：契约本身；
- `article-visual-v1`：单张图表；
- `article-visual-bundle-v1`：一次生成的全部图表集合。

## 1. 定位

图表数据由确定性程序 `scripts/article-visuals.mjs` 从冻结数据生成，输出 `ARTICLE_VISUAL_BUNDLE.json`。Writer 只能选择已有图表并编写标题、takeaway 与正文解释，不能修改任何图表数字。

## 2. 单张图表字段

```json
{
  "id": "string",
  "kind": "yield_curve | line | multi_line | bar | grouped_bar | area | spread | indexed_performance | comparison_table | timeline",
  "title": "结论式标题（≤80 字）",
  "takeaway": "一句要点（≤120 字）",
  "unit": "percent | bp | index-points | pct-points | ratio | currency | none",
  "dataThrough": "YYYY-MM-DD",
  "sourceIndexes": [0],
  "series": [{ "id": "string", "label": "string", "unit": "string" }],
  "points": [{ "x": "string", "y": "number|null", "seriesId": "string" }],
  "notes": ["string（≤160 字）"],
  "contentSha256": "hex"
}
```

`contentSha256` 是去除自身后的规范化哈希，用于校验 Writer 未改动图表数字。

## 3. 空值与 unavailable

- `null` 不允许被画成 0；
- 数据不可用时该点缺省或显式 `null`，前端渲染为空状态；
- `unavailable` 状态在 notes 中显式标注，不补造数字。

## 4. 数据来源

- 收益率曲线与利差：冻结 writer packet 的 treasury facts（及历史 packet 归档）；
- 指数表现：冻结 research bundle 的指数观察；
- 板块相对强度：sector-rotation 的规则观察分（不叫概率）；
- 观察榜分项：prediction-diagnostics（只读）。

## 5. 校验

`scripts/article-visuals.mjs` 提供 `generate` 与 `validate` 子命令；`scripts/article-visuals.test.mjs` 覆盖：来源绑定、dataThrough 一致、空值不被画成 0、收益率曲线日期排序、2s10s 与 breakeven 计算、重复 visualId 拒绝、内容哈希稳定。
