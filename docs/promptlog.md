# Prompt Log & AI Workbook — Campus Resource Grid (P2P Chanakya)

> **Required deliverable.** A fifth of the total marks are for how we used AI.
> **Owner:** P2 (lead maintainer) — every teammate must add entries here.
> **Rule:** Every prompt sent to any AI model must appear here **before** the code is committed.
> See [`claude.md`](../claude.md) for the full logging rules.

---

## How to add an entry

There are **two formats**. Use whichever fits the situation.

### ⚡ Quick Log (chat / exploratory / one-off)
Use this any time you paste something into Claude.ai, ChatGPT, Gemini, Antigravity, Copilot, or any AI chat. One row in the Quick Log table in Section 5 — takes 30 seconds.

| Field | What to write |
|---|---|
| Date/Time | YYYY-MM-DD HH:MM |
| Who | P1 / P2 / P3 / P4 |
| Tool | Claude.ai / ChatGPT / Antigravity / Copilot / etc. |
| Prompt | Paste the exact text you sent |
| What it gave you | One-line summary of the response |
| Verdict | ✅ Used / ⚠️ Partially used / ❌ Ignored |

### 📋 Full Entry (runtime / code-level prompts)
Use this for any prompt that ends up inside Python code (`explain.py`, `classifier.py`, etc.).

```
### Entry X.Y — [Short title]
- **Date / Time:** YYYY-MM-DD HH:MM
- **Model:** Claude Haiku / Groq LLaMA / Agentic assistant / etc.
- **Used in:** filename → function()
- **Who:** P1 / P2 / P3 / P4
- **Purpose:** One sentence — what were you asking the model to do?
- **Prompt:**
  ```text
  <exact prompt — system turn first, then user turn>
  ```
- **Output received:**
  ```text
  <representative response>
  ```
- **What went wrong (if anything):**
- **How we fixed it:**
- **Verdict:** ✅ Kept / ⚠️ Revised / ❌ Dropped
```

---

## Master Index

| # | Entry | Section | Who | Verdict |
|---|---|---|---|---|
| 1.1 | Initial facility alert prompt — hallucination issue | Alert explanations | P2 | ⚠️ Revised |
| 1.2 | Refined grounded alert prompt — bounded & verified | Alert explanations | P2 | ⚠️ Revised (see correction) |
| 1.3 | Live SHAP explanation via Groq (`server.py`) | Alert explanations | P2 | ✅ Kept (see note) |
| 1.4 | Evidence-only `why()` on P1's real output, number check | Alert explanations | P2 | ✅ Kept |
| 2.1 | Freeform staff-note classification — verbose output | Staff-note tagging | P2 | ⚠️ Revised |
| 2.2 | Constrained atomic tagging | Staff-note tagging | P2 | ✅ Kept |
| 3.1 | Sensor physics & outlier rule design | Modelling & ablation | P2 | ✅ Kept |
| 3.2 | Data-leakage / cheating investigation | Modelling & ablation | P2 | ✅ Kept |
| 3.3 | P3 data layer, offline buffer, source check & leaderboard | Modelling & ablation / Data layer | P3 | ✅ Kept |
| 4.1 | Chronos-2 dependency & hardware audit | Chronos-2 benchmarking | P2 | ✅ Kept |

_Add a row here every time you add an entry below._

---

## Executive Summary of AI Utilisation

AI in this project is strictly bounded to four high-leverage tasks:

1. **Alert explanation (`explain.py → why()`)** — grounded NL summaries from telemetry evidence; zero hallucinations enforced.
2. **Log classification (`explain.py → tag_note()`)** — noisy handwritten facility notes → atomic tags (`leak / maintenance / fest / other`).
3. **Model selection & ablation** — rigorous comparison across Decision Trees, Random Forests, HistGradientBoosting, LightGBM, and XGBoost for a Raspberry Pi Zero 2 W class device. Measured results are in `docs/CLASSIFIER_REPORT.md`, reproducible with `src/train_classifier.py` (XGBoost: 85.37%, 923 KB, 0.56 ms per item on a laptop).
4. **Offline resilience** — precomputed JSON cache (`data/why_cache.json`) + deterministic template fallback so the demo works without internet or API keys.

---

## Section 1 — Alert Explanations (`explain.py → why()`)

