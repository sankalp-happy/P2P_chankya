# Classifier Report: Smart-Bin Waste Sorter (P2 Deliverable for P4)

**API for P4:** `predict(event)` returns a dict: `label, confidence, reason, destination, route, alert, time_ms`. `classifier_metrics()` returns a dict: `accuracy, accuracy_per_class, macro_f1, confusion, classes / class_names, sensor_importance, size_kb, time_ms` plus the not-sure stats. Routing: food goes to the building's own composter (B05/B06/B07), otherwise to B07. That B07 default is an assumption, because `buildings.csv` has no locations. Paper, plastic, glass and metal go to recycling. E-waste goes to certified pickup and raises an alert. Items below 60% confidence go to manual sort and raise an alert. On the 1,601 test events this gives 63 e-waste alerts and 147 manual-sort items.
**Author:** P2 (Waste Sorting Model & Explainability)  
**Target Submission:** For P4 final integration and pitch report

---

### 1. Model Architecture & Ablation Comparison

Reproduce with `python3 src/train_classifier.py`. It uses stratified 5-fold CV (seed 42) on the 6,314 labelled bin events, the 5 sensor features only, and out-of-fold predictions. Size is the saved `joblib` file. Time is the median `predict_proba` time for one item, on one CPU thread, on a busy laptop (8 cores, load average around 40 during the run). The numbers below are exactly what the script printed.

| Model | 5-Fold Accuracy (± fold std) | Macro-F1 | Model Size | Time per Item (CPU) | Route to Manual (<60%) |
|---|---|---|---|---|---|
| Decision Tree (depth=4) | 81.31% (±0.81) | 0.7754 | 4.91 KB | 0.45 ms | 2.55% |
| Random Forest (n=100, d=12) | 84.94% (±0.71) | 0.8278 | 9,824.58 KB | 6.18 ms | 10.96% |
| HistGradientBoosting | 84.13% (±0.83) | 0.8204 | 2,120.00 KB | 19.61 ms | 5.15% |
| LightGBM (n=100, d=5) | 84.64% (±1.06) | 0.8261 | 1,619.20 KB | 1.00 ms | 7.79% |
| **XGBoost (winner: d=4, n=100, lr=0.08)** | **85.37% (±0.97)** | **0.8342** | **923.02 KB** | **0.56 ms** | **9.44%** |

> **Winner:** XGBoost has the best macro-F1 (0.8342) and 85.37% accuracy. That is above the 85% target, but only by 0.37 points, which is less than one fold's standard deviation. Items the model is unsure about (below 60% confidence, 9.44% of items) go to `manual_sort`. On the remaining items, accuracy is **88.96%** (macro-F1 0.8638).
>
> **Per-class accuracy (recall):** ewaste 67.5%, food_organic 92.2%, glass 69.1%, metal 93.6%, paper_cardboard 86.9%, plastic 80.5%.
>
> **Sensor importance** (permutation importance: the accuracy drop when one sensor is shuffled, averaged over the 5 validation folds): moisture 0.239, acoustic hardness 0.162, transparency 0.148, weight 0.146, metal signal 0.145.
>
> **Correction (13:40):** An earlier version of this table, made by a run with no script in the repo, reported XGBoost at 85.51% / 0.8352 / 244 KB / 0.31 ms. The training script does not reproduce those numbers, so the table above replaces them.

---

### 2. Confusion Matrix & Misclassification Analysis

**Confusion Matrix (Rows = Actual, Columns = Predicted):**
```text
                 ewaste  food_organic  glass  metal  paper_cardboard  plastic
ewaste              237            12     10     49               20       23
food_organic          6          1707      2      1               97       39
glass                 8             7    221      5                8       71
metal                13             6      2    569                6       12
paper_cardboard       0            98      0      3             1270       90
plastic               1            37     28      4              266     1386
```

* **Where and why mix-ups occur:**
  1. **Plastic vs. Paper/Cardboard (266 plastic -> paper, 90 paper -> plastic):** Lightweight rigid plastic and dry cardboard have near-zero metal signatures and similar low density.
  2. **Glass vs. Plastic (71 glass -> plastic, 28 plastic -> glass):** Clear PET bottles and thin glass tumblers share identical optical transparency (>0.60) and overlapping acoustic resonance.
  3. **E-waste vs. Metal (49 ewaste -> metal):** Small appliances and cables contain high copper/aluminum proportions that trigger the inductive metal sensor similarly to beverage cans.

