"""
Train the smart-bin waste classifier and write models/waste.joblib, models/waste_metrics.json
and data/waste_events_test_predictions.csv.

- Data: datasets/raw/waste_events_train.csv, label column `category` (the README calls it `waste_class`).
- Features: the 5 sensor readings only. bin_id / building_id are left out on purpose: a bin in a new room
  has no location prior to lean on.
- Cleaning: clip to physical limits. Missing readings stay NaN; XGBoost learns a default branch for them,
  and classifier.predict() passes NaN through the same way.
- Model choice: stratified 5-fold CV over 5 model families, keep the best macro-F1, refit on all rows.

Run: python3 src/train_classifier.py
"""
import os

os.environ.setdefault("OMP_NUM_THREADS", "1")  # one thread: fair per-item timing, no OpenMP spin on a busy laptop

import json
import tempfile
import time

import joblib
import numpy as np
import pandas as pd
from lightgbm import LGBMClassifier
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score
from sklearn.model_selection import StratifiedKFold
from sklearn.pipeline import make_pipeline
from sklearn.tree import DecisionTreeClassifier
from xgboost import XGBClassifier

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FEATURES = ["weight_g", "moisture_pct", "metal_signal", "transparency", "acoustic_hardness"]
LIMITS = {"weight_g": (0, None), "moisture_pct": (0, 100), "metal_signal": (0, 100),
          "transparency": (0, 1), "acoustic_hardness": (0, 1)}
NOT_SURE = 0.60
SEED = 42

MODELS = {
    # DT and RF cannot take NaN in sklearn 1.4, so they get a median fill.
    "Decision Tree (depth=4)": lambda: make_pipeline(SimpleImputer(strategy="median"),
                                                     DecisionTreeClassifier(max_depth=4, random_state=SEED)),
    "Random Forest (n=100, d=12)": lambda: make_pipeline(SimpleImputer(strategy="median"),
                                                         RandomForestClassifier(100, max_depth=12, random_state=SEED, n_jobs=1)),
    "HistGradientBoosting": lambda: HistGradientBoostingClassifier(random_state=SEED),
    "LightGBM (n=100, d=5)": lambda: LGBMClassifier(n_estimators=100, max_depth=5, random_state=SEED, n_jobs=1, verbose=-1),
    "XGBoost (d=4, n=100, lr=0.08)": lambda: XGBClassifier(max_depth=4, n_estimators=100, learning_rate=0.08,
                                                           random_state=SEED, n_jobs=1),
}


def clean(df):
    x = df[FEATURES].astype(float)
    for c, (lo, hi) in LIMITS.items():
        x[c] = x[c].clip(lo, hi)
    return x


def size_kb_and_ms(model, x):
    with tempfile.NamedTemporaryFile(suffix=".joblib") as f:
        joblib.dump(model, f.name)
        size = os.path.getsize(f.name) / 1024
    row = x.iloc[[0]].to_numpy()
    model.predict_proba(row)  # warm-up
    t = []
    for i in range(200):
        t0 = time.perf_counter()
        model.predict_proba(x.iloc[[i]].to_numpy())
        t.append(time.perf_counter() - t0)
    return round(size, 2), round(float(np.median(t)) * 1000, 3)


