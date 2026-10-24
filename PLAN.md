# Campus Resource Grid: team plan

## What we're building

A web dashboard for an 8-building campus. You drag a time slider (or press Play) and the whole campus updates as if it were live:

- how much electricity, water and waste each building is using right now
- a forecast of the next 12 hours, so a spike shows up before it happens
- unusual readings, with a likely cause, a suggested fix, and the reasons behind it
- a live feed of smart-bin events, each sorted into a waste type and sent to compost, recycling or e-waste
- facility alerts in one list
- buildings going offline and coming back, with no data lost or counted twice
- a leaderboard that rewards buildings for saving

We build it in Python with Streamlit. Only two of us do machine learning.

## Who does what

| Person | Job | Writes ML? |
|---|---|---|
| P1 | Forecasting and finding the cause of unusual readings | Yes, the heavy part |
| P2 | Waste sorting model, waste routing, Claude explanations | Yes, the light part |
| P3 | Cleaning the data, offline handling, the leaderboard | No |
| P4 | The dashboard, the report and the video | No |

Each person only edits their own files, so nobody waits on anyone and git never conflicts.

## Data traps: read these before you start

- The README calls the waste label `waste_class`. In the files it's called `category`.
- **All 9 exam days fall between 28 Sep and 9 Oct**, inside the last three weeks. If you train on everything before 28 Sep, the model has never seen an exam day. See P1, step 2.
- Duplicate hourly rows are not exact copies: the values differ slightly. Match duplicates on building + timestamp, not on the whole row.
- Hourly rows arrive out of order. `timestamp` is when a reading was taken, `received_at` is when it reached the server.
- Temperature and rain are one value per day, not per hour.
- The README says the data is .csv with .xlsx copies. We only got .xlsx. CSV copies are now in `P2P_DATASET/`.

---

## P1: forecasting and root cause

You own `forecast.py` and `attribution.py`.

1. Predict each building's electricity and water 6 and 12 hours ahead. Start with the simple guess ("same hour yesterday"), then beat it with a gradient-boosting model from scikit-learn. Give the model only what would be known when the forecast is made:
   - usage now, at the same hour yesterday and last week, and the average of the last 24 hours
   - hour, day of the week, day type (exam, holiday, weekend), whether there's an event
   - the day's temperature. This is the real daily average, used as a stand-in for a weather forecast. Say so in the report.
2. Test it the way it would really run: walk forward one day at a time through the last 20 days. Each day, retrain on everything before it (this takes seconds) and forecast that day. Report:
   - the error on normal days and on exam days, separately, against the simple guess
   - how many real spikes it caught. A spike is an hour above that building's usual top 5%.

   This matters because the exam period sits inside the test window. The first exam days are where the model should struggle, and daily retraining is how it recovers. That gives us real numbers for the "model gets worse over the semester" failure mode.
3. Flag readings that are far from what was expected for that building at that hour of the week. Run the same check on the daily waste numbers in the daily summary (landfill kg, contamination %).
4. For each flagged reading, look for a reason and give it points:
   - a staff note about that building within a day (leak, pump repair, fest prep)
   - a calendar event that day
   - the shift it happened in. High use at night (00:00–05:00) with almost no footfall points to a leak or lights left on. Meal hours at the Food Court point to a mess rush.
   - only one building affected (equipment) versus the whole campus (weather or an event)
5. The reason with the most points wins. Keep the runner-up too, so the dashboard can show what else was considered. Turn the winner into an action with rupees and CO2:
   - Rs 8 and 0.7 kg CO2 per kWh
   - water counts as 0.85 kWh per 1,000 L
6. Rank all actions by rupees at stake × how sure we are (winning points ÷ total possible points). Show both numbers.

Every output must explain itself. See "How each AI part explains itself" below.

Until 1:15, work on the raw data with duplicates removed. P3 hands you the cleaned data at 1:15.

For the report, write two things:
- why a small model is good enough here: a size, speed and error table covering the simple guess, our model and Chronos-2
- what happened on exam days

## P2: waste sorting, routing, Claude explanations

You own `classifier.py` and `explain.py`, and you keep the prompt log.

