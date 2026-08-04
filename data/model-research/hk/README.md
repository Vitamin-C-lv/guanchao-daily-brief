# 港股研究面板入口

P2-A 只提交港股研究契约和验证边界，不提交没有来源快照的历史面板。若要开始训练，必须在本目录以显式不可变快照提供 `panel.csv.gz`，并同时登记来源、交易日历、成分/权重的 point-in-time 证据和 SHA-256。

当前目录没有 `panel.csv.gz`，因此 `scripts/hk_model_research.py validate` 会报告：

- `sessions=0`、`rows=0`，不会把缺失历史转成零；
- `datasetId=null`，只生成独立的 `researchContractId`；
- 1/5/20 日指标全部为 `null`，不会返回默认 50% 概率；
- 候选状态为 `shadow`，生产应用为 `false`。

面板一旦存在，校验器只接受可读的 gzip CSV，并检查 `date`、`objectId`、真实日历日期和重复 `(date, objectId)`；dataset identity 使用 raw gzip 字节 SHA-256，不使用文件 mtime、绝对路径或运行时间。

官方恒生行业当前快照只允许做同日观察，不能替代历史训练面板；当前成分股名单也不能回填过去。
