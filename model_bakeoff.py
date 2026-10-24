"""P1: model bake-off at the 12 h horizon: simple guess, Ridge, RandomForest, MLP, our gradient boosting, LSTM.
`python model_bakeoff.py` writes models/bakeoff.json and models/bakeoff.md; `--smoke` is a 1-day dry run that writes nothing."""
import forecast  # first: limits OpenMP to one thread before any model is fitted
from forecast import BUILDINGS, DAY_TYPES, FEATURES, MODELS, STREAMS, TEST_START, features, fit, hourly

import io
import json
import os
import sys
import time
from datetime import datetime

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.neural_network import MLPRegressor

try:
    import torch
    torch.set_num_threads(1)
except ImportError:
    torch = None

SMOKE = "--smoke" in sys.argv
H, DAY = 12, pd.Timedelta(days=1)
NDAYS = 1 if SMOKE else 20
RETRAIN = list(pd.date_range(TEST_START, periods=NDAYS // (1 if SMOKE else 5), freq="5D"))  # 09-28, 10-03, 10-08, 10-13
STEP = 1 if SMOKE else 5
NUM = ["hour", "dow", "temp", "now", "lag24", "lag168", "roll24", "is_event"]
WIN, EPOCHS = 168, 5
LSTM = "LSTM"
MODELS_LIST = ["simple guess (lag24)", "Ridge", "RandomForest", "MLP", "our model (HistGB)"] + ([LSTM] if torch else [])

PROTOCOL = (
    "12 h horizon, both streams, features = forecast.FEATURES, test days 2026-09-28..2026-10-17 (20 days, all exam days inside). "
    "To bound runtime every model is retrained every 5 days, at midnight 09-28, 10-03, 10-08 and 10-13, on features(hourly(as_of=d)) "
    "with targets before d, and each fit serves the next 5 days; the same schedule applies to every model. All models are scored on the "
    "same rows (rows where any prediction is NaN are dropped). Non-GB models: NaN filled with the training median per column; "
    "Ridge and MLP use one-hot building/day_type and standard scaling, RandomForest the imputed ordinal features. Ridge(alpha=1); "
    "RandomForest(100 trees, min_samples_leaf=5, 1 job); MLP (64,32), early_stopping, max_iter=300; our model = forecast.fit. "
    + ("LSTM: single layer, hidden 32, input = last 168 hourly values of the building ending 12 h before the target (scaled per building with training mean/std, "
       "NaN -> 0) concatenated with the target hour's calendar features (hour/dow sin-cos, day_type one-hot, building one-hot, is_event, scaled temp), "
       f"linear head, Adam lr 3e-3, batch 256, {EPOCHS} epochs, MSE, one CPU thread, seed 0. " if torch else
       "LSTM skipped: torch is not importable in this environment. ")
    + "Metrics: MAE, WAPE = 100*sum|err|/sum(actual) overall, on exam days and on working days. size_kb = joblib compress=3 "
      "(state_dict for the LSTM), train_s = mean seconds per fit, predict_ms = median wall time to prepare inputs and predict one building's 12 rows, "
      "one thread. Other processes were running on this machine, so timings are noisy (see load)."
)


class Prep:
    """Median imputation fitted on train; ordinal (trees) or one-hot + standard scaling (linear / MLP)."""
    def __init__(self, X, onehot):
        self.onehot, self.med = onehot, X[FEATURES].median()
        self.mu = self.sd = None
        if onehot:
            A = self._raw(X)
            self.mu, self.sd = A.mean(0), A.std(0) + 1e-9

    def _raw(self, X):
        X = X[FEATURES].fillna(self.med)
        if not self.onehot:
            return X.to_numpy(float)
        oh = [(X.building.to_numpy()[:, None] == np.arange(len(BUILDINGS))), (X.day_type.to_numpy()[:, None] == np.arange(len(DAY_TYPES)))]
        return np.hstack([X[NUM].to_numpy(float)] + [o.astype(float) for o in oh])

    def __call__(self, X):
        A = self._raw(X)
        return (A - self.mu) / self.sd if self.onehot else A


def sk_model(name, X):
    y = X.y.to_numpy()
    P = Prep(X, onehot=name != "RandomForest")
    est = {"Ridge": Ridge(alpha=1.0),
           "RandomForest": RandomForestRegressor(n_estimators=100, min_samples_leaf=5, n_jobs=1, random_state=0),
           "MLP": MLPRegressor((64, 32), early_stopping=True, max_iter=300, random_state=0)}[name]
    est.fit(P(X), y)
    return lambda Z: est.predict(P(Z)), (est, P)


# ---------- LSTM ----------
def cal_feats(R, mean_temp, sd_temp):
    ang = lambda v, p: np.c_[np.sin(2 * np.pi * v / p), np.cos(2 * np.pi * v / p)]
    dt = R.day_type.fillna(0).to_numpy()[:, None] == np.arange(len(DAY_TYPES))
    b = R.building.to_numpy()[:, None] == np.arange(len(BUILDINGS))
    t = ((R.temp.fillna(mean_temp) - mean_temp) / sd_temp).to_numpy()[:, None]
    return np.hstack([ang(R.hour.to_numpy(), 24), ang(R.dow.to_numpy(), 7), dt, b, R.is_event.to_numpy()[:, None], t]).astype(np.float32)


class Net(torch.nn.Module if torch else object):
    def __init__(self, ncal):
        super().__init__()
        self.lstm = torch.nn.LSTM(1, 32, batch_first=True)
        self.head = torch.nn.Linear(32 + ncal, 1)

    def forward(self, w, c):
        return self.head(torch.cat([self.lstm(w)[0][:, -1], c], 1)).squeeze(1)


def windows(grid, rows):
    """(n, 168, 1) scaled history of each row's building ending 12 h before its target hour."""
    pos = ((rows.ts - grid.index[0]) / pd.Timedelta(hours=1)).astype(int).to_numpy()
    A = np.vstack([np.zeros((WIN, grid.shape[1])), np.nan_to_num(grid.to_numpy(float))])  # 0 = building mean once scaled
    V = np.lib.stride_tricks.sliding_window_view(A, WIN, axis=0)  # (T', 8, 168)
    return V[pos - H + 1, rows.building.to_numpy()][:, :, None].astype(np.float32)


def lstm_model(X, pivot_d, pivot_full):
    mu, sd = pivot_d.mean(), pivot_d.std()
    sc = lambda p: ((p - mu) / sd).reindex(columns=BUILDINGS)
    gd = sc(pivot_d).reindex(pd.date_range(pivot_d.index.min(), pivot_full.index.max(), freq="h"))
    gf = sc(pivot_full).reindex(gd.index)
    X = X[X.y.notna() & (X.ts >= gd.index[0] + pd.Timedelta(hours=H))]
    tm, ts_ = X.temp.mean(), X.temp.std()
    torch.manual_seed(0)
    net = Net(cal_feats(X.head(1), tm, ts_).shape[1])
    W, C = torch.from_numpy(windows(gd, X)), torch.from_numpy(cal_feats(X, tm, ts_))
    y = torch.from_numpy(((X.y.to_numpy() - mu[X.building_id].to_numpy()) / sd[X.building_id].to_numpy()).astype(np.float32))
    opt = torch.optim.Adam(net.parameters(), lr=3e-3)
    for _ in range(EPOCHS):
        for idx in torch.randperm(len(y)).split(256):
            opt.zero_grad()
            torch.nn.functional.mse_loss(net(W[idx], C[idx]), y[idx]).backward()
            opt.step()
    net.eval()

    def predict(Z):
        with torch.no_grad():
            out = net(torch.from_numpy(windows(gf, Z)), torch.from_numpy(cal_feats(Z, tm, ts_))).numpy()
        return out * sd[Z.building_id].to_numpy() + mu[Z.building_id].to_numpy()
    return predict, net.state_dict()


# ---------- harness ----------
def size_kb(obj):
    buf = io.BytesIO()
    joblib.dump(obj, buf, compress=3)
    return buf.getbuffer().nbytes / 1024


def ms(call, repeats=7):
    call()
    out = []
    for _ in range(repeats):
        t = time.perf_counter()
        call()
        out.append((time.perf_counter() - t) * 1000)
    return out


def run_stream(full, stream):
    test = features(full, stream, H)
    pivot_full = full.pivot(index="ts", columns="building_id", values=stream)
    cost = {m: {"size_kb": [], "train_s": [], "ms": []} for m in MODELS_LIST}
    parts = []
    for d in RETRAIN:
        T = test[(test.ts >= d) & (test.ts < d + STEP * DAY) & test.y.notna()].copy()
        train = features(hourly(as_of=d), stream, H)
        train = train[train.ts < d]
        assert train.ts.max() < d
        X12 = T[T.building_id == "B01"].head(12)
        T["simple guess (lag24)"] = T.lag24
        cost["simple guess (lag24)"]["size_kb"].append(0.0)
        cost["simple guess (lag24)"]["train_s"].append(0.0)
        cost["simple guess (lag24)"]["ms"] += ms(lambda: X12.lag24.to_numpy())
        fits = {n: (lambda n=n: sk_model(n, train.dropna(subset=["y"]))) for n in ["Ridge", "RandomForest", "MLP"]}
        fits["our model (HistGB)"] = lambda: (lambda m: (m.predict, m))(fit(train))
        if torch:
            fits[LSTM] = lambda: lstm_model(train, hourly(as_of=d).pivot(index="ts", columns="building_id", values=stream), pivot_full)
        for name, f in fits.items():
            t = time.perf_counter()
            predict, obj = f()
            cost[name]["train_s"].append(time.perf_counter() - t)
            T[name] = predict(T[FEATURES] if name == "our model (HistGB)" else T)
            cost[name]["size_kb"].append(size_kb(obj))
            cost[name]["ms"] += ms(lambda: predict(X12[FEATURES] if name == "our model (HistGB)" else X12))
            print(f"  {stream} {d.date()} {name} done {cost[name]['train_s'][-1]:.0f}s", flush=True)
        parts.append(T)
    R = pd.concat(parts).dropna(subset=MODELS_LIST)  # same rows for every model
    R["day_type"] = R.day_type.map(dict(enumerate(DAY_TYPES)))
    rows = []
    for m in MODELS_LIST:
        err, c = (R[m] - R.y).abs(), cost[m]
        wape = lambda mask: round(100 * err[mask].sum() / R.y[mask].sum(), 2)
        rows.append({"model": m, "stream": stream, "n": len(R), "mae": round(err.mean(), 3), "wape_pct": wape(R.y.notna()),
                     "wape_exam_pct": wape(R.day_type == "exam"), "wape_working_pct": wape(R.day_type == "working"),
                     "size_kb": round(np.mean(c["size_kb"]), 1), "train_s": round(np.mean(c["train_s"]), 2),
                     "predict_ms": round(float(np.median(c["ms"])), 3)})
    return rows


def main():
    start, load0 = time.perf_counter(), os.getloadavg()
    full = hourly()
    rows = [r for s in STREAMS for r in run_stream(full, s)]
    load1 = os.getloadavg()
    cols = list(rows[0])
    md = "\n".join(["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)] + ["| " + " | ".join(str(r[c]) for c in cols) + " |" for r in rows])
    runtime = time.perf_counter() - start
    note = f"\n\nLSTM {'ran' if torch else 'skipped (torch not importable)'}. Runtime {runtime:.0f} s; load average (1/5/15 min) start {tuple(round(x, 1) for x in load0)}, end {tuple(round(x, 1) for x in load1)} on {os.cpu_count()} cores."
    print(md + note)
    if SMOKE:
        return
    out = {"rows": [{k: (int(v) if isinstance(v, np.integer) else v) for k, v in r.items()} for r in rows], "protocol": PROTOCOL, "lstm_ran": bool(torch),
           "load_start": load0, "load_end": load1, "cpu_count": os.cpu_count(), "runtime_s": round(runtime),
           "generated_at": datetime.now().isoformat(timespec="seconds")}
    (MODELS / "bakeoff.json").write_text(json.dumps(out, indent=1, allow_nan=False))
    (MODELS / "bakeoff.md").write_text(f"# Model bake-off (12 h horizon)\n\n{PROTOCOL}\n\n{md}{note}\n")


if __name__ == "__main__":
    main()
