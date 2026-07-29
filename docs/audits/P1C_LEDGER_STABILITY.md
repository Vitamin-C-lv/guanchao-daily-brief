# P1-C production ledger stability audit

## Result

The Git-tracked ledger is the source of truth and the main-only workflow preserves its append-only contract. The reproducible machine-readable result is [p1c-ledger-stability.json](../../reports/prediction/p1c-ledger-stability.json).

- Write trigger: the normal writer runs only after `validate`, only on `refs/heads/main`, and only for schedule or a non-`validate` `workflow_dispatch` mode. A `dry_run=true` manual dispatch can also run on an audit branch, but its commit/push steps remain disabled.
- Schedules: `30 7 * * 1-5` UTC (15:30 Asia/Shanghai, closing) and `30 10 * * 5` UTC (18:30 Asia/Shanghai, weekly).
- PRs have read-only validation. Only `automate` receives `contents: write`.
- `prediction-ledger-${{ github.ref }}` serializes writers without cancelling an in-progress append.
- `dry_run=true` performs refresh, append, rebuild and verification in the ephemeral runner checkout while skipping commit and push.
- The copied-ledger simulation proved no-op (9 to 9 snapshots), one append (9 to 10), duplicate idempotency, one independent evaluation event (300 to 301), deterministic review rebuild, verify, and byte-identical public export.

## Failure behavior

Immutable gzip events and JSON-derived outputs use same-directory temporary files and replace operations. A failed runner cannot push; before a non-dry-run commit it verifies the full ledger. A lost race fetches/rebases/revalidates and retries push up to three times; any rebase conflict aborts instead of overwriting history.

The static validator requires the exact current `content/sector-rotation.json` publication timestamp to appear in the immutable snapshots. Therefore a changed prediction payload that lacks a snapshot fails validation before and after automation.

## Latest snapshot

The latest snapshot is correctly at 2026-07-24 because the committed publication is exactly `2026-07-24T20:19:06+08:00` and has a matching snapshot. No later committed main publication existed at the audited baseline; this is a post-merge/not-yet-scheduled-run state, not a trigger-chain defect.

No production write is recommended by this audit. GitHub Actions dry-run [30422855704](https://github.com/Vitamin-C-lv/guanchao-daily-brief/actions/runs/30422855704) passed both the Windows contract job and the append/verify job at `05bfcf2`; no snapshot was appended and its commit/push steps were skipped.
