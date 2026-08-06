# P2-A 港股预测模型研究与数据契约交接

## 当前定位

- 仓库：`Vitamin-C-lv/guanchao-daily-brief`
- 当前主线事实：PR #45 已按 expected head `7279f39a975b19128e4215ee344ab77be16dcc2b` squash merge，merge commit 为 `77915afc9a8d6b3d6554fe440eb04c83e51296c7`；本次收尾提交后的最新 `origin/main` SHA 以最终 fetch 记录为准。
- 本次独立功能分支：`codex/p2a-hk-prediction-model-research`；原工作区 `D:\周报个人网站` 未操作。
- P1-F PR #23 已 squash merge；P1-F merge SHA：`746378a23ef9ed622f723b2af4921db3d20168e3`。
- 当前阶段完成 P1-GA 最终加固 + P1-GB/P1-GC 首批工程包：冻结 `research-bundle-v1` 的 canonical array、canonical UTC timestamp、发布日期精度和 raw snapshot lineage，并实现受限官方采集、不可变存储、daily/weekly builder、dry-run 和 rebuild。
- `config/research-sources.json` 只允许 Federal Reserve RSS、BLS RSS 和 Federal Register JSON；`scripts/research-pipeline.mjs` 是唯一 pipeline，限量 GET、显式 bot identity、无 cookie/auth/browser/重试，RSS/Atom 和结构化 JSON 只保存 bounded metadata/hash/raw response。A_SHARE/HK 没有合规 adapter 时必须为 unavailable；不创建或提交 production artifact。
- P1-G final hardening 要求真正 no-op：raw/source/document/bundle/index/latest 字节相同时 `shouldWrite: false`，不得更新 mtime；rebuild 在派生写入前验证全部 raw gzip/hash/唯一性与 source/document lineage；无日期 document 使用 bundle asOf 仅作分区。
- `research:run` 必须显式选择 `--dry-run` 或 `--write`，验收只在 temp/sandbox 测试 write。官方 dry-run summary 提供受控 `sourceDiagnostics`，不保存响应正文、headers、cookies、token、堆栈或敏感 query。Federal Register 零结果为 ready，feed offset 日期保留来源日历日。
- 原 P1-F 恢复资料保留于 `D:\Codex-Recovery`，不进入仓库。
- 生产站：`https://guanchao-daily-brief.vercel.app/`
- P1-C 精确 main 基线：`2c4dc081bb591830f78d532b32416a92f6446b40`。
- P1-C 分支：`feature/p1c-ledger-feature-coverage-audit`；PR #14 已以 squash 合并。
- P1-C merge SHA：`d1b3e44cbe54f815a25f7829f793d3986402a018`。
- P1-C 交接 PR #15 merge SHA / P1-D main 基线：`2ac399be0b12f74f8e83f4c59184dde706430dc3`。
- P1-D PR #16 已以 squash 合并；P1-D merge SHA：`ee00cf1220f7e906c80b9038edfd113bfa861f4a`。
- P1-C 审计已完成：账本的本地隔离 no-op、单次 append、重复幂等、独立 evaluation、review 重建、verify 与两次公开导出字节一致均已验证；GitHub dry-run 也已通过。

P1-B 的不可变账本边界保持不变。P1-C 没有修改账本 Schema、snapshot/evaluation 身份规则、模型、dataset 或页面。

## 能力与冻结数据

P1-B 以 GitHub 跟踪的不可变 snapshot/evaluation gzip 事件为权威，提供可重建 index/manifest/review/public shard、兼容历史 JSON、`/predictions/history` 按月加载和状态/legacy/目标筛选，以及 main-only 的账本自动化。

