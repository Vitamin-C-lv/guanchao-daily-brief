# Writer packet contract

`content/writer-packets/daily-latest.json` and `weekly-latest.json` are derived views only. A
request must reference its immutable gzip packet under `data/writer-jobs/packets/`; that packet,
not a latest view, is the authoritative writer input. Packet identities use canonical data and
preserve explicit `partial`, `stale`, and `unavailable` states: null is never zero.

`writer-request-v1` freezes its execution meaning with `writerPromptSha256` and each target's
`targetSchemaVersion`, `validatorId`, and `validatorSha256`. A changed prompt, validator, or
schema version rejects the result. `writer-result-v1` is the sole normal output and contains
target payloads plus `result.factReferences`, the only permitted fact lineage source.
`payload.factClaims` is forbidden.

Every fact reference contains `factId`, `usedValue`, `usedUnit`, `usedAsOf`, `targetPath`,
`targetField`, `claimMode`, `claimText`, and `renderedValue`. A target path/field pair cannot
repeat and each output needs at least one reference. Status mapping is `ready` → `value`,
`partial` → `partial`, `stale` → `delayed`, and `unavailable` / `rate_limited` /
`schema_changed` → `unavailable`.

For a numeric target, the actual payload value must equal `usedValue`, while `claimText` must
exactly equal the nonempty `renderedValue`. For a text target, the actual payload string must
exactly equal `claimText`; partial/delayed/unavailable wording is checked against that actual
text. `targetField` must resolve to a real primitive payload field.

When generation cannot meet this contract, Luna may return `writer-error-v1` with the request
job ID and `GENERATION_CONTRACT_FAILURE`. It is not a writer result, cannot be validated or
applied, must not contain a half article, and never enters accepted storage.

Accepted results are deterministic gzip artifacts and cannot be overwritten by a different stable
identity. Weekly report, weekly index, and weekly notice are derived and committed in one rollback
transaction. Writer apply never changes the prediction ledger.
