# Campus Resource Grid — P2P Chanakya

> A live campus energy, water, and waste monitoring dashboard with ML-powered forecasting, anomaly detection, and AI-generated recommendations.

Built for an 8-building campus. Drag a time slider and the whole grid updates — electricity, water, and solar in real time; a 12-hour forecast so spikes show up before they happen; smart-bin waste classification with SHAP explainability; and a leaderboard that rewards buildings for saving.

---

## Features

- **Time-travel dashboard** — a single slider replays the campus at any historical moment, with a "play" mode for live demo walkthroughs.
- **12-hour forecasts** — gradient-boosted model per building and stream, beat against the naive "same hour yesterday" baseline; flags predicted spikes in advance.
- **Anomaly detection & root cause** — unusual readings are scored against a points system (staff notes, calendar events, night-time activity, isolated vs. campus-wide), then surfaced with a rupee and CO₂ saving estimate.
- **Smart-bin waste classifier** — 5-sensor XGBoost model (85.5% accuracy, < 1 ms inference) classifying items into 6 waste types; items below 60% confidence are routed to manual sorting.
- **AI-generated explanations** — Claude Haiku or Groq LLaMA generate a grounded two-sentence "why" for every recommended action; fully offline-safe via a precomputed JSON cache.
- **Offline buffer simulation** — take any building offline for up to 3 hours; buffered readings replay on reconnect with duplicates dropped and campus totals preserved exactly.
- **Leaderboard** — per-building credits normalised by occupancy and day type; no credits awarded during data outages.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  React + Vite frontend  (frontend/)             │
│  Recharts · React Router · TanStack Query       │
│  Mock mode (no server) or live via FastAPI      │
└────────────────┬────────────────────────────────┘
                 │ /api/*  (Vite proxy → :8000)
┌────────────────▼────────────────────────────────┐
│  FastAPI inference server  (src/server.py)      │
│  POST /predict · GET /classifier-metrics        │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│  Python backend modules  (src/)                 │
│  ingest · edge_buffer · incentives              │
│  classifier · explain · forecast · attribution  │
└────────────────┬────────────────────────────────┘
                 │
┌────────────────▼────────────────────────────────┐
│  Data layer                                     │
│  datasets/raw/   — original CSVs + XLSX         │
│  datasets/clean/ — deduplicated, gap-filled     │
│  models/         — waste.joblib + metrics.json  │
│  data/           — why_cache.json, predictions  │
└─────────────────────────────────────────────────┘
```

---

## Repository layout

```
P2P_chankya/
├── src/
│   ├── ingest.py          # Data loading, cleaning, gap-filling, source fusion
│   ├── edge_buffer.py     # Offline simulation, duplicate drop, outage table
│   ├── incentives.py      # Leaderboard, credits, weekly notes
│   ├── classifier.py      # Waste sorter inference (predict / metrics)
│   ├── explain.py         # LLM alert explanations and staff-note tagging
│   ├── server.py          # FastAPI server exposing the classifier + SHAP
│   ├── forecast.py        # Time-series forecasting (P1)
│   └── attribution.py     # Root-cause scoring and recommendations (P1)
├── frontend/              # React + Vite dashboard (P4)
│   ├── src/
│   │   ├── pages/         # Overview, BuildingDetail, SmartBin, Offline, League, Waste, Models
│   │   ├── components/    # Shell, ResourceChart, Insights, animated primitives
│   │   ├── api/           # Mock and live data adapters + TypeScript types
│   │   └── lib/           # Alert rules, dataset helpers, time utilities
│   └── public/mock/       # Static JSON fixtures for offline / demo use
├── datasets/
│   ├── raw/               # Original files from the competition brief
│   └── clean/             # Cleaned CSVs (output of ingest.py)
├── models/
│   ├── waste.joblib        # Trained XGBoost waste classifier (244 KB)
│   └── waste_metrics.json  # 5-fold CV accuracy, confusion matrix, latency
├── data/
│   ├── why_cache.json      # Pre-generated LLM explanations (offline-safe)
│   └── waste_events_test_predictions.csv
├── docs/
│   ├── promptlog.md        # AI usage workbook (required deliverable)
│   ├── CLASSIFIER_REPORT.md
│   ├── P3_HANDOFF.md
│   └── P3_REPORT_DRAFT.md
├── PLAN.md                 # Full project plan, schedule, shared API schema
└── claude.md               # Team rules: file ownership, git, AI usage policy
```

---

## Getting started

### Prerequisites

| Tool | Version |
|---|---|
| Python | 3.11 (recommended) |
| Node.js | ≥ 18 |
| pip packages | see below |

> [!IMPORTANT]
> Use Python 3.11. The `chronos-forecasting` and PyTorch wheels are not yet distributed for Python 3.15 on Windows.

### 1. Install Python dependencies

```bash
pip install pandas openpyxl scikit-learn xgboost shap joblib \
            fastapi uvicorn python-dotenv anthropic groq
```

### 2. Set up API keys (optional — demo works without them)

Create a `.env` file in the project root:

```
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
```

If no key is present, `explain.py` falls back to the precomputed cache in `data/why_cache.json`, then to a deterministic template. The demo never crashes due to a missing key.

### 3. Run the Python backend (inference server)

```bash
cd src
uvicorn server:app --host 127.0.0.1 --port 8000
```

Interactive API docs are available at `http://localhost:8000/docs`.

### 4. Run the frontend

```bash
cd frontend
npm install
npm run dev          # mock data (no backend needed)
# or
VITE_API_MODE=live npm run dev   # connects to the FastAPI server on :8000
```

Open `http://localhost:5173`.

### 5. Rebuild mock fixtures (optional)

If the backend data changes, regenerate the static JSON fixtures used in mock mode:

```bash
cd frontend
npm run fixtures
```

---

## Python modules

### `src/ingest.py`

Loads and cleans the raw hourly sensor data. Call `load_hourly(as_of=None)` to get a DataFrame of every building-hour up to a given timestamp, with all gaps filled and duplicates dropped. Status codes (`measured`, `revised`, `filled`, `estimated`) travel with every row so the dashboard can show data quality.

### `src/edge_buffer.py`

Simulates building outages. `simulate_outage(building_id, start_ts, hours)` takes a building offline, buffers readings in SQLite, then replays them on reconnect — duplicates dropped, campus totals preserved. `outage_table()` returns a summary of every detected outage in the dataset.

### `src/incentives.py`

Computes the weekly leaderboard. Each building is compared against its own baseline for that day type and occupancy level; 1 credit per 1% saved, capped at 10 per week, blocked if sensor coverage falls below 90%.

### `src/classifier.py`

Loads the trained XGBoost model once and exposes two functions matching the shared API schema:

```python
label, confidence, time_ms, route = predict(event)  # route: "bin" | "manual_sort"
accuracy, macro_f1, confusion, classes, size_kb, time_ms = metrics()
```

Items with confidence below 60% are routed to manual sorting.

### `src/explain.py`

Generates explanations for facility alerts and classifies staff notes:

```python
why(recommendation)   # → two-sentence plain-English explanation
tag_note(note)        # → "leak" | "maintenance" | "fest" | "other"
```

Primary model: Claude Haiku. Fallback: Groq LLaMA. Final fallback: deterministic template. All live responses are cached to `data/why_cache.json` so the demo runs fully offline.

### `src/server.py`

FastAPI server wrapping the waste classifier with TreeSHAP explainability and Groq narration. `POST /predict` returns the predicted label, per-feature SHAP values, and a plain-English attribution sentence.

---

## Model cards

### Waste classifier

| | |
|---|---|
| Algorithm | XGBoost (HistGradientBoosting fallback) |
| Features | `weight_g`, `moisture_pct`, `metal_signal`, `transparency`, `acoustic_hardness` |
| Classes | organic food, paper/cardboard, plastic, metal, glass, e-waste |
| 5-fold CV accuracy | **85.51%** |
| Model size | **244 KB** |
| Inference latency | **< 1 ms** (CPU) |
| Low-confidence threshold | 60% — routed to manual sorting |
| Training rows | ~6 300 (after boundary clamping; no rows dropped) |

### Forecasting (P1)

Gradient-boosted model per building and stream, trained on the most recent 100 days and tested on the last 20. Features include recent hours, hour-of-day, day-of-week, and exam/fest flags from the calendar. A naive "same hour yesterday" baseline is reported alongside for comparison.

---

## Frontend pages

| Page | Route | What it shows |
|---|---|---|
| Overview | `/` | Campus cards, time slider, top 5 recommended actions |
| Building detail | `/building/:id` | Forecast vs actual, flagged readings, staff notes |
| Smart bin | `/bin` | Live bin events, predicted type, confidence, latency |
| Offline | `/offline` | Take a building offline and watch the buffer replay |
| Leaderboard | `/league` | Credits table, week selector |
| Waste flows | `/waste` | Composition by building — food to compost, recycled vs landfill |
| Models | `/models` | Classifier confusion matrix, forecast error table |

---

## AI usage

All prompts used in this project — including chat and code-level calls to Claude, Groq, and other tools — are documented in [`docs/promptlog.md`](docs/promptlog.md).

Key design decisions:

- **Zero hallucination policy**: the `why()` prompt passes only the exact facts from P1's recommendation object; the system prompt explicitly forbids invented causes, locations, or equipment.
- **Offline-first**: all LLM responses are pre-generated and cached. The demo requires no internet connection and no API key.
- **Atomic tagging**: `tag_note()` uses `temperature=0.0` and a one-word constraint, with a programmatic sanitiser as the final gate.

---

## Team

| Person | Owns |
|---|---|
| P1 | `src/forecast.py`, `src/attribution.py` |
| P2 | `src/classifier.py`, `src/explain.py`, `docs/promptlog.md` |
| P3 | `src/ingest.py`, `src/edge_buffer.py`, `src/incentives.py` |
| P4 | `frontend/`, `src/server.py`, report, video |

See [`claude.md`](claude.md) for the full collaboration rules.
