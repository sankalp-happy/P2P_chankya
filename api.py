"""P3: FastAPI backend for the React UI (frontend/CONTRACT.md, frontend/src/api/types.ts).
Wraps everyone's functions; all field mapping lives here. Run: uvicorn api:app --port 8000"""
import json
import math
from contextlib import asynccontextmanager
from functools import lru_cache

import pandas as pd
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel

import attribution
import edge_buffer
import forecast
import incentives
import ingest

TS = "%Y-%m-%d %H:%M"
STREAM = {"electricity": "electricity_kwh", "water": "water_litres"}  # UI name -> data column
UI_STREAM = {v: k for k, v in STREAM.items()}
QUALITY = {"measured": "real", "revised": "real", "filled": "filled", "estimated": "missing"}


def _records(df, dates=(), stamps=()):
    """DataFrame -> JSON bytes: dates as YYYY-MM-DD, stamps as YYYY-MM-DD HH:MM, NaN/NaT as null."""
    df = df.copy()
    for c in dates:
        df[c] = df[c].dt.strftime("%Y-%m-%d")
    for c in stamps:
        df[c] = pd.to_datetime(df[c]).dt.strftime(TS)
    return df.to_json(orient="records").encode()


def _json(body):
    return Response(body, media_type="application/json")


def _clean(x):
    """NaN -> None, numpy/pandas scalars -> Python, recursively, for dict/list payloads."""
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    if isinstance(x, pd.Timestamp):
        return None if pd.isna(x) else x.strftime(TS)
    if hasattr(x, "item"):
        x = x.item()
    return None if isinstance(x, float) and math.isnan(x) else x


def _classifier():
    """P2's module, imported on first use so a broken or half-edited classifier only fails its own two routes."""
    try:
        from src import classifier
        return classifier
    except Exception as e:  # noqa: BLE001  (any import error: syntax, missing model file)
        raise HTTPException(503, f"classifier unavailable: {type(e).__name__}: {e}")


def _stream(s):
    if s not in STREAM:
        raise HTTPException(400, f"stream must be one of {list(STREAM)}")
    return STREAM[s]


# ---------- static data, built once ----------

@lru_cache(maxsize=None)
def _static(name):
    if name == "buildings":
        return _records(ingest.load_buildings())
    if name == "calendar":
        return _records(ingest.load_calendar(), dates=["date"])
    if name == "bin-events":
        return _records(pd.read_csv(ingest.DATA / "waste_events_test.csv"))  # timestamp kept as the raw string
    if name == "daily":
        return _records(ingest.load_daily(), dates=["date"])
    if name == "manual-logs":
        m = ingest.load_manual_logs().rename(columns={"role": "logger_role", "building_raw": "building"})
        return _records(m, stamps=["ts"])
    if name == "hourly":
        # The UI replays client-side from received_at, so send the full clean period once.
        # received_at = when the server could show the value: a real reading's arrival, or for a filled hour the moment
        # the gap was known (next reading arrived; long gaps after the day closed). So lost hours also replay as offline.
        known = ingest._base()[["building_id", "ts", "known_at"]].rename(columns={"known_at": "received_at"})
        h = ingest.load_hourly().merge(known, on=["building_id", "ts"], how="left")
        h["quality"] = h.status.map(QUALITY)
        return _records(h, stamps=["ts", "received_at"])
    if name == "outages":
        return _records(edge_buffer.outage_table(), stamps=["start", "end"])
    if name == "classifier-metrics":
        m = _classifier().classifier_metrics()
        if not isinstance(m, dict):  # P2's tuple: (accuracy, macro_f1, confusion, classes, size_kb, time_ms)
            m = dict(zip(["accuracy", "macro_f1", "confusion", "classes", "size_kb", "time_ms"], m))
        m = {**m, "class_names": m.get("class_names", m.get("classes"))}
        return json.dumps(_clean(m)).encode()
    if name == "forecast-metrics":
        # One number per method for the Models page: mean of the normal-day % error at 12 h over both streams.
        f = forecast.forecast_metrics()
        f = f[f.horizon == 12].groupby("method", sort=False)
        out = pd.DataFrame({"error": f.error_normal_pct.mean(), "error_exam": f.error_exam_pct.mean(),
                            "size_kb": f.size_kb.mean(), "time_ms": f.time_ms.mean()}).round(2).reset_index()
        return out.to_json(orient="records").encode()
    raise KeyError(name)


def _warm():
    for name in ["buildings", "calendar", "bin-events", "daily", "manual-logs", "hourly", "outages", "forecast-metrics"]:
        _static(name)
    try:
        _static("classifier-metrics")  # loads P2's model at startup when it imports
    except HTTPException:
        pass


@asynccontextmanager
async def _lifespan(app):
    _warm()  # build the cached JSON and load the models before the first request
    yield


app = FastAPI(title="Campus Resource Grid API", lifespan=_lifespan)


@app.get("/api/buildings")
def buildings():
    return _json(_static("buildings"))


@app.get("/api/calendar")
def calendar():
    return _json(_static("calendar"))


@app.get("/api/bin-events")
def bin_events():
    return _json(_static("bin-events"))


@app.get("/api/hourly")
def hourly():
    return _json(_static("hourly"))


@app.get("/api/daily")
def daily():
    return _json(_static("daily"))


