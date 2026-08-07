#!/usr/bin/env python3
"""Targeted tests for the private three-market model core."""

from __future__ import annotations

import csv
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))

from three_market_model_core import (
    ThreeMarketError,
    canonical_json,
    derive_price_rows,
    gzip_bytes,
    load_hstech_normalized_override,
    oos_evaluate,
    sha256_bytes,
    write_immutable,
)
from validate_three_market_sources import validate_source


class ThreeMarketCoreTests(unittest.TestCase):
    def test_future_labels_exclude_feature_date_and_are_independent(self) -> None:
        series = {(date(2026, 1, 1) + timedelta(days=day)).isoformat(): float(day + 1) for day in range(41)}
        rows = derive_price_rows("US_NASDAQ", "nasdaq_composite", "index", series)
        first = rows[20]
        self.assertEqual(first["date"], "2026-01-21")
        self.assertEqual(first["targetDate1"], "2026-01-22")
        self.assertEqual(first["targetDate5"], "2026-01-26")
        self.assertEqual(first["targetDate20"], "2026-02-10")
        self.assertNotEqual(first["expectedReturn1"], first["expectedReturn20"])

    def test_relative_features_require_an_aligned_benchmark(self) -> None:
        series = {(date(2026, 2, 1) + timedelta(days=day)).isoformat(): float(day + 1) for day in range(29)}
        benchmark = {(date(2026, 2, 1) + timedelta(days=day)).isoformat(): float(day + 2) for day in range(1, 29)}
        rows = derive_price_rows("HK", "hstech", "index", series, benchmark)
        self.assertIsNone(rows[0]["relative_return_1d"])
        self.assertIsNotNone(rows[2]["relative_return_1d"])

    def test_walk_forward_is_purged_and_deterministic(self) -> None:
        # Expand to enough synthetic sessions without changing the deterministic order.
        series = {(date(2020, 1, 1) + timedelta(days=index)).isoformat(): float(100 + (index % 19)) for index in range(900)}
        rows = derive_price_rows("US_NASDAQ", "nasdaq_composite", "index", series)
        rows = [row for row in rows if row["date"] >= "2020-01-01"]
        result_a = oos_evaluate(rows, ("return_1d", "return_5d", "volatility_20d"), 1)
        result_b = oos_evaluate(rows, ("return_1d", "return_5d", "volatility_20d"), 1)
        self.assertEqual(result_a, result_b)
        self.assertTrue(result_a["strictOos"])
        for fold in result_a["folds"]:
            self.assertEqual(fold["purgeRule"], "training target session index < evaluation start index")

    def test_missing_values_are_not_zero_filled(self) -> None:
        rows = derive_price_rows("US_NASDAQ", "nasdaq_composite", "index", {"2026-03-01": 1.0, "2026-03-02": 2.0, "2026-03-03": 3.0})
        self.assertIsNone(rows[0]["return_1d"])

    def test_immutable_artifact_noop_and_conflict(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"
            content = canonical_json({"normalizedPanelIdentitySha256": sha256_bytes(b"panel"), "value": 1})
            self.assertTrue(write_immutable(path, content, identity=sha256_bytes(b"identity")))
            self.assertFalse(write_immutable(path, content, identity=sha256_bytes(b"identity")))
            with self.assertRaises(ThreeMarketError):
                write_immutable(path, canonical_json({"normalizedPanelIdentitySha256": sha256_bytes(b"identity"), "value": 2}), identity=sha256_bytes(b"identity"))

    def test_deterministic_gzip(self) -> None:
        self.assertEqual(gzip_bytes(b"abc"), gzip_bytes(b"abc"))

    def test_hstech_normalized_adapter_accepts_post_launch_fixture_and_rejects_short_fixture(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bars = [
                {
                    "date": (date(2020, 8, 17) + timedelta(days=index)).isoformat(),
                    "open": 100.0 + index,
                    "high": 101.0 + index,
                    "low": 99.0 + index,
                    "close": 100.5 + index,
                    "volume": 1000,
                }
                for index in range(252)
            ]
            fixture = root / "hstech.json"
            fixture.write_text(json.dumps({
                "schemaVersion": "hstech-sina-normalized-v1",
                "source": {"provider": "akshare.stock_hk_index_daily_sina", "url": "https://example.invalid"},
                "bars": bars,
            }), encoding="utf-8")
            series, source = load_hstech_normalized_override(fixture)
            self.assertEqual(len(series), 252)
            self.assertEqual(min(series), "2020-08-17")
            self.assertEqual(source["id"], "akshare_sina_hstech")

            short_fixture = root / "hstech-short.json"
            short_fixture.write_text(json.dumps({
                "schemaVersion": "hstech-sina-normalized-v1",
                "source": {"provider": "akshare.stock_hk_index_daily_sina"},
                "bars": bars[:251],
            }), encoding="utf-8")
            with self.assertRaises(ThreeMarketError):
                load_hstech_normalized_override(short_fixture)

    def test_source_validator_ignores_meta_and_normalizes_cboe_dates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            folder = root / "raw" / "cboe_vix"
            folder.mkdir(parents=True)
            (folder / "meta.json").write_text(json.dumps({"sourceId": "cboe_vix", "rows": 0}), encoding="utf-8")
            with (folder / "payload.csv").open("w", encoding="utf-8", newline="") as handle:
                writer = csv.DictWriter(handle, fieldnames=["DATE", "CLOSE"])
                writer.writeheader()
                writer.writerow({"DATE": "12/31/2025", "CLOSE": "14.55"})
                writer.writerow({"DATE": "01/02/2026", "CLOSE": "13.93"})
            result = validate_source({"id": "cboe_vix", "required": True, "expectedMinRows": 2}, root)
            self.assertEqual(result["status"], "ready")
            self.assertEqual(result["rows"], 2)
            self.assertEqual(result["firstDate"], "2025-12-31")
            self.assertEqual(result["lastDate"], "2026-01-02")
            self.assertEqual(result["duplicateDates"], 0)


if __name__ == "__main__":
    unittest.main()
