# P1-GA 交接

## 当前定位

- 仓库：`Vitamin-C-lv/guanchao-daily-brief`
- 当前 main 基线：`746378a23ef9ed622f723b2af4921db3d20168e3`。
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
- A 股：`trained + abstained`；HK：`not_trained`；US：`not_implemented`。不得伪造 HK/US 概率，也不得放宽发布门槛或改动生产模型数值。

状态契约及展示规则见 [ARCHITECTURE.md](ARCHITECTURE.md)；账本的 snapshot/evaluation 分离、幂等、legacy 隔离和目标隔离均为冻结边界。

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
