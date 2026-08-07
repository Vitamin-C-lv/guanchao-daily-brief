# 自动化规则

- Prediction Publisher 正常路径由 Windows Task Scheduler 在 18:20 Asia/Shanghai 调用确定性脚本；不启动 AI Agent，不训练、不 promotion、不产生 LLM token。
- Daily Writer 在 20:00、Weekly Writer 在周六 10:00 由本机 Codex 调用；写作阶段可在疑点、缺失、冲突、重大政策、异常行情或 18:20–20:00 新事件下主动联网调查。
- 任何 production write 前先运行 `check-automation-consistency.mjs`；不一致必须输出 `AUTOMATION_DRIFT` 并停止。
- Review 阶段只 rehearsal/dry-run：不写 prediction ledger，不执行 Daily article production write，不 merge。
