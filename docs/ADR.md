# Architecture Decision Records

所有以下决策状态均为 Accepted；变更须由项目架构负责人明确冻结后实施。

| ID | 决策 | 理由 |
| --- | --- | --- |
| ADR-001 | 静态站点与 GitHub 仓库是当前基础设施。 | 与现有 Vercel 部署和可审计 Git 历史一致，避免无必要数据库。 |
| ADR-002 | 预测历史采用不可变事件账本。 | snapshot、evaluation 与 revision 分离，防止事后改写。 |
| ADR-003 | 概率模型无样本外优势时必须弃权。 | 概率发布以可验证优势为前提，不用默认 50%。 |
| ADR-004 | 预测目标采用多目标、多周期。 | 1/5/20 日与 absolute/relative/top-quartile/expected-excess 不混算。 |
| ADR-005 | 训练基于不可变内容寻址数据集。 | 模型升级可复现，冻结输入与生产模型可追溯。 |
| ADR-006 | Windows-first 工程策略。 | 用户本地验收环境为 Windows，云端只保留部署所需兼容。 |
| ADR-007 | Terra 用于工程，Sol 仅用于模型研究。 | 区分工程实施与统计研究的推理需要。 |
| ADR-026 | ADR-007 被明确 supersede：默认使用 GPT-5.6 Luna Max；同一根因连续两轮失败，或问题涉及复杂统计、数据泄漏、概率校准或 walk-forward 设计时升级 GPT-5.6 Sol。 | 默认路由保持高推理工程效率；升级前必须先形成脱敏 failure bundle，确保升级依据是真实错误、最小复现和已执行验证，而不是盲目换模型。 |
| ADR-008 | 架构由项目负责人冻结，工程 Agent 不自主扩展。 | 设计权与执行权分离，保护模型和产品边界。 |
| ADR-009 | 最小充分实现优先。 | 不为未知需求引入抽象、数据库或多层框架。 |
| ADR-010 | 保留 P1-B 账本架构，合并前仅做必要维护性处理。 | 只允许行为保持的职责拆分与重复 CI 收敛。 |
| ADR-011 | 区分模型输入完整度、模型特征覆盖、生产信号覆盖、训练就绪覆盖和供应商健康度。 | 冻结模型的实际训练输入与独立生产观察信号必须可分别审计；观察信号不得伪装成模型特征、改变概率或放宽发布门槛。 |
| ADR-012 | 写作模型只读取经过验证的 writer packet。 | 防止写作模型自行浏览、抓取或把未验证数字写入内容。 |
| ADR-013 | 美债曲线状态与因果来源分开判断。 | 曲线形态不构成通胀、财政供给或增长原因的充分证据。 |
| ADR-014 | 工程 Agent 实施与独立验证分离。 | external_review 模式下 Codex 只运行定向测试和一次 typecheck、创建 Draft PR；ChatGPT 负责完整审查、全量验证与合并决定。 |
| ADR-015 | Luna 写作通过不可变 writer request/result 契约进入生产内容流程。 | packet、request 与 result 均可追踪；Luna 不得自主抓取；结果必须先验证，accepted result 不可覆盖，内容应用与 prediction ledger 分离。 |
| ADR-016 | 研究资料必须经不可变 source run、document 和 research bundle 契约后才可进入 writer context。 | 唯一 canonical identity/validator 为 `scripts/research-contract.mjs`；artifact timestamp 统一 canonical UTC，document 必须精确绑定可供给的 sourceRunId/rawSnapshotId，并以 `publishedDate` 保留日期精度，bundle 身份使用递归 business view。仅审计字段变化复用首次 artifact，其余稳定差异 fail closed；Luna 不得直接浏览或读取任意 latest 文件。未来 `writer-context-v1` 将扩展 ADR-012，同时保留“Luna 不得自主浏览”的核心原则。 |
| ADR-017 | 媒体网页只保留元数据、哈希和最小证据片段。 | 不保存完整新闻正文；不得绕过付费墙或任何访问控制，避免版权与合规风险。 |
| ADR-018 | evidenceState 由来源类别、独立 publisher 数量和合格反证关系确定性派生。 | 合格 contradict 仅来自可审计的一手、媒体或供应商类别，且按 publisherId/duplicate cluster 去重；community/social 仅保留为 unverified counter-signal、不参与 corroborated。AI 不得自行提升证据等级。 |
| ADR-019 | 首批 qualitative research collection 限定为三项官方结构化来源。 | `research-source-catalog-v1` 仅登记 Federal Reserve RSS、BLS RSS 和 Federal Register JSON；单一 pipeline 采用无认证的受限 GET、固定 identity、content cap、host-validated redirect、deterministic gzip 和 fail-closed immutable storage。它不抓取正文、不生成 AI observation、不启动 Luna，也不改变 P1-F、模型或页面。 |
| ADR-020 | research storage 的复用必须是物理 no-op，派生重建必须先验证 raw lineage。 | immutable 与 derived plan 都显式声明 `created/reused/shouldWrite`；相同字节不触碰文件或 mtime。rebuild 按 raw → source run → document → bundle → index/latest 顺序 fail closed；document 分区 fallback、duplicate effective-publication 排序和 provider 安全诊断均由单一 pipeline/contract 实现，诊断不进入业务身份。 |
| ADR-021 | 港股公开对象与后台训练宇宙必须分离。 | 公开视图固定为恒生指数、恒生科技指数、港股创新药、头部科技互联网四个对象；后台仍需保留恒生综合 12 个一级行业和可追溯主题代理，避免页面展示范围限制训练横截面。 |
| ADR-022 | 港股主题的主目标是相对恒指表现，不使用两个公开主题的 top-quartile 作为主目标。 | 主题对象使用 `relative_outperformance_vs_hsi` 与 `expected_excess_vs_hsi`；`top_quartile` 只有在横截面至少 4 个对象时作为研究指标，避免小样本目标失真。 |
| ADR-023 | 恒生官方行业历史、官方主题指数代理和第三方分类必须分层登记。 | 第三方或主题代理不得伪装成恒生 HSICS 一级行业；当前成分股名单不得回填过去；历史 OHLC、成分、权重和 ETF 份额必须以显式 point-in-time lineage 与 SHA-256 进入不可变数据集，缺失不得零填。 |
| ADR-024 | HK 研究候选与生产模型严格隔离，质量不足时只能保持 candidate/shadow。 | 每周期必须输出样本数、样本外窗口、AUC、Brier、Brier Skill、RankIC、Top-Bottom/扣费收益差、离散度、完整度、市场状态、概率分布、特征缺失/零方差和 provider 失败；任何周期或数据闸门不足都禁止自动晋升。 |
| ADR-025 | 港股日报日期与数据源观察日期必须分别建模。 | `asOf/sessionDate` 是日报或预测截止日，`sourceAsOf` 是实际 provider 快照日；两者错位时保留诊断并 fail closed，不把未来快照贴到过去日报。未训练未来窗口使用 `outputMode=none`，不得退化为当前观察或默认概率。 |
| ADR-027 | 每日简报采用全球整合主文章，并以预授权触发候选控制重大专项；编辑市场展望与量化模型预测严格隔离。 | 普通波动进入一篇全球主文章，避免固定三市场凑稿；研究包先确定证据、专项资格和失效条件，Writer 只能读取冻结执行包并输出可追溯内容。 |
| ADR-028 | 阶段二三市场研究使用统一不可变 panel manifest，但 raw snapshot identity 与 normalized panel identity 分离；训练只产生研究/shadow 产物。 | A/HK/US 需要共享 session/object/feature/label 审计和可重放 OOS 评价，同时必须保护受限 raw history、冻结 A 股 champion、生产页面和 prediction ledger。 |

