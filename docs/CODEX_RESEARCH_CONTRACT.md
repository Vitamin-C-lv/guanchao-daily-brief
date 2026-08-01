# Codex Research Contract v1

`data/codex-research/contract.json` defines the handoff from a local Codex Researcher to the local Codex Writer.

## Roles and boundary

- Researcher may browse public sources in the current Codex task and may retain only bounded evidence records.
- Writer receives `CODEX_RESEARCH.json` inside an immutable execution package and must not browse, call an external LLM API, or read credentials.
- Existing quantitative writer packets, prediction probabilities, rankings, EvidenceScore fields, prediction ledger, and model/sector-rotation files remain outside this contract.

Every fact must bind `sourceUrl`, `publisher`, `publishedAt` or `publishedDate`, `accessedAt`, `documentId`, `claimText`, `evidenceClass`, and `contentSha256`. Every observation binds document IDs and at least one supporting basis with a locator and bounded excerpt. A document title is never accepted as causal evidence by itself.

## Storage and identity

`codex-research.mjs seal` normalizes URLs and timestamps, computes stable IDs, verifies source metadata, and writes no full article text. The run identity excludes audit-only generation/access timestamps; an audit timestamp change therefore reuses the same immutable business artifact. `store --dry-run` produces a write plan without changing the repository; `store --write` uses deterministic gzip and fails closed on a stable-identity conflict or corrupt existing artifact.

The adapted output is the existing `research-bundle-v1`. It is written through the established immutable research storage so writer-context validation can consume the bundle without a second source lineage.

## Commands

```powershell
node scripts/codex-research.mjs validate-contract
node scripts/codex-research.mjs seal --input C:\Codex-Recovery\GuanchaoWriter\candidate.json --output C:\Codex-Recovery\GuanchaoWriter\CODEX_RESEARCH.json
node scripts/codex-research.mjs validate --file C:\Codex-Recovery\GuanchaoWriter\CODEX_RESEARCH.json
node scripts/codex-research.mjs store --input C:\Codex-Recovery\GuanchaoWriter\CODEX_RESEARCH.json --dry-run --root D:\周报个人网站
node scripts/codex-research.mjs store --input C:\Codex-Recovery\GuanchaoWriter\CODEX_RESEARCH.json --write --root D:\周报个人网站
```

The execution package, not the latest research view, is the writer authority. Missing, partial, rate-limited, or schema-changed evidence remains explicit and is never converted to zero or an invented fact.
