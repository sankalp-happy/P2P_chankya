"""P3: weekly building leaderboard and credits, the weekly note, and how we would measure the scheme's impact.

Closed loop: a building is scored each week against its own frozen normal -> credits and a note go back to
the occupants -> next week's score. Our data predates any scheme, so nothing here claims a real saving.
"""
from functools import lru_cache

import numpy as np
import pandas as pd

from ingest import BUILDINGS, load_buildings, load_calendar, load_daily, load_hourly

BASE_END = pd.Timestamp("2026-08-16")  # the frozen baseline is 2026-06-20..2026-08-16
FALLBACK = {"exam": "working", "holiday": "weekend"}  # a day type with under 2 baseline days borrows this one
DAY_TYPES = ["working", "weekend", "semester_break", "exam", "holiday"]
S = ["kwh", "litres", "landfill_kg"]  # kwh = grid + own solar, so a sunny week earns nothing
LABEL = {"kwh": "electricity", "litres": "water", "landfill_kg": "landfill waste"}
MIN_COVERAGE = 90  # % of the week's building-hours that must be real, or no credits
MAX_CREDITS = 10
# Longest run of identical readings in a normal night: 3 h for electricity, 14 h for water (B08 on a quiet
# weekend, 1 L/h). The stuck B02 water meter on 2026-09-03 read 0 for 48 h. 24 h sits between the two.
FLAT_HOURS = 24
SCHEME = ["B05", "B06", "B07"]  # the trial group; B01-B04 and B08 are the comparison group
TIPS = {
    "kwh": "Switch off lights and AC when a room empties, and set the AC to 24 C.",
    "litres": "Report dripping taps and running cisterns to facilities, and run washing machines only on full loads.",
    "landfill_kg": "Sort at the bin: food in wet, paper and bottles in dry, and keep recycling free of food.",
}
FIRST = ["building_id", "expected", "actual", "occupancy_adjustment", "pct_saved", "credits", "rank", "coverage_pct"]
EXTRA = [f"{s}_{k}" for s in S for k in ("expected", "actual", "pct_saved")] + ["week_start", "week_end", "reason"]

IMPACT_DESIGN = """How we would measure the impact (we have not measured it yet).

Our data predates any incentive scheme, so we claim no saving. The leaderboard shows each building against its own
frozen normal; it does not show that the scheme works.

Trial: run the scheme in B05, B06 and B07 (scheme group) for 4 weeks and keep B01-B04 and B08 as the comparison
group. For each group, take the change from the 4 weeks before the start to the 4 weeks of the trial in
electricity (kWh), water (litres) and landfill (kg) per person, plus recycling contamination (%). The impact is the
scheme group's change minus the comparison group's change (difference-in-differences), so anything that hits all
buildings alike (weather, exams, term dates) cancels out.

Limits: the two groups differ in type (hostels and a food court against academic, lab and admin buildings), so
this only works if both groups would have moved in parallel without the scheme. We check that on the pre-period.
placebo_test() does it on our history: it runs the same comparison for every start week, when no scheme existed.
Any effect smaller than the spread of those estimates (the noise floor) cannot be told apart from chance in a
4-week trial. Staff logs and manual notes never change a score.
"""


@lru_cache(maxsize=1)
def _daily():
    """Daily rows with day_type and the three scored streams. Cached, do not mutate."""
    d = load_daily().merge(load_calendar()[["date", "day_type"]], on="date", how="left")
    return d.assign(kwh=d.electricity_kwh + d.solar_generation_kwh, litres=d.water_litres)


@lru_cache(maxsize=1)
def _baseline():
    """Frozen normal: mean per-person use by building and day type over the baseline days, one row per building
    and day type. Fewer than 2 baseline days: borrow the fallback day type's row."""
    d = _daily()
    d = d[d.date <= BASE_END]
    key = [d.building_id, d.day_type]
    pp = pd.DataFrame({"base_" + s: d[s] / d.occupancy_avg for s in S}).assign(base_occ=d.occupancy_avg)
    base = pp.groupby(key).mean().assign(n=d.groupby(key).occupancy_avg.count())
    base = base.reindex(pd.MultiIndex.from_product([BUILDINGS, DAY_TYPES], names=["building_id", "day_type"]))
    thin = base.n.fillna(0) < 2
    base.loc[thin, :] = base.loc[[(b, FALLBACK.get(t, t)) for b, t in base.index[thin]]].values
    return base.drop(columns="n")


