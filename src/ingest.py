"""P3: load, clean and fuse the campus data. Every other module reads data through here."""
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "datasets" / "raw"
BUILDINGS = [f"B0{i}" for i in range(1, 9)]
STREAMS = ["electricity_kwh", "water_litres", "solar_kwh", "footfall"]

# Every spelling of a building found in manual_logs.csv (37 raw spellings, lower-cased here).
ALIASES = {
    "B01": ["academic block a", "acad block a", "block a"],
    "B02": ["academic block b", "acad block b", "block b"],
    "B03": ["central library", "central lib", "library"],
    "B04": ["engineering labs & innovation centre", "eng labs", "labs", "innovation centre"],
    "B05": ["boys hostel", "boys hostle", "bh"],
    "B06": ["girls hostel", "girls hostle", "gh"],
    "B07": ["food court", "canteen", "fc"],
    "B08": ["admin block", "admin"],
}
ALIAS_TO_ID = {a: b for b, names in ALIASES.items() for a in names + [b.lower()]}
# raw unit -> (factor, standard unit). 1 unit = 1 kWh, 1 kL = 1,000 L, 1 bag = 8 kg (README section 5).
UNITS = {"kWh": (1, "kWh"), "units": (1, "kWh"), "L": (1, "L"), "kL": (1000, "L"), "kg": (1, "kg"), "bags": (8, "kg")}


@lru_cache(maxsize=1)
def _read(name, dates=()):
    return pd.read_csv(DATA / name, parse_dates=list(dates))


def load_buildings():
    return _read("buildings.csv").copy()


def load_calendar():
    return _read("calendar.csv", ("date",)).copy()


def load_daily():
    return _read("daily_summary.csv", ("date",)).copy()


def load_manual_logs():
    """ts, building_id, stream, value, unit, note, role, plus the raw fields so the UI can show before/after.
    An unknown spelling leaves building_id empty (shown as an alert) instead of guessing a building."""
    m = _read("manual_logs.csv", ("logged_at",))
    conv = m.unit.map(UNITS)
    return pd.DataFrame({
        "ts": m.logged_at,
        "building_id": m.building.str.strip().str.lower().map(ALIAS_TO_ID),
        "stream": m.stream,
        "value": m.value * conv.str[0],
        "unit": conv.str[1],
        "note": m.note,
        "role": m.logger_role,
        "log_id": m.log_id,
        "building_raw": m.building,
        "value_raw": m.value,
        "unit_raw": m.unit,
    })



LATE = pd.Timedelta(hours=2)  # lag above this = a buffered reading that arrived in a burst; offline = no reading for this long


@lru_cache(maxsize=1)
def _deduped():
    """Raw hourly readings, one row per (building_id, ts): the earliest received_at wins, retransmissions are dropped.
    Columns: ts, received_at, building_id + the 4 streams. Cached, do not mutate."""
    df = _read("hourly_streams.csv", ("timestamp", "received_at"))
    df = df.rename(columns={"timestamp": "ts", "solar_generation_kwh": "solar_kwh"})
    df = df.sort_values("received_at", kind="stable").drop_duplicates(["building_id", "ts"])
    return df.sort_values(["ts", "building_id"]).reset_index(drop=True)


