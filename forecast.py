"""P1: short-horizon forecasts of hourly electricity and water per building."""
import io
import json
import sys
import tempfile
import time
from functools import lru_cache
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from threadpoolctl import threadpool_limits

# OpenMP threads stall on this Mac (a 2,000-row fit took 18 s vs 3 s for our full fit on one thread).
# One core is also what a Pi-class edge box gives us, so all timings below are single-core.
threadpool_limits(1)

ROOT = Path(__file__).parent
DATA = ROOT / "datasets" / "raw"
MODELS = ROOT / "models"
STREAMS = ["electricity_kwh", "water_litres"]
HORIZONS = [6, 12]
BUILDINGS = [f"B0{i}" for i in range(1, 9)]
DAY_TYPES = ["working", "weekend", "semester_break", "exam", "holiday"]
FEATURES = ["building", "hour", "dow", "day_type", "is_event", "temp", "now", "lag24", "lag168", "roll24"]
TEST_START = pd.Timestamp("2026-09-28")  # last 20 days: all 9 exam days fall inside

# Flip to True once P3's ingest.py and P2's explain.py are real, not P4's stubs.
USE_TEAM = False

ALIASES = {
    "B01": ["academic block a", "acad block a", "block a"],
    "B02": ["academic block b", "acad block b", "block b"],
    "B03": ["central library", "central lib", "library"],
    "B04": ["engineering labs & innovation centre", "engineering labs", "eng labs", "labs", "innovation centre"],
    "B05": ["boys hostel", "boys hostle", "bh"],
    "B06": ["girls hostel", "girls hostle", "gh"],
    "B07": ["food court", "canteen", "fc"],
    "B08": ["admin block", "admin"],
}
ALIAS_TO_ID = {a: b for b, names in ALIASES.items() for a in names + [b.lower()]}


# ---------- loaders: same shape as P3's ingest.py, used until their cleaned data is in ----------

@lru_cache(maxsize=1)
def _deduped_hourly():
    """Retransmitted duplicates (same building + ts, jittered values) keep the first arrival.
    Dedup-then-filter equals filter-then-dedup: the first copy has arrived whenever any copy has."""
    df = pd.read_csv(DATA / "hourly_streams.csv", parse_dates=["timestamp", "received_at"])
    df = df.rename(columns={"timestamp": "ts", "solar_generation_kwh": "solar_kwh"})
    df = df.sort_values("received_at").drop_duplicates(["building_id", "ts"])
    return df.sort_values(["ts", "building_id"]).assign(status="measured").reset_index(drop=True)


def hourly(as_of=None):
    """Meter rows received by as_of (the server's view at that moment)."""
    if USE_TEAM:
        from ingest import load_hourly
        df = load_hourly(as_of).copy()
        # Train and forecast only on real readings: filled/estimated values would be fake targets.
        df.loc[~df.status.isin(["measured", "revised"]), STREAMS + ["footfall"]] = np.nan
        return df
    df = _deduped_hourly()
    return df.copy() if as_of is None else df[df.received_at <= pd.Timestamp(as_of)].reset_index(drop=True)


@lru_cache(maxsize=1)
def _calendar():
    return pd.read_csv(DATA / "calendar.csv", parse_dates=["date"])


def calendar():
    if USE_TEAM:
        from ingest import load_calendar
        return load_calendar()
    return _calendar().copy()


def daily():
    if USE_TEAM:
        from ingest import load_daily
        return load_daily()
    return pd.read_csv(DATA / "daily_summary.csv", parse_dates=["date"])


def manual_logs():
    """ts, building_id, stream, value, unit, note, role. Nicknames mapped to IDs, units to kWh / L / kg."""
    if USE_TEAM:
        from ingest import load_manual_logs
        return load_manual_logs()
    m = pd.read_csv(DATA / "manual_logs.csv", parse_dates=["logged_at"])
    factor = m.unit.map({"kL": 1000, "bags": 8}).fillna(1)
    return pd.DataFrame({
        "ts": m.logged_at,
        "building_id": m.building.str.strip().str.lower().map(ALIAS_TO_ID),
        "stream": m.stream,
        "value": m.value * factor,
        "unit": m.unit.replace({"kL": "L", "bags": "kg", "units": "kWh"}),
        "note": m.note,
        "role": m.logger_role,
    })


