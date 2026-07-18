# A/H rotation and volume policy

## Fixed definitions

- A shares: CSI All Share level-2 industries.
- Hong Kong: Hang Seng level-1 industries.
- Use the same constituents, currency, corporate-action treatment, and complete trading sessions across the comparison window.
- `turnoverAmountRatio20d`: latest 5-session average turnover amount divided by the preceding 20-session average.
- `tradingVolumeRatio20d`: latest 5-session average trading volume divided by the preceding 20-session average.
- `turnoverShareRatio20d`: latest 5-session average share of whole-market turnover amount divided by the preceding 20-session average share.

## Default A-share AI-chain map

Use these CSI All Share level-2 functional buckets by default:

- chips: `Semiconductors & Semiconductor Equipment`;
- servers, optical modules, and network hardware: `Technology Hardware & Equipment`;
- models, enterprise software, and AI applications: `Software & Services`;
- carrier networks and IDC connectivity: `Telecommunication Services`.

The official classification code and published Chinese name in the selected taxonomy snapshot control; the English labels above are stable semantic anchors, not substitutes for a current official constituent list. Power, cooling, construction, media, and other AI-adjacent themes stay in a separately labeled extension layer and must not be merged into the core buckets merely because a company has an AI narrative.

For every run record taxonomy owner, version/effective date, classification codes and names, constituent snapshot date, member identifiers, member count, retrieval time, and a hash of the ordered constituent list. Use the latest official constituent snapshot effective on or before the first session of the 25-session window and hold it fixed for the full calculation. If an official historical snapshot or landing page cannot be found, do not invent a direct link or silently use today's members; mark the sector test `insufficient`.

## Reproducible window rules

- Turnover amount is unadjusted traded currency. Adjust share volume only for splits, consolidations, bonus issues, or equivalent share-count actions using one documented factor series; record every action treatment.
- A confirmed suspension/no-trade session contributes zero amount and zero volume. A missing row is not a suspension and must never be imputed as zero. Every fixed member/session must be either observed or explicitly confirmed no-trade; otherwise the result is `insufficient`.
- For A shares, whole-market turnover is the same-provider, same-session RMB sum of ordinary A shares on Shanghai, Shenzhen, and Beijing exchanges, including STAR and ChiNext, and excluding B shares, funds, bonds, repos, and derivatives. Record the inclusion rule and keep it unchanged across all 25 sessions.
- `breadth5d` is the share of fixed-snapshot members whose close-to-close return from the close five complete sessions earlier to the latest close is above zero. Confirmed suspensions retain their official unchanged close; members without both boundary closes make the test `insufficient`.
- `relativeReturn5d` is sector 5-session close-to-close return minus the matching benchmark return over identical sessions and return type. Default benchmark is CSI All Share for A shares and Hang Seng Composite for Hong Kong; record official name/code and whether price or total return is used.

## “明显放量” gate

Use `verified` only when all are true:

- 25 comparable complete sessions are available;
- turnover amount ratio is at least 1.35;
- trading volume ratio is at least 1.20;
- turnover-share ratio is at least 1.15;
- breadth, 5-session relative return, and top-three turnover concentration are available;
- direct source links identify date range, unit, taxonomy, and provider.

The 1.20 volume threshold is an editorial screening threshold and must be reviewed after sufficient backtesting. If the amount and volume signals diverge, historical coverage is incomplete, or constituent changes cannot be normalized, use `insufficient`.

If breadth is below 50% or top-three concentration exceeds 60%, label the result “集中交易 / 高位分歧” rather than broad sector activation.

Return `none` only when the complete, reproducible test ran and no sector passed the gate. Return `insufficient` when taxonomy, constituents, links, sessions, corporate actions, denominator, breadth, benchmark, or any required input cannot be verified.

## Tonghuashun boundary

Tonghuashun raw turnover amount and trading volume are `vendor-market-data`. Cite the direct data page and capture time. Tonghuashun “main-force flow,” large-order, and active-buy algorithms are `vendor-estimate`. Never combine these labels or describe an estimate as verified fund holdings.

The installed `$a-stock-data` skill may be used to acquire A-share inputs. Its `ths_hot_reason()` endpoint supplies current-session per-stock `chengjiaoe` and `chengjiaoliang`; that snapshot alone cannot establish sector-level expansion. Aggregate a fixed constituent universe and compare at least 25 complete sessions using the same unit and corporate-action treatment. Prefer one consistent historical OHLCV provider; if current Tonghuashun data is combined with mootdx or another provider, reconcile units and spot-check overlapping sessions before calculating ratios.

`industry_comparison()` supplies price change and breadth, not historical sector turnover amount or trading volume. Do not infer “明显放量” from its ranking alone. Use its breadth only as a separate confirmation layer.

## Fund-direction inference

Require two independent, aligned evidence types, for example price/volume/breadth plus ETF shares, southbound disclosures, margin data, issuer actions, or another official disclosure. A single price/volume series or vendor algorithm limits confidence to low.