def _run_len(v):
    """Length of the run of identical readings each hour sits in (0 for a missing hour). v is indexed (building, ts)."""
    same = v.eq(v.groupby(level=0).shift())
    return v.groupby((~same).cumsum()).transform("size").where(v.notna(), 0)


@lru_cache(maxsize=32)
def _hours(as_of=None):
    """Per building-hour: `real` (measured or revised, not missing) and `flat` (electricity or water identical for
    FLAT_HOURS or more real hours in a row). Built from what load_hourly(as_of) shows; cached per as_of."""
    d = _daily()
    grid = pd.MultiIndex.from_product([BUILDINGS, pd.date_range(d.date.min(), d.date.max() + pd.Timedelta(hours=23), freq="h")],
                                      names=["building_id", "ts"])
    h = load_hourly(as_of).set_index(["building_id", "ts"]).reindex(grid)
    real = h.status.isin(["measured", "revised"]) & h.electricity_kwh.notna() & h.water_litres.notna()
    e, w = h.electricity_kwh.where(real), h.water_litres.where(real)
    # ponytail: a gap (non-real hour) restarts the run, so a stuck meter that also drops hours can slip under FLAT_HOURS
    return pd.DataFrame({"real": real, "flat": (_run_len(e) >= FLAT_HOURS) | (_run_len(w) >= FLAT_HOURS)})


def _scores(as_of=None):
    """One row per building for the week ending the day before as_of: index and per-stream figures, no credits yet."""
    d = _daily()
    last = d.date.max()
    asof = None if as_of is None else pd.Timestamp(as_of)
    end = last if asof is None else min(asof.normalize() - pd.Timedelta(days=1), last)
    start = end - pd.Timedelta(days=6)
    w = d[d.date.between(start, end)].join(_baseline(), on=["building_id", "day_type"])
    for s in S:
        expected = w["base_" + s] * w.occupancy_avg
        ok = expected.notna() & w[s].notna()  # a day with a missing value drops out of both sides
        w[s + "_expected"], w[s + "_actual"] = expected.where(ok), w[s].where(ok)
    g = w.groupby("building_id")
    t = g[[f"{s}_{k}" for s in S for k in ("expected", "actual")]].sum(min_count=1).reindex(BUILDINGS)
    ratio = pd.concat([t[f"{s}_actual"] / t[f"{s}_expected"] for s in S], axis=1).mean(axis=1)
    for s in S:
        t[s + "_pct_saved"] = (t[s + "_expected"] - t[s + "_actual"]) / t[s + "_expected"] * 100
    occ = w.occupancy_avg.groupby(w.building_id).mean()
    base_occ = w.base_occ.where(w.occupancy_avg.notna()).groupby(w.building_id).mean()
    hrs = _hours(asof)
    ok = (hrs.real & ~hrs.flat).unstack(0).reindex(pd.date_range(start, end + pd.Timedelta(hours=23), freq="h"), fill_value=False)
    t = t.assign(expected=100.0, actual=100 * ratio, occupancy_adjustment=occ / base_occ, coverage_pct=ok.mean() * 100,
                 week_start=start, week_end=end).rename_axis("building_id").reset_index()
    t["pct_saved"] = t.expected - t.actual
    return t


def _finish(t):
    """Rank (eligible buildings first, by saving), award credits, give a reason, round, order the columns."""
    ok = t.coverage_pct >= MIN_COVERAGE
    base_week = t.week_start <= BASE_END  # this week overlaps the baseline, so it is scored against itself
    order = t.assign(out=~ok).sort_values(["out", "pct_saved"], ascending=[True, False], kind="stable")
    t = t.assign(rank=pd.Series(range(1, len(t) + 1), index=order.index))
    t["actual"] = t.actual.round(1)
    t["pct_saved"] = (t.expected - t.actual).round(1)
    credits = np.floor(t.pct_saved).clip(0, MAX_CREDITS).fillna(0).astype(int)
    t["credits"] = credits.where(ok & ~base_week, 0)
    t["reason"] = np.select(
        [base_week, ~ok, t.pct_saved < 0, np.floor(t.pct_saved) > MAX_CREDITS],
        ["baseline period", "coverage " + t.coverage_pct.astype(int).astype(str) + f"% < {MIN_COVERAGE}%: no credits",
         "used more than normal", f"capped at {MAX_CREDITS}"], "")
    for c in t.columns[t.columns.str.startswith(tuple(S))]:
        t[c] = t[c].round(1)
    t["occupancy_adjustment"], t["coverage_pct"] = t.occupancy_adjustment.round(2), t.coverage_pct.round(1)
    return t[FIRST + EXTRA].sort_values("rank").reset_index(drop=True)