## ADR-027 详细冻结（Accepted）

- 每个日报固定生成一个 `global_main` 主文章；`specialReports` 允许 0–2 篇，普通 A 股、港股、美股波动不得分别凑成三篇文章。
- 主文章必须包含今日结论、关键事实、全球逻辑链、跨市场传导、下一交易日展望、未来一周展望、反证与失效条件、下一步观察；机器可读契约为 `global-market-brief-v1`。
- 重大专项只能从冻结研究包中 `eligible=true` 的 `specialTriggerCandidates` 选择，Writer 不得自行发明触发事件；没有 eligible 候选时必须返回空数组。
- 编辑判断使用“市场展望”语义并绑定 `sourceIds`；量化系统的输出继续留在独立冻结 writer packet，使用“模型预测”语义。市场展望不得携带未经模型契约支持的数值概率，`EvidenceScore` 不得重命名为 `probability`。
- Writer 只读冻结执行包，不联网、不新增来源、不改事实、数值、概率、排名、收益、模型状态或历史；Researcher 可以联网，Validator 负责契约和来源引用校验。
- 页面只消费公开 DTO 的标题、导语、结论、逻辑链简表、市场标签、数据截止日、来源数和文章 URL，以及专项标题、触发类型、结论、市场标签和文章 URL；provider 错误、内部状态、路径、堆栈、gate failure、原始研究 payload 和私人 Skill 内容不进入页面 DTO。
- 本 ADR supersede 旧的“每日固定三市场分稿”内容生产习惯，但不重写历史 ADR；P2-B0 只冻结契约，不切换生产内容。

## ADR-028 详细冻结（Accepted）

- fetch 与 engineering 分离：`RUN_FETCH.ps1` 是唯一数据入口，训练入口只接受显式私有 cache，禁止重新搜索供应商或在训练期间联网。
- raw snapshot lineage 与 normalized panel identity 各自有 SHA；相同 identity 同内容必须物理 no-op，identity 冲突必须 fail closed。
- HK/US 主题合法历史不足时保持 `unavailable`；HK/US 指数模型即使有 OOS 训练也保持 shadow/abstained，不向用户页面发布概率。
- A 股当前 champion、文章、UI、Writer、日报/周报 automation 和 prediction ledger 不属于阶段二写入范围。