# ---------- features: only what is known `horizon` hours before the target hour ----------

def features(df, stream, horizon, until=None):
    """One row per (target hour ts, building). `y` is the target; `now`/`roll24` are at the forecast
    origin (ts - horizon); lag24/lag168 count back from the target, so horizon <= 24 keeps them known.
    `until` extends the hourly grid into the future so forecasts can be made past the last reading."""
    w = df.pivot(index="ts", columns="building_id", values=stream).reindex(columns=BUILDINGS)
    w = w.reindex(pd.date_range(w.index.min(), until or w.index.max(), freq="h"))
    parts = {
        "y": w,
        "now": w.shift(horizon),
        "lag24": w.shift(24),
        "lag168": w.shift(168),
        "roll24": w.rolling(24, min_periods=12).mean().shift(horizon),
    }
    X = pd.concat({k: v.stack(future_stack=True) for k, v in parts.items()}, axis=1)
    X.index.names = ["ts", "building_id"]
    X = X.reset_index()
    cal = calendar().set_index("date")
    day = X.ts.dt.normalize()
    X["building"] = X.building_id.map(BUILDINGS.index)
    X["hour"] = X.ts.dt.hour
    X["dow"] = X.ts.dt.dayofweek
    X["day_type"] = day.map(cal.day_type).map({t: i for i, t in enumerate(DAY_TYPES)})
    X["is_event"] = day.map(cal.event).notna().astype(int)
    X["temp"] = day.map(cal.avg_temp_c)  # real daily mean, a stand-in for a weather forecast
    return X


def fit(X):
    """Gradient boosting on the rows with a known target."""
    X = X.dropna(subset=["y"])
    model = HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.05, categorical_features=["building", "day_type"], random_state=0
    )
    return model.fit(X[FEATURES], X.y)


# ---------- model, forecast() and forecast_metrics() below ----------

RETRAIN_DAYS = pd.date_range(TEST_START, "2026-10-18")  # one model per midnight, 21 in all


@lru_cache(maxsize=1)
def holdout_band():
    """Prediction band: 10th and 90th percentile of (actual - predicted) per stream, horizon and building,
    on the 14 days before TEST_START, from models that never saw those days. Computed once, copied into every bundle."""
    start = TEST_START - pd.Timedelta(days=14)
    df = hourly(as_of=TEST_START)
    parts = []
    for stream in STREAMS:
        for h in HORIZONS:
            X = features(df, stream, h).dropna(subset=["y"])
            model = fit(X[X.ts < start])
            hold = X[(X.ts >= start) & (X.ts < TEST_START)]
            res = (hold.y - model.predict(hold[FEATURES])).groupby(hold.building_id)
            parts.append(pd.DataFrame({"q10": res.quantile(0.1), "q90": res.quantile(0.9)}).assign(stream=stream, horizon=h))
    return pd.concat(parts).reset_index().set_index(["stream", "horizon", "building_id"])


def train(until):
    """The models as retrained at midnight `until`, from the readings the server had received by then.
    Bundle: models and info keyed by (stream, horizon); spike (95th percentile) and typical (median) keyed by
    stream, then (building_id, hour of day); band; temp_mean (training mean of the daily temperature)."""
    until = pd.Timestamp(until)
    df = hourly(as_of=until)
    cal = calendar()
    bundle = {"trained_until": until, "models": {}, "info": {}, "spike": {}, "typical": {}, "band": holdout_band(),
              "temp_mean": cal[cal.date < until].avg_temp_c.mean()}
    for stream in STREAMS:
        for h in HORIZONS:
            X = features(df, stream, h)
            X = X[X.ts < until]
            t = time.perf_counter()
            model = fit(X)
            seconds = time.perf_counter() - t
            buf = io.BytesIO()
            joblib.dump(model, buf, compress=3)
            bundle["models"][stream, h] = model
            bundle["info"][stream, h] = {"train_s": seconds, "size_kb": len(buf.getvalue()) / 1024}
        by_hour = X.dropna(subset=["y"]).groupby(["building_id", "hour"]).y  # same target rows for any horizon
        bundle["spike"][stream] = by_hour.quantile(0.95).to_dict()
        bundle["typical"][stream] = by_hour.median().to_dict()
    return bundle


