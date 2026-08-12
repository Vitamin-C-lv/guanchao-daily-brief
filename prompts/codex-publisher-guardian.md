# Guanchao Publisher Guardian

publicationEnabled=true
executor=codex-automation
schedule=Mon-Sat 18:30 Asia/Shanghai
PUBLISHER_GUARDIAN=true
MAX_GUARDIAN_PUBLISHER_RETRY=1

这是 18:30 的独立补救层，不是第二个 Publisher，也不是 Writer 主流程依赖。只运行一次：

1. Guardian 的第一条且唯一正常入口是 `node scripts/publisher-guardian.mjs --edition-date YYYY-MM-DD --write`；隔离演练才使用 `--dry-run`。在该命令之前禁止运行 `writer-production-preflight`、`writer-ready` 或 generic production hard preflight，也不要因为 `automation consistency=false` 直接退出。
2. `publisher-guardian.mjs` 启动后先 bounded `git fetch origin main`，再读取最小 Operations Memory、当天 Packet、Publisher receipt、Task Scheduler 证据、进程/全局锁，最后才比较 canonical repo、runtime 与 fresh `origin/main`。必须保留 `remoteMainBeforeFetch`、`remoteMainAfterFetch`、`runtimeHead` 和 `runtimeReachableFromRemote`。
3. 正常成功或合法 NO_OP 立即返回 `HEALTHY_NO_ACTION`；只要合法 Publisher 仍在运行或锁属于活跃 Publisher，返回 `PUBLISHER_STILL_RUNNING`，不得并发启动第二个 Publisher。runtime clean 且 behind fresh main 只能使用既有安全 `fetch + merge --ff-only` 同步；detached runtime 在 SHA 一致时合法。
4. runtime dirty、runtime 与 fresh remote 无 ancestry、禁止路径、secret/security issue 或 immutable conflict 都是 `NON_REPAIRABLE`/fail-closed，但仍必须写 receipt。runtime ahead 先等待短 bounded grace 并第二次 fetch；若 remote 更新到 runtime HEAD，返回 `HEALTHY_NO_ACTION`，不得重跑 Publisher。
5. consistency failure 在 Guardian 中只是诊断/repair signal，不是前置死门；只允许 deterministic、bounded repair。只有缺少真实执行证据且没有活跃 Publisher 时，才允许 Publisher recovery，固定 `MAX_GUARDIAN_PUBLISHER_RETRY=1`，不得循环重试。不可变冲突只记录 `PREDICTION_CONFLICT`，不得覆盖 ledger 或 Packet。
6. 无论 `HEALTHY_NO_ACTION`、`PUBLISHER_STILL_RUNNING`、`RECOVERED`、`RECOVERY_FAILED`、`CANONICAL_RUNTIME_HEAD_MISMATCH`、`CONSISTENCY_DRIFT` 或 `PREDICTION_CONFLICT`，每次都生成 `PUBLISHER_GUARDIAN_RECEIPT.json`；不得写入凭据、token、cookie、本地敏感路径。周日由 `SUNDAY_NO_RUN` 保护，Guardian 不运行。

不修改模型、probability、publication gate、ledger、历史 prediction，不 reset、clean、stash、rebase、amend、force push、merge PR，不操作 `D:/周报个人网站`。
