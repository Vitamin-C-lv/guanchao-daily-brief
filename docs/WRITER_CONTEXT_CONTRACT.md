# Writer context contract

`baseline-content-v1` and `writer-context-v1` freeze the complete input boundary for a manual
writer job. A context names one quantitative writer packet, one qualitative research bundle,
one complete baseline payload, one frozen prompt, one validator and one target schema. Every
reference is repository-relative and binds both the immutable artifact identity and its exact
gzip bytes.

## Authority and storage

Immutable baselines live at
`data/writer-contexts/baselines/YYYY/MM/<contentIdentity>.json.gz`. Immutable contexts live at
`data/writer-contexts/contexts/YYYY/MM/<contextId>.json.gz`. Files with the same business
identity are never replaced: a later `capturedAt`, `generatedAt` or warning is audit-only and
reuses the first stored bytes. A stable-content conflict fails closed.

`data/writer-contexts/index.json` and `content/writer-contexts/*-latest.json` are derived views.
They may be rebuilt offline, but they are never authoritative writer inputs. Preparing a context
requires explicit immutable packet and bundle paths plus an explicit baseline source path.

## Identity and integrity

The baseline business identity covers its schema version, edition, as-of date, target path,
target schema and the complete payload. The context business identity covers its schema version,
edition, as-of date, all three immutable artifact references, prompt and validator hashes, and
the target schema. Audit timestamps and warnings are excluded from business identity.

`integrity.businessSha256` equals the business identity. `integrity.sha256` hashes the complete
logical artifact with only the self-referential SHA field omitted. References use
`artifactSha256`, the SHA-256 of the exact deterministic gzip bytes. Canonical JSON and business
hashing are imported from `scripts/research-contract.mjs`; there is no second canonicalizer.

## Path and validation boundary

Paths use `/`, may not be absolute, contain a drive prefix, `..`, empty segments or backslashes,
and must stay below the repository root. Daily baselines only target
`content/daily-brief.json`; weekly baselines target an exact
`content/weekly-reports/weekly-YYYY-Www.json` file. Context validation reads exact referenced
bytes, verifies each SHA, decompresses and validates the packet, bundle and baseline, and checks
their internal IDs, edition and as-of compatibility.

The CLI supports registry, baseline and context validation, explicit `prepare`, and offline
`rebuild`. `prepare` requires exactly one of `--dry-run` and `--write`; an optional summary
output must be outside the repository. Production worktrees use dry-run only. Write-mode exists
for isolated temporary and rehearsal repositories.
