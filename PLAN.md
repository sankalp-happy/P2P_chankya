# Campus Resource Grid: team plan

## What we're building

A web dashboard for an 8-building campus. You drag a time slider (or press Play) and the whole campus updates as if it were live:

- how much electricity, water and waste each building is using right now
- a forecast of the next 12 hours, so a spike shows up before it happens
- unusual readings, with a likely cause and a suggested fix ("probably a leak in the Boys Hostel, send a plumber")
- a live feed of smart-bin events, each sorted into a waste type
- a button that takes one building offline for 3 hours, to show that no data gets lost
- a leaderboard that rewards buildings for saving

We build it in Python with Streamlit. Only two of us do machine learning.

## Who does what

| Person | Job | Writes ML? |
|---|---|---|
| P1 | Forecasting and finding the cause of unusual readings | Yes, the heavy part |
| P2 | Waste sorting model and the Claude explanations | Yes, the light part |
| P3 | Cleaning the data, the offline buffer, the leaderboard | No |
| P4 | The dashboard, the report and the video | No |

Each person only edits their own files, so nobody waits on anyone and git never conflicts.

---

## P1: forecasting and root cause

You own `forecast.py` and `attribution.py`.

1. Predict each building's electricity and water 6 and 12 hours ahead. Start with the simple guess "same hour yesterday" and then beat it with a gradient-boosting model from scikit-learn. Give the model the recent hours, the time of day, the day of the week, whether it's an exam or fest day, and the temperature.
2. Keep the last 20 days aside for testing. Report how far off each method is, and how many of the real spikes it caught.
3. Flag readings that are far from what the forecast expected.
4. For each flagged reading, look for a reason and give it points:
   - a staff note about that building within a day (a leak, pump repair, fest prep)
   - a calendar event that day
   - high usage at night when nobody is walking in
   - only one building affected, rather than the whole campus
5. The reason with the most points wins. Turn it into an action with rupees and CO2 saved (Rs 8 per kWh, 0.7 kg CO2 per kWh).

Until 1:15, work on the raw data with duplicate rows removed. P3 hands you the cleaned data at 1:15.

For the report, write: why a small model is good enough here (size, speed, accuracy compared to the simple guess), and what happens when patterns change during exam or fest weeks.

## P2: waste sorting model and Claude explanations

You own `classifier.py` and `explain.py`, and you keep the prompt log.

1. Train a model that sorts a bin event into one of the 6 waste types, using its 5 sensor readings. Try a small decision tree, a random forest and gradient boosting, and keep whichever scores best. Aim to finish by 1:30.
2. Report accuracy (the target is above 85%), which types get mixed up, the model's size, and how long one prediction takes.
3. When the model isn't sure (below 60% confidence), send the item to manual sorting.
4. Save predictions for the test file as `waste_events_test_predictions.csv`. This is an optional deliverable.
5. Use Claude (Haiku model) to write a two-sentence "why" for each of P1's suggested actions. Claude may only use the facts P1 passes in, never invent them. Generate these ahead of time and save them to a file, so the demo works without internet. If Claude is unavailable, fall back to a fixed sentence template.
6. Also use Claude to tag the staff notes as leak, maintenance, fest or other.
7. Keep `docs/PROMPTS.md` up to date: the prompts we used, what went wrong, and how we fixed them. A fifth of the marks are about how we used AI.
8. After 2:00, run Chronos-2 (see "Should we use the new pretrained models?" below) on the same last 20 days P1 tests on. Give P1 its error numbers for the comparison table.

## P3: data, offline buffer, leaderboard

You own `ingest.py`, `edge_buffer.py` and `incentives.py`.

1. Clean the hourly data. Remove duplicate rows and keep the first one that arrived. Fill short gaps (up to 3 hours) by drawing a line between neighbours. Fill longer gaps from the daily totals. Mark every filled value so it never shows up as a fake zero.
2. Make a table of when each building went offline and for how long.
3. Clean the staff logs. Map nicknames like "BH" and "Boys Hostle" to building codes (B05). Convert units: kL to litres, bags to kg (1 bag is 8 kg).
4. When sources disagree, trust the sensor first, then the daily summary, then the staff log. If they differ by more than 20%, raise an alert but don't change the data.
5. Build the offline demo. While a building is "offline", readings pile up in a small local database. When it reconnects, they arrive all at once with some duplicates mixed in. Show that the campus totals come out exactly the same.
6. Build the leaderboard. Compare each building against its own normal usage on similar days, adjusted for how many people were in it. That way a big hostel isn't punished for being big. 1 credit for every 1% saved, up to 10 a week. A building gets no credits if its sensors were down for more than 10% of the week.