def train_all():
    """Save one bundle per retrain day: our 'retrain daily at midnight' deployment."""
    (MODELS / "bundles").mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    holdout_band()
    print(f"band done ({time.perf_counter() - start:.0f} s)", flush=True)
    for d in RETRAIN_DAYS:
        joblib.dump(train(d), MODELS / "bundles" / f"{d:%Y-%m-%d}.joblib", compress=3)
        print(f"{d:%Y-%m-%d} saved ({time.perf_counter() - start:.0f} s)", flush=True)


# ---------- forecast(): what the dashboard calls on every slider move ----------

DAY_NAMES = {"weekend": "weekend", "semester_break": "semester break", "exam": "exam day", "holiday": "holiday"}


@lru_cache(maxsize=32)  # all 21 bundles fit in memory, so the slider never reloads one
def _load_bundle(day):
    """`day` is 'YYYY-MM-DD'. A missing file is retrained on the spot (slow, but the dashboard keeps working)."""
    path = MODELS / "bundles" / f"{day}.joblib"
    return joblib.load(path) if path.exists() else train(day)


def _reasons(r, typical, mean_typical, temp_mean, event):
    """Up to 3 inputs that differ most from a normal day: calendar facts first, then usage ratios against the
    building's typical value (ranked by |log ratio|, only above 1.3x or below 0.7x), then temperature."""
    day_type = DAY_TYPES[int(r.day_type)] if pd.notna(r.day_type) else "working"
    facts = []
    if day_type != "working":
        facts.append(DAY_NAMES[day_type] + (f": {event}" if event else ""))
    elif event:
        facts.append(f"event: {event}")
    typical_now = typical[r.building_id, r.hour]
    typical_origin = typical[r.building_id, (r.ts - pd.Timedelta(hours=r.h)).hour]
    ratios = [("same hour last week", r.lag168 / typical_now), ("same hour yesterday", r.lag24 / typical_now),
              (f"usage {r.h} h earlier", r.now / typical_origin), ("last 24 h average", r.roll24 / mean_typical)]
    ratios = [(name, x) for name, x in ratios if x > 1.3 or x < 0.7]  # a missing input is NaN, which fails both tests
    ratios.sort(key=lambda p: -abs(np.log(max(p[1], 0.01))))  # max(): a reading of 0 would be log(0)
    texts = [f"{name} {x:.1f}x normal" for name, x in ratios]
    if pd.notna(r.temp) and abs(r.temp - temp_mean) >= 3:
        texts.append(f"{'hotter' if r.temp > temp_mean else 'cooler'} than usual ({r.temp:.0f} C vs {temp_mean:.0f} C)")
    return "; ".join((facts + texts)[:3]) or "normal pattern for this hour"


@lru_cache(maxsize=16)  # the 8 buildings of one slider move share one feature build
def _live(as_of, stream, horizon):
    """(t0, [(h, X)]): feature rows of every building for the target hours t0+1..t0+horizon, split by the model
    that serves them. t0 is the newest real reading of this stream the server has (any building): readings
    arrive ~1 h late, so we count ahead from it, not from as_of. The 6 h model covers hours 1-6 (fresher origin), the 12 h model hours 7-12."""
    df = hourly(as_of)
    t0 = df.ts[df[stream].notna()].max()  # not df.ts.max(): the team loader pads the grid with NaN estimates up to as_of
    if pd.isna(t0):  # slider before the first reading arrived
        return t0, []
    df = df[(df.ts >= t0 - pd.Timedelta(days=8)) & (df.ts <= t0)]  # lag168 plus a day of margin is all the features look back
    parts, done = [], 0
    for h in HORIZONS:
        last = min(h, horizon)
        if last <= done:
            break
        X = features(df, stream, h, until=t0 + pd.Timedelta(hours=last))
        parts.append((h, X[X.ts > t0 + pd.Timedelta(hours=done)]))
        done = last
    return t0, parts


