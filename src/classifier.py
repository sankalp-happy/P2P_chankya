"""
Classifier module for Smart-Bin Waste Sorter.
Loads the trained XGBoost model (src/train_classifier.py) once at import.
Provides predict(event) and classifier_metrics() for the dashboard.
"""

import os
import json
import time
import joblib
import numpy as np
import pandas as pd
import xgboost as xgb

# Feature list expected by the model
FEATURES = ['weight_g', 'moisture_pct', 'metal_signal', 'transparency', 'acoustic_hardness']

# Locate model and metrics file across workspace configurations
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_POSSIBLE_MODEL_DIRS = [
    os.path.join(_CURRENT_DIR, "models"),
    os.path.join(_CURRENT_DIR, "P2P_chankya", "models"),
    os.path.join(os.path.dirname(_CURRENT_DIR), "models"),
    os.path.join(os.path.dirname(_CURRENT_DIR), "P2P_chankya", "models"),
    "models",
    "P2P_chankya/models"
]

_MODEL_PATH = None
_METRICS_PATH = None

for d in _POSSIBLE_MODEL_DIRS:
    m_cand = os.path.join(d, "waste.joblib")
    j_cand = os.path.join(d, "waste_metrics.json")
    if os.path.exists(m_cand) and os.path.exists(j_cand):
        _MODEL_PATH = m_cand
        _METRICS_PATH = j_cand
        break

if not _MODEL_PATH or not os.path.exists(_MODEL_PATH):
    raise FileNotFoundError(f"Trained model not found in any of {_POSSIBLE_MODEL_DIRS}")

# Load model and metrics ONCE
_MODEL = joblib.load(_MODEL_PATH)
# Ensure inference runs on CPU for instant low-latency edge deployment
try:
    _MODEL.set_params(device="cpu", n_jobs=1)  # one row: one thread is fastest, no OpenMP spin
except Exception:
    pass

with open(_METRICS_PATH, "r", encoding="utf-8") as _f:
    _METRICS_DATA = json.load(_f)

_CLASSES = _METRICS_DATA["classes"]
_CONFIDENCE_THRESHOLD = 0.60
_LIMITS = [(0, None), (0, 100), (0, 100), (0, 1), (0, 1)]  # same clipping as train_classifier.py
_SAY = {"weight_g": "weight {:.0f} g", "moisture_pct": "moisture {:.0f}%", "metal_signal": "metal signal {:.0f}",
        "transparency": "transparency {:.2f}", "acoustic_hardness": "hardness {:.2f}"}

_BUILDINGS = pd.read_csv(os.path.join(os.path.dirname(_CURRENT_DIR), "datasets", "raw", "buildings.csv"))
COMPOSTERS = set(_BUILDINGS[_BUILDINGS.has_composter == 1].building_id)  # B05, B06, B07
# ponytail: buildings.csv has no locations, so "nearest composter" is an assumption: every building without
# one sends food to the Food Court (B07). Put the real nearest per building here if the campus map is known.
NEAREST_COMPOSTER = {b: "B07" for b in _BUILDINGS.building_id if b not in COMPOSTERS}
RECYCLABLE = {"paper_cardboard", "plastic", "glass", "metal"}


def destination(label, confidence, building_id=None):
    """(destination, alert or None) for one item. Circular allocation, README section 7."""
    if confidence < _CONFIDENCE_THRESHOLD:
        return "manual sort", f"unsure item ({confidence:.0%} {label}) needs manual sorting"
    if label == "food_organic":
        if building_id in COMPOSTERS:
            return f"composter {building_id} (own)", None
        return f"composter {NEAREST_COMPOSTER.get(building_id, 'B07')} (nearest)", None
    if label in RECYCLABLE:
        return f"recycling ({label})", None
    return "certified e-waste pickup", "e-waste: book certified e-waste pickup"


