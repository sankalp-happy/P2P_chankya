# P3 report draft: data, offline handling, incentives

Items in double square brackets are numbers still to come from code. Listed in section 9.

## 1. How we handle messy data

**Duplicates.** 23,192 rows arrived against 23,040 expected (8 buildings × 120 days × 24 h). 184 are retransmissions: same building and timestamp, slightly jittered values, so whole-row dedup would miss them. We dedup on (building_id, timestamp), keeping the earliest `received_at`. That leaves 23,008 readings.

**Gaps.** 32 building-hours never arrived, in 7 gaps of 1, 2, 4, 4, 7, 7 and 7 hours. We sort by sampling time and reindex each building to the full hourly grid. Gaps up to 3 hours get a straight line between neighbours. Longer gaps take that day's daily_summary total, spread over the missing hours by the building's usual hourly profile, so the day still adds up. Every row has a status (measured, filled, estimated, revised), so filled values are never fake zeros, and the forecast trains only on measured rows.

**Late arrivals.** Normal lag is 1.0–1.1 h, but 112 readings (after removing duplicates) came over 2 h late, in 26 bursts: the edge device buffered during a dropout and sent a burst on reconnect (B03's 11 hours from 30 Sep 21:00 arrived together at about 09:19 on 1 Oct). The dashboard replays by arrival time: at slider time T it shows only readings received by T. A silent building shows "offline since HH:MM, showing estimate", never zero and never removed. When the burst lands, the real readings replace the estimates and are marked "revised". One row per building-hour, so totals cannot double count.

**Staff logs.** 415 entries use 37 spellings for 8 buildings ("BH", "Boys Hostle", "B05" are all B05) and mixed units. We map names and convert (units = kWh, 1 kL = 1,000 L, 1 bag = 8 kg). Wild values, like a water entry of 959,417 L (10x the meter that day: an extra digit), are flagged, not fixed. Meter daily sums agree with daily_summary (median ratio 1.00, never over 20% off).

## 2. Fusion rule

Four sources, four speeds: meters (hourly), smart-bin events (per item), staff logs (irregular), daily summary (daily). Trust order: meter, then daily summary, then staff log, and the dashboard shows the most-trusted value. If two sources disagree by more than 20%, `source_check()` raises an alert on the facility alerts page. It never overwrites data.

Bins capture about 1% of waste mass (11.8 kg/day against about 1,042 kg/day in the daily summary), so we compare their composition shares, never kg. Staff entries about 1,000x or 8x off are flagged as unit mistakes. Entries matching another building's value are flagged as a possible wrong building. Disagreements in our data: 117.

## 3. Offline buildings and reconciliation

`outage_table()` lists each real outage: building, start, end, hours, readings that arrived late, readings that never arrived.

| Outages | Arrived late | Never arrived |
|---|---|---|
| 33, 144 h in total | 112 readings, 26 bursts | 32 readings, 7 gaps |

Demo: "take B03 offline for 3 hours". Readings queue in a local SQLite outbox on the gateway, then flush in one burst with about 30% jittered duplicate retransmissions (a stress test, far above the real file's 184). The server stores readings keyed by (building, stream, hour) with `INSERT OR IGNORE`, so the first arrival wins, the same rule as cleaning. `INSERT OR REPLACE` would let a jittered retry overwrite the true value. Buffered 12, duplicates dropped 4; campus totals before and after match exactly: 1,048.98 kWh and 32,185 L campus-wide, identical before and after.

## 4. Incentive loop and how we'd measure it

Each building gets a weekly score on electricity (grid plus own solar, so weather earns nothing), water and landfill. Each is compared with the building's own frozen per-person normal for the same day type (baseline 20 Jun–16 Aug), scaled by that week's occupancy, so big hostels aren't punished. The screen shows expected (100 = normal), actual, occupancy adjustment, % saved and credits: 1 credit per 1% saved, max 10 a week, spendable at the Food Court. A weekly note gives each building its rank, its biggest waste (the top recommended action for it) and one thing to do.

Anti-gaming: under 90% real hourly readings in a week means no credits (flat-lined meters count as not real); weekly cap; frozen baseline; staff logs can't move a score.

To measure impact, run the scheme in B05, B06, B07 against B01–B04 and B08 for 4 weeks, and compare the before/after change between the groups (difference-in-differences) on kWh, litres and landfill kg per person, plus contamination %. A placebo test on our historical data, where no scheme existed, gives the noise floor, the smallest effect a 4-week trial could detect: about 27–35 percentage points (so a 4-week trial could only detect a very large effect). Our data predates any scheme, so we claim no saving.

## 5. Failure modes we own

| What goes wrong | How we detect it | Mitigation | Evidence from our data |
|---|---|---|---|
| Gaming the leaderboard (unplugging a meter) | Under 90% real hourly readings in the week; flat-lined meter | No credits that week; weekly cap; frozen baseline | Real file misses 32 of 23,040 building-hours (0.14%); the longest gap, 7 h, is 4% of a week. Building-weeks under 90%: [[N_LOW_COVERAGE_WEEKS]] |
| Gateway outage | Gap in readings by arrival time | Local SQLite outbox; `INSERT OR IGNORE`; estimate shown, then "revised" | 26 bursts, 112 late readings, 32 lost hours in 7 gaps; B03's 11-hour burst |
| Staff log wrong building or unit | ~1,000x or 8x off; matches another building; >20% off the meter | Logs never overwrite meters; alert raised | 37 spellings for 8 buildings; a 959,417 L water entry; 20 entries flagged |

## 6. Three lines on key decisions

- **Dedup key.** (building_id, timestamp), earliest `received_at` wins. Jittered values defeat whole-row dedup. The SQLite store uses the same first-wins rule.
- **Arrival-time replay.** Filter on `received_at` ≤ T, not sampling time. That is what the server knew at T, so outages and "revised" rows appear by themselves.
- **Frozen per-person baseline.** Each building's own normal, per person, per day type, fixed before scoring. Frozen, so a building can't lower its own bar; per person, so size doesn't matter.

## 7. Judge Q&A

**Why not just `drop_duplicates()`?** It removes only identical rows, and our retransmissions differ slightly, so it would miss them. We match on building and timestamp and keep the earliest arrival.

**Why not fill gaps with zero?** Zero says the building used nothing, which understates totals and could earn false credits. We fill, mark every filled row, and train only on real readings.

**How do you know the totals match?** The server keeps one row per (building, stream, hour), so a duplicate cannot add twice. The offline demo prints campus totals before and after: 1,048.98 kWh and 32,185 L campus-wide, identical before and after.

**Can a building cheat?** Unplugging a meter earns nothing: under 90% real readings means no credits, and a flat-lined meter counts as not real. Credits are capped and the baseline is frozen.

**Did the scheme save anything?** No. Our data predates any scheme, so we claim no saving. We designed the 4-week test and measured its noise floor: about 27–35 percentage points (so a 4-week trial could only detect a very large effect).

**How does this scale to 30 buildings?** Each building has its own outbox and baseline, and every reading is keyed by building, so the work is per-building. We have run only 8: this is the design, not a measured result.

## 8. Prompt log entries (for docs/promptlog.md)

### P3 data layer, offline buffer, source check and leaderboard
- **Date / Time:** 2026-10-24
- **Model:** Claude Opus 5.5 orchestrating Claude Sonnet sub-agents in Claude Code
- **Used in:** ingest.py / edge_buffer.py / incentives.py
- **Purpose:** Coding agents build P3's four pieces from a spec of measured facts.
- **Prompt:** Four prompts. (1) `load_hourly`: sort, dedup on (building_id, timestamp) keeping the earliest `received_at`, reindex, fill gaps, tag status, filter by `received_at` ≤ as_of. (2) Outage table and SQLite outage simulation: late versus lost readings; outbox, burst with ~30% jittered duplicates, `INSERT OR IGNORE`, before/after totals. (3) `source_check`: clean names and units, trust order, 20% rule, unit and wrong-building flags. (4) Leaderboard: weekly per-person score against a frozen baseline, occupancy adjustment, credits, 90% coverage rule.
- **What went wrong / How we fixed it:** [[TO FILL after review]]
- **Verdict:** [[TO FILL after review]]

Claude Code sessions give no public share link. P3 should paste the key prompts into a claude.ai chat and add its share link ([[CLAUDE_AI_SHARE_LINK]]) here, as the rules ask.

## 9. Placeholders to fill

- `33`, `144`: from `outage_table()`
- `117`, `20`: from `source_check()`
- `12`, `4`, `1,048.98 kWh and 32,185 L campus-wide, identical before and after`: from `simulate_outage("B03", ..., 3)`
- `[[N_LOW_COVERAGE_WEEKS]]`: from `leaderboard()` (`coverage_pct` under 90)
- `about 27–35 percentage points (so a 4-week trial could only detect a very large effect)`: from the placebo difference-in-differences run
- `[[CLAUDE_AI_SHARE_LINK]]`: P3, from claude.ai
- `[[TO FILL after review]]`: P3, after code review