def forecast(building_id, stream, as_of, horizon=12):
    """The next `horizon` (1-12) hours after the newest reading the server has at `as_of`.
    Columns: ts, predicted, low, high, simple_guess (same hour yesterday), is_spike, reasons.
    attrs: in_sample (as_of is before the first retrain day, so the model has seen the future),
    model_trained_until, newest_reading."""
    as_of = pd.Timestamp(as_of)
    assert 1 <= horizon <= max(HORIZONS), f"horizon must be 1..{max(HORIZONS)}"
    day = min(max(as_of.normalize(), TEST_START), RETRAIN_DAYS[-1])
    bundle = _load_bundle(f"{day:%Y-%m-%d}")
    t0, parts = _live(as_of, stream, horizon)
    if not parts:
        return pd.DataFrame(columns=["ts", "predicted", "low", "high", "simple_guess", "is_spike", "reasons"])
    rows = []
    for h, X in parts:
        X = X[X.building_id == building_id]
        pred = np.maximum(bundle["models"][stream, h].predict(X[FEATURES]), 0)  # night water came out at about -5 L
        q = bundle["band"].loc[stream, h, building_id]
        rows.append(X.assign(h=h, predicted=pred, high=np.maximum(pred + q.q90, pred),
                             low=np.minimum(np.maximum(pred + q.q10, 0), pred)))
    X = pd.concat(rows)
    typical, spike = bundle["typical"][stream], bundle["spike"][stream]
    mean_typical = np.mean([typical[building_id, hr] for hr in range(24)])
    cal = calendar().set_index("date")
    reasons = [_reasons(r, typical, mean_typical, bundle["temp_mean"], cal.event.get(r.ts.normalize()) if r.is_event else "")
               for r in X.itertuples()]
    out = pd.DataFrame({
        "ts": X.ts, "predicted": X.predicted, "low": X.low, "high": X.high, "simple_guess": X.lag24,
        "is_spike": X.predicted.values >= [spike[building_id, hr] for hr in X.hour], "reasons": reasons,
    }).reset_index(drop=True)
    out.attrs.update(in_sample=bool(as_of < TEST_START), model_trained_until=bundle["trained_until"], newest_reading=t0)
    return out


# ---------- forecast_metrics(): reads what eval_forecast.py (ours) and P2's Chronos run wrote, computes nothing ----------

METRIC_COLS = ["method", "stream", "horizon", "error_normal_days", "error_exam_days", "error_normal_pct", "error_exam_pct",
               "spikes_caught", "spikes_total", "false_alarms", "size_kb", "train_s", "time_ms"]
DAILY_COLS = ["date", "day_type", "stream", "horizon", "method", "mae", "pct"]


def _read_metrics(key, cols):
    """`key` lists from every metrics file that exists and parses; otherwise an empty frame. Never raises."""
    rows = []
    for name in ["forecast_metrics.json", "chronos_metrics.json"]:
        try:
            rows += json.loads((MODELS / name).read_text())[key]
        except (OSError, ValueError, KeyError, TypeError):  # missing, half-written, or not the expected shape
            pass
    df = pd.DataFrame(rows)
    return df.reindex(columns=cols + [c for c in df if c not in cols])


def forecast_metrics():
    """One row per method x stream x horizon: errors on normal and exam days, spikes caught, size, time."""
    return _read_metrics("rows", METRIC_COLS)


def forecast_daily_errors():
    """One row per test day x method x stream x horizon, for the drift chart."""
    d = _read_metrics("daily", DAILY_COLS)
    return d.assign(date=pd.to_datetime(d.date))


# ---------- self-check: python forecast.py ----------

def _check_no_leakage(cases, as_of):
    """Multiply every reading received after as_of by 10: no forecast may change."""
    global _deduped_hourly
    real = _deduped_hourly
    shaken = real().copy()
    shaken.loc[shaken.received_at > as_of, STREAMS] *= 10
    runs = []
    try:
        for source in (real, lambda: shaken):
            _deduped_hourly = source
            _live.cache_clear()  # the cache would hand back the first run's features
            runs.append([forecast(b, s, as_of) for b, s in cases])
    finally:
        _deduped_hourly = real
        _live.cache_clear()
    for before, after in zip(*runs):
        pd.testing.assert_frame_equal(before, after)


