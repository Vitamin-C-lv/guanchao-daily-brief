# 本机 Codex Writer 自动化

自动化配置在 `config/codex-writer-automation.json`。它定义两个 Asia/Shanghai 本机 Codex 任务：

- 日报：每天 07:30。
- 周报：每周六 10:00。

两项任务都使用 native Codex automation，模型偏好 `gpt-5.6-luna`，但不依赖 Luna API、外部 LLM API、API key 或外部写手服务。每次运行先由 Researcher 在当前 Codex 任务内收集公开证据并封存 `CODEX_RESEARCH.json`，再由 Writer 只消费 execution package；Writer 阶段禁止浏览、搜索和 API 调用。

任务应在独立的本机 runtime clone `D:\周报个人网站-local-writer-runtime` 中执行，恢复/审计材料放在 `C:\Codex-Recovery\GuanchaoWriter`。runtime clone 不是生产 main worktree；任何生产 apply 都必须显式运行 `codex-writer-finalize.mjs --write`，先通过 writer-result、目标 validator、editorial lint 和保护边界检查。

`publicationEnabled` 固定为 `false`。因此定时任务只负责生成研究记录、execution package、Writer 结果和失败报告，不自行提交、推送、合并或部署。日报/周报发布是单独的受控 finalize 操作；发布时必须保留原始证据、SHA-256、上下文 ID、请求 ID、结果 ID 和 validator 输出。

## Failure handling

研究源不可用、限流或 schema 改变时保留显式状态；不补零、不回填、不猜测。缺少必需绑定时输出 `writer-error-v1`，不生成半成品文章。任务失败只写到 recovery root，不能写入 `data/prediction-ledger`、`public/data/prediction-history`、模型/概率/排名、EvidenceScore、HK/US 模型或 sector rotation 文件。

## Operator commands

```powershell
node scripts/codex-writer-prepare.mjs --edition daily --market-packet content/writer-packets/daily-latest.json --codex-research C:\Codex-Recovery\GuanchaoWriter\CODEX_RESEARCH.json --output C:\Codex-Recovery\GuanchaoWriter\daily-package --write
node scripts/codex-writer-finalize.mjs --package C:\Codex-Recovery\GuanchaoWriter\daily-package --result C:\Codex-Recovery\GuanchaoWriter\daily-result.json --output C:\Codex-Recovery\GuanchaoWriter\daily-finalize.json --dry-run
```

自动化 ID 由 Codex desktop automation service 创建后记录在任务审计报告中；配置文件保留 `automationId: null`，避免把外部服务 ID 伪装成仓库内事实。
