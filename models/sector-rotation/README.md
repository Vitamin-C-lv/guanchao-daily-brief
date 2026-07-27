# 行业轮动经验模型

这是一个低内存、可复现的行业相对强弱模型。A股数值层使用中证官网日频指数数据；港股当前层使用恒生指数公司官方行业指数快照，历史接口无法稳定返回时不生成预测；美股只保留三大指数状态，不在这里扩建行业模型。

## 数据边界

- A股固定使用 `taxonomy.a-core12-v2.json`：10个中证全指一级行业指数（`000986`–`000995`），加中证军工 `399967` 与中证移动互联网 `399970` 两个重点主题。医疗、军工、互联网标签只影响界面编排，不加分、不改权重或排名。
- 当前层可在同一最新完整交易日内对已核验的可用子集排序，并明确标注 `N/12`；5日和20日预测必须完整覆盖12项、taxonomy hash 与冻结模型一致，且对应期限的 walk-forward 回测通过发布门禁。
- 历史输入以中证官方接口为首选，日期参数使用 `YYYYMMDD`、逐代码串行并优先复用有效缓存；官方源不可用时才扩大至独立可信市场数据源交叉核验。百度 `000xxx` 代码与个股存在歧义，禁止作为这些指数的降级源。
- 历史压缩为单指数 `csv.gz`，一次只读取一个行业；派生特征和训练采用流式多遍扫描，不把全部年月数据同时放进内存。
- 当前层仍是横截面观察分，不是预测。未来层使用 `a-share-relative-probability-v2.json`，为 1、5、20 个交易日分别训练绝对上涨、跑赢中证全指、进入行业前 25% 与预期相对收益四个独立目标；主榜只使用前四分位概率或预期相对收益。
- 概率模型使用最近 504 个交易日滚动训练，并以 purged walk-forward、同期限 embargo 和最后 126 个独立日期作审计。原始分、原始概率与校准概率分别保存；只有原始模型已有样本外区分度且校准不塌缩时才启用校准器。
- 最高最低概率差小于3个百分点、全部位于47%–53%、横截面标准差不足、数据完整度低于80%、Brier不优于基准、RankIC或扣费后Top-Bottom不为正、或多数窗口方向不一致时，模型必须弃权。页面继续显示证据观察榜，但观察分永远不标注为概率。
- 每条可发布预测由概率模型版本、市场、`asOf`、期限、`dueDate` 和行业代码生成不可变 `forecastId`，并带 `probabilityTier` 与 `calibrationBasis`。只有量价一类证据时，文字置信度等级始终封顶 `low`。
- 数值层只学习当时可得的量价数据。新闻、机构观点与长期资金线索是独立事件覆盖层，不泄漏进量价基础模型，也不会触发日常重训。

## 两年主窗口与锁定保留集

- 周六研究流程把最近 **504 个完整交易日**作为主要滚动制度窗口。每个测试块只使用其开始前已经到期的标签训练；训练标签的 `targetDate` 必须严格早于测试块首日，5/20日重叠标签不能穿越边界。
- 模型选择先在锁定保留集之前的504个交易日完成，252个交易日保留集只打开一次。已打开边界追加记录在 `holdout-registry.json`；不足252个全新已到期日时只能输出 `research/insufficient`，不得滚动、重用或重命名旧holdout。
- 固定候选只有两个：9项可解释线性岭回归，以及在相同量价输入上增加8个预先定义交互/平方项的小型岭回归。复杂候选至少要把选择段 rank IC 提高0.01、维持正头尾差，并且不触发更早历史压力否决；复杂度本身不是升级理由。
- 更早历史继续用相同504日滚动方式作为制度压力测试，但不与最近两年混合拟合。压力样本用于暴露失效状态，不能用来包装近期局部改善。

2026-07-19 的首次 v2 审计记录在 `a-share-v2-audit.json`。5日与20日候选均未通过预登记门禁，交互模型也没有达到最低改善，因此 `a-share-v1.json` 保持原冻结版本。原审计中“把训练至最新日的冻结模型直接评估过去252日”的比较存在前视污染，已删除且不影响“候选未通过”的结论。未来基线比较必须在相同边界逐fold重拟合，或使用部署后前瞻结果。

## 压缩事件记忆

本地事件库位于 `data/rotation-model/events/events.jsonl.gz`，逐行 gzip 保存。只保存日期、标题、直接来源、100–200字事实摘要、行业标签、已知时间、情景方向、后续5/20日相对表现和内容哈希；不保存网页全文、长引文、图片、PDF或视频。每日任务只匹配、去重、追加与补齐到期结果，不重训冻结模型。

图片或图表优先识别成结构化字段，并记录来源、单位、口径、区间和 `extraction.confidence`；OCR 结果是提取结果，不是“官方直接数据”。置信度低于0.90或无法人工/结构化交叉核对时不得入模。确需保留视觉证据时才允许限宽WebP，必须hash去重并遵守单文件与总库体积上限。

“国家队/超大型长期资金”仅允许四类明确主体：中央汇金、证金、全国社保基金、基本养老保险基金组合。后来披露的前十股东变化、官方增持公告或基金报告可作事后真值；ETF申赎、宽基成交、权重股相对强弱与尾盘集中度只能作 `inference-proxy`，必须保留替代解释和失效条件。医保基金不与社保/养老混同，也不纳入权益资金结论。

## 运行

使用项目配置的 Python 运行：

```powershell
pnpm rotation:refresh
pnpm rotation:signals
pnpm rotation:history
pnpm rotation:infer
uv run --no-project --python 3.12 --with requests --with numpy python scripts/prediction_dataset.py build --market a-share --feature-file <staging-feature-file> --history-dir <read-only-history-dir> --benchmark-history <read-only-history-dir>/000985.csv.gz --as-of <latest-session> --output-root models/sector-rotation/datasets --code-commit <commit>
uv run --no-project --python 3.12 --with requests --with numpy python scripts/prediction_dataset.py verify --snapshot models/sector-rotation/datasets/a-share/<dataset-id>
pnpm rotation:probability-train --dataset-snapshot models/sector-rotation/datasets/a-share/<dataset-id> --output models/sector-rotation/candidates/<version>.json
pnpm rotation:events-append --input event.json
pnpm rotation:events-prune
```

Node 启动器依次尝试 `CODEX_PYTHON`、`python`、`py -3` 和 `uv` 管理的 Python，不写死任何用户缓存路径。日常无人值守入口是 `pnpm rotation:refresh`：刷新官方结构化输入、重建当日特征并应用冻结模型，但不训练。

候选重建固定为“只读历史 → staging 特征 → immutable snapshot build/verify → snapshot-only training”。不存在会先抓取再失败的 `train`/`pipeline` 入口；训练器要求 `--dataset-snapshot`，拒绝把可变 `FEATURE_PATH` 作为隐式输入。冻结模型不能被该流程覆盖，未来独立发布步骤仍须核验已审计 candidate 的路径/SHA-256、taxonomy/覆盖、两期限 `passed` 和当前基线哈希后才可原子替换。
