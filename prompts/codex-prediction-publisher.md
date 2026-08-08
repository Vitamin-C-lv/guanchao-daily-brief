# Guanchao Prediction Publisher deterministic task

publicationEnabled=true
executor=windows-task-scheduler
schedule=Mon-Sat 18:20 Asia/Shanghai
normalPathUsesLlm=false
normalPathLlmTokens=0

Windows Task Scheduler 直接调用 `scripts/run-prediction-publisher-task.ps1`，再由稳定 runtime
执行 `node scripts/run-prediction-publisher.mjs --edition-date YYYY-MM-DD --write`。本任务不启动
AI Agent、不调用模型；禁止训练；禁止激活 shadow candidate；机械数据、冻结模型推断、门禁、账本和
Packet 均由确定性脚本完成。

写入前先运行 `node scripts/check-automation-consistency.mjs`；不一致必须输出
`AUTOMATION_DRIFT` 并停止。无新交易日输出 `status=no-op`。门禁失败时输出“规则观察分，不是概率”。如果 Asia/Shanghai 为周日，launcher 必须输出 `SUNDAY_NO_RUN` 并以 0 退出；不得刷新数据、写 ledger 或生成 Packet。

HSTECH 恢复只使用稳定私有标准化 Sina cache；不使用 ETF 03032、插值、成分股重建或 launch 前
backtest；不因恢复自动 promotion 或发布新的 HK probability。每日任务结束后生成
`DAILY_MARKET_PACKET.json` 与 `PREDICTION_REVIEW_PACKET.json` 到外部 run 目录。
