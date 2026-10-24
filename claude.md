# claude.md — AI Usage Rules for P2P Chanakya

This file tells every team member (and any AI assistant working on this repo) the rules for using Claude and other AI models in this project, and the general collaboration rules for the whole hackathon.

---

## 🤝 Team collaboration rules

### File ownership — do not touch someone else's files

Each person owns specific files. **Only edit your own files.** If you need a change in someone else's file, ask them — don't push it yourself.

| Person | Owns |
|---|---|
| **P1** | `forecast.py`, `attribution.py` |
| **P2** | `classifier.py`, `explain.py`, `docs/promptlog.md`, `claude.md` |
| **P3** | `ingest.py`, `edge_buffer.py`, `incentives.py` |
| **P4** | `app.py`, `pages/`, `schema.py`, report, video |

> **Why this matters:** We have 4 hours. A single merge conflict can cost 20 minutes. Staying in your lane is the fastest strategy.

### Git rules

- **Pull before you push.** Always `git pull` before starting a new work block.
- **Commit often, in small pieces.** One logical change per commit — don't batch unrelated edits.
- **Write a useful commit message.** Bad: `"fix"`. Good: `"classifier: add fallback for low-confidence predictions"`.
- **Never force-push to `main`.** If you have a conflict, resolve it locally first.
- **Never commit secrets.** The Anthropic API key goes in a `.env` file, which is already in `.gitignore`.

### Shared interfaces — do not change without telling everyone

The function signatures in `schema.py` are agreed on at 0:00–0:20 and then **frozen**. If you absolutely must change a signature, post in the group chat first and wait for a reply. Changing a shared function silently breaks everyone downstream.

### Communication

- If you are going to be late on a handoff (P3 → P1 at 1:15), say so at least 10 minutes early.
- If something is broken and it's not your file, raise it immediately — don't stay silent and work around it.
- At 2:30 everyone stops adding features. No exceptions.

### General

- **Don't rename or move files** owned by someone else.
- **Don't install new packages** without telling the group — everyone's environment must stay in sync.
- **Don't use the Claude API key** for anything outside this project.
- If you break something accidentally, say so and roll back — no blame, just fix it fast.

---

## 🔑 Core rule

**Every prompt you send to any AI model must appear in [`docs/promptlog.md`](docs/promptlog.md) before you commit your code.**

No exceptions. A fifth of our marks come from the prompt log.

**There are two formats — pick the one that takes less effort:**

| Situation | Format to use |
|---|---|
| Chat / IDE assistant / exploratory (Claude.ai, ChatGPT, Gemini, Antigravity, Copilot…) | ⚡ **Quick Log** — one row in the Section 5 table |
| Prompt that ends up inside Python code (`explain.py`, `classifier.py`, etc.) | 📋 **Full Entry** — complete template with verdict |

The Quick Log takes 30 seconds. There is no excuse to skip it.

---

## What counts as a prompt

Log it if you:

- call `anthropic.messages.create(...)` or any equivalent SDK method in Python code → **Full Entry**
- paste text into Claude.ai, ChatGPT, Gemini, Antigravity, or any AI chat to help with this project → **Quick Log row**
- use GitHub Copilot / Cursor / any AI-assisted completion you explicitly crafted → **Quick Log row**
- use an AI to interpret results or write any part of the report → **Quick Log row**

You do **not** need to log:
- generic autocomplete suggestions you didn't craft
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
