# 不可变预测训练数据集

每个 A 股训练数据集位于 `a-share/<dataset-id>/`，ID 为 `a-share-<dataAsOf>-<identity SHA-256 前12位>`。identity 同时绑定解压 panel、数据集/特征/标签/基准契约、`a-core12-v2` canonical taxonomy hash、`000985` 实际会话日历 hash；不会把创建时间或本机路径写入 identity。`panel.csv.gz` 使用固定列、`date → code` 行序、UTF-8 Unix 换行以及 `mtime=0` 且空 filename 的 gzip，因此相同输入会得到相同字节和 hash。

快照只能创建，不能覆盖或原位更新。创建时会同时写入：

- `manifest.json`：契约、identity、范围、成熟度、质量指标、panel/source/label diagnostics hash；
- `source-manifest.json`：特征、日线、`000985` 会话日历和分类文件的 full/used-content hash；
- `label-diagnostics.json`：按 1/5/20 会话的样本、正样本率和横截面；
- `panel.csv.gz`：可审计的特征与标签面板。

`index.json` 是追加式注册表。每项保存不可变的 `creationStatus`，以及可审计的 `lifecycleStatus`/`statusHistory`。允许 `candidate → active|superseded` 与 `active → retired`；必须通过 `prediction_dataset.py set-status --reason ... --code-commit ...` 追加原因，禁止复活 `retired`/`superseded` 或删除历史。`legacy_recovered` 表示已找回旧输入，`reproduction_unavailable` 记录无法从现有设备找回的冻结生产输入。废弃数据集只在注册表显式标记，不删除已发布 snapshot。

当行情、实际 benchmark 会话日历、分类、特征或标签契约改变时，必须创建新的 snapshot；绝不复用 ID 或重写历史 hash。用 `prediction_dataset.py verify` 审计快照，并用 `diff` 说明两份 snapshot 的日期、行业、字段、标签及数值变化。日常 history/features/signals 缓存仍可忽略；只有不可变训练 snapshot 会被提交。
