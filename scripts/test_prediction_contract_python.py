#!/usr/bin/env python3
"""Regression tests for prediction lineage written by Python generators."""

from __future__ import annotations

import unittest
from unittest.mock import patch
from pathlib import Path
import sys
import json
import tempfile
import copy

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prediction_history as history
import sector_rotation as rotation


class PredictionContractPythonTest(unittest.TestCase):
    def test_state_contract_keeps_independent_semantics(self) -> None:
        state = rotation.prediction_state_contract(
            model_availability="trained",
            publication_status="abstained",
            output_mode="evidence_observation",
            calibration_status="disabled",
            probability_source="raw_model",
            probability_target="top_quartile",
            model_version="relative-v2",
            feature_version="price-volume",
            model_input_completeness=1.0,
            production_feature_coverage=0.5,
            gate_failures=["production_feature_coverage"],
        )
        self.assertEqual(state["modelAvailability"], "trained")
        self.assertEqual(state["publicationStatus"], "abstained")
        self.assertEqual(state["modelInputCompleteness"], 1.0)
        self.assertEqual(state["productionFeatureCoverage"], 0.5)

    def test_history_does_not_backfill_missing_raw_probability(self) -> None:
        snapshot = {
            "generatedAt": "2026-07-24T20:00:00+08:00",
            "model": {"version": "2026-07-21-relative-v2"},
            "markets": [{
                "id": "a-share",
                "sources": [],
                "horizons": {
                    "tomorrow": {
                        "status": "ready", "asOf": "2026-07-24", "dueDate": "2026-07-27", "sessions": 1,
                        "modelAvailability": "trained", "publicationStatus": "published", "outputMode": "probability",
                        "calibrationStatus": "enabled", "probabilitySource": "calibrated_model", "probabilityTarget": "top_quartile",
                        "modelVersion": "2026-07-21-relative-v2", "featureVersion": "price-volume",
                        "modelInputCompleteness": 1.0, "productionFeatureCoverage": 0.8, "gateFailures": [],
                        "items": [{
                            "forecastId": "fr-a-test", "sector": "能源", "code": "000986", "rankingTarget": "top-quartile",
                            "rawScore": 0.1, "calibratedProbability": 31.2, "topQuartileProbability": 31.2,
                            "outperformanceProbability": 48.0, "absoluteUpProbability": 50.1, "expectedExcessReturn": 0.2,
                            "historicalBaseRate": 25.0, "effectiveEdge": 6.2,
                        }],
                    },
                    "oneWeek": {}, "oneMonth": {},
                },
            }],
        }
        record = history.extract_records(snapshot)[0]
        self.assertIsNone(record["raw_probability"])
        self.assertEqual(record["calibrated_probability"], 31.2)
        self.assertEqual(record["top_quartile_probability"], 31.2)
        self.assertEqual(record["probability_target"], "top_quartile")

    def test_legacy_base_rate_is_explicit_and_never_top_quartile(self) -> None:
        record = history.normalize_record_contract({
            "ranking_target": "absolute-up-legacy", "model_version": "2026-07-20-probability-v1",
            "absolute_up_probability": 51.9, "historical_base": 51.9,
            "top_quartile_probability": None, "relative_outperformance_probability": None,
        })
        self.assertTrue(record["legacy"])
        self.assertEqual(record["probability_target"], "absolute_up")
        self.assertEqual(record["probability_source"], "historical_base_rate")
        self.assertIsNone(record["top_quartile_probability"])

    def test_missing_legacy_probability_is_data_insufficient_not_50_percent(self) -> None:
        record = {
            "prediction_id": "legacy-missing", "prediction_status": "published", "market": "a-share",
            "prediction_date": "2026-07-21", "due_date": "2026-07-22", "sector_id": "000986",
            "ranking_target": "absolute-up-legacy", "absolute_up_probability": None,
        }
        with patch.object(history, "a_share_returns", return_value=({"000986": 0.01, "000987": 0.02, "000988": 0.03, "000989": 0.04}, 0.01, "2026-07-22")):
            result = history.evaluation_for(record)
        self.assertEqual(result["result"], "data-insufficient")

    def test_native_a_share_generation_to_temp_dir_uses_current_source_window(self) -> None:
        frozen = rotation.read_json(rotation.MODEL_PATH)
        frozen = copy.deepcopy(frozen)
        frozen["data"]["coverageCount"] = 0  # Exercise observation/source generation without inference.
        probability = rotation.read_json(rotation.MULTI_TARGET_MODEL_PATH)
        taxonomy = rotation.read_json(rotation.TAXONOMY_PATH)
        manifest = {"aShareHistory": {item["code"]: {"source": rotation.CSI_API} for item in taxonomy["indices"]}}
        rows = {
            item["code"]: {
                "code": item["code"], "name": item["shortName"], "date": "2026-07-24",
                "momentum5": index / 100, "momentum20": index / 200,
                "amountRatio5v20": 0.1, "volumeRatio5v20": 0.1,
                "volatility20": 0.02, "drawdown60": -0.03,
            }
            for index, item in enumerate(taxonomy["indices"], start=1)
        }
        with patch.object(rotation, "load_manifest", return_value=manifest), patch.object(rotation, "latest_rows", return_value=rows), patch.object(rotation, "latest_complete_a_share_session", return_value="2026-07-24"), patch.object(rotation, "visualization_artifact", return_value={"normalizedPerformance60d": {"series": []}}):
            market = rotation.a_share_market(frozen, probability)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "sector-rotation-contract.json"
            rotation.write_json_atomic(output, {"markets": [market]})
            generated = json.loads(output.read_text(encoding="utf-8"))
        current = generated["markets"][0]["horizons"]["current"]
        self.assertEqual(current["modelAvailability"], "trained")
        self.assertEqual(current["modelInputCompleteness"], 1.0)
        self.assertEqual(current["modelFeatureCoverage"], 0.5)
        self.assertEqual(current["productionFeatureCoverage"], 0.5)
        self.assertEqual(generated["markets"][0]["marketBreadthSummary"]["status"], "unavailable")
        self.assertEqual(generated["markets"][0]["featureCoverage"]["productionSignalCoverage"], 0.5)
        for source in generated["markets"][0]["sources"]:
            if "indexCode=" in source["url"]:
                self.assertIn(f"endDate={market['asOf'].replace('-', '')}", source["url"])


if __name__ == "__main__":
    unittest.main()