---

### 3. Interpretable Decision Tree Rules (4-Level Tree)

To prove explainability to facilities staff and regulatory auditors, the exact rules of the 4-level decision tree are:
```text
|--- moisture_pct <= 40.25
|   |--- metal_signal <= 27.35
|   |   |--- transparency <= 0.23
|   |   |   |--- acoustic_hardness <= 0.42 -> class: paper_cardboard
|   |   |   |--- acoustic_hardness >  0.42 -> class: plastic
|   |   |--- transparency >  0.23
|   |   |   |--- weight_g <= 221.00 -> class: plastic
|   |   |   |--- weight_g >  221.00 -> class: glass
|   |--- metal_signal >  27.35
|   |   |--- weight_g <= 303.00
|   |   |   |--- transparency <= 0.18 -> class: metal
|   |   |   |--- transparency >  0.18 -> class: ewaste
|   |   |--- weight_g >  303.00 -> class: ewaste
|--- moisture_pct >  40.25
|   |--- acoustic_hardness <= 0.53 -> class: food_organic
|   |--- acoustic_hardness >  0.53
|   |   |--- weight_g <= 193.50 -> class: plastic
|   |   |--- weight_g >  193.50
|   |   |   |--- moisture_pct <= 47.25 -> class: plastic
|   |   |   |--- moisture_pct >  47.25 -> class: food_organic
```

---

### 4. Cleaning Rules & Leakage (Cheating) Investigation

1. **Cleaning & Outlier Clamping Rule:**
   - 591 rows (9.36%) contained missing sensor telemetry. Dropping them was rejected as it starves rare classes (`glass`, `ewaste`).
   - Boundary clipping was enforced on physical limits: `weight_g >= 0`, `moisture_pct ∈ [0, 100]`, `metal_signal ∈ [0, 100]`, `transparency ∈ [0, 1]`, `acoustic_hardness ∈ [0, 1]`. Missing values stay NaN: XGBoost learns which branch they take, and `predict()` passes NaN through the same way (it no longer fills fixed defaults).
2. **Cheating / Spatial Leakage Check:**
   - In an earlier run (not part of `train_classifier.py`, so not re-measured here), adding `building_id` raised CV accuracy to 86.24%, because campus locations have heavy categorical priors (e.g. Food Court B07 is 48% organic food; Academic Block B03 is 65% paper).
   - **Decision:** Excluded both `building_id` and `bin_id` entirely from training features. A real physical smart bin installed in an uncatalogued room cannot rely on location shortcuts.

---

### 5. Hardware Justification (Raspberry Pi Zero 2 W)

* **Compute & Memory Budget:** The Raspberry Pi Zero 2 W costs Rs 1,500–2,000 and features a quad-core ARM Cortex-A53 CPU with only 512 MB RAM.
* **Why this model fits:** The saved XGBoost file is **923 KB** (under 0.2% of 512 MB RAM). On a laptop, the model alone takes **0.56 ms** per item. The full `predict()` call, including the per-feature reason and routing, had a median of **4.9 ms** over the 1,601 live test events. The slowest call took about 1 s, while the laptop had a load average of about 40 on 8 cores. Every event finished under the 2 s limit. We have not measured on a Pi Zero 2 W; expect it to be several times slower than the laptop. It consumes virtually zero battery power and eliminates any need for costly cloud GPUs.

---

### 6. Failure Mode and Operational Fix

* **Failure Mode (Sensor Drift):** Strain-gauge load cells and capacitive moisture probes drift over time due to dust buildup, thermal expansion, and residue adhesion, resulting in negative weights or spurious food classifications.
* **Operational Fix:** 
  1. The bin firmware runs an automated software tare (re-zero) every night at 3:00 AM when bins are empty.
  2. The central dashboard monitors rolling class distributions per bin; any bin showing a 3-day divergence >25% from historical variance triggers an automated technician cleaning alert.

---

### 7. Chronos-2 Comparison Note (For P1)

* **Chronos-2 Status:** Tested on environment. Pre-built PyTorch binaries for the host's Python 3.15 Windows AMD64 environment are not yet published on PyPI (`ResolutionImpossible`). Per schedule instructions, Chronos-2 runtime was dropped.
* **Not measured:** We never ran Chronos-2, so we have no time or error numbers for it. Its size and speed must not be quoted as our results. P1 owns the forecast comparison table; any Chronos-2 row there must come from a real run.
