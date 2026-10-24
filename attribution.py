"""P1: flag unusual readings, find the probable cause, and turn it into a ranked, explained action.

How it works, in four steps:
1. Expected = median of the same building, stream and hour over the same kind of day (semester break, weekend or
   holiday, working or exam day), using only data received by as_of. Flag a reading when its robust z is 3.5 or more
   and it is at least 1.5x (or at most 1/1.5 of) expected. Flagged hours of one building + stream + direction less
   than 24 h apart form one episode. Daily landfill and contamination get the same check (high side only).
2. Each episode collects evidence for each possible cause: staff note, calendar, shift, localisation, extreme reading.
3. The cause with the most points wins (confidence = points / 8); the runner-up is kept.
4. The winner becomes an action with rupees and CO2, and actions are ranked by rupees x confidence.
"""
from functools import lru_cache

import numpy as np
import pandas as pd

from forecast import DATA, USE_TEAM, calendar, daily, hourly, manual_logs

# Dataset constants (README section 6). No water tariff or landfill cost is given, so only
# the pumping energy of water counts as rupees, and landfill actions carry 0.
RS_PER_KWH = 8
CO2_PER_KWH = 0.70
KWH_PER_KL_WATER = 0.85  # pumping and treatment energy per 1,000 L

Z_FLAG = 3.5  # |robust z| at or above this is unusual
MIN_RATIO = 1.5  # ...and the reading must also be 1.5x above (or below 1/1.5 of) expected: a 1.3x blip is not worth a visit
MAD_SCALE = 1.4826  # makes MAD comparable to a standard deviation
MIN_REL_MAD = 0.05  # MAD floor: 5% of expected, so a flat night reading cannot explode z
ABS_MAD_FLOOR = {"electricity_kwh": 1.0, "water_litres": 10.0, "landfill_kg": 1.0, "contamination_pct": 1.0,
                 "solar_kwh": 5.0}
MIN_SAMPLES = 3  # no expected value from fewer than this many past readings
EPISODE_GAP_H = 24  # flagged hours of one building+stream+sign this close are one incident
DAILY_GAP_DAYS = 2

MAX_POINTS = 8  # note 3 + calendar 2 + shift 2 + localisation 1
NOTE_POINTS, CALENDAR_POINTS, SHIFT_POINTS, LOCAL_POINTS, EXTREME_POINTS = 3, 2, 2, 1, 2
NOTE_WINDOW_H = 24  # a note counts if logged within this many hours of the episode
NIGHT_HOURS = range(0, 6)
DAY_HOURS = range(8, 19)  # "daytime" for the footfall baseline
QUIET_FOOTFALL = 0.05  # night footfall at or below this share of the daytime median is "nobody there"
NIGHT_MIN_H = 2  # flagged quiet-night hours needed for shift points
MEAL_HOURS = {7, 8, 9, 12, 13, 14, 19, 20, 21}
MEAL_SHARE = 0.5  # share of flagged hours inside meal hours for "mess rush"
EXTREME_RATIO = 8  # median flagged reading at least this many times expected
ZERO_RUN_H = 3  # this many flagged hours in a row at exactly 0
SAME_SHARE = 0.25  # another building is "also flagged" if it shares this much of the episode's hours

HOURLY_STREAMS = ["electricity_kwh", "water_litres"]
DAILY_STREAMS = ["landfill_kg", "contamination_pct"]
SOLAR = "solar_kwh"  # daily total per solar building (has_solar in buildings.csv), low side only: lost generation
SOLAR_NOTE_WORDS = ["inverter", "solar", "panel"]  # a note about these explains low solar
WET_PERCENTILE = 0.75  # rain or humidity above this percentile of the days seen so far counts as weather
STREAM_NAME = {"electricity_kwh": "electricity", "water_litres": "water", "solar_kwh": "solar generation",
               "landfill_kg": "landfill waste", "contamination_pct": "recycling contamination"}
UNIT = {"electricity_kwh": "kWh", "water_litres": "L", "landfill_kg": "kg", "contamination_pct": "% points",
        "solar_kwh": "kWh"}
DAY_CLASS_TEXT = {"break": "a semester-break day", "off": "a weekend or holiday", "on": "a working or exam day",
                  "all": "a typical day"}  # solar is compared with all days: the sun ignores the timetable

# Causes that can explain a high reading per stream (the "local" ones get the localisation point).
LOCAL_CAUSES = {
    "electricity_kwh": ["left_on", "equipment_down", "meter_fault"],
    "water_litres": ["leak", "equipment_down", "meter_fault"],
    "landfill_kg": ["equipment_down"],
    "contamination_pct": ["equipment_down"],
}
CAUSE_ORDER = ["leak", "left_on", "weather", "equipment_down", "meter_fault", "event_surge", "mess_rush"]  # tie-break
CAUSE_TEXT = {"leak": "a leak", "left_on": "AC/lights left on", "equipment_down": "equipment down",
              "meter_fault": "a meter fault", "event_surge": "an event surge", "mess_rush": "a mess rush",
              "weather": "weather", "unexplained": "unexplained"}

