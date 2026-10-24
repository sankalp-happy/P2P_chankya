# P3 handoff: data, offline handling, leaderboard

You now own `ingest.py`, `edge_buffer.py` and `incentives.py`. Only edit those (plus `docs/P3_*`); see `claude.md` for team rules.
Each file has a self-check. Run all three before you change anything:

```bash
python3 ingest.py && python3 edge_buffer.py && python3 incentives.py
```

All three pass as of this commit. The data is read from `datasets/raw/` (`ingest.DATA`).

## What each file gives the team

| Function | Returns | Used by |
|---|---|---|
| `ingest.load_hourly(as_of=None)` | building_id, ts, electricity_kwh, water_litres, solar_kwh, footfall, status. One row per building-hour on the full grid up to as_of. Never NaN. | P1 forecast, P4 cards |
| `ingest.building_status(as_of)` | building_id, last_reading_ts, offline, since. Card text: "offline since HH:MM, showing estimate". | P4 |
| `ingest.load_manual_logs()` | ts, building_id, stream, value, unit, note, role, + log_id, building_raw, value_raw, unit_raw (before/after view) | P1 causes, P4 |
| `ingest.load_daily()`, `load_calendar()`, `load_buildings()` | the CSVs, dates parsed | everyone |
| `edge_buffer.outage_table()` | building_id, start, end, hours, arrived_late, lost | P4 connectivity + alerts |
| `edge_buffer.simulate_outage(b, start_ts, hours)` | dict: buffered, duplicates_dropped, gaps_filled, totals_before, totals_during, totals_after, matches | P4 "take B03 offline" button |
| `edge_buffer.source_check()` | building_id, date, stream, meter, daily_summary, staff_log, disagrees, + trusted, trusted_source, pct_diff, detail | P4 alerts page |
| `incentives.leaderboard(as_of)` | building_id, expected, actual, occupancy_adjustment, pct_saved, credits, rank, coverage_pct, + per-stream {kwh,litres,landfill_kg}_{expected,actual,pct_saved}, week_start, week_end, reason | P4 leaderboard |
| `incentives.weekly_note(as_of)` | building_id, rank, credits, biggest_waste, one_thing_to_do, text | P4 |
| `incentives.IMPACT_DESIGN`, `incentives.placebo_test()` | how we'd measure impact; the noise floor from our data | report |

Everything after "+" is an addition beyond `schema.py` in PLAN.md. P4 has not been told about these yet: tell them.

## Key decisions (be ready to defend these)