def _check_metrics_files():
    """Empty frames without files; rows from both files with them (fake files in a temp dir)."""
    global MODELS
    real = MODELS
    with tempfile.TemporaryDirectory() as tmp:
        MODELS = Path(tmp)
        try:
            m = forecast_metrics()
            assert m.empty and list(m.columns) == METRIC_COLS
            assert forecast_daily_errors().empty and list(forecast_daily_errors().columns) == DAILY_COLS
            row = dict.fromkeys(METRIC_COLS, 1) | {"method": "our model"}
            day = dict.fromkeys(DAILY_COLS, 1) | {"date": "2026-09-28", "method": "our model"}
            (MODELS / "forecast_metrics.json").write_text(json.dumps({"rows": [row], "daily": [day]}))
            (MODELS / "chronos_metrics.json").write_text(json.dumps({"rows": [row | {"method": "Chronos-2"}]}))
            m = forecast_metrics()
            assert list(m.method) == ["our model", "Chronos-2"] and list(m.columns) == METRIC_COLS
            d = forecast_daily_errors()
            assert len(d) == 1 and d.date.iloc[0] == pd.Timestamp("2026-09-28")
            (MODELS / "forecast_metrics.json").write_text('{"rows": [')  # half-written file
            assert list(forecast_metrics().method) == ["Chronos-2"]
        finally:
            MODELS = real


def _self_check():
    cols = ["ts", "predicted", "low", "high", "simple_guess", "is_spike", "reasons"]
    cases = [("B05", "water_litres"), ("B03", "electricity_kwh")]
    as_of = pd.Timestamp("2026-09-29 18:00")  # exam week
    newest = hourly(as_of).ts.max()
    for b, s in cases:
        for horizon in (12, 9, 6, 3):
            f = forecast(b, s, as_of, horizon)
            assert list(f.columns) == cols and len(f) == horizon, (b, s, horizon)
            assert (f.low <= f.predicted).all() and (f.predicted <= f.high).all() and (f.low >= 0).all()
            assert f.predicted.notna().all() and f.reasons.str.len().gt(0).all()
            assert (f.ts == newest + pd.to_timedelta(range(1, horizon + 1), unit="h")).all()
            assert f.attrs["model_trained_until"] <= as_of and f.attrs["in_sample"] is False
    print("ok  forecast() returns `horizon` rows with exactly the right columns, 0 <= low <= predicted <= high")
    print(f"ok  newest reading {newest}; targets start 1 h later; bundle trained_until {f.attrs['model_trained_until']} <= as_of")
    early = forecast("B05", "water_litres", "2026-09-01 12:00")
    late = forecast("B05", "water_litres", "2026-10-20 12:00")
    assert early.attrs["in_sample"] and early.attrs["model_trained_until"] == TEST_START
    assert not late.attrs["in_sample"] and late.attrs["model_trained_until"] == RETRAIN_DAYS[-1]
    print("ok  as_of before the first retrain day: in_sample=True; after the last: newest bundle, in_sample=False")
    exam = forecast("B05", "electricity_kwh", "2026-10-06 08:00")
    assert exam.reasons.str.contains("exam").all(), exam.reasons.tolist()
    print(f"ok  exam day reasons: {exam.reasons.iloc[0]!r}")
    _check_no_leakage(cases, as_of)
    print("ok  no leakage: readings received after as_of multiplied by 10 leave both forecasts identical")
    _check_metrics_files()
    print("ok  forecast_metrics / forecast_daily_errors: empty without files, both files read, half-written file ignored")
    flags = [forecast(b, "electricity_kwh", "2026-10-06 08:00").is_spike for b in BUILDINGS]
    assert all(f.dtype == bool for f in flags)
    spikes = sum(f.sum() for f in flags)
    print(f"ok  is_spike is a bool column ({spikes} spike hours across 8 buildings, electricity, 2026-10-06 08:00)")
    grid = pd.date_range("2026-10-06 09:00", periods=3, freq="3h")  # a fresh as_of per slider move
    slow = []
    for t in grid:
        start = time.perf_counter()
        for b in BUILDINGS:
            for s in STREAMS:
                forecast(b, s, t)
        slow.append((time.perf_counter() - start) / 16 * 1000)
    _live.cache_clear()
    start = time.perf_counter()
    forecast("B05", "water_litres", grid[0])
    cold = (time.perf_counter() - start) * 1000
    print(f"ok  speed: {np.mean(slow):.0f} ms per call over a slider move (8 buildings x 2 streams); "
          f"{cold:.0f} ms for a lone call with cold features")


if __name__ == "__main__":
    train_all() if sys.argv[1:2] == ["train"] else _self_check()