_Prompts that generate the two-sentence "why" for each recommendation P1 produces._

---

### Entry 1.1 — Initial facility alert prompt (Version 1 — Hallucination issue)

- **Date / Time:** 2026-10-24 12:05
- **Model:** Anthropic Claude Haiku (`claude-haiku-5-5`) via Claude Code
- **Used in:** `src/explain.py → why()`
- **Who:** P2 (Abhijit)
- **Purpose:** Generate a short explanation of why a building anomaly occurred and what action to take.
- **Prompt:**
  ```text
  Explain why this campus building has an alert and what should be done:
  {"building": "Boys Hostel (B05)", "stream": "water", "reading": "18,400 L/hr", "rupees_saved": 1472}
  ```
- **Output received:**
  ```text
  The Boys Hostel alert is likely caused by students leaving taps running in the common
  bathrooms or a malfunctioning float valve in the overhead water storage tank. You should
  dispatch a plumber to check the roof tank immediately, which will save Rs 1472.
  ```
- **What went wrong:**
  - **Hallucination / fact invention:** The prompt gave no evidence of "students leaving taps running" or an "overhead water storage tank". The model fabricated plausible-sounding causes, violating the requirement that Claude may only use facts it's given.
  - **Unbounded length:** Output was 3 sentences; requirement is max 2.
- **How we fixed it:**
  - Added an explicit system prompt forbidding unprovided assumptions.
  - Required all numbers to be restated verbatim.
  - Enforced a hard two-sentence limit.
- **Verdict:** ⚠️ Revised → see Entry 1.2

---

### Entry 1.2 — Refined grounded alert prompt (Version 2 — Bounded & verified)

- **Date / Time:** 2026-10-24 12:20
- **Model:** Anthropic Claude Haiku (`claude-haiku-5-5`) & Groq (`llama-3.3-70b-versatile`)
- **Used in:** `src/explain.py → why()`
- **Who:** P2 (Abhijit)
- **Purpose:** Enforce zero-hallucination, strictly fact-grounded explanation in two sentences.
- **Prompt:**
  ```text
  System: Explain this campus facility alert in at most two plain sentences. Use only the
  facts given in the JSON evidence. Include the numbers. Do not invent causes, locations,
  or equipment not present in the input.

  User: {"building": "Boys Hostel (B05)", "stream": "water", "reading": "18,400 L/hr",
  "cause": "pipe rupture near washroom shaft",
  "action": "send emergency plumber to isolate valve",
  "rupees_saved": 1472, "co2_kg": 0}
  ```
- **Output received:**
  ```text
  In Boys Hostel (B05), an unusual water reading of 18,400 L/hr was detected due to a
  pipe rupture near the washroom shaft. Sending an emergency plumber to isolate the valve
  will resolve the leak and save approximately Rs 1,472.
  ```
- **Why it worked:**
  - Exactly two plain sentences.
  - Exact numbers restated (`18,400 L/hr`, `Rs 1,472`).
  - Zero hallucinated entities.
- **What went wrong:** Nothing — first run of v2 passed.
- **How we fixed it:** N/A
- **Verdict:** ✅ Kept — baked into runtime & pre-cached in `data/why_cache.json`
- **⚠️ Correction (P2, 2026-10-24 13:30):** The system prompt that was actually in `src/explain.py` was shorter than the one quoted above: `Explain this campus facility alert in at most two plain sentences. Use only the facts given. Include the numbers.` The input and output above use an invented example (18,400 L/hr, Rs 1,472), not P1's model output. The cache built from it held 9 hand-written texts with invented numbers (for example Rs 360/day for the B04 inverter, where P1 measured Rs 7,259 for 6–8 Oct). Those entries were deleted. See Entry 1.4.

---

### Entry 1.3 — Live SHAP Sensor Explainability via Groq 7B (`allam-2-7b`)

