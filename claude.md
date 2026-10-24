# claude.md — AI Usage Rules for P2P Chanakya

This file tells every team member (and any AI assistant working on this repo) the rules for using Claude and other AI models in this project.

---

## 🔑 Core rule

**Every prompt you send to Claude (or any AI model) must be logged in [`docs/promptlog.md`](docs/promptlog.md) before you commit your code.**

No exceptions. This is a graded deliverable — a fifth of our marks come from the prompt log.

---

## What counts as a prompt

Log it if you:

- call `anthropic.messages.create(...)` or any equivalent SDK method in Python code
- paste text into Claude.ai, ChatGPT, Gemini, or any chat interface to help with this project
- use a GitHub Copilot / Cursor / AI-assisted completion that you explicitly crafted (not auto-suggested boilerplate)
- use an AI to interpret results or write any part of the report

You do **not** need to log:
- generic autocomplete suggestions you didn't prompt for
- spell-check or grammar suggestions

---

## How to log a prompt

Open `docs/promptlog.md` and copy this template into the right section:

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

## Sections in the prompt log

| Section | Who fills it | What goes there |
|---|---|---|
| Section 1 — Waste-event explanations | P2 | `explain.py · why()` prompts |
| Section 2 — Staff-note tagging | P2 | `explain.py · tag_note()` prompts |
| Section 3 — Exploratory / one-off | Anyone | Dev, debug, or data questions |
| Section 4 — Chronos-2 comparison | P2 (after 2:00) | Prompts for interpreting model results |

---

## Rules for writing prompts in code

1. **Never let Claude invent facts.** Always pass the exact numbers and notes from P1/P3 in the prompt. Do not let the model speculate.
2. **Separate the system prompt from the user turn.** The system prompt sets behaviour; the user turn carries the data.
3. **Set `max_tokens` explicitly** so the model doesn't ramble.
4. **Pre-generate and cache** all Claude responses to a file before the demo — the demo must work without internet.
5. **Provide a fallback.** If the API call fails, return a fixed template sentence, not an error.

---

## Checklist before committing

- [ ] Every new or changed prompt is in `docs/promptlog.md`
- [ ] The prompt entry includes a sample output
- [ ] The "what went wrong / how we fixed it" fields are filled if you iterated
- [ ] The Reflection table in `docs/promptlog.md` is filled in (do this at 2:30)

---

## Who owns what

| File | Owner |
|---|---|
| `docs/promptlog.md` | **P2** — keep it up to date, resolve conflicts |
| `explain.py` | P2 |
| `classifier.py` | P2 |
| `claude.md` | P2 — update if rules change |

If you are an AI assistant helping with this repository: always append new prompt entries to `docs/promptlog.md` whenever you write or revise a prompt that will be used in the project code or report.
