# Prompt Log — Campus Resource Grid (P2P Chanakya)

> **Owner:** P2 · **File:** `docs/promptlog.md`
> Every time you call Claude (or any AI model) in this project, add a new entry here.
> A fifth of the final marks are for *how* we used AI — quality, iteration, and reflection matter.

---

## How to add an entry

Copy the template below, fill it in, and append it at the bottom of this file under the correct section.

```
### [Short title describing what the prompt does]
- **Date / Time:** YYYY-MM-DD HH:MM
- **Model:** Claude Haiku / GPT-4o / etc.
- **Used in:** explain.py / classifier.py / etc.
- **Purpose:** One line — what were you asking the model to do?
- **Prompt:**
  ```
  <paste the exact prompt here>
  ```
- **Sample output:**
  ```
  <paste a representative response>
  ```
- **What went wrong (if anything):**
- **How we fixed it:**
- **Verdict:** ✅ Kept / ⚠️ Revised / ❌ Dropped
```

---

## Section 1 — Waste-event explanations (`explain.py · why()`)

_These prompts generate the two-sentence "why" for each recommendation that P1 produces._

<!-- Add entries here -->

---

## Section 2 — Staff-note tagging (`explain.py · tag_note()`)

_These prompts classify a raw staff log entry as: `leak`, `maintenance`, `fest`, or `other`._

<!-- Add entries here -->

---

## Section 3 — One-off / exploratory prompts

_Prompts used during development, debugging, or data exploration that are not called at runtime._

<!-- Add entries here -->

---

## Section 4 — Chronos-2 / model comparison (P2 after 2:00)

_Any prompts used to interpret or narrate the Chronos-2 comparison results._

<!-- Add entries here -->

---

## Reflection

_Fill this in during the 2:30–3:10 wrap-up window._

| Question | Answer |
|---|---|
| Which prompt took the most iterations to get right? | |
| What was the biggest mistake the model made? | |
| How did we prevent the model from inventing facts? | |
| Would we use AI differently next time? | |
