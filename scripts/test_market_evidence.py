from __future__ import annotations

import importlib.util
import unittest
from datetime import date, timedelta
from pathlib import Path


SCRIPT = Path(__file__).with_name("market_evidence.py")
SPEC = importlib.util.spec_from_file_location("market_evidence", SCRIPT)
assert SPEC and SPEC.loader
market_evidence = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(market_evidence)


class MarketEvidenceTests(unittest.TestCase):
    def test_history_metrics_use_five_vs_prior_twenty(self) -> None:
        start = date(2026, 1, 1)
        benchmark = []
        sector = []
        for index in range(25):
            trading_date = (start + timedelta(days=index)).isoformat()
            benchmark.append(
                {"date": trading_date, "close": 100 + index, "amountYi": 1000.0, "volume": 1000.0}
            )
            multiplier = 2.0 if index >= 20 else 1.0
            sector.append(
                {
                    "date": trading_date,
                    "close": 100 + index * 2,
                    "amountYi": 100.0 * multiplier,
                    "volume": 80.0 * multiplier,
                }
            )
        metrics = market_evidence.history_metrics(sector, benchmark)
        self.assertEqual(metrics["historySessions"], 25)
        self.assertEqual(metrics["turnoverAmountRatio20d"]["value"], 2.0)
        self.assertEqual(metrics["tradingVolumeRatio20d"]["value"], 2.0)
        self.assertEqual(metrics["turnoverShareRatio20d"]["value"], 2.0)

    def test_intraday_quote_is_not_a_completed_close(self) -> None:
        intraday = {"date": "2026-07-21", "timestamp": "20260721092838"}
        close = {"date": "2026-07-21", "timestamp": "20260721150512"}
        self.assertFalse(market_evidence.quote_is_complete_close("2026-07-21", intraday))
        self.assertTrue(market_evidence.quote_is_complete_close("2026-07-21", close))
        self.assertFalse(market_evidence.quote_is_complete_close("2026-07-20", close))

    def test_publication_gate_requires_all_fields_and_three_thresholds(self) -> None:
        def ready(value: float) -> dict[str, object]:
            return {"status": "verified", "value": value}

        metrics = {
            "turnoverAmountRatio20d": ready(1.5),
            "tradingVolumeRatio20d": ready(1.3),
            "turnoverShareRatio20d": ready(1.2),
            "breadthPct": ready(55.0),
            "relativeReturn5d": ready(2.0),
            "top3ConcentrationPct": ready(30.0),
        }
        self.assertEqual(market_evidence.publication_state(metrics)["volumeStatus"], "verified")
        metrics["breadthPct"] = {"status": "insufficient", "value": None}
        state = market_evidence.publication_state(metrics)
        self.assertEqual(state["volumeStatus"], "insufficient")
        self.assertIn("breadthPct", state["missingFields"])


if __name__ == "__main__":
    unittest.main()
