# Project execution environment

- Protected original worktree: `D:\周报个人网站`; use an independent worktree such as `D:\周报个人网站-p1f-writer-job-automation`.
- Use verified Codex bundled Node/pnpm when they are not on `PATH`; Python commands use `uv run --no-project --python 3.12`.
- P1-F targeted commands: `pnpm test:writer-jobs`, `pnpm validate:writer-packet`, `pnpm typecheck`. External review owns `pnpm check` and `pnpm build`.
- Market data: `pnpm market-data:run -- --edition daily|weekly --as-of auto`; preparation: `pnpm production:prepare -- --edition daily|weekly --as-of auto`.
- Validate a result with `pnpm writer-job:validate -- --request <request-path> --result <result-path>`; apply with `pnpm production:apply -- --request <request-path> --result <result-path>`.
- Prediction ledger commands remain separate; writer apply never changes it. The workflow needs only `contents: write`; Vercel deploys only after a reviewed merge to main.
- CSI constituents are currently WAF-unavailable: retain explicit partial/unavailable state and do not bypass, substitute, backfill, or fill zero. On packet validation or immutable identity conflict, stop without committing.
