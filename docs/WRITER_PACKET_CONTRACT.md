# Writer packet contract

`content/writer-packets/daily-latest.json` and `weekly-latest.json` are derived latest views;
the matching immutable run is authoritative. A packet has schemaVersion, stable
`writerPacketId`, real `generatedAt`, market dates, facts, Treasury factor, breadth status,
provider health, warnings, sourceIndex and integrity hashes. The identity intentionally excludes
runtime timestamps so a repeat of identical business input retains the same packet identity.

Every numeric fact has a unique `factId`, finite numeric value or `null`, unit, 1/5/20-session
bp changes, `asOf`, `releasedAt`, status, sourceId and sourceUrl. `null` is never zero.
`sourceIndex` covers every fact source. Treasury nominal facts cite
`us-treasury-nominal-xml`; real 10Y cites `us-treasury-real-xml`. Nominal and real dates must
match before the overall Treasury factor can be ready.

Statuses are `ready`, `partial`, `stale`, `unavailable`, `rate_limited`, or `schema_changed`.
Partial/stale/unavailable facts cannot be presented as latest or turned into a deterministic
conclusion. Market breadth may remain unavailable under CSI WAF; this is a visible absence, not
a zero or a substitute current-membership historical calculation.

Validate packets with `pnpm validate:writer-packet`. The validator recomputes packet and
integrity identities, checks fact/source lineage, finite/null semantics, units, Treasury source
separation and dates. Structured content validation must require numeric claims to retain the
packet factId and matching value/unit/asOf.

## Writer request/result v1

`writer-request-v1` is immutable and contains stable jobId, edition/date, real createdAt, packet
identity/path/hash, targets, allowed fact IDs, required sections, prompt path and ready/partial
status. Wall-clock time and local paths do not affect jobId. `writer-result-v1` contains stable
resultId, job/packet identities, engine metadata, target payloads and fact references.
`pnpm writer-job:validate` rejects unknown requests, targets or facts; mismatched value/unit/date;
unavailable/stale deterministic claims; and frozen model/probability/ranking/publication fields.
`pnpm production:apply` validates again and writes deterministic accepted gzip without touching the
prediction ledger.
