"""P3: buildings going offline (real outages, a simulated outage with a local SQLite buffer) and cross-checks between sources."""
import sqlite3
from functools import lru_cache

import numpy as np
import pandas as pd

from ingest import BUILDINGS, LATE, STREAMS, DATA, _deduped, load_daily, load_hourly, load_manual_logs


# ---------- outages: outage_table() and simulate_outage() ----------

TABLE = "CREATE TABLE {} (building_id TEXT, stream TEXT, ts TEXT, value REAL, PRIMARY KEY (building_id, stream, ts))"


@lru_cache(maxsize=1)
def _outages():
    d = _deduped()
    # ponytail: grid ends at the last reading seen, so hours lost after it would be missed
    grid = pd.MultiIndex.from_product([BUILDINGS, pd.date_range(d.ts.min(), d.ts.max(), freq="h")], names=["building_id", "ts"])
    recv = d.set_index(["building_id", "ts"]).received_at.reindex(grid)
    g = recv.reset_index()
    g["late"] = g.received_at - g.ts > LATE
    g["lost"] = g.received_at.isna()
    hit = g.late | g.lost
    g["run"] = (hit & ~(hit.shift(fill_value=False) & (g.building_id == g.building_id.shift()))).cumsum()
    runs = g[hit].groupby("run").agg(building_id=("building_id", "first"), start=("ts", "min"), last=("ts", "max"),
                                     end=("received_at", "max"), arrived_late=("late", "sum"), lost=("lost", "sum"))
    # no late rows in the run: data flow resumed at the next real reading
    nxt = recv.reindex(pd.MultiIndex.from_arrays([runs.building_id, runs["last"] + pd.Timedelta(hours=1)])).values
    runs["end"] = runs.end.fillna(pd.Series(nxt, index=runs.index))
    runs["hours"] = runs.arrived_late + runs.lost
    return runs[["building_id", "start", "end", "hours", "arrived_late", "lost"]].sort_values("start").reset_index(drop=True)


def outage_table():
    """building_id, start, end, hours, arrived_late, lost. One row per run of late (> 2 h) or lost hours of one building."""
    return _outages().copy()


def _totals(con):
    """Campus total per stream from a readings table."""
    return pd.Series(dict(con.execute("SELECT stream, SUM(value) FROM readings GROUP BY stream"))).reindex(STREAMS)


def _round(t):
    return {s: round(float(t[s]), 3) for s in STREAMS}


def simulate_outage(building_id, start_ts, hours):
    """Take one building offline for `hours` from start_ts, buffer its readings in a local SQLite outbox, then flush on reconnect.
    Counts are readings (one stream at one hour). The flush is a burst that also re-sends ~30% of the rows with +-0.5% jitter,
    like real retransmissions. The server uses INSERT OR IGNORE: the first arrival wins, same as ingest's dedup (earliest
    received_at kept). INSERT OR REPLACE would let a jittered retry overwrite the true value and the totals would drift.
    Returns buffered, duplicates_dropped, gaps_filled, totals_before, totals_during, totals_after, matches."""
    if building_id not in BUILDINGS:
        raise ValueError(f"unknown building_id {building_id!r}, expected one of {BUILDINGS}")
    if not 1 <= hours <= 48:
        raise ValueError(f"hours must be between 1 and 48, got {hours}")
    t0 = pd.Timestamp(start_ts)
    df = load_hourly()
    win = df[(df.ts >= t0) & (df.ts < t0 + pd.Timedelta(hours=hours))]
    mine = win[win.building_id == building_id].set_index("ts")
    if len(mine) != hours:
        raise ValueError(f"window {t0} + {hours} h is outside the data ({df.ts.min()} .. {df.ts.max()})")
    # the dashboard's estimate for a missing hour: same hour one week earlier
    if t0 - pd.Timedelta(days=7) < df.ts.min():
        raise ValueError(f"{t0} is less than a week into the data ({df.ts.min()}), no earlier hour to estimate from")
    est = df[df.building_id == building_id].set_index("ts")[STREAMS].reindex(mine.index - pd.Timedelta(days=7))

    long = win.melt(["building_id", "ts"], STREAMS, "stream").dropna(subset=["value"])  # a missing sensor value is no reading to buffer
    long["ts"] = long.ts.astype(str)
    before = long.groupby("stream").value.sum()
    rows = lambda x: list(x[["building_id", "stream", "ts", "value"]].itertuples(index=False, name=None))

    # ponytail: a real gateway keeps the outbox in a file on its SD card so it survives a reboot
    edge, srv = sqlite3.connect(":memory:"), sqlite3.connect(":memory:")
    edge.execute(TABLE.format("outbox"))
    srv.execute(TABLE.format("readings"))
    edge.executemany("INSERT INTO outbox VALUES (?,?,?,?)", rows(long[long.building_id == building_id]))
    srv.executemany("INSERT INTO readings VALUES (?,?,?,?)", rows(long[long.building_id != building_id]))
    buffered = edge.execute("SELECT COUNT(*) FROM outbox").fetchone()[0]
    during = _totals(srv) + est.sum()

    sent = edge.execute("SELECT building_id, stream, ts, value FROM outbox ORDER BY ts, stream").fetchall()
    rng = np.random.default_rng(0)
    pick = rng.choice(len(sent), round(0.3 * len(sent)), replace=False)
    jitter = 1 + rng.uniform(-0.005, 0.005, len(pick))
    burst = sent + [(*sent[i][:3], sent[i][3] * j) for i, j in zip(pick, jitter)]  # retries arrive after the originals
    n = srv.total_changes
    srv.executemany("INSERT OR IGNORE INTO readings VALUES (?,?,?,?)", burst)
    dropped = len(burst) - (srv.total_changes - n)
    after = _totals(srv)
    edge.close(), srv.close()
    totals_before, totals_after = _round(before), _round(after)
    return {"buffered": buffered, "duplicates_dropped": dropped, "gaps_filled": buffered,"totals_before": totals_before,
            "totals_during": _round(during), "totals_after": totals_after, "matches": totals_after == totals_before}


