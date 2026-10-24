"""
Builds the frontend's mock fixtures from the P2P dataset (read-only) into public/mock/.

Field names follow the team brief exactly, so the mock layer in src/api/mock.ts returns
the same shapes the real Python functions will. Run from frontend/:  npm run fixtures
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

_ROOT = Path(__file__).resolve().parents[2]
# datasets/raw after the repo refactor; P2P_DATASET in older checkouts
DATA = next(p for p in (_ROOT / "datasets" / "raw", _ROOT / "P2P_DATASET") if p.exists())
OUT = Path(__file__).resolve().parents[1] / "public" / "mock"
OUT.mkdir(parents=True, exist_ok=True)

FEATURES = ["weight_g", "moisture_pct", "metal_signal", "transparency", "acoustic_hardness"]
CLASSES = ["food_organic", "paper_cardboard", "plastic", "glass", "metal", "ewaste"]
MAX_FILL_GAP_H = 2  # gaps up to this long are interpolated ("filled"); longer stay "missing"

ALIASES = {
    "B01": ["b01", "block a", "academic block a", "acad block a"],
    "B02": ["b02", "block b", "academic block b", "acad block b"],
    "B03": ["b03", "central library", "central lib", "library"],
    "B04": ["b04", "engineering labs & innovation centre", "labs", "eng labs", "innovation centre"],
    "B05": ["b05", "boys hostel", "bh", "boys hostle"],
    "B06": ["b06", "girls hostel", "gh", "girls hostle"],
    "B07": ["b07", "food court", "canteen", "fc"],
    "B08": ["b08", "admin block", "admin"],
}
ALIAS_MAP = {a: b for b, names in ALIASES.items() for a in names}


def write(name, obj):
    (OUT / name).write_text(json.dumps(obj, separators=(",", ":"), allow_nan=False))


def records(df):
    return json.loads(df.to_json(orient="records"))


def hourly():
    h = pd.read_excel(DATA / "hourly_streams.xlsx")
    h["timestamp"] = pd.to_datetime(h["timestamp"])
    h["received_at"] = pd.to_datetime(h["received_at"])
    # deterministic dedupe of retransmissions: the first-received copy wins
    h = h.sort_values("received_at").drop_duplicates(["building_id", "timestamp"], keep="first")
    grid = pd.MultiIndex.from_product(
        [sorted(h.building_id.unique()), pd.date_range("2026-06-20 00:00", "2026-10-17 23:00", freq="h")],
        names=["building_id", "timestamp"],
    ).to_frame(index=False)
    h = grid.merge(h, on=["building_id", "timestamp"], how="left").sort_values(["building_id", "timestamp"])
    cols = ["electricity_kwh", "water_litres", "solar_generation_kwh", "footfall"]
    out = []
    for b, g in h.groupby("building_id"):
        g = g.copy()
        gap = g["electricity_kwh"].isna() | g["water_litres"].isna()
        run_id = (gap != gap.shift()).cumsum()
        run_len = gap.groupby(run_id).transform("sum")
        filled = gap & (run_len <= MAX_FILL_GAP_H)
        for c in cols:
            g[c] = g[c].interpolate(limit_area="inside")
            g.loc[gap & ~filled, c] = np.nan
        g["quality"] = np.where(~gap, "real", np.where(filled, "filled", "missing"))
        out.append(g)
    h = pd.concat(out)
    h = h.rename(columns={"timestamp": "ts", "solar_generation_kwh": "solar_kwh"})
    h["ts"] = h.ts.dt.strftime("%Y-%m-%d %H:%M")
    h["received_at"] = h.received_at.dt.strftime("%Y-%m-%d %H:%M")
    for c in ["electricity_kwh", "solar_kwh"]:
        h[c] = h[c].round(2)
    h["water_litres"] = h["water_litres"].round(0)
    h["footfall"] = h["footfall"].round(0)
    keep = ["building_id", "ts", "electricity_kwh", "water_litres", "solar_kwh", "footfall", "quality", "received_at"]
    print("hourly quality:", h.quality.value_counts().to_dict())
    return records(h[keep])


def manual_logs():
    m = pd.read_excel(DATA / "manual_logs.xlsx")
    m["building_id"] = m.building.str.strip().str.lower().map(ALIAS_MAP)
    assert m.building_id.notna().all(), m[m.building_id.isna()].building.unique()
    m = m.rename(columns={"logged_at": "ts"})
    return records(m[["ts", "building_id", "stream", "value", "unit", "note", "logger_role", "building"]])


def classifier():
    """Gaussian naive Bayes, so the browser can run the exact same model as the mock `predict()`."""
    d = pd.read_excel(DATA / "waste_events_train.xlsx").sample(frac=1, random_state=7)
    cut = int(len(d) * 0.8)
    tr, te = d.iloc[:cut], d.iloc[cut:]
    model = {"classes": CLASSES, "features": FEATURES, "priors": [], "mean": [], "var": []}
    for c in CLASSES:
        x = tr[tr.category == c][FEATURES]
        model["priors"].append(float(len(x) / len(tr)))
        model["mean"].append([float(v) for v in x.mean()])
        model["var"].append([float(v) + 1e-3 for v in x.var()])

    def predict(row):
        logp = []
        for i in range(len(CLASSES)):
            lp = np.log(model["priors"][i])
            for j, f in enumerate(FEATURES):
                v = row[f]
                if pd.isna(v):
                    continue  # NB marginalises missing sensors for free
                mu, var = model["mean"][i][j], model["var"][i][j]
                lp += -0.5 * np.log(2 * np.pi * var) - (v - mu) ** 2 / (2 * var)
            logp.append(lp)
        return CLASSES[int(np.argmax(logp))]

    pred = te.apply(predict, axis=1)
    conf = [[int(((te.category == a) & (pred == p)).sum()) for p in CLASSES] for a in CLASSES]
    f1s = []
    for i, c in enumerate(CLASSES):
        tp = conf[i][i]
        fp = sum(conf[r][i] for r in range(6)) - tp
        fn = sum(conf[i]) - tp
        f1s.append(2 * tp / max(1, 2 * tp + fp + fn))
    metrics = {
        "accuracy": round(float((pred == te.category).mean()), 4),
        "macro_f1": round(float(np.mean(f1s)), 4),
        "confusion": conf,
        "class_names": CLASSES,
        "size_kb": round(len(json.dumps(model)) / 1024, 1),
        "time_ms": 0.05,
        "model_name": "Gaussian naive Bayes (mock stand-in)",
    }
    print("mock classifier:", metrics["accuracy"], metrics["macro_f1"])
    return model, metrics


def main():
    b = pd.read_excel(DATA / "buildings.xlsx")
    write("buildings.json", records(b))

    cal = pd.read_excel(DATA / "calendar.xlsx")
    cal["date"] = pd.to_datetime(cal.date).dt.strftime("%Y-%m-%d")
    write("calendar.json", records(cal))

    daily = pd.read_excel(DATA / "daily_summary.xlsx")
    daily["date"] = pd.to_datetime(daily.date).dt.strftime("%Y-%m-%d")
    write("daily.json", records(daily))

    write("hourly.json", hourly())
    write("manual_logs.json", manual_logs())

    ev = pd.read_excel(DATA / "waste_events_test.xlsx")
    ev["timestamp"] = pd.to_datetime(ev.timestamp).dt.strftime("%Y-%m-%d %H:%M:%S")
    write("bin_events.json", records(ev.sort_values("timestamp")))

    model, metrics = classifier()
    write("classifier_model.json", model)
    write("classifier_metrics.json", metrics)
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:28s} {f.stat().st_size / 1024:8.1f} KB")


if __name__ == "__main__":
    main()
