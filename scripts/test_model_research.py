from __future__ import annotations

import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import model_research as research


SNAPSHOT = research.ROOT / "models" / "sector-rotation" / "datasets" / "a-share" / "a-share-2026-07-21-3448b55c8ae4"


def synthetic_rows(count: int = 48) -> list[dict[str, object]]:
    rows = []
    for index in range(count):
        row: dict[str, object] = {
            "date": f"2024-01-{index % 28 + 1:02d}",
            "code": f"{index % 12:06d}",
            "targetDate1": "2024-02-01",
            "absoluteUp1": index % 2,
            "outperformance1": (index // 2) % 2,
            "topQuartile1": int(index % 4 == 0),
            "expectedExcess1": (index - count / 2) / 1000,
        }
        for feature_number, feature in enumerate(research.CURRENT_FEATURES, start=1):
            row[feature] = (index + 1) * feature_number / 100.0
        rows.append(row)
    return rows


def synthetic_records(dates: int = 126, shift: float = 0.0) -> list[dict[str, object]]:
    values = []
    for day in range(dates):
        date = f"2024-{day // 28 + 1:02d}-{day % 28 + 1:02d}"
        for sector in range(12):
            top = int(sector < 3)
            score = 1.2 - sector / 4 + shift
            values.append({
                "date": date,
                "code": f"{sector:06d}",
                "rawScores": {target: score for target in research.BINARY_TARGETS},
                "rawProbabilities": {target: research.sigmoid(score) for target in research.BINARY_TARGETS},
                "predictedExcess": (11 - sector) / 1000,
                "targets": {"absoluteUp": int(sector % 2 == 0), "outperformance": int(sector < 6), "topQuartile": top},
                "realizedExcess": (11 - sector) / 1000,
                "regime": "risk-on" if day % 2 == 0 else "risk-off",
            })
    return values


def synthetic_folds() -> list[dict[str, object]]:
    model = {
        "topQuartile": {
            "featureNames": ["momentum5"],
            "coefficients": {"momentum5": 0.1},
        }
    }
    return [{"models": model}, {"models": model}]


def calibrators() -> dict[str, dict[str, float | str | int]]:
    return {
        target: {
            "method": "platt-on-purged-time-ordered-oof",
            "ridge": 2.0,
            "scoreMean": 0.0,
            "scoreScale": 1.0,
            "intercept": 0.0,
            "slope": 1.0,
            "baseRate": 0.25 if target == "topQuartile" else 0.5,
            "observations": 100,
            "dates": 10,
        }
        for target in research.BINARY_TARGETS
    }


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = research.validate_contract()
        cls.specs = research.candidate_specs(cls.contract)

    def test_schema_version(self):
        self.assertEqual(self.contract["schemaVersion"], "model-research-contract-v1")

    def test_market(self):
        self.assertEqual(self.contract["market"], "A_SHARE")

    def test_horizons(self):
        self.assertEqual(self.contract["horizons"], [1, 5, 20])

    def test_binary_targets(self):
        self.assertEqual(tuple(self.contract["targets"]["binary"]), research.BINARY_TARGETS)

    def test_continuous_target(self):
        self.assertEqual(self.contract["targets"]["continuous"], [research.CONTINUOUS_TARGET])

    def test_explicit_snapshot(self):
        self.assertTrue(self.contract["dataset"]["explicitSnapshotRequired"])

    def test_network_forbidden(self):
        self.assertFalse(self.contract["dataset"]["networkAccessDuringTraining"])

    def test_null_policy(self):
        self.assertEqual(self.contract["dataset"]["missingValuePolicy"], "preserve-null-never-zero")

    def test_random_split_forbidden(self):
        self.assertFalse(self.contract["dataset"]["randomSplitAllowed"])

    def test_candidate_cap(self):
        self.assertEqual(self.contract["candidateDesign"]["maxCandidates"], 120)

    def test_seed(self):
        self.assertEqual(self.contract["candidateDesign"]["randomSeed"], 20260731)

    def test_windows(self):
        self.assertEqual([self.contract["windows"][name] for name in ("trainingSessions", "selectionSessions", "holdoutSessions", "walkForwardBlockSessions")], [504, 504, 252, 63])

    def test_bootstrap(self):
        self.assertEqual((self.contract["bootstrap"]["blockLengthSessions"], self.contract["bootstrap"]["repetitions"]), (63, 1000))

    def test_costs(self):
        self.assertEqual((self.contract["transactionCosts"]["perLeg"], self.contract["transactionCosts"]["roundTrip"]), (0.002, 0.004))

    def test_promotion_enum(self):
        self.assertEqual(set(self.contract["promotionGate"]["allowedDecisions"]), {"promotion-eligible", "keep-champion", "insufficient-data", "invalid-run"})

    def test_noninferiority_frozen(self):
        self.assertEqual(self.contract["promotionGate"]["nonInferiority"]["topQuartileBrierMaximumIncrease"], 0.005)

    def test_production_boundary(self):
        self.assertTrue(all(value is False for value in self.contract["productionBoundary"].values()))

    def test_candidate_count(self):
        self.assertEqual(len(self.specs), 23)

    def test_candidate_plan_unique(self):
        self.assertEqual(len({research.canonical_json(item) for item in self.specs}), len(self.specs))

    def test_first_candidate_is_champion_replay(self):
        self.assertEqual(self.specs[0]["candidateFamily"], "champion-replay")

    def test_raw_calibration_candidate(self):
        self.assertEqual(sum(item["calibrationMethod"] == "raw" for item in self.specs), 1)

    def test_linear_ablation_candidate(self):
        self.assertEqual(sum(item["featureSet"] == "linear-base" for item in self.specs), 1)

    def test_candidate_features_are_bounded(self):
        self.assertTrue(all(set(research.features_for_spec(item)) <= set(research.CURRENT_FEATURES) for item in self.specs))


class PrimitiveTests(unittest.TestCase):
    def test_canonical_json_key_order(self):
        self.assertEqual(research.canonical_json({"b": 1, "a": 2}), b'{"a":2,"b":1}')

    def test_canonical_json_rejects_nan(self):
        with self.assertRaises(ValueError):
            research.canonical_json({"value": math.nan})

    def test_sha256_bytes(self):
        self.assertEqual(research.sha256_bytes(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

    def test_atomic_write_created_and_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "x.bin"
            self.assertEqual(research.atomic_write(path, b"x"), "created")
            self.assertEqual(research.atomic_write(path, b"x"), "reused")

    def test_atomic_write_updated(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "x.bin"
            research.atomic_write(path, b"x")
            self.assertEqual(research.atomic_write(path, b"y"), "updated")

    def test_atomic_write_immutable_conflict(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "x.bin"
            research.atomic_write(path, b"x")
            with self.assertRaises(research.ModelResearchError):
                research.atomic_write(path, b"y", immutable=True)

    def test_external_path_rejects_repo(self):
        with self.assertRaises(research.ModelResearchError):
            research.require_external(research.ROOT / "tmp")

    def test_external_path_accepts_temp(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.assertEqual(research.require_external(Path(temporary)), Path(temporary).resolve())

    def test_candidate_root_exact(self):
        self.assertEqual(research.require_candidate_root(research.CANDIDATE_ROOT), research.CANDIDATE_ROOT.resolve())

    def test_candidate_root_rejects_other(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(research.ModelResearchError):
            research.require_candidate_root(Path(temporary))

    def test_sigmoid_zero(self):
        self.assertEqual(research.sigmoid(0), 0.5)

    def test_auc_perfect(self):
        self.assertEqual(research._auc([(0.1, 0), (0.9, 1)]), 1.0)

    def test_ece_zero_for_exact_buckets(self):
        self.assertAlmostEqual(research._ece([(0.0, 0), (1.0, 1)]), 0.0)

    def test_probability_metric_fields(self):
        value = research.probability_metrics([(0.2, 0), (0.8, 1)], 0.5, 2, 0.3)
        self.assertTrue({"brier", "baselineBrier", "brierSkill", "logLoss", "rocAuc", "expectedCalibrationError"} <= set(value))

    def test_missing_feature_never_zero_filled(self):
        with self.assertRaises(research.ModelResearchError):
            research.feature_value({}, "momentum5")

    def test_nonfinite_feature_rejected(self):
        with self.assertRaises(research.ModelResearchError):
            research.feature_value({"momentum5": math.inf}, "momentum5")

    def test_logistic_ridge_fit(self):
        model = research.fit_estimator(synthetic_rows(), horizon=1, target="absoluteUp", features=(research.CURRENT_FEATURES[0],), kind="logistic", ridge=40)
        self.assertEqual((model["type"], model["ridge"]), ("standardized-ridge-logistic", 40.0))

    def test_regression_ridge_fit(self):
        model = research.fit_estimator(synthetic_rows(), horizon=1, target="expectedExcess", features=(research.CURRENT_FEATURES[0],), kind="linear", ridge=80)
        self.assertEqual((model["type"], model["ridge"]), ("standardized-ridge-linear", 80.0))

    def test_score_is_finite(self):
        rows = synthetic_rows()
        model = research.fit_estimator(rows, horizon=1, target="expectedExcess", features=(research.CURRENT_FEATURES[0],), kind="linear", ridge=80)
        self.assertTrue(math.isfinite(research.score_estimator(model, rows[0])))

    def test_platt_calibration(self):
        model = research.fit_platt(synthetic_records(4), "topQuartile", 2)
        self.assertEqual((model["method"], model["ridge"]), ("platt-on-purged-time-ordered-oof", 2.0))

    def test_raw_probability(self):
        record = {"rawProbabilities": {"topQuartile": 0.4}, "rawScores": {"topQuartile": -0.2}}
        self.assertEqual(research.calibrated_probability(record, "topQuartile", "raw", calibrators()["topQuartile"]), 0.4)

    def test_platt_probability(self):
        record = {"rawProbabilities": {"topQuartile": 0.4}, "rawScores": {"topQuartile": 0.0}}
        self.assertEqual(research.calibrated_probability(record, "topQuartile", "platt", calibrators()["topQuartile"]), 0.5)

    def test_ranking_metrics(self):
        records = synthetic_records(63)
        values = [item["rawProbabilities"]["topQuartile"] for item in records]
        metrics = research._ranking_metrics(records, values)
        self.assertEqual((len(metrics["daily"]), len(metrics["blocks"])), (63, 1))

    def test_after_cost_is_spread_minus_roundtrip(self):
        records = synthetic_records(2)
        values = [item["rawProbabilities"]["topQuartile"] for item in records]
        metrics = research._ranking_metrics(records, values)
        self.assertAlmostEqual(metrics["topBottomSpread"] - metrics["afterCostSpread"], 0.004)

    def test_evaluation_contains_daily_brier(self):
        value = research.evaluate_records(synthetic_records(2), synthetic_folds(), method="raw", calibrators=calibrators())
        self.assertIn("topQuartileBrier", value["_daily"][0])

    def test_public_evaluation_strips_private(self):
        self.assertEqual(research._public_evaluation({"a": 1, "_daily": []}), {"a": 1})

    def test_bootstrap_deterministic(self):
        champion = [{"date": f"d{i}", "rankIc": 0.0, "afterCostSpread": 0.0, "topQuartileBrier": 0.2} for i in range(126)]
        challenger = [{"date": f"d{i}", "rankIc": 0.1, "afterCostSpread": 0.01, "topQuartileBrier": 0.19} for i in range(126)]
        self.assertEqual(research.paired_block_bootstrap(champion, challenger), research.paired_block_bootstrap(champion, challenger))

    def test_bootstrap_paired_delta_direction(self):
        champion = [{"date": f"d{i}", "rankIc": 0.0, "afterCostSpread": 0.0, "topQuartileBrier": 0.2} for i in range(126)]
        challenger = [{"date": f"d{i}", "rankIc": 0.1, "afterCostSpread": 0.01, "topQuartileBrier": 0.19} for i in range(126)]
        value = research.paired_block_bootstrap(champion, challenger)
        self.assertGreater(value["topQuartileBrierImprovement"]["lower95"], 0)

    def test_bootstrap_rejects_unpaired_dates(self):
        left = [{"date": f"a{i}", "rankIc": 0.0, "afterCostSpread": 0.0, "topQuartileBrier": 0.2} for i in range(126)]
        right = [{"date": f"b{i}", "rankIc": 0.0, "afterCostSpread": 0.0, "topQuartileBrier": 0.2} for i in range(126)]
        with self.assertRaises(research.ModelResearchError):
            research.paired_block_bootstrap(left, right)

    def test_bootstrap_rejects_short_series(self):
        daily = [{"date": "x", "rankIc": 0.0, "afterCostSpread": 0.0, "topQuartileBrier": 0.2}]
        with self.assertRaises(research.ModelResearchError):
            research.paired_block_bootstrap(daily, daily)

    def test_candidate_identity_valid(self):
        identity = {"dataset": "x", "horizons": [1, 5, 20]}
        candidate = {
            "schemaVersion": "model-candidate-v1",
            "candidateId": research.sha256_bytes(research.canonical_json(identity)),
            "businessIdentity": identity,
            "horizons": {str(h): {"models": {target: {} for target in (*research.BINARY_TARGETS, research.CONTINUOUS_TARGET)}} for h in research.HORIZONS},
        }
        self.assertEqual(research.validate_candidate(candidate)["candidateId"], candidate["candidateId"])

    def test_candidate_identity_corruption_rejected(self):
        candidate = {
            "schemaVersion": "model-candidate-v1",
            "candidateId": "0" * 64,
            "businessIdentity": {"dataset": "x"},
            "horizons": {},
        }
        with self.assertRaises(research.ModelResearchError):
            research.validate_candidate(candidate)

    def test_cli_train_requires_explicit_arguments(self):
        with self.assertRaises(SystemExit):
            research.build_parser().parse_args(["train"])

    def test_cli_shadow_requires_explicit_arguments(self):
        with self.assertRaises(SystemExit):
            research.build_parser().parse_args(["shadow"])

    def test_cli_validate_parses(self):
        self.assertEqual(research.build_parser().parse_args(["validate"]).command, "validate")

    def test_production_boundary_is_stable_on_read(self):
        self.assertEqual(research.production_boundary(), research.production_boundary())


class DatasetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest, cls.panel, cls.audit = research.audit_dataset(SNAPSHOT)
        cls.reference = research.dataset_reference(SNAPSHOT, cls.manifest)
        cls.windows = research.holdout_windows(cls.panel, research.read_json(research.HOLDOUT_REGISTRY))

    def test_dataset_identity(self):
        self.assertEqual(self.reference["datasetIdentitySha256"], "3448b55c8ae44e7f4d95fd5cb8a1c8b229d40bdf070124f4350ac8226a18a963")

    def test_dataset_manifest_sha(self):
        self.assertEqual(self.reference["datasetManifestSha256"], "072ea900788faa910ddf17853563bc2ceb3bc2334fdcbcd97325f25202c8c756")

    def test_dataset_panel_sha(self):
        self.assertEqual(self.reference["panelSha256"], "16f43560015ea6f3778f18298f9abc5a99aaf3824b880e203c9b8c63aac95d89")

    def test_taxonomy_sha(self):
        self.assertEqual(self.reference["taxonomySha256"], "2cdb81a8cfbc2c2705bcbba45f14b601265f368accb68a94db74c062ac3c363a")

    def test_dataset_rows(self):
        self.assertEqual((self.audit["rows"], self.audit["dates"], self.audit["sectors"]), (30012, 2501, 12))

    def test_dataset_audit_passes(self):
        self.assertTrue(self.audit["passed"])

    def test_duplicate_rows_absent(self):
        self.assertEqual(self.audit["duplicateKeys"], 0)

    def test_date_ordering(self):
        self.assertEqual(self.audit["orderingErrors"], 0)

    def test_target_leakage_absent(self):
        self.assertEqual(self.audit["targetLeakageRows"], 0)

    def test_nonfinite_absent(self):
        self.assertEqual(self.audit["nonfiniteFeatureValues"], 0)

    def test_null_never_zero_filled(self):
        self.assertFalse(self.audit["missingValuesCoercedToZero"])

    def test_labelled_h1(self):
        self.assertEqual((self.audit["labelled"]["1"]["rows"], self.audit["labelled"]["1"]["dates"]), (30000, 2500))

    def test_labelled_h5(self):
        self.assertEqual((self.audit["labelled"]["5"]["rows"], self.audit["labelled"]["5"]["dates"]), (29952, 2496))

    def test_labelled_h20(self):
        self.assertEqual((self.audit["labelled"]["20"]["rows"], self.audit["labelled"]["20"]["dates"]), (29772, 2481))

    def test_selection_precedes_holdout(self):
        self.assertTrue(all(item["selectionEnd"] < item["holdoutStart"] for item in self.windows.values()))

    def test_holdout_date_counts(self):
        self.assertTrue(all(item["holdoutDates"] == 252 for item in self.windows.values()))

    def test_opened_holdouts_are_disclosed(self):
        self.assertTrue(self.windows["5"]["usedBefore"] and self.windows["20"]["usedBefore"])

    def test_h1_contract_preregistration(self):
        self.assertFalse(self.windows["1"]["usedBefore"])

    def test_store_validation_never_activates_candidate(self):
        result = research.validate_candidate_store()
        if result["candidateCount"]:
            self.assertFalse(research.read_json(research.SHADOW_CONFIG_PATH)["active"])
        else:
            self.assertEqual(result["status"], "valid")


def _add_grid_test(name: str, grid_name: str, expected: float) -> None:
    def test(self):
        contract = research.validate_contract()
        self.assertIn(expected, contract["candidateDesign"][grid_name])

    setattr(ContractTests, name, test)


for _grid, _values in {
    "logisticRidge": (10, 20, 40, 80, 160),
    "regressionRidge": (20, 40, 80, 160, 320),
    "calibratorRidge": (0.5, 1, 2, 4, 8),
}.items():
    for _value in _values:
        _add_grid_test(f"test_grid_{_grid}_{str(_value).replace('.', '_')}", _grid, _value)


def _add_ablation_test(group: str) -> None:
    def test(self):
        matches = [item for item in self.specs if item["excludedNonlinearGroups"] == [group]]
        self.assertEqual(len(matches), 1)
        self.assertTrue(set(research.NONLINEAR_GROUPS[group]).isdisjoint(research.features_for_spec(matches[0])))

    setattr(ContractTests, f"test_ablation_{group.replace('-', '_')}", test)


for _group in research.NONLINEAR_GROUPS:
    _add_ablation_test(_group)


if __name__ == "__main__":
    unittest.main()
