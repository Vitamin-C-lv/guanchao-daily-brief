# 观潮冻结架构

## 产品与治理

观潮是一个以公开证据为基础的全网信息采集、市场解释、预测和历史复盘网站。目标是广泛收集分散信息，将其组织为事实、证据、反证和观察项，并为 A 股、港股、美股保留可追溯的预测、实际结果和每周复盘。每个结论必须能回到数据、来源、时间和模型版本。

项目架构负责人拥有产品目标、信息架构、数据流、模块边界、数据契约、模型目标、发布门槛、历史账本规则、路线、技术债优先级、验收标准和模型选择的设计权。工程 Agent 忠实实施冻结设计、测试、验证、提交和交接；不得自主扩展功能、改变模型或发布门槛、引入数据库或并行实现、重设计账本、修改历史预测，或把 HK/US 研究候选写入生产。HK P2-A 允许在独立研究边界内登记契约和候选 shadow，但不得自动训练、发布或替换生产模型。

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

research bundle 仅建模来源、文档、观察、事件与 coverage；它不能改模型、概率、EvidenceScore、排名、publicationStatus、门槛或 prediction ledger，也不作投资结论。source run、document 与 bundle 均不可覆盖：source run 将 adapterId/adapterVersion 纳入 sourceRunId，document 精确引用 sourceRunId、记录 contentHashBasis/version 并从 run 解析 source class，bundleId 只 hash 递归 business view 而不 hash 完整审计对象。每层的 business SHA 和完整 canonical SHA 分离；仅 requestedAt/accessedAt/generatedAt 与 warnings 可作为 audit-only candidate 复用首次 artifact，其余稳定字段冲突 fail closed。唯一实现是 `scripts/research-contract.mjs`，提供 canonical identity、验证和只读 CLI。latest 是派生视图，不能作为 writer 权威输入。Luna 不得直接浏览、抓取或读取任意 latest 文件，未来只能读取同时绑定 immutable quantitative writer packet、qualitative research bundle、baseline content 及其 SHA/schema 的 `writer-context-v1`。

P1-G storage 将不可变计划与物理写入分离：只有 `shouldWrite: true` 才能原子落盘；相同 immutable artifact 以及字节相同的 index/latest 都是 mtime 不变的真正 no-op。rebuild 先验证 raw 文件名、gzip、内容 hash、唯一物理路径和 source/document lineage，再规划派生视图。document 分区使用来源日期、上海 timestamp 日期或 bundle asOf fallback，但不改变 document 业务字段。duplicate builder/validator 共享同一 effective-publication comparator。provider 失败只暴露受控 warning 与 hostname 诊断，响应内容和敏感请求信息永不进入 artifact 或 summary。

定性证据的确认状态由来源类别、稳定 publisherId、重复转载关系与合格反证确定性派生。community/social 只能作为线索或 unverified counter-signal，不触发 conflicting 也不计入交叉验证；calendar-event 可引用业务日结束前已发布的未来日历，其他事实不得越过 bundle 的上海业务日。coverage 对 market/topic 按包含关系计唯一 ID，不将重叠分类求和为顶层数量。

## 数据层

供应商结果统一为 `ProviderResult<T>`：`provider`、`requestedAt`、`asOf`、`status`、`data`、`coverage`、`sourceUrl`、`warnings`、`rawSnapshotId`。`status` 仅可为 `ready`、`partial`、`stale`、`unavailable`、`rate_limited` 或 `schema_changed`。数据源优先级为官方机构/交易所/指数公司/公告、官方文件、可靠公开接口、第三方公开补充、新闻线索。

核心事实保留 current/previous/expected value、as-of、数据期、发布和更新时间、来源、状态、货币、单位及质量标记。`0` 表示已确认的零，`null` 表示未获得；不得静默填零。时间必须满足 `asOfDate <= releasedAt <= updatedAt`。

## 模型与状态契约