- 审计前后的受跟踪账本：snapshots 9；prediction records 324；evaluation events 300。
- legacy/current：36 / 288；最早/最晚预测：2026-07-21 / 2026-07-24。
- dataset ID：`a-share-2026-07-21-3448b55c8ae4`。
- 生产模型 SHA-256（未变）：`358e19ae3dacbfdba71db195c0171c627646f33aaadf39250fb0f7b7cbb994d8`。
- A 股：`trained + abstained`；HK 生产模型仍为 `not_trained`，但 P2-A 已登记独立 `candidateStatus=shadow` 研究契约；US：`not_implemented`。不得伪造 HK/US 概率，也不得放宽发布门槛或改动生产模型数值。

## P2-A：港股预测模型研究与数据契约（2026-08-04）

- 后台训练宇宙与公开视图分离：训练宇宙为恒生综合 12 个一级行业、恒生指数、恒生科技指数、恒生上海深港创新药精选 50 指数代理和恒生互联网与资讯科技指数代理；公开视图固定为恒生指数、恒生科技指数、港股创新药、头部科技互联网四个对象。映射见 `models/sector-rotation/hk-training-universe-v1.json` 与 `hk-public-universe-v1.json`。
- 12 个一级行业保留恒生官方代码和官方分类身份；主题代理明确 `officialClassification=false`，不得被改写成恒生官方行业历史。当前成分股名单不得回填历史，缺失值保留 `null`。
- 港股目标独立于 A 股：指数对象使用 `absolute_up` / `expected_return`；主题对象使用 `relative_outperformance_vs_hsi` / `expected_excess_vs_hsi`；`topQuartile` 只在横截面至少 4 个对象时作为研究指标，不是两个公开主题的主目标。
- 1/5/20 交易日分别训练和验证；契约固定 walk-forward、purged time-series split、按周期 embargo、训练窗口内标准化，以及只有在样本外区分度成立后才可校准。
- 当前仓库可追溯的港股历史长度：`0` sessions、`0` rows；只有恒生官方当前行业快照和静态月末/研究资料，没有可验证连续历史面板。港股研究报告因此为 `insufficient-data`、候选 `shadow`，不写生产模型或预测账本，不返回默认 50% 概率；静态轮动 DTO 只同步 `sourceAsOf`、四对象 `publicUniverse` 和 fail-closed 状态，不承载预测结果。
- 官方来源边界：恒生官方历史 OHLC 资料存在下载/授权边界；HKMA 的 HIBOR、USD/HKD 接口和美国财政部 2Y 资料只登记为 collector-ready，未在本分支假设历史已存在。南向、ETF、point-in-time 成分/权重、USD/CNH 失败状态全部显式记录。
- 日期错位根因是实时恒生快照的 `sourceAsOf` 与日报 `sessionDate/asOf` 被旧实现硬合并。现在保留两者，错位时 fail closed；未训练未来窗口为 `outputMode=none`，不再复用 `current_observation`。
- 研究数据身份已区分：无 `data/model-research/hk/panel.csv.gz` 时 `datasetId=null`，只生成独立的 `researchContractId`；面板存在时才验证 gzip、必需列、真实日历日期、`objectId` 和重复行，并将 raw gzip SHA-256 纳入 dataset identity。身份不使用文件 mtime、绝对路径或运行时间。
- P2-A 研究入口：`scripts/hk_model_research.py`；契约：`data/model-research/hk-contract.json`；来源登记：`data/model-research/hk-source-registry-v1.json`。`pnpm model-research:validate` 同时验证既有 A 股研究契约和 HK candidate-only 契约。
- P2-A 没有修改 A 股生产模型、概率阈值、历史账本、公开页面 UI 或原始工作区；仅同步港股 `content/sector-rotation.json` 的日期血缘、公开四对象映射和弃权状态。接入真实历史前，必须先提交显式 panel、交易日历、来源/成分/权重 lineage 与 SHA-256，再按三周期补齐指标和质量闸门。
- 模型路由按 ADR-026 执行：默认 GPT-5.6 Luna Max；同一根因连续两轮失败，或涉及复杂统计、数据泄漏、概率校准、walk-forward 设计时才升级 GPT-5.6 Sol；升级前必须有脱敏 failure bundle。ADR-026 已明确 supersede ADR-007，不重写历史决策。

