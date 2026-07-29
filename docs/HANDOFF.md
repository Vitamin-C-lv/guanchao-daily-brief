# P1-B 交接

## 当前定位

- 仓库：`Vitamin-C-lv/guanchao-daily-brief`
- 生产站：`https://guanchao-daily-brief.vercel.app/`
- P1-B merge SHA / main 交接基线：`0120f1be488fca0729b9309c22a1714986a207ab`
- 当前发布阶段：P1-B 已进入 main；无活跃开发分支。
- PR：[#12](https://github.com/Vitamin-C-lv/guanchao-daily-brief/pull/12)，已于 2026-07-29 squash merge。

P1-B 的七个既有提交依次为：`a97c8df` 不可变账本契约、`453b6c1` 云端 snapshot 迁移、`b255a02` evaluation 与周复盘、`1302929` 月度公开分片、`2b55ea6` 历史页、`f264f77` 不可变性与指标测试、`ebb5edc` 自动化验证与归档；合并前治理维护新增 `671c611` 治理文档、`771d040` 周度复盘职责拆分和 `0b602af` Windows CI 收敛。

## 能力与冻结数据

P1-B 以 GitHub 跟踪的不可变 snapshot/evaluation gzip 事件为权威，提供可重建 index/manifest/review/public shard、兼容历史 JSON、`/predictions/history` 按月加载和状态/legacy/目标筛选，以及 main-only 的账本自动化。

- snapshots：9；prediction records：324；evaluation events：300。
- legacy/current：36 / 288；最早/最晚预测：2026-07-21 / 2026-07-24。
- dataset ID：`a-share-2026-07-21-3448b55c8ae4`。
- 生产模型 SHA-256：`358e19ae3dacbfdba71db195c0171c627646f33aaadf39250fb0f7b7cbb994d8`。
- A 股：`trained + abstained`；HK：`not_trained`；US：`not_implemented`。不得伪造 HK/US 概率，也不得放宽发布门槛或改动生产模型数值。

状态契约及展示规则见 [ARCHITECTURE.md](ARCHITECTURE.md)；账本的 snapshot/evaluation 分离、幂等、legacy 隔离和目标隔离均为冻结边界。

## 工作区与环境

原工作区为 `D:\周报个人网站`，可能有用户未提交工作；不得在其上 reset、clean、stash、覆盖或开发。P1-B 使用独立 worktree `D:\周报个人网站-p1b-cloud-prediction-ledger`。Windows 为本地验收环境；Node/pnpm 不在 PATH 时使用 Codex bundled runtime，Python 验证使用项目既有 `uv` 调用。

## 当前技术债与准确下一步

P1-B 已完成并通过本地完整 `pnpm check`、静态构建、Windows `core.autocrlf=true` 隔离验证、GitHub Windows 检查和 Vercel Preview。纯周复盘指标已拆到 `prediction_ledger_review.py`；存储、哈希、不可变性与公开导出语义未变。当前模型缺少可评分的 published current probability 样本，周指标以 null 和 `insufficient_sample` 表示，这是正确语义而不是待填的零。

本轮合并后，下一阶段名称仅为：**P1-C：生产账本运行稳定性与A股生产特征覆盖审计**。不要在本交接所述工作中实施 P1-C。

## 新对话恢复顺序

1. [docs/HANDOFF.md](HANDOFF.md)
2. [docs/ARCHITECTURE.md](ARCHITECTURE.md)
3. [docs/ADR.md](ADR.md)
4. [README.md](../README.md)
5. [package.json](../package.json)
6. 当前任务相关源码
