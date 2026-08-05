from __future__ import annotations

import json
import gzip
import math
import os
import subprocess
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hk_model_research as research
import sector_rotation as rotation


class ContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.contract = research.read_json(research.CONTRACT_PATH)
        cls.universe = research.read_json(research.TRAINING_UNIVERSE_PATH)
        cls.public = research.read_json(research.PUBLIC_UNIVERSE_PATH)
        cls.registry = research.read_json(research.SOURCE_REGISTRY_PATH)

    def test_contract_is_hk_only_and_has_independent_horizons(self):
        self.assertEqual(self.contract["market"], "HK")
        self.assertEqual(self.contract["horizons"], [1, 5, 20])
        self.assertEqual(self.contract["timezone"], "Asia/Shanghai")

    def test_public_universe_is_exactly_four_objects(self):
        objects = self.public["objects"]
        self.assertEqual([item["id"] for item in objects], ["hsi", "hstech", "hk_innovative_drug", "hk_tech_internet"])
        self.assertEqual(self.public["displayedObjectCount"], 4)
        self.assertNotEqual(self.public["displayedObjectCount"], self.universe["officialIndustryCount"])

    def test_training_universe_keeps_official_industry_history_distinct_from_proxies(self):
        objects = self.universe["objects"]
        official = [item for item in objects if item["kind"] == "official_industry"]
        proxies = [item for item in objects if item["kind"] == "theme_proxy"]
        self.assertEqual(len(official), 12)
        self.assertEqual(len({item["code"] for item in official}), 12)
        self.assertTrue(all(item["officialClassification"] is True for item in official))
        self.assertTrue(all(item["officialClassification"] is False for item in proxies))
        self.assertTrue(all(item["doNotBackfillFromCurrentConstituents"] for item in objects))

    def test_theme_targets_are_not_top_quartile(self):
        self.assertEqual(
            self.contract["targets"]["theme"],
            {
                "binary": ["relative_outperformance_vs_hsi"],
                "continuous": ["expected_excess_vs_hsi"],
            },
        )
        self.assertEqual(self.contract["targets"]["topQuartile"]["role"], "research-only")

    def test_source_registry_is_explicit_about_missing_history(self):
        failures = self.registry["providerFailures"]
        self.assertTrue(failures)
        self.assertTrue(all(item["status"] != "success" for item in failures))
        self.assertTrue(all(item["reason"] for item in failures))

    def test_production_boundary_is_closed(self):
        self.assertTrue(all(value is False for value in self.contract["productionBoundary"].values()))


class FeatureTests(unittest.TestCase):
    def _history(self, count: int = 70, scale: float = 1.0) -> list[dict[str, object]]:
        start = date(2024, 1, 1)
        return [
            {"date": (start + timedelta(days=index)).isoformat(), "close": 100.0 + index * scale}
            for index in range(count)
        ]

    def test_price_features_use_only_prior_observations(self):
        values = research.derive_price_features(self._history(), self._history(scale=0.5))
        self.assertIsNone(values[0]["return_1"])
        self.assertIsNone(values[19]["return_20"])
        self.assertIsNotNone(values[20]["return_20"])
        self.assertIsNotNone(values[20]["distance_ma20"])
        self.assertNotEqual(values[20]["relative_return_5"], 0.0)

    def test_missing_history_is_preserved_as_null(self):
        history = self._history()
        history[10]["close"] = None
        values = research.derive_price_features(history, self._history(scale=0.5))
        self.assertIsNone(values[10]["return_1"])
        self.assertIsNone(values[11]["return_1"])
        self.assertFalse(any(value == 0 for row in values for value in row.values() if value is not None and isinstance(value, float) and math.isfinite(value)))

    def test_invalid_calendar_dates_fail_closed(self):
        for invalid_date in ("2024-01-32", "2026-02-29", "2026-13-01"):
            with self.subTest(invalid_date=invalid_date):
                with self.assertRaises(research.HKModelResearchError):
                    research.derive_price_features(
                        [{"date": invalid_date, "close": 100.0}],
                        [{"date": invalid_date, "close": 100.0}],
                    )


class ResearchStatusTests(unittest.TestCase):
    def test_report_has_all_required_metrics_without_fabricating_values(self):
        report = research.build_research_report()
        self.assertEqual(report["candidateStatus"], "shadow")
        self.assertFalse(report["productionApply"]["applied"])
        self.assertEqual(report["dataset"]["history"]["sessions"], 0)
        required = {
            "trainSampleCount", "oosWindowCount", "auc", "brier", "brierSkill", "rankIC",
            "topBottomSpread", "afterCostSpread", "predictionDispersion", "dataCompleteness",
            "regimePerformance", "rawProbabilityDistribution", "calibratedProbabilityDistribution",
            "featureMissingRates", "zeroVarianceFeatures", "providerFailures",
        }
        for horizon in report["horizons"].values():
            self.assertEqual(set(horizon["metrics"]), required)
            self.assertIsNone(horizon["metrics"]["auc"])
            self.assertFalse(horizon["qualityGatePassed"])

    def test_dataset_identity_is_content_addressed(self):
        identity = research.dataset_identity()
        self.assertIsNone(identity["datasetId"])
        self.assertRegex(identity["researchContractId"], r"^hk-research-contract-[0-9a-f]{12}$")
        self.assertRegex(identity["identitySha256"], r"^[0-9a-f]{64}$")
        self.assertEqual(identity["identityComponents"]["panelSha256"], None)
        self.assertEqual(identity["identityComponents"]["snapshotStatus"], "unavailable")

    def test_production_boundary_is_read_only(self):
        self.assertEqual(research.production_boundary(), research.production_boundary())