状态契约及展示规则见 [ARCHITECTURE.md](ARCHITECTURE.md)；账本的 snapshot/evaluation 分离、幂等、legacy 隔离和目标隔离均为冻结边界。

## P2-A 合并收尾（2026-08-05）

- PR #45 已 Ready 并 squash merge；merge commit 为 `77915afc9a8d6b3d6554fe440eb04c83e51296c7`。本阶段完成的是港股研究契约，不是已训练港股模型。
- 港股仍为 `0 rows / 0 sessions`；无 panel 时 `datasetId=null`，独立 `researchContractId` 保留，候选保持 `shadow`，未训练港股模型，未发布港股概率。
- 下一阶段尚未启动；不开始港股历史数据采集、模型训练、公开 DTO、UI 改版或美股任务。
- 日报和周报自动化目前由用户主动暂停；本次收尾未恢复、创建或修改任何 automation。

## 工作区与环境

原工作区为 `D:\周报个人网站`，可能有用户未提交工作；不得在其上 reset、clean、stash、覆盖或开发。P1-B 使用独立 worktree `D:\周报个人网站-p1b-cloud-prediction-ledger`。Windows 为本地验收环境；Node/pnpm 不在 PATH 时使用 Codex bundled runtime，Python 验证使用项目既有 `uv` 调用。

## P1-C 覆盖结论与准确下一步

`modelInputCompleteness=100%` 是冻结 26 输入向量的完整性；`productionFeatureCoverage=50%` 是五个生产级差异特征组中仅量价相对强弱（25%）和成交额/量（25%）已实现的加权状态。缺失组为 market breadth（20%）、ETF/institution flow（20%）、policy/event mapping（10%）。概率校准、1 日扣费后 spread、当前 published probability 样本等既有门禁仍未通过，未被放宽。

## P1-D：A股特征覆盖契约v2与市场广度v1（已合并）

- P1-D 分支：`feature/p1d-a-share-market-breadth`；合并前 HEAD：`5cb0f2814cb0b5a0d0fc6bc16e257f4d61019b4a`；本地 Windows 工作树：`D:\周报个人网站-p1d-a-share-market-breadth`。
- coverage contract：`prediction-feature-coverage-v2`。`modelInputCompleteness=26/26=1.00`；`modelFeatureCoverage=0.50`，兼容字段 `productionFeatureCoverage` 明确标记为其 deprecated alias；`productionSignalCoverage=0.50`、`trainingReadyCoverage=0.50`、`providerHealthCoverage=0.50`，直到真实 breadth 运行质量改变该运行态值。
- 生产模型 lineage sidecar：`models/sector-rotation/a-share-relative-probability-v2.lineage.json`，绑定模型 SHA、datasetId、manifest SHA 和 feature/label/benchmark 契约；不修改模型字节。
- marketBreadth v1：成员关系使用 CSI 官方成分文件，行情使用现有腾讯公开日 K 路径。只允许当日 15:05（上海）以后为当日写不可变 snapshot；禁止用当前成员关系回填历史，未形成点时历史前 `trainingReady=false`。
- 当前真实生产采集状态：CSI 成分关系接口在 2026-07-29 收盘后连续两轮返回 403；没有写入任何 breadth snapshot，也没有以第三方名单、旧名单或零值降级。市场广度为 `unavailable`，`productionReady=false`、`trainingReady=false`；冻结量价模型与 0.50 发布门槛保持不变。
- 剩余缺失组：marketBreadth 需先恢复官方成员关系可用性；policy/event mapping 与 ETF/institution flow 未开始。

## P1-E：确定性市场数据采集管线v1与美债核心因子组