def _selfcheck_outage():
    t = outage_table()
    d = _deduped()
    assert t.arrived_late.sum() == ((d.received_at - d.ts) > LATE).sum() and t.lost.sum() == 32
    assert t[(t.building_id == "B03") & (t.start == "2026-09-30 21:00")].arrived_late.item() == 11
    assert (t.hours == t.arrived_late + t.lost).all() and (t.end > t.start).all()
    r = simulate_outage("B03", "2026-10-01 12:00", 3)
    assert r["buffered"] == 12 and r["gaps_filled"] == 12 and r["duplicates_dropped"] > 0 and r["matches"]
    assert r["totals_during"] != r["totals_before"]
    assert simulate_outage("B03", "2026-10-01 12:00", 3) == r
    print(f"outages ok: {len(t)} outages, longest {t.hours.max()} h; B03 demo buffered {r['buffered']}, dropped {r['duplicates_dropped']} duplicates")


# ---------- source_check(): meters vs daily summary vs staff logs vs smart bins ----------

TRUST = ["meter", "daily_summary", "staff_log"]  # most trusted first
PAIRS = [("meter", "daily_summary"), ("meter", "staff_log"), ("daily_summary", "staff_log")]
UNIT = {"electricity": "kWh", "water": "L", "waste": "kg"}
SHARE = {"food_organic": "food_share", "paper_cardboard": "dry_share", "plastic": "dry_share", "glass": "dry_share",
         "metal": "dry_share", "ewaste": "ewaste_share"}
DAILY_KG = {"wet_organic_kg": "food_share", "dry_recyclable_kg": "dry_share", "ewaste_kg": "ewaste_share"}
SLIPS = {1000: "kilo/unit slip", 10: "extra or missing digit", 8: "bags counted as kg, or the reverse"}
KEY = ["building_id", "date", "stream"]
TOL = 20  # percent for readings, percentage points for shares
MIN_BIN_EVENTS = 10  # ponytail: a weekly share from fewer bin events is a coin flip; with 10 every building keeps 11+ of 18 weeks


def _monday(t):
    return t.dt.normalize() - pd.to_timedelta(t.dt.day_of_week, unit="D")


def _num(x):
    return f"{x:,.0f}" if abs(x) >= 100 else f"{x:.3g}"


def _off(x, ref):
    return f"{abs(x - ref) / ref:.0%} {'above' if x > ref else 'below'}" if ref else f"{_num(x)} against 0"