# First match wins, so "water meter running fast ... pipe" is a leak, not a meter fault.
NOTE_TAGS = [
    ("leak", ["leak", "pipe", "plumber", "wet patch", "running fast", "tank"]),
    ("left_on", ["left on", "lights", " ac "]),
    ("equipment_down", ["composter", "motor", "inverter", "pump"]),
    ("meter_fault", ["meter", "analyzer", "analyser", "calibrat", "stuck", "flicker", "display"]),
    ("event", ["alumni", "fest", "meet", "expecting", "cooking", "rehearsal"]),
]
METER_STREAM_WORDS = {"water_litres": ["water"], "electricity_kwh": ["electricity", "energy", "power"]}
EXPLAIN_TAG_TO_CAUSE = {"leak": "leak", "maintenance": "equipment_down", "fest": "event"}


# ---------- small helpers ----------

@lru_cache(maxsize=1)
def _solar_buildings():
    b = pd.read_csv(DATA / "buildings.csv")
    return tuple(b[b.has_solar == 1].building_id)


def _wet_days():
    """date -> rain, humidity and wet (either above the 75th percentile of the days up to that date: no look-ahead)."""
    c = calendar().set_index("date")[["rainfall_mm", "humidity_pct"]].rename(columns={"rainfall_mm": "rain", "humidity_pct": "hum"})
    c["rain_p"], c["hum_p"] = (c[k].expanding().quantile(WET_PERCENTILE) for k in ("rain", "hum"))
    return c.assign(wet=(c.rain > c.rain_p) | (c.hum > c.hum_p))


@lru_cache(maxsize=1)
def _building_names():
    return pd.read_csv(DATA / "buildings.csv").set_index("building_id").building_name.to_dict()


def _day_class():
    """date -> break / off (weekend or holiday) / on (working or exam). The calendar is known in advance."""
    t = calendar().set_index("date").day_type
    return t.map({"semester_break": "break", "weekend": "off", "holiday": "off"}).fillna("on")


def _hour_text(h):
    return f"{(h % 12) or 12} {'AM' if h < 12 else 'PM'}"


def _unusual(actual, expected, hour, dayclass):
    """Plain-language size of the deviation; hour is None for a daily reading."""
    when = f"{_hour_text(hour)} on {DAY_CLASS_TEXT[dayclass]}" if hour is not None else DAY_CLASS_TEXT[dayclass]
    if actual >= expected:
        return f"{actual / expected:.1f}x the usual for {when}" if expected > 0 else f"far above the usual for {when}"
    return f"only {actual / expected:.0%} of the usual for {when}"


def _flagged(d, one_sided=False):
    """Statistically unusual (z) and big enough to matter (ratio). Daily waste is one-sided: less is good news."""
    high = (d.z >= Z_FLAG) & (d.actual >= MIN_RATIO * d.expected)
    low = (d.z <= -Z_FLAG) & (d.actual * MIN_RATIO <= d.expected)
    return d[high] if one_sided else d[high | low]


def _score(df, keys, floor):
    """Expected = median of the group; z = (actual - expected) / (1.4826 * max(MAD, 5% of expected, floor))."""
    g = df.groupby(keys).actual
    expected = g.transform("median")
    mad = (df.actual - expected).abs().groupby([df[k] for k in keys]).transform("median")
    scale = MAD_SCALE * np.maximum.reduce([mad.values, MIN_REL_MAD * expected.values, np.full(len(df), floor)])
    z = (df.actual - expected) / scale
    return expected, z.where(g.transform("count") >= MIN_SAMPLES)


# ---------- step 1 and 2: flag readings, group them into episodes ----------

def _hourly_flags(as_of):
    """Flagged hourly readings using only rows received by as_of, plus each building's daytime footfall."""
    h = hourly(as_of)
    h["hour"] = h.ts.dt.hour
    h["dayclass"] = h.ts.dt.normalize().map(_day_class()).fillna("on")
    day_foot = h[h.hour.isin(DAY_HOURS)].groupby("building_id").footfall.median()
    parts = []
    for stream in HOURLY_STREAMS:
        d = h[["building_id", "ts", "hour", "dayclass", "footfall", stream]].rename(columns={stream: "actual"})
        d = d.dropna(subset=["actual"]).assign(stream=stream)
        d["expected"], d["z"] = _score(d, ["building_id", "dayclass", "hour"], ABS_MAD_FLOOR[stream])
        parts.append(_flagged(d))
    flags = pd.concat(parts, ignore_index=True)
    return flags.assign(kind="hourly"), day_foot