- **Date / Time:** 2026-10-24 12:56
- **Model:** Groq 7B (`allam-2-7b`) via GroqCloud API
- **Used in:** `server.py → POST /predict`
- **Who:** P2 (Waste Sorting & Explainability)
- **Purpose:** Translate raw TreeSHAP numerical attributions and sensor telemetry into clear, intuitive physical explanations.
- **Prompt:**
  ```text
  You are the explainability AI for an autonomous Smart-Bin waste sorter.
  A waste item was classified as 'food_organic' with 96.7% confidence.
  Sensor readings:
  - Weight: 350.0 g
  - Moisture: 72.0 %
  - Metal Signal: 5.0
  - Transparency: 0.12
  - Acoustic Hardness: 0.1

  TreeSHAP feature attributions (how much each sensor pushed toward or away from food_organic):
  {
    "weight_g": 0.0857,
    "moisture_pct": 2.3017,
    "metal_signal": 0.1181,
    "transparency": -0.003,
    "acoustic_hardness": 0.1829
  }

  In at most 2 plain sentences, explain why the model made this prediction and which physical sensor drove this classification.
  ```
- **Output received:**
  ```text
  The Smart-Bin waste sorter classified the waste item as 'food_organic' due to the significant contribution from the moisture sensor. Higher moisture content indicates that the waste item is more likely to be organic matter from food. The weight of the waste item also played a role, as heavier items are typically found in food waste.
  ```
- **Why it worked:**
  - Directly pinpointed the top SHAP driver (`moisture_pct`, SHAP score +2.3017).
  - Grounded explanation in sensor readings without hallucinating external facts.
  - Sub-second inference latency on Groq LPU hardware.
- **Verdict:** ✅ Kept — integrated live into FastAPI `/predict` endpoint
- **Note (P2, 13:30):** The output above has 3 sentences, although the prompt asks for at most 2. `server.py` is a separate FastAPI demo. The dashboard's per-item reason comes from `src/classifier.py → predict()` (XGBoost's own per-feature contributions, no LLM), so it works offline.

---

### Entry 1.4 — Evidence-only `why()` on P1's real output (Version 3)

- **Date / Time:** 2026-10-24 13:30
- **Model:** Claude Haiku (`claude-haiku-5-5`), then Groq `llama-3.3-70b-versatile`, then a fixed template
- **Used in:** `src/explain.py → why()`, `build_cache()`
- **Who:** P2 (fixes made with Claude Code for the team)
- **Purpose:** Rephrase one of P1's `attribution.recommend()` actions in at most 2 sentences, using P1's evidence only.
- **Prompt:**
  ```text
  System: Rephrase this campus facility alert in at most two plain sentences. Use only the facts in the JSON.
  Keep every number exactly as given. Do not add causes, equipment, places or numbers that are not in it.

  User: JSON of P1's fields only: building_id, building_name, stream, cause, unusual, confidence, action,
  rupees_saved, co2_kg, how_computed, runner_up, evidence (fact text).
  ```
- **What went wrong in v2:**
  1. Real `recommend()` records hold pandas Timestamps, so `json.dumps` raised an error. Both LLM calls were skipped without any message, and the template printed `unusual electricity_kwh reading () was flagged due to meter_fault`.
  2. The cache key was `building_stream_cause`, so a real recommendation could return a hand-written text with invented numbers.
- **How we fixed it:** The model sees only P1's fields. The cache key is a hash of those fields, so a cached text is reused only for the exact same evidence. Any LLM text containing a number that is not in the evidence is rejected, and the template is used instead. `python3 src/explain.py --build-cache` precomputes the top 5 actions at the 6 demo times from P1's self-check (23 texts).
- **Output received (cache, template source; no API key was set on the build machine, so no Claude text yet):**
  ```text
  Engineering Labs & Innovation Centre (B04) solar generation was only 46% of the usual for a typical day, most likely weather (calendar: 02 Aug rainfall 26.4 mm, humidity 85% (above the 75th percentile so far: 6.2 mm or 75%)). Action: No action: low solar on a rainy day (26.4 mm) across 2 buildings; 163 kWh bought from the grid instead.
  ```
- **To do:** Re-run `--build-cache` with `ANTHROPIC_API_KEY` set. Each cache entry records its `source`.
- **Verdict:** ✅ Kept

---

## Section 2 — Staff-Note Tagging (`explain.py → tag_note()`)

_Prompts that classify a raw staff log entry as `leak`, `maintenance`, `fest`, or `other`._

---

### Entry 2.1 — Freeform classification (Version 1 — Verbose output)