P1-E 从 P1-D 合并后的 main 开始。它固定数据采集、不可变运行快照、writer packet 和 Luna 写作边界；美债因子只作为证据观察，不进入冻结模型、概率或发布门槛。marketBreadth 只可评估一个严格限定的、精确 CSI 指数代码的补充来源；不得历史回填或改变 taxonomy。

P1-E PR #18 已合并；merge SHA：`16cde0056432b7d839420f545bbabbc4f49475a0`。固定入口为 `pnpm market-data:run -- --edition daily|weekly --as-of auto`；运行时读取启用的 source catalog，通过显式 sourceId 映射生成不可变 run 和 writer packet。相同业务输入的 runId/writerPacketId 稳定，运行审计时间不参与身份。

- Treasury：名义曲线与实际曲线是独立官方 XML 来源。2026-07-29 的最近可用数据为 2026-07-28；2Y/10Y/30Y/real10Y、2s10s 与 1/5/20 个美国有效交易日 bp 变化均保存为 evidence observation。名义/实际日期不同为 partial，超过 catalog 的美国交易日延迟为 stale；`causeAssessment=insufficient_data`，不得把曲线形态写成因果结论。
- writer packet：`content/writer-packets/daily-latest.json` 与 `weekly-latest.json` 是唯一的量化写作输入；validator 重算身份/hash，并验证 factId、sourceIndex、有限/null 值、单位、日期和 real10Y lineage。Luna 只可读取 packet，禁止自主抓取。
- Breadth：CSI WAF 下成员来源仍是 `unavailable`，packet 因此为 partial；未接受补充来源，未写 breadth snapshot，未零填充或历史回填。这不会阻断冻结量价模型。
- P1-E 不训练模型、不改变 EvidenceScore、概率、排名、发布门槛、UI、dataset 或 prediction ledger。生产模型 SHA 仍为 `358e19ae3dacbfdba71db195c0171c627646f33aaadf39250fb0f7b7cbb994d8`；dataset ID 仍为 `a-share-2026-07-21-3448b55c8ae4`；账本仍为 9 snapshots / 324 prediction records / 300 evaluations。

下一阶段仍需由架构负责人冻结；任何 breadth 接入必须先取得可审计、点时的精确 CSI 成分关系，禁止以当前名单回填历史。

审计限制：最新 2026-07-24 内容只保留覆盖摘要，未跟踪逐特征生产缓存；生产模型 JSON 未嵌入 datasetId/feature contract，因此关联由冻结仓库状态/manifest 证实而非模型自身字段。详见 `docs/audits/P1C_*.md` 和 `reports/prediction/p1c-*.json`。

## 2026-07-29 Treasury bp 规范化与品牌资产刷新

- Treasury 热修：PR #20 已以 squash 合并；merge SHA / 后续 Logo 基线：`b3ed821d961ebda39d1b683bcf976d0d19cd0a31`。writer packet 中 `spread2s10sBp` 的 `35.00000000000006` 已规范化为 `35`；所有 bp 值与 1/5/20 日 bp 变化统一最多两位小数，`null` 仍为 `null`。
- Logo：PR #21 已以 squash 合并；merge SHA / 本次交接同步前 main：`a756a7bdf407888d0ceeb80f9ae7b33053e5f48a`。横版源文件为 `public/brand/guanchao-logo-horizontal.png`，方形 mark 为 `public/brand/guanchao-logo-mark.png`；App Router 图标为 `app/icon.png` 与 `app/apple-icon.png`，并保留 32/16px PNG favicon。
- 本次仅变更 writer packet 数值展示与品牌资产/图标接入：未训练模型，未改变 EvidenceScore、概率、预测逻辑、数据源、dataset、ledger、发布门槛或预测页面信息架构。

## 新对话恢复顺序