def _daily_flags(as_of):
    """Flagged daily readings; a day's summary exists only after the day ends."""
    d = daily()
    d = d[d.date < as_of.normalize()]
    d = d.assign(dayclass=d.date.map(_day_class()).fillna("on"), hour=np.nan, footfall=np.nan, ts=d.date)
    parts = []
    for stream in DAILY_STREAMS:
        s = d[["building_id", "ts", "hour", "dayclass", "footfall", stream]].rename(columns={stream: "actual"})
        s = s.dropna(subset=["actual"]).assign(stream=stream)
        s["expected"], s["z"] = _score(s, ["building_id", "dayclass"], ABS_MAD_FLOOR[stream])
        parts.append(_flagged(s, one_sided=True).assign(wet=False))
    parts.append(_solar_flags(as_of))
    return pd.concat(parts, ignore_index=True).assign(kind="daily")


def _solar_flags(as_of):
    """Low daily solar totals of solar buildings. Only full days (24 hourly rows received) before as_of's date;
    expected = the building's median over those days; a `wet` day starts its own episode (weather, not a fault)."""
    h = hourly(as_of)
    h = h[h.building_id.isin(_solar_buildings()) & (h.ts < as_of.normalize())].dropna(subset=[SOLAR])
    s = h.groupby(["building_id", h.ts.dt.normalize()]).solar_kwh.agg(actual="sum", n="count").reset_index()
    s = s[s.n == 24].assign(stream=SOLAR, hour=np.nan, dayclass="all", footfall=np.nan)
    s["expected"], s["z"] = _score(s, ["building_id"], ABS_MAD_FLOOR[SOLAR])
    low = _flagged(s)
    return low[low.z < 0].assign(wet=lambda d: d.ts.map(_wet_days().wet).fillna(False).astype(bool))


def _with_episode_ids(flags, gap):
    """Same building + stream + sign (+ wet day or not), next flagged reading within `gap` of the previous one."""
    f = flags.assign(sign=np.sign(flags.z), wet=flags.get("wet", False)).sort_values(["building_id", "stream", "sign", "wet", "ts"])
    prev = f.groupby(["building_id", "stream", "sign", "wet"]).ts.shift()
    f["ep"] = (prev.isna() | (f.ts - prev > gap)).cumsum()
    return f


# ---------- step 3: staff notes ----------

def _keyword_tag(text):
    t = f" {text.lower()} "
    return next((tag for tag, words in NOTE_TAGS if any(w in t for w in words)), None)


@lru_cache(maxsize=None)
def _tag(text):
    """leak / left_on / equipment_down / meter_fault / event / None. P2's Claude tagger first when USE_TEAM."""
    keyword = _keyword_tag(text)
    # P2's labels cannot say left_on or meter_fault, so a keyword hit for those wins.
    if USE_TEAM and keyword not in ("left_on", "meter_fault"):
        try:
            from explain import tag_note
            tag = EXPLAIN_TAG_TO_CAUSE.get(tag_note(text))
            if tag:
                return tag
        except Exception:
            pass  # the demo must not depend on the API
    return keyword


def _note_fits(tag, text, stream):
    """Does a note with this tag say something about this stream?"""
    t = f" {text.lower()} "
    if tag == "leak":
        return stream == "water_litres"
    if tag == "left_on":
        return stream == "electricity_kwh"
    if tag == "equipment_down":
        if "composter" in t:
            return stream in DAILY_STREAMS
        if "inverter" in t:
            return stream == "electricity_kwh"
        return stream in HOURLY_STREAMS  # pump or motor
    if tag == "meter_fault":
        named = [s for s, words in METER_STREAM_WORDS.items() if any(w in t for w in words)]
        return not named or stream in named
    return tag == "event"


# ---------- step 3: score candidate causes from evidence ----------

def _longest_zero_run(ep):
    """Longest stretch of consecutive flagged hours whose reading is exactly 0."""
    run = best = 0
    prev = None
    for ts, a in zip(ep.ts, ep.actual):
        if a == 0:
            run = run + 1 if prev is not None and ts - prev == pd.Timedelta(hours=1) else 1
            prev = ts
        else:
            run, prev = 0, None
        best = max(best, run)
    return best