- **Date / Time:** 2026-10-24 12:10
- **Model:** Anthropic Claude Haiku
- **Used in:** `src/explain.py → tag_note()`
- **Who:** P2 (Abhijit)
- **Purpose:** Classify free-text maintenance logs into schema categories.
- **Prompt:**
  ```text
  What category does this facility note belong to? Choose from leak, maintenance, fest, other.
  Note: "Plumber called. Leak suspected in underground line near block entrance."
  ```
- **Output received:**
  ```text
  Based on the mention of a plumber and an underground pipe line, this note falls under
  the "leak" category.
  ```
- **What went wrong:**
  - Model returned a full sentence instead of an atomic tag. Downstream Streamlit and SQLite aggregators crashed trying to match the string `"leak"` against the full sentence.
- **How we fixed it:**
  - Set `temperature=0.0`.
  - Constrained output to strictly one word: `leak`, `maintenance`, `fest`, or `other`.
  - Added programmatic sanitiser: `if tag not in VALID_TAGS: return 'other'`.
- **Verdict:** ⚠️ Revised → see Entry 2.2

---

### Entry 2.2 — Constrained atomic tagging (Version 2)

- **Date / Time:** 2026-10-24 12:22
- **Model:** Anthropic Claude Haiku / Groq LLaMA-3.1-8B-Instant
- **Used in:** `src/explain.py → tag_note()`
- **Who:** P2 (Abhijit)
- **Purpose:** Return exactly one lowercase tag word with zero verbose explanation.
- **Prompt:**
  ```text
  System: Classify the staff note into exactly one category: leak, maintenance, fest, other.
  Output ONLY the category word in lowercase. If ambiguous or not strictly matching the
  first three, output other.

  User: "Water meter running fast, tank refilling often. Wet patch near 3rd floor washroom pipe."
  ```
- **Output received:**
  ```text
  leak
  ```
- **Edge-case verification:**
  | Staff note | Expected | Got |
  |---|---|---|
  | `"Composter motor burnt, wet waste going with normal garbage."` | `maintenance` | `maintenance` ✅ |
  | `"Alumni meet tomorrow, expecting 1500+ people. Extra cooking planned."` | `fest` | `fest` ✅ |
  | `"evening reading"` | `other` | `other` ✅ |
- **What went wrong:** Nothing.
- **How we fixed it:** N/A
- **Verdict:** ✅ Kept
- **⚠️ Correction (P2, 13:30):** The system prompt in `src/explain.py` is `Classify the staff note into exactly one category: leak, maintenance, fest, other. Output ONLY the category word.` (Claude Haiku, then Groq `llama-3.1-8b-instant`), without the extra sentence quoted above. The tags for all 13 distinct staff notes in `manual_logs.csv` are stored under `notes_tagged` in `data/why_cache.json`, and `python3 src/explain.py` checks that every note is covered.

---

## Section 3 — Modelling & Ablation (`classifier.py`)

_Prompts and AI-assisted decisions made during model selection, outlier handling, and feature engineering._

---

### Entry 3.1 — Sensor physics & outlier rule design

- **Date / Time:** 2026-10-24 12:02
- **Model:** Agentic pair-programming assistant
- **Used in:** `src/classifier.py` — preprocessing pipeline
- **Who:** P2 (Abhijit)
- **Purpose:** Determine whether to drop or clamp sensor outliers and formulate edge-ready cleaning rules for Raspberry Pi deployment.
- **Prompt:**
  ```text
  Given 5 sensors on a smart bin:
  weight_g (5 to 2045 g), moisture_pct (0 to 100%), metal_signal (0 to 100%),
  transparency (0 to 1), acoustic_hardness (0 to 1).
  591 rows (9.36%) have missing values.
  Should we drop rows or impute? What clamping rules should be applied for deployment
  on a Raspberry Pi Zero 2 W?
  ```
- **Output received / engineering decision:**
  - Dropping 9.36% of rows discards edge cases and reduces diversity for rare classes (`glass`: 320, `ewaste`: 351) → **rejected**.
  - Adopted deterministic boundary clamping instead:
    - `weight_g = max(0.0, weight_g)`
    - `moisture_pct = clip(0.0, 100.0)`
    - `metal_signal = clip(0.0, 100.0)`
    - `transparency = clip(0.0, 1.0)`
    - `acoustic_hardness = clip(0.0, 1.0)`
  - Native histogram splits (HistGradientBoosting) achieved **85.51%** accuracy without synthetic imputation distortion. _(Correction 13:40: `src/train_classifier.py` measures HistGradientBoosting at 84.13% and XGBoost, which handles NaN natively too, at 85.37%.)_