def _value_rows():
    """Electricity, water, waste per building-day: meter (days with 24 real hours only), daily summary, staff log (median)."""
    h = load_hourly()
    h = h[h.status.isin(["measured", "revised"])].rename(columns={"electricity_kwh": "electricity", "water_litres": "water"})
    g = h.groupby(["building_id", h.ts.dt.normalize().rename("date")])[["electricity", "water"]]
    meter = g.sum().where(g.count() == 24).reset_index().melt(["building_id", "date"], var_name="stream", value_name="meter")
    d = load_daily().rename(columns={"electricity_kwh": "electricity", "water_litres": "water"})
    # the staff "waste" stream is the day's total: wet + dry + e-waste + hazardous (median ratio 1.03, 72% within 20%; landfill or one category alone fit far worse)
    d["waste"] = d[["wet_organic_kg", "dry_recyclable_kg", "ewaste_kg", "hazardous_kg"]].sum(axis=1, min_count=4)
    daily = d.melt(["building_id", "date"], list(UNIT), "stream", "daily_summary")
    m = load_manual_logs()
    m = m[m.stream.isin(UNIT) & m.building_id.notna()]
    staff = m.groupby(["building_id", m.ts.dt.normalize().rename("date"), "stream"]).value.agg(staff_log="median", n="size").reset_index()
    return meter.merge(daily, on=KEY, how="outer").merge(staff, on=KEY, how="outer")


def _bin_rows():
    """Smart-bin mass share per building-week against the daily-summary share of the same days; date = the week's Monday."""
    w = pd.read_csv(DATA / "waste_events_train.csv", parse_dates=["timestamp"])
    wk = _monday(w.timestamp).rename("date")
    # ponytail: a bin event with no weight counts as 0 g (2% of events)
    mass = w.weight_g.groupby([w.building_id, wk, w.category.map(SHARE).rename("stream")]).sum().unstack("stream", fill_value=0)
    n = w.groupby(["building_id", wk]).size().rename("n")
    share = mass.div(mass.sum(axis=1), axis=0)[n.reindex(mass.index) >= MIN_BIN_EVENTS]
    bins = share.reset_index().melt(["building_id", "date"], var_name="stream", value_name="meter").merge(n.reset_index(), on=["building_id", "date"])
    d = load_daily().dropna(subset=list(DAILY_KG)).rename(columns=DAILY_KG)
    kg = d.groupby(["building_id", _monday(d.date).rename("date")])[list(set(DAILY_KG.values()))].sum()
    daily = kg.div(kg.sum(axis=1), axis=0).reset_index().melt(["building_id", "date"], var_name="stream", value_name="daily_summary")
    # ewaste_share not compared: the daily summary logs e-waste on only 29 of 960 building-days, so every week would alert
    return bins.merge(daily, on=KEY).query("stream != 'ewaste_share'")


def _why(df, full):
    """One sentence per disagreeing row: unit mistake, wrong building, or just how far off."""
    share = df.stream.str.endswith("_share")
    ratio = df.staff_log / df.trusted
    with np.errstate(all="ignore"):
        lr = np.log(ratio.where(df.staff_off)).values[:, None]
        dist = np.minimum(np.abs(lr - np.log(list(SLIPS))), np.abs(lr + np.log(list(SLIPS))))
    slip = pd.Series(np.nanmin(np.where(np.isnan(dist), np.inf, dist), axis=1) < np.log(1.35), index=df.index) & df.staff_off
    slip_name = pd.Series(np.array(list(SLIPS.values()))[np.argmin(np.where(np.isnan(dist), np.inf, dist), axis=1)], index=df.index)
    # same day, another building's trusted value within 5% of the staff value
    cand = full.loc[full[["meter", "daily_summary"]].notna().any(axis=1) & ~full.stream.str.endswith("_share"), ["building_id", "date", "stream", "trusted"]]
    s = df.loc[df.staff_off, ["building_id", "date", "stream", "staff_log"]].reset_index().merge(cand, on=["date", "stream"], suffixes=("", "_o"))
    s = s[(s.building_id != s.building_id_o) & ((s.staff_log - s.trusted).abs() <= 0.05 * s.trusted)]
    other = s.groupby("index").building_id_o.first()
    out = {}
    for r in df[df.disagrees].itertuples():
        u, src, parts = UNIT.get(r.stream), "the " + r.trusted_source.replace("_", " "), []
        if r.stream.endswith("_share"):
            parts.append(f"bins see {r.meter:.0%} {r.stream[:-6]} by mass, daily summary {r.daily_summary:.0%} ({int(r.n)} bin events that week)")
        if r.md_off:
            parts.append(f"daily summary {_num(r.daily_summary)} {u} is {_off(r.daily_summary, r.meter)} the meter")
        if r.staff_off:
            v = f"staff log {_num(r.staff_log)} {u}"
            if r.Index in other.index:
                parts.append(f"{v} fits {other[r.Index]} that day, not {r.building_id}: possibly logged against {other[r.Index]}")
            elif slip[r.Index]:
                parts.append(f"{v} is {_num(ratio[r.Index])}x {src}: unit mistake ({slip_name[r.Index]})")
            else:
                parts.append(f"{v} is {_off(r.staff_log, r.trusted)} {src}")
            if r.n > 1:
                parts[-1] += f" (median of {int(r.n)} logs)"
        out[r.Index] = "; ".join(parts) or f"sources differ by {r.pct_diff:g}"
    return pd.Series(out, dtype=object)