1. Train a model that sorts a bin event into one of the 6 waste types.
   - Use only the 5 sensor readings, not `bin_id` or `building_id`. The model should work in any bin. Check quickly whether `bin_id` alone predicts the type, and mention it in the report if it does.
   - Remove impossible readings first (negative weight, moisture over 100%).
   - Try a small decision tree, a random forest and gradient boosting, with 5-fold cross-validation, and keep the best. Aim to finish by 1:30.
2. Report:
   - overall accuracy (the target is above 85%) and accuracy per waste type
   - which types get mixed up (confusion matrix)
   - model size, and time per prediction, measured on a laptop, against the 2-second limit
3. Give every prediction a reason: the 2 readings that point most strongly to that type, for example "glass: transparency 0.92 and hardness 0.95, typical of glass". Also show which sensors matter most overall. scikit-learn's `permutation_importance` does this in a few lines.
4. If the model isn't sure (below 60% confidence), send the item to manual sorting.
5. Route every item. This is the "circular allocation" the judges want screenshots of:
   - food goes to the building's own composter (B05, B06 and B07 have one), otherwise to the nearest one
   - paper, plastic, glass and metal go to recycling
   - e-waste goes to certified e-waste pickup and raises an alert
   - unsure items go to manual sorting
6. Save `waste_events_test_predictions.csv` with exactly two columns, `event_id` and `predicted_class`. This is optional, but cheap.
7. Use Claude (Haiku model) to write a two-sentence "why" for each of P1's actions. Claude may only rephrase the evidence P1 passes in, never add to it. Generate these ahead of time and save them to a file, so the demo works offline. If Claude is unavailable, fall back to a fixed sentence template.
8. Also use Claude to tag staff notes as leak, maintenance, fest or other.
9. Keep `docs/PROMPTS.md` up to date. The judges want three things:
   - how each prompt changed, step by step: v1, what went wrong, v2
   - which tools we used
   - **public share links to the chats**. Ask everyone to do their important prompting in a chat app that can make a share link (claude.ai, ChatGPT) and to paste the link into the log.
10. After 2:00, run Chronos-2 (see below) on the same walk-forward days P1 uses. Give P1 the error and time numbers.

## P3: data, offline handling, leaderboard

You own `ingest.py`, `edge_buffer.py` and `incentives.py`.

1. Clean the hourly data:
   - Sort by `timestamp`.
   - Treat rows with the same building and timestamp as duplicates, and keep the one that arrived first.
   - Fill gaps of up to 3 hours by drawing a line between the neighbouring readings. Fill longer gaps from the daily totals.
   - Mark every filled value, so it never shows up as a fake zero.
2. Make an outage table: when each building went quiet and for how long. Split each outage into readings that arrived late in a burst and readings that never arrived.
3. Replay the data the way the server saw it. At slider time T, show only rows that had arrived by T (`received_at` ≤ T). The real outages in the data then appear on their own:
   - The building's card says "offline since 14:00, showing estimate" instead of disappearing.
   - When the late burst arrives, the estimate is replaced by the real readings and marked "revised".
   - Campus totals never count a reading twice.
4. Clean the staff logs:
   - Map nicknames to building codes ("BH" and "Boys Hostle" become B05).
   - Convert units: kL to litres, bags to kg (1 bag is 8 kg), "units" to kWh.
5. Combine four sources that run at four speeds: meters (hourly), bin events (one per item), staff logs (whenever) and the daily summary (daily).
   - Trust the meter first, then the daily summary, then the staff log.
   - If two sources differ by more than 20%, raise an alert but don't change the data.
   - Add up the bin events per building per day by waste type, and compare them with the daily summary's waste figures.
