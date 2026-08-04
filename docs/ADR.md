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
