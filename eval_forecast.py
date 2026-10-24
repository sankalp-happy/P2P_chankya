"""P1: walk-forward evaluation of the forecasting model over the last 20 days (exam window included).

Writes models/forecast_metrics.json and models/walkforward_predictions.csv.
`python eval_forecast.py` regenerates both; `python eval_forecast.py --smoke` is a 2-day, 1-stream dry run
that writes nothing."""
import forecast  # noqa: F401  first: it limits OpenMP to one thread before anything fits a model
from forecast import BUILDINGS, DAY_TYPES, FEATURES, HORIZONS, MODELS, STREAMS, TEST_START, features, fit, hourly

import io
import json
import os
import sys
import time
from datetime import datetime

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

SMOKE = "--smoke" in sys.argv
DAY = pd.Timedelta(days=1)
DAYS = list(pd.date_range(TEST_START, periods=20, freq="D"))
# label -> column name in walkforward_predictions.csv
METHODS = {
    "simple guess": "simple_guess",
    "our model": "our_model",
    "our model, no retraining": "our_model_no_retrain",
    "small model": "small_model",
}
RETRAINED = {}  # filled below, once fit_small exists

PROTOCOL = (
    "Walk-forward over 20 test days, 2026-09-28 to 2026-10-17 (all 9 exam days, and the 2026-10-02 holiday, fall inside). "
    "For every stream (electricity, water), horizon (6 h, 12 h) and test day d, the model is retrained at midnight d on "
    "features(hourly(as_of=d)), using only target hours before d and only meter rows already received by d, then used to "
    "forecast the 24 target hours of day d. Test rows have an observed target; features look back from the forecast origin "
    "(target hour minus horizon), plus the same hour yesterday and last week, and the temperature is the real daily mean "
    "of the target date, a stand-in for a weather forecast. Methods: 'simple guess' predicts the same hour yesterday; "
    "'our model' is forecast.fit (gradient boosting, up to 300 iterations) retrained every day; 'our model, no retraining' is one fit at "
    "midnight 2026-09-28 used for all 20 days (the drift comparison, it has never seen an exam day); 'small model' is the "
    "same daily retraining with up to 100 iterations, 15 leaves per tree and learning rate 0.1. All methods are scored on the same rows, dropping "
    "any row where a prediction is missing. Errors are split by the target date's day type (exam vs everything else, "
    "so the holiday and weekends count as normal): MAE in kWh or litres, and percent error = 100 * sum|error| / sum(actual). "
    "A spike is an actual value above the 95th percentile of that stream, building and hour of day over all data before "
    "2026-09-28 (a fixed threshold); a spike is caught when the prediction is above the same threshold, and a false alarm "
    "is a prediction above it when the actual was not. size_kb is the joblib (compress=3) file size, train_s the mean seconds "
    "per fit (the single fit for no retraining), time_ms the median wall time of one building's 12-hour forecast (12 rows) "
    "on one core; for the simple guess it times reading the stored same-hour-yesterday values. Everything is measured on "
    "single-threaded scikit-learn 1.4.1."
)


def fit_small(X):
    """Same recipe as forecast.fit with a much smaller ensemble, to show the accuracy-vs-size trade-off."""
    X = X.dropna(subset=["y"])
    model = HistGradientBoostingRegressor(
        max_iter=100, max_leaf_nodes=15, learning_rate=0.1, categorical_features=["building", "day_type"], random_state=0
    )
    return model.fit(X[FEATURES], X.y)


RETRAINED.update({"our model": fit, "small model": fit_small})


def timed_fit(fit_fn, X):
    start = time.perf_counter()
    model = fit_fn(X)
    return model, time.perf_counter() - start


def size_kb(model):
    buf = io.BytesIO()
    joblib.dump(model, buf, compress=3)
    return buf.getbuffer().nbytes / 1024


def time_ms(call, repeats=15):
    """Wall time of each of `repeats` calls, in ms, after one warm-up call."""
    call()
    out = []
    for _ in range(repeats):
        start = time.perf_counter()
        call()
        out.append((time.perf_counter() - start) * 1000)
    return out


def train_rows(stream, h, d):
    """What a model retrained at midnight d may see: meter rows received by d, targets before d."""
    X = features(hourly(as_of=d), stream, h)
    X = X[X.ts < d]
    assert X.ts.max() < d
    return X


def spike_thresholds(full, stream):
    """95th percentile per (building, hour of day) over everything before TEST_START; fixed, so the definition doesn't move."""
    past = full[full.ts < TEST_START].assign(hour=lambda x: x.ts.dt.hour)
    return past.groupby(["building_id", "hour"])[stream].quantile(0.95).rename("thr").reset_index()


