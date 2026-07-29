# P1-C A-share production feature coverage audit

## Result

`productionFeatureCoverage` is exactly **50%**: the weighted numerator is 0.50 and denominator is 1.00. It consists of `priceRelativeStrength` (0.25) plus `turnoverAndVolume` (0.25). It is not a hardcoded literal, but it is currently derived from a static declared availability set in `scripts/sector_probability.py:data_diagnostics`.

The complete machine-readable inventory, 20-session recomputation, null/zero-variance checks, sector-mapping check and source-to-model lineage are in [p1c-a-share-feature-coverage.json](../../reports/prediction/p1c-a-share-feature-coverage.json), [p1c-feature-lineage.json](../../reports/prediction/p1c-feature-lineage.json), and [p1c-coverage-recomputation.json](../../reports/prediction/p1c-coverage-recomputation.json).

## Why 100% and 50% coexist

The frozen A-share model has 26 numerical inputs: nine raw price/volume features, nine cross-sectional normalizations, and eight deterministic nonlinear terms. Across 12 sectors and the latest 20 immutable dataset sessions (2026-06-24 through 2026-07-21), all 26 have 240/240 finite values, no zero-variance session, no duplicate sector vector, and no silent-zero substitution. Thus `modelInputCompleteness=26/26=100%` is correct for the frozen model vector.

`productionFeatureCoverage` instead measures five planned production feature groups. The absent groups are:

- `marketBreadth` (20%): `provider_not_implemented`.
- `etfAndInstitutionFlow` (20%): `provider_not_implemented`.
- `policyAndEventMapping` (10%): `adapter_not_wired`.

The current model vector contains no proxy feature. The current production content date is 2026-07-24, but the committed artifact preserves only its summary diagnostic, not a per-feature production matrix; the audit does not claim a per-field 2026-07-24 recomputation that cannot be reproduced.

## P1-D design input only

Do not implement these in P1-C. The strictly limited candidates for **P1-D: A股生产特征补全** are:

1. `marketBreadth`: +20 percentage points if a reliable existing public source and two-year point-in-time history are proven.
2. `policyAndEventMapping`: +10 points if deterministic A-core12 mapping and historical point-in-time semantics are proven.
3. `etfAndInstitutionFlow`: potential +20 points, but not currently recommended because it combines two high-maintenance unimplemented domains.

The model file and dataset remain frozen; this audit neither trains nor changes inputs, coefficients, gates, providers, schema, ledger identities, or UI.