Hand cleaned hourly data to P1 by 1:15.

## P4: dashboard, report, video

You own `app.py`, the `pages/` folder, the report and the video.

1. In the first 20 minutes, set up the project folder. Create a placeholder version of every file above that returns fake data in the right shape, and push it. Everyone else starts from these.
2. Build the main page: the time slider, one card per building, the 12-hour forecast chart, the top 5 suggested actions with their "why", and an alerts list.
3. Build the other pages:
   - Building detail: forecast vs actual, flagged readings, staff notes
   - Smart bin: events streaming in, the predicted type, confidence, and time taken
   - Connectivity: the "take B03 offline for 3 hours" button and the before/after totals
   - Leaderboard and credits
   - Waste flows: food waste to compost, recycled vs landfill
4. Write the cost and scale part of the report: about Rs 9,500 per standard building and Rs 13,000 per hostel or mess, with a cap of Rs 15,000. These are rough prices from Indian online shops. Explain how one small computer per building plus one central server stretches from 3 buildings to 30.
5. Put the 3-page report together, record the video and take the screenshots.

---

## Schedule

| Time | What happens |
|---|---|
| 0:00–0:20 | P4 sets up the project. Everyone installs, runs the app, and checks their tool works. We agree on the shared function list (end of this file). |
| 0:20–1:15 | Everyone builds their part. |
| 1:15 | P3 gives P1 the cleaned data. |
| 1:15–2:30 | Keep building. P2's classifier should be done by 1:30. |
| 2:30 | Stop adding features. Everything must work end to end. |
| 2:30–3:10 | Fix bugs. Everyone writes their part of the report and the prompt log. |
| 3:10–3:40 | Record the video and take screenshots. |
| 3:40–4:00 | Spare time, then submit. |

If we fall behind, drop these, in this order:
1. the Chronos-2 comparison
2. live Claude calls (keep the saved text)
3. the waste flows page
4. the offline animation (keep the before/after numbers)
5. the 6-hour forecast (keep the 12-hour one)

## Tools

| Part | Tool | Why |
|---|---|---|
| Waste sorting | scikit-learn tree models | 5 numbers per event, no images. Trees are small and fast. |
| Forecasting | scikit-learn gradient boosting | Handles exam and fest days, trains in seconds, runs on a cheap CPU |
| Flagging unusual readings | Distance from the forecast | Easy to explain ("3x normal for 2 AM") |
| Finding the cause | A points system | Every suggestion points to a real note or event |
| Explanations | Claude Haiku | Writes the "why" in plain English. It never decides the cause. |
| Dashboard | Streamlit | Python only. Moving the slider redraws everything. |
| Storage | Data files plus SQLite | Nothing extra to install |

Install: `pip install pandas openpyxl scikit-learn streamlit anthropic`

We ruled out training our own deep learning model (only 120 days of data, and it needs a GPU), Prophet (hard to install, slow) and React (a second language in a 4-hour build).

## Should we use the new pretrained models (TimesFM, Chronos and others)?

Yes, but as a comparison, not as the main model. A Haiku agent searched the web for this (October 2026).

