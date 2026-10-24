# Model bake-off (12 h horizon)

12 h horizon, both streams, features = forecast.FEATURES, test days 2026-09-28..2026-10-17 (20 days, all exam days inside). To bound runtime every model is retrained every 5 days, at midnight 09-28, 10-03, 10-08 and 10-13, on features(hourly(as_of=d)) with targets before d, and each fit serves the next 5 days; the same schedule applies to every model. All models are scored on the same rows (rows where any prediction is NaN are dropped). Non-GB models: NaN filled with the training median per column; Ridge and MLP use one-hot building/day_type and standard scaling, RandomForest the imputed ordinal features. Ridge(alpha=1); RandomForest(100 trees, min_samples_leaf=5, 1 job); MLP (64,32), early_stopping, max_iter=300; our model = forecast.fit. LSTM: single layer, hidden 32, input = last 168 hourly values of the building ending 12 h before the target (scaled per building with training mean/std, NaN -> 0) concatenated with the target hour's calendar features (hour/dow sin-cos, day_type one-hot, building one-hot, is_event, scaled temp), linear head, Adam lr 3e-3, batch 256, 5 epochs, MSE, one CPU thread, seed 0. Metrics: MAE, WAPE = 100*sum|err|/sum(actual) overall, on exam days and on working days. size_kb = joblib compress=3 (state_dict for the LSTM), train_s = mean seconds per fit, predict_ms = median wall time to prepare inputs and predict one building's 12 rows, one thread. Other processes were running on this machine, so timings are noisy (see load).

| model | stream | n | mae | wape_pct | wape_exam_pct | wape_working_pct | size_kb | train_s | predict_ms |
|---|---|---|---|---|---|---|---|---|---|
| simple guess (lag24) | electricity_kwh | 3820 | 5.188 | 13.53 | 11.96 | 11.73 | 0.0 | 0.0 | 0.005 |
| Ridge | electricity_kwh | 3820 | 4.556 | 11.88 | 11.46 | 12.07 | 1.6 | 0.16 | 3.415 |
| RandomForest | electricity_kwh | 3820 | 3.52 | 9.18 | 9.37 | 7.83 | 9317.7 | 32.92 | 6.182 |
| MLP | electricity_kwh | 3820 | 7.226 | 18.84 | 29.38 | 8.71 | 86.4 | 16.58 | 3.969 |
| our model (HistGB) | electricity_kwh | 3820 | 3.899 | 10.17 | 9.85 | 11.21 | 440.3 | 3.76 | 7.635 |
| LSTM | electricity_kwh | 3820 | 7.091 | 18.49 | 17.97 | 16.42 | 17.2 | 152.59 | 22.149 |
| simple guess (lag24) | water_litres | 3807 | 181.281 | 15.97 | 13.81 | 14.29 | 0.0 | 0.0 | 0.007 |
| Ridge | water_litres | 3807 | 181.413 | 15.98 | 14.15 | 16.01 | 1.5 | 0.15 | 3.008 |
| RandomForest | water_litres | 3807 | 138.765 | 12.22 | 11.81 | 11.36 | 8064.1 | 44.99 | 8.164 |
| MLP | water_litres | 3807 | 193.273 | 17.02 | 20.66 | 13.14 | 88.0 | 55.67 | 3.209 |
| our model (HistGB) | water_litres | 3807 | 147.701 | 13.01 | 13.17 | 12.57 | 368.5 | 2.99 | 7.253 |
| LSTM | water_litres | 3807 | 260.276 | 22.92 | 19.78 | 20.15 | 17.2 | 181.25 | 22.08 |

LSTM ran. Runtime 2000 s; load average (1/5/15 min) start (33.7, 31.9, 32.3), end (53.4, 34.5, 34.8) on 8 cores.
