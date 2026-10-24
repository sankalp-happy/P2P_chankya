# Live API: what the backend sends and what the UI reads

Single reference for `VITE_API_MODE=live`. Backend: `api.py` (owner P3, FastAPI on :8000). UI: `frontend/` (owner P4 / dripston), types in `frontend/src/api/types.ts`.
`frontend/CONTRACT.md` is the original wish-list. This file records what `api.py` **actually returns** and, for every gap, **which side changes**.

Status: **agreed with P3 on 2026-10-24 ~14:00.** Checked against the running server (all routes 200). The API side is done. Everything still open is a **UI change (dripston)**, collected in the [UI to-do](#ui-to-do-dripston) at the end. P3 edits this file when `api.py` changes.

Conventions
- Timestamps: `"YYYY-MM-DD HH:MM"`, campus local time. Dates: `"YYYY-MM-DD"`. Exception: `/api/bin-events` keeps the raw `timestamp` with seconds (`"2026-06-20 10:38:58"`), and the UI only slices it, so that's fine.
- `NaN`/`NaT` are sent as `null`.
- `stream` query param: `electricity` | `water` (the API maps these to `electricity_kwh` / `water_litres`). Anything else returns 400.
- Errors: 400 with `{"detail": "..."}` for a bad `building_id`/`stream`/outage request. 503 from `/api/predict` and `/api/classifier-metrics` if P2's classifier fails to import (the other routes keep working).
- Fields beyond `types.ts` are passed through. TypeScript ignores them until the UI adds them to the types.

Legend: ✅ matches the UI · 🟡 works, but the UI should show a field the judges want · 🔴 the UI shows something wrong until changed

---

## Static data (built once at startup, cached)

| Route | Source | Fields sent | UI type | Status |
|---|---|---|---|---|
| `GET /api/buildings` | `ingest.load_buildings()` | building_id, building_name, building_type, floors, area_sqm, design_capacity, has_solar, solar_capacity_kw, year_built, has_composter | `Building` | ✅ |
| `GET /api/calendar` | `ingest.load_calendar()` | date, day_of_week, day_type (`working`/`weekend`/`holiday`/`exam`/`semester_break`), event, avg_temp_c, rainfall_mm, humidity_pct | `CalendarDay` | ✅ |
| `GET /api/daily` | `ingest.load_daily()` | date, building_id, occupancy_avg, electricity_kwh, water_litres, solar_generation_kwh, wet_organic_kg, dry_recyclable_kg, ewaste_kg, hazardous_kg, composted_kg, recycled_kg, contamination_pct, landfill_kg | `DailyRow` | ✅ |
| `GET /api/bin-events` | `waste_events_test.csv` | event_id, timestamp, building_id, bin_id, weight_g, moisture_pct, metal_signal, transparency, acoustic_hardness | `BinEvent` | ✅ |
| `GET /api/manual-logs` | `ingest.load_manual_logs()` | ts, building_id, stream (`electricity`/`water`/`waste`/`note`), value, unit (already normalised to `L`/`kWh`/`kg`), note, logger_role, log_id, building (raw spelling), value_raw, unit_raw | `ManualLog` (+extras) | ✅ (extras unused; the UI could show raw→clean for the "messy staff logs" story) |
| `GET /api/hourly` | `ingest.load_hourly()` | building_id, ts, electricity_kwh, water_litres, solar_kwh, footfall, **status**, quality, received_at | `HourlyRow` | 🟡 H1 |
| `GET /api/outages` | `edge_buffer.outage_table()` | building_id, start, end, hours, arrived_late, lost | `OutageRow` (+extras) | ✅ (33 rows) |
| `GET /api/forecast-metrics` | `forecast.forecast_metrics()`, 12 h rows, mean of both streams | method, error (normal-day % error), error_exam, size_kb, time_ms | `ForecastMethodMetrics` | 🔴 M1 |
| `GET /api/classifier-metrics` | `src/classifier.classifier_metrics()` | accuracy, macro_f1, confusion (6×6), classes, class_names, accuracy_per_class, sensor_importance, size_kb, time_ms, not-sure stats, model comparison table | `ClassifierMetrics` | 🟡 C1 |

**H1 – hourly status.** One full-period payload (23,040 rows, ~3 MB), built at startup. The UI replays it by `received_at`. This is final.
- `status` = `measured` | `revised` | `filled`. `quality` = `real` | `filled` only ('missing' never appears).
- `received_at` is **never null**. For a real reading it's the arrival time. For a filled hour it's when the server could show the fill: the next reading's arrival, or, for gaps over 3 h, after the day closed (filled from the daily total). So the UI's rule "arrived once `received_at <= now`" already makes lost hours replay as offline/estimate. ✅
- 🟡 **UI:** add `status?: 'measured'|'revised'|'filled'` to `HourlyRow` and show a "revised" chip on cards (judged: live / offline / estimated / revised).

**M1 – forecast metrics.** Real values at 12 h ahead (normal-day % error, mean of both streams):

| method | error % | size_kb | time_ms |
|---|---|---|---|
| simple guess | 16.44 | 0.00 | 0.01 |
| our model | 11.34 | 420.9 | 7.41 |
| our model, no retraining | 11.93 | 422.7 | 7.79 |
| small model | 11.95 | 76.4 | 4.39 |

- 🔴 **UI:** the "ours" highlight is `method.startsWith('Our')`, but live names are lowercase. Compare case-insensitively.
- A Chronos row appears only if P2 writes `models/chronos_metrics.json` (not there now). **UI:** never show the mock's Chronos numbers (7.1 % / 478 MB / 860 ms are invented). Show a Chronos row only when the API sends one.

**C1 – classifier metrics.**
- ✅ `class_names` order from the real model: `ewaste, food_organic, glass, metal, paper_cardboard, plastic`. This is not the mock's order, but `SmartBin.tsx:331-347` already labels the matrix from `m.class_names`.
- 🟡 **UI:** add `sensor_importance` and `accuracy_per_class` to `ClassifierMetrics` and render sensor importance (judged requirement).

---

## Per slider position (`as_of` = the time-control hour)

### `GET /api/forecast?building_id&stream&as_of&horizon=12` → `forecast.forecast()`
Fields: ts, predicted, low, high, is_spike, **simple_guess**, **reasons** (string, e.g. `"weekend: Mid-semester exams end (Sat)"`).
- 🟡 **UI:** add `simple_guess?: number` and `reasons?: string` to `ForecastPoint`, draw the simple guess as a comparison line, and show `reasons` on spike points/alerts (judged: "simple guess for comparison, reasons for a spike").
- The first `ts` is the first hour **without a reading** (as_of 14:00 → 13:00 … 00:00 next day), not as_of+1 (P1's design). The chart must not assume as_of+1.
- Cost: the first call per building + hour takes **1.7–4 s** (P1's model), then 3 ms cached. One slider step = 16 calls (8 buildings × 2 streams, `Insights.tsx`). `api.py` keeps 256 results = 16 slider hours. **Before recording, pre-warm the demo window** (curl the hours you'll play through), or Play will stutter.

### `GET /api/forecast-history?building_id&stream&start&end`
Fields: ts, predicted (our model's 12 h-ahead walk-forward prediction). **Only 28 Sep – 17 Oct** (the test window), and `[]` before that, so the ghost line disappears earlier. Record the demo inside this window. ✅ (optional by contract)

### `GET /api/recommend?as_of&top=5` → `attribution.recommend()`
Fields: rank, building_id, building_name, cause (code), **cause_label**, action, why, rupees_saved, co2_kg, **stream** (`electricity`/`water`/**null**), **metric** (`electricity_kwh`/`water_litres`/`solar_kwh`/`landfill_kg`), evidence (`["<fact> (+<points>)", …]`), runner_up, runner_up_evidence (same format), confidence (0–1), how_computed (e.g. `"905 kWh lost x Rs 8 = Rs 7,238; x 0.7 kg = 633 kg CO2"`), kind, start, end, hours, actual, expected, excess, unusual, kwh_at_stake, score.
- Cause codes: `leak`, `left_on`, `weather`, `equipment_down`, `meter_fault`, `event_surge`, `mess_rush` (plus `unexplained`). `cause_label` is P1's text for each.
- 🔴 **UI:** `Insights.tsx:74` title shows `r.cause`, so use `r.cause_label ?? r.cause`. `Insights.tsx:77` appends `r.stream`; show `metric` when `stream` is null. `setStream(r.stream)` is already guarded by `if (r.stream)`, so null is safe.
- 🟡 **UI:** show `runner_up` + `runner_up_evidence`, `confidence`, and `how_computed` (judged: "why, evidence checklist with points, runner-up cause, confidence, ₹ + CO2").
- It can return fewer than `top` items. Cost: ~1 s first call.

### `GET /api/leaderboard?as_of` → `incentives.leaderboard()`
Fields: building_id, **expected = 100, actual = index** (100 = the building's own normal for that day type and occupancy), occupancy_adjustment, pct_saved, credits (int), rank, coverage_pct, kwh_expected, kwh_actual, kwh_pct_saved, litres_expected, litres_actual, litres_pct_saved, landfill_kg_expected, landfill_kg_actual, landfill_kg_pct_saved, week_start, week_end, reason (e.g. `"coverage 69% < 90%: no credits"`, `"baseline period"`, `"used more than normal"`). No `simulated`, no `expected_low/high`.
- Credits rule (`incentives.py`): `credits = floor(pct_saved)` clipped to 0–10. That's 0 if coverage < 90 % or in a baseline week. The week is the 7 days **ending the day before** `as_of`.
- 🔴 **UI:** `League.tsx:201` prints `{actual} / {expected} kWh`, which reads "94 / 100 kWh". Label it as an index ("94 vs own normal 100"). Show kWh / L / landfill rows from the `*_expected/*_actual/*_pct_saved` fields.
- 🔴 **UI:** drop the hard-coded ±3.5 % "noise band: no credits inside" (`League.tsx:183,208`). There's no real band. If a marker is wanted: credits start at pct_saved ≥ 1.
- 🔴 **UI:** `League.tsx:109` caption "credits = ₹1 each · 30 % of verified savings" is wrong. Use "1 credit per 1 % saved vs own normal, max 10 a week, none below 90 % sensor coverage".
- 🟡 **UI:** show `occupancy_adjustment`, `week_start–week_end` and `reason` (judged: "the maths: expected, actual, occupancy adjustment, coverage").
- Cost: ~1.5 s first call.

---

## Actions

### `POST /api/outage` body `{building_id, start_ts, hours}` → `edge_buffer.simulate_outage()`
Fields: buffered, duplicates_dropped, gaps_filled, totals_before, **totals_during**, totals_after, **matches** (bool: after == before). Each totals object = {electricity_kwh, water_litres, solar_kwh, footfall}.
- `totals_during` = the campus totals the server showed while the building was offline, with its hours replaced by estimates (same hour one week earlier).
- Example (B03, 10 Oct 09:00, 3 h): before 759.82 kWh / 20,256 L · during 762.61 / 20,243 · after 759.82 / 20,256 · matches = true.
- 🔴 **UI:** `Offline.tsx:219,229` reads `totals_without_buffer` (mock only) under "No buffer", so the column is empty live. Rename it "During outage (estimate)", read `totals_during`, and use `matches` for the ✓/✕ chip.
- Server upsert is INSERT OR IGNORE (first arrival wins).

### `POST /api/predict` body = a `BinEvent` → `src/classifier.predict()`
Fields: label, confidence, **reason** (`"plastic: transparency 0.81 and hardness 0.63"`), **destination** (`composter B07 (nearest)` / `recycling (plastic)` / `certified e-waste pickup` / `manual sort`), route (`bin`/`manual_sort`), **alert** (text or null: e-waste pickup, unsure item), time_ms. Manual-sort threshold = **0.60**.
- 🟡 **UI:** add `reason`, `destination`, `alert` to `Prediction` and show them per item (judged: "per-item reason, destination, time per item"). Today the UI only picks a sprite from `route`/`label`.
- 🔴 **UI:** `constants.ts` `MANUAL_SORT_BELOW = 0.7` and `Models.tsx:90` "Items under 70 % confidence…" disagree with P2's 0.60.

### `GET /api/alerts?as_of` → one list for the facility alerts panel
Fields: `[{kind, building_id, ts, title, detail}]`, newest first. `kind`:
- `offline`: `ingest.building_status(as_of)`, e.g. "Offline since 09:00, showing estimate"
- `anomaly`: `attribution.anomalies(as_of, 24)`, top 20, e.g. "water: only 59% of the usual for 6 PM on a working or exam day"
- `source_mismatch`: `edge_buffer.source_check()`, disagreeing rows in the 7 days before `as_of`

E-waste and unsure items are **not** included; they come per event from `/api/predict` (`alert`). Cost: 0.2–0.6 s first call, then cached.
- 🟡 **UI:** not in `types.ts`/`live.ts` yet. Add `alerts(as_of)` to `Api` and render one "Facility alerts" panel from it, plus `predict().alert` items from the bin feed. In mock mode keep `lib/alerts.ts`. This panel is one of the three required screenshots.

---

## Hard-coded or mock numbers that must not appear as real in live mode

- `frontend/src/api/mock.ts:608-612` forecast metrics (14.6 / 7.9 / 7.1 %, Chronos 478 MB / 860 ms): invented. Live replaces them (see M1).
- `mock.ts` `leaderboard()`: `SIM_FACTOR` fakes a 5–10 % saving for B03/B05/B06 from 24 Aug (flagged `simulated`). The ±3.5 % band is invented and **stays visible in live mode** until the UI drops it.
- `mock.ts` `recommend()`: rupee/CO2 numbers come from a browser heuristic ("trims an estimated 15 %", "×0.5"). Live replaces them with `attribution.recommend()`.
- `mock.ts` `simulate_outage()`: `duplicates_dropped = 11 %` of buffered, invented. Live replaces it.
- `public/mock/classifier_metrics.json` / `classifier_model.json`: a naive-Bayes stand-in from `build_fixtures.py`, not P2's XGBoost. Live replaces them.
- UI text that **stays hard-coded in live mode**:
  - `Models.tsx:90` "70 % confidence" (real: 60 %).
  - League caption "₹1 each · 30 % of verified savings" (real: 1 credit per 1 % saved, max 10).
  - `Models.tsx:109` "₹25,000 per building … pays back in about two months". OK: the problem statement lets the team choose the budget, and 5 % × 6,000 kWh × ₹8 = ₹2,400 a week, so payback ≈ 10 weeks. Keep it worded as an illustration.

## UI to-do (dripston), ordered by impact on the video and judging

1. League: index label, drop the ±3.5 % band, real credits caption, show occupancy_adjustment / per-stream rows / reason.
2. Recommendations: `cause_label`, `metric` when `stream` is null, plus runner-up, confidence, how_computed.
3. Facility alerts panel from `/api/alerts` + predict `alert` (required screenshot).
4. Offline: "During outage" column from `totals_during`, chip from `matches`.
5. Forecast: simple-guess line + spike `reasons`.
6. Smart bin: per-item `reason`, `destination`, `alert`; threshold 0.60.
7. Models: case-insensitive "our model" highlight; no mock Chronos; sensor importance.
8. Cards: "revised" chip from `status`.
9. `scripts/build_fixtures.py` reads `<repo>/P2P_DATASET/`, which moved to `datasets/raw/`. This only matters when fixtures are rebuilt.

## Run

```
# backend (repo root)
python3 -m uvicorn api:app --port 8000
# frontend
cd frontend && VITE_API_MODE=live npm run dev   # http://localhost:5173, /api proxied to :8000
```
The Vite proxy target `http://localhost:8000` reaches uvicorn's 127.0.0.1 bind (checked with Node 26).
