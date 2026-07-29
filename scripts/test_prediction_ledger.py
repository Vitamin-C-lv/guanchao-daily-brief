#!/usr/bin/env python3
"""Contract tests for the immutable GitHub prediction ledger."""

from __future__ import annotations

import copy
import gzip
import json
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prediction_ledger as ledger


COMMIT = "1" * 40
MODEL_HASH = "2" * 64


def prediction(
    prediction_id: str = "fr-a-20260724-h1-000986-aaaaaaaaaaaa",
    *,
    horizon: int = 1,
    due_date: str = "2026-07-25",
    probability_target: str = "top_quartile",
    publication_status: str = "published",
    model_availability: str = "trained",
    legacy: bool = False,
) -> dict:
    published = publication_status == "published"
    if legacy:
        probability_target = "absolute_up"
    result = {
        "predictionId": prediction_id,
        "predictionDate": "2026-07-24",
        "market": "a-share",
        "sectorId": "000986",
        "sectorName": "能源",
        "horizonSessions": horizon,
        "dueDate": due_date,
        "modelVersion": "2026-07-21-relative-v2" if not legacy else "2026-07-20-probability-v1",
        "modelAvailability": model_availability,
        "publicationStatus": publication_status,
        "outputMode": "probability" if published else "evidence_observation",
        "calibrationStatus": "enabled" if published else "disabled",
        "probabilitySource": ("legacy_unknown" if legacy else "calibrated_model") if published else "raw_model",
        "probabilityTarget": probability_target,
        "rawScore": 0.2 if published else None,
        "rawProbability": 28.0 if published else None,
        "calibratedProbability": 31.0 if published else None,
        "absoluteUpProbability": 52.0 if published else None,
        "outperformanceProbability": 49.0 if published and not legacy else None,
        "topQuartileProbability": 31.0 if published and not legacy else None,
        "expectedExcessReturn": 0.4 if published else None,
        "historicalBaseRate": 25.0 if published else None,
        "effectiveEdge": 6.0 if published else None,
        "observationScore": None if published else 72.0,
        "abstainReasons": [] if published else ["quality_gate_failed"],
        "dataAsOf": "2026-07-24",
        "createdAt": "2026-07-24T20:00:00+08:00",
        "modelInputCompleteness": 1.0,
        "productionFeatureCoverage": 0.5,
        "claim": "若相对强度延续，则进入前25%的概率高于历史基准。",
        "evidence": [],
        "counterEvidence": [],
        "trigger": "5日动量保持为正。",
        "invalidation": "5日动量转负。",
        "sourceUrls": ["https://www.csindex.com.cn/zh-CN/indices/index-detail/000986"],
        "legacy": legacy,
        "benchmark": {
            "code": "000985",
            "name": "中证全指",
            "contractVersion": "a-share-benchmark-csi-all-share-v1",
        },
        "universe": {
            "id": "a-core12-v2",
            "sectorIds": [f"S{index:02d}" for index in range(12)],
            "topQuartileFraction": 0.25,
            "tieBreak": ["expected_excess_desc", "sector_id_asc"],
        },
    }
    if publication_status == "not_applicable":
        result.update({
            "outputMode": "current_observation",
            "calibrationStatus": "not_applicable",
            "probabilitySource": "none",
            "probabilityTarget": "none",
            "rawScore": None,
            "rawProbability": None,
            "calibratedProbability": None,
            "absoluteUpProbability": None,
            "outperformanceProbability": None,
            "topQuartileProbability": None,
            "expectedExcessReturn": None,
            "historicalBaseRate": None,
            "effectiveEdge": None,
            "observationScore": 72.0,
            "abstainReasons": ["model_unavailable"],
            "modelInputCompleteness": None,
            "productionFeatureCoverage": None,
        })
    return result


def snapshot(records: list[dict] | None = None, *, created_at: str = "2026-07-24T20:00:00+08:00") -> dict:
    return ledger.build_snapshot(
        predictions=records or [prediction()],
        created_at=created_at,
        data_as_of="2026-07-24",
        edition="closing",
        code_commit=COMMIT,
        models=[{
            "market": "a-share",
            "modelVersion": "2026-07-21-relative-v2",
            "artifactSha256": MODEL_HASH,
            "availability": "trained",
        }],
    )


