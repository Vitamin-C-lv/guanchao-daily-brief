# 观潮冻结架构

## 产品与治理

观潮是一个以公开证据为基础的全网信息采集、市场解释、预测和历史复盘网站。目标是广泛收集分散信息，将其组织为事实、证据、反证和观察项，并为 A 股、港股、美股保留可追溯的预测、实际结果和每周复盘。每个结论必须能回到数据、来源、时间和模型版本。

项目架构负责人拥有产品目标、信息架构、数据流、模块边界、数据契约、模型目标、发布门槛、历史账本规则、路线、技术债优先级、验收标准和模型选择的设计权。工程 Agent 忠实实施冻结设计、测试、验证、提交和交接；不得自主扩展功能、改变模型或发布门槛、引入数据库或并行实现、重设计账本、修改历史预测、训练 HK/US，或开始 P1-C。

## 单向数据流

```text
调度器 → 数据源适配器 → 原始快照 → 标准化和质量检查
→ 特征与训练数据集 → 冻结模型推理 → 预测状态契约
→ GitHub 不可变预测账本 → 公开月度分片 → 页面展示
→ 实际结果评价 → 每周复盘 → 下一轮模型研究
```

任何下游层不得反向修改上游事实。AI只可摘要事实、组织证据、撰写解释、生成反证和观察项；不得修改原始数据、模型输出、概率、排名、收益、评价、发布状态、模型版本或数据完整度。

## P1-G qualitative research layer

定量市场数据与定性研究资料是分离的不可变输入。P1-G 的完整未来流向为：

```text
scheduler
→ source adapters
→ raw/hash-only snapshots
→ research source runs
→ research documents
→ source-grounded observations
→ events/deduplication/coverage
→ immutable research bundle
→ immutable writer context
→ Luna
→ P1-F validate/apply
→ content pages
```

research bundle 仅建模来源、文档、观察、事件与 coverage；它不能改模型、概率、EvidenceScore、排名、publicationStatus、门槛或 prediction ledger，也不作投资结论。source run、document 与 bundle 均不可覆盖：source run 以 sourceRunId 绑定业务采集结果，document 精确引用 sourceRunId 并从中解析 source class，bundleId 只 hash 递归 business view 而不 hash 完整审计对象。每层的 business SHA 和完整 canonical SHA 分离，身份冲突 fail closed。latest 是派生视图，不能作为 writer 权威输入。Luna 不得直接浏览、抓取或读取任意 latest 文件，未来只能读取同时绑定 immutable quantitative writer packet、qualitative research bundle、baseline content 及其 SHA/schema 的 `writer-context-v1`。

定性证据的确认状态由来源类别、稳定 publisherId、重复转载关系与反证关系确定性派生。community/social 只能作为线索，不计入交叉验证；calendar-event 可引用业务日结束前已发布的未来日历，其他事实不得越过 bundle 的上海业务日。coverage 对 market/topic 按包含关系计唯一 ID，不将重叠分类求和为顶层数量。

## 数据层

供应商结果统一为 `ProviderResult<T>`：`provider`、`requestedAt`、`asOf`、`status`、`data`、`coverage`、`sourceUrl`、`warnings`、`rawSnapshotId`。`status` 仅可为 `ready`、`partial`、`stale`、`unavailable`、`rate_limited` 或 `schema_changed`。数据源优先级为官方机构/交易所/指数公司/公告、官方文件、可靠公开接口、第三方公开补充、新闻线索。

核心事实保留 current/previous/expected value、as-of、数据期、发布和更新时间、来源、状态、货币、单位及质量标记。`0` 表示已确认的零，`null` 表示未获得；不得静默填零。时间必须满足 `asOfDate <= releasedAt <= updatedAt`。

## 模型与状态契约

模型周期为 1、5、20 个交易日；目标为 `absolute_up`、`relative_outperformance`、`top_quartile`、`expected_excess`，主榜按 top-quartile、expected-excess、relative-outperformance、absolute-up 优先。训练必须采用 walk-forward、purged time-series split 和 embargo；没有样本外优势时必须 `publicationStatus=abstained`，不得给默认 50%。