@lru_cache(maxsize=1)
def _source_check():
    df = pd.concat([_value_rows(), _bin_rows()], ignore_index=True)
    df["trusted"] = df[TRUST].bfill(axis=1).iloc[:, 0]
    df["trusted_source"] = df[TRUST].notna().idxmax(axis=1)
    share = df.stream.str.endswith("_share")
    rel = {}
    for a, b in PAIRS:
        gap = (df[b] - df[a]).abs()
        rel[a, b] = gap.where(share, (gap / df[a].abs()).mask((df[a] == 0) & (gap == 0), 0.0)) * 100
    df["pct_diff"] = pd.concat(rel.values(), axis=1).max(axis=1).round(1)
    df["disagrees"] = df.pct_diff > TOL
    df["md_off"] = rel[PAIRS[0]] > TOL
    df["staff_off"] = rel[PAIRS[1]].fillna(rel[PAIRS[2]]) > TOL
    full, df = df, df[df[TRUST].notna().sum(axis=1) >= 2].copy()
    df["detail"] = _why(df, full).reindex(df.index).fillna("")
    cols = ["building_id", "date", "stream", *TRUST, "disagrees", "trusted", "trusted_source", "pct_diff", "detail"]
    return df.sort_values(["date", "building_id", "stream"])[cols].reset_index(drop=True)


def source_check():
    """One row per building-day-stream (electricity, water, waste) and per building-week-stream (food_share, dry_share, ewaste_share)
    where at least two sources are present: building_id, date, stream, meter, daily_summary, staff_log, disagrees, then the fusion
    output trusted / trusted_source (meter > daily_summary > staff_log), pct_diff and detail (a sentence for disagreeing rows).
    meter = sum of the 24 real hourly readings (NaN if the day is incomplete); for shares it is the smart-bin share of mass.
    disagrees: any two present sources differ by more than 20% of the more-trusted one. Shares use 20 percentage points instead of
    20% relative: weekly shares are small and noisy, ewaste is 0 in the daily summary most weeks (relative flags 54-76% of weeks).
    Shares are fractions 0-1 and pct_diff is then in points. Several staff logs for one day: median. Waste staff logs are
    compared with wet + dry + ewaste + hazardous. Nothing is overwritten: all source columns stay as read."""
    return _source_check().copy()


def _selfcheck_sources():
    before = load_daily()
    s = source_check()
    assert before.equals(load_daily())
    assert list(s.columns[:7]) == ["building_id", "date", "stream", "meter", "daily_summary", "staff_log", "disagrees"]
    assert list(s.columns[7:]) == ["trusted", "trusted_source", "pct_diff", "detail"]
    assert (s[TRUST].notna().sum(axis=1) >= 2).all()
    big = s[(s.stream == "water") & (s.staff_log == 959417)]
    assert len(big) == 1 and big.disagrees.item() and "unit mistake" in big.detail.item(), big
    e = s[(s.stream == "electricity") & s.meter.notna() & s.daily_summary.notna()]
    md = (e.meter - e.daily_summary).abs() / e.meter > 0.2
    assert md.mean() < 0.02, md.mean()
    t = s.groupby("stream").agg(rows=("disagrees", "size"), disagree=("disagrees", "sum"))
    print(f"sources ok: {len(s)} rows\n{t.to_string()}\n{s.detail.str.contains('unit mistake').sum()} unit mistakes, "
          f"{s.detail.str.contains('logged against').sum()} wrong-building suspects; 959,417 L: {big.detail.item()}")


if __name__ == "__main__":
    _selfcheck_outage()
    _selfcheck_sources()