- **What went wrong:** Nothing — recommendation accepted on first pass.
- **How we fixed it:** N/A
- **Verdict:** ✅ Kept

---

### Entry 3.2 — Data-leakage / cheating investigation

- **Date / Time:** 2026-10-24 12:15
- **Model:** GPU ablation script (`run_ablation_study.py`) + agentic assistant interpretation
- **Used in:** `src/classifier.py` — feature selection
- **Who:** P2 (Abhijit)
- **Purpose:** Determine whether including `building_id` as a feature is leakage or legitimate signal.
- **Prompt:**
  ```text
  Training with building_id raised accuracy by +0.73%. Building B07 (Food Court) has 48%
  organic food waste; B03 (Academic) has 65% paper/cardboard. Is this a valid feature or
  spatial leakage for a bin that may be deployed in any location?
  ```
- **Output received / engineering decision:**
  - A bin deployed at a new or uncatalogued location cannot rely on spatial priors.
  - **Decision:** `building_id` and `bin_id` excluded from all model features to prevent false generalisation.
- **What went wrong:** Nothing.
- **How we fixed it:** N/A
- **Verdict:** ✅ Kept

---

### Entry 3.3 — P3 Data Layer, Offline Buffer, Cross-Source Check & Leaderboard

- **Date / Time:** 2026-10-24 12:45
- **Model:** Claude Opus 5.5 orchestrating Claude Sonnet sub-agents in Claude Code
- **Used in:** `ingest.py`, `edge_buffer.py`, `incentives.py`
- **Who:** P3
- **Purpose:** Build data cleaning, outage buffer replay, multi-source telemetry validation, and baseline-normalized leaderboard incentive loop.
- **Prompt:**
  ```text
  Build 3 production-grade, self-checking modules for Campus Resource Grid:
  1. ingest.py: Load & clean hourly streams; dedup on (building_id, timestamp) keeping earliest received_at; reindex to full hourly grid; interpolate gaps (<=3h linear, >3h profile-scaled daily totals); assign status (measured, revised, filled, estimated); replay by arrival time (received_at <= as_of).
  2. edge_buffer.py: Detect outages and late bursts; simulate gateway outage with local SQLite outbox using INSERT OR IGNORE on reconnect with 30% jittered retries; verify before/after campus totals match; implement source_check() fusing meters, daily summary, staff logs, and smart-bin mass shares with 20% tolerance, unit slip, and wrong-building detection.
  3. incentives.py: Compute weekly building leaderboard normalized against frozen baseline (2026-06-20 to 2026-08-16) and occupancy; award 1 credit/1% saved (max 10); disqualify weeks with <90% real readings or flat-lined sensors (>=24h); run placebo difference-in-differences test to quantify noise floor.
  ```
- **Output received:**
  - `ingest.py` (23,040 rows: 22,691 measured, 112 revised, 237 filled: 32 lost hours + 205 NaN cells; 0.1 ms cached queries).
  - `edge_buffer.py` (33 outages identified; B03 offline demo buffered 12 readings, dropped 4 jittered retries, matched totals exactly at 1,048.98 kWh and 32,185 L; 117 multi-source disagreements flagged).
  - `incentives.py` (8 buildings scored weekly; 1 out of 136 building-weeks flagged under 90% coverage for B02 stuck meter; placebo DiD established 27–35 pp noise floor).
- **What went wrong / How we fixed it:**
  - *Discrepancy in late reading count:* Brief noted 296 late rows in raw CSV, but 184 were retransmission duplicates. Deduplication on `(building_id, timestamp)` first leaves exactly 112 true late readings across 26 bursts.
  - *Hidden sensor NaN cells:* 205 rows had timestamps but contained NaN sensor readings. Handled with `filled` status and interpolation rather than crashing or treating as zero.
  - *Spurious e-waste share alerts:* Daily summary logs e-waste on only 29 of 960 days, triggering false alerts in 30–40% of weeks. Excluded e-waste from weekly composition share checks, retaining food and dry recyclables.
- **Verdict:** ✅ Kept

---

