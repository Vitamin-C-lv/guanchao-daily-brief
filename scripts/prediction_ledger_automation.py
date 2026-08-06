#!/usr/bin/env python3
"""Daily/closing/weekly orchestration for the Git-backed prediction ledger."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prediction_history as legacy_history
import prediction_ledger as ledger
import sector_rotation as rotation


def history_source_hash() -> str:
    paths = sorted(path for path in [*rotation.HISTORY_DIR.glob("*.csv.gz"), rotation.BENCHMARK_HISTORY_PATH] if path.exists())
    entries = [{"path": path.relative_to(rotation.ROOT).as_posix(), "sha256": ledger.sha256_bytes(path.read_bytes())} for path in paths]
    if not entries:
        raise ledger.LedgerError("evaluation history sources are unavailable")
    return ledger.sha256_bytes(ledger.canonical_json_bytes(entries))


def append_available_evaluations(root: Path, *, code_commit: str) -> dict[str, int]:
    predictions = ledger.collect_predictions(root)
    evaluated_ids = {item["predictionId"] for item in ledger.collect_evaluations(root) if item["eventType"] == "evaluation"}
    source_hash = history_source_hash()
    counts = {"appended": 0, "pending": 0, "skipped": 0, "dataInsufficient": 0}
    for record in predictions:
        if record["legacy"] or record["publicationStatus"] != "published" or record["modelAvailability"] != "trained" or record["market"] != "a-share":
            counts["skipped"] += 1
            continue
        if record["predictionId"] in evaluated_ids:
            counts["skipped"] += 1
            continue
        due_date = record.get("dueDate")
        if not due_date:
            counts["pending"] += 1
            continue
        returns, benchmark, latest_date = legacy_history.a_share_returns(record["predictionDate"], due_date)
        if latest_date is None or due_date > latest_date:
            counts["pending"] += 1
            continue
        evaluated_at = f"{latest_date}T20:00:00+08:00"
        sources = {"rotationHistorySetSha256": source_hash}
        if record["sectorId"] not in returns or benchmark is None or len(returns) < 4:
            event = ledger.build_evaluation_event(
                prediction_id=record["predictionId"], evaluated_at=evaluated_at,
                evaluation_data_as_of=latest_date, horizon_sessions=record["horizonSessions"],
                realized_absolute_return=None, realized_benchmark_return=None, realized_excess_return=None,
                realized_sector_rank=None, realized_sector_count=None, realized_top_quartile=None,
                target_outcome=None, result="data_insufficient", source_hashes=sources, code_commit=code_commit,
            )
            counts["dataInsufficient"] += 1
        else:
            event = ledger.evaluate_prediction_from_returns(
                record, returns, benchmark_return=benchmark, evaluated_at=evaluated_at,
                source_hashes=sources, code_commit=code_commit,
            )
        counts["appended"] += int(ledger.append_evaluation(root, event))
    ledger.rebuild_index(root)
    return counts


def latest_iso_week(root: Path) -> str:
    del root
    iso = datetime.now(ZoneInfo("Asia/Shanghai")).date().isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def publication_data_as_of(payload: dict[str, Any]) -> str:
    """Return the A-share session represented by a mixed-market publication."""
    direct = payload.get("dataAsOf") or payload.get("asOf")
    if direct:
        return str(direct)
    markets = payload.get("markets")
    entries = markets.values() if isinstance(markets, dict) else markets if isinstance(markets, list) else []
    for market in entries:
        if isinstance(market, dict) and str(market.get("id") or market.get("market")) == "a-share" and market.get("asOf"):
            return str(market["asOf"])
    return str(payload.get("generatedAt", "")[:10])


def run(mode: str, root: Path, rotation_path: Path, *, code_commit: str, iso_week: str | None, states_path: Path | None = None) -> dict[str, Any]:
    if mode not in {"daily", "closing", "weekly"}:
        raise ledger.LedgerError("mode must be daily, closing or weekly")
    ledger.initialize_ledger(root)
    before = ledger.verify_ledger(root)
    ledger.require_restored_ledger(root, expected_snapshot_count=before["snapshotCount"])
    payload = json.loads(ledger.canonical_text_bytes(rotation_path, artifact=str(rotation_path)))
    # A refresh timestamp can move on a non-trading day while the frozen market
    # input is still the same trading session.  Snapshot identity and immutable
    # prediction IDs are keyed by the data-as-of session, never generatedAt.
    payload_date = publication_data_as_of(payload)
    index = json.loads(ledger.canonical_text_bytes(root / "index.json", artifact="ledger index"))
    snapshot_report: dict[str, Any]
    if index.get("lastPredictionDate") and payload_date <= index["lastPredictionDate"]:
        snapshot_report = {"written": False, "reason": "publication date is already represented", "dataAsOf": payload_date}
    else:
        snapshot = ledger.snapshot_from_rotation_payload(payload, edition="closing" if mode == "closing" else "daily", code_commit=code_commit)
        snapshot_report = {"written": ledger.append_snapshot(root, snapshot), "runId": snapshot["runId"], "path": ledger.snapshot_relative_path(snapshot)}
    states_report: dict[str, Any] | None = None
    if states_path is not None:
        states_payload = json.loads(ledger.canonical_text_bytes(states_path, artifact=str(states_path)))
        states = states_payload.get("states") if isinstance(states_payload, dict) else states_payload
        if not isinstance(states, list) or not states:
            raise ledger.LedgerError("states file must contain a non-empty states array")
        models: list[dict[str, Any]] = []
        seen_models: set[tuple[str, str]] = set()
        for state in states:
            key = (str(state["market"]), str(state["modelVersion"]))
            if key in seen_models:
                continue
            seen_models.add(key)
            models.append({
                "market": state["market"],
                "modelVersion": state["modelVersion"],
                "artifactSha256": None,
                "availability": state["modelAvailability"],
            })
        data_as_of = max(str(state["recordDate"]) for state in states)
        # Deterministic creation time keeps identical states physically idempotent
        # across days: only a status/dataset/model/horizon change forms a new snapshot.
        created_at = f"{data_as_of}T20:00:00+08:00"
        state_snapshot = ledger.build_state_snapshot(
            states=states,
            created_at=created_at,
            data_as_of=data_as_of,
            edition=mode,
            code_commit=code_commit,
            models=models,
        )
        states_report = {
            "written": ledger.append_state_snapshot(root, state_snapshot),
            "runId": state_snapshot["runId"],
            "path": ledger.snapshot_relative_path(state_snapshot),
            "dataAsOf": data_as_of,
            "stateCount": len(states),
        }
    evaluations = append_available_evaluations(root, code_commit=code_commit)
    week = iso_week or latest_iso_week(root)
    review = ledger.write_weekly_review(root, week, output_path=ledger.DEFAULT_REVIEW_PATH) if mode == "weekly" else None
    public = ledger.export_public(
        root, ledger.DEFAULT_PUBLIC_ROOT,
        compatibility_path=ledger.DEFAULT_COMPATIBILITY_PATH,
        review_path=ledger.DEFAULT_REVIEW_PATH,
    )
    verification = ledger.verify_ledger(root, public_root=ledger.DEFAULT_PUBLIC_ROOT)
    return {
        "ok": True, "mode": mode, "before": before, "snapshot": snapshot_report,
        "states": states_report,
        "evaluations": evaluations, "weeklyReview": None if review is None else {"isoWeek": review["isoWeek"], "counts": review["counts"]},
        "public": {"recordCount": public["recordCount"], "files": len(public["files"])}, "verification": verification,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("daily", "closing", "weekly"), required=True)
    parser.add_argument("--root", type=Path, default=ledger.DEFAULT_LEDGER_ROOT)
    parser.add_argument("--rotation", type=Path, default=rotation.CONTENT_PATH)
    parser.add_argument("--code-commit")
    parser.add_argument("--week")
    parser.add_argument("--states", type=Path)
    args = parser.parse_args()
    try:
        report = run(args.mode, args.root.resolve(), args.rotation.resolve(), code_commit=args.code_commit or ledger._git_head(), iso_week=args.week, states_path=args.states)
    except (ledger.LedgerError, OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, sort_keys=True))
        return 1
    print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