def _also_flagged(ep, flags):
    """How many other buildings were flagged for the same stream, sign and kind in the same readings."""
    same = flags[(flags.stream == ep.stream.iat[0]) & (flags.sign == ep.sign.iat[0]) & (flags.kind == ep.kind.iat[0])]
    mine = set(ep.ts)
    return sum(len(mine & set(g.ts)) >= max(1, SAME_SHARE * len(ep)) for k, g in same.groupby("building_id")
               if k != ep.building_id.iat[0])


def _solar_context(ep, flags):
    """(worst wet day as a wet_days() row or None, number of solar buildings low in the same days)."""
    wet = _wet_days().loc[ep.ts.min():ep.ts.max()]
    wet = wet[wet.wet]
    return (wet.loc[wet.rain.idxmax()] if len(wet) else None), _also_flagged(ep, flags) + 1


def _solar_evidence(ep, flags, notes):
    """Low solar: an inverter note (equipment_down) or a wet day (weather); localisation boosts whichever has evidence."""
    b, start, end = ep.building_id.iat[0], ep.ts.min(), ep.ts.max() + pd.Timedelta(hours=23)
    pad = pd.Timedelta(hours=NOTE_WINDOW_H)
    out = []
    near = notes[(notes.building_id == b) & (notes.ts >= start - pad) & (notes.ts <= end + pad)]
    for r in near.assign(gap=(near.ts - start).abs()).sort_values("gap").itertuples():
        if any(w in r.note.lower() for w in SOLAR_NOTE_WORDS):
            out.append(("equipment_down", f"staff note ({r.role}, {r.ts:%d %b %H:%M}): '{r.note}'", NOTE_POINTS))
            break
    day, n_low = _solar_context(ep, flags)
    if day is not None:
        out.append(("weather", f"calendar: {day.name:%d %b} rainfall {day.rain:.1f} mm, humidity {day.hum:.0f}% "
                               f"(above the {WET_PERCENTILE * 100:.0f}th percentile so far: {day.rain_p:.1f} mm or {day.hum_p:.0f}%)", CALENDAR_POINTS))
    have = {c for c, _, _ in out}
    if n_low == 1 and "equipment_down" in have:
        out.append(("equipment_down", f"only {b} had low solar in those days (the other solar buildings were normal)", LOCAL_POINTS))
    if n_low >= 2 and "weather" in have:
        out.append(("weather", f"{n_low} solar buildings had low solar on the same days", LOCAL_POINTS))
    return out


def _evidence(ep, flags, notes, cal, day_foot):
    """All evidence for one episode as (cause, fact, points). Every fact is read from the data."""
    b, stream, high = ep.building_id.iat[0], ep.stream.iat[0], ep.sign.iat[0] > 0
    if stream == SOLAR:
        return _solar_evidence(ep, flags, notes)
    hourly_ep = ep.kind.iat[0] == "hourly"
    start, n = ep.ts.min(), len(ep)
    end = ep.ts.max() + pd.Timedelta(hours=0 if hourly_ep else 23)  # a daily reading covers its whole day
    pad = pd.Timedelta(hours=NOTE_WINDOW_H)
    out = []

    # Staff note (never one logged after as_of): one item per cause, the nearest note wins.
    near = notes[(notes.building_id == b) & (notes.ts >= start - pad) & (notes.ts <= end + pad)]
    seen = set()
    for r in near.assign(gap=(near.ts - start).abs()).sort_values("gap").itertuples():
        tag = _tag(r.note)
        # A low reading can only be explained by a meter note: a leak or an event makes readings go up.
        if tag and tag not in seen and (high or tag == "meter_fault") and _note_fits(tag, r.note, stream):
            seen.add(tag)
            cause = "event_surge" if tag == "event" else tag
            out.append((cause, f"staff note ({r.role}, {r.ts:%d %b %H:%M}): '{r.note}'", NOTE_POINTS))

    # Calendar: event/exam day explains a surge; a quiet day with high electricity points to "left on".
    days = cal.loc[start.normalize():end.normalize()]
    if high:
        # A holiday's name (Gandhi Jayanti) is in the event column but is not an event that adds load.
        why_event = [str(x) for x in days[days.day_type != "holiday"].event.dropna().unique()]
        if (days.day_type == "exam").any() and not why_event:
            why_event = ["exam day"]
        if why_event:
            out.append(("event_surge", f"calendar: {'; '.join(why_event[:2])} ({days.index[0]:%d %b})", CALENDAR_POINTS))
        quiet = days[days.day_type.isin(["holiday", "weekend"])]
        if stream == "electricity_kwh" and len(quiet):
            out.append(("left_on", f"calendar: {quiet.day_type.iat[0]} ({quiet.index[0]:%d %b}) but electricity was high", CALENDAR_POINTS))

    # Shift: nobody there at night, or the food court at meal time.
    if high and hourly_ep:
        quiet_cut = QUIET_FOOTFALL * day_foot.get(b, np.nan)
        night = ep[ep.hour.isin(NIGHT_HOURS) & (ep.footfall <= quiet_cut)]
        if len(night) >= NIGHT_MIN_H:
            cause = "leak" if stream == "water_litres" else "left_on"
            out.append((cause, f"{len(night)} of {n} flagged hours fell between 00:00 and 05:00 with footfall "
                               f"<= {quiet_cut:.0f}/h (5% of the daytime median)", SHIFT_POINTS))
        meal = ep.hour.isin(MEAL_HOURS).mean()
        if b == "B07" and meal >= MEAL_SHARE:
            out.append(("mess_rush", f"{meal:.0%} of the flagged hours fell in Food Court meal hours", SHIFT_POINTS))

    # Extreme readings: far beyond anything a real load does, or a flat zero for hours.
    if hourly_ep:
        ratio = (ep.actual / ep.expected.where(ep.expected > 0)).median()
        if high and ratio >= EXTREME_RATIO:
            out.append(("meter_fault", f"median flagged reading was {ratio:.0f}x expected (rule: {EXTREME_RATIO}x or more)", EXTREME_POINTS))
        run = _longest_zero_run(ep)
        if not high and run >= ZERO_RUN_H:
            out.append(("meter_fault", f"meter read exactly 0 for {run} flagged hours in a row while {ep.expected.median():,.0f} was usual", EXTREME_POINTS))

    # Localisation: one building (equipment) versus the whole campus (event). Only boosts causes that
    # already have other evidence: an isolated flag alone does not say what went wrong.
    also = _also_flagged(ep, flags)
    if high:
        if also == 0:
            have = {c for c, _, _ in out}
            for cause in LOCAL_CAUSES[stream]:
                if cause in have:
                    out.append((cause, f"only {b} was flagged for {STREAM_NAME[stream]} in those hours", LOCAL_POINTS))
        elif also >= 2 and any(c == "event_surge" for c, _, _ in out):
            out.append(("event_surge", f"{also + 1} buildings were flagged for {STREAM_NAME[stream]} at the same time", LOCAL_POINTS))
    elif also == 0 and any(c == "meter_fault" for c, _, _ in out):
        out.append(("meter_fault", f"only {b} was flagged for {STREAM_NAME[stream]} in those hours", LOCAL_POINTS))
    return out


