#!/usr/bin/env python3
"""Execute every adversarial fixture against the production ledger code."""

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
from test_prediction_ledger import COMMIT, evaluation, prediction, snapshot


FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "prediction-ledger"


class PredictionLedgerFixtureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "ledger"
        self.public = Path(self.temporary.name) / "public"
        ledger.initialize_ledger(self.root)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def base(self, *, with_evaluation: bool = False) -> None:
        ledger.append_snapshot(self.root, snapshot())
        if with_evaluation:
            ledger.append_evaluation(self.root, evaluation())
        ledger.rebuild_index(self.root)

    def write_review(self, records: list[dict], events: list[dict], mutate) -> None:
        review = ledger.build_weekly_review(records, events, "2026-W30")
        mutate(review)
        path = self.root / "reviews" / "2026" / "2026-W30.json"
        ledger.write_json_atomic(path, review)
        ledger.rebuild_index(self.root)

    def execute(self, mutation: str) -> None:
        if mutation == "duplicate_prediction_conflict":
            self.base()
            changed = prediction()
            changed["topQuartileProbability"] = 99.0
            ledger.append_snapshot(self.root, snapshot([changed], created_at="2026-07-24T20:01:00+08:00"))
        elif mutation == "missing_evaluation_reference":
            ledger.append_evaluation(self.root, evaluation("missing-prediction"))
        elif mutation == "evaluation_overwrite":
            self.base(with_evaluation=True)
            event = evaluation()
            (self.root / ledger.evaluation_relative_path(event)).write_bytes(b"tampered")
            ledger.append_evaluation(self.root, event)
        elif mutation == "wrong_month_path":
            self.base()
            original = next(self.root.glob("snapshots/**/*.json.gz"))
            wrong = self.root / "snapshots" / "2026" / "08" / original.name
            wrong.parent.mkdir(parents=True)
            original.replace(wrong)
            ledger.collect_snapshot_documents(self.root)
        elif mutation == "snapshot_hash_mismatch":
            self.base()
            path = next(self.root.glob("snapshots/**/*.json.gz"))
            document = json.loads(gzip.decompress(path.read_bytes()))
            document["predictions"][0]["claim"] = "tampered"
            path.write_bytes(ledger.deterministic_gzip_bytes(ledger.canonical_json_bytes(document)))
            ledger.collect_snapshot_documents(self.root)
        elif mutation == "manifest_missing_entry":
            self.base()
            path = next(self.root.glob("manifests/**/*.json"))
            value = json.loads(path.read_text(encoding="utf-8"))
            value["entries"] = []
            ledger.write_json_atomic(path, value)
            ledger.verify_ledger(self.root)
        elif mutation == "index_count_mismatch":
            self.base()
            path = self.root / "index.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            value["predictionRecordCount"] = 999
            ledger.write_json_atomic(path, value)
            ledger.verify_ledger(self.root)
        elif mutation == "legacy_leak_current_metrics":
            record = prediction(legacy=True)
            ledger.append_snapshot(self.root, snapshot([record]))
            self.write_review([record], [], lambda review: review["policy"].update({"legacyExcludedFromCurrentMetrics": False}))
            ledger.verify_ledger(self.root)
        elif mutation == "pending_counted_as_wrong":
            record = prediction()
            ledger.append_snapshot(self.root, snapshot([record]))
            self.write_review([record], [], lambda review: review["counts"].update({"pending": 0, "evaluated": 1}))
            ledger.verify_ledger(self.root)
        elif mutation == "abstention_counted_as_wrong":
            record = prediction(publication_status="abstained")
            ledger.append_snapshot(self.root, snapshot([record]))
            self.write_review([record], [], lambda review: review["counts"].update({"abstained": 0, "evaluated": 1}))
            ledger.verify_ledger(self.root)
        elif mutation == "targets_mixed_in_brier":
            first = prediction()
            second = prediction("fr-a-20260724-h1-000987-bbbbbbbbbbbb", probability_target="absolute_up")
            second["sectorId"] = "000987"
            ledger.append_snapshot(self.root, snapshot([first, second]))
            events = [evaluation(first["predictionId"]), evaluation(second["predictionId"])]
            for event in events:
                ledger.append_evaluation(self.root, event)
            self.write_review([first, second], events, lambda review: review["policy"].update({"probabilityTargetsNeverMixed": False}))
            ledger.verify_ledger(self.root)
        elif mutation == "public_internal_field_leak":
            self.base()
            ledger.export_public(self.root, self.public)
            index_path = self.public / "index.json"
            index = json.loads(index_path.read_text(encoding="utf-8"))
            shard = self.public / index["files"][0]["path"]
            payload = json.loads(shard.read_text(encoding="utf-8"))
            payload["records"][0]["codeCommit"] = COMMIT
            ledger.write_json_atomic(shard, payload)
            index["files"][0]["sha256"] = ledger.sha256_canonical_text(shard)
            ledger.write_json_atomic(index_path, index)
            ledger.verify_ledger(self.root, public_root=self.public)
        elif mutation == "history_truncation":
            self.base()
            ledger.export_public(self.root, self.public)
            path = self.public / "index.json"
            index = json.loads(path.read_text(encoding="utf-8"))
            index["recordCount"] = 0
            ledger.write_json_atomic(path, index)
            ledger.verify_ledger(self.root, public_root=self.public)
        elif mutation == "empty_ledger_overwrite":
            ledger.require_restored_ledger(self.root, expected_snapshot_count=1)
        elif mutation == "nondeterministic_gzip":
            self.base()
            path = next(self.root.glob("snapshots/**/*.json.gz"))
            document = json.loads(gzip.decompress(path.read_bytes()))
            with path.open("wb") as raw:
                with gzip.GzipFile(filename="timestamped.json", mode="wb", fileobj=raw, mtime=123) as handle:
                    handle.write(ledger.canonical_json_bytes(document))
            ledger.collect_snapshot_documents(self.root)
        elif mutation == "invalid_revision_chain":
            self.base()
            first = evaluation()
            revision = ledger.build_evaluation_event(
                prediction_id=first["predictionId"], evaluated_at="2026-07-26T20:00:00+08:00",
                evaluation_data_as_of=first["evaluationDataAsOf"], horizon_sessions=1,
                realized_absolute_return=2.1, realized_benchmark_return=1.0, realized_excess_return=1.1,
                realized_sector_rank=1, realized_sector_count=12, realized_top_quartile=True,
                target_outcome=True, result="correct", source_hashes=first["sourceHashes"], code_commit=COMMIT,
                event_type="revision", supersedes_event_id="peval-20260725-00000000000000000000", reason="bad chain",
            )
            ledger.append_evaluation(self.root, revision)
        elif mutation == "schema_extra_property":
            document = snapshot()
            document["unexpected"] = True
            ledger.validate_snapshot_document(document)
        elif mutation == "invalid_model_state":
            record = prediction()
            record["modelAvailability"] = "maybe"
            ledger.validate_prediction(record)
        elif mutation == "invalid_probability_lineage":
            record = prediction()
            record["probabilitySource"] = "copied_dashboard_value"
            ledger.validate_prediction(record)
        elif mutation == "invalid_calendar_order":
            ledger.due_date_for_sessions("2026-07-20", 1, ["2026-07-22", "2026-07-21", "2026-07-21"])
        else:
            self.fail(f"fixture mutation has no executable handler: {mutation}")

    def test_all_adversarial_fixtures_fail_closed(self) -> None:
        fixtures = sorted(FIXTURE_ROOT.glob("*.json"))
        self.assertGreaterEqual(len(fixtures), 20)
        for path in fixtures:
            with self.subTest(fixture=path.name):
                payload = json.loads(path.read_text(encoding="utf-8"))
                try:
                    with self.assertRaisesRegex(ledger.LedgerError, payload["expectedError"]):
                        self.execute(payload["mutation"])
                finally:
                    self.temporary.cleanup()
                    self.temporary = tempfile.TemporaryDirectory()
                    self.root = Path(self.temporary.name) / "ledger"
                    self.public = Path(self.temporary.name) / "public"
                    ledger.initialize_ledger(self.root)


if __name__ == "__main__":
    unittest.main()
