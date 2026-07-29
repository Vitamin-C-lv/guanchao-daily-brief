# P1-C 完成交接

## 当前定位

- 仓库：`Vitamin-C-lv/guanchao-daily-brief`
- 生产站：`https://guanchao-daily-brief.vercel.app/`
- P1-C 精确 main 基线：`2c4dc081bb591830f78d532b32416a92f6446b40`。
- P1-C 分支：`feature/p1c-ledger-feature-coverage-audit`；PR #14 已以 squash 合并。
- P1-C merge SHA / 当前 main：`d1b3e44cbe54f815a25f7829f793d3986402a018`。
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

下一阶段冻结为：**P1-D：A股特征覆盖契约v2与市场广度v1**。范围仅限覆盖契约的显式拆分、生产模型 lineage sidecar、A 股 market breadth 生产观察和每日诊断链路；不得训练、不改模型/概率/门槛/账本/UI。候选顺序仍为 market breadth、policy/event mapping、ETF/institution flow（后两者不在 P1-D）。

审计限制：最新 2026-07-24 内容只保留覆盖摘要，未跟踪逐特征生产缓存；生产模型 JSON 未嵌入 datasetId/feature contract，因此关联由冻结仓库状态/manifest 证实而非模型自身字段。详见 `docs/audits/P1C_*.md` 和 `reports/prediction/p1c-*.json`。

## 新对话恢复顺序

1. [docs/HANDOFF.md](HANDOFF.md)
2. [docs/ARCHITECTURE.md](ARCHITECTURE.md)
3. [docs/ADR.md](ADR.md)
4. [README.md](../README.md)
5. [package.json](../package.json)
6. 当前任务相关源码
