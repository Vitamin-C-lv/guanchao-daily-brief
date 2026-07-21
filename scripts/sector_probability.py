#!/usr/bin/env python3
"""Train and audit always-on A-share sector upside probabilities.

The event is deliberately simple and tradable: the official sector index
closes above its as-of close after 1, 5 or 20 complete A-share sessions.
Models are fitted on rolling 504-session windows.  Every probability used for
calibration is produced out of sample with matured labels only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

import sector_rotation as rotation

try:
    import numpy as np
except ImportError as exc:  # probability training is weekly/research-only
    raise SystemExit("sector_probability.py requires numpy for its small logistic solver") from exc


HORIZONS = (1, 5, 20)
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
CALIBRATION_TEST_SESSIONS = 504
EVALUATION_SESSIONS = 126
BLOCK_SESSIONS = 63
RIDGE = 40.0
CALIBRATOR_RIDGE = 2.0
OUTPUT_PATH = rotation.PROBABILITY_MODEL_PATH


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


def labelled_dates(horizon: int, before: str | None = None) -> list[str]:
    raw_key = f"raw_forward{horizon}"
    target_date_key = f"targetDate{horizon}"
    return sorted(
        {
            row["date"]
            for row in rotation.iter_features()
            if row.get(raw_key) is not None
            and row.get(target_date_key) is not None
            and (before is None or row[target_date_key] < before)
        }
    )


def feature_value(row: dict[str, Any], feature: str) -> float:
    if feature in row:
        return float(row[feature])
    return rotation.model_feature_value(row, feature)


def fit_linear_probability_model(
    horizon: int,
    *,
    train_end_exclusive: str | None,
    train_start_inclusive: str,
) -> dict[str, Any]:
    raw_key = f"raw_forward{horizon}"
    target_date_key = f"targetDate{horizon}"
    stats = rotation.RunningStats(len(PROBABILITY_FEATURES))
    training_dates: set[str] = set()
    target_dates: list[str] = []
    positives = 0
    for row in rotation.iter_features():
        raw_return = row.get(raw_key)
        target_date = row.get(target_date_key)
        if (
            raw_return is None
            or target_date is None
            or row["date"] < train_start_inclusive
            or (train_end_exclusive and target_date >= train_end_exclusive)
        ):
            continue
        stats.add([feature_value(row, feature) for feature in PROBABILITY_FEATURES])
        training_dates.add(row["date"])
        target_dates.append(target_date)
        positives += int(raw_return > 0)
    if len(training_dates) < TRAINING_SESSIONS:
        raise RuntimeError(
            f"only {len(training_dates)} matured dates for {horizon}-session probability model"
        )
    scales = stats.scales()
    dim = len(PROBABILITY_FEATURES) + 1
    training_rows: list[tuple[list[float], float]] = []
    for row in rotation.iter_features():
        raw_return = row.get(raw_key)
        target_date = row.get(target_date_key)
        if (
            raw_return is None
            or target_date is None
            or row["date"] < train_start_inclusive
            or (train_end_exclusive and target_date >= train_end_exclusive)
        ):
            continue
        design = [1.0] + [
            (feature_value(row, feature) - stats.mean[index]) / scales[index]
            for index, feature in enumerate(PROBABILITY_FEATURES)
        ]
        target = 1.0 if raw_return > 0 else 0.0
        training_rows.append((design, target))
    design_matrix = np.asarray([row for row, _ in training_rows], dtype=np.float64)
    targets = np.asarray([target for _, target in training_rows], dtype=np.float64)
    coefficients = np.zeros(dim, dtype=np.float64)
    coefficients[0] = logit(positives / stats.n)
    for _ in range(24):
        logits = np.clip(design_matrix @ coefficients, -60.0, 60.0)
        probabilities = 1.0 / (1.0 + np.exp(-logits))
        weights = np.maximum(probabilities * (1 - probabilities), 1e-6)
        gradient = design_matrix.T @ (targets - probabilities)
        gradient[1:] -= RIDGE * coefficients[1:]
        hessian = (design_matrix.T * weights) @ design_matrix
        hessian[1:, 1:] += np.eye(dim - 1) * RIDGE
        delta = np.linalg.solve(hessian, gradient)
        coefficients += delta
        if float(np.max(np.abs(delta))) < 1e-7:
            break
    coefficient_values = [float(value) for value in coefficients]
    return {
        "type": "rolling-standardized-ridge-logistic",
        "horizonSessions": horizon,
        "ridge": RIDGE,
        "trainingRows": stats.n,
        "trainingDates": len(training_dates),
        "trainingStart": min(training_dates),
        "trainingEnd": max(training_dates),
        "trainingTargetDateMax": max(target_dates),
        "baseRate": positives / stats.n,
        "featureNames": PROBABILITY_FEATURES,
        "featureMeans": dict(zip(PROBABILITY_FEATURES, stats.mean)),
        "featureScales": dict(zip(PROBABILITY_FEATURES, scales)),
        "intercept": coefficient_values[0],
        "coefficients": dict(zip(PROBABILITY_FEATURES, coefficient_values[1:])),
    }


def score_model(model: dict[str, Any], row: dict[str, Any]) -> float:
    value = float(model["intercept"])
    for feature in model["featureNames"]:
        scale = float(model["featureScales"][feature]) or 1.0
        value += (
            (feature_value(row, feature) - float(model["featureMeans"][feature]))
            / scale
            * float(model["coefficients"][feature])
        )
    return value


def out_of_fold_predictions(horizon: int) -> list[dict[str, Any]]:
    dates = labelled_dates(horizon)
    required = TRAINING_SESSIONS + CALIBRATION_TEST_SESSIONS
    if len(dates) < required:
        raise RuntimeError(
            f"only {len(dates)} labelled dates for horizon {horizon}; require {required}"
        )
    test_dates = dates[-CALIBRATION_TEST_SESSIONS:]
    test_set = set(test_dates)
    rows_by_date: dict[str, list[dict[str, Any]]] = defaultdict(list)
    raw_key = f"raw_forward{horizon}"
    for row in rotation.iter_features():
        if row["date"] in test_set and row.get(raw_key) is not None:
            rows_by_date[row["date"]].append(row)

    predictions: list[dict[str, Any]] = []
    for offset in range(0, len(test_dates), BLOCK_SESSIONS):
        block = test_dates[offset : offset + BLOCK_SESSIONS]
        start = block[0]
        matured = labelled_dates(horizon, before=start)
        if len(matured) < TRAINING_SESSIONS:
            continue
        model = fit_linear_probability_model(
            horizon,
            train_end_exclusive=start,
            train_start_inclusive=matured[-TRAINING_SESSIONS],
        )
        if model["trainingTargetDateMax"] >= start:
            raise RuntimeError(f"probability leakage at {start} horizon {horizon}")
        for trading_date in block:
            for row in rows_by_date.get(trading_date, []):
                raw_return = float(row[raw_key])
                predictions.append(
                    {
                        "date": trading_date,
                        "code": row["code"],
                        "score": score_model(model, row),
                        "target": int(raw_return > 0),
                        "return": raw_return,
                    }
                )
    if len({item["date"] for item in predictions}) < CALIBRATION_TEST_SESSIONS:
        raise RuntimeError(f"incomplete probability OOF coverage for horizon {horizon}")
    return predictions


def fit_platt(items: list[dict[str, Any]]) -> dict[str, float]:
    scores = [float(item["score"]) for item in items]
    targets = [int(item["target"]) for item in items]
    mean = statistics.fmean(scores)
    scale = statistics.pstdev(scores) or 1.0
    base_rate = sum(targets) / len(targets)
    intercept = logit(base_rate)
    slope = 0.0
    for _ in range(40):
        h00 = h01 = h11 = 0.0
        g0 = g1 = 0.0
        for score, target in zip(scores, targets):
            x = (score - mean) / scale
            probability = sigmoid(intercept + slope * x)
            residual = target - probability
            weight = max(probability * (1 - probability), 1e-6)
            g0 += residual
            g1 += residual * x
            h00 += weight
            h01 += weight * x
            h11 += weight * x * x
        g1 -= CALIBRATOR_RIDGE * slope
        h11 += CALIBRATOR_RIDGE
        delta0, delta1 = rotation.solve_linear(
            [[h00, h01], [h01, h11]],
            [g0, g1],
        )
        intercept += delta0
        slope += delta1
        if max(abs(delta0), abs(delta1)) < 1e-8:
            break
    return {
        "method": "sigmoid-platt-on-time-ordered-oof",
        "scoreMean": mean,
        "scoreScale": scale,
        "intercept": intercept,
        "slope": slope,
        "baseRate": base_rate,
        "observations": len(items),
        "dates": len({item["date"] for item in items}),
    }


def calibrated_probability(calibrator: dict[str, Any], score: float) -> float:
    normalized = (
        (score - float(calibrator["scoreMean"]))
        / (float(calibrator["scoreScale"]) or 1.0)
    )
    return sigmoid(float(calibrator["intercept"]) + float(calibrator["slope"]) * normalized)


def apply_tier(probability: float, base_rate: float, tier: str) -> float:
    blend = {
        "model-calibrated": 1.0,
        "model-shrunk": 0.35,
        "historical-base-rate": 0.0,
    }[tier]
    return clamp(base_rate + blend * (probability - base_rate), 0.02, 0.98)


def roc_auc(items: list[tuple[float, int]]) -> float | None:
    positives = sum(target for _, target in items)
    negatives = len(items) - positives
    if positives == 0 or negatives == 0:
        return None
    ordered = sorted(enumerate(items), key=lambda entry: entry[1][0])
    ranks = [0.0] * len(items)
    cursor = 0
    while cursor < len(ordered):
        end = cursor + 1
        while end < len(ordered) and ordered[end][1][0] == ordered[cursor][1][0]:
            end += 1
        average_rank = (cursor + 1 + end) / 2
        for index in range(cursor, end):
            ranks[ordered[index][0]] = average_rank
        cursor = end
    positive_rank_sum = sum(rank for rank, (_, target) in zip(ranks, items) if target)
    return (positive_rank_sum - positives * (positives + 1) / 2) / (positives * negatives)


def probability_metrics(items: list[tuple[float, int]], base_rate: float) -> dict[str, Any]:
    brier = statistics.fmean((probability - target) ** 2 for probability, target in items)
    baseline_brier = statistics.fmean((base_rate - target) ** 2 for _, target in items)
    log_loss = statistics.fmean(
        -(target * math.log(clamp(probability, 1e-9, 1 - 1e-9))
          + (1 - target) * math.log(clamp(1 - probability, 1e-9, 1 - 1e-9)))
        for probability, target in items
    )
    bins: list[list[tuple[float, int]]] = [[] for _ in range(10)]
    for probability, target in items:
        bins[min(9, int(probability * 10))].append((probability, target))
    ece = sum(
        len(bucket) / len(items)
        * abs(
            statistics.fmean(probability for probability, _ in bucket)
            - statistics.fmean(target for _, target in bucket)
        )
        for bucket in bins
        if bucket
    )
    auc = roc_auc(items)
    return {
        "brier": brier,
        "baselineBrier": baseline_brier,
        "brierSkill": 1 - brier / baseline_brier if baseline_brier else None,
        "logLoss": log_loss,
        "ece10": ece,
        "auc": auc,
        "observations": len(items),
    }


def wilson_interval(success_rate: float, effective_n: int, z: float = 1.6448536269514722) -> tuple[float, float]:
    n = max(1, effective_n)
    denominator = 1 + z * z / n
    center = (success_rate + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(success_rate * (1 - success_rate) / n + z * z / (4 * n * n)) / denominator
    return clamp(center - margin, 0.0, 1.0), clamp(center + margin, 0.0, 1.0)


def calibration_bins(
    items: list[dict[str, Any]],
    calibrator: dict[str, Any],
    tier: str,
) -> list[dict[str, Any]]:
    base_rate = float(calibrator["baseRate"])
    prepared = sorted(
        (
            apply_tier(calibrated_probability(calibrator, float(item["score"])), base_rate, tier),
            int(item["target"]),
            str(item["date"]),
        )
        for item in items
    )
    bins: list[dict[str, Any]] = []
    for start in range(0, len(prepared), max(1, len(prepared) // 10)):
        bucket = prepared[start : start + max(1, len(prepared) // 10)]
        if not bucket:
            continue
        observed = statistics.fmean(target for _, target, _ in bucket)
        independent_dates = len({trading_date for _, _, trading_date in bucket})
        low, high = wilson_interval(observed, independent_dates)
        bins.append(
            {
                "meanPredicted": statistics.fmean(probability for probability, _, _ in bucket),
                "observedUpRate": observed,
                "observations": len(bucket),
                "independentDates": independent_dates,
                "wilson90Low": low,
                "wilson90High": high,
            }
        )
        if len(bins) == 10:
            break
    return bins


def train_horizon(horizon: int) -> dict[str, Any]:
    predictions = out_of_fold_predictions(horizon)
    dates = sorted({item["date"] for item in predictions})
    evaluation_dates = set(dates[-EVALUATION_SESSIONS:])
    calibration_items = [item for item in predictions if item["date"] not in evaluation_dates]
    evaluation_items = [item for item in predictions if item["date"] in evaluation_dates]
    audit_calibrator = fit_platt(calibration_items)
    audit_base = float(audit_calibrator["baseRate"])
    raw_pairs = [
        (calibrated_probability(audit_calibrator, float(item["score"])), int(item["target"]))
        for item in evaluation_items
    ]
    raw_metrics = probability_metrics(raw_pairs, audit_base)
    if (
        raw_metrics["brier"] <= raw_metrics["baselineBrier"]
        and raw_metrics["ece10"] <= 0.08
        and (raw_metrics["auc"] or 0.5) >= 0.5
    ):
        tier = "model-calibrated"
    elif (
        raw_metrics["brier"] <= raw_metrics["baselineBrier"] * 1.05
        and (raw_metrics["auc"] or 0.5) >= 0.5
    ):
        tier = "model-shrunk"
    else:
        tier = "historical-base-rate"
    deployed_pairs = [
        (apply_tier(probability, audit_base, tier), target)
        for probability, target in raw_pairs
    ]
    deployed_metrics = probability_metrics(deployed_pairs, audit_base)
    final_calibrator = fit_platt(predictions)
    matured = labelled_dates(horizon)
    final_model = fit_linear_probability_model(
        horizon,
        train_end_exclusive=None,
        train_start_inclusive=matured[-TRAINING_SESSIONS],
    )
    return {
        "horizonSessions": horizon,
        "eventDefinition": f"中证行业指数第{horizon}个后续完整交易日收盘价高于asOf收盘价",
        "status": "ready",
        "deploymentTier": tier,
        "model": final_model,
        "calibrator": final_calibrator,
        "calibrationBins": calibration_bins(predictions, final_calibrator, tier),
        "audit": {
            "walkForward": "rolling 504-session training; 63-session test blocks; targetDate strictly before each test block",
            "calibrationDates": len({item["date"] for item in calibration_items}),
            "evaluationDates": len(evaluation_dates),
            "evaluationObservations": len(evaluation_items),
            "auditCalibration": audit_calibrator,
            "unshrunkMetrics": raw_metrics,
            "deployedMetrics": deployed_metrics,
            "fallbackPolicy": "calibrated -> fixed 35% shrink -> historical base rate; always emit a probability when the current row is complete",
        },
    }


def train(output: Path) -> dict[str, Any]:
    if not rotation.FEATURE_PATH.exists():
        raise SystemExit("feature file missing; run rotation:features first")
    taxonomy = rotation.read_json(rotation.TAXONOMY_PATH)
    manifest = rotation.load_manifest().get("features", {})
    horizons = {str(horizon): train_horizon(horizon) for horizon in HORIZONS}
    latest = rotation.latest_rows()
    as_of = max(row["date"] for row in latest.values())
    payload = {
        "schemaVersion": 1,
        "id": "guanchao-a-share-sector-up-probability",
        "version": f"{as_of}-probability-v1",
        "trainedAt": rotation.now_iso(),
        "asOf": as_of,
        "trainingStart": min(item["model"]["trainingStart"] for item in horizons.values()),
        "trainingEnd": max(item["model"]["trainingEnd"] for item in horizons.values()),
        "taxonomyHash": rotation.canonical_json_sha256(taxonomy),
        "featureDataSha256": manifest.get("sha256"),
        "method": {
            "label": "absolute close-to-close upside event",
            "estimator": "rolling standardized ridge logistic score with independent sigmoid calibration",
            "calibration": "time-ordered out-of-fold Platt calibration; final 126 dates reserved for tier selection",
            "fallback": "fixed shrinkage or historical base rate prevents blank output without inventing certainty",
            "probabilityMeaning": "historical conditional frequency estimate, not a guaranteed return or trade instruction",
        },
        "features": [
            rotation.MODEL_FEATURE_DESCRIPTIONS.get(
                feature,
                rotation.FEATURE_DESCRIPTIONS.get(feature, feature),
            )
            for feature in PROBABILITY_FEATURES
        ],
        "horizons": horizons,
        "limitations": [
            "The 12 sector observations on one date are correlated; calibration bands use independent dates as the effective sample size.",
            "A probability above 50% does not imply positive expected return after costs or an attractive payoff ratio.",
            "Only index price, volume and turnover known at the as-of close enter the numerical model.",
        ],
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    rotation.write_json_atomic(output, payload)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(
        "[probability] "
        + " ".join(
            f"h{horizon}={horizons[str(horizon)]['deploymentTier']}"
            f"/BrierSkill={horizons[str(horizon)]['audit']['deployedMetrics']['brierSkill']:.4f}"
            for horizon in HORIZONS
        )
        + f" sha256={digest}",
        flush=True,
    )
    return payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    root.add_argument("command", choices=["train"])
    root.add_argument(
        "--output",
        default=str(OUTPUT_PATH.relative_to(rotation.ROOT)).replace("\\", "/"),
        help="project-relative output path",
    )
    return root


def main() -> None:
    args = parser().parse_args()
    output = (rotation.ROOT / args.output).resolve()
    if not output.is_relative_to(rotation.MODEL_DIR.resolve()):
        raise SystemExit("probability artifact output must stay under models/sector-rotation")
    train(output)


if __name__ == "__main__":
    main()