def evaluation(
    prediction_id: str = "fr-a-20260724-h1-000986-aaaaaaaaaaaa",
    *,
    event_id: str | None = None,
    result: str = "correct",
) -> dict:
    return ledger.build_evaluation_event(
        prediction_id=prediction_id,
        evaluated_at="2026-07-25T20:00:00+08:00",
        evaluation_data_as_of="2026-07-25",
        horizon_sessions=1,
        realized_absolute_return=0.02,
        realized_benchmark_return=0.01,
        realized_excess_return=0.01,
        realized_sector_rank=1,
        realized_sector_count=12,
        realized_top_quartile=True,
        target_outcome=True,
        result=result,
        source_hashes={"sectorHistorySha256": "3" * 64, "benchmarkHistorySha256": "4" * 64},
        code_commit=COMMIT,
        evaluation_event_id=event_id,
    )


class PredictionLedgerTests(unittest.TestCase):
    def root(self, directory: str) -> Path:
        target = Path(directory) / "ledger"
        ledger.initialize_ledger(target)
        return target

    def test_snapshot_idempotent_append(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            item = snapshot()
            self.assertTrue(ledger.append_snapshot(root, item))
            self.assertFalse(ledger.append_snapshot(root, item))
            self.assertEqual(len(list(root.glob("snapshots/**/*.json.gz"))), 1)

    def test_same_prediction_id_same_content_is_not_duplicated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            ledger.append_snapshot(root, snapshot())
            records = ledger.collect_predictions(root)
            self.assertEqual(len(records), 1)

    def test_same_prediction_id_different_immutable_core_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            ledger.append_snapshot(root, snapshot())
            changed = prediction()
            changed["topQuartileProbability"] = 99.0
            with self.assertRaisesRegex(ledger.LedgerError, "immutable prediction conflict"):
                ledger.append_snapshot(root, snapshot([changed], created_at="2026-07-24T20:01:00+08:00"))

    def test_evaluation_reference_must_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            with self.assertRaisesRegex(ledger.LedgerError, "missing prediction reference"):
                ledger.append_evaluation(root, evaluation("missing"))

    def test_evaluation_does_not_overwrite_prediction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            ledger.append_snapshot(root, snapshot())
            before = ledger.collect_predictions(root)
            ledger.append_evaluation(root, evaluation())
            self.assertEqual(before, ledger.collect_predictions(root))

    def test_revision_event_chain_is_append_only(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            ledger.append_snapshot(root, snapshot())
            first = evaluation()
            ledger.append_evaluation(root, first)
            revision = ledger.build_evaluation_event(
                prediction_id=first["predictionId"],
                evaluated_at="2026-07-26T20:00:00+08:00",
                evaluation_data_as_of=first["evaluationDataAsOf"],
                horizon_sessions=first["horizonSessions"],
                realized_absolute_return=0.021,
                realized_benchmark_return=first["realizedBenchmarkReturn"],
                realized_excess_return=0.011,
                realized_sector_rank=first["realizedSectorRank"],
                realized_sector_count=first["realizedSectorCount"],
                realized_top_quartile=first["realizedTopQuartile"],
                target_outcome=first["targetOutcome"],
                result=first["result"],
                source_hashes=first["sourceHashes"],
                code_commit=first["codeCommit"],
                event_type="revision",
                supersedes_event_id=first["evaluationEventId"],
                reason="official close was revised",
            )
            ledger.append_evaluation(root, revision)
            self.assertEqual(len(ledger.collect_evaluations(root)), 2)

    def test_deterministic_gzip(self) -> None:
        document = snapshot()
        self.assertEqual(ledger.deterministic_gzip_json(document), ledger.deterministic_gzip_json(document))
        compressed = ledger.deterministic_gzip_json(document)
        self.assertEqual(int.from_bytes(compressed[4:8], "little"), 0)
        self.assertEqual(compressed[3] & 0x08, 0)

    def test_lf_crlf_portability(self) -> None:
        self.assertEqual(
            ledger.sha256_canonical_text(b'{"a":1}\n'),
            ledger.sha256_canonical_text(b'{"a":1}\r\n'),
        )

    def test_empty_remote_cannot_replace_nonempty_history(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            empty = self.root(directory)
            with self.assertRaisesRegex(ledger.LedgerError, "empty ledger would overwrite"):
                ledger.require_restored_ledger(empty, expected_snapshot_count=1)

    def test_local_migration_is_byte_identical_on_repeat(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "snapshots.jsonl.gz"
            legacy = ledger.to_legacy_snake_case(prediction())
            with source.open("wb") as raw_handle:
                with gzip.GzipFile(filename="", mode="wb", fileobj=raw_handle, mtime=0) as handle:
                    handle.write((json.dumps(legacy, ensure_ascii=False) + "\n").encode())
            roots = [Path(directory) / "one", Path(directory) / "two"]
            for root in roots:
                ledger.initialize_ledger(root)
                ledger.migrate_local_ledgers(root, source, None, code_commit=COMMIT)
            self.assertEqual(ledger.tree_hash(roots[0]), ledger.tree_hash(roots[1]))

    def test_historical_base_never_becomes_model_probability(self) -> None:
        legacy = ledger.normalize_legacy_prediction({
            **ledger.to_legacy_snake_case(prediction(legacy=True)),
            "absolute_up_probability": 51.9,
            "historical_base": 51.9,
            "raw_probability": None,
            "calibrated_probability": 51.9,
        })
        self.assertEqual(legacy["probabilitySource"], "historical_base_rate")
        self.assertIsNone(legacy["rawProbability"])
        self.assertIsNone(legacy["topQuartileProbability"])

    def test_legacy_is_excluded_from_current_metrics(self) -> None:
        review = ledger.build_weekly_review([prediction(legacy=True)], [], "2026-W30")
        self.assertEqual(review["slices"][0]["legacy"], True)
        self.assertEqual(review["metrics"]["topQuartileHitRate"], None)

    def test_pending_is_not_counted_as_wrong(self) -> None:
        review = ledger.build_weekly_review([prediction()], [], "2026-W30")
        self.assertEqual(review["counts"]["pending"], 1)
        self.assertEqual(review["metrics"]["topQuartileHitRate"], None)

    def test_abstained_is_not_counted_as_wrong(self) -> None:
        record = prediction(publication_status="abstained")
        review = ledger.build_weekly_review([record], [], "2026-W30")
        self.assertEqual(review["counts"]["abstained"], 1)
        self.assertEqual(review["counts"]["evaluated"], 0)

    def test_not_trained_is_not_in_metrics(self) -> None:
        record = prediction(publication_status="not_applicable", model_availability="not_trained")
        record.update({"outputMode": "current_observation", "calibrationStatus": "not_applicable", "probabilitySource": "none", "probabilityTarget": "none"})
        review = ledger.build_weekly_review([record], [], "2026-W30")
        self.assertEqual(review["counts"]["notTrained"], 1)

    def test_not_implemented_is_not_in_metrics(self) -> None:
        record = prediction(publication_status="not_applicable", model_availability="not_implemented")
        record.update({"outputMode": "current_observation", "calibrationStatus": "not_applicable", "probabilitySource": "none", "probabilityTarget": "none"})
        review = ledger.build_weekly_review([record], [], "2026-W30")
        self.assertEqual(review["counts"]["notImplemented"], 1)

    def test_due_dates_advance_1_5_20_sessions(self) -> None:
        calendar = [f"2026-07-{day:02d}" for day in range(20, 31)]
        self.assertEqual(ledger.due_date_for_sessions("2026-07-20", 1, calendar), "2026-07-21")
        self.assertEqual(ledger.due_date_for_sessions("2026-07-20", 5, calendar), "2026-07-25")
        self.assertIsNone(ledger.due_date_for_sessions("2026-07-20", 20, calendar))

    def test_benchmark_return_is_subtracted(self) -> None:
        event = ledger.evaluate_prediction_from_returns(
            prediction(),
            {"000986": 0.04, "000987": 0.03, "000988": 0.02, "000989": 0.01},
            benchmark_return=0.015,
            evaluated_at="2026-07-25T20:00:00+08:00",
            source_hashes={"sectorHistorySha256": "3" * 64, "benchmarkHistorySha256": "4" * 64},
            code_commit=COMMIT,
        )
        self.assertAlmostEqual(event["realizedExcessReturn"], 2.5)

    def test_top_quartile_tie_break_matches_dataset_contract(self) -> None:
        ranked = ledger.rank_sector_returns({"B": 0.1, "A": 0.1, "C": 0.0, "D": -0.1})
        self.assertEqual(ranked, ["A", "B", "C", "D"])

    def test_weekly_review_contains_required_slices(self) -> None:
        review = ledger.build_weekly_review([prediction()], [], "2026-W30")
        self.assertIn("modelVersion", review["slices"][0])
        self.assertIn("probabilityTarget", review["slices"][0])

    def test_probability_targets_are_not_mixed_in_brier(self) -> None:
        first = prediction()
        second = prediction("fr-a-20260724-h1-000987-bbbbbbbbbbbb", probability_target="absolute_up")
        second["sectorId"] = "000987"
        events = [evaluation(first["predictionId"]), evaluation(second["predictionId"])]
        review = ledger.build_weekly_review([first, second], events, "2026-W30")
        self.assertIn("top_quartile", review["targetMetrics"])
        self.assertIn("absolute_up", review["targetMetrics"])

    def test_insufficient_sample_returns_null_with_reason(self) -> None:
        review = ledger.build_weekly_review([prediction()], [], "2026-W30")
        self.assertIsNone(review["metrics"]["brierSkill"])
        self.assertEqual(review["metricReasons"]["brierSkill"], "insufficient_sample")

    def test_public_export_does_not_leak_internal_fields(self) -> None:
        public = ledger.public_record(prediction(), None)
        self.assertNotIn("codeCommit", public)
        self.assertNotIn("integrity", public)
        self.assertNotIn("localPath", json.dumps(public))

    def test_index_is_rebuilt_from_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            ledger.append_snapshot(root, snapshot())
            first = ledger.rebuild_index(root)
            (root / "index.json").unlink()
            second = ledger.rebuild_index(root)
            self.assertEqual(first, second)

    def test_manifest_is_rebuilt_from_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            ledger.append_snapshot(root, snapshot())
            ledger.rebuild_index(root)
            manifest = root / "manifests" / "2026" / "07.json"
            before = manifest.read_bytes()
            manifest.unlink()
            ledger.rebuild_index(root)
            self.assertEqual(before, manifest.read_bytes())

    def test_concurrent_append_merge_keeps_both_records(self) -> None:
        left = snapshot([prediction()])
        other = prediction("fr-a-20260724-h1-000987-bbbbbbbbbbbb")
        other["sectorId"] = "000987"
        right = snapshot([other], created_at="2026-07-24T20:01:00+08:00")
        merged = ledger.merge_snapshot_documents([left], [right])
        self.assertEqual(len(ledger.unique_predictions_from_snapshots(merged)), 2)

    def test_push_conflict_retries_three_times(self) -> None:
        attempts: list[int] = []
        def runner(attempt: int) -> bool:
            attempts.append(attempt)
            return attempt == 3
        self.assertTrue(ledger.retry_push(runner, maximum_attempts=3))
        self.assertEqual(attempts, [1, 2, 3])

    def test_month_path_matches_internal_date(self) -> None:
        item = snapshot()
        self.assertEqual(ledger.snapshot_relative_path(item), f"snapshots/2026/07/{item['runId']}.json.gz")

    def test_canonical_hash_ignores_line_endings(self) -> None:
        self.assertEqual(ledger.canonical_text_bytes(b"a\r\nb\r\n"), b"a\nb\n")

    def test_snapshot_file_cannot_be_overwritten_in_place(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = self.root(directory)
            item = snapshot()
            ledger.append_snapshot(root, item)
            path = root / ledger.snapshot_relative_path(item)
            path.write_bytes(b"tampered")
            with self.assertRaisesRegex(ledger.LedgerError, "immutable snapshot path conflict"):
                ledger.append_snapshot(root, item)


if __name__ == "__main__":
    unittest.main()
