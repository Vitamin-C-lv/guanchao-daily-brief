# 不可变预测训练数据集

每个 A 股训练数据集位于 `a-share/<dataset-id>/`，ID 为 `a-share-<dataAsOf>-<panel SHA-256 前12位>`。`panel.csv.gz` 使用固定列、`date → code` 行序、UTF-8 Unix 换行以及 `mtime=0` 的 gzip，因此相同输入会得到相同字节和 hash。

快照只能创建，不能覆盖或原位更新。创建时会同时写入：

- `manifest.json`：契约、范围、成熟度、质量指标和 panel hash；
- `source-manifest.json`：特征、日线、日历和分类文件的 hash；
- `label-diagnostics.json`：按 1/5/20 会话的样本和正样本率；
- `panel.csv.gz`：可审计的特征与标签面板。

`index.json` 是追加式注册表。`active` 可用于已审计训练，`candidate` 是尚未替代任何生产模型的重建输入，`legacy_recovered` 表示已找回旧输入，`reproduction_unavailable` 记录无法从现有设备找回的冻结生产输入。废弃数据集应在注册表显式标注状态，不删除旧 snapshot。

当行情、日历、分类、特征或标签契约改变时，必须创建新的 snapshot；绝不复用 ID 或重写历史 hash。用 `prediction_dataset.py verify` 审计快照，并用 `diff` 说明两份 snapshot 的日期、行业、字段、标签及数值变化。
