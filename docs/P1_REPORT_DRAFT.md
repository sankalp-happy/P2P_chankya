# P1 report draft: forecasting and root cause

All numbers below were measured by `eval_forecast.py` (output `models/forecast_metrics.json`) and `attribution.py` self-check. Nothing is estimated by hand.

## Forecasting 6–12 h ahead, and why a small model

**What it does.** For every building we forecast hourly electricity (kWh) and water (L) for the next 12 hours. Hours 1–6 come from a 6 h model and hours 7–12 from a 12 h model (scikit-learn gradient-boosted trees, `HistGradientBoostingRegressor`). Inputs are only what is known when the forecast is made: usage at the newest reading, the 24 h average, the same hour yesterday and last week, hour, weekday, day type (exam, holiday, weekend…), event flag, and the day's temperature. The temperature is the real daily mean, used as a stand-in for a weather forecast. "12 h ahead" means 12 h after the newest meter reading; readings reach the server about 1 h after they are taken.

**How we tested it.** Walk-forward over the last 20 days (28 Sep–17 Oct, all 9 exam days inside): every midnight the model is retrained on the readings the server had by then, then forecasts that day. All methods are scored on the same 3,800+ hours.

| 12 h ahead | Error, all 20 days | Size | Train (1 core) | One 12 h forecast |
|---|---|---|---|---|
| Simple guess (same hour yesterday) | electricity 13.5%, water 16.0% | 0 | none | <0.01 ms |
| Our model, retrained daily | electricity **10.0%**, water **13.0%** | ~440 KB | ~3 s | ~7–16 ms |
| Small model (100 trees, 15 leaves) | electricity 10.7%, water 13.5% | ~78 KB | ~1 s | ~5–8 ms |
| Chronos-2 (pretrained, 120M parameters) | *P2 fills in* | *P2 measures* | none | *P2 fills in* |

Error = 100 × Σ|error| / Σ actual. At 6 h ahead our model's error is 8.9% (electricity) and 13.7% (water). Timings were taken on a laptop shared with other processes, one CPU thread, so they are upper bounds; the point is the order of magnitude.

**Which model family: we tested six.** Same 20 test days, same rows, 12 h ahead, every model retrained every 5 days (`model_bakeoff.py`, `models/bakeoff.md`):

| Model | Electricity error | Water error | Size | Train per fit |
|---|---|---|---|---|
| Simple guess | 13.5% | 16.0% | 0 | none |
| Linear regression (Ridge) | 11.9% | 16.0% | 2 KB | 0.2 s |
| Small neural net (MLP 64-32) | 18.8% | 17.0% | 86 KB | 17–56 s |
| LSTM (1 layer, 32 units, 168 h window) | 18.5% | 22.9% | 17 KB | 150–180 s |
| Random forest (100 trees) | **9.2%** | **12.2%** | 8–9 MB | 33–45 s |
| **Gradient boosting (ours)** | 10.2% | 13.0% | 0.4 MB | 3–4 s |

The random forest is about 1 point more accurate, but it is ~20× larger and ~10× slower to train. The neural nets did worse than the simple guess: 120 days of data is too little for them, and our MLP and LSTM were small and untuned, so this is a fair-effort result, not their ceiling. Gradient boosting gives the best accuracy per unit of compute, so it is what runs in each building. One run, one seed; timings were taken on a busy laptop.

**Why this trade-off.** The model cuts error by about a quarter to a third against the simple guess, retrains in seconds and forecasts in milliseconds on one CPU core, so a Raspberry Pi–class box in each building can run and retrain it every night with no cloud GPU. A 5.6× smaller model loses only 2–8% relative accuracy, so hardware is not the bottleneck at this size. A pretrained foundation model such as Chronos-2 has 120 million parameters against our few hundred KB; it belongs on the central server, if anywhere.

**What it does not do well (honest limit).** Catching single top-5% hours is hard: the model flags about 40–45% of them at 12 h ahead, no better than the simple guess (48%). On the two weeks before the test, every rule we tried was close to chance, because outside exam week most top-5% hours are one-off blips. The model's gain is in the average error and in following the exam-week level shift; a dedicated spike classifier is the next step.

## Exam weeks and model drift (failure mode)

**The risk.** Usage patterns shift during exams, fests and holidays, and a model trained on ordinary weeks goes stale. Our test window starts on the first exam day, so on 28 Sep the model had never seen one.

**What we measured.** Exam days were only modestly harder than ordinary working days (6 h electricity: 9.6% vs 7.9%), and error did not jump on the first exam day. The bigger effects came when the pattern changed back: after the exam block and on the 2 Oct holiday. A model frozen on 28 Sep vs the same model retrained every midnight:

| Where the pattern changed | Frozen model | Retrained daily |
|---|---|---|
| 2 Oct holiday, electricity 12 h | 18.8% | **15.9%** |
| Post-exam working days, water 6 h | 14.5% | **11.9%** |
| All 20 days, water 6 h | 14.6% | **13.7%** |

Over all 20 days, daily retraining gave a small gain (0–7% relative); on exam days themselves at 12 h it made no difference. We present it as cheap insurance, not a cure.

**Mitigation.** Retrain every midnight (seconds on one core); fall back to the simple guess for a building if its error over the last day jumps; show the forecast band so staff see when the model is unsure.

## Root cause and ranked actions

Each unusual reading (robust z-score ≥ 3.5 against the same building, hour and kind of day, and at least 1.5× or below 1/1.5× of usual) is grouped into an incident and scored against possible causes with points (max 8): a staff note for that building within ±24 h (3), the calendar (2), the shift, e.g. night with nobody in or Food Court meal hours (2), and whether only one building is affected (1). The cause with most points wins; the runner-up is shown too. Rupees = excess kWh × Rs 8 (water: 0.85 kWh per 1,000 L), CO2 = kWh × 0.7 kg. Actions are ranked by rupees × confidence. Meter faults and weather count Rs 0 because they are not real waste.

It finds every planted problem in the data, using only notes and readings available at that moment:

| Incident | Found as | Confidence | Rs at stake |
|---|---|---|---|
| B04 solar inverter down, 6–8 Oct | equipment down (inverter note, only B04) | 4/8 | 7,259 (907 kWh bought from grid) |
| B03 lights/AC left on, 2 Oct holiday | left on (note, holiday, night, only B03) | 8/8 | 1,023 |
| B06 underground leak, 4–9 Aug | leak (warden note, only B06) | 4/8 | 276 by 7 Aug |
| B04 power analyzer calibration, 27 Aug | meter fault (note, 10× usual) | 6/8 | 0 (not real use) |
| B02 water meter stuck at 0, 3–4 Sep | meter fault (zeros, note) | 6/8 | 0 |
| B05 composter down, 7–13 Sep | equipment down (note) | 4/8 | 0 (929 kg extra landfill) |

B03 is already flagged as "left on" (5/8) at noon on 2 Oct, seven hours before the security note is logged.
