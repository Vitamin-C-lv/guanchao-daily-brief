#!/usr/bin/env python3
"""Contract tests for immutable prediction datasets."""

from __future__ import annotations

import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prediction_dataset as datasets
import sector_rotation as rotation


DATASET_ID = "a-share-2026-07-21-c403b3f790b8"
SNAPSHOT = rotation.ROOT / "models" / "sector-rotation" / "datasets" / "a-share" / DATASET_ID


def trading_days() -> list[str]:
    # Includes a weekend and the 2026 Spring Festival closure implicitly: only
    # explicit market sessions are present, so calendar position is authoritative.
    return [
        "2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08",
        "2026-01-09", "2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15",
        "2026-01-16", "2026-01-19", "2026-01-20", "2026-01-21", "2026-01-22",
        "2026-01-23", "2026-01-26", "2026-01-27", "2026-01-28", "2026-01-29",
        "2026-01-30", "2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05",
    ]


def synthetic_panel(reverse: bool = False) -> tuple[list[dict[str, object]], set[str], dict[str, dict[str, float]], dict[str, float]]:
    days = trading_days()
    codes = {f"S{index:02d}" for index in range(12)}
    rows: list[dict[str, object]] = []
    histories: dict[str, dict[str, float]] = {}
    benchmark = {date: 100 + index for index, date in enumerate(days)}
    for index, code in enumerate(sorted(codes)):
        # S00 and S01 deliberately tie on all returns to exercise code tie-break.
        slope = 0.5 if index < 2 else 0.5 + index / 100
        histories[code] = {date: 100 + slope * day_index for day_index, date in enumerate(days)}
        for date in days:
            row: dict[str, object] = {"date": date, "code": code, "name": code}
            for feature in rotation.FEATURES + rotation.MODEL_FEATURES:
                row[feature] = float(index + 1)
            rows.append(row)
    if reverse:
        rows.reverse()
    return rows, codes, histories, benchmark


