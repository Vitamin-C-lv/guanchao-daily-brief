# Writer packet contract

`content/writer-packets/daily-latest.json` and `weekly-latest.json` are derived views only. A
request must reference its immutable gzip packet under `data/writer-jobs/packets/`; that packet,
not a latest view, is the authoritative writer input. Packet identities use canonical data and
preserve explicit `partial`, `stale`, and `unavailable` states: null is never zero.

`writer-request-v2` references one exact `writer-context-v1` by path, gzip SHA and context ID.
The context freezes the packet, research bundle, full baseline, prompt, validator and target
schema. A changed context, prompt, validator or schema rejects the request/result.
`writer-result-v2` is the sole normal output and keeps its complete payload separate from
`claimBindings`; `payload.factClaims` is forbidden.

Quantitative bindings contain `claimPath`, `claimText`, `factId`, and `renderedValue` and resolve
to exact packet facts. Qualitative bindings contain observation IDs, document IDs covering every
observation basis, and the bundle's exact evidence state. Source-metadata bindings may only repeat
frozen title, publisher, URL or publication-date metadata. A claim path cannot repeat.

For a numeric target, the actual payload value must equal the packet value, while `claimText` must
exactly equal the nonempty `renderedValue`. For a text target, the actual payload string must
exactly equal `claimText`; partial/delayed/unavailable wording is checked against that actual
text. `claimPath` must resolve to a real primitive payload field. A canonical baseline diff rejects
every changed business field that is not bound to quantitative, qualitative or source-metadata
evidence (apart from the narrow formatting/date allowlist), and unchanged baseline text cannot be
re-labeled as new evidence.

When generation cannot meet this contract, Luna may return `writer-error-v1` with the request
job ID and `GENERATION_CONTRACT_FAILURE`. It is not a writer result, cannot be validated or
applied, must not contain a half article, and never enters accepted storage.

Accepted results are deterministic gzip artifacts and cannot be overwritten by a different stable
identity. Weekly report, weekly index, and weekly notice are derived and committed in one rollback
transaction. Writer apply never changes the prediction ledger.

P1-H/I remains manual queue/apply infrastructure, not an automatic writer. New request preparation
requires an explicit immutable context and never reads a latest view. Automatic Luna execution,
automatic content publication and scheduled writing remain disabled. A deterministic execution
package contains only the request, context, packet, bundle, baseline, prompt, schema reference,
result template and hashes; Luna must not browse autonomously.