`modelAvailability`：`trained | not_trained | not_implemented`；`publicationStatus`：`published | abstained | insufficient_data | not_applicable`；`outputMode`：`probability | evidence_observation | current_observation | none`；`calibrationStatus`：`enabled | disabled | collapsed | not_applicable | legacy_unknown`；`probabilitySource`：`raw_model | calibrated_model | historical_base_rate | legacy_unknown | none`；`probabilityTarget`：`absolute_up | relative_outperformance | top_quartile | none`。

历史基准率、证据观察和已禁用校准均不得被展示为模型概率；not-trained、not-implemented、pending、abstained 不计为错误；legacy 不进入当前模型指标；不同目标不得混算。

## 不可变账本与公开数据

`data/prediction-ledger/` 是权威：`contract.json`、`index.json`、按年月分开的 snapshot/evaluation gzip 事件、weekly review 及 manifest。预测与评价是分离事件；修订是新的 revision event。相同身份且内容相同幂等，相同身份且内容不同失败。旧预测不原位修改；Git 历史为第二层审计；index、manifest、review、公开分片均可重建，且公开限制绝不截断权威历史。

公开数据为 `public/data/prediction-history/index.json`、`YYYY-MM.json` 和 `reviews/YYYY-Www.json`。页面先加载 index，再加载选定月，不得一次加载所有历史。远端恢复失败不得从空账本继续覆盖，legacy、弃权和 HK/US 状态必须保存。

## 页面与复盘

`/predictions` 展示当前预测、模型状态、概率或证据观察、完整度和历史入口。`/predictions/history` 提供月份、市场、周期、发布状态、模型版本、概率目标、legacy/current 筛选，以及预测/实际对照和周度复盘。移动端维持五个底部导航项；不可将 null 显示为 0、无概率显示为 50%、仅用颜色表达状态，或重复实现状态映射。

每周复盘按模型版本、市场、周期、目标、发布状态、legacy/current、成熟度和周次切片。样本不足返回 null 与原因；不自动降低门槛。复盘只能为下一轮研究提供可读建议，不能改写预测或评价。

## 工程、测试与开发流程

依赖只能沿 `provider → normalized contract → domain/quality → dataset/model → prediction contract → ledger → public DTO → React` 前进。单一业务规则只保留一个实现；避免 old/new 双写、万能类、未知未来抽象、`any`、`ts-ignore` 和静默 catch。配置、纯计算、I/O、CLI 尽量分离；超过约 800 行评估拆分，超过约 1000 行原则上拆分，但不机械拆分；不用 repository/service/manager/DI 框架。

Windows 是主本地环境；Vercel 继续验证真实部署。测试覆盖不可变性、身份、迁移、evaluation 语义、legacy 隔离、目标隔离、公开字段、路由和静态构建。每次变更先保持冻结契约，再执行定向测试、完整 `pnpm check` 和构建；有失败时读取真实日志修复，不通过删除门禁“修绿”。

普通工程使用 GPT-5.6 Terra（高推理）；模型训练与统计研究使用 GPT-5.6 Sol（高或中高推理），不默认使用 Sol Max。

## 长期原则

1. 事实先于解释，数据先于模型，样本外表现先于概率发布。
2. 无优势必须弃权；规则观察分不得冒充概率。
3. 历史预测不得事后改写，模型升级必须可复现。
4. 重点观察不改变客观评分；AI 不得修改模型输出。
5. 最小充分实现优于通用大框架；维护成本属于产品成本。
6. 架构由项目负责人冻结，工程 Agent 忠实实施。

## P1-F writer queue/apply boundary

P1-F supplies immutable quantitative packet snapshots, a request/result queue, result contract
validation, atomic daily/weekly apply, rollback, and manual request preparation. It is not a
research bundle, autonomous Luna runner, automatic content publisher, or scheduled writing system.
`research-bundle-v1` and `writer-context-v1` remain future frozen contracts. A future
`writer-context-v1` must reference an immutable quantitative writer packet, immutable qualitative
research bundle, immutable baseline content, and the SHA plus Schema version of each input. Luna
must never browse autonomously; it may only operate on explicitly frozen context inputs.