1. [docs/HANDOFF.md](HANDOFF.md)
2. [docs/ARCHITECTURE.md](ARCHITECTURE.md)
3. [docs/ADR.md](ADR.md)
4. [docs/EXECUTION_ENVIRONMENT.md](EXECUTION_ENVIRONMENT.md)
5. [docs/WRITER_PACKET_CONTRACT.md](WRITER_PACKET_CONTRACT.md)
6. [docs/DATA_COLLECTION_RUNBOOK.md](DATA_COLLECTION_RUNBOOK.md)
7. [docs/RESEARCH_BUNDLE_CONTRACT.md](RESEARCH_BUNDLE_CONTRACT.md)
8. [`data/research-bundles/contract.json`](../data/research-bundles/contract.json)
9. [README.md](../README.md)
10. [package.json](../package.json)
11. 当前任务相关源码

## CI automation consistency portability

- scripts/test-automation-consistency.mjs creates a minimal temporary guanchao-financial-writer Skill fixture and passes its explicit skillDirectory into checkAutomationConsistency; positive tests no longer depend on runner HOME or a private local Skill.
- The fixture also removes a required Skill file and verifies that the production check remains fail closed. pnpm check invokes the isolated unit test only; the production automation:consistency CLI still uses its real local paths and retains WRITER_SKILL_MISSING/AUTOMATION_DRIFT behavior.

## P1-F writer job queue

P1-F is queue/apply infrastructure: immutable packet snapshot → writer request → externally
supplied result → contract validation → atomic daily/weekly apply with rollback. It provides
immutable packet snapshots, request/result queue files, deterministic accepted gzip, manual request
preparation, and rebuildable index/pending pointers. It does not provide a research bundle,
automatic Luna execution, automatic publication, or scheduled writing; the workflow is
manual-only until immutable `writer-context-v1` exists.

The next frozen inputs are `research-bundle-v1` and `writer-context-v1`. A future context must
reference the immutable quantitative writer packet, immutable qualitative research bundle,
immutable baseline content, and each artifact's SHA and Schema version. Luna must still not browse
autonomously. P1-F never trains a model, changes EvidenceScore, probabilities, rankings or gates,
or touches the prediction ledger.

## P2-B0 全球整合主文章契约冻结（2026-08-05）

- P2-A 已完成：港股仍为 `0 rows / 0 sessions`，候选保持 `shadow`，未训练港股模型，未发布港股概率。
- PR #47 已以 squash merge 合并；merge commit 为 `a1c2956149f92d628c81968380e1bd15ed4d8375`；合并后、docs-only 收尾提交前的最新 `main` SHA 为 `a1c2956149f92d628c81968380e1bd15ed4d8375`。
- P2-B0 已完成并冻结：`global-market-brief-v1`、`global-market-brief-public-dto-v1` 和 `global-market-event-v1`，包括最小契约、正负 fixture、契约测试和 P2-B 并行边界；当前生产文章仍未切换，无真实 Writer 输出、无 UI 变化、无模型变化。
- 旧写作链仍为 `writer-context-v1 → writer-request-v2/result-v2 → scripts/writer-jobs.mjs → content/daily-brief.json`；当前三市场分稿产生/落盘位置为 `content/daily-brief.json` 的 `markets[]`，并由 `scripts/validate-brief.mjs` 强制三市场结构。旧 `daily-brief-v1` 在 P2-B4 集成完成前保留，禁止长期双写。
- 自动化仍暂停；本任务没有恢复、创建或修改日报/周报 automation。下一阶段允许从同一个最新 `main` 并行启动 P2-B1、P2-B2、P2-B3；三个 lane 的兼容性由 P2-B4 集成。
- B1 负责研究包、Writer context、生成链、Validator、editorial lint；B2 负责本机 `guanchao-financial-writer` Skill 与质量规则且不提交私人 Skill 正文；B3 负责首页、简报列表、全球主文章卡和专项区。三 lane 不得互相修改热点文件。
- 港股仍没有历史数据和训练；未训练港股模型、未发布港股概率。本阶段也没有美股模型、新数据源、知识图谱、向量数据库或自动化恢复。

## P2-B4A：全球整合文章集成与真实预览（Draft）