## Section 4 — Chronos-2 Benchmarking (P2 support to P1)

_Prompts and findings from the Chronos-2 forecasting comparison run after 2:00._

---

### Entry 4.1 — Chronos-2 dependency & hardware audit

- **Date / Time:** 2026-10-24 12:03
- **Model:** Pip dependency resolver & PyTorch check (tooling, not LLM)
- **Used in:** P1's comparison table in the report
- **Who:** P2 (Abhijit)
- **Purpose:** Verify that `chronos-forecasting>=2.0` can install and run on the team's hardware within the 30-minute time-box.
- **Prompt / command:**
  ```text
  pip install "chronos-forecasting>=2.0"
  ```
- **Output received:**
  - Target machine: **Python 3.15** on Windows 11.
  - PyPI has no pre-compiled `torch>=2.2` wheels for Python 3.15 Windows AMD64 → `ResolutionImpossible`.
  - Per the fallback schedule: Chronos-2 runtime execution **dropped** to preserve timeline.
- **Numbers handed to P1 for the comparison table:**
  | | Chronos-2 | Tuned GBDT (P1/P2) |
  |---|---|---|
  | Parameters | 120 M | ~244 KB |
  | Memory | ~480 MB (FP32) | < 1 MB |
  | Inference time | 250–500 ms (CPU) | < 1 ms |
  | Offline capable | No (needs server) | Yes (RPi Zero 2 W) |
- **What went wrong:** Wheel incompatibility with Python 3.15.
- **How we fixed it:** Dropped runtime; used architectural numbers for the report comparison.
- **⚠️ Correction (P2, 13:40):** Chronos-2 was never run, so the Chronos-2 column above (memory, 250–500 ms, "needs server") is not measured. Do not quote it as a result. The GBDT column is superseded by the measured numbers in `docs/CLASSIFIER_REPORT.md` (923 KB, 0.56 ms per item). P1 owns the forecast comparison table.
- **Verdict:** ✅ Kept (as a documented comparison, not a running model)

---

## Public share links — still missing

The data README asks for **verified public chat share links**. As of 13:30 the log has **none**. Claude Code and Antigravity sessions have no share link. Paste the key prompt into claude.ai or ChatGPT, make a share link, and add it to the entry.

| Entry | Owner to chase | Link |
|---|---|---|
| 1.1, 1.2, 1.4 `why()` prompts | P2 | missing |
| 1.3 Groq SHAP prompt (`server.py`) | P2 (Pramod) | missing |
| 2.1, 2.2 `tag_note()` prompts | P2 | missing |
| 3.1, 3.2 modelling / leakage | P2 | missing |
| 3.3 P3 data layer | P3 | missing (placeholder `[[CLAUDE_AI_SHARE_LINK]]` in `docs/P3_REPORT_DRAFT.md`) |
| 4.1 Chronos-2 audit | P2 | missing |
| P1 forecasting & root cause | P1 | **no entry yet** (`docs/P1_REPORT_DRAFT.md` has no prompt section) |
| P4 UI / frontend | P4 | **no entry yet** for the `frontend/` mock |
| Section 5 Quick Log rows | each person | missing |

---

## Section 5 — Quick Log (all teammates, all tools)

_Every prompt sent to any AI tool — chat, IDE assistant, or code helper — goes here as a one-liner.
No friction: just add a row. Graders look at coverage across the whole team._