- **Dedup key** = (building_id, ts), keep the earliest `received_at`. Retransmissions have jittered values, so whole-row dedup misses them. 23,192 rows become 23,008.
- **Status** per row: `measured` (on time), `revised` (arrived > 2 h late, replaced an estimate), `filled` (lost hour or blank cell; ≤ 3 h gap = straight line, longer = daily_summary total spread by the hour-of-day profile), `estimated` (not received yet at as_of; typical value). Counts on the full data: measured 22,691, revised 112, filled 237 (32 lost hours + 205 rows with a blank cell).
- **Replay by arrival time**: at slider time T, only readings received by T count. Each value has a `known_at`; long-gap fills are known only after the day closes (daily total).
- **P1 contract** (agreed with P1's session): measured + revised rows equal P1's own dedup filtered by received_at ≤ as_of. P1 NaNs everything else. Asserted in `ingest._selfcheck_hourly`.
- **Speed**: `load_hourly` is cached per as_of (lru_cache, 4 entries) and returns a copy: 0.9 ms per call. P1 calls it 16× per slider move.
- **Outage simulation** uses SQLite `INSERT OR IGNORE` (first arrival wins), not `INSERT OR REPLACE` as PLAN.md says: with jittered retries, REPLACE overwrote true values and totals drifted (tested). B03 demo: 12 buffered, 4 duplicates dropped, totals match exactly.
- **Fusion**: trust meter > daily summary > staff log; > 20% disagreement raises an alert, nothing is overwritten. Staff "waste" logs match wet + dry + ewaste + hazardous (median ratio 1.035). Smart bins see ~1% of the mass, so they are compared by composition share per building-week (20 percentage points). E-waste share is not compared (daily summary logs e-waste on only 29 of 960 days).
- **Leaderboard**: electricity = grid + own solar (weather doesn't earn credits); water; landfill. Each vs the building's frozen per-person normal for that day type (baseline 20 Jun – 16 Aug), scaled by occupancy. expected = 100 (index), pct_saved = 100 − actual. 1 credit per 1%, max 10/week; none under 90% coverage; flat-lined meters (same reading ≥ 24 h) don't count (catches B02's water meter stuck at 0 on 3–4 Sep); weeks overlapping the baseline earn 0.
- **No saving claimed**: our data predates any scheme. The placebo test (DiD with no scheme) swings by about 27–35 percentage points over 4-week windows, so a 4-week trial could only detect a very large effect.

## Numbers from the data

184 duplicate rows; 32 lost building-hours in 7 gaps (1, 2, 4, 4, 7, 7, 7 h); 112 late readings in 26 bursts; 33 outages, longest 11 h (B04 4 Sep, B03 30 Sep); 37 building spellings in staff logs; 20 staff unit mistakes and 5 wrong-building suspects (the 959,417 L water log is 10× the meter: an extra digit); 117 source disagreements in total (electricity 5, water 7, waste 28, food share 43, dry share 34).

## Open items, in priority order

1. **Tell P1** that `forecast.py` still points at `P2P_DATASET/` (moved to `datasets/raw/`). Until they fix it, their `USE_TEAM` switch and `attribution.recommend()` fail, and `weekly_note` falls back to the worst-stream text instead of P1's top action. It's P1's file: don't edit it.
2. **Tell P4** about the extra functions and columns in the table above.
3. **Report draft** `docs/P3_REPORT_DRAFT.md`: fill `[[N_LOW_COVERAGE_WEEKS]]` (building-weeks under 90% coverage, from `leaderboard()` over every week), `[[CLAUDE_AI_SHARE_LINK]]`, and the `[[TO FILL after review]]` fields in the prompt-log entry. What went wrong to record there: the brief's late count (296 raw vs 112 after dedup), missed blank cells (205 rows), and noisy e-waste share alerts (removed). Give the prompt-log entry to P2 for `docs/promptlog.md`.
4. Known limits, marked with `# ponytail:` comments in the code: the typical profile uses the whole period (display only, never used for training); waste-share alerts are noisy (30–40% of weeks) because bins are a ~1% sample, so show them as information, not urgent alerts; B02's water pct_saved is inflated on the stuck-meter week (credits are still blocked by coverage).

## API for the React UI (`api.py`)

FastAPI backend for `frontend/` (routes in `frontend/CONTRACT.md`, shapes in `frontend/src/api/types.ts`). It wraps everyone's functions; all field mapping lives in `api.py`, nobody else's file changes.

Needs FastAPI ≥ 0.162 (0.110 crashes with Starlette 1.x: `pip3 install -U fastapi`).

```bash
python3 -m uvicorn api:app --port 8000
```

Then, in another terminal:

```bash
cd frontend && VITE_API_MODE=live npm run dev
```

Mappings: `status` → `quality` (measured/revised = real, filled = filled, estimated = missing) plus `received_at`; classifier `classes` → `class_names`, tuple or dict accepted for `predict()`/`classifier_metrics()`; forecast-metrics = one row per method, `error` = mean normal-day % error at 12 h over both streams; UI stream `electricity`/`water` ↔ `electricity_kwh`/`water_litres`; recommend evidence as "fact (+points)" strings; timestamps `YYYY-MM-DD HH:MM`, NaN → null.
Speed: static routes are built once at startup. The first `/api/forecast` per building + time takes 1.7–4 s (P1's model), then it's cached. P2's classifier is imported lazily, so if `src/classifier.py` breaks, only its two routes return 503.