6. Build the "take B03 offline for 3 hours" button. Readings pile up in a small local database, then arrive all at once with some duplicates mixed in. Show the campus totals before and after: they must match exactly.
7. Build the leaderboard as a closed loop:
   - **Score:** electricity, water and landfill waste per person. Compare each with the building's own normal on similar days, adjusted for how many people were in it. A big hostel isn't punished for being big.
   - **Credits:** 1 for every 1% saved, up to 10 a week. None if the building's sensors were down for more than 10% of the week. Show the maths on screen: expected, actual, occupancy adjustment, credits.
   - **Close the loop:** each building gets a weekly note with its rank, its biggest waste (P1's top action for it) and one thing to do. Credits can be spent at the Food Court.
   - **How we'd measure impact:** run the scheme in some buildings (for example B05, B06 and B07) and keep the others as a comparison group for 4 weeks. Compare how usage per person changed before and after, between the two groups. Measure kWh, litres and landfill kg per person, plus contamination %. Our data is from before any scheme existed, so we can't claim a real saving. Say that plainly.

Hand cleaned hourly data to P1 by 1:15.

## P4: dashboard, report, video

You own `app.py`, the `pages/` folder, the report and the video.

1. In the first 20 minutes, set up the project folder. Create a placeholder version of every file above that returns fake data in the right shape, and push it. Everyone else starts from these.
2. Build the main page:
   - the time slider
   - one card per building, showing whether it's live, offline (estimated) or revised
   - the 12-hour forecast chart
   - the top 5 actions with their "why"
3. Build the other pages:
   - **Building detail:** forecast vs actual, flagged readings, staff notes
   - **Smart bin:** events streaming in, with predicted type, confidence, reason, destination and time taken
   - **Waste flows (circular allocation):** where waste goes in each building (compost, recycling, landfill), using the daily summary and the bin routing. 4 kg of food waste makes 1 kg of compost.
   - **Facility alerts:** one list gathered from everyone: unusual readings (P1), e-waste and unsure items (P2), offline buildings and disagreeing sources (P3)
   - **Connectivity:** the offline button and the before/after totals
   - **Leaderboard and credits**
4. Write the 3-page report:
   - **Architecture diagram:** sensors, then a small computer in each building, then the central server, then the dashboard
   - **How we handle messy data:** taken from P3
   - **Screenshots**
   - **Budget and scaling.** Each building gets ESP32 boards on its meters and bins, and one Raspberry Pi–class computer that runs the waste model and the forecast. That costs about Rs 9,500 for a standard building and Rs 13,000 for a hostel or mess, with a cap of Rs 15,000. These are rough prices from Indian online shops. Explain how the same setup grows from 3 buildings to 30.
   - **Credits** for the tools and models we used (scikit-learn, Streamlit, Chronos-2, Claude), and how AI was used
5. Take screenshots. The judges ask for three by name: the telemetry dashboard, circular waste allocation, and facility alerts.
6. Record the video as **one continuous screen recording**. It must show the UI recalculating across buildings and a prompt being run.

---

## Schedule

| Time | What happens |
|---|---|
| 0:00–0:20 | P4 sets up the project. Everyone installs, runs the app, and checks their tool works. Start the Chronos-2 install now; it's a big download. Agree on the shared function list (end of this file). |
| 0:20–1:15 | Everyone builds their part. |
| 1:15 | P3 gives P1 the cleaned data. |
| 1:15–2:30 | Keep building. P2's classifier should be done by 1:30. |
| 2:30 | Stop adding features. Everything must work end to end. |
| 2:30–3:10 | Fix bugs. Everyone writes their part of the report and the prompt log, plus 3 lines on the key decisions in their part, so any of us can answer the judges. |
| 3:10–3:40 | Record the video and take screenshots. |
| 3:40–4:00 | Spare time, then submit. |

If we fall behind, drop these, in this order:
1. the Chronos-2 comparison
2. live Claude calls (keep the saved text)
3. the building comparison on the waste page (keep the page: the submission needs a screenshot of it)
4. the offline animation (keep the before/after numbers)
5. the 6-hour forecast (keep the 12-hour one)

## How each AI part explains itself

The problem says the system "must justify why it made each recommendation". This table is what the dashboard shows for each part.

| Part | What the user sees |
|---|---|
| Waste sorting | The type, how sure the model is, the 2 readings that decided it, and where the item goes. On the metrics panel: which sensors matter most, and which types get mixed up. |
| Forecast | The predicted line with a low–high band, the simple guess for comparison, and why a spike is expected. For the "why", list the inputs that differ most from a normal day, e.g. "exam day, 7 PM, same hour last week was 2x normal". |
| Unusual readings | Actual vs expected, e.g. "3.4x the usual for 2 AM on a Tuesday". |
| Root cause | The evidence checklist with points for each item, the runner-up cause, and how sure we are. |
| Action ranking | Rupees at stake and how sure we are, side by side, plus how the rupees and CO2 were worked out. |
| Leaderboard | Expected, actual, the occupancy adjustment, and the credits. |
| Claude text | Labelled "written by AI from the evidence above". It only rephrases the evidence. The template text shows if Claude is off. |

## Requirements checklist

| Requirement (problem statement) | How we meet it | Owner |
|---|---|---|
| Combine 3+ messy sources at different speeds; don't drop offline buildings | 4 sources (meters, bin events, staff logs, daily summary), a trust order, and estimates for offline buildings | P3 |
| 5+ waste classes, above 85%, cheap hardware, under 2 s | 6 classes, measured accuracy and time, runs on a Pi-class computer | P2 |
| Forecast 6–12 h ahead and justify accuracy vs compute | 6 h and 12 h forecasts, compared with the simple guess and Chronos-2 on error, size and speed | P1 |
| Survive hours offline, buffer, reconcile | Replay by arrival time, local buffer, duplicates removed, estimates revised, totals match | P3 |
| Root cause, ranked actions, explain why | Points checklist, runner-up, ranked by rupees × confidence, Claude rephrasing | P1, P2 |
| Incentive loop, and how impact is measured | Leaderboard, credits, weekly note, comparison-group plan | P3 |
| Per-building budget; scale from 3 to 30+ | Rs 15,000 cap, parts list, scaling argument | P4 |
| At least 2 failure modes with fixes | 6, listed below | All |

| Deliverable (data README) | Owner |
|---|---|
| Prompt workbook with prompt changes and public chat share links | P2 collects, everyone contributes |
| 3-page PDF: architecture, data handling, screenshots | P4 |
| 2.5-minute continuous video: live recalculation and a prompt being run | P4 |
| Screenshots: telemetry dashboard, circular waste allocation, facility alerts | P4 |
| Optional: `waste_events_test_predictions.csv` (`event_id`, `predicted_class`) | P2 |

**Every data file gets used.** Judges score how well we used the dataset.

| File | Used for |
|---|---|
| buildings | composters, capacity, solar |
| calendar | forecast inputs and causes |
| daily summary | filling gaps, waste flows, leaderboard, cross-checks |
| hourly | forecasting and outages |
| staff logs | causes and cross-checks |
| bin train | the waste model |
| bin test | the live feed and the predictions file |

## Tools

| Part | Tool | Why |
|---|---|---|
| Waste sorting | scikit-learn tree models | 5 numbers per event, no images. Trees are small and fast. |
| Forecasting | scikit-learn gradient boosting | Handles exam and fest days, trains in seconds, runs on a cheap CPU |
| Flagging unusual readings | Distance from the expected value | Easy to explain ("3x normal for 2 AM") |
| Finding the cause | A points system | Every suggestion points to a real note or event |
| Explanations | Claude Haiku | Writes the "why" in plain English. It never decides the cause. |
| Hardware in each building | ESP32 boards on sensors, a Raspberry Pi–class computer | Runs both models locally, no cloud GPU needed |
| Dashboard | Streamlit | Python only. Moving the slider redraws everything. |
| Storage | Data files plus SQLite | Nothing extra to install |

Install: `pip install pandas openpyxl scikit-learn streamlit anthropic`

We ruled out:
- training our own deep learning model: only 120 days of data, and it needs a GPU
- Prophet: hard to install, and slow
- React: a second language in a 4-hour build

## Should we use the new pretrained models (TimesFM, Chronos and others)?

Yes, but as a comparison, not as the main model. A Haiku agent searched the web for this (October 2026).

**What we'll do:** run Amazon's **Chronos-2** next to our small model and put both in the report.
- It's a pretrained forecasting model, so there's nothing to train. It can also use known future inputs, such as "tomorrow is an exam day".
- It's free to use (Apache-2.0) and takes about 8 lines of code (below).
- A recent energy benchmark found Chronos-2 and TiRex-2, used without any training, beat XGBoost and random forests trained for the task ([FETS, April 2026](https://arxiv.org/abs/2604.22328)). Chronos-2 is also first overall on [fev-bench](https://arxiv.org/abs/2509.26468).
- It has 120 million parameters; our model is a few hundred KB. That's the accuracy-vs-compute trade-off the problem asks us to justify. The small model runs in each building, and Chronos-2 can run nightly on the central server if it's clearly more accurate.
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
- Hostels and labs use about 3.5 kWh per person per day. The Food Court uses 0.7.
- The hourly data has both duplicate rows and missing hours. Some readings arrive hours late.

## What could go wrong, and our fix

| Problem | Fix |
|---|---|
| Sensors slowly drift | Re-zero bins daily. Flag a sensor that has been off for 3 days. |
| People cheat the leaderboard | No credits when sensor data is patchy. Credits capped per week. Random spot checks. |
| The model gets worse during exams or fests | Retrain daily. Fall back to the simple guess if errors jump. Our exam-week test shows how big the drop is and how fast it recovers. |
| A bin sees an item unlike anything it was trained on | Low confidence sends it to manual sorting. The hand-sorted label is added to the training data. |
| A building loses internet | Buffer locally, remove duplicates on reconnect, show estimates and never zeros, replace estimates when real data arrives. |
| Staff log the wrong building or unit | Clean names and units automatically. Logs never overwrite meter data. |

## Video plan (2.5 minutes, one continuous take)

| Time | Show |
|---|---|
| 0:00–0:15 | The problem: two hostels use 76% of the water, and audits lag by days. |
| 0:15–0:35 | Messy staff logs being cleaned. Press Play: a building goes offline, shows an estimate, then gets revised when its data arrives. |
| 0:35–1:00 | Bin events sorted live, each with its reason and destination. The waste flows page. |
| 1:00–1:25 | Slide into exam week. The forecast shows the spike 12 hours early, with its reasons. |
| 1:25–1:50 | Click the top action: the evidence checklist, the "why", the rupees saved. The alerts page. |
| 1:50–2:10 | A prompt running live: Claude tags a messy staff note. Then the prompt workbook. |
| 2:10–2:30 | Leaderboard and credits, cost per building, scaling to 30 buildings. |

---

## Appendix: shared function list (`schema.py`)

Agree on these in the first 20 minutes, then don't change them without telling everyone.

```python
# P3: ingest.py
load_hourly(as_of=None)  # only rows received by as_of
                         # building_id, ts, electricity_kwh, water_litres, solar_kwh, footfall,
                         # status: measured / filled / estimated / revised
load_manual_logs()  # ts, building_id, stream, value, unit, note, role
load_daily(), load_calendar(), load_buildings()

# P3: edge_buffer.py
simulate_outage(building_id, start_ts, hours)  # buffered, duplicates_dropped, gaps_filled, totals_before, totals_after
outage_table()      # building_id, start, end, hours, arrived_late, lost
source_check()      # building_id, date, stream, meter, daily_summary, staff_log, disagrees

# P3: incentives.py
leaderboard(as_of)  # building_id, expected, actual, occupancy_adjustment, pct_saved, credits, rank, coverage_pct

# P1: forecast.py
forecast(building_id, stream, as_of, horizon=12)  # ts, predicted, low, high, simple_guess, is_spike, reasons
forecast_metrics()  # per method (simple guess / our model / Chronos-2):
                    # error_normal_days, error_exam_days, spikes_caught, size_kb, time_ms

# P1: attribution.py
recommend(as_of, top=5)  # list of: rank, building_id, cause, runner_up, evidence [(fact, points)],
                         # confidence, action, why, rupees_saved, co2_kg

# P2: classifier.py
predict(event)  # label, confidence, reason, destination, time_ms
classifier_metrics()  # accuracy, accuracy_per_class, macro_f1, confusion, sensor_importance, size_kb, time_ms

# P2: explain.py
why(recommendation)  # one or two sentences
tag_note(note)       # leak / maintenance / fest / other
```

P4 builds the alerts page from `recommend()`, from `predict()` results that are e-waste or manual sort, and from `outage_table()` and `source_check()`.
