#!/usr/bin/env python3
"""Contract tests for immutable prediction datasets and snapshot-only training."""

from __future__ import annotations

import csv
import gzip
import json
import shutil
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prediction_dataset as datasets
import sector_rotation as rotation


def registered_snapshot() -> Path:
    index = datasets.read_json(rotation.ROOT / "models" / "sector-rotation" / "datasets" / "index.json")
    candidates = [item for item in index["datasets"] if item.get("lifecycleStatus") == "candidate"]
    if len(candidates) != 1:
        raise AssertionError(f"expected exactly one candidate snapshot, found {len(candidates)}")
    return rotation.ROOT / "models" / "sector-rotation" / "datasets" / candidates[0]["path"]


SNAPSHOT = registered_snapshot()


def trading_days() -> list[str]:
    # The real SSE 2026 artifact marks 2026-02-16 through 2026-02-23 as closed.
    # Only actual benchmark sessions appear here, so the holiday cannot consume a
    # horizon slot.
    return [
        "2026-02-13", "2026-02-24", "2026-02-25", "2026-02-26", "2026-02-27",
        "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06",
        "2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13",
        "2026-03-16", "2026-03-17", "2026-03-18", "2026-03-19", "2026-03-20",
        "2026-03-23", "2026-03-24", "2026-03-25", "2026-03-26", "2026-03-27",
    ]


def synthetic_panel(reverse: bool = False) -> tuple[list[dict[str, object]], set[str], dict[str, dict[str, float]], dict[str, float]]:
    days = trading_days()
    codes = {f"S{index:02d}" for index in range(12)}
    rows: list[dict[str, object]] = []
    histories: dict[str, dict[str, float]] = {}
    benchmark = {date: 100 + index for index, date in enumerate(days)}
    for index, code in enumerate(sorted(codes)):
        # S00 and S01 deliberately tie to exercise code-based deterministic ranking.
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


def write_history(path: Path, code: str, days: list[str], slope: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=rotation.HISTORY_FIELDS, lineterminator="\n")
        writer.writeheader()
        for index, date in enumerate(days):
            writer.writerow(
                {
                    "date": date,
                    "code": code,
                    "name": code,
                    "close": f"{100 + slope * index:.8f}",
                    "change_pct": "0",
                    "trading_volume": "1000",
                    "trading_value_yi": "10",
                    "constituents": "12",
                }
            )


def fixture_days(count: int = 100) -> list[str]:
    # Synthetic sessions only need an ordered explicit benchmark calendar.
    start = date(2024, 1, 1)
    return [(start + timedelta(days=index)).isoformat() for index in range(count)]


