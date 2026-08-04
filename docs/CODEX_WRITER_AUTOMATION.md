# 本机 Codex Writer 与预测发布自动化

自动化配置唯一事实来源是 `config/codex-writer-automation.json`。它声明三个 Asia/Shanghai
本机 Codex 任务：

- `prediction`：Guanchao Prediction Publisher，每天 06:45，确定性脚本发布概率榜或证据观察榜。
- `daily`：观潮本机 Codex 日报写手，每天 07:30。
- `weekly`：观潮本机 Codex 周报写手，每周六 10:00。

三项任务都使用 native Codex automation，模型偏好 `gpt-5.6-luna`，但不依赖 Luna API、外部
LLM API、API key 或外部写手服务。日报/周报先由 Researcher 在当前 Codex 任务内收集公开证据并
封存 `CODEX_RESEARCH.json`，再由 Writer 只消费 execution package；Writer 阶段禁止浏览、搜索
和 API 调用。Prediction Publisher 由确定性脚本执行计算，Luna 只做执行与日志整理，不得修改
预测输出。

## Publication policy

`publicationEnabled=true`，`productionApplyRequiresExplicitWrite=true`。生产写入（日报、
周报、预测快照）都必须显式通过 `--write`（日报/周报：`codex-writer-finalize.mjs --write`；
预测：`run-prediction-publisher.mjs --write`），并先通过 writer-result、目标 validator、
editorial lint、保护边界检查与 freshness 门禁。原生 Automation 不是自动读取仓库 JSON，
因此 native automation prompt 必须与仓库配置/文档保持一致；一致性检查
`node scripts/check-automation-consistency.mjs` 在写入前校验仓库 config、仓库 docs、native
automation prompt、native schedule、native model 与 runtime 路径，任一不一致时安全失败并输出
`AUTOMATION_DRIFT`。

## Stable runtime and run isolation

任务只使用稳定 runtime `D:\周报个人网站-local-writer-runtime`（规范路径
`D:\Guanchao-Workspace\runtime\local-writer-runtime`），不再创建
`runtime-clone-YYYY-MM-DD`。每次运行前：获取全局锁；确认 runtime 干净；
`git fetch origin`；`git pull --ff-only origin main`；验证依赖；`node_modules` 缺失时用固定
lockfile 离线恢复一次。每次运行的隔离只体现在外部 run 目录
`C:\Codex-Recovery\GuanchaoWriter\runs\YYYY-MM-DD\<edition-or-prediction>\`。

## Freshness gate

日报/周报任务不得直接读取数日不变的 `content/writer-packets/daily-latest.json`。写作前必须
先刷新官方市场数据并生成当天 writer packet：

```powershell
node scripts/run-market-evidence.mjs run --edition daily --as-of auto
node scripts/validate-writer-packet.mjs
```

freshness 门禁要求 packet.generatedAt 的 Asia/Shanghai 日期等于 editionDate（当天），
marketDates 为各市场最新完整交易日且不晚于 editionDate；周末与休市日 editionDate 仍为当天，
市场数据使用最新完整交易日，不把非交易日写成交易日。Researcher 的 asOf 必须与新 packet 业务
日期一致。若 packet 未刷新，prepare 输出错误码 `STALE_WRITER_PACKET` 并停止，不得继续拿旧
packet 改旧文章。门禁检查关系：packet generatedAt、marketDates、source asOf、baseline
editionDate、requestedAsOf 必须形成可解释的一致关系。

## Writer context compatibility

历史 `writer-context-v1` / `writer-request-v2` / `writer-result-v2` 继续代表生成时的 prompt
与 validator：验证历史 artifact 时只校验其自身哈希、contextId 与冻结引用，不要求当前工作树
文件 SHA 等于历史冻结 SHA。新 prompt/validator 会生成新的 contextId；rebuild 不把当前文件
SHA 反向强加给全部历史 context。新的生产 apply 仍必须使用当前被批准的 validator
（`validateRequest`/`validateResult` 默认仍比较当前文件 SHA）。

## Operator commands

```powershell
# 一致性检查（写入前必须通过）
node scripts/check-automation-consistency.mjs

# 刷新并验证 daily writer packet
node scripts/run-market-evidence.mjs run --edition daily --as-of auto
node scripts/validate-writer-packet.mjs

# 日报准备与发布
node scripts/codex-writer-prepare.mjs --edition daily --market-packet content/writer-packets/daily-latest.json --codex-research C:\Codex-Recovery\GuanchaoWriter\runs\<date>\daily\CODEX_RESEARCH.json --output C:\Codex-Recovery\GuanchaoWriter\runs\<date>\daily\package --edition-date YYYY-MM-DD --write
node scripts/codex-writer-finalize.mjs --package <package> --result <result> --output <report> --dry-run
node scripts/codex-writer-finalize.mjs --package <package> --result <result> --output <report> --write

# 预测发布（确定性）
node scripts/run-prediction-publisher.mjs --edition-date YYYY-MM-DD --write
```

自动化 ID 记录在 `C:\Codex-Recovery\GuanchaoWriter\automation-state.json`
（dailyAutomationId / weeklyAutomationId / predictionAutomationId、promptSha256、
configSha256、installedAt、lastVerifiedAt、model、schedule、enabled）；配置文件保留
`automationId: null`，避免把外部服务 ID 伪装成仓库内事实。不要把 Codex 服务凭据写入任何文件。

## Failure handling

研究源不可用、限流或 schema 改变时保留显式状态；不补零、不回填、不猜测。缺少必需绑定时输出
`writer-error-v1`，不生成半成品文章。任务失败只写到 recovery root 与 run 目录，不能写入
`data/prediction-ledger`、`public/data/prediction-history`、模型/概率/排名、EvidenceScore、
HK/US 模型或 sector rotation 文件（Prediction Publisher 除外，它显式负责这些文件的受控更新）。