def _pick_cause(items):
    """Winner and runner-up by total points; ties go to CAUSE_ORDER."""
    pts = {}
    for cause, _, p in items:
        pts[cause] = pts.get(cause, 0) + p
    ranked = sorted(pts, key=lambda c: (-pts[c], CAUSE_ORDER.index(c)))
    if not ranked:
        return "unexplained", 0, None
    runner = {"cause": ranked[1], "points": pts[ranked[1]]} if len(ranked) > 1 else None
    return ranked[0], pts[ranked[0]], runner


# ---------- step 4: money and action ----------

def _money(cause, stream, high, excess):
    """(kWh at stake, rupees, co2 kg, how it was worked out). Meter faults and low readings are not real use."""
    if stream == SOLAR:  # excess = lost generation, bought from the grid instead; weather cannot be fixed
        if cause == "weather":
            return 0.0, 0.0, 0.0, f"{excess:,.0f} kWh of solar lost to weather: nothing to fix, no rupees counted"
        return excess, excess * RS_PER_KWH, excess * CO2_PER_KWH, (f"{excess:,.0f} kWh lost x Rs {RS_PER_KWH} = Rs {excess * RS_PER_KWH:,.0f}; "
                                                                 f"x {CO2_PER_KWH} kg = {excess * CO2_PER_KWH:,.0f} kg CO2")
    if cause == "meter_fault" or not high or stream in DAILY_STREAMS:
        return 0.0, 0.0, 0.0, "no rupees counted: " + ("a meter fault is not real consumption" if cause == "meter_fault"
                              else "a low reading is not extra consumption" if not high
                              else "the dataset gives no landfill or contamination cost")
    if stream == "water_litres":
        kwh = excess / 1000 * KWH_PER_KL_WATER
        calc = f"{excess:,.0f} L / 1000 x {KWH_PER_KL_WATER} kWh = {kwh:,.1f} kWh; "
    else:
        kwh, calc = excess, f"{excess:,.0f} kWh; "
    return kwh, kwh * RS_PER_KWH, kwh * CO2_PER_KWH, calc + f"x Rs {RS_PER_KWH} = Rs {kwh * RS_PER_KWH:,.0f}; x {CO2_PER_KWH} kg = {kwh * CO2_PER_KWH:,.0f} kg CO2"


