# Source and evidence policy

## Evidence classes

1. `official`: regulators, exchanges, statistics agencies, central banks, courts, and issuer filings.
2. `primary-research`: original research and public datasets such as Stanford HAI AI Index. It supports its measured topic, not unrelated market prices.
3. `vendor-market-data`: raw or aggregated price, turnover amount, trading volume, and breadth data from Tonghuashun, Wind, Choice, or similar providers.
4. `institution-opinion`: dated public views from banks, asset managers, and research institutions.
5. `major-media`: direct reporting from Reuters, AP, Bloomberg, CNBC, Xinhua, and comparable editorial organizations.
6. `vendor-estimate`: provider algorithms such as “main-force flow” or large-order estimates.
7. `proxy`: price, ETF shares, margin balances, southbound active stocks, short turnover, or custody changes used as an indirect signal.

Do not call `vendor-market-data` an official source. Do not call `vendor-estimate` a real institution position.

## `tier` is not `evidenceClass`

`SourceLink.tier` is a UI-level publisher label: `official`, `authoritative`, or `major-media`. `evidenceClass` describes what a cited claim actually proves and uses the classes above. Typical mapping is official body → `official`; research institute, bank, issuer, or market-data vendor → `authoritative`; major newsroom → `major-media`. A high `tier` never upgrades an estimate, opinion, proxy, or research result into an official fact. Store both fields independently.

## Minimum support

- One official source can prove that an official release exists. Its market interpretation needs another evidence class.
- A high-impact fact or popup requires at least two independent publishers, including one official, primary-research, or vendor-market-data source.
- A chart must preserve as-of date, unit, scope, calculation method, and direct source links. Derived values must cite the inputs.
- Reprints of one wire story count as one publisher. One institution's webpage and PDF count as one publisher.
- Institution opinions must preserve original date and applicable market. A media paraphrase must be labeled as such.

## Rumors and negative claims

Include an unconfirmed rumor only when a major news organization reports it and it already matters to pricing. State that it is unconfirmed, identify the response status, and remove unsupported details. For investigations, allegations, charges, and judgments, preserve the exact legal stage and use filings, court material, exchange notices, or formal responses.

## Direct-link rule

Use accessible HTTPS source pages, not search results, social screenshots, content farms, or temporary redirects. A mootdx socket, package/API name, raw HTTP endpoint, IP/port, or local cache is an acquisition route, not a citation. Pair collected data with an accessible HTTPS provider landing/data page that identifies the dataset; if no such page exists, record the acquisition internally but do not publish it as support for a factual claim, chart, or forecast. Never fabricate an official or provider URL. Do not download or archive upstream articles, reports, images, or PDFs in the repository.

## Community acquisition skills

`$a-stock-data` is an installed community acquisition skill. Its code examples and endpoint-health claims are implementation guidance, not publishable evidence. Cite the underlying exchange, issuer, Tonghuashun, Tencent, Eastmoney, Sina, or other provider page returned by the acquisition step. Recheck current endpoint output and units on every run; do not cite the GitHub README to support a market fact.

When that skill's prose, examples, or labels conflict with this file, this file wins. In particular, an endpoint response is not automatically `official`, a provider algorithm is not observed capital flow, and a successful fetch is not proof of historical completeness.

Use only the minimum endpoint needed. Do not run examples that disable TLS verification, download research PDFs, persist home-directory caches, or batch-scan hundreds of securities unless the active report explicitly requires it and the project storage/rate-limit policy permits it. Never expose `IWENCAI_API_KEY` or other credentials in logs, JSON, citations, or commits. Prefer official exchange fallbacks for material facts and stop cleanly when a provider blocks access.