def leaderboard(as_of=None):
    """One row per building for the 7 full days before as_of's date (as_of=None: the last 7 days of data).
    expected is 100 (the building's own frozen normal), actual is 100 x the mean of actual/expected over
    electricity, water and landfill, scaled for how many people were in. 1 credit per 1% saved, max 10 a week,
    none if under 90% of the week's hours are real or the week overlaps the baseline."""
    return _finish(_scores(as_of))


def weekly_note(as_of=None):
    """building_id, rank, credits, biggest_waste, one_thing_to_do, text: a plain note per building, no AI."""
    lb = leaderboard(as_of)
    try:  # P1's actions are a bonus; the note must work without them
        from attribution import recommend
        recs = pd.DataFrame(recommend(as_of if as_of is not None else lb.week_end.iat[0] + pd.Timedelta(days=1), top=50))
    except Exception:
        recs = pd.DataFrame(columns=["building_id", "stream", "action"])
    top = recs.drop_duplicates("building_id").set_index("building_id")  # recommend() is sorted best first
    name = load_buildings().set_index("building_id").building_name
    pcts = lb.set_index("building_id")[[s + "_pct_saved" for s in S]].rename(columns=lambda c: c[:-len("_pct_saved")])
    rows = []
    for r in lb.itertuples():
        worst = pcts.loc[r.building_id].idxmin()  # the stream furthest above (or least below) its normal
        if r.building_id in top.index:
            stream = {"electricity_kwh": "kwh", "water_litres": "litres"}.get(top.stream[r.building_id], "landfill_kg")
            waste = top.action[r.building_id].rstrip(".")
        else:
            stream, p = worst, pcts.loc[r.building_id, worst]
            waste = f"{LABEL[stream]} {abs(p):.0f}% above your normal" if p < 0 else "nothing above your normal this week"
        why = f" ({r.reason})" if r.credits == 0 and r.reason else ""
        text = (f"{name[r.building_id]} ranked {r.rank} of {len(lb)} last week and earned {r.credits} credits{why}, "
                f"spendable at the Food Court. Biggest waste: {waste}. One thing to do: {TIPS[stream]}")
        rows.append((r.building_id, r.rank, r.credits, waste, TIPS[stream], text))
    return pd.DataFrame(rows, columns=["building_id", "rank", "credits", "biggest_waste", "one_thing_to_do", "text"])


