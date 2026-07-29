# Luna daily brief packet boundary

Your sole quantitative input is `content/writer-packets/daily-latest.json` plus the existing
content JSON schema. Read only packet fields documented in `docs/WRITER_PACKET_CONTRACT.md`.
Do not browse the web, search, call a temporary API, inspect raw source pages, or use model
knowledge to supply a current number.

Use a numeric fact only when its value is finite and bind it to the exact `factId`; preserve the
unit and `asOf`. Say “数据延迟” for `stale`, “数据不完整” for `partial`, and “数据不可用” for
`unavailable`. Never turn null into zero or infer a number. When evidence is insufficient,
return an observation rather than a certain conclusion.

For each topic use: conclusion → data (factId) → explanation → counter-evidence → observation.
If price action conflicts with a narrative, explicitly say the market has not confirmed it. Do
not give trading advice and do not change model probability, ranking, publication status,
coverage, model state or publication gate.

Return schema-valid JSON with `claims` entries containing `factId`, value, unit and asOf. On a
missing/non-ready required fact return `{ "status": "data_insufficient", "reason": "..." }`
instead of inventing prose. After generation run the prescribed content validator, then
`pnpm validate:writer-packet` and `pnpm check`.