模型周期为 1、5、20 个交易日；A 股冻结目标保持原有契约。HK 指数对象使用 `absolute_up`、`expected_return`，主题对象使用 `relative_outperformance_vs_hsi`、`expected_excess_vs_hsi`；`top_quartile` 仅在横截面规模足够时作为研究指标。训练必须采用 walk-forward、purged time-series split 和 embargo；没有样本外优势时必须保持 candidate/shadow 或 `publicationStatus=abstained`，不得给默认 50%。

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

模型路由默认使用 GPT-5.6 Luna Max（高推理）。同一根因连续两轮失败，或问题涉及复杂统计、数据泄漏、概率校准或 walk-forward 设计时，才升级 GPT-5.6 Sol；升级前必须先形成脱敏 failure bundle，至少包含 manifest、真实错误日志、失败分析、环境摘要、可复现 diff 和测试摘要。该规则由 ADR-026 明确 supersede ADR-007，且不通过换模型掩盖代码或契约缺陷。

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
`research-bundle-v1` is a frozen immutable input contract. Its single collection pipeline accepts only the validated Federal Reserve RSS, BLS RSS and Federal Register JSON catalog entries, stores deterministic raw/source/document/bundle artifacts, and exposes derived latest views only as non-authoritative convenience outputs. `writer-context-v1` remains a future frozen contract. A future
`writer-context-v1` must reference an immutable quantitative writer packet, immutable qualitative
research bundle, immutable baseline content, and the SHA plus Schema version of each input. Luna
must never browse autonomously; it may only operate on explicitly frozen context inputs.

## P2-B0 全球整合主文章与并行边界

P2-B0 在不切换当前生产内容的前提下冻结 `global-market-brief-v1`。它是面向后续 Writer、Validator 和 Page 集成的独立输出契约，不替换现有 `daily-brief-v1`，也不建立 old/new 长期双写。

### 契约与数据流

```text
Researcher（可联网）
  → 冻结 execution package：事实、来源索引、量化 writer packet、逻辑链候选、跨市场候选、专项候选、反向证据、观察项、旧文章基线
  → Writer（不联网，只读 package）
  → 1 个 global_main + 0–2 个 special_report
  → Validator：结构、sourceIds、evidenceStatus、失效条件、专项 eligible、公开 DTO 边界
  → Page DTO：只暴露公开内容字段
```

机器可读文件为 `schemas/global-market-brief-v1.schema.json`，执行校验器为 `scripts/global-market-brief-contract.mjs`。主文章的 `contentKind` 固定为 `global_main`；专项固定为 `special_report`。`specialTriggerCandidates` 是冻结研究包授权结果的最小投影，报告必须回指 eligible 候选及其证据 ID。

当前生产写作链仍为 `writer-context-v1 → writer-request-v2/result-v2 → scripts/writer-jobs.mjs → content/daily-brief.json`，其 `markets` 数组仍由 `scripts/validate-brief.mjs` 强制 A 股、港股、美股三项。本阶段只增加新契约和迁移边界，不修改旧 validator、旧 prompt、当前 `content/daily-brief.json` 或页面。

### 市场展望、模型预测与公开边界

编辑的 `outlook.nextSession` 与 `outlook.oneWeek` 必须包含 `statement`、支持来源和至少一个 `invalidationConditionId`，只能表达“市场展望”；它们不得有 `probability`、`EvidenceScore`、ranking、model state 等字段。量化系统的概率、排名、收益和模型状态仍由独立 writer packet/预测契约提供，使用“模型预测”标记，Writer 只能逐值引用、不能改写。不可用值保留 `null`，不得转成 0。

未来页面消费 `global-market-brief-public-dto-v1`：主文章卡只读取 `title`、`dek`、`conclusion`、逻辑链简表、`marketTags`、`dataAsOf`、`sourceCount`、`articleUrl`；专项区只读取 `title`、`triggerType`、`conclusion`、`marketTags`、`articleUrl`。公开 DTO 不含 provider diagnostics、raw research、internal lineage、gate failures、文件路径、运行日志或私人 Skill。

### 结构化事件与迁移窗口

