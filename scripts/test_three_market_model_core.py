#!/usr/bin/env python3
"""Targeted tests for the private three-market model core."""

from __future__ import annotations

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
    oos_evaluate,
    sha256_bytes,
    write_immutable,
)


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


if __name__ == "__main__":
    unittest.main()