def make_small_build_input(root: Path, *, altered: bool = False) -> tuple[Path, Path, Path, list[str]]:
    taxonomy = datasets.read_json(rotation.TAXONOMY_PATH)
    codes = [item["code"] for item in taxonomy["indices"]]
    days = fixture_days()
    history_dir = root / "history"
    for offset, code in enumerate(codes):
        slope = 0.20 + offset / 100
        write_history(history_dir / f"{code}.csv.gz", code, days, slope)
    write_history(history_dir / "000985.csv.gz", "000985", days, 0.18)
    if altered:
        # A coherent source change changes forward labels but not the feature file.
        path = history_dir / f"{codes[0]}.csv.gz"
        rows = list(csv.DictReader(gzip.open(path, "rt", encoding="utf-8", newline="")))
        rows[40]["close"] = f"{float(rows[40]['close']) * 1.05:.8f}"
        with gzip.open(path, "wt", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=rotation.HISTORY_FIELDS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
    feature_path = root / "features.csv.gz"
    with gzip.open(feature_path, "wt", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=datasets.feature_columns(), lineterminator="\n")
        writer.writeheader()
        for date_index, date in enumerate(days):
            for code_index, code in enumerate(codes):
                row: dict[str, object] = {"date": date, "code": code, "name": code}
                for feature_index, feature in enumerate(rotation.FEATURES + rotation.MODEL_FEATURES):
                    row[feature] = 0.01 * (date_index + code_index + feature_index + 1)
                writer.writerow(row)
    return feature_path, history_dir, history_dir / "000985.csv.gz", days


class PredictionDatasetContractTests(unittest.TestCase):
    def labelled(self, reverse: bool = False):
        return datasets.create_labelled_rows(*synthetic_panel(reverse))

    def test_contract_versions_are_frozen(self) -> None:
        self.assertEqual(datasets.DATASET_SCHEMA_VERSION, 1)
        self.assertEqual(datasets.A_SHARE_LABEL_CONTRACT_VERSION, "a-share-labels-v1")
        self.assertEqual(datasets.A_SHARE_FEATURE_CONTRACT_VERSION, "a-share-price-volume-v2")
        self.assertEqual(datasets.A_SHARE_BENCHMARK_CONTRACT_VERSION, "a-share-benchmark-csi-all-share-v1")

    def test_explicit_one_five_twenty_session_calendar_and_real_holiday(self) -> None:
        calendar_artifact = datasets.read_json(rotation.CALENDAR_PATH)
        self.assertIn("2026-02-16", calendar_artifact["closedWeekdays"])
        self.assertIn("2026-02-23", calendar_artifact["closedWeekdays"])
        rows, calendar = self.labelled()
        first = next(row for row in rows if row["date"] == calendar[0] and row["code"] == "S00")
        self.assertEqual(first["targetDate1"], "2026-02-24")
        self.assertEqual(first["targetDate5"], calendar[5])
        self.assertEqual(first["targetDate20"], calendar[20])
        self.assertLess(first["date"], first["targetDate20"])

    def test_absolute_outperformance_and_expected_excess_labels(self) -> None:
        rows, _ = self.labelled()
        row = next(item for item in rows if item["date"] == "2026-02-13" and item["code"] == "S11")
        expected_excess = float(row["sectorForwardReturn5"]) - float(row["benchmarkForwardReturn5"])
        self.assertEqual(row["absoluteUp5"], int(float(row["sectorForwardReturn5"]) > 0))
        self.assertEqual(row["outperformance5"], int(expected_excess > 0))
        self.assertAlmostEqual(float(row["expectedExcess5"]), expected_excess)

    def test_top_quartile_ceil_and_code_tie_break(self) -> None:
        rows, _ = self.labelled()
        section = [row for row in rows if row["date"] == "2026-02-13"]
        self.assertEqual(sum(int(row["topQuartile1"]) for row in section), 3)
        tied = [row for row in section if row["code"] in {"S00", "S01"}]
        self.assertLess(
            int(next(row for row in tied if row["code"] == "S00")["realizedRank1"]),
            int(next(row for row in tied if row["code"] == "S01")["realizedRank1"]),
        )
        self.assertEqual(sorted(int(row["realizedRank1"]) for row in section), list(range(1, 13)))

    def test_sector_extra_date_cannot_change_benchmark_calendar_target(self) -> None:
        rows, codes, histories, benchmark = synthetic_panel()
        histories["S00"]["2026-02-17"] = 999.0  # benchmark is closed on this date.
        labelled, calendar = datasets.create_labelled_rows(rows, codes, histories, benchmark)
        first = next(row for row in labelled if row["date"] == "2026-02-13" and row["code"] == "S00")
        self.assertEqual(first["targetDate1"], calendar[1])
        self.assertEqual(first["targetDate1"], "2026-02-24")

    def test_missing_sector_at_true_target_leaves_horizon_null_without_drift(self) -> None:
        rows, codes, histories, benchmark = synthetic_panel()
        del histories["S00"]["2026-03-02"]  # the true fifth benchmark session after 2026-02-13
        labelled, calendar = datasets.create_labelled_rows(rows, codes, histories, benchmark)
        first = next(row for row in labelled if row["date"] == "2026-02-13" and row["code"] == "S00")
        self.assertEqual(calendar[5], "2026-03-02")
        self.assertIsNone(first["targetDate5"])
        self.assertIsNone(first["expectedExcess5"])
        self.assertIsNone(first["absoluteUp5"])
        self.assertEqual(first["targetDate1"], "2026-02-24")

    def test_input_order_does_not_change_labels_or_gzip_bytes(self) -> None:
        rows_a, _ = self.labelled(False)
        rows_b, _ = self.labelled(True)
        raw_a, compressed_a = datasets.panel_bytes(rows_a)
        raw_b, compressed_b = datasets.panel_bytes(rows_b)
        self.assertEqual(raw_a, raw_b)
        self.assertEqual(compressed_a, compressed_b)
        self.assertEqual(datasets.sha256_bytes(compressed_a), datasets.sha256_bytes(compressed_b))
        self.assertEqual(compressed_a[3] & 0x08, 0)
        self.assertEqual(int.from_bytes(compressed_a[4:8], "little"), 0)

    def test_missing_sector_and_missing_benchmark_are_not_coerced_to_zero(self) -> None:
        rows, codes, histories, benchmark = synthetic_panel()
        with self.assertRaisesRegex(datasets.DatasetError, "incomplete ranked universe"):
            datasets.create_labelled_rows(rows[:-1], codes, histories, benchmark)
        broken = dict(benchmark)
        broken[trading_days()[5]] = None  # session remains known but the close is unavailable
        labelled, _ = datasets.create_labelled_rows(rows, codes, histories, broken)
        first = next(row for row in labelled if row["date"] == trading_days()[0])
        self.assertIsNone(first["expectedExcess5"])
        self.assertIsNone(first["absoluteUp5"])

    def test_benchmark_never_enters_ranked_universe(self) -> None:
        rows, codes, histories, benchmark = synthetic_panel()
        with self.assertRaisesRegex(datasets.DatasetError, "benchmark entered ranked universe"):
            datasets.create_labelled_rows(rows, {"000985", *codes}, {"000985": histories["S00"], **histories}, benchmark)

    def test_terminal_labels_are_null_not_zero(self) -> None:
        rows, calendar = self.labelled()
        terminal = next(row for row in rows if row["date"] == calendar[-1])
        for horizon in (1, 5, 20):
            self.assertIsNone(terminal[f"targetDate{horizon}"])
            self.assertIsNone(terminal[f"absoluteUp{horizon}"])
            self.assertIsNone(terminal[f"expectedExcess{horizon}"])

    def test_registered_snapshot_verifies_and_has_full_depth(self) -> None:
        manifest = datasets.verify_snapshot(SNAPSHOT)
        self.assertEqual(manifest["datasetId"], SNAPSHOT.name)
        self.assertEqual(manifest["calendar"]["sha256"], manifest["calendar"]["sessionCalendarSha256"])
        self.assertEqual(manifest["calendar"]["sha256"], datasets.read_json(SNAPSHOT / "source-manifest.json")["marketCalendarSha256"])
        for horizon in ("1", "5", "20"):
            self.assertGreaterEqual(manifest["maturity"][horizon]["matureDates"], 1008)

    def test_snapshot_immutable_write_and_lifecycle_rules(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "fixed"
            datasets.write_new_snapshot(target, {"a.txt": b"one"})
            with self.assertRaisesRegex(datasets.DatasetError, "cannot be overwritten"):
                datasets.write_new_snapshot(target, {"a.txt": b"two"})
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "datasets"
            root.mkdir()
            index = {
                "schemaVersion": 1,
                "datasets": [{
                    "datasetId": "a-share-2026-07-21-aaaaaaaaaaaa", "market": "A_SHARE", "creationStatus": "candidate",
                    "lifecycleStatus": "candidate", "statusHistory": [{"from": None, "to": "candidate", "changedAt": "2026-07-27T00:00:00Z", "codeCommit": "a" * 40, "reason": "initial registration"}],
                    "path": "a-share/a-share-2026-07-21-aaaaaaaaaaaa", "panelSha256": "a" * 64, "manifestSha256": "b" * 64,
                }],
                "legacyProduction": [],
            }
            (root / "index.json").write_bytes(datasets.json_bytes(index))
            datasets.set_dataset_status(root, "a-share-2026-07-21-aaaaaaaaaaaa", "active", "activate test", "b" * 40)
            datasets.set_dataset_status(root, "a-share-2026-07-21-aaaaaaaaaaaa", "retired", "retire test", "c" * 40)
            with self.assertRaisesRegex(datasets.DatasetError, "illegal lifecycle transition"):
                datasets.set_dataset_status(root, "a-share-2026-07-21-aaaaaaaaaaaa", "active", "forbidden", "d" * 40)

    def test_build_twice_is_byte_identical_and_contract_version_changes_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feature, history, benchmark, days = make_small_build_input(root / "input")
            first = datasets.build_snapshot(feature, root / "first", "a" * 40, as_of=days[-1], history_dir=history, benchmark_history_file=benchmark, created_at="2026-07-27T00:00:00Z")
            second = datasets.build_snapshot(feature, root / "second", "a" * 40, as_of=days[-1], history_dir=history, benchmark_history_file=benchmark, created_at="2026-07-27T00:00:00Z")
            self.assertEqual(first["datasetId"], second["datasetId"])
            self.assertEqual(first["manifest"]["panel"]["sha256"], second["manifest"]["panel"]["sha256"])
            self.assertEqual(
                (Path(first["snapshot"]) / "panel.csv.gz").read_bytes(),
                (Path(second["snapshot"]) / "panel.csv.gz").read_bytes(),
            )
            alternate = datasets.build_snapshot(feature, root / "alternate", "a" * 40, as_of=days[-1], history_dir=history, benchmark_history_file=benchmark, created_at="2026-07-27T00:00:00Z", label_contract_version="a-share-labels-v2-test")
            self.assertNotEqual(first["datasetId"], alternate["datasetId"])
            self.assertEqual(first["manifest"]["panel"]["uncompressedSha256"], alternate["manifest"]["panel"]["uncompressedSha256"])

    def test_diff_identifies_a_coherent_label_change(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            feature_a, history_a, benchmark_a, days = make_small_build_input(root / "left")
            feature_b, history_b, benchmark_b, _ = make_small_build_input(root / "right", altered=True)
            left = datasets.build_snapshot(feature_a, root / "out-left", "a" * 40, as_of=days[-1], history_dir=history_a, benchmark_history_file=benchmark_a, created_at="2026-07-27T00:00:00Z")
            right = datasets.build_snapshot(feature_b, root / "out-right", "a" * 40, as_of=days[-1], history_dir=history_b, benchmark_history_file=benchmark_b, created_at="2026-07-27T00:00:00Z")
            diff = datasets.diff_snapshots(Path(left["snapshot"]), Path(right["snapshot"]))
            self.assertFalse(diff["identical"])
            self.assertGreater(diff["labelChanges"], 0)

    def test_training_loader_has_no_mutable_feature_fallback_and_production_file_is_unchanged(self) -> None:
        source = (rotation.ROOT / "scripts" / "sector_probability.py").read_text(encoding="utf-8")
        self.assertIn("load_verified_dataset", source)
        self.assertNotIn("def load_panel", source)
        self.assertNotIn("rotation.FEATURE_PATH.exists", source)
        self.assertIn("datasetPanelSha256", source)
        self.assertIn("labelDiagnosticsSha256", source)
        model_sha = datasets.sha256_path(rotation.MULTI_TARGET_MODEL_PATH)
        self.assertEqual(model_sha, "358e19ae3dacbfdba71db195c0171c627646f33aaadf39250fb0f7b7cbb994d8")

    def test_label_formula_is_not_duplicated_in_trainer(self) -> None:
        source = (rotation.ROOT / "scripts" / "sector_probability.py").read_text(encoding="utf-8")
        self.assertNotIn("raw_forward", source)
        self.assertNotIn("benchmark_forward", source)
        self.assertNotIn("excess_forward", source)


if __name__ == "__main__":
    unittest.main()
