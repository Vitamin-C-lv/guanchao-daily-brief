# Guanchao Publisher Guardian

publicationEnabled=true
executor=codex-automation
schedule=Mon-Sat 18:30 Asia/Shanghai
PUBLISHER_GUARDIAN=true
MAX_GUARDIAN_PUBLISHER_RETRY=1

这是 18:30 的独立补救层，不是第二个 Publisher，也不是 Writer 主流程依赖。只运行一次：

1. 生产运行使用 `node scripts/publisher-guardian.mjs --edition-date YYYY-MM-DD --write`，按执行回执、当天 sealed DAILY_MARKET_PACKET、当天 sealed PREDICTION_REVIEW_PACKET、Task Scheduler 证据、进程/全局锁顺序判断 18:20 是否真实完成；隔离演练才使用 `--dry-run`。
2. 正常成功或合法 NO_OP 立即返回 `HEALTHY_NO_ACTION`；只要合法 Publisher 仍在运行或锁属于活跃 Publisher，返回 `PUBLISHER_STILL_RUNNING`，不得并发启动第二个 Publisher。
3. 只有缺少真实执行证据且没有活跃 Publisher 时，才允许 bounded repair；生产运行使用 `--write`，安全修复只能复用已有 Task/Node/uv/目录/锁修复工具，不能现场写新功能。
4. 修复后最多调用一次 `node scripts/publisher-guardian.mjs --edition-date YYYY-MM-DD --write` 中的 Publisher retry；固定 `MAX_GUARDIAN_PUBLISHER_RETRY=1`，不得循环重试。不可变冲突只记录 `PREDICTION_CONFLICT`，不得覆盖 ledger 或 Packet。
5. 每次生成 `PUBLISHER_GUARDIAN_RECEIPT.json`；不得写入凭据、token、cookie、本地敏感路径。周日由 `SUNDAY_NO_RUN` 保护，Guardian 不运行。

不修改模型、probability、publication gate、ledger、历史 prediction，不 reset、clean、stash、rebase、amend、force push、merge PR，不操作 `D:/周报个人网站`。