`schemas/global-market-event-v1.schema.json` 只冻结 `eventType`、`occurredAt`、`region`、`affectedAssets`、`affectedThemes`、`direction`、`horizon`、`sourceConfidence`、`marketConfirmation`、`supportingSourceIds`、`contradictorySourceIds`、`status`。它复用现有 research bundle 的证据状态语义，不引入数据库、向量库、图数据库、知识图谱、搜索服务或通用事件平台。

P2-B0 保留明确迁移窗口：旧 `daily-brief-v1`/三市场生产链只有在 P2-B4 完成 Writer context、Writer result、Validator、内容应用和页面消费的统一切换，并完成外部审查与完整回归后，才允许删除；在此之前不得生产双写、替换生产文章或恢复自动化。

## 阶段二：三市场预测数据与模型核心（2026-08-06）

阶段二增加独立的 `three-market-model-core-v1` 研究边界。采集脚本先在中立目录生成私有 cache；离线工程入口 `scripts/three_market_model_core.py` 只消费显式 cache，不联网、不发现新来源。A 股复用现有 prediction dataset contract 和 champion replay；HK/US 生成非空指数 panel 时只保留 shadow/research 语义。

统一 panel manifest 同时记录 raw snapshot lineage 与 normalized panel identity，但两者使用独立 SHA。panel 使用确定性 gzip、UTF-8/LF、明确 session/object/feature/label 列；相同 identity 且字节相同是 no-op，相同 identity 内容变化 fail closed。所有缺失值保持 `null`，主题对象在冻结来源无法提供合法历史时保持 `unavailable`，不静默替换或回测混入正式历史。

特征只使用预测时点已知信息，标签按 1/5/20 日独立生成；训练采用 expanding walk-forward、target-date purge 和 horizon embargo。没有至少三个有效 OOS fold 的对象/周期保持 `insufficient_data`；即使训练完成，HK/US 也固定 `publicationStatus=abstained`、`outputMode=none`。阶段二不写文章、UI、Writer、日报/周报 automation、生产模型或 prediction ledger。

## 阶段三：预测产品发布与持续复盘（2026-08-06）

阶段三新增三层，全部只读消费阶段二私有研究输出，不训练、不 promotion、不改模型与文章边界：

```text
阶段二私有研究输出（MODEL_CARDS / OOS_METRICS / RUN_RESULT）
  → HK/US publication gate（registry + 确定性 validator）
  → PublicPredictionView v1 DTO（public/data/predictions/current.json）
  → /predictions 专用页面（A/HK/US 三市场、1/5/20、概率/观察/弃权/不足/不可用分离）
  → HK/US state-only ledger snapshot（幂等、不进入评价分母）
  → prediction publisher 集成（gate → DTO → states → validators → 白名单）
```

- A 股继续使用现有冻结生产 gate 与 `content/sector-rotation.json` 观察榜；HK/US 走 `prediction-publication-gates-v1` 门禁，本阶段真实结果全部 blocked（HSI/Nasdaq abstained、HSTECH insufficient_data、两个主题 unavailable），任何 HK/US 概率保持 `null`。
- `/predictions` 使用专用组件（PredictionCurrentView / PredictionMarketTabs / PredictionHorizonCard / PredictionStatusPanel / PredictionSourceNote / PredictionWeeklyReviewTeaser），不再渲染通用 Dashboard predictions view；URL query `market=a-share|hk|us` 在刷新与分享后保持；移动端保持五项底部导航，390px 无横向溢出。
- `/predictions/history` 保留按月分片与哈希校验，新增当前三市场状态摘要与“数据不足”筛选；弃权、未训练、数据不可用不计为错误，legacy/current 与市场/目标/周期保持隔离。
- 账本：HK/US 状态写入 state-only snapshot，`probability/expectedReturn=null`、evaluation 不适用、相同状态跨天幂等；公开分片保留状态记录，`statusSummary` 增加 `unavailable`；生产账本在 PR 审查阶段不写入。
- 自动化：既有本机 `guanchao-prediction-publisher` 任务保持不变（Asia/Shanghai 06:45，无重复任务）；日报 07:30 与周报周六 10:00 自动化未改动；发布前必须 `pnpm automation:consistency` 通过，dry-run 不写、不 commit、不 push。