def placebo_test():
    """History has no scheme, so any scheme-vs-comparison 'effect' is noise. For every start week, the
    difference-in-differences of per-person electricity, water and landfill (a 4-week window against the 4 weeks
    before it, scheme group minus comparison group, % points). Their spread is the smallest effect a 4-week trial
    could detect. Returns one row per start week."""
    d = _daily()
    d = d[d.date < d.date.min() + pd.Timedelta(days=119)]  # 17 whole weeks; the 120th day is a stub
    wk = ((d.date - d.date.min()).dt.days // 7).rename("week")
    grp = d.building_id.isin(SCHEME).map({True: "scheme", False: "comparison"}).rename("group")
    out = {}
    for s in S:
        ok = d[s].notna() & d.occupancy_avg.notna()  # a day with a missing value drops out of both sides
        num = d[s].where(ok).groupby([grp, wk]).sum().unstack(0).rolling(4).sum()
        den = d.occupancy_avg.where(ok).groupby([grp, wk]).sum().unstack(0).rolling(4).sum()
        pp = num / den  # per-person use over the 4 weeks ending in each week
        chg = pp.shift(-3) / pp.shift(1) - 1  # trial weeks j..j+3 against weeks j-4..j-1
        out[s + "_did_pct"] = (chg.scheme - chg.comparison) * 100
    res = pd.DataFrame(out).dropna().round(1)
    res.insert(0, "start", d.date.min() + pd.to_timedelta(res.index * 7, unit="D"))
    spread = res.drop(columns="start")
    for c in spread:
        print(f"placebo {c[:-8]}: {spread[c].min():+.1f} to {spread[c].max():+.1f} points over {len(res)} start weeks "
              f"(sd {spread[c].std():.1f}); a 4-week trial needs more than {spread[c].abs().max():.1f} points to stand out")
    term = res[res.start - pd.Timedelta(days=28) > d.date[d.day_type == "semester_break"].max()].drop(columns="start")
    print("  without start weeks whose before-window touches the semester break: "
          + "; ".join(f"{c[:-8]} {term[c].min():+.1f} to {term[c].max():+.1f}" for c in term) + f" ({len(term)} start weeks)")
    return res.reset_index(drop=True)


def _selfcheck():
    import time

    as_of = "2026-10-12 08:00"
    lb = leaderboard(as_of)
    assert len(lb) == 8 and list(lb.columns) == FIRST + EXTRA, list(lb.columns)
    assert (lb.expected == 100).all() and np.allclose(lb.pct_saved, lb.expected - lb.actual, atol=0.051)
    assert lb.credits.between(0, MAX_CREDITS).all() and lb.coverage_pct.between(0, 100).all()
    assert sorted(lb["rank"]) == list(range(1, 9)) and (lb.credits[lb.coverage_pct < MIN_COVERAGE] == 0).all()
    assert (lb.week_end - lb.week_start == pd.Timedelta(days=6)).all() and lb.week_end.iat[0] == pd.Timestamp("2026-10-11")
    assert (leaderboard().week_end == pd.Timestamp("2026-10-17")).all()  # as_of=None: the last 7 days of data
    ok = lb[lb.coverage_pct >= MIN_COVERAGE]
    assert (ok["rank"] <= len(ok)).all() and ok.sort_values("rank").pct_saved.is_monotonic_decreasing

    # forced coverage rule: same week, one building's coverage set to 80 -> it loses its credits and drops to the bottom
    raw = _scores(as_of)
    top = lb.building_id[lb.credits > 0].iat[0]
    forced = _finish(raw.assign(coverage_pct=raw.coverage_pct.mask(raw.building_id == top, 80.0))).set_index("building_id")
    assert forced.credits[top] == 0 and forced["rank"][top] == 8 and forced.reason[top] == "coverage 80% < 90%: no credits"

    # real outage: B02's water meter stuck at 0 on 2026-09-03 (staff note logged 17:10) and 2026-09-04
    h = _hours(pd.Timestamp("2026-09-08 08:00"))
    stuck = h.loc["B02"].loc["2026-09-03":"2026-09-04"]
    assert stuck.real.all() and stuck.flat.all() and len(stuck) == 48  # reported fine, caught by the flatline rule
    assert h.flat.sum() == 48  # and nothing else in the data (every normal night is shorter than FLAT_HOURS)
    out = leaderboard("2026-09-08 08:00").set_index("building_id")
    assert out.coverage_pct["B02"] < MIN_COVERAGE and out.credits["B02"] == 0 and out["rank"]["B02"] == 8
    print(f"flatline: N={FLAT_HOURS} h flags {int(h.flat.sum())} building-hours, all B02 2026-09-03..04; "
          f"B02 coverage that week {out.coverage_pct['B02']}%, reason: {out.reason['B02']}")

    # weeks overlapping the baseline are scored against themselves: no credits
    b = leaderboard("2026-08-10")
    assert (b.credits == 0).all() and (b.reason == "baseline period").all()
    assert leaderboard("2026-08-24").week_start.iat[0] > BASE_END  # first clean week

    t0 = time.perf_counter()
    leaderboard(as_of)
    warm = time.perf_counter() - t0
    assert warm < 0.3, warm

    pd.set_option("display.width", 250, "display.max_columns", 30)
    print(f"\nleaderboard({as_of!r}), week {lb.week_start.iat[0]:%Y-%m-%d} to {lb.week_end.iat[0]:%Y-%m-%d}, {warm * 1000:.0f} ms warm")
    print(lb[FIRST + ["reason"]].to_string(index=False))
    print(lb[[c for c in EXTRA if c.endswith(("expected", "actual", "pct_saved"))]].set_index(lb.building_id).to_string())
    note = weekly_note(as_of)
    assert len(note) == 8 and note.text.str.len().gt(0).all()
    print("\nweekly note B03:", note.set_index("building_id").text["B03"])
    print("weekly note B02, week with the stuck meter:", weekly_note("2026-09-08 08:00").set_index("building_id").text["B02"])
    print()
    p = placebo_test()
    assert len(p) == 10 and p.drop(columns="start").notna().all().all()
    print(p.to_string(index=False))
    print("\nIMPACT_DESIGN:\n" + IMPACT_DESIGN)


if __name__ == "__main__":
    _selfcheck()