def walk_forward(full, stream, h, days):
    """Predictions of all four methods on every test row, plus size / train time / predict time per method."""
    test = features(full, stream, h)
    cost = {label: {"size_kb": [], "train_s": [], "ms": []} for label in METHODS}
    static, static_s = timed_fit(fit, train_rows(stream, h, TEST_START))
    cost["our model, no retraining"]["size_kb"].append(size_kb(static))
    cost["our model, no retraining"]["train_s"].append(static_s)
    cost["simple guess"]["size_kb"].append(0.0)
    cost["simple guess"]["train_s"].append(0.0)
    parts = []
    for d in days:
        day = test[(test.ts >= d) & (test.ts < d + DAY)]
        T = day[day.y.notna()].copy()
        assert T.ts.between(d, d + DAY, inclusive="left").all()
        rows12 = day[day.building_id == "B01"].head(12)  # one building's 12-hour forecast
        assert len(rows12) == 12
        X12 = rows12[FEATURES]

        T["simple_guess"] = T.lag24
        cost["simple guess"]["ms"] += time_ms(lambda: rows12.lag24.to_numpy())
        train = train_rows(stream, h, d)
        for label, fit_fn in RETRAINED.items():
            model, secs = timed_fit(fit_fn, train)
            T[METHODS[label]] = model.predict(T[FEATURES])
            cost[label]["size_kb"].append(size_kb(model))
            cost[label]["train_s"].append(secs)
            cost[label]["ms"] += time_ms(lambda: model.predict(X12))
        T["our_model_no_retrain"] = static.predict(T[FEATURES])
        cost["our model, no retraining"]["ms"] += time_ms(lambda: static.predict(X12))
        parts.append(T)
        print(f"  {stream} {h}h {d.date()} done", flush=True)

    R = pd.concat(parts, ignore_index=True)
    R = R.dropna(subset=list(METHODS.values()))  # same rows for every method
    R = R.merge(spike_thresholds(full, stream), on=["building_id", "hour"], how="left")
    R["day_type"] = R.day_type.map(dict(enumerate(DAY_TYPES)))
    R["stream"], R["horizon"] = stream, h
    return R, cost


def r(x, nd=2):
    """Round to plain Python float; NaN becomes None so the JSON stays valid."""
    return None if pd.isna(x) else round(float(x), nd)


def metric_row(R, label, cost, stream, h):
    col = METHODS[label]
    err = (R[col] - R.y).abs()
    exam = R.day_type == "exam"
    spike = R.y > R.thr
    alarm = R[col] > R.thr
    pct = lambda m: 100 * err[m].sum() / R.y[m].sum()
    c = cost[label]
    return {
        "method": label, "stream": stream, "horizon": h, "n": int(len(R)),
        "error_normal_days": r(err[~exam].mean()), "error_exam_days": r(err[exam].mean()),
        "error_normal_pct": r(pct(~exam)), "error_exam_pct": r(pct(exam)),
        "spikes_caught": int((spike & alarm).sum()), "spikes_total": int(spike.sum()),
        "spikes_total_exam": int((spike & exam).sum()), "false_alarms": int((alarm & ~spike).sum()),
        "size_kb": r(np.mean(c["size_kb"])), "train_s": r(np.mean(c["train_s"])),
        "time_ms": r(np.median(c["ms"]), 3) if c["ms"] else 0.0,
    }


def daily_rows(R, stream, h):
    """Per test day and method: MAE and percent error, for the drift chart."""
    out = []
    for label, col in METHODS.items():
        for date, x in R.assign(err=(R[col] - R.y).abs()).groupby(R.ts.dt.normalize()):
            out.append({
                "date": date.strftime("%Y-%m-%d"), "day_type": x.day_type.iloc[0], "stream": stream, "horizon": h,
                "method": label, "mae": r(x.err.mean()), "pct": r(100 * x.err.sum() / x.y.sum()),
            })
    return out


def markdown_table(rows):
    cols = list(rows[0])
    lines = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    lines += ["| " + " | ".join(str(row[c]) for c in cols) + " |" for row in rows]
    return "\n".join(lines)


def main():
    start, load = time.perf_counter(), os.getloadavg()[0]  # timings below are inflated if the machine is busy
    days = DAYS[:2] if SMOKE else DAYS
    streams = STREAMS[:1] if SMOKE else STREAMS
    full = hourly()
    assert set(full.building_id) == set(BUILDINGS)
    rows, daily, preds = [], [], []
    for stream in streams:
        for h in HORIZONS:
            R, cost = walk_forward(full, stream, h, days)
            rows += [metric_row(R, label, cost, stream, h) for label in METHODS]
            daily += daily_rows(R, stream, h)
            preds.append(R)
    print(markdown_table(rows))
    print(f"total runtime {time.perf_counter() - start:.0f} s; load average at start/end {load:.0f}/{os.getloadavg()[0]:.0f} on {os.cpu_count()} cores")
    if SMOKE:
        return
    MODELS.mkdir(exist_ok=True)
    out = {"rows": rows, "daily": daily, "protocol": PROTOCOL, "generated_at": datetime.now().isoformat(timespec="seconds")}
    (MODELS / "forecast_metrics.json").write_text(json.dumps(out, indent=1, allow_nan=False))
    cols = ["ts", "building_id", "stream", "horizon", "day_type", "y", *METHODS.values()]
    pd.concat(preds)[cols].round(4).to_csv(MODELS / "walkforward_predictions.csv", index=False)


if __name__ == "__main__":
    main()