- 当前状态：`Draft`，只在分支 `feature/p2-b4-global-brief-integration-preview` 与独立工作树 `D:\Guanchao-Workspace\worktrees\active\p2-b4-global-brief-integration-preview`；不合并、不发布生产、不恢复 automation。
- 前置合并已核对：B1 PR #49 merge SHA `ea0298a4bc75773d46f60becb43c4caf3cead600`；B3 PR #48 merge SHA `cc2a82fc717337c4eae9ed687d63e6930ae9851d`。
- 本次真实冻结输入：research bundle `4c06451a13ac33985c4f8058247d3342e646608ba4cd2df62e4829157759c1d7`（asOf `2026-08-03`、7 documents、4 observations）；writer packet `b2d544c8fc01b1dae46ee0fe42a0215c43beb7ef2121555e67bd4883d838b752`（`partial`，market breadth 仍 unavailable，不回填、不零填）。
- 真实结果：主文章 `global-market-brief-2026-08-04`，标题“海外风险偏好回暖，估值修复仍等本地确认”，`dataAsOf=2026-08-03`；无合格专项文章，唯一 routine volatility trigger 为 `eligible=false`，不将普通波动升级为专项报告。
- 受限写入器只允许并已实际写入两份 feature-branch 内容：`content/global-market-briefs/2026-08-04.json` 与 `content/global-market-brief-public.json`。公开 DTO 为字段白名单投影，不暴露内部 diagnostics、Writer context、packet 或 ledger。
- 隔离恢复实跑：contextId `1273b93110e875da32114fbc93e46c9daf04fd19dfc013c4fcc1378cc510a5e4`；job/requestId `babe97de39fe7f16fa4445b31cb5d689edf2f2623fa424f13a56bc2f512ad51a`；resultId `f1c4214480cf0e8b451d3053ce73f99543682c44045f129b12a34c9ef44daecc`。dry-run 报告 `wrote=false`、`productionApply.applied=false`；显式 write 报告 `wrote=true`、`targetValidation.status=valid`，但 `productionApply.applied=false`，保护边界 328 项 unchanged。
- 初始实现提交为 `e534be1`，文章读取器/真实内容收尾提交为 `912560d`；B4A 不改变预测模型、概率、排名、发布门槛、prediction ledger 或生产内容。
- Draft PR #50：<https://github.com/Vitamin-C-lv/guanchao-daily-brief/pull/50>；Dataset validation、Ledger contract、Vercel 与 Vercel Preview Comments 均通过；ledger publish job 按策略 `skipping`。Vercel deployment：<https://guanchao-daily-brief-git-f-2288a4-lxy13738164923-3443s-projects.vercel.app>。
- 远端 Preview 已部署，但匿名访问被 Vercel protection 重定向到登录页，因此不把远端匿名页面冒充为已目视验收。使用同一 commit 的 `out/` 静态导出在本地 `http://127.0.0.1:3102` 做了真实 DOM/截图 QA：`/`、`/briefs/`、`/articles/global-market-brief-2026-08-04/` 在 1920/1440/390 宽度均无横向溢出；文章标题、跨市场传导、下一交易时段、未来一周、失效条件、来源实际渲染，无 404/Application error。截图证据保留在 `D:\Guanchao-Workspace\temp\p2-b4-global\screenshots\local-dismissed\`。

## P2-B 合并与本机自动化恢复收尾（2026-08-06）

- PR #50 已 squash merge，merge commit：`14110781d301aaf37b05ee3bd92b478115963946`；本收尾提交前最新 `main`：`14110781d301aaf37b05ee3bd92b478115963946`。
- P2-B 全球整合日报正式完成；生产页面切换到全球主文章；同 editionDate 的旧三市场分稿降级为历史，不再作为首页主叙事。
- 日报 automation `观潮本机 Codex 日报写手` 已恢复并启用，既有 Asia/Shanghai 07:30 时间表保持不变；global_market_brief dry-run 通过：1 个 `global_main`、0 个专项、`wrote=false`、`productionApply.applied=false`，未写生产。
- 周报 automation `观潮本机 Codex 周报写手` 已恢复并启用，既有 Asia/Shanghai 周六 10:00 时间表保持不变；既有周报语义、全球日报历史与 ledger 校验通过，未写生产、未 push。
- `pnpm automation:consistency` 通过；正式 runtime 为 `D:\Guanchao-Workspace\runtime\local-writer-runtime`，正式 Skill 为本机 `guanchao-financial-writer`。
- 港股仍未训练、未发布概率。下一大阶段是：“三市场预测数据与模型核心”。

## 阶段二三市场模型核心交接（2026-08-06）

- 冻结基线：`9c8869fc3193a57e83ce46bde40c96c3aba8af41`；实现分支：`feature/stage2-three-market-model-core`。
- 私有数据采集严格使用附件 `SOURCE_MANIFEST.json` 和 `RUN_FETCH.ps1`；raw history 不进入 Git 或 Review ZIP。采集源失败保留真实状态，不更换供应商、不把 USD/CNY 改名为 USD/CNH、不把 HSTECH 回测值混入正式历史。
- 新入口：`scripts/three_market_model_core.py`。它只消费显式 cache，产出非空 HK/US 指数 panel manifest、prior-only 特征、1/5/20 标签、purge+embargo OOS 指标和 shadow model cards；主题对象无合法历史时为 `unavailable`。
- A 股继续使用现有 `models/sector-rotation/datasets/a-share/...` contract 和 champion replay，只生成 challenger recommendation；不得自动替换 champion。
- 生产边界：`content/`、预测 UI、Writer Skill、日报/周报 automation、三套生产模型和 `data/prediction-ledger/` 均必须保持字节不变；`LEDGER_DRY_RUN.json` 只能证明未 append。
- 定向测试：`pnpm test:three-market`；完整仓库检查仍按本阶段验收执行，失败必须保留真实日志，不得删除门禁。

## 阶段二 PR #51 合并收尾（2026-08-06）

- PR #51 已按 expected head `31c99cbcfc89c703042f0e784429dad584b6056b` 转 Ready 并 squash merge；merge commit：`06a4b9b27ba32eb4ee26550f12bb8bedf035f818`。
- 本次合并后 main 验证基线：`06a4b9b27ba32eb4ee26550f12bb8bedf035f818`；Dataset portability、Prediction ledger contract 和 Vercel main 均通过，Vercel 状态为 Ready。
- 阶段二“三市场预测数据与模型核心”已完成；A 股 dataset 为 `ready`，challenger 已按冻结协议完成真实 OOS 数值比较，`promotionRecommendation=keep-champion`，现有 A 股 champion 保持不变；exact production champion artifact replay 仍不可用。
- HK dataset 为 `partial`：HSI 的 1/5/20 模型均为 `trained`、`shadow`、`abstained`；HSTECH 仅 1 条有效记录，1/5/20 均为 `insufficient_data`；港股创新药与科技互联网均为 `unavailable`。
- US Nasdaq dataset 为 `ready`；Nasdaq 1/5/20 均为 `trained`、`shadow`、`abstained`。Nasdaq 20 日的正向研究指标只属于研究观察，不得自动解释为可发布模型。
- HK/US 尚无 production publication gate；没有发布 HK/US 概率，没有写 production prediction ledger。
- 日报与周报 automation 保持原 `ACTIVE` 状态和原时间表：日报 Asia/Shanghai 07:30，周报 Asia/Shanghai 周六 10:00；本次未修改 automation。
- 本次未修改文章、UI、Writer Skill；未替换 A 股 champion；未写 production ledger。
- 下一大阶段：“预测产品发布与持续复盘”。

## 阶段三：预测产品发布与持续复盘（2026-08-06，Draft）

- 冻结基线：`main@7b396ed5b3d7681a4e1127365858d67637d78497`；分支：`feature/stage3-prediction-product-release`；独立 worktree：`D:\Guanchao-Workspace\worktrees\active\stage3-prediction-product-release`；原工作区 `D:\周报个人网站` 未操作。
- HK/US publication gate v1：registry `data/model-research/prediction-publication-gates-v1.json` + schema `schemas/prediction-publication-gate-v1.schema.json` + validator `scripts/prediction-publication-gate.mjs`。用阶段二私有输出（`D:\Guanchao-Workspace\temp\stage2-run-fix-r3`）验证 15 个 horizon 全部 blocked：HSI 1/5/20 `abstained`、HSTECH `insufficient_data`、港股创新药/科技互联网 `unavailable`、Nasdaq 1/5/20 `abstained`；`probabilitiesPublished=false`，无默认 50%。
- PublicPredictionView v1：schema `schemas/public-prediction-view-v1.schema.json`、类型 `lib/public-prediction-view.ts`、builder `scripts/build-public-prediction-view.mjs`、validator `scripts/validate-public-prediction-view.mjs`；唯一公开权威输入 `public/data/predictions/current.json`。A 股映射现有生产观察榜，HK/US 不携带任何概率；私有字段泄漏测试与确定性 no-op 已通过。
- `/predictions` 专用页面：新组件见 ARCHITECTURE.md；URL `?market=a-share|hk|us` 刷新/分享保持；A 股观察榜保留 12 项排名与证据分；HK/US 只显示状态与原因；390px 无横向溢出；五项底部导航不变。
- 历史页：保留按月分片与 SHA-256 校验；新增当前三市场状态摘要与“数据不足”筛选；`stateLabel` 增加“数据不可用”；弃权/不足/未训练不计错误。
- 账本：`prediction_ledger.py` 新增 state-only snapshot（`build_state_snapshot`/`append_state_snapshot`/`collect_states`/CLI `append-state`），`prediction_ledger_automation.py` 支持 `--states`；概率字段恒为 null、evaluation 不适用、相同状态跨天幂等、状态变化才新增 snapshot；派生 index/manifest/public shard 已重新生成（新增 `stateRecordCount`/`unavailable`/`stateCount`），不可变 snapshot/evaluation gzip 未改动。sandbox 验证：append → 幂等 → rebuild → export → verify 全通过；PR 审查阶段未写生产 ledger。
- Publisher：`run-prediction-publisher.mjs` 新增 gate → DTO → DTO validator → ledger states 步骤；写入白名单仅增加 `public/data/predictions/`；阶段二私有输出通过 `--research-output`/`GUANCHAO_STAGE2_RESEARCH_OUTPUT` 传入（本机默认 `D:\Guanchao-Workspace\temp\stage2-run-fix-r3`），缺失时 `PRIVATE_OUTPUT_MISSING` fail closed。
- 自动化：本机 `guanchao-prediction-publisher`（Asia/Shanghai 06:45 ACTIVE）与日报/周报 automation 均未改动、无重复任务；`pnpm automation:consistency` 通过（已把本机 automation-state 的过期 `configSha256` 刷新为冻结基线配置的 SHA，未改任何时间表/启用状态；备份 `automation-state.json.stage3-bak-20260806`）。
- 截图：11 张全部来自最终 commit 的静态导出（1920/1440/390，含 fixture 两张），DOM 断言记录 overflow/概率数/导航数/状态卡数；fixture 截图只进 Review ZIP，不建立生产测试路由。
- 测试：`pnpm typecheck`、`git diff --check`、gate/DTO/publisher/ledger/DOM 定向测试通过；完整 `pnpm check` 与独立 build 结果见 Review ZIP 的 TESTS.txt。
- 当前状态：Draft PR，未 Ready、未 merge；生产账本未写；模型 SHA 未变；A 股 champion 未替换；HK/US 未发布概率。
