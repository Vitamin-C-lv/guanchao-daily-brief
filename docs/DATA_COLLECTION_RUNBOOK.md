# Deterministic market-data runbook

P1-E has one supported data path: collector → normalized facts → quality checks
→ immutable run → writer packet → immutable writer request → validated writer result → atomic content apply → prediction ledger.
Luna never substitutes for collection or validation.

## Daily

1. Preview the request without writing: `pnpm market-data:run -- --edition daily --as-of auto --dry-run`.
2. Run `pnpm market-data:run -- --edition daily --as-of auto` after reviewing its machine-readable summary.
3. Run `pnpm validate:market-data` and `pnpm validate:writer-packet`.
4. Run `pnpm production:prepare -- --edition daily --as-of auto`; supply only its request and named packet to Luna.
5. Validate with `pnpm writer-job:validate -- --request <request-path> --result <result-path>`, then dry-run apply before external full validation. Only after those checks may the
   usual prediction-ledger automation be considered; the packet does not alter model gates.
6. Commit and push only the validated content and any intended immutable artifacts.

## Weekly

Use the same order with `--edition weekly`, then give its immutable request and named packet to Luna. Validate and dry-run apply before external full validation,
rebuild the normal ledger review, then commit and push. A weekly packet is not a model review
and cannot change probabilities or rankings.

## Idempotency and retries

`runId` and `writerPacketId` depend on requested market date, source identities and normalized
business facts—not on wall-clock audit timestamps. Repeating the same successful input is a
no-op for the immutable run. A conflicting payload at the same identity fails rather than
overwriting history. Retry a transient source failure with the same command; do not edit a
prior run or fill a missing datum with zero.

## Partial and stop conditions

The CSI membership source may be `unavailable` because of its documented WAF. This produces a
partial packet and leaves market breadth unavailable; it never blocks the existing frozen
price/turnover model or authorizes historical backfill. Treasury `partial`, `stale`, or
`unavailable` may be described only as such and cannot support a deterministic rate narrative.
Do not publish if packet validation fails, a required source is unavailable, structured content
contains a numeric fact without its packet factId, or a stale/unavailable value is called latest.

## Source discipline

The catalog in `config/market-evidence-sources.json` is the runtime entry point. Disabled
sources are never called. Each enabled source appears in the immutable run, including failures;
the source result retains URL, status, parser/normalizer versions and raw response hash but not
raw XML or HTML. No cookies, browser automation, WAF challenge parameters or user credentials
are used.
