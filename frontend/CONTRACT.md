# Frontend ↔ backend contract

The UI runs on mock data by default (`public/mock/*.json`, built by `npm run fixtures`).
To use the real Python functions, run FastAPI on `:8000` and start the UI with `VITE_API_MODE=live`.
Vite proxies `/api/*` to `http://localhost:8000`. Field names match the team brief; full types are in `src/api/types.ts`.

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