class PredictionDatasetContractTests(unittest.TestCase):
    def labelled(self, reverse: bool = False):
        return datasets.create_labelled_rows(*synthetic_panel(reverse))

    def test_contract_versions_are_frozen(self) -> None:
        self.assertEqual(datasets.DATASET_SCHEMA_VERSION, 1)
        self.assertEqual(datasets.A_SHARE_LABEL_CONTRACT_VERSION, "a-share-labels-v1")
        self.assertEqual(datasets.A_SHARE_FEATURE_CONTRACT_VERSION, "a-share-price-volume-v2")
        self.assertEqual(datasets.A_SHARE_BENCHMARK_CONTRACT_VERSION, "a-share-benchmark-csi-all-share-v1")

    def test_explicit_one_five_twenty_session_calendar(self) -> None:
        rows, calendar = self.labelled()
        first = [row for row in rows if row["date"] == calendar[0]][0]
        self.assertEqual(first["targetDate1"], calendar[1])
        self.assertEqual(first["targetDate5"], calendar[5])
        self.assertEqual(first["targetDate20"], calendar[20])
        self.assertEqual(first["targetDate1"], "2026-01-05")  # weekend did not count
        self.assertLess(first["date"], first["targetDate20"])

    def test_absolute_outperformance_and_excess_labels(self) -> None:
        rows, _ = self.labelled()
        row = next(item for item in rows if item["date"] == "2026-01-02" and item["code"] == "S11")
        expected_excess = float(row["sectorForwardReturn5"]) - float(row["benchmarkForwardReturn5"])
        self.assertEqual(row["absoluteUp5"], int(float(row["sectorForwardReturn5"]) > 0))
        self.assertEqual(row["outperformance5"], int(expected_excess > 0))
        self.assertAlmostEqual(float(row["expectedExcess5"]), expected_excess)

    def test_top_quartile_ceil_and_code_tie_break(self) -> None:
        rows, _ = self.labelled()
        section = [row for row in rows if row["date"] == "2026-01-02"]
        self.assertEqual(sum(int(row["topQuartile1"]) for row in section), 3)
        tied = [row for row in section if row["code"] in {"S00", "S01"}]
        self.assertLess(int(next(row for row in tied if row["code"] == "S00")["realizedRank1"]), int(next(row for row in tied if row["code"] == "S01")["realizedRank1"]))
        self.assertEqual(sorted(int(row["realizedRank1"]) for row in section), list(range(1, 13)))

    def test_input_order_does_not_change_labels_or_gzip_bytes(self) -> None:
        rows_a, _ = self.labelled(False)
        rows_b, _ = self.labelled(True)
        raw_a, compressed_a = datasets.panel_bytes(rows_a)
        raw_b, compressed_b = datasets.panel_bytes(rows_b)
        self.assertEqual(raw_a, raw_b)
        self.assertEqual(compressed_a, compressed_b)
        self.assertEqual(datasets.sha256_bytes(compressed_a), datasets.sha256_bytes(compressed_b))

    def test_missing_sector_is_rejected_and_missing_benchmark_never_becomes_zero(self) -> None:
        rows, codes, histories, benchmark = synthetic_panel()
        with self.assertRaisesRegex(datasets.DatasetError, "complete 12-sector"):
            datasets.create_labelled_rows(rows[:-1], codes, histories, benchmark)
        broken = dict(benchmark)
        del broken[trading_days()[5]]
        labelled, _ = datasets.create_labelled_rows(rows, codes, histories, broken)
        first = next(row for row in labelled if row["date"] == trading_days()[0])
        self.assertIsNone(first["expectedExcess5"])
        self.assertIsNone(first["absoluteUp5"])

    def test_benchmark_never_enters_ranked_universe(self) -> None:
        rows, codes, histories, benchmark = synthetic_panel()
        with self.assertRaisesRegex(datasets.DatasetError, "benchmark 000985"):
            datasets.create_labelled_rows(rows, {"000985", *codes}, {"000985": histories["S00"], **histories}, benchmark)

    def test_terminal_labels_are_null_not_zero(self) -> None:
        rows, calendar = self.labelled()
        terminal = next(row for row in rows if row["date"] == calendar[-1])
        for horizon in (1, 5, 20):
            self.assertIsNone(terminal[f"targetDate{horizon}"])
            self.assertIsNone(terminal[f"absoluteUp{horizon}"])
            self.assertIsNone(terminal[f"expectedExcess{horizon}"])

    def test_snapshot_verify_manifest_hash_and_immutable_write(self) -> None:
        manifest = datasets.verify_snapshot(SNAPSHOT)
        self.assertEqual(manifest["datasetId"], DATASET_ID)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "fixed"
            datasets.write_new_snapshot(target, {"a.txt": b"one"})
            with self.assertRaisesRegex(datasets.DatasetError, "cannot be overwritten"):
                datasets.write_new_snapshot(target, {"a.txt": b"two"})

    def test_diff_self_has_no_difference(self) -> None:
        diff = datasets.diff_snapshots(SNAPSHOT, SNAPSHOT)
        self.assertTrue(diff["identical"])
        self.assertEqual(diff["labelChanges"], 0)

    def test_diff_identifies_a_label_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            left = Path(temporary) / "left"
            right = Path(temporary) / "right"
            shutil.copytree(SNAPSHOT, left)
            shutil.copytree(SNAPSHOT, right)
            for snapshot in (left, right):
                manifest_path = snapshot / "manifest.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                manifest["datasetId"] = snapshot.name
                manifest_path.write_bytes(datasets.json_bytes(manifest))
            rows = datasets.parse_snapshot_panel(right / "panel.csv.gz")
            target = next(row for row in rows if row["expectedExcess1"] is not None)
            target["expectedExcess1"] = float(target["expectedExcess1"]) + 1e-13
            raw, compressed = datasets.panel_bytes(rows)
            (right / "panel.csv.gz").write_bytes(compressed)
            manifest_path = right / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["panel"].update({
                "sha256": datasets.sha256_bytes(compressed),
                "uncompressedSha256": datasets.sha256_bytes(raw),
                "compressedBytes": len(compressed),
                "uncompressedBytes": len(raw),
            })
            manifest_path.write_bytes(datasets.json_bytes(manifest))
            diff = datasets.diff_snapshots(left, right)
            self.assertFalse(diff["identical"])
            self.assertGreater(diff["labelChanges"], 0)

    def test_training_loader_has_no_mutable_feature_fallback_and_production_file_is_unchanged(self) -> None:
        source = (rotation.ROOT / "scripts" / "sector_probability.py").read_text(encoding="utf-8")
        self.assertIn("load_verified_dataset", source)
        self.assertNotIn("def load_panel", source)
        self.assertNotIn("rotation.FEATURE_PATH.exists", source)
        model_sha = datasets.sha256_path(rotation.MULTI_TARGET_MODEL_PATH)
        self.assertEqual(model_sha, "358e19ae3dacbfdba71db195c0171c627646f33aaadf39250fb0f7b7cbb994d8")

    def test_label_formula_is_not_duplicated_in_trainer(self) -> None:
        source = (rotation.ROOT / "scripts" / "sector_probability.py").read_text(encoding="utf-8")
        self.assertNotIn("raw_forward", source)
        self.assertNotIn("benchmark_forward", source)
        self.assertNotIn("excess_forward", source)


if __name__ == "__main__":
    unittest.main()
