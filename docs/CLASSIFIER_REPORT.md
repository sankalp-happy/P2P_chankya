# Classifier Report: Smart-Bin Waste Sorter (P2 Deliverable for P4)
**Author:** P2 (Waste Sorting Model & Explainability)  
**Target Submission:** For P4 final integration and pitch report

---

### 1. Model Architecture & Ablation Comparison

We rigorously evaluated three primary tree-based families using 5-fold Stratified Cross-Validation on the 6,314 labeled bin events:

| Model Architecture | 5-Fold Accuracy | Macro-F1 | Model Size | Latency per Item (CPU) | Route to Manual (<60%) |
|---|---|---|---|---|---|
| **Decision Tree (depth=4)** | 81.31% | 0.7754 | 2.72 KB | 0.15 ms | 2.55% |
| **HistGradientBoosting** | 84.10% | 0.8191 | 841.03 KB | 6.85 ms | 5.50% |
| **Random Forest (n=100, d=12)** | 84.94% | 0.8280 | 2,061.74 KB | 18.09 ms | 11.00% |
| **LightGBM (n=100, d=5)** | 85.05% | 0.8302 | 642.52 KB | 0.94 ms | 7.95% |
| **XGBoost (Winner: d=4, n=100, lr=0.08)** | **85.51%** | **0.8352** | **244.32 KB** | **0.31 ms** | **9.72%** |

> **Winner Selection:** **XGBoost** achieves the highest Macro-F1 (**0.8352**) and surpasses the target with **85.51% overall raw accuracy**. With the "not sure" filter (< 60% confidence routed to `manual_sort`), accuracy on the sorted stream reaches **89.18%** (Macro-F1: **0.8660**), affecting only 9.72% of ambiguous items.

---

### 2. Confusion Matrix & Misclassification Analysis

**Confusion Matrix (Rows = Actual, Columns = Predicted):**
```text
                 ewaste  food_organic  glass  metal  paper_cardboard  plastic
ewaste              242            12      9     45               20       23
food_organic          5          1709      3      1               97       37
glass                 9             7    218      5                8       73
metal                16             6      2    567                6       11
paper_cardboard       1           101      0      3             1272       84
plastic               2            33     27      3              266     1391
```

* **Where and why mix-ups occur:**
  1. **Plastic vs. Paper/Cardboard (266 plastic -> paper, 84 paper -> plastic):** Lightweight rigid plastic and dry cardboard have near-zero metal signatures and similar low density.
  2. **Glass vs. Plastic (73 glass -> plastic, 27 plastic -> glass):** Clear PET bottles and thin glass tumblers share identical optical transparency (>0.60) and overlapping acoustic resonance.
  3. **E-waste vs. Metal (45 ewaste -> metal):** Small appliances and cables contain high copper/aluminum proportions that trigger the inductive metal sensor similarly to beverage cans.

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
   - Boundary clipping was enforced on physical limits: `weight_g >= 0`, `moisture_pct ∈ [0, 100]`, `metal_signal ∈ [0, 100]`, `transparency ∈ [0, 1]`, `acoustic_hardness ∈ [0, 1]`. Missing values are natively partitioned in the tree histogram splits without synthetic distortion.
2. **Cheating / Spatial Leakage Check:**
   - Incorporating `building_id` falsely boosts cross-validation accuracy to **86.24%** (+0.73%) because campus locations have heavy categorical priors (e.g. Food Court B07 is 48% organic food; Academic Block B03 is 65% paper).
   - **Decision:** Excluded both `building_id` and `bin_id` entirely from training features. A real physical smart bin installed in an uncatalogued room cannot rely on location shortcuts.

---

### 5. Hardware Justification (Raspberry Pi Zero 2 W)

* **Compute & Memory Budget:** The Raspberry Pi Zero 2 W costs Rs 1,500–2,000 and features a quad-core ARM Cortex-A53 CPU with only 512 MB RAM.
* **Why this model fits:** The saved XGBoost artifact is just **244 KB** (0.04% of available RAM) and single-item CPU latency is **0.31 ms** (over 6,000x faster than the 2-second target). It consumes virtually zero battery power and eliminates any need for costly cloud GPUs.

---

### 6. Failure Mode and Operational Fix

* **Failure Mode (Sensor Drift):** Strain-gauge load cells and capacitive moisture probes drift over time due to dust buildup, thermal expansion, and residue adhesion, resulting in negative weights or spurious food classifications.
* **Operational Fix:** 
  1. The bin firmware runs an automated software tare (re-zero) every night at 3:00 AM when bins are empty.
  2. The central dashboard monitors rolling class distributions per bin; any bin showing a 3-day divergence >25% from historical variance triggers an automated technician cleaning alert.

---

### 7. Chronos-2 Comparison Note (For P1)

* **Chronos-2 Status:** Tested on environment. Pre-built PyTorch binaries for the host's Python 3.15 Windows AMD64 environment are not yet published on PyPI (`ResolutionImpossible`). Per schedule instructions, Chronos-2 runtime was dropped.
* **Key Metric for Pitch:** Chronos-2 requires **120 Million parameters (~480 MB)** and hundreds of milliseconds of compute per step. Our small gradient boosting model achieves instant edge inference on a **244 KB footprint**, justifying decentralized campus deployment on cheap microcomputers.