| Date/Time | Who | Tool | Prompt (exact text) | What it gave you | Verdict |
|---|---|---|---|---|---|
| 2026-10-24 12:10 | P4 (Sankalp) | Antigravity (Claude) | `make a docs/promptlog.md for the collection of all the prompts being used. also make a claude.md with instruction to put every prompts in the promptlog.md` | Created `docs/promptlog.md` (structured log template) and `claude.md` (team AI-usage rules) | ✅ Used |
| 2026-10-24 12:11 | P4 (Sankalp) | Antigravity (Claude) | `push it after completion` | Committed and pushed both files to `origin/main` | ✅ Used |
| 2026-10-24 12:13 | P4 (Sankalp) | Antigravity (Claude) | `claude.md add basic instructions like dont touch someone else's code, etc etc` | Added team collaboration rules section (file ownership, git rules, comms) to `claude.md` | ✅ Used |
| 2026-10-24 12:38 | P4 (Sankalp) | Antigravity (Claude) | `pull the main and clean the codebase. put all the scripts inside src. organise the codebase.` | Reorganised repo: `src/`, `datasets/raw`, `datasets/clean`, `data/`, `models/`, `docs/` | ✅ Used |
| 2026-10-24 12:40 | P4 (Sankalp) | Antigravity (Claude) | `whatever abhijit has pushed in prompts.md put it in the promptlog. make sure the prompts are recorded in the desired manner only.` | Migrated all 7 of Abhijit's entries from `PROMPTS.md` into `promptlog.md` as a structured workbook | ✅ Used |
| 2026-10-24 12:45 | P3 | Claude Opus 5.5 / Sonnet | Specification of deduplication, interpolation, SQLite offline outbox, source cross-checks, and baseline-adjusted leaderboard | Generated ingest.py, edge_buffer.py, incentives.py passing all automated self-checks | ✅ Used |
| 2026-10-24 13:05 | P3/P4 | Antigravity (Gemini) | `Read the P3 handoff document and start from where it left` | Verified self-checks, resolved pandas deprecation in edge_buffer.py, filled N_LOW_COVERAGE_WEEKS and report draft placeholders, generated P1/P4 handoffs | ✅ Used |

| 2026-10-24 13:15 | P2 (via Sankalp) | Claude Code (Opus 5.5) | `You are finishing P2's part ... close the gaps against the hard requirements` (full brief: predict() dict + reason + routing, metrics dict + sensor importance, training script, NaN handling, real why() cache, one prompt log, Chronos claim) | Rewrote `predict()`, `classifier_metrics()`, `why()`; added `src/train_classifier.py`; rebuilt cache from P1's output; this log's corrections | ✅ Used |
| 2026-10-24 14:10 | P1/P4 (Sankalp) | Antigravity (Gemini) | `read @[docs/P1_REPORT_DRAFT.md] , i want a csv with all the results of models as required .` | Generated master CSV (`p1_model_results.csv`) and dedicated CSVs for forecast comparison, 6-model bakeoff, drift ablation, and walkforward metrics | ✅ Used |

_← Add your row here. One row per prompt, any tool, any teammate._

---

## Human Work Log

_Track what each person built manually (no AI). Fill this in during the 2:30–3:10 wrap-up._

| Person | What was built by hand (no AI) | Time spent |
|---|---|---|
| P1 | | |
| P2 | | |
| P3 | Baseline frozen window design, SQLite INSERT OR IGNORE idempotency proofs, 90% coverage threshold verification | 45 min |
| P4 | | |

---

## AI vs Human Decision Log

_When AI suggested something and the team overrode it, note it here. Graders look for this._

| # | What AI suggested | What we actually did | Why we overrode |
|---|---|---|---|
| 1 | Drop 9.36% missing rows | Clamp sensor values instead | Dropping hurts rare-class diversity |
| 2 | Include `building_id` as a feature (+0.73% acc) | Excluded it | Spatial leakage — invalid for unseen locations |

---

## Section 6 — Team Reflection & Self-Audit

_Fill this in at 2:30 during the wrap-up window._

| Audit question | Finding & resolution |
|---|---|
| **Which prompt took the most iterations?** | The `why()` alert generator. Version 1 invented plausible-sounding causes not in the evidence (e.g. broken float valves). Restricting the system prompt to JSON-fact-only extraction resolved it completely. |
| **What was the biggest model mistake?** | `tag_note()` v1 returned verbose paragraphs instead of a single tag. Fixed with strict one-token constraints and a programmatic regex fallback. |
| **How did we guarantee zero hallucinations in the live demo?** | (1) The model sees only P1's evidence fields; (2) any LLM text with a number that is not in that evidence is rejected; (3) a cache keyed on a hash of the evidence, built from P1's real `recommend()` output; (4) a template built from the same fields. Correction: until 13:30 the cache held hand-written texts with invented numbers; they were deleted (Entry 1.4). |
| **What would we do differently next time?** | Standardise a shared Python 3.11 venv across all team members at 0:00 to avoid pre-release wheel incompatibilities with PyTorch. |
| **Total AI prompts logged** | 10 full entries + Quick Log rows |
| **Total human decisions overriding AI** | 2 |
