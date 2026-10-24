# Frontend ↔ backend contract

The UI talks to the team backend, repo-root `api.py` (P3), started with `uvicorn api:app --port 8000`
from the repo root. Its routes carry the `/api` prefix; Vite proxies `/api/*` to `:8000` unchanged, in both
`npm run dev` and `npm run demo`.

Every route below is called live. If the backend is down or a call fails, that call falls back to mock data
(built from the real dataset) and the backend is retried after 15 s. `VITE_API_MODE=mock` forces mock everywhere.
Field names match the team brief; full types are in `src/api/types.ts`.

| Route | Python function | Returns |
|---|---|---|
| `GET /api/buildings` | buildings.xlsx | `Building[]` |
| `GET /api/calendar` | calendar.xlsx | `CalendarDay[]` |
| `GET /api/bin-events` | waste_events_test.xlsx | `BinEvent[]` |
| `GET /api/hourly` | `load_hourly()` | `building_id, ts, electricity_kwh, water_litres, solar_kwh, footfall, quality` (+ optional `received_at`) |
| `GET /api/daily` | `load_daily()` | daily_summary columns as-is |
| `GET /api/manual-logs` | `load_manual_logs()` | `ts, building_id, stream, value, unit, note` |
| `GET /api/forecast?building_id&stream&as_of&horizon=12` | `forecast()` | `ts, predicted, low, high, is_spike` |
| `GET /api/forecast-history?building_id&stream&start&end` | optional | `ts, predicted` (faint ghost line; chart works without it) |
| `GET /api/recommend?as_of&top=5` | `recommend()` | `rank, building_id, cause, action, why, rupees_saved, co2_kg` (+ optional `stream, evidence[]`) |
| `GET /api/leaderboard?as_of` | `leaderboard()` | `building_id, expected, actual, pct_saved, credits, rank, coverage_pct` (+ optional `expected_low, expected_high, simulated`) |
| `POST /api/outage` `{building_id, start_ts, hours}` | `simulate_outage()` | `buffered, duplicates_dropped, gaps_filled, totals_before, totals_after` |
| `GET /api/outages` | `outage_table()` | `building_id, start, end, hours` |
| `GET /api/forecast-metrics` | `forecast_metrics()` | `[{method, error, size_kb, time_ms}]` |
| `POST /api/predict` (a `BinEvent`) | `predict()` | `label, confidence, time_ms, route` |
| `GET /api/classifier-metrics` | `classifier_metrics()` | `accuracy, macro_f1, confusion (6×6), class_names, size_kb, time_ms` |

Timestamps are `"YYYY-MM-DD HH:MM"`, campus local time. `stream` is `electricity` or `water`.
Sprites go in `public/sprites/<name>.png` (see names in `src/lib/constants.ts` and `src/components/Shell.tsx`).
