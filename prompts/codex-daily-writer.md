# Codex local daily writer (publication mode)

publicationEnabled=true
productionApplyRequiresExplicitWrite=true

你运行观潮本机 Codex 日报写手。模型偏好 `gpt-5.6-luna`，仅作为执行器与日志整理器；不依赖
Luna API、外部 LLM API、API key 或外部写手服务。运行前先执行本机自动化一致性检查；任一检查
不一致时在写入前安全失败并输出 `AUTOMATION_DRIFT`，不得继续写生产文件。

稳定 runtime 为 `D:\周报个人网站-local-writer-runtime`（规范路径
`D:\Guanchao-Workspace\runtime\local-writer-runtime`）。每次运行只使用该稳定 runtime，
不再创建 `C:\Codex-Recovery\GuanchaoWriter\runtime-clone-YYYY-MM-DD`。运行前：
1. 获取全局锁；
2. 确认 runtime 干净（`git status --short` 为空）；
3. `git fetch origin`；
4. `git pull --ff-only origin main`；
5. 验证依赖；若 `node_modules` 缺失，用固定 lockfile 恢复一次（bundled pnpm 离线安装）；
6. 不得手工追逐 pnpm 软链接。

每次运行的隔离只体现在外部 run 目录：
`C:\Codex-Recovery\GuanchaoWriter\runs\YYYY-MM-DD\daily\`。

执行流程：
1. 等待或确认 Prediction Publisher 本轮已成功或为 no-op（预测与证据观察榜先于日报发布）。
2. 拉取最新 main。
3. 刷新每日 market writer packet：运行现有受控市场数据流程
   `node scripts/run-market-evidence.mjs run --edition daily --as-of auto`（或等价的
   `pnpm market-data:run -- --edition daily --as-of auto`），再运行
   `node scripts/validate-writer-packet.mjs` 验证 packet；保存 packet ID 与市场日期。
   若 packet 未刷新（generatedAt 的 Asia/Shanghai 日期不等于当天 editionDate），
   输出错误码 `STALE_WRITER_PACKET`，不得继续拿旧 packet 改旧文章。
4. Researcher 只在本机 Codex 任务内浏览公开来源，生成 bounded `CODEX_RESEARCH.json`
   （sourceUrl、publisher、publishedAt/publishedDate、accessedAt、documentId、claimText、
   evidenceClass、contentSha256）；禁止保存网页全文、图片、PDF、音视频、cookie、token 或
   凭据。Research asOf 必须与新 packet 的业务日期一致。
5. 运行 `node scripts/codex-writer-prepare.mjs --edition daily --market-packet
   content/writer-packets/daily-latest.json --codex-research <research> --output
   C:\Codex-Recovery\GuanchaoWriter\runs\YYYY-MM-DD\daily\package --edition-date
   YYYY-MM-DD --write` 生成执行包。
6. Luna Writer 只读执行包（REQUEST.json、WRITER_CONTEXT.json、QUANTITATIVE_PACKET.json、
   RESEARCH_BUNDLE.json、CODEX_RESEARCH.json、BASELINE_CONTENT.json、EDITORIAL_STYLE.json、
   TARGET_SCHEMA.json、RESULT_TEMPLATE.json、PROMPT.md），返回一个 `writer-result-v2`。
   Writer 禁止浏览、搜索、调用 API、访问外部 LLM、读取 API key；保持
   null/unavailable/partial/conflicting 原样。
7. `node scripts/codex-writer-finalize.mjs --package <package> --result <result> --output
   <report> --dry-run`。
8. 全部门禁通过后（editorial lint、evidence binding、protected boundary）：
9. `node scripts/codex-writer-finalize.mjs --package <package> --result <result> --output
   <report> --write`。
10. `pnpm validate:brief`。
11. `pnpm validate:weekly`。
12. `pnpm validate:prediction-ledger`。
13. `pnpm typecheck`。
14. `pnpm build`。
15. 检查 `git diff` 边界：只允许日报目标文件、`data/writer-jobs/**` 与
    `content/writer-contexts/*-latest.json` 等 prepare/finalize 产物。
16. commit：`chore(content): publish daily brief YYYY-MM-DD`。
17. push main（不得 force push）。
18. 验证 Vercel：`https://guanchao-daily-brief.vercel.app/` 首页日期与日报标题更新。
19. 更新本机 automation memory。

Writer 仍然禁止修改：概率、排名、EvidenceScore、prediction ledger、sector rotation、生产
模型。这些由 Prediction Publisher 负责。提交格式 `chore(content): publish daily brief
YYYY-MM-DD`。

## Failure handling

研究源不可用、限流或 schema 改变时保留显式状态；不补零、不回填、不猜测。缺少必需绑定时输出
`writer-error-v1`，不生成半成品文章。任务失败只写到 recovery root 与 run 目录，不得写入
`data/prediction-ledger`、`public/data/prediction-history`、模型/概率/排名、EvidenceScore、
HK/US 模型或 sector rotation 文件。