@lru_cache(maxsize=1)
def _base():
    """The whole period on the full building x hour grid, built once. Per row: the clean value of each stream
    (real, or filled), est_<stream> (typical profile), known_at (when the server can show it), late, filled.
    Sorted by ts then building_id so load_hourly can slice by time."""
    cal = load_calendar()
    hours = pd.date_range(cal.date.min(), cal.date.max() + pd.Timedelta(hours=23), freq="h")
    g = pd.MultiIndex.from_product([BUILDINGS, hours], names=["building_id", "ts"]).to_frame(index=False)
    g = g.merge(_deduped(), on=["building_id", "ts"], how="left")
    g["date"] = g.ts.dt.normalize()
    late = g.received_at - g.ts > LATE
    # ponytail: profile = median over the whole period (leaks the future); fine for display, P1 never trains on filled/estimated rows
    key = [g.building_id, g.ts.dt.hour, g.date.map(cal.set_index("date").day_type)]
    prof = g[STREAMS].groupby(key).transform("median")

    # a lost hour is missing in all 4 streams, a sensor dropout (NaN cell in a real row) in one; gaps are runs per building and stream
    miss = g[STREAMS].isna()
    m = miss.values
    start = np.vstack([np.ones((1, 4), bool), m[1:] != m[:-1]]) | (g.building_id != g.building_id.shift()).values[:, None]
    run = start.cumsum(axis=0)
    size = np.column_stack([np.bincount(r)[r] for r in run.T])
    long = pd.DataFrame(m & (size > 3), columns=STREAMS)
    short = miss & ~long
    # short gaps: straight line between the neighbouring real readings
    # ponytail: a short gap touching the period edge has no neighbour and stays NaN; none in this data (self-check asserts no NaN)
    lin = g[STREAMS].groupby(g.building_id).transform(lambda s: s.interpolate(limit_area="inside"))
    v = g[STREAMS].mask(short, lin)

    # long gaps: the day's remaining total (daily_summary minus what we have) spread over the missing hours by the profile
    daily = load_daily().rename(columns={"solar_generation_kwh": "solar_kwh"})
    tot = g[["building_id", "date"]].merge(daily, on=["building_id", "date"], how="left").reindex(columns=STREAMS)  # footfall: NaN
    day = [g.building_id, g.date]
    rem = tot - v.groupby(day).transform("sum")
    w = prof.where(long, 0)
    share = w.div(w.groupby(day).transform("sum"))  # NaN where the profile sums to 0
    fill = (rem * share).where((rem > 0) & share.notna(), prof)  # else the typical value
    v = v.mask(long, fill)

    filled = miss.any(axis=1)
    nxt = g.received_at.where(~filled).groupby(g.building_id).bfill()  # clean row: its own arrival; else when the next clean reading arrived
    known_at = nxt.mask(long.any(axis=1), np.maximum(nxt, g.date + pd.Timedelta(days=1)))  # a daily total is only known once the day closes
    b = pd.concat([g[["building_id", "ts"]], v, prof.add_prefix("est_"), pd.DataFrame({"known_at": known_at, "late": late, "filled": filled})], axis=1)
    return b.sort_values(["ts", "building_id"]).reset_index(drop=True)


def load_hourly(as_of=None):
    """building_id, ts, electricity_kwh, water_litres, solar_kwh, footfall, status, one row per building-hour up to as_of.
    status: measured, revised (late reading arrived), filled (lost hour with the gap known, or a row with a NaN cell: any value filled in), estimated (not here yet: typical profile)."""
    return _hourly(None if as_of is None else pd.Timestamp(as_of)).copy()


@lru_cache(maxsize=4)  # the dashboard asks 16 times per slider move with the same as_of
def _hourly(as_of):
    b = _base()
    n = len(b) if as_of is None else b.ts.searchsorted(pd.Timestamp(as_of), side="right")
    b = b.iloc[:n]
    known = np.ones(n, bool) if as_of is None else (b.known_at <= as_of).values
    status = np.select([~known, b.filled.values, b.late.values], ["estimated", "filled", "revised"], "measured")
    vals = {c: np.where(known, b[c].values, b["est_" + c].values) for c in STREAMS}
    return pd.DataFrame({"building_id": b.building_id.values, "ts": b.ts.values, **vals, "status": status})


def building_status(as_of=None):
    """building_id, last_reading_ts, offline, since. offline: nothing received for over 2 h; since: when the data stopped.
    as_of=None: the moment the last reading arrived."""
    d = _deduped()
    t = d.received_at.max() if as_of is None else pd.Timestamp(as_of)
    last = d[d.received_at <= t].groupby("building_id").ts.max().reindex(BUILDINGS)
    offline = (last < t.floor("h") - LATE).values
    return pd.DataFrame({"building_id": BUILDINGS, "last_reading_ts": last.values, "offline": offline,
                         "since": (last + pd.Timedelta(hours=1)).where(offline).values})


def _selfcheck_logs():
    logs = load_manual_logs()
    assert logs.building_id.notna().all(), logs[logs.building_id.isna()].building_raw.unique()
    assert set(logs.unit.dropna()) == {"kWh", "L", "kg"}
    raw = _read("manual_logs.csv")
    assert logs.loc[raw.unit == "kL", "value"].equals(raw.loc[raw.unit == "kL", "value"] * 1000)
    assert logs.loc[raw.unit == "bags", "value"].equals(raw.loc[raw.unit == "bags", "value"] * 8)
    print(f"manual logs ok: {raw.building.nunique()} spellings -> {logs.building_id.nunique()} buildings")