def _action(cause, b, name, stream, high, e):
    """One short, concrete instruction. e holds excess/actual/expected for the episode."""
    where, amt = f"{b} {name}", f"{e['excess']:,.0f} {UNIT[stream]}"
    if stream == SOLAR and cause == "weather":
        return (f"No action: low solar on a rainy day ({e['rain']:.1f} mm) across {e['n_low']} building{'s' * (e['n_low'] > 1)}; "
                f"{amt} bought from the grid instead.")
    if stream == SOLAR and cause == "equipment_down":
        return f"Call vendor to reset/repair the {b} rooftop solar inverter; {amt} of solar lost so far (bought from the grid)."
    if cause == "meter_fault":
        return (f"Check or recalibrate the {where} {STREAM_NAME[stream]} meter: it read {e['actual']:,.0f} vs "
                f"{e['expected']:,.0f} {UNIT[stream]} usual. Not counted as savings.")
    if cause == "leak":
        return f"Send plumber to check {where} water lines and tanks; {amt} above normal so far."
    if cause == "left_on":
        return f"Switch off AC and lights in {where} when it is empty; {amt} above normal so far."
    if cause == "equipment_down" and stream == "landfill_kg":
        return f"Repair {b} composter; {amt} above normal went to landfill."
    if cause == "equipment_down" and stream == "contamination_pct":
        return f"Fix the {b} composter and re-brief staff on segregation; contamination was {e['actual']:.0f}% vs {e['expected']:.0f}% usual."
    if cause == "equipment_down":
        return f"Inspect {where} equipment (pumps, motors, inverter); {amt} above normal."
    if cause == "event_surge":
        return f"Plan for the extra load at {where} on event and exam days, and switch off idle loads when it ends; {amt} above normal."
    if cause == "mess_rush":
        return f"Stagger {where} cooking and switch off idle kitchen equipment between meal peaks; {amt} above normal."
    return f"Investigate {where} {STREAM_NAME[stream]}: no staff note or event explains it. Ask the building supervisor."


def _why(rec):
    """Plain-text justification built only from the evidence. P2's Claude rephrasing when USE_TEAM."""
    if USE_TEAM:
        try:
            from explain import why
            return why(rec)
        except Exception:
            pass
    first = f"{rec['building_id']} {STREAM_NAME[rec['stream']]} was {rec['unusual']}."
    if rec["cause"] == "unexplained":
        return first + " No staff note, calendar event or shift pattern explains it, so it needs a manual check."
    facts = "; ".join(f for f, _ in rec["evidence"])
    text = f"{first} Most likely {CAUSE_TEXT[rec['cause']]} ({rec['confidence'] * MAX_POINTS:.0f}/{MAX_POINTS} points): {facts}."
    if rec["runner_up"]:
        text += f" Runner-up: {CAUSE_TEXT[rec['runner_up']['cause']]} ({rec['runner_up']['points']}/{MAX_POINTS})."
    return text


# ---------- public API ----------

