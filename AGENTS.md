## Guanchao Anti-Overdefense

For implementation, review, refactoring, validation, packaging, CI repair, and engineering handoff work, apply the project skill:

`.agents/skills/guanchao-anti-overdefense/SKILL.md`

These rules constrain proposed engineering work, not the reporting of real defects.

1. Use Guanchao's real threat model. Do not turn ordinary engineering into security-paper hardening for hypothetical adversaries. Security, migration, validation, or review explicitly required by the user, project contracts, accepted ADRs, or higher-priority instructions remains required.

2. Do not add hashes, SHA-256, checksums, fingerprints, or checksum manifests unless they are part of an existing identity/integrity contract, replace a materially more expensive operation, or their result changes the next action. Preserve legitimate dataset content identity, immutable ledger identity, and model artifact identity. Routine ZIPs, reports, screenshots, logs, temporary files, and ordinary Git-tracked documentation do not need mechanical SHA-256 merely for extra assurance.

3. Do not add speculative feature flags, migration frameworks, compatibility layers, wrappers, recovery systems, or parallel old/new implementations for situations that do not occur in the current supported system. Prefer the minimum sufficient implementation.

4. Treat edge cases according to reachability in Guanchao's supported use: real provider data, documented inputs, supported Windows workflows, GitHub Actions, Vercel, production pages, and actual public interfaces count. Merely theoretically constructible encodings, races, operating systems, or adversarial conditions do not justify engineering work unless the project actually supports or encounters them.

5. Use engineering judgement where judgement is required. Do not replace it with scoring machinery, giant checklists, repeated self-review loops, or re-running settled checks. Before an optional check, identify the live uncertainty it can resolve and what action would change if it fails. Required targeted tests, final `pnpm check`, build, contract validation, and real release gates remain required.

6. These limits never override explicit user instructions, the latest HANDOFF, ARCHITECTURE, accepted ADRs, task contracts, external contracts, immutable-history requirements, dataset identity, model artifact identity, publication gates, or explicitly required security/migration/review work.

Guanchao's existing invariants remain unchanged:

- `null` is not `0`.
- Models without sufficient out-of-sample edge must abstain.
- EvidenceScore is not probability.
- Historical predictions must not be rewritten.
- AI must not alter raw data, model probabilities, rankings, realized returns, publication status, or model version.
- Priority watchlists may increase collection and explanation depth but must not receive artificial model-score boosts.

Say plainly when something is correct. Do not manufacture findings, hashes, frameworks, or abstractions merely to appear rigorous.
