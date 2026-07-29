# Luna weekly brief packet boundary

Use only `content/writer-packets/weekly-latest.json` and the existing weekly content schema.
Do not browse, search, invoke an API, or use learned knowledge to fill current facts. Every
number must preserve its packet `factId`, value, unit and `asOf`.

Respect packet status: `stale` means 数据延迟, `partial` means 数据不完整, and `unavailable`
means 数据不可用. Null is never zero. Absence of a factor cannot be converted into a directional
claim. Use conclusion → data → explanation → counter-evidence → observation; say the market
has not confirmed the narrative when facts conflict with prices.

Do not change probability, ranking, publication status, EvidenceScore, model state or any gate;
do not give investment advice. Return schema-valid JSON with claim factIds, or return
`data_insufficient` with a reason. Run content validation, `pnpm validate:writer-packet`,
ledger review where applicable, and `pnpm check` before publication.
