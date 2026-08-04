# 港股 P2-A 研究边界

`hk-training-universe-v1.json` 是后台训练宇宙：12 个恒生综合一级行业，加上恒生指数、恒生科技指数和可追溯的主题代理对象。`hk-public-universe-v1.json` 是未来公开视图：恒生指数、恒生科技指数、港股创新药、头部科技互联网四个对象。

主题代理必须在公开字段中披露代理身份，不能被称为恒生官方行业历史；当前成分股名单不能回填历史；缺失值必须保留为 `null`。

`data/model-research/hk/` 当前没有可验证历史面板，所以研究报告保持 `shadow`，不进入 `models/sector-rotation/a-share-*.json`、`content/` 或 `data/prediction-ledger/`。