def main():
    train = pd.read_csv(os.path.join(ROOT, "datasets", "raw", "waste_events_train.csv"))
    x = clean(train)
    classes = sorted(train.category.unique())
    y = train.category.map({c: i for i, c in enumerate(classes)}).to_numpy()
    print(f"{len(x)} events, {x.isna().any(axis=1).sum()} with a missing reading (kept as NaN)")

    folds = list(StratifiedKFold(5, shuffle=True, random_state=SEED).split(x, y))
    results = {}
    for name, make in MODELS.items():
        proba = np.zeros((len(x), len(classes)))
        importance = np.zeros(len(FEATURES))
        for tr, va in folds:
            m = make().fit(x.iloc[tr].to_numpy(), y[tr])
            proba[va] = m.predict_proba(x.iloc[va].to_numpy())
            if name.startswith("XGBoost"):
                pi = permutation_importance(m, x.iloc[va].to_numpy(), y[va], scoring="accuracy",
                                            n_repeats=5, random_state=SEED)
                importance += pi.importances_mean / len(folds)
        pred, conf = proba.argmax(1), proba.max(1)
        sure = conf >= NOT_SURE
        fold_acc = [accuracy_score(y[va], pred[va]) for _, va in folds]
        results[name] = dict(pred=pred, importance=importance, accuracy=accuracy_score(y, pred),
                             fold_std=float(np.std(fold_acc)), macro_f1=f1_score(y, pred, average="macro"),
                             manual_pct=100 * (1 - sure.mean()), sure_accuracy=accuracy_score(y[sure], pred[sure]),
                             sure_macro_f1=f1_score(y[sure], pred[sure], average="macro"))

    print(f"\n{'model':32} {'acc':>7} {'±fold':>6} {'macroF1':>8} {'size KB':>9} {'ms/item':>8} {'manual%':>8}")
    for name, r in results.items():
        r["size_kb"], r["time_ms"] = size_kb_and_ms(MODELS[name]().fit(x.to_numpy(), y), x)
        print(f"{name:32} {r['accuracy']:7.2%} {r['fold_std']:6.2%} {r['macro_f1']:8.4f} {r['size_kb']:9.2f} "
              f"{r['time_ms']:8.3f} {r['manual_pct']:7.2f}%")

    best = max(results, key=lambda n: results[n]["macro_f1"])
    r = results[best]
    cm = confusion_matrix(y, r["pred"])
    model = MODELS[best]().fit(x.to_numpy(), y)
    joblib.dump(model, os.path.join(ROOT, "models", "waste.joblib"))
    imp = dict(zip(FEATURES, (round(float(v), 4) for v in r["importance"])))
    metrics = {
        "model_name": best,
        "evaluation": "stratified 5-fold CV, out-of-fold predictions, seed 42; size and time measured on this laptop",
        "accuracy": round(r["accuracy"], 4),
        "accuracy_fold_std": round(r["fold_std"], 4),
        "accuracy_per_class": {c: round(cm[i, i] / cm[i].sum(), 4) for i, c in enumerate(classes)},
        "macro_f1": round(r["macro_f1"], 4),
        "confusion": cm.tolist(),
        "classes": classes,
        "sensor_importance": dict(sorted(imp.items(), key=lambda kv: -kv[1])),
        "sensor_importance_method": "permutation importance (accuracy drop), XGBoost, mean over the 5 validation folds",
        "size_kb": r["size_kb"],
        "time_ms": r["time_ms"],
        "not_sure_threshold": NOT_SURE,
        "manual_sort_pct": round(r["manual_pct"], 2),
        "sure_accuracy": round(r["sure_accuracy"], 4),
        "sure_macro_f1": round(r["sure_macro_f1"], 4),
        "comparison": {n: {k: round(v, 4) for k, v in res.items() if k in
                           ("accuracy", "fold_std", "macro_f1", "size_kb", "time_ms", "manual_pct")}
                       for n, res in results.items()},
    }
    with open(os.path.join(ROOT, "models", "waste_metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)

    test = pd.read_csv(os.path.join(ROOT, "datasets", "raw", "waste_events_test.csv"))
    pd.DataFrame({"event_id": test.event_id,
                  "predicted_class": np.array(classes)[model.predict(clean(test).to_numpy())]}
                 ).to_csv(os.path.join(ROOT, "data", "waste_events_test_predictions.csv"), index=False)

    print(f"\nkept: {best}")
    print("per-class accuracy:", metrics["accuracy_per_class"])
    print("sensor importance:", metrics["sensor_importance"])
    print(f"not sure (<{NOT_SURE:.0%}): {metrics['manual_sort_pct']}% to manual sort; "
          f"accuracy on the rest {metrics['sure_accuracy']:.2%}, macro-F1 {metrics['sure_macro_f1']:.4f}")
    print(f"wrote models/waste.joblib, models/waste_metrics.json, data/waste_events_test_predictions.csv ({len(test)} rows)")


if __name__ == "__main__":
    main()
