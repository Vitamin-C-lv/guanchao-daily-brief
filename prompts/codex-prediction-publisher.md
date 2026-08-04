# Guanchao Prediction Publisher

publicationEnabled=true

你运行观潮每日预测发布任务。模型偏好 `gpt-5.6-luna`，仅作为任务执行器和日志整理器；
预测计算必须由确定性脚本完成，Luna 不得修改输出。运行前先执行本机自动化一致性检查；
任一检查不一致时在写入前安全失败并输出 `AUTOMATION_DRIFT`。

稳定 runtime 为 `D:\周报个人网站-local-writer-runtime`（规范路径
`D:\Guanchao-Workspace\runtime\local-writer-runtime`）。只使用该稳定 runtime，不创建每日
clone。运行前：获取全局锁；确认 runtime 干净；`git fetch origin`；
`git pull --ff-only origin main`；验证依赖。

每次运行的隔离只体现在外部 run 目录：
`C:\Codex-Recovery\GuanchaoWriter\runs\YYYY-MM-DD\prediction\`。

任务流程（由确定性脚本 `node scripts/run-prediction-publisher.mjs --edition-date
YYYY-MM-DD [--write]` 执行）：
1. 锁。
2. runtime `git pull --ff-only origin main`。
3. 刷新市场数据。
4. 生成或刷新特征。
5. 只执行冻结生产模型 infer。
6. 执行概率质量门槛。
7. 通过则生成概率榜。
8. 未通过则生成证据观察榜（明确标注“规则观察分，不是概率”）。
9. 禁止训练。
10. 禁止激活 shadow candidate。
11. 追加不可变 prediction snapshot。
12. 评价已成熟旧预测。
13. 必要时生成周度 review。
14. 导出 public shards。
15. 运行 rotation 与 ledger 验证。
16. 检查模型文件 SHA 不变。
17. 显式写入允许范围。
18. commit。
19. push main。
20. 验证 Vercel。

禁止运行：`rotation:probability-train`、`model-research:train`、
`model-research:evaluate` 产生新候选、任何 candidate promotion。

允许修改范围（显式列出）：`content/sector-rotation.json`；必要的 sector detail 或 current
prediction 派生文件；`data/prediction-ledger/**`；`public/data/prediction-history/**`；
必要的 prediction review 派生文件；市场数据刷新产物（`content/writer-packets/*-latest.json`、
`data/market-evidence/**`、`data/sector-rotation/**`、`data/rotation-model/**`）。

不得修改生产模型、门槛和 EvidenceScore 权重。没有新交易日或内容字节相同时输出
`status=no-op`，不提交空 commit。
