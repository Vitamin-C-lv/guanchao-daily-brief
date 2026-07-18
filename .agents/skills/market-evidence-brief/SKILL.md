---
name: market-evidence-brief
description: Research and produce evidence-backed Chinese daily, closing, and weekly macro/market briefs with source grading, A/H sector volume analysis, Stanford AI Index monitoring, structured chart selection, restrained AI editorial visuals, and falsifiable conditional forecasts. Use for 观潮 brief generation, market rotation analysis, institutional-view synthesis, chart planning, or forecast review.
---

# Market Evidence Brief

Use this workflow before editing any 观潮 daily, closing, or weekly report.

## 1. Fix the information boundary

- Record Asia/Shanghai generation time and each market's latest complete session separately.
- Never turn intraday prices, futures, stale institutional views, or search snippets into closing facts.
- Read the existing report and local archive first. Preserve still-valid material and deduplicate by event, publisher, URL, date, and claim.

## 2. Build a claim ledger before writing

For every material claim record the claim type, as-of date, unit, source, evidence class, and whether another independent publisher confirms it. Separate:

- confirmed fact;
- primary research finding;
- institution opinion;
- vendor market data or estimate;
- editorial inference;
- unconfirmed market rumor.

Read [source-policy.md](references/source-policy.md) whenever gathering external facts, Stanford AI Index material, institutional views, or Tonghuashun data.

## 3. Cover only decision-relevant information

Check Fed and macro policy, A shares, Hong Kong, US equities, cross-market risks, and material company/institution developments. Scan Stanford HAI's AI Index as specified in [stanford-ai-index.md](references/stanford-ai-index.md). Record “checked, no material update” internally instead of filling the page with low-value items.

## 4. Analyze A/H rotation with comparable data

Use fixed industry taxonomies and complete sessions. Keep turnover amount, trading volume, and turnover share distinct. Read [rotation-volume.md](references/rotation-volume.md) before claiming “明显放量” or inferring large-fund direction.

When actual A-share market data must be fetched, invoke the installed `$a-stock-data` skill, read its `SKILL.md` completely, then execute only the endpoint examples needed for the claim. Treat it as an acquisition recipe, not as an authority: retain the underlying provider URL, observation time, unit, and evidence class, and independently validate material outputs. Prefer its mootdx/Tencent path for price-volume data, apply its Eastmoney serial rate limit, and never promote provider fund-flow algorithms to observed holdings.

This skill is the governing publication policy. If `$a-stock-data` documentation uses looser wording for source quality, completeness, fund flow, or confidence, apply this skill's stricter evidence classes and downgrade to `insufficient` when they cannot be met.

## 5. Match the visual to the evidence

Use structured numbers rendered by code for every factual chart. Choose the chart type from the data relationship, not for decoration. AI image generation is optional and only for clearly labeled editorial illustration. Read [chart-image-policy.md](references/chart-image-policy.md) before creating charts or images.

## 6. Make more forecasts by making them falsifiable

Add scenarios only when they have current evidence, counterevidence, a trigger, an invalidation condition, a due date, and calibrated confidence. Review prior forecasts before creating new ones. Read [prediction-policy.md](references/prediction-policy.md) for the evidence thresholds and required fields.

## 7. Validate and publish

- Run the project content, generated-asset, type, and static-build checks.
- If a factual claim, chart, or forecast lacks evidence, remove or downgrade it instead of filling the gap.
- If image generation fails or yields no persistent local path, omit the optional visual and continue.
- Commit only intended content, hashed generated assets actually referenced by JSON, and relevant code. Never commit upstream PDFs, screenshots, report covers, news images, model caches, or local archives.
