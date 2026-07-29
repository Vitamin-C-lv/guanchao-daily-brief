from __future__ import annotations

import copy
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import market_breadth
import prediction_feature_coverage


AS_OF = "2026-07-29"


def price_rows(count: int = 20, *, zero_volume: bool = False) -> list[dict]:
    dates = [f"2026-07-{day:02d}" for day in range(1, count + 1)]
    dates[-1] = AS_OF
    return [
        {"date": day, "close": float(index + 1), "volume": 0.0 if zero_volume and index == count - 1 else 100.0}
        for index, day in enumerate(dates)
    ]


def fixture_taxonomy() -> dict:
    return {"indices": [{"code": f"{index:06d}", "shortName": f"行业{index}"} for index in range(1, 13)]}


def fixture_memberships(taxonomy: dict, count: int = 10, effective: str = AS_OF) -> dict:
    return {
        index["code"]: {
            "effectiveDate": effective,
            "sha256": f"{int(index['code']):064x}",
            "sourceUrl": f"https://example.test/{index['code']}",
            "items": [{"symbol": f"sz{sector:02d}{member:04d}"} for member in range(count)],
        }
        for sector, index in enumerate(taxonomy["indices"], start=1)
    }


def fixture_prices(memberships: dict) -> dict:
    return {
        item["symbol"]: {"symbol": item["symbol"], "rows": price_rows(), "rawSha256": f"{position:064x}", "warning": None}
        for position, membership in enumerate(memberships.values(), start=1)
        for item in membership["items"]
    }


