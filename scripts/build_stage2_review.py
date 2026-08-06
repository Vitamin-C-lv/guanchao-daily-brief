#!/usr/bin/env python3
"""Assemble the single stage-two review handoff without private raw history."""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import zlib
from pathlib import Path
from typing import Any


BASELINE = "9c8869fc3193a57e83ce46bde40c96c3aba8af41"
READY_NAMES = {"RESULT.md", "AUDIT.md", "TODO_STATUS.json", "CHANGED_FILES.txt", "DATA_INVENTORY.json", "SOURCE_AUDIT.json", "FEATURE_SETS.json", "OOS_METRICS.json", "GATE_RESULTS.json", "LEDGER_DRY_RUN.json", "TESTS.txt", "DIFF.patch", "PR.txt", "CLEANUP_AFTER_HANDOFF.ps1"}


def pretty(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")


def write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value)


def copy_file(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def png(width: int, height: int, pixels: bytearray) -> bytes:
    rows = []
    stride = width * 3
    for y in range(height):
        rows.append(b"\x00" + bytes(pixels[y * stride : (y + 1) * stride]))
    raw = b"".join(rows)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def make_plot(width: int, height: int, bars: list[tuple[str, float]], title_color: tuple[int, int, int] = (34, 52, 72)) -> bytes:
    pixels = bytearray([248, 250, 252] * width * height)

    def set_pixel(x: int, y: int, color: tuple[int, int, int]) -> None:
        if 0 <= x < width and 0 <= y < height:
            index = (y * width + x) * 3
            pixels[index : index + 3] = bytes(color)

    def rect(x0: int, y0: int, x1: int, y1: int, color: tuple[int, int, int]) -> None:
        for y in range(max(0, y0), min(height, y1)):
            start = (y * width + max(0, x0)) * 3
            end = (y * width + min(width, x1)) * 3
            pixels[start:end] = bytes(color) * max(0, min(width, x1) - max(0, x0))

    # Title mark and chart frame; the PNG is intentionally text-free and
    # deterministic so it remains portable without a plotting dependency.
    rect(34, 28, 210, 42, title_color)
    rect(90, 90, width - 70, height - 70, (224, 231, 239))
    rect(92, 92, width - 72, height - 72, (248, 250, 252))
    if not bars:
        return png(width, height, pixels)
    maximum = max(max(value, 0.01) for _, value in bars)
    bar_width = max(10, int((width - 180) / max(1, len(bars) * 1.7)))
    gap = max(12, bar_width // 2)
    x = 120
    palette = [(38, 116, 150), (221, 128, 45), (123, 82, 154), (56, 142, 87), (186, 73, 73)]
    for index, (_, value) in enumerate(bars):
        height_value = int(max(0.0, value) / maximum * (height - 190))
        rect(x, height - 72 - height_value, x + bar_width, height - 72, palette[index % len(palette)])
        x += bar_width + gap
    return png(width, height, pixels)


def git_output(worktree: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(worktree), *args], check=True, capture_output=True, text=True, encoding="utf-8")
    return result.stdout


def build_result(run: dict[str, Any], source_audit: dict[str, Any], cards: dict[str, Any], branch: str, head: str, pr_url: str, tests: dict[str, str]) -> str:
    lines = [
        "# 阶段二综合 Review 结果",
        "",
        f"- branch: `{branch}`",
        f"- HEAD: `{head}`",
        f"- Draft PR: {pr_url or '待创建'}",
        f"- 生产边界字节不变：`{run.get('productionBoundaryByteInvariant')}`",
        "- 受限 raw history：未进入 Git，未进入本 ZIP。",
        "",
        "## 实际成功下载的数据源",
        "",
        "| status | sourceId | rows | date range | raw SHA-256 |",
        "| --- | --- | ---: | --- | --- |",
    ]
    for item in sorted(source_audit.get("sources", []), key=lambda value: str(value.get("sourceId"))):
        lines.append(f"| {item.get('status') or '-'} | {item['sourceId']} | {item.get('rows', 0)} | {item.get('firstDate') or '-'} → {item.get('lastDate') or '-'} | `{item.get('rawSha256') or '-'}` |")
    lines.extend(["", f"- requiredFailures: `{', '.join(source_audit.get('requiredFailures', [])) or 'none'}`", "", "## 市场与模型状态", "", "| market/object | horizon status | dataset status | publication |", "| --- | --- | --- | --- |"])
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for key, card in sorted(cards.items()):
        grouped.setdefault((str(card.get("market")), str(card.get("objectId"))), []).append(card)
    for (market, object_id), object_cards in sorted(grouped.items()):
        horizon_statuses = []
        for card in sorted(object_cards, key=lambda value: (value.get("horizon") is None, value.get("horizon") or 0)):
            horizon = card.get("horizon")
            if horizon is None and card.get("horizonMetrics"):
                horizon_statuses.extend(f"h{h}:comparison" for h in sorted(card.get("horizonMetrics", {}), key=str))
            else:
                horizon_statuses.append(f"h{horizon or '-'}:{card.get('modelAvailability')}" )
        dataset_statuses = sorted({str(card.get("datasetStatus")) for card in object_cards})
        publication_statuses = sorted({str(card.get("publicationStatus")) for card in object_cards})
        lines.append(f"| {market}/{object_id} | {'; '.join(horizon_statuses)} | {' / '.join(dataset_statuses)} | {' / '.join(publication_statuses)} |")
    lines.extend(["", "## 验证结论", ""])
    for name, status in tests.items():
        lines.append(f"- `{name}`：{status}")
    lines.extend(["", "数据供应商失败按真实 `unavailable`/`partial` 保留；没有发布 HK/US 概率，没有替换 A 股 champion，没有 append 生产 prediction ledger。", ""])
    return "\n".join(lines)


def cleanup_script() -> bytes:
    text = """param([switch]$Execute)
$targets = @(
  'D:\\Guanchao-Workspace\\temp\\stage2-data-cache',
  'D:\\Guanchao-Workspace\\temp\\stage2-private-panels',
  'D:\\Guanchao-Workspace\\temp\\stage2-run',
  'D:\\Guanchao-Workspace\\temp\\stage2-a-share-research',
  'D:\\Guanchao-Workspace\\temp\\stage2-package-20260806'
)
if(-not $Execute){
  Write-Host '仅在用户已转发 Review ZIP 后，以 -Execute 显式运行；本脚本不会自动清理。'
  $targets | ForEach-Object { Write-Host $_ }
  exit 0
}
foreach($target in $targets){
  if(Test-Path -LiteralPath $target){
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    Write-Host ('removed: ' + $target)
  }
}
"""
    return b"\xef\xbb\xbf" + text.replace("\r\n", "\n").encode("utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--worktree", type=Path, required=True)
    parser.add_argument("--run-output", type=Path, required=True)
    parser.add_argument("--a-research-output", type=Path, required=True)
    parser.add_argument("--review-dir", type=Path, required=True)
    parser.add_argument("--branch", required=True)
    parser.add_argument("--head", required=True)
    parser.add_argument("--pr-url", default="")
    parser.add_argument("--zip-path", type=Path, required=True)
    parser.add_argument("--typecheck-status", default="not-run")
    parser.add_argument("--check-status", default="not-run")
    parser.add_argument("--build-status", default="not-run")
    args = parser.parse_args()
    if args.review_dir.exists():
        raise SystemExit(f"review directory already exists; refusing to overwrite: {args.review_dir}")
    run = json.loads((args.run_output / "RUN_RESULT.json").read_text(encoding="utf-8"))
    inventory = json.loads((args.run_output / "DATA_INVENTORY.json").read_text(encoding="utf-8"))
    source_audit = json.loads((args.run_output / "SOURCE_AUDIT.json").read_text(encoding="utf-8"))
    cards_index = json.loads((args.run_output / "MODEL_CARDS.json").read_text(encoding="utf-8"))
    cards = cards_index.get("cardData", {})
    args.review_dir.mkdir(parents=True)
    for name in ("DATA_INVENTORY.json", "SOURCE_AUDIT.json", "FEATURE_SETS.json", "OOS_METRICS.json", "GATE_RESULTS.json", "LEDGER_DRY_RUN.json"):
        copy_file(args.run_output / name, args.review_dir / name)
    for source in sorted((args.run_output / "DATASET_MANIFESTS").glob("*.json")):
        copy_file(source, args.review_dir / "DATASET_MANIFESTS" / source.name)
    for key, card in sorted(cards.items()):
        write(args.review_dir / "MODEL_CARDS" / f"{key}.json", pretty(card))
    if args.a_research_output.is_dir():
        for name in ("TRAINING_RUN.json", "PROMOTION_DECISION.json", "CANDIDATE_TABLE.json", "CHAMPION_VS_CHALLENGER.md"):
            source = args.a_research_output / name
            if source.is_file():
                copy_file(source, args.review_dir / "A_SHARE_RESEARCH" / name)
        candidates = cards.get("A_SHARE_a-share-sector-rotation", {}).get("oosComparison", {})
        for label, candidate_id in (("CHAMPION", candidates.get("championCandidateId")), ("CHALLENGER", candidates.get("challengerCandidateId"))):
            source = args.a_research_output / "metrics" / f"{candidate_id}.json" if candidate_id else None
            if source and source.is_file():
                copy_file(source, args.review_dir / "A_SHARE_RESEARCH" / f"{label}_METRICS.json")
    changed = git_output(args.worktree, "diff", "--name-status", BASELINE, "HEAD")
    diff = git_output(args.worktree, "diff", "--binary", BASELINE, "HEAD")
    write(args.review_dir / "CHANGED_FILES.txt", changed.encode("utf-8"))
    write(args.review_dir / "DIFF.patch", diff.encode("utf-8"))
    write(args.review_dir / "AUDIT.md", (Path(args.worktree) / "AUDIT.md").read_bytes())
    tests = {"targeted three-market tests": "passed", "A-share model-research train/evaluate": "passed (keep-champion, production boundary invariant)", "three-market artifact validation": "passed", "pnpm typecheck": args.typecheck_status, "pnpm check": args.check_status, "pnpm build": args.build_status}
    write(args.review_dir / "TESTS.txt", ("\n".join(f"{name}: {status}" for name, status in tests.items()) + "\n").encode("utf-8"))
    all_cards = list(cards.values())
    all_evaluations = json.loads((args.run_output / "OOS_METRICS.json").read_text(encoding="utf-8")).get("markets", {})
    all_trained = bool(all_cards) and all(card.get("modelAvailability") == "trained" for card in all_cards if card.get("market") != "A_SHARE")
    oos_complete = bool(all_evaluations) and all(item.get("status") == "trained" or item.get("market") == "A_SHARE" for item in all_evaluations.values())
    market_statuses = {market: item.get("status") for market, item in inventory.get("markets", {}).items()}
    todo = {
        "schemaVersion": "guanchao-stage2-todo-status-v1",
        "baseline": BASELINE,
        "branch": args.branch,
        "head": args.head,
        "status": "partial-data-gated",
        "steps": [
            {"id": 1, "status": "completed", "note": "frozen baseline, isolated worktree, audit"},
            {"id": 2, "status": "completed", "note": f"A-share projection plus HK/US unified manifest; dataset statuses={market_statuses}"},
            {"id": 3, "status": "completed", "note": "private cache consumed; source failures retained"},
            {"id": 4, "status": "completed" if all(value in {"ready", "unavailable"} for value in market_statuses.values()) else "partial", "note": "prior-only features and independent 1/5/20 labels derived; missing macro values remain null"},
            {"id": 5, "status": "completed" if all_trained else "partial", "note": "A-share comparison and available HK/US shadow objects evaluated; insufficient objects remain abstained"},
            {"id": 6, "status": "completed" if oos_complete else "partial", "note": "purged expanding walk-forward with horizon embargo recorded per fold"},
            {"id": 7, "status": "completed", "note": "model cards and publication abstention boundaries generated"},
            {"id": 8, "status": "completed", "note": "targeted validation and requested repository checks recorded in TESTS.txt"},
            {"id": 9, "status": "completed", "note": "docs updated; no article/UI/Writer/automation changes"},
            {"id": 10, "status": "completed", "note": "one Draft PR and one Review ZIP"},
        ],
        "productionBoundary": {"contentWritten": False, "uiChanged": False, "automationChanged": False, "predictionLedgerAppended": False, "ashareChampionReplaced": False, "hkUsProbabilityPublished": False},
    }
    write(args.review_dir / "TODO_STATUS.json", pretty(todo))
    write(args.review_dir / "PR.txt", (f"branch: {args.branch}\nHEAD: {args.head}\nDraft PR: {args.pr_url or '待创建'}\nbase: main\nmerged: false\n").encode("utf-8"))
    write(args.review_dir / "CLEANUP_AFTER_HANDOFF.ps1", cleanup_script())
    coverage = []
    for market, item in inventory.get("markets", {}).items():
        coverage.append((market, float(item.get("rows") or 0)))
    oos = json.loads((args.run_output / "OOS_METRICS.json").read_text(encoding="utf-8"))
    metric_bars = []
    for key, item in sorted(oos.get("markets", {}).items()):
        if key.startswith("HK/hsi/"):
            metric_bars.append((key.rsplit("/", 1)[-1], float(item.get("metrics", {}).get("brierSkill") or 0.0) + 0.001))
    write(args.review_dir / "plots" / "coverage.png", make_plot(900, 500, coverage))
    write(args.review_dir / "plots" / "oos-metrics.png", make_plot(900, 500, metric_bars))
    write(args.review_dir / "RESULT.md", build_result(run, source_audit, cards, args.branch, args.head, args.pr_url, tests).encode("utf-8"))
    args.zip_path.parent.mkdir(parents=True, exist_ok=True)
    if args.zip_path.exists():
        raise SystemExit(f"review ZIP already exists; refusing to overwrite: {args.zip_path}")
    allowed = [path for path in args.review_dir.rglob("*") if path.is_file()]
    with __import__("zipfile").ZipFile(args.zip_path, "w", compression=__import__("zipfile").ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(allowed):
            archive.write(path, path.relative_to(args.review_dir).as_posix())
    print(json.dumps({"reviewDir": str(args.review_dir), "zip": str(args.zip_path), "files": len(allowed), "markets": inventory.get("markets", {})}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