**What we'll do:** run Amazon's **Chronos-2** next to our small model and put both in the report.
- It's a pretrained forecasting model, so there's nothing to train. It can also use known future inputs, such as "tomorrow is an exam day".
- It's free to use (Apache-2.0) and takes about 8 lines of code (below).
- A recent energy benchmark found Chronos-2 and TiRex-2, used without any training, beat XGBoost and random forests trained for the task ([FETS, April 2026](https://arxiv.org/abs/2604.22328)). Chronos-2 is also first overall on [fev-bench](https://arxiv.org/abs/2509.26468).
- It has 120 million parameters, against a few hundred KB for our model. That's the accuracy-vs-compute trade-off the problem asks us to justify. The plan: the small model runs in each building, and Chronos-2 can run nightly on the central server if it's clearly more accurate.
- Nobody has checked how fast it runs on a laptop CPU. Time it, and report the time.

```python
# pip install "chronos-forecasting>=2.0"   (pulls in PyTorch, a big download: start it at 0:00)
from chronos import Chronos2Pipeline
pipe = Chronos2Pipeline.from_pretrained("amazon/chronos-2", device_map="cpu")
pred = pipe.predict_df(hist, future_df=fut, prediction_length=12,
                       quantile_levels=[0.1, 0.5, 0.9], id_column="id",
                       timestamp_column="timestamp", target="target")
```

`fut` holds the known future inputs, such as the exam and fest flags. Leave temperature out, since we can't know it in advance.

**What we're skipping, and why:**

| Model | Why we're not using it |
|---|---|
| TimesFM (Google) | Larger (200M+), and the newest version's weights are non-commercial. Chronos-2 does the same job. |
| TiRex-2 | A good, lighter backup if Chronos-2 won't install, but the download is gated |
| Moirai 2.0 | Research-only licence, no pip install |
| TimeGPT | Paid API, needs internet |
| Toto, Sundial, Lag-Llama | No simple pip install, or can't use calendar inputs |
| TabPFN (for the waste model) | Weights are non-commercial, and it's slow on a CPU with 6,300 rows. A random forest on 5 numbers is enough. |

Version numbers and licences come from the agent's web search. Check the licence before any commercial use.

## Facts for the pitch

- The two hostels use 76% of the campus's water.
- The Boys Hostel draws about 82 kW on average.
- Hostels and labs use about 3.5 kWh per person per day. The food court uses 0.7.
- The hourly data has both duplicate rows and missing hours. Some readings arrive hours late.

## What could go wrong, and our fix

| Problem | Fix |
|---|---|
| Sensors slowly drift off | Re-zero bins daily. Flag a sensor that's been off for 3 days. |
| People cheat the leaderboard | No credits with patchy data. Cap credits per week. Random spot checks. |
| The model gets worse during exams or fests | Retrain weekly. Fall back to the simple guess if errors jump. |
| A building loses internet | Buffer locally, remove duplicates on reconnect, never fill gaps with zero. |
| Staff log the wrong building or unit | Clean names and units automatically. Logs never overwrite sensor data. |

## Video plan (2.5 minutes)

| Time | Show |
|---|---|
| 0:00–0:15 | The problem: two hostels use 76% of the water, and audits lag by days. |
| 0:15–0:35 | Messy staff logs being cleaned up. |
| 0:35–1:00 | Bin events being sorted live, with accuracy and speed. |
| 1:00–1:30 | Slide into exam week. The forecast shows the spike 12 hours early. |
| 1:30–1:55 | Click the top suggestion: the cause, the "why", the money saved. |
| 1:55–2:10 | Take a building offline and back. The totals don't change. |
| 2:10–2:30 | Leaderboard, cost per building, scaling to 30 buildings, how we used AI. |

---

## Appendix: shared function list (`schema.py`)

Agree on these in the first 20 minutes, then don't change them without telling everyone.

```python
# P3: ingest.py
load_hourly()       # building_id, ts, electricity_kwh, water_litres, solar_kwh, footfall, quality
load_manual_logs()  # ts, building_id, stream, value, unit, note, role
load_daily(), load_calendar(), load_buildings()

# P3: edge_buffer.py
simulate_outage(building_id, start_ts, hours)  # returns counts: buffered, duplicates dropped, totals match?

# P3: incentives.py
leaderboard(as_of)  # building_id, expected, actual, pct_saved, credits, rank

# P1: forecast.py
forecast(building_id, stream, as_of, horizon=12)  # ts, predicted, low, high, is_spike
metrics()

# P1: attribution.py
recommend(as_of, top=5)  # list of: building, cause, action, evidence, rupees_saved, co2_kg, score

# P2: classifier.py
predict(event)  # label, confidence, time_ms, route ("bin" or "manual_sort")
metrics()

# P2: explain.py
why(recommendation)  # one or two sentences
tag_note(note)       # leak / maintenance / fest / other
```
