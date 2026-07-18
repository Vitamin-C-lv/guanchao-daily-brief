# Falsifiable forecast policy

More forecasts means more independently testable scenarios, not higher certainty.

## Required fields

Each forecast needs an immutable id, as-of date, horizon, due date, claim, direction, evidence, counterevidence, trigger, invalidation condition, confidence, and source references. Use conditional language such as “若……则可能……”.

Express short horizons in trading days. Compute `dueDate` from the named market's official trading calendar: the first session after `asOf` is day 1, and weekends, exchange holidays, and unscheduled closures do not count. A cross-market forecast must name one primary market or carry separate due dates; never add calendar days as a shortcut.

## Confidence gates

- Low: at least two cited observations; use when evidence is only price/volume, one vendor estimate, or indirect proxies.
- Medium: at least two independent evidence classes and two independent publishers, including one official, primary-research, or vendor-market-data source.
- Medium-high: at least three independent evidence classes and three publishers, including two official, primary-research, or vendor-market-data sources, with at least three complete sessions of alignment where market data is involved.

Every forecast must include at least one counterevidence item. Ban target prices, individual-stock trading instructions, certain inflow claims, and return promises.

Stanford AI Index can support structural horizons but never a 1–5 day forecast alone. Institution opinions are evidence of that institution's view, not proof that the scenario will occur.

## Review discipline

Before publishing new forecasts, review the prior report or local archive. Mark due forecasts as confirmed, partial, invalidated, or pending. Never silently rewrite a prior claim after the fact. When evidence is missing, publish `insufficient` instead of a scenario. Use `none` only after the required data were complete and no qualifying scenario remained; `none` never means data unavailable.
