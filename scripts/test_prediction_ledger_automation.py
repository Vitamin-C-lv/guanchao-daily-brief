#!/usr/bin/env python3
"""Regression tests for production-ledger automation decisions."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prediction_ledger as ledger
import prediction_ledger_automation as automation


class LedgerAutomationTests(unittest.TestCase):
    def test_non_trading_refresh_uses_data_as_of_for_noop(self) -> None:
        """A newer generatedAt must not rewrite an already-snapshotted session."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "ledger"
            ledger.initialize_ledger(root)
            (root / "index.json").write_text(json.dumps({"lastPredictionDate": "2026-07-24"}), encoding="utf-8")
            rotation = Path(directory) / "rotation.json"
            rotation.write_text(json.dumps({"generatedAt": "2026-07-29T20:00:00+08:00", "markets": [{"id": "a-share", "asOf": "2026-07-24"}]}), encoding="utf-8")
            verification = {"snapshotCount": 9, "predictionRecordCount": 324, "evaluationEventCount": 300}
            with patch.object(automation.ledger, "verify_ledger", side_effect=[verification, verification]), patch.object(automation.ledger, "require_restored_ledger"), patch.object(automation, "append_available_evaluations", return_value={"appended": 0}), patch.object(automation.ledger, "export_public", return_value={"recordCount": 324, "files": []}), patch.object(automation.ledger, "snapshot_from_rotation_payload") as create_snapshot:
                result = automation.run("closing", root, rotation, code_commit="1" * 40, iso_week="2026-W30")
            self.assertEqual(result["snapshot"], {"written": False, "result": "NO_OP", "reason": "publication date is already represented", "dataAsOf": "2026-07-24"})
            create_snapshot.assert_not_called()


if __name__ == "__main__":
    unittest.main()
