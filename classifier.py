"""
Classifier module for Smart-Bin Waste Sorter.
Loads the trained XGBoost model once at module initialization.
Provides predict(event) and classifier_metrics() for the dashboard.
"""

import os
import json
import time
import joblib
import numpy as np

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
    _MODEL.set_params(device="cpu")
except Exception:
    pass

with open(_METRICS_PATH, "r", encoding="utf-8") as _f:
    _METRICS_DATA = json.load(_f)

_CLASSES = _METRICS_DATA["classes"]
_CONFIDENCE_THRESHOLD = 0.60


def predict(event):
    """
    Predict waste category for a single bin event's sensor readings.
    
    Parameters:
        event (dict): Dictionary with keys:
            - 'weight_g'
            - 'moisture_pct'
            - 'metal_signal'
            - 'transparency'
            - 'acoustic_hardness'
            
    Returns:
        tuple: (label, confidence, time_ms, route)
            - label (str): One of the 6 waste types
            - confidence (float): Probability between 0.0 and 1.0
            - time_ms (float): Execution latency in milliseconds
            - route (str): 'bin' if confidence >= 0.60 else 'manual_sort'
    """
    t0 = time.perf_counter()
    
    # Extract, impute defaults if missing, and clamp readings
    row = np.array([
        max(0.0, float(event.get("weight_g", 122.0) if event.get("weight_g") is not None and not np.isnan(event.get("weight_g", np.nan)) else 122.0)),
        min(100.0, max(0.0, float(event.get("moisture_pct", 11.5) if event.get("moisture_pct") is not None and not np.isnan(event.get("moisture_pct", np.nan)) else 11.5))),
        min(100.0, max(0.0, float(event.get("metal_signal", 5.3) if event.get("metal_signal") is not None and not np.isnan(event.get("metal_signal", np.nan)) else 5.3))),
        min(1.0, max(0.0, float(event.get("transparency", 0.1) if event.get("transparency") is not None and not np.isnan(event.get("transparency", np.nan)) else 0.1))),
        min(1.0, max(0.0, float(event.get("acoustic_hardness", 0.24) if event.get("acoustic_hardness") is not None and not np.isnan(event.get("acoustic_hardness", np.nan)) else 0.24)))
    ], dtype=np.float32).reshape(1, -1)
    
    probs = _MODEL.predict_proba(row)[0]
    best_idx = int(np.argmax(probs))
    conf = float(probs[best_idx])
    label = _CLASSES[best_idx]
    
    route = "bin" if conf >= _CONFIDENCE_THRESHOLD else "manual_sort"
    
    t1 = time.perf_counter()
    time_ms = round((t1 - t0) * 1000.0, 4)
    
    return label, round(conf, 4), time_ms, route


def classifier_metrics():
    """
    Returns verified metrics computed during 5-fold cross-validation.
    
    Returns:
        tuple: (accuracy, macro_f1, confusion, classes, size_kb, time_ms)
            - accuracy (float): Overall 5-fold cross validation accuracy
            - macro_f1 (float): Average macro F1 score across all 6 classes
            - confusion (list of lists): 6x6 confusion matrix
            - classes (list of str): Class names in matrix row/col order
            - size_kb (float): Size of trained model file in KB
            - time_ms (float): Average CPU single prediction latency in ms
    """
    return (
        _METRICS_DATA["accuracy"],
        _METRICS_DATA["macro_f1"],
        _METRICS_DATA["confusion"],
        _METRICS_DATA["classes"],
        _METRICS_DATA["size_kb"],
        _METRICS_DATA["time_ms"]
    )


def metrics():
    """Alias for classifier_metrics to match schema.py in PLAN.md."""
    return classifier_metrics()


if __name__ == "__main__":
    # Self-test
    print("Testing classifier_metrics()...")
    acc, f1, cm, cl, sz, ms = classifier_metrics()
    print(f"Accuracy: {acc*100:.2f}%, Macro-F1: {f1:.4f}, Size: {sz:.2f} KB, Latency: {ms:.4f} ms")
    print("Classes:", cl)
    
    print("\nTesting predict() on sample event:")
    sample = {
        "weight_g": 350.0,
        "moisture_pct": 72.0,
        "metal_signal": 5.0,
        "transparency": 0.12,
        "acoustic_hardness": 0.10
    }
    pred_label, pred_conf, pred_ms, pred_route = predict(sample)
    print(f"Prediction: label={pred_label}, confidence={pred_conf}, time_ms={pred_ms}, route={pred_route}")
