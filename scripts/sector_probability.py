#!/usr/bin/env python3
"""Train and audit A-share sector-rotation models with strict abstention.

Three independent horizons (1/5/20 sessions) are trained for four targets:
absolute upside, benchmark outperformance, top-quartile membership and
expected excess return.  All evaluation is time ordered.  No null is replaced
with zero and no failed model falls back to 50%.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

import sector_rotation as rotation
import prediction_dataset as datasets

try:
    import numpy as np
except ImportError as exc:
    raise SystemExit("sector_probability.py requires numpy") from exc


HORIZONS = (1, 5, 20)
BINARY_TARGETS = ("absoluteUp", "outperformance", "topQuartile")
PROBABILITY_FEATURES = [
    *rotation.FEATURES,
    *rotation.MODEL_FEATURES,
    "nl_momentum_acceleration",
    "nl_medium_trend_acceleration",
    "nl_momentum5_x_amount",
    "nl_momentum20_x_volume",
    "nl_trend_x_drawdown",
    "nl_reversal_x_volatility",
    "nl_momentum5_squared",
    "nl_drawdown_squared",
]
TRAINING_SESSIONS = 504
OOF_SESSIONS = 504
EVALUATION_SESSIONS = 126
BLOCK_SESSIONS = 63
LOGISTIC_RIDGE = 40.0
REGRESSION_RIDGE = 80.0
CALIBRATOR_RIDGE = 2.0
ROUND_TRIP_COST = 0.002
MIN_PROBABILITY_SPREAD = 0.03
MIN_CROSS_SECTION_STD = 0.01
MIN_DATA_COMPLETENESS = 0.80
OUTPUT_PATH = rotation.MULTI_TARGET_MODEL_PATH


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def sigmoid(value: float) -> float:
    if value >= 0:
        exp_value = math.exp(-min(value, 60.0))
        return 1.0 / (1.0 + exp_value)
    exp_value = math.exp(max(value, -60.0))
    return exp_value / (1.0 + exp_value)


def logit(probability: float) -> float:
    value = clamp(probability, 1e-6, 1 - 1e-6)
    return math.log(value / (1 - value))


def feature_value(row: dict[str, Any], feature: str) -> float:
    if feature in row:
        value = row.get(feature)
    else:
        value = rotation.model_feature_value(row, feature)
    if value is None or not math.isfinite(float(value)):
        raise ValueError(f"missing feature {feature} for {row.get('date')} {row.get('code')}")
    return float(value)


def rank_values(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda index: values[index])
    ranks = [0.0] * len(values)
    cursor = 0
    while cursor < len(order):
        end = cursor + 1
        while end < len(order) and values[order[end]] == values[order[cursor]]:
            end += 1
        average = (cursor + 1 + end) / 2
        for position in range(cursor, end):
            ranks[order[position]] = average
        cursor = end
    return ranks


def spearman(left: list[float], right: list[float]) -> float | None:
    if len(left) != len(right) or len(left) < 3:
        return None
    left_rank = rank_values(left)
    right_rank = rank_values(right)
    left_mean = statistics.fmean(left_rank)
    right_mean = statistics.fmean(right_rank)
    numerator = sum((a - left_mean) * (b - right_mean) for a, b in zip(left_rank, right_rank))
    denominator = math.sqrt(
        sum((a - left_mean) ** 2 for a in left_rank)
        * sum((b - right_mean) ** 2 for b in right_rank)
    )
    return numerator / denominator if denominator else None


def label_field(target: str, horizon: int) -> str:
    """Map model targets to snapshot columns; labels are never derived here."""
    return f"{target}{horizon}"


def load_verified_dataset(snapshot: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    try:
        return datasets.load_verified_snapshot(snapshot)
    except datasets.DatasetError as exc:
        raise SystemExit(f"invalid training dataset snapshot: {exc}") from exc


def labelled_dates(panel: list[dict[str, Any]], horizon: int, before: str | None = None) -> list[str]:
    target_key = label_field("topQuartile", horizon)
    date_key = f"targetDate{horizon}"
    return sorted({
        row["date"] for row in panel
        if row.get(target_key) is not None
        and row.get(date_key) is not None
        and (before is None or row[date_key] < before)
    })


def training_rows(
    panel: list[dict[str, Any]],
    horizon: int,
    target_key: str,
    start: str,
    end_exclusive: str | None,
) -> list[dict[str, Any]]:
    date_key = f"targetDate{horizon}"
    rows = [
        row for row in panel
        if row["date"] >= start
        and row.get(target_key) is not None
        and row.get(date_key) is not None
        and (end_exclusive is None or row[date_key] < end_exclusive)
    ]
    if len({row["date"] for row in rows}) < TRAINING_SESSIONS:
        raise RuntimeError(f"insufficient matured training dates for h{horizon} {target_key}")
    return rows


def fit_model(
    panel: list[dict[str, Any]],
    horizon: int,
    target_key: str,
    kind: str,
    start: str,
    end_exclusive: str | None,
) -> dict[str, Any]:
    rows = training_rows(panel, horizon, target_key, start, end_exclusive)
    matrix = np.asarray(
        [[feature_value(row, feature) for feature in PROBABILITY_FEATURES] for row in rows],
        dtype=np.float64,
    )
    targets = np.asarray([float(row[target_key]) for row in rows], dtype=np.float64)
    means = matrix.mean(axis=0)
    scales = matrix.std(axis=0, ddof=1)
    scales = np.where(scales > 1e-12, scales, 1.0)
    normalized = (matrix - means) / scales
    design = np.column_stack([np.ones(len(rows)), normalized])
    coefficients = np.zeros(design.shape[1], dtype=np.float64)
    if kind == "logistic":
        coefficients[0] = logit(float(targets.mean()))
        for _ in range(32):
            scores = np.clip(design @ coefficients, -60.0, 60.0)
            probabilities = 1.0 / (1.0 + np.exp(-scores))
            weights = np.maximum(probabilities * (1 - probabilities), 1e-6)
            gradient = design.T @ (targets - probabilities)
            gradient[1:] -= LOGISTIC_RIDGE * coefficients[1:]
            hessian = (design.T * weights) @ design
            hessian[1:, 1:] += np.eye(design.shape[1] - 1) * LOGISTIC_RIDGE
            delta = np.linalg.solve(hessian, gradient)
            coefficients += delta
            if float(np.max(np.abs(delta))) < 1e-8:
                break
        ridge = LOGISTIC_RIDGE
    else:
        penalty = np.eye(design.shape[1]) * REGRESSION_RIDGE
        penalty[0, 0] = 0
        coefficients = np.linalg.solve(design.T @ design + penalty, design.T @ targets)
        ridge = REGRESSION_RIDGE
    dates = {row["date"] for row in rows}
    target_dates = [str(row[f"targetDate{horizon}"]) for row in rows]
    return {
        "type": f"rolling-standardized-ridge-{kind}",
        "horizonSessions": horizon,
        "ridge": ridge,
        "trainingRows": len(rows),
        "trainingDates": len(dates),
        "trainingStart": min(dates),
        "trainingEnd": max(dates),
        "trainingTargetDateMax": max(target_dates),
        "baseRate": float(targets.mean()) if kind == "logistic" else None,
        "featureNames": PROBABILITY_FEATURES,
        "featureMeans": dict(zip(PROBABILITY_FEATURES, (float(value) for value in means))),
        "featureScales": dict(zip(PROBABILITY_FEATURES, (float(value) for value in scales))),
        "intercept": float(coefficients[0]),
        "coefficients": dict(zip(PROBABILITY_FEATURES, (float(value) for value in coefficients[1:]))),
    }


def score_model(model: dict[str, Any], row: dict[str, Any]) -> float:
    value = float(model["intercept"])
    for feature in model["featureNames"]:
        value += (
            (feature_value(row, feature) - float(model["featureMeans"][feature]))
            / (float(model["featureScales"][feature]) or 1.0)
            * float(model["coefficients"][feature])
        )
    return value


def fit_platt(items: list[dict[str, Any]], target: str) -> dict[str, Any]:
    scores = [float(item["rawScores"][target]) for item in items]
    targets = [int(item["targets"][target]) for item in items]
    mean = statistics.fmean(scores)
    scale = statistics.pstdev(scores) or 1.0
    base_rate = sum(targets) / len(targets)
    intercept = logit(base_rate)
    slope = 0.0
    for _ in range(40):
        h00 = h01 = h11 = g0 = g1 = 0.0
        for score, observed in zip(scores, targets):
            x = (score - mean) / scale
            probability = sigmoid(intercept + slope * x)
            residual = observed - probability
            weight = max(probability * (1 - probability), 1e-6)
            g0 += residual
            g1 += residual * x
            h00 += weight
            h01 += weight * x
            h11 += weight * x * x
        g1 -= CALIBRATOR_RIDGE * slope
        h11 += CALIBRATOR_RIDGE
        delta0, delta1 = rotation.solve_linear([[h00, h01], [h01, h11]], [g0, g1])
        intercept += delta0
        slope += delta1
        if max(abs(delta0), abs(delta1)) < 1e-8:
            break
    return {
        "method": "platt-on-purged-time-ordered-oof",
        "scoreMean": mean,
        "scoreScale": scale,
        "intercept": intercept,
        "slope": slope,
        "baseRate": base_rate,
        "observations": len(items),
        "dates": len({item["date"] for item in items}),
    }


def calibrated_probability(calibrator: dict[str, Any], score: float) -> float:
    normalized = (score - float(calibrator["scoreMean"])) / (float(calibrator["scoreScale"]) or 1.0)
    return sigmoid(float(calibrator["intercept"]) + float(calibrator["slope"]) * normalized)


def roc_auc(items: list[tuple[float, int]]) -> float | None:
    positives = sum(target for _, target in items)
    negatives = len(items) - positives
    if not positives or not negatives:
        return None
    ranks = rank_values([probability for probability, _ in items])
    positive_sum = sum(rank for rank, (_, target) in zip(ranks, items) if target)
    return (positive_sum - positives * (positives + 1) / 2) / (positives * negatives)


def probability_metrics(items: list[tuple[float, int]], base_rate: float) -> dict[str, Any]:
    brier = statistics.fmean((probability - target) ** 2 for probability, target in items)
    baseline = statistics.fmean((base_rate - target) ** 2 for _, target in items)
    return {
        "brier": brier,
        "baselineBrier": baseline,
        "brierSkill": 1 - brier / baseline if baseline else None,
        "auc": roc_auc(items),
        "observations": len(items),
    }


def mean_cross_section_std(items: list[dict[str, Any]], value_getter) -> float:
    grouped: dict[str, list[float]] = defaultdict(list)
    for item in items:
        grouped[item["date"]].append(float(value_getter(item)))
    values = [statistics.pstdev(group) for group in grouped.values() if len(group) >= 3]
    return statistics.fmean(values) if values else 0.0


def out_of_fold_predictions(panel: list[dict[str, Any]], horizon: int) -> list[dict[str, Any]]:
    dates = labelled_dates(panel, horizon)
    if len(dates) < TRAINING_SESSIONS + OOF_SESSIONS:
        raise RuntimeError(f"h{horizon} only has {len(dates)} labelled dates")
    test_dates = dates[-OOF_SESSIONS:]
    test_set = set(test_dates)
    rows_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in panel:
        if row["date"] in test_set and row.get(label_field("topQuartile", horizon)) is not None:
            rows_by_date[row["date"]].append(row)
    predictions: list[dict[str, Any]] = []
    for offset in range(0, len(test_dates), BLOCK_SESSIONS):
        block = test_dates[offset : offset + BLOCK_SESSIONS]
        start = block[0]
        matured = labelled_dates(panel, horizon, before=start)
        if len(matured) < TRAINING_SESSIONS:
            continue
        train_start = matured[-TRAINING_SESSIONS]
        models = {
            target: fit_model(
                panel, horizon, label_field(target, horizon), "logistic", train_start, start
            )
            for target in BINARY_TARGETS
        }
        excess_model = fit_model(
            panel, horizon, label_field("expectedExcess", horizon), "linear", train_start, start
        )
        if any(model["trainingTargetDateMax"] >= start for model in [*models.values(), excess_model]):
            raise RuntimeError(f"label leakage at {start} h{horizon}")
        for trading_date in block:
            regime = "risk-on" if statistics.fmean(
                float(row["momentum20"]) for row in rows_by_date[trading_date]
            ) >= 0 else "risk-off"
            for row in rows_by_date[trading_date]:
                scores = {target: score_model(model, row) for target, model in models.items()}
                predictions.append({
                    "date": trading_date,
                    "code": row["code"],
                    "rawScores": scores,
                    "rawProbabilities": {target: sigmoid(score) for target, score in scores.items()},
                    "predictedExcess": score_model(excess_model, row),
                    "targets": {
                        target: int(row[label_field(target, horizon)])
                        for target in BINARY_TARGETS
                    },
                    "realizedExcess": float(row[label_field("expectedExcess", horizon)]),
                    "realizedRank": int(row[f"realizedRank{horizon}"]),
                    "regime": regime,
                })
    if len({item["date"] for item in predictions}) != OOF_SESSIONS:
        raise RuntimeError(f"incomplete OOF coverage for h{horizon}")
    return predictions


def choose_calibration(
    calibration_items: list[dict[str, Any]],
    evaluation_items: list[dict[str, Any]],
    target: str,
) -> dict[str, Any]:
    calibrator = fit_platt(calibration_items, target)
    base_rate = float(calibrator["baseRate"])
    raw_pairs = [
        (float(item["rawProbabilities"][target]), int(item["targets"][target]))
        for item in evaluation_items
    ]
    calibrated_pairs = [
        (calibrated_probability(calibrator, float(item["rawScores"][target])), int(item["targets"][target]))
        for item in evaluation_items
    ]
    raw_metrics = probability_metrics(raw_pairs, base_rate)
    calibrated_metrics = probability_metrics(calibrated_pairs, base_rate)
    raw_std = mean_cross_section_std(evaluation_items, lambda item: item["rawProbabilities"][target])
    calibrated_std = mean_cross_section_std(
        evaluation_items,
        lambda item: calibrated_probability(calibrator, float(item["rawScores"][target])),
    )
    enabled = bool(
        (raw_metrics["auc"] or 0.0) > 0.52
        and (raw_metrics["brierSkill"] or 0.0) > 0
        and calibrated_metrics["brier"] <= raw_metrics["brier"]
        and calibrated_std >= max(MIN_CROSS_SECTION_STD, raw_std * 0.35)
    )
    return {
        "enabled": enabled,
        "reason": (
            "raw model has OOS discrimination and calibration preserves dispersion"
            if enabled
            else "calibration disabled: raw OOS discrimination or post-calibration dispersion is insufficient"
        ),
        "calibrator": calibrator,
        "rawMetrics": raw_metrics,
        "calibratedMetrics": calibrated_metrics,
        "rawCrossSectionStd": raw_std,
        "calibratedCrossSectionStd": calibrated_std,
    }


def probability_for(item: dict[str, Any], target: str, audit: dict[str, Any]) -> float:
    if audit["enabled"]:
        return calibrated_probability(audit["calibrator"], float(item["rawScores"][target]))
    return float(item["rawProbabilities"][target])


def ranking_metrics(
    items: list[dict[str, Any]],
    top_quartile_audit: dict[str, Any],
) -> dict[str, Any]:
    by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in items:
        by_date[item["date"]].append(item)
    rank_ics: list[float] = []
    hit_rates: list[float] = []
    spreads: list[float] = []
    dispersions: list[float] = []
    regime_values: dict[str, list[float]] = defaultdict(list)
    date_metrics: list[dict[str, Any]] = []
    for trading_date in sorted(by_date):
        rows = by_date[trading_date]
        predicted = [probability_for(row, "topQuartile", top_quartile_audit) for row in rows]
        realized = [float(row["realizedExcess"]) for row in rows]
        rank_ic = spearman(predicted, realized)
        if rank_ic is None:
            continue
        order = sorted(range(len(rows)), key=lambda index: predicted[index], reverse=True)
        top_count = max(1, math.ceil(len(rows) * 0.25))
        bottom_count = top_count
        actual_top = set(sorted(range(len(rows)), key=lambda index: realized[index], reverse=True)[:top_count])
        predicted_top = set(order[:top_count])
        hit = len(actual_top & predicted_top) / top_count
        spread = statistics.fmean(realized[index] for index in order[:top_count]) - statistics.fmean(
            realized[index] for index in order[-bottom_count:]
        )
        dispersion = statistics.pstdev(predicted)
        rank_ics.append(rank_ic)
        hit_rates.append(hit)
        spreads.append(spread)
        dispersions.append(dispersion)
        regime_values[rows[0]["regime"]].append(rank_ic)
        date_metrics.append({"date": trading_date, "rankIc": rank_ic, "spread": spread})
    windows = []
    for start in range(0, len(date_metrics), BLOCK_SESSIONS):
        block = date_metrics[start : start + BLOCK_SESSIONS]
        if not block:
            continue
        windows.append({
            "start": block[0]["date"],
            "end": block[-1]["date"],
            "rankIc": statistics.fmean(item["rankIc"] for item in block),
            "topBottomSpread": statistics.fmean(item["spread"] for item in block),
        })
    spread = statistics.fmean(spreads) if spreads else 0.0
    return {
        "rankIc": statistics.fmean(rank_ics) if rank_ics else None,
        "crossSectionSpearman": statistics.fmean(rank_ics) if rank_ics else None,
        "topQuartileHitRate": statistics.fmean(hit_rates) if hit_rates else None,
        "topBottomSpread": spread,
        "topBottomSpreadAfterCosts": spread - ROUND_TRIP_COST * 2,
        "transactionCostPerLeg": ROUND_TRIP_COST,
        "predictionCrossSectionStd": statistics.fmean(dispersions) if dispersions else 0.0,
        "positiveWindowShare": (
            sum(window["rankIc"] > 0 for window in windows) / len(windows) if windows else 0.0
        ),
        "windows": windows,
        "regimes": {
            regime: {"dates": len(values), "rankIc": statistics.fmean(values)}
            for regime, values in regime_values.items()
        },
    }


def data_diagnostics(panel: list[dict[str, Any]], dataset_manifest: dict[str, Any]) -> dict[str, Any]:
    taxonomy = rotation.read_json(rotation.TAXONOMY_PATH)
    latest_date = max(row["date"] for row in panel)
    latest = [row for row in panel if row["date"] == latest_date]
    vectors: dict[str, list[float]] = {}
    sectors = []
    for item in taxonomy["indices"]:
        row = next((candidate for candidate in latest if candidate["code"] == item["code"]), None)
        missing = [] if row else list(PROBABILITY_FEATURES)
        values: list[float] = []
        if row:
            for feature in PROBABILITY_FEATURES:
                try:
                    values.append(feature_value(row, feature))
                except (TypeError, ValueError):
                    missing.append(feature)
            vectors[item["code"]] = values
        sectors.append({
            "code": item["code"],
            "name": item["shortName"],
            "featureCount": len(PROBABILITY_FEATURES) - len(missing),
            "missingCount": len(missing),
            "missingRatio": len(missing) / len(PROBABILITY_FEATURES),
            "missingFeatures": missing,
            "mapping": {
                "industryIndex": "mapped" if row else "missing",
                "indexCode": item["code"],
                "historySource": "immutable-dataset-source-manifest",
                "etf": "not-yet-backfilled",
                "institutionFlow": "not-yet-backfilled",
            },
        })
    pairwise = []
    codes = sorted(vectors)
    exact_duplicates = []
    for left_index, left in enumerate(codes):
        for right in codes[left_index + 1 :]:
            distance = math.sqrt(sum((a - b) ** 2 for a, b in zip(vectors[left], vectors[right])))
            pairwise.append(distance)
            if distance <= 1e-12:
                exact_duplicates.append([left, right])
    feature_std = []
    for feature in PROBABILITY_FEATURES:
        values = [feature_value(row, feature) for row in latest]
        feature_std.append({"feature": feature, "crossSectionStd": statistics.pstdev(values)})
    source_failures: list[dict[str, Any]] = []
    enhanced_groups = {
        "priceRelativeStrength": 0.25,
        "turnoverAndVolume": 0.25,
        "marketBreadth": 0.20,
        "etfAndInstitutionFlow": 0.20,
        "policyAndEventMapping": 0.10,
    }
    available_groups = {"priceRelativeStrength", "turnoverAndVolume"}
    evidence_completeness = sum(
        weight for group, weight in enhanced_groups.items() if group in available_groups
    )
    return {
        "asOf": latest_date,
        "expectedFeatureCount": len(PROBABILITY_FEATURES),
        "sectors": sectors,
        "crossSection": {
            "sectorCount": len(latest),
            "exactDuplicateVectors": exact_duplicates,
            "minimumPairwiseDistance": min(pairwise) if pairwise else None,
            "medianPairwiseDistance": statistics.median(pairwise) if pairwise else None,
            "featureStandardDeviation": feature_std,
        },
        "mappings": {
            "benchmark": {
                "code": rotation.A_SHARE_BENCHMARK["code"],
                "name": rotation.A_SHARE_BENCHMARK["shortName"],
                "status": "immutable-snapshot",
                "source": dataset_manifest["benchmark"]["source"],
            },
            "focusPolicy": "focus changes collection depth only; no score bonus or prior override",
        },
        "sourceHealth": {
            "failures": source_failures,
            "fallbackEligibleCodes": [],
            "fallbackOrSourceBySector": [
                {"code": sector["code"], "source": sector["mapping"]["historySource"]}
                for sector in sectors
            ],
        },
        "enhancedFeatureGroups": {
            "weights": enhanced_groups,
            "available": sorted(available_groups),
            "completeness": evidence_completeness,
            "missingIsNeverZero": True,
        },
        # These two measures deliberately answer different questions.  The first
        # is the availability of the frozen 26-input model on the prediction date;
        # the second is planned production feature-group implementation coverage.
        "modelInputCompleteness": 1.0,
        "productionFeatureCoverage": evidence_completeness,
    }


def current_predictions(
    panel: list[dict[str, Any]],
    models: dict[str, Any],
    calibrations: dict[str, Any],
) -> list[dict[str, Any]]:
    latest_date = max(row["date"] for row in panel)
    rows = [row for row in panel if row["date"] == latest_date]
    output = []
    for row in rows:
        probabilities = {}
        for target in BINARY_TARGETS:
            score = score_model(models[target], row)
            raw = sigmoid(score)
            audit = calibrations[target]
            calibrated = calibrated_probability(audit["calibrator"], score) if audit["enabled"] else raw
            probabilities[target] = {
                "rawScore": score,
                "rawProbability": raw,
                "calibratedProbability": calibrated,
                "calibrationApplied": bool(audit["enabled"]),
                "historicalBaseRate": float(audit["calibrator"]["baseRate"]),
            }
        output.append({
            "date": latest_date,
            "code": row["code"],
            "name": row["name"],
            "probabilities": probabilities,
            "expectedExcessReturn": score_model(models["expectedExcess"], row),
        })
    output.sort(
        key=lambda item: (
            item["probabilities"]["topQuartile"]["calibratedProbability"],
            item["expectedExcessReturn"],
        ),
        reverse=True,
    )
    return output


def abstain_reasons(
    current: list[dict[str, Any]],
    diagnostics: dict[str, Any],
    calibrations: dict[str, Any],
    ranking: dict[str, Any],
) -> list[str]:
    top = [item["probabilities"]["topQuartile"]["calibratedProbability"] for item in current]
    outperformance = [
        item["probabilities"]["outperformance"]["calibratedProbability"] for item in current
    ]
    metrics = calibrations["topQuartile"][
        "calibratedMetrics" if calibrations["topQuartile"]["enabled"] else "rawMetrics"
    ]
    reasons = []
    if not top or max(top) - min(top) < MIN_PROBABILITY_SPREAD:
        reasons.append("最高与最低进入前25%概率差小于3个百分点")
    if outperformance and all(0.47 <= value <= 0.53 for value in outperformance):
        reasons.append("全部跑赢基准概率落在47%—53%区间")
    if top and statistics.pstdev(top) < MIN_CROSS_SECTION_STD:
        reasons.append("当前横截面预测标准差低于1个百分点")
    completeness = float(diagnostics["enhancedFeatureGroups"]["completeness"])
    if completeness < MIN_DATA_COMPLETENESS:
        reasons.append(f"生产级差异特征完整度仅{completeness * 100:.0f}%，低于80%")
    if (metrics.get("brierSkill") or 0.0) <= 0:
        reasons.append("进入前25%概率的Brier Score未优于历史基准")
    if (ranking.get("rankIc") or 0.0) <= 0:
        reasons.append("样本外RankIC不大于0")
    if (ranking.get("topBottomSpreadAfterCosts") or 0.0) <= 0:
        reasons.append("扣除交易成本后的Top-Bottom收益差不大于0")
    if float(ranking.get("positiveWindowShare") or 0.0) <= 0.5:
        reasons.append("多数walk-forward窗口的方向不一致")
    if not calibrations["topQuartile"]["enabled"]:
        reasons.append("原始前四分位模型未满足概率校准启用条件")
    return reasons


def train_horizon(panel: list[dict[str, Any]], horizon: int, diagnostics: dict[str, Any]) -> dict[str, Any]:
    predictions = out_of_fold_predictions(panel, horizon)
    dates = sorted({item["date"] for item in predictions})
    evaluation_dates = set(dates[-EVALUATION_SESSIONS:])
    calibration_items = [item for item in predictions if item["date"] not in evaluation_dates]
    evaluation_items = [item for item in predictions if item["date"] in evaluation_dates]
    calibrations = {
        target: choose_calibration(calibration_items, evaluation_items, target)
        for target in BINARY_TARGETS
    }
    ranking = ranking_metrics(evaluation_items, calibrations["topQuartile"])
    matured = labelled_dates(panel, horizon)
    start = matured[-TRAINING_SESSIONS]
    models = {
        target: fit_model(panel, horizon, label_field(target, horizon), "logistic", start, None)
        for target in BINARY_TARGETS
    }
    models["expectedExcess"] = fit_model(
        panel, horizon, label_field("expectedExcess", horizon), "linear", start, None
    )
    current = current_predictions(panel, models, calibrations)
    reasons = abstain_reasons(current, diagnostics, calibrations, ranking)
    return {
        "horizonSessions": horizon,
        "status": "ready",
        "publicationStatus": "abstained" if reasons else "published",
        "primaryTarget": "topQuartileProbability",
        "secondaryRankingTarget": "expectedExcessReturn",
        "eventDefinitions": {
            "absoluteUp": f"第{horizon}个后续完整交易日行业指数收益率大于0",
            "outperformance": f"第{horizon}个后续完整交易日行业收益率大于中证全指收益率",
            "topQuartile": f"未来{horizon}个交易日相对收益进入固定12项观察池前25%",
            "expectedExcess": f"行业未来{horizon}个交易日收益率减中证全指收益率",
        },
        "models": models,
        "calibrations": calibrations,
        "latestPredictions": current,
        "abstainReasons": reasons,
        "audit": {
            "validation": (
                "rolling 504-session training; purged chronological 63-session test blocks; "
                f"labels must mature before each block; embargo={horizon} sessions"
            ),
            "calibrationDates": len({item["date"] for item in calibration_items}),
            "evaluationDates": len(evaluation_dates),
            "evaluationObservations": len(evaluation_items),
            "rankingMetrics": ranking,
            "qualityGate": {
                "passed": not reasons,
                "reasons": reasons,
                "thresholds": {
                    "minimumProbabilitySpread": MIN_PROBABILITY_SPREAD,
                    "minimumCrossSectionStd": MIN_CROSS_SECTION_STD,
                    "minimumDataCompleteness": MIN_DATA_COMPLETENESS,
                    "brierSkillMustBePositive": True,
                    "rankIcMustBePositive": True,
                    "topBottomAfterCostsMustBePositive": True,
                    "positiveWindowShareMustExceed": 0.5,
                },
            },
        },
    }


def train(output: Path, dataset_snapshot: Path) -> dict[str, Any]:
    dataset_manifest, panel = load_verified_dataset(dataset_snapshot)
    diagnostics = data_diagnostics(panel, dataset_manifest)
    horizons = {str(horizon): train_horizon(panel, horizon, diagnostics) for horizon in HORIZONS}
    as_of = diagnostics["asOf"]
    payload = {
        "schemaVersion": 2,
        "id": "guanchao-a-share-sector-relative-probability",
        "version": f"{as_of}-relative-v2",
        "trainedAt": rotation.now_iso(),
        "asOf": as_of,
        "trainingStart": min(
            result["models"]["topQuartile"]["trainingStart"] for result in horizons.values()
        ),
        "trainingEnd": max(
            result["models"]["topQuartile"]["trainingEnd"] for result in horizons.values()
        ),
        "taxonomyHash": dataset_manifest["taxonomy"]["sha256"],
        "featureDataSha256": dataset_manifest["panel"]["sha256"],
        "datasetId": dataset_manifest["datasetId"],
        "datasetSchemaVersion": dataset_manifest["schemaVersion"],
        "datasetPanelSha256": dataset_manifest["panel"]["sha256"],
        "datasetManifestSha256": datasets.sha256_path(dataset_snapshot / datasets.SNAPSHOT_MANIFEST_NAME),
        "labelContractVersion": dataset_manifest["contracts"]["labels"],
        "featureContractVersion": dataset_manifest["contracts"]["features"],
        "benchmarkContractVersion": dataset_manifest["contracts"]["benchmark"],
        "calendarSha256": dataset_manifest["calendar"]["sha256"],
        "benchmark": {
            "code": rotation.A_SHARE_BENCHMARK["code"],
            "name": rotation.A_SHARE_BENCHMARK["shortName"],
            "source": rotation.CSI_API,
        },
        "method": {
            "label": "multi-target sector rotation relative to CSI All Share",
            "estimator": "independent rolling ridge logistic/linear models for 1, 5 and 20 sessions",
            "validation": "purged walk-forward time-series validation with horizon embargo",
            "calibration": "Platt calibration is enabled only after raw OOS discrimination and dispersion checks",
            "fallback": "strict abstention; evidence observation ranking replaces failed probability publication",
            "focusPolicy": "deeper collection never changes model priors, feature weights or scores",
        },
        "features": [
            rotation.MODEL_FEATURE_DESCRIPTIONS.get(
                feature, rotation.FEATURE_DESCRIPTIONS.get(feature, feature)
            )
            for feature in PROBABILITY_FEATURES
        ],
        "dataDiagnostics": diagnostics,
        "horizons": horizons,
        "limitations": [
            "Current numerical history contains price, volume and turnover features; ETF, breadth and institution-flow backfills remain incomplete and therefore trigger abstention.",
            "Historical predictions are stored separately as immutable publication-time snapshots and are never regenerated by this training command.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    rotation.write_json_atomic(output, payload)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    states = " ".join(
        f"h{horizon}={horizons[str(horizon)]['publicationStatus']}"
        f"/RankIC={horizons[str(horizon)]['audit']['rankingMetrics']['rankIc']:.4f}"
        for horizon in HORIZONS
    )
    print(f"[relative-probability] {states} sha256={digest}", flush=True)
    return payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("command", choices=["train"])
    root.add_argument(
        "--output",
        required=True,
        help="audit-only output under models/sector-rotation/candidates",
    )
    root.add_argument(
        "--dataset-snapshot",
        required=True,
        help="verified immutable dataset snapshot; mutable FEATURE_PATH is never a training input",
    )
    return root


def main() -> None:
    args = parser().parse_args()
    output = (rotation.ROOT / args.output).resolve()
    candidate_root = (rotation.MODEL_DIR / "candidates").resolve()
    if not output.is_relative_to(candidate_root):
        raise SystemExit("training output must stay under models/sector-rotation/candidates; frozen production model cannot be overwritten")
    train(output, Path(args.dataset_snapshot).resolve())


if __name__ == "__main__":
    main()