def _selfcheck_hourly():
    import time
    h, d, keys = load_hourly(), _deduped(), ["building_id", "ts"]
    hi = h.set_index(keys)
    # 1. shape, counts: filled = lost hours + rows with a NaN cell; revised = late real rows
    assert list(h.columns) == keys + STREAMS + ["status"] and len(h) == 23040 and len(d) == 23008
    assert len(_read("hourly_streams.csv")) == 23192 and not hi.index.duplicated().any()
    assert h.equals(h.sort_values(["ts", "building_id"]).reset_index(drop=True)) and not h[STREAMS].isna().any().any()
    lost = ~hi.index.isin(d.set_index(keys).index)
    nan_rows = d[STREAMS].isna().any(axis=1).sum()
    n_late = ((d.received_at - d.ts) > LATE).sum()
    st = h.status.value_counts().to_dict()
    assert lost.sum() == 32 and nan_rows == 205 and st == {"measured": 23040 - 237 - n_late, "revised": n_late, "filled": 32 + nan_rows}, st
    # gaps of lost hours per building: lengths, short ones lie between neighbours, long ones add up to the daily total
    dl = load_daily().set_index(["building_id", "date"]).electricity_kwh
    gaps, fallback = [], 0
    lost = pd.Series(lost, index=hi.index)
    for b, s in hi.electricity_kwh.groupby(level=0):
        s, m = s.droplevel(0), lost[b]
        for _, r in s[m].groupby((m != m.shift()).cumsum()[m]):
            gaps.append(len(r))
            t0, t1 = r.index[0], r.index[-1]
            assert (r > 0).all()  # 2. never a fake zero
            if len(r) <= 3:
                a, z = s[t0 - pd.Timedelta(hours=1)], s[t1 + pd.Timedelta(hours=1)]
                assert r.between(min(a, z) - 1e-9, max(a, z) + 1e-9).all()
            else:
                for day in pd.date_range(t0.normalize(), t1.normalize()):  # 3. the day adds up to daily_summary
                    x, gm = s[s.index.normalize() == day], m[s.index.normalize() == day]
                    if dl[b, day] - x[~gm].sum() > 0:
                        assert abs(x.sum() - dl[b, day]) < 0.01, (b, day)
                    else:
                        fallback += 1
    assert sorted(gaps) == [1, 2, 4, 4, 7, 7, 7], gaps
    # 4. P1 compatibility: measured+revised = the clean deduped rows received by as_of, same values
    clean = d[~d[STREAMS].isna().any(axis=1)]
    for t in [None, "2026-08-12 06:00", "2026-10-01 06:00"]:
        x = load_hourly(t)
        x = x[x.status.isin(["measured", "revised"])].set_index(keys)[STREAMS].sort_index()
        ref = (clean if t is None else clean[clean.received_at <= pd.Timestamp(t)]).set_index(keys)[STREAMS].sort_index()
        pd.testing.assert_frame_equal(x, ref, check_exact=True)
    # 5. replay of the B03 outage
    burst = lambda x: x[(x.building_id == "B03") & x.ts.between("2026-09-30 21:00", "2026-10-01 06:00")]
    x = load_hourly("2026-10-01 06:00")
    s = building_status("2026-10-01 06:00").set_index("building_id")
    assert len(burst(x)) == 10 and (burst(x).status == "estimated").all()
    assert s.offline["B03"] and s.since["B03"] == pd.Timestamp("2026-09-30 21:00")
    x = load_hourly("2026-10-01 10:00")
    assert (burst(x).status == "revised").all() and not building_status("2026-10-01 10:00").set_index("building_id").offline["B03"]
    # 6. speed
    load_hourly("2026-10-17 12:00")
    t0 = time.perf_counter()
    for _ in range(16):
        x = load_hourly("2026-10-17 12:00")
    ms = (time.perf_counter() - t0) / 16 * 1000
    assert ms < 20, ms
    # 7. no double counting, and every call returns a fresh frame
    assert x.electricity_kwh.sum() == x.drop_duplicates(keys).electricity_kwh.sum()
    x["electricity_kwh"] = 0.0
    assert load_hourly("2026-10-17 12:00").electricity_kwh.sum() > 0
    print(f"hourly ok: {len(h)} rows {st}, long-gap days on fallback {fallback}, {ms:.1f} ms per load_hourly call")


if __name__ == "__main__":
    _selfcheck_logs()
    _selfcheck_hourly()