class PublicContractTests(unittest.TestCase):
    def test_cli_forces_utf8_json_under_cp1252_stdio(self):
        environment = os.environ.copy()
        environment["PYTHONIOENCODING"] = "cp1252"
        environment["PYTHONUTF8"] = "0"
        script = Path(__file__).resolve().parent / "hk_model_research.py"
        completed = subprocess.run(
            [sys.executable, str(script), "report"],
            check=True,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        output = completed.stdout.decode("utf-8")
        payload = json.loads(output)
        self.assertEqual(payload["market"], "HK")
        self.assertIn("没有显式", output)
        self.assertNotIn("UnicodeEncodeError", completed.stderr.decode("utf-8"))

    def test_committed_hk_dto_keeps_source_date_and_withholds_observations(self):
        content_path = Path(__file__).resolve().parents[1] / "content" / "sector-rotation.json"
        payload = json.loads(content_path.read_text(encoding="utf-8"))
        hk = next(market for market in payload["markets"] if market["id"] == "hk")
        self.assertEqual(hk["sourceAsOf"], "2026-08-04")
        self.assertEqual(
            [item["id"] for item in hk["publicUniverse"]],
            ["hsi", "hstech", "hk_innovative_drug", "hk_tech_internet"],
        )
        for horizon in ("current", "tomorrow", "oneWeek", "oneMonth"):
            self.assertEqual(hk["horizons"][horizon]["outputMode"], "none")

    def test_date_mismatch_is_retained_and_untrained_forecasts_are_not_current_observations(self):
        original_session = rotation.daily_brief_session
        original_fetch = rotation.fetch_hk_current
        try:
            rotation.daily_brief_session = lambda market_id: "2026-08-03"
            rotation.fetch_hk_current = lambda: (
                "2026-08-04",
                [
                    {"code": code, "name": name, "change": 0.1, "value": 100.0}
                    for code, name in rotation.HSI_CODE_NAMES.items()
                ],
            )
            result = rotation.hk_market()
        finally:
            rotation.daily_brief_session = original_session
            rotation.fetch_hk_current = original_fetch
        self.assertEqual(result["sourceAsOf"], "2026-08-04")
        self.assertEqual([item["id"] for item in result["publicUniverse"]], ["hsi", "hstech", "hk_innovative_drug", "hk_tech_internet"])
        self.assertEqual(result["horizons"]["current"]["sourceAsOf"], "2026-08-04")
        self.assertEqual(result["horizons"]["tomorrow"]["outputMode"], "none")
        self.assertEqual(result["horizons"]["oneWeek"]["outputMode"], "none")
        self.assertEqual(result["horizons"]["oneMonth"]["outputMode"], "none")


class PanelDescriptorTests(unittest.TestCase):
    @staticmethod
    def _panel_bytes(*, newline: str = "\n", close: str = "100.0") -> bytes:
        body = newline.join(
            [
                "date,objectId,close",
                f"2024-01-01,hsi,{close}",
                "2024-01-02,hsi,101.0",
            ]
        ) + newline
        return gzip.compress(body.encode("utf-8"), mtime=0)

    def test_missing_panel_has_contract_identity_but_no_dataset_id(self):
        with TemporaryDirectory() as directory:
            identity = research.dataset_identity(Path(directory) / "panel.csv.gz")
        self.assertIsNone(identity["datasetId"])
        self.assertRegex(identity["researchContractId"], r"^hk-research-contract-[0-9a-f]{12}$")
        self.assertEqual(identity["identityComponents"]["snapshotStatus"], "unavailable")

    def test_same_panel_is_stable_and_business_bytes_change_dataset_id(self):
        with TemporaryDirectory() as directory:
            panel_path = Path(directory) / "panel.csv.gz"
            panel_path.write_bytes(self._panel_bytes())
            first = research.dataset_identity(panel_path)
            second = research.dataset_identity(panel_path)
            panel_path.write_bytes(self._panel_bytes(close="100.1"))
            changed = research.dataset_identity(panel_path)
        self.assertEqual(first["datasetId"], second["datasetId"])
        self.assertIsNotNone(first["datasetId"])
        self.assertNotEqual(first["datasetId"], changed["datasetId"])
        self.assertEqual(first["identityComponents"]["panelHashBasis"], "raw-gzip-bytes-v1")

    def test_newline_policy_is_explicit_and_changes_raw_panel_identity(self):
        with TemporaryDirectory() as directory:
            panel_path = Path(directory) / "panel.csv.gz"
            panel_path.write_bytes(self._panel_bytes(newline="\n"))
            lf_identity = research.dataset_identity(panel_path)
            panel_path.write_bytes(self._panel_bytes(newline="\r\n"))
            crlf_identity = research.dataset_identity(panel_path)
        self.assertNotEqual(lf_identity["datasetId"], crlf_identity["datasetId"])
        self.assertEqual(crlf_identity["identityComponents"]["panelHashBasis"], "raw-gzip-bytes-v1")

    def test_panel_descriptor_rejects_corrupt_gzip_missing_columns_and_duplicates(self):
        with self.assertRaises(research.HKModelResearchError):
            research.panel_descriptor(b"not a gzip")
        missing_column = gzip.compress(b"date,close\n2024-01-01,100\n", mtime=0)
        with self.assertRaises(research.HKModelResearchError):
            research.panel_descriptor(missing_column)
        duplicate = gzip.compress(
            b"date,objectId,close\n2024-01-01,hsi,100\n2024-01-01,hsi,101\n",
            mtime=0,
        )
        with self.assertRaises(research.HKModelResearchError):
            research.panel_descriptor(duplicate)


if __name__ == "__main__":
    unittest.main()