def predict(event):
    """
    Predict waste category for a single bin event's sensor readings.

    Parameters:
        event (dict): the 5 sensor readings ('weight_g', 'moisture_pct', 'metal_signal', 'transparency',
            'acoustic_hardness'); missing or None readings are passed to the model as NaN, as in training.
            Optional 'building_id' picks the composter for food.

    Returns:
        dict with label, confidence, reason (the 2 readings that pushed hardest toward the label),
        destination, route ('bin' or 'manual_sort'), alert (text or None), time_ms.
    """
    t0 = time.perf_counter()
    vals = [event.get(f) for f in FEATURES]
    row = np.array([[np.nan if v is None else float(v) for v in vals]], dtype=np.float32)
    for j, (lo, hi) in enumerate(_LIMITS):
        row[0, j] = np.clip(row[0, j], lo, hi)  # NaN stays NaN

    probs = _MODEL.predict_proba(row)[0]
    best_idx = int(np.argmax(probs))
    conf = float(probs[best_idx])
    label = _CLASSES[best_idx]

    booster = _MODEL.get_booster()
    contrib = booster.predict(xgb.DMatrix(row, feature_names=booster.feature_names), pred_contribs=True)[0, best_idx, :-1]
    top = [j for j in np.argsort(-contrib)[:2] if contrib[j] > 0]
    parts = [f"{FEATURES[j].replace('_', ' ')} not read" if np.isnan(row[0, j]) else _SAY[FEATURES[j]].format(row[0, j])
             for j in top]
    reason = f"{label}: {' and '.join(parts)}" if parts else f"{label}: no single reading stands out"

    dest, alert = destination(label, conf, event.get("building_id"))
    route = "bin" if conf >= _CONFIDENCE_THRESHOLD else "manual_sort"
    time_ms = round((time.perf_counter() - t0) * 1000.0, 4)
    return {"label": label, "confidence": round(conf, 4), "reason": reason, "destination": dest,
            "route": route, "alert": alert, "time_ms": time_ms}


def classifier_metrics():
    """
    Metrics written by src/train_classifier.py (stratified 5-fold CV, out-of-fold predictions).

    Returns:
        dict with accuracy, accuracy_per_class, macro_f1, confusion (rows = actual, cols = predicted),
        classes / class_names (matrix order), sensor_importance, size_kb, time_ms, plus the not-sure stats
        and the model comparison table.
    """
    return {**_METRICS_DATA, "class_names": _CLASSES}


def metrics():
    """Alias for classifier_metrics to match schema.py in PLAN.md."""
    return classifier_metrics()


if __name__ == "__main__":
    m = classifier_metrics()
    print(f"Accuracy {m['accuracy']:.2%}, macro-F1 {m['macro_f1']:.4f}, {m['size_kb']} KB, {m['time_ms']} ms")
    print("Per class:", m["accuracy_per_class"])
    print("Sensor importance:", m["sensor_importance"])
    assert {"accuracy", "accuracy_per_class", "macro_f1", "confusion", "sensor_importance", "size_kb", "time_ms"} <= set(m)

    # Routing rules
    assert destination("food_organic", 0.9, "B05") == ("composter B05 (own)", None)
    assert destination("food_organic", 0.9, "B01")[0] == "composter B07 (nearest)"
    assert destination("glass", 0.9, "B01") == ("recycling (glass)", None)
    assert destination("ewaste", 0.9)[0] == "certified e-waste pickup" and destination("ewaste", 0.9)[1]
    assert destination("ewaste", 0.5)[0] == "manual sort" and destination("plastic", 0.59)[1]

    food = predict({"weight_g": 350.0, "moisture_pct": 72.0, "metal_signal": 5.0, "transparency": 0.12,
                    "acoustic_hardness": 0.10, "building_id": "B06"})
    print("Food-like item:", food)
    assert food["label"] == "food_organic" and food["destination"] == "composter B06 (own)"
    assert food["reason"].startswith("food_organic: ") and "moisture" in food["reason"]
    gap = predict({"weight_g": 350.0, "moisture_pct": None, "metal_signal": 5.0, "transparency": 0.12,
                   "acoustic_hardness": 0.10})
    print("Missing moisture:", gap)

    # Whole live stream (1,601 test events): agrees with the predictions file, alerts, and time per event
    test = pd.read_csv(os.path.join(os.path.dirname(_CURRENT_DIR), "datasets", "raw", "waste_events_test.csv"))
    out = [predict({k: (None if pd.isna(v) else v) for k, v in r.items()}) for r in test.to_dict("records")]
    saved = pd.read_csv(os.path.join(os.path.dirname(_CURRENT_DIR), "data", "waste_events_test_predictions.csv"))
    assert list(saved.columns) == ["event_id", "predicted_class"] and len(saved) == len(test)
    assert (saved.predicted_class.values == [o["label"] for o in out]).all()
    worst = max(o["time_ms"] for o in out)
    median = float(np.median([o["time_ms"] for o in out]))
    assert worst < 2000
    print(f"Live stream: {len(out)} events, {sum(o['destination'] == 'certified e-waste pickup' for o in out)} e-waste alerts, "
          f"{sum(o['route'] == 'manual_sort' for o in out)} manual sort, median {median:.2f} ms, slowest {worst:.2f} ms (limit 2,000 ms)")
    print("classifier.py self-check passed")