def _episodes(as_of, lookback_h):
    """Attribute every episode that ended inside the window. Returns a list of recommendation dicts."""
    as_of = pd.Timestamp(as_of)
    hourly_flags, day_foot = _hourly_flags(as_of)
    daily_flags = _daily_flags(as_of)
    notes = manual_logs()
    notes = notes[(notes.stream == "note") & (notes.ts <= as_of)]  # no future notes
    cal = calendar().set_index("date")
    names = _building_names()
    flags = pd.concat([_with_episode_ids(hourly_flags, pd.Timedelta(hours=EPISODE_GAP_H)),
                       _with_episode_ids(daily_flags, pd.Timedelta(days=DAILY_GAP_DAYS)).assign(ep=lambda d: d.ep + 10**6)])
    keep = {"hourly": as_of - pd.Timedelta(hours=lookback_h),
            "daily": as_of.normalize() - pd.Timedelta(days=lookback_h // 24)}
    recs = []
    for _, ep in flags.groupby("ep"):
        if ep.ts.max() < keep[ep.kind.iat[0]]:
            continue
        b, stream, high = ep.building_id.iat[0], ep.stream.iat[0], ep.sign.iat[0] > 0
        items = _evidence(ep, flags, notes, cal, day_foot)
        cause, points, runner = _pick_cause(items)
        agg = "mean" if stream == "contamination_pct" else "sum"
        e = {"actual": getattr(ep.actual, agg)(), "expected": getattr(ep.expected, agg)(),
             "excess": getattr((ep.actual - ep.expected).clip(lower=0), agg)()}
        if stream == SOLAR:  # a low reading's "excess" is the generation lost
            day, e["n_low"] = _solar_context(ep, flags)
            e["excess"], e["rain"] = (ep.expected - ep.actual).clip(lower=0).sum(), 0 if day is None else day.rain
        if not high and cause == "unexplained":
            continue  # a low reading with no sign of a meter fault is not an action (see anomalies())
        kwh, rupees, co2, calc = _money(cause, stream, high, e["excess"])
        worst = ep.loc[ep.z.abs().idxmax()]
        hour = None if ep.kind.iat[0] == "daily" else int(worst.hour)
        conf = points / MAX_POINTS
        rec = {
            "building_id": b, "building_name": names.get(b, b), "cause": cause,
            "runner_up": runner,
            "evidence": [(f, p) for c, f, p in items if c == cause] or [("No staff note, calendar event or shift pattern matches", 0)],
            "confidence": conf, "stream": stream, "kind": ep.kind.iat[0],
            "start": ep.ts.min(), "end": ep.ts.max(), "hours": len(ep) * (24 if ep.kind.iat[0] == "daily" else 1),
            "actual": e["actual"], "expected": e["expected"], "excess": e["excess"],
            "unusual": _unusual(worst.actual, worst.expected, hour, worst.dayclass),
            "rupees_saved": round(rupees, 2), "co2_kg": round(co2, 2), "kwh_at_stake": round(kwh, 2),
            "how_computed": calc, "score": round(rupees * conf, 2),
            "runner_up_evidence": [(f, p) for c, f, p in items if runner and c == runner["cause"]],
        }
        rec["action"] = _action(cause, b, rec["building_name"], stream, high, e)
        recs.append(rec)
    return recs


def recommend(as_of, top=5):
    """Top actions at as_of. Each is a dict with the schema keys rank, building_id, cause, runner_up
    ({"cause", "points"} or None), evidence [(fact, points)], confidence (0-1), action, why, rupees_saved, co2_kg,
    plus stream, kind ("hourly" or "daily"), start, end, hours (flagged hours; 24 per flagged day for daily),
    actual, expected, excess (summed over flagged readings; contamination is a mean), unusual, score,
    building_name, kwh_at_stake, how_computed, runner_up_evidence.
    Sorted by score = rupees_saved * confidence, then confidence. Episodes that ended over 7 days ago are dropped."""
    recs = sorted(_episodes(as_of, 168), key=lambda r: (-r["score"], -r["confidence"], r["start"]))[:top]
    # why() only for the ones shown: with USE_TEAM it may be a Claude call.
    out = [{"rank": i, **r} for i, r in enumerate(recs, 1)]
    for rec in out:
        rec["why"] = _why(rec)
    return out


def anomalies(as_of, lookback_h=168):
    """Every flagged hourly and daily reading in the window: building_id, stream, ts, actual, expected, z,
    unusual, kind. Newest first."""
    as_of = pd.Timestamp(as_of)
    hf, _ = _hourly_flags(as_of)
    df = _daily_flags(as_of)
    hf = hf[hf.ts >= as_of - pd.Timedelta(hours=lookback_h)]
    df = df[df.ts >= as_of.normalize() - pd.Timedelta(days=lookback_h // 24)]
    a = pd.concat([hf, df], ignore_index=True)
    a["unusual"] = [_unusual(r.actual, r.expected, None if r.kind == "daily" else int(r.hour), r.dayclass) for r in a.itertuples()]
    cols = ["building_id", "stream", "ts", "actual", "expected", "z", "unusual", "kind"]
    return a[cols].sort_values(["ts", "building_id"], ascending=[False, True]).reset_index(drop=True)


if __name__ == "__main__":
    import time

    REQUIRED = {"rank", "building_id", "cause", "runner_up", "evidence", "confidence", "action", "why",
                "rupees_saved", "co2_kg"}
    all_notes = manual_logs()
    all_notes = all_notes[all_notes.stream == "note"]

    def pick(recs, building, stream):
        return next(r for r in recs if r["building_id"] == building and r["stream"] == stream)

    # B04 power analyzer calibration: ~380 vs ~25 kWh all day, a meter fault, not real consumption
    r = pick(recommend("2026-08-28 06:00"), "B04", "electricity_kwh")
    assert r["cause"] == "meter_fault" and r["rupees_saved"] == 0 and r["co2_kg"] == 0
    assert any("calibrated" in f for f, _ in r["evidence"]) and r["confidence"] == 0.75
    print("OK B04 2026-08-27: meter_fault, rank", r["rank"], "| Rs 0 |", r["unusual"])

    # B03 holiday, AC and lights left on (the note is logged at 19:05, so it only counts after that)
    r = pick(recommend("2026-10-03 06:00"), "B03", "electricity_kwh")
    assert r["cause"] == "left_on" and any("left ON" in f for f, _ in r["evidence"]) and r["rupees_saved"] > 0
    early = pick(recommend("2026-10-02 12:00"), "B03", "electricity_kwh")
    assert early["cause"] == "left_on" and not any("left ON" in f for f, _ in early["evidence"])
    print(f"OK B03 2026-10-02: left_on, {r['confidence']:.2f} confidence with the note, {early['confidence']:.2f} before it")

    # B02 water meter stuck at 0 (low side)
    r = pick(recommend("2026-09-05 06:00"), "B02", "water_litres")
    zeros = anomalies("2026-09-05 06:00").query("building_id == 'B02' and stream == 'water_litres' and actual == 0")
    assert r["cause"] == "meter_fault" and r["rupees_saved"] == 0 and len(zeros) >= 24 and (zeros.z < 0).all()
    print("OK B02 2026-09-03/04: meter_fault, Rs 0,", len(zeros), "flagged zero hours")

    # B06 leak, 2026-08-04 .. 08-09
    r = recommend("2026-08-07 20:00")[0]
    assert (r["building_id"], r["stream"], r["cause"]) == ("B06", "water_litres", "leak") and r["rupees_saved"] > 0
    print("OK B06 leak: rank 1 at 2026-08-07 20:00, Rs", r["rupees_saved"])

    # B05 composter down, 2026-09-07 .. 09-14, shows in landfill_kg
    r = pick(recommend("2026-09-10 06:00", top=20), "B05", "landfill_kg")
    assert r["cause"] == "equipment_down" and r["rupees_saved"] == 0 and "composter" in r["action"]
    print("OK B05 composter: equipment_down, landfill action:", r["action"])

    # B04 rooftop solar inverter dead 2026-10-06 .. 10-08 (note 10-07 11:30): solar_kwh is exactly 0, rupees count
    r = pick(recommend("2026-10-09 06:00"), "B04", "solar_kwh")
    assert r["cause"] == "equipment_down" and r["kind"] == "daily" and r["rupees_saved"] > 0 and r["excess"] > 0
    assert "inverter" in r["action"] and f"{r['excess']:,.0f} kWh" in r["action"] and r["rank"] == 1
    assert abs(r["rupees_saved"] - r["excess"] * RS_PER_KWH) < 0.01 and abs(r["co2_kg"] - r["excess"] * CO2_PER_KWH) < 0.01
    assert any("red error light" in f for f, _ in r["evidence"])
    sol = anomalies("2026-10-09 06:00").query("stream == 'solar_kwh' and building_id == 'B04' and ts >= '2026-10-06'")
    assert len(sol) == 3 and (sol.actual == 0).all() and (sol.z < 0).all()
    assert not any("reset by vendor" in f for f, _ in r["evidence"])  # that note is only logged on 10-09 at 15:00
    # a rainy day: all solar buildings low, weather, nothing to fix, lost kWh stated
    w = [x for x in recommend("2026-10-09 06:00", top=50) if x["stream"] == "solar_kwh" and x["cause"] == "weather"]
    assert w and all(x["rupees_saved"] == 0 and "No action" in x["action"] and "mm" in x["action"] for x in w)
    print(f"OK B04 solar 2026-10-06..08: equipment_down, Rs {r['rupees_saved']:,.0f}; weather episodes: {len(w)}, e.g. {w[0]['action']}")

    # Shape, ordering, and no future leakage, at the 3 demo times and just before every note
    times = ["2026-08-07 20:00", "2026-08-28 06:00", "2026-10-03 06:00"]
    times += [str(t - pd.Timedelta(minutes=1)) for t in all_notes.ts]
    for t in times:
        recs = recommend(t, top=5)
        assert len(recs) <= 5 and [x["rank"] for x in recs] == list(range(1, len(recs) + 1))
        assert [(x["score"], x["confidence"]) for x in recs] == sorted([(x["score"], x["confidence"]) for x in recs], reverse=True)
        for x in recs:
            assert REQUIRED <= set(x) and 0 <= x["confidence"] <= 1 and x["why"] and x["action"]
        later = all_notes[all_notes.ts > pd.Timestamp(t)].note
        text = " ".join(f for x in recommend(t, top=50) for f, _ in x["evidence"] + [(x["why"], 0)])
        assert not any(n in text for n in later), t
        a = anomalies(t)
        assert (a[a.kind == "hourly"].ts <= pd.Timestamp(t)).all()
        assert (a[a.kind == "daily"].ts < pd.Timestamp(t).normalize()).all()
    print("OK shape, order, no future notes or readings at", len(times), "times")

    t0 = time.time()
    for t in times[:6]:
        recommend(t)
    print(f"recommend() runtime: {(time.time() - t0) / 6 * 1000:.0f} ms per call (single core, 6 calls)")
    print("all checks passed")
