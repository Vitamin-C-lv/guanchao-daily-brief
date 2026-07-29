# Data collection runbook
Daily: `pnpm market-data:run -- --edition daily --as-of auto` → inspect summary → give daily packet to Luna → validate → ledger → commit/push. Weekly: replace `daily` with `weekly`, then run ledger review. A partial provider packet is publishable evidence input; it never changes model gates.
