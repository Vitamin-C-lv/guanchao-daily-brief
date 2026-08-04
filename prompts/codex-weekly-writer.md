# Codex local weekly writer (publication mode)

publicationEnabled=true
productionApplyRequiresExplicitWrite=true

你运行观潮本机 Codex 周报写手。模型偏好 `gpt-5.6-luna`，仅作为执行器与日志整理器；不依赖
Luna API、外部 LLM API、API key 或外部写手服务。运行前先执行本机自动化一致性检查；任一检查
不一致时在写入前安全失败并输出 `AUTOMATION_DRIFT`，不得继续写生产文件。

稳定 runtime 为 `D:\周报个人网站-local-writer-runtime`（规范路径
`D:\Guanchao-Workspace\runtime\local-writer-runtime`）。每次运行只使用该稳定 runtime，
不再创建 `runtime-clone-YYYY-MM-DD`。运行前：获取全局锁；确认 runtime 干净；
`git fetch origin`；`git pull --ff-only origin main`；验证依赖（缺失时用固定 lockfile 离线
恢复一次）；不得手工追逐 pnpm 软链接。

每次运行的隔离只体现在外部 run 目录：
`C:\Codex-Recovery\GuanchaoWriter\runs\YYYY-MM-DD\weekly\`。

执行流程：
1. 确认最新 prediction evaluations 已完成、本周 review 已生成、weekly packet 已刷新、最新
   日报与预测内容已同步。
2. 刷新 weekly writer packet（现有受控市场数据流程，`--edition weekly --as-of auto`）并验证。
3. Researcher 生成 bounded `CODEX_RESEARCH.json`（约束同日报任务），asOf 与 weekly packet
   业务日期一致。
4. `node scripts/codex-writer-prepare.mjs --edition weekly ... --write` 生成执行包。
5. Luna Writer 只读执行包，返回 `writer-result-v2`；禁止浏览、搜索、外部 LLM 与 API key。
6. `codex-writer-finalize.mjs --dry-run`。
7. 全部门禁通过后 `codex-writer-finalize.mjs --write`。
8. `pnpm validate:weekly`、`pnpm validate:brief`、`pnpm validate:prediction-ledger`、
   `pnpm typecheck`、`pnpm build`。
9. `git diff` 边界检查；commit：`chore(content): publish weekly brief YYYY-Www`；
   push main（不得 force push）；验证 Vercel；更新 automation memory。

Writer 禁止修改概率、排名、EvidenceScore、prediction ledger、sector rotation、生产模型。

## Failure handling

研究源不可用、限流或 schema 改变时保留显式状态；不补零、不回填、不猜测。缺少必需绑定时输出
`writer-error-v1`。任务失败只写到 recovery root 与 run 目录，不得写入 ledger、public history、
模型/概率/排名、EvidenceScore、HK/US 模型或 sector rotation 文件。