class MarketBreadthTests(unittest.TestCase):
    def test_member_metrics_calculates_all_three_ratios_without_zero_fill(self) -> None:
        metrics, warning = market_breadth.member_metrics(price_rows(), AS_OF)
        self.assertIsNone(warning)
        self.assertEqual(metrics, {"advance": 1.0, "positive5d": 1.0, "aboveMa20": 1.0})
        missing, missing_warning = market_breadth.member_metrics([], AS_OF)
        self.assertIsNone(missing)
        self.assertIn("stale", missing_warning)

    def test_suspension_is_excluded_not_counted_as_down(self) -> None:
        metrics, warning = market_breadth.member_metrics(price_rows(zero_volume=True), AS_OF)
        self.assertIsNone(metrics)
        self.assertIn("suspended", warning)

    def test_ready_sector_requires_ten_members_and_eighty_percent_coverage(self) -> None:
        index = fixture_taxonomy()["indices"][0]
        membership = fixture_memberships({"indices": [index]}, count=10)[index["code"]]
        prices = fixture_prices({index["code"]: membership})
        ready = market_breadth.sector_result(index, membership, prices, AS_OF)
        self.assertEqual(ready["status"], "ready")
        self.assertEqual(ready["validConstituentRatio"], 1.0)
        self.assertEqual(ready["advanceRatio1d"], 1.0)
        self.assertEqual(ready["positiveReturnRatio5d"], 1.0)
        self.assertEqual(ready["aboveMa20Ratio"], 1.0)
        membership_nine = fixture_memberships({"indices": [index]}, count=9)[index["code"]]
        partial = market_breadth.sector_result(index, membership_nine, fixture_prices({index["code"]: membership_nine}), AS_OF)
        self.assertEqual(partial["status"], "partial")
        membership_coverage = fixture_memberships({"indices": [index]}, count=10)[index["code"]]
        price_coverage = fixture_prices({index["code"]: membership_coverage})
        price_coverage.pop(membership_coverage["items"][0]["symbol"])
        partial_coverage = market_breadth.sector_result(index, membership_coverage, price_coverage, AS_OF)
        self.assertEqual(partial_coverage["status"], "partial")
        self.assertEqual(partial_coverage["validConstituentRatio"], 0.9)

    def test_point_in_time_membership_rejects_future_effective_date(self) -> None:
        taxonomy = fixture_taxonomy()
        memberships = fixture_memberships(taxonomy, effective="2026-07-30")
        with self.assertRaises(ValueError):
            market_breadth.build_snapshot(
                as_of=AS_OF,
                taxonomy=taxonomy,
                constituent_by_sector=memberships,
                prices=fixture_prices(memberships),
                price_failures=[],
            )

    def test_group_status_needs_all_twelve_ready_sectors(self) -> None:
        taxonomy = fixture_taxonomy()
        memberships = fixture_memberships(taxonomy)
        payload = market_breadth.build_snapshot(
            as_of=AS_OF,
            taxonomy=taxonomy,
            constituent_by_sector=memberships,
            prices=fixture_prices(memberships),
            price_failures=[],
        )
        self.assertEqual(payload["summary"]["status"], "ready")
        self.assertTrue(payload["summary"]["productionReady"])
        first_symbol = memberships[taxonomy["indices"][0]["code"]]["items"][0]["symbol"]
        prices = fixture_prices(memberships)
        prices.pop(first_symbol)
        partial = market_breadth.build_snapshot(
            as_of=AS_OF,
            taxonomy=taxonomy,
            constituent_by_sector=memberships,
            prices=prices,
            price_failures=["fixture provider failure"],
        )
        self.assertEqual(partial["summary"]["status"], "partial")
        self.assertFalse(partial["summary"]["productionReady"])

    def test_snapshot_is_deterministic_idempotent_and_conflicts_are_rejected(self) -> None:
        taxonomy = fixture_taxonomy()
        memberships = fixture_memberships(taxonomy)
        payload = market_breadth.build_snapshot(
            as_of=AS_OF,
            taxonomy=taxonomy,
            constituent_by_sector=memberships,
            prices=fixture_prices(memberships),
            price_failures=[],
        )
        self.assertEqual(market_breadth.deterministic_gzip(payload), market_breadth.deterministic_gzip(payload))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            _, created = market_breadth.write_snapshot(root, payload)
            self.assertTrue(created)
            _, repeated = market_breadth.write_snapshot(root, payload)
            self.assertFalse(repeated)
            index = market_breadth.rebuild_index(root)
            self.assertEqual(index["availableDates"], [AS_OF])
            changed = copy.deepcopy(payload)
            changed["summary"]["groupCoverage"] = 0.99
            changed["contentHash"] = market_breadth.sha256_bytes(market_breadth.canonical_bytes({key: value for key, value in changed.items() if key != "contentHash"}))
            with self.assertRaises(FileExistsError):
                market_breadth.write_snapshot(root, changed)

    def test_source_qualification_is_bounded(self) -> None:
        qualification = market_breadth.source_qualification()
        self.assertLessEqual(len(qualification["candidates"]), 3)
        self.assertEqual(sum(candidate["selected"] for candidate in qualification["candidates"]), 2)

    def test_current_snapshot_rejects_intraday_collection_before_close(self) -> None:
        class BeforeClose(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 7, 29, 14, 59, tzinfo=tz)

        with patch("market_breadth.datetime", BeforeClose):
            with self.assertRaisesRegex(ValueError, "completed Shanghai close"):
                market_breadth.collect(AS_OF)

    def test_coverage_contract_keeps_model_and_training_measures_frozen(self) -> None:
        contract = prediction_feature_coverage.build_coverage_contract(
            expected_model_inputs=26,
            available_model_inputs=26,
            price_relative_strength_health=1.0,
            turnover_and_volume_health=1.0,
            market_breadth_summary={"status": "ready", "groupCoverage": 1.0},
        )
        self.assertEqual(contract["modelInputCompleteness"], 1.0)
        self.assertEqual(contract["modelFeatureCoverage"], 0.5)
        self.assertEqual(contract["productionSignalCoverage"], 0.7)
        self.assertEqual(contract["trainingReadyCoverage"], 0.5)
        self.assertEqual(contract["providerHealthCoverage"], 0.7)
        self.assertEqual(contract["productionFeatureCoverage"], 0.5)

    def test_lineage_sidecar_verifies_frozen_model_and_dataset(self) -> None:
        report = prediction_feature_coverage.verify_lineage()
        self.assertTrue(report["ok"])
        self.assertEqual(report["datasetId"], "a-share-2026-07-21-3448b55c8ae4")


if __name__ == "__main__":
    unittest.main()