@app.get("/api/manual-logs")
def manual_logs():
    return _json(_static("manual-logs"))


@app.get("/api/outages")
def outages():
    return _json(_static("outages"))


@app.get("/api/classifier-metrics")
def classifier_metrics():
    return _json(_static("classifier-metrics"))


@app.get("/api/forecast-metrics")
def forecast_metrics():
    return _json(_static("forecast-metrics"))


# ---------- per slider position ----------

@lru_cache(maxsize=256)
def _forecast(building_id, stream, as_of, horizon):
    f = forecast.forecast(building_id, stream, as_of, horizon)
    return _records(f[["ts", "predicted", "low", "high", "is_spike", "simple_guess", "reasons"]], stamps=["ts"])


@app.get("/api/forecast")
def get_forecast(building_id: str, stream: str, as_of: str, horizon: int = 12):
    if building_id not in ingest.BUILDINGS:
        raise HTTPException(400, f"unknown building_id {building_id}")
    return _json(_forecast(building_id, _stream(stream), as_of, horizon))


@lru_cache(maxsize=1)
def _walkforward():
    w = pd.read_csv(forecast.MODELS / "walkforward_predictions.csv", parse_dates=["ts"])
    return w[w.horizon == 12]


@app.get("/api/forecast-history")
def forecast_history(building_id: str, stream: str, start: str, end: str):
    """Our model's 12 h-ahead walk-forward predictions (test window 28 Sep - 17 Oct only; empty before)."""
    w = _walkforward()
    w = w[(w.building_id == building_id) & (w.stream == _stream(stream)) & w.ts.between(pd.Timestamp(start), pd.Timestamp(end))]
    return _json(_records(w[["ts", "our_model"]].rename(columns={"our_model": "predicted"}), stamps=["ts"]))


@lru_cache(maxsize=64)
def _recommend(as_of, top):
    out = []
    for r in attribution.recommend(as_of, top):
        r = {**r, "metric": r.get("stream"), "stream": UI_STREAM.get(r.get("stream")),  # null for solar_kwh / landfill_kg
             "cause_label": attribution.CAUSE_TEXT.get(r["cause"], r["cause"]),
             "evidence": [f"{fact} (+{pts})" for fact, pts in r.get("evidence", [])],
             "runner_up_evidence": [f"{fact} (+{pts})" for fact, pts in r.get("runner_up_evidence", [])]}
        out.append(_clean(r))
    return json.dumps(out).encode()


@app.get("/api/recommend")
def recommend(as_of: str, top: int = 5):
    return _json(_recommend(as_of, top))


@lru_cache(maxsize=64)
def _leaderboard(as_of):
    lb = incentives.leaderboard(as_of)
    return _records(lb, dates=[c for c in ["week_start", "week_end"] if pd.api.types.is_datetime64_any_dtype(lb[c])])


@app.get("/api/leaderboard")
def leaderboard(as_of: str):
    return _json(_leaderboard(as_of))


# ---------- actions ----------

class OutageRequest(BaseModel):
    building_id: str
    start_ts: str
    hours: int


@app.post("/api/outage")
def outage(req: OutageRequest):
    try:
        return _clean(edge_buffer.simulate_outage(req.building_id, req.start_ts, req.hours))
    except ValueError as e:
        raise HTTPException(400, str(e))


@app.post("/api/predict")
def predict(event: dict):
    p = _classifier().predict(event)
    if not isinstance(p, dict):  # P2's tuple: (label, confidence, time_ms, route)
        p = dict(zip(["label", "confidence", "time_ms", "route"], p))
    return _clean(p)


# ---------- alerts: one list for the facility alerts panel ----------

@lru_cache(maxsize=64)
def _alerts(as_of):
    t = pd.Timestamp(as_of)
    out = []
    for r in ingest.building_status(t).query("offline").itertuples():
        out.append({"kind": "offline", "building_id": r.building_id, "ts": r.since.strftime(TS),
                    "title": f"Offline since {r.since:%H:%M}, showing estimate",
                    "detail": f"last reading {r.last_reading_ts:%d %b %H:%M}; buffered readings replace the estimate on reconnect"})
    a = attribution.anomalies(t, 24)
    for r in a.head(20).itertuples():
        out.append({"kind": "anomaly", "building_id": r.building_id, "ts": r.ts.strftime(TS),
                    "title": f"{UI_STREAM.get(r.stream, r.stream)}: {r.unusual}",
                    "detail": f"actual {r.actual:g} vs expected {r.expected:g} ({r.kind})"})
    sc = edge_buffer.source_check()
    sc = sc[sc.disagrees & (sc.date >= t.normalize() - pd.Timedelta(days=7)) & (sc.date < t.normalize())]
    for r in sc.itertuples():
        out.append({"kind": "source_mismatch", "building_id": r.building_id, "ts": r.date.strftime(TS),
                    "title": f"{r.stream}: sources disagree by {r.pct_diff:g}%", "detail": r.detail or f"trusted: {r.trusted_source}"})
    return json.dumps(_clean(sorted(out, key=lambda x: x["ts"], reverse=True))).encode()


@app.get("/api/alerts")
def alerts(as_of: str):
    """kind offline | anomaly | source_mismatch; e-waste and unsure bin items come from /api/predict per event."""
    return _json(_alerts(as_of))
