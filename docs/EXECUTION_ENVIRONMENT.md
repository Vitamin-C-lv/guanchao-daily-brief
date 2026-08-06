# Project execution environment

- Protected original worktree: `D:\周报个人网站`; use an independent worktree such as `D:\周报个人网站-p1f-writer-job-automation`.
- Use verified Codex bundled Node/pnpm when they are not on `PATH`; Python commands use `uv run --no-project --python 3.12`.
- P1-F targeted commands: `pnpm test:writer-jobs`, `pnpm validate:writer-packet`, `pnpm typecheck`. External review owns `pnpm check` and `pnpm build`.
- Market data: `pnpm market-data:run -- --edition daily|weekly --as-of auto`; preparation: `pnpm production:prepare -- --edition daily|weekly --as-of auto`.
- Validate a result with `pnpm writer-job:validate -- --request <request-path> --result <result-path>`; apply with `pnpm production:apply -- --request <request-path> --result <result-path>`.
- Prediction ledger commands remain separate; writer apply never changes it. The workflow needs only `contents: write`; Vercel deploys only after a reviewed merge to main.
- CSI constituents are currently WAF-unavailable: retain explicit partial/unavailable state and do not bypass, substitute, backfill, or fill zero. On packet validation or immutable identity conflict, stop without committing.

## P1-L restored publication automation (2026-08)

- Native automation state lives in `C:\Codex-Recovery\GuanchaoWriter\automation-state.json`; repository config is `config/codex-writer-automation.json`. Run `pnpm automation:consistency` before any production write; any mismatch prints `AUTOMATION_DRIFT` and must fail closed.
- Stable runtime: `D:\周报个人网站-local-writer-runtime` (canonical `D:\Guanchao-Workspace\runtime\local-writer-runtime`). No per-day clones; per-run isolation is `C:\Codex-Recovery\GuanchaoWriter\runs\YYYY-MM-DD\<edition-or-prediction>\`.
- Daily freshness: `pnpm refresh:writer-packet -- --edition daily` (or `node scripts/refresh-writer-packet.mjs --edition daily --edition-date YYYY-MM-DD`); a packet not generated on the edition date blocks prepare with `STALE_WRITER_PACKET`.
- Predictions: `pnpm prediction:publish -- --edition-date YYYY-MM-DD --write` runs only frozen-model infer, applies gates, appends immutable ledger snapshots, exports public shards, verifies model SHA, commits, pushes and checks Vercel; identical business bytes produce `status=no-op` without an empty commit.
- Stage-2 private research outputs used by the HK/US publication gate live at the stable runtime path `D:\Guanchao-Workspace\runtime\model-research\stage2-three-market` (manifest.json carries per-file SHA-256; never commit these private artifacts). The publisher resolves the path via `--research-output`, `GUANCHAO_STAGE2_RESEARCH_OUTPUT`, or that stable default; dry-run and pre-commit failures restore the runtime exactly (`git status --porcelain` empty, HEAD unchanged).
- Historical `writer-context-v1` artifacts validate their frozen prompt/validator references without re-imposing current file SHAs (`writer-context.mjs validate-context --legacy`, rebuild/scan); new prepare and current apply still require the currently approved validator.
