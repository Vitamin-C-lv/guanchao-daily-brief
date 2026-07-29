"""Pure weekly-review metrics for the immutable prediction ledger.

This module deliberately owns no filesystem or CLI operations.  The ledger
orchestrator supplies the frozen contract versions and its deterministic error
type so the exported review bytes and user-visible errors remain unchanged.
"""

from __future__ import annotations

import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import date
from typing import Any, Sequence


def _latest_evaluations(evaluations: Sequence[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for event in sorted(evaluations, key=lambda item: (item["evaluatedAt"], item["evaluationEventId"])):
        latest[event["predictionId"]] = event
    return latest


def _target_probability(record: dict[str, Any]) -> float | None:
    return {
        "absolute_up": record.get("absoluteUpProbability"),
        "relative_outperformance": record.get("outperformanceProbability"),
        "top_quartile": record.get("topQuartileProbability"),
    }.get(record.get("probabilityTarget"))


def _pearson(left: Sequence[float], right: Sequence[float]) -> float | None:
    if len(left) < 2 or len(left) != len(right):
        return None
    mean_left, mean_right = statistics.fmean(left), statistics.fmean(right)
    numerator = sum((x - mean_left) * (y - mean_right) for x, y in zip(left, right))
    denominator = math.sqrt(sum((x - mean_left) ** 2 for x in left) * sum((y - mean_right) ** 2 for y in right))
    return numerator / denominator if denominator else None


def _average_ranks(values: Sequence[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: (values[index], index))
    ranks = [0.0] * len(values)
    cursor = 0
    while cursor < len(order):
        end = cursor + 1
        while end < len(order) and values[order[end]] == values[order[cursor]]:
            end += 1
        rank = (cursor + 1 + end) / 2.0
        for position in range(cursor, end):
            ranks[order[position]] = rank
        cursor = end
    return ranks


def _auc(probabilities: Sequence[float], outcomes: Sequence[int]) -> float | None:
    positives = [index for index, outcome in enumerate(outcomes) if outcome == 1]
    negatives = [index for index, outcome in enumerate(outcomes) if outcome == 0]
    if not positives or not negatives:
        return None
    wins = 0.0
    for positive in positives:
        for negative in negatives:
            wins += 1.0 if probabilities[positive] > probabilities[negative] else 0.5 if probabilities[positive] == probabilities[negative] else 0.0
    return wins / (len(positives) * len(negatives))


def _ece(probabilities: Sequence[float], outcomes: Sequence[int], bins: int = 10) -> float | None:
    if not probabilities:
        return None
    total = len(probabilities)
    value = 0.0
    for bin_index in range(bins):
        low, high = bin_index / bins, (bin_index + 1) / bins
        indices = [i for i, probability in enumerate(probabilities) if low <= probability < high or (bin_index == bins - 1 and probability == 1.0)]
        if indices:
            mean_probability = statistics.fmean(probabilities[i] for i in indices)
            mean_outcome = statistics.fmean(outcomes[i] for i in indices)
            value += len(indices) / total * abs(mean_probability - mean_outcome)
    return value


def _metric_bundle(pairs: Sequence[tuple[dict[str, Any], dict[str, Any]]]) -> tuple[dict[str, Any], dict[str, str]]:
    probabilities: list[float] = []
    outcomes: list[int] = []
    bases: list[float] = []
    excess: list[float] = []
    for record, event in pairs:
        probability = _target_probability(record)
        if probability is None or event.get("targetOutcome") is None:
            continue
        probabilities.append(float(probability) / 100.0)
        outcomes.append(int(bool(event["targetOutcome"])))
        base = record.get("historicalBaseRate")
        bases.append(float(base) / 100.0 if base is not None else 0.5)
        excess.append(float(event.get("realizedExcessReturn") or 0.0))
    n = len(probabilities)
    reasons: dict[str, str] = {}
    names = ("brier", "baselineBrier", "brierSkill", "auc", "ece", "calibrationError", "rankIc", "topBottomSpread", "topBottomSpreadAfterCosts", "topQuartileHitRate", "predictionDispersion")
    metrics: dict[str, Any] = {name: None for name in names}
    if n < 5:
        reasons.update({name: "insufficient_sample" for name in names})
        metrics["sampleSize"] = n
        return metrics, reasons
    brier = statistics.fmean((p - y) ** 2 for p, y in zip(probabilities, outcomes))
    baseline = statistics.fmean((p - y) ** 2 for p, y in zip(bases, outcomes))
    metrics.update({
        "sampleSize": n, "brier": brier, "baselineBrier": baseline,
        "brierSkill": 1.0 - brier / baseline if baseline else None,
        "auc": _auc(probabilities, outcomes), "ece": _ece(probabilities, outcomes),
        "calibrationError": _ece(probabilities, outcomes),
        "rankIc": _pearson(_average_ranks(probabilities), _average_ranks(excess)),
        "topQuartileHitRate": statistics.fmean(outcomes),
        "predictionDispersion": statistics.pstdev(probabilities) if n > 1 else None,
    })
    top_n = max(1, math.ceil(n * 0.25))
    order = sorted(range(n), key=lambda i: (probabilities[i], i))
    metrics["topBottomSpread"] = statistics.fmean(excess[i] for i in order[-top_n:]) - statistics.fmean(excess[i] for i in order[:top_n])
    metrics["topBottomSpreadAfterCosts"] = None
    reasons["topBottomSpreadAfterCosts"] = "cost_contract_unavailable"
    for name in names:
        if metrics.get(name) is None:
            reasons[name] = "undefined_sample_distribution"
    return metrics, reasons


def build_weekly_review(
    predictions: Sequence[dict[str, Any]], evaluations: Sequence[dict[str, Any]], iso_week: str, *,
    schema_version: int, contract_version: str, error_type: type[Exception],
) -> dict[str, Any]:
    if not re.fullmatch(r"\d{4}-W\d{2}", iso_week):
        raise error_type("isoWeek must be YYYY-Www")
    year, week = int(iso_week[:4]), int(iso_week[6:])
    selected = [item for item in predictions if date.fromisoformat(item["predictionDate"]).isocalendar()[:2] == (year, week)]
    latest = _latest_evaluations(evaluations)
    counts = Counter()
    current_pairs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for record in selected:
        event = latest.get(record["predictionId"])
        if record["legacy"]:
            counts["legacy"] += 1
            continue
        counts["current"] += 1
        if record["publicationStatus"] == "published":
            counts["published"] += 1
        if record["modelAvailability"] == "not_trained":
            counts["notTrained"] += 1
        elif record["modelAvailability"] == "not_implemented":
            counts["notImplemented"] += 1
        elif record["publicationStatus"] == "abstained":
            counts["abstained"] += 1
        elif record["publicationStatus"] == "insufficient_data":
            counts["insufficientData"] += 1
        elif event is None:
            counts["pending"] += 1
        elif event["result"] == "data_insufficient":
            counts["dataInsufficientEvaluation"] += 1
            counts["dataInsufficient"] += 1
            counts["matured"] += 1
        elif event["result"] in {"correct", "wrong", "near_neutral"}:
            counts["evaluated"] += 1
            counts["matured"] += 1
            current_pairs.append((record, event))
    required_counts = ("totalRecords", "records", "current", "published", "abstained", "notTrained", "notImplemented", "pending", "matured", "evaluated", "dataInsufficient", "insufficientData", "dataInsufficientEvaluation", "legacy")
    counts["totalRecords"] = len(selected)
    counts["records"] = len(selected)
    metrics, metric_reasons = _metric_bundle(current_pairs)
    metrics["publicationRate"] = counts["published"] / counts["current"] if counts["current"] else None
    metrics["abstentionRate"] = counts["abstained"] / counts["current"] if counts["current"] else None
    if metrics["publicationRate"] is None:
        metric_reasons["publicationRate"] = "insufficient_sample"
    if metrics["abstentionRate"] is None:
        metric_reasons["abstentionRate"] = "insufficient_sample"
    grouped: dict[tuple[Any, ...], list[tuple[dict[str, Any], dict[str, Any]]]] = defaultdict(list)
    slice_keys = ("modelVersion", "market", "horizonSessions", "probabilityTarget", "publicationStatus", "legacy")
    for record in selected:
        key = tuple(record[item] for item in slice_keys)
        event = latest.get(record["predictionId"])
        if event and event["result"] in {"correct", "wrong", "near_neutral"}:
            grouped[key].append((record, event))
        else:
            grouped.setdefault(key, [])
    slices = []
    for key, pairs in sorted(grouped.items(), key=lambda item: tuple(str(value) for value in item[0])):
        bundle, reasons = _metric_bundle([] if key[-1] else pairs)
        slices.append({**dict(zip(slice_keys, key)), "recordCount": sum(tuple(record[item] for item in slice_keys) == key for record in selected), "metrics": bundle, "metricReasons": reasons})
    target_metrics: dict[str, Any] = {}
    for target in sorted({record["probabilityTarget"] for record, _ in current_pairs}):
        bundle, reasons = _metric_bundle([pair for pair in current_pairs if pair[0]["probabilityTarget"] == target])
        target_metrics[target] = {"metrics": bundle, "metricReasons": reasons}
    versions: dict[str, Any] = {}
    for version in sorted({record["modelVersion"] for record, _ in current_pairs}):
        bundle, reasons = _metric_bundle([pair for pair in current_pairs if pair[0]["modelVersion"] == version])
        versions[version] = {"metrics": bundle, "metricReasons": reasons}
    recommendations = []
    if metrics.get("sampleSize", 0) < 20:
        recommendations.append("样本不足：继续积累同一概率目标的到期样本，不据此改模或解冻模型。")
    if counts["abstained"]:
        recommendations.append("保留 abstain 门槛；优先审查输入完整度与特征覆盖率，不把观察分伪装成概率。")
    abstain_distribution = Counter(reason for record in selected if not record["legacy"] and record["publicationStatus"] == "abstained" for reason in record["abstainReasons"])
    scored_calls = [{"predictionId": record["predictionId"], "market": record["market"], "sectorId": record["sectorId"], "modelVersion": record["modelVersion"], "horizonSessions": record["horizonSessions"], "probabilityTarget": record["probabilityTarget"], "result": event["result"], "realizedExcessReturn": event["realizedExcessReturn"]} for record, event in current_pairs]
    largest_errors = sorted((item for item in scored_calls if item["result"] == "wrong"), key=lambda item: -abs(float(item["realizedExcessReturn"] or 0.0)))[:10]
    best_calls = sorted((item for item in scored_calls if item["result"] == "correct"), key=lambda item: -abs(float(item["realizedExcessReturn"] or 0.0)))[:10]
    machine_recommendations = {
        "recurringFailureModes": [] if not largest_errors else ["review_largest_directional_errors"],
        "featureCoverageProblems": [reason for reason in sorted(abstain_distribution) if "完整度" in reason or "覆盖" in reason],
        "calibrationWarnings": ["insufficient_current_target_samples"] if metrics.get("sampleSize", 0) < 20 else [],
        "regimeInstability": [], "recommendedResearchActions": ["accumulate_same_target_outcomes", "audit_feature_coverage_without_lowering_gates"], "gatePolicy": "do_not_lower_automatically",
    }
    generation_candidates = [record["createdAt"] for record in selected]
    generation_candidates.extend(event["evaluatedAt"] for event in evaluations if event["predictionId"] in {item["predictionId"] for item in selected})
    generated_at = max(generation_candidates) if generation_candidates else f"{date.fromisocalendar(year, week, 7).isoformat()}T00:00:00Z"
    return {
        "schemaVersion": schema_version, "contractVersion": contract_version, "isoWeek": iso_week, "generatedAt": generated_at,
        "counts": {key: counts[key] for key in required_counts}, "metrics": metrics, "metricReasons": metric_reasons,
        "targetMetrics": target_metrics, "slices": slices, "modelVersionComparison": versions,
        "abstainReasonDistribution": dict(sorted(abstain_distribution.items())), "largestErrors": largest_errors,
        "bestCalls": best_calls, "recommendations": recommendations, "machineRecommendations": machine_recommendations,
        "policy": {"legacyExcludedFromCurrentMetrics": True, "pendingAndAbstainedNeverCountedAsWrong": True, "probabilityTargetsNeverMixed": True},
    }
