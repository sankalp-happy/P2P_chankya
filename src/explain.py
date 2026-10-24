"""
Explain module for Campus Resource Grid.
Generates human-readable explanations ("why") for facility alerts and
categorizes maintenance/staff notes.

Features:
- Primary: Claude Haiku (claude-haiku-5-5) via Anthropic API (ANTHROPIC_API_KEY)
- Alternative: Groq API (GROQ_API_KEY) using LLaMA-3.3-70B / 3.1-8B
- Offline Safe: Precomputed cache in data/why_cache.json
- Resilient Fallback: Deterministic factual sentence template and keyword tagger
"""

import os
import json
import re
import hashlib

# Resolve data cache path
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
_POSSIBLE_CACHE_PATHS = [
    os.path.join(_CURRENT_DIR, "data", "why_cache.json"),
    os.path.join(_CURRENT_DIR, "P2P_chankya", "data", "why_cache.json"),
    os.path.join(os.path.dirname(_CURRENT_DIR), "data", "why_cache.json"),
    os.path.join(os.path.dirname(_CURRENT_DIR), "P2P_chankya", "data", "why_cache.json"),
    "data/why_cache.json",
    "P2P_chankya/data/why_cache.json"
]

_CACHE_DATA = {}
path = None
for path in _POSSIBLE_CACHE_PATHS:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                _CACHE_DATA = json.load(f)
            break
        except Exception:
            pass

VALID_TAGS = {"leak", "maintenance", "fest", "other"}
_CACHE_PATH = path if os.path.exists(path) else os.path.join(os.path.dirname(_CURRENT_DIR), "data", "why_cache.json")

# Demo times to precompute (the as_of values P1's attribution self-check uses).
DEMO_TIMES = ["2026-08-07 20:00", "2026-08-28 06:00", "2026-09-05 06:00", "2026-09-10 06:00",
              "2026-10-03 06:00", "2026-10-09 06:00"]
_STREAM_NAME = {"electricity_kwh": "electricity", "water_litres": "water", "solar_kwh": "solar generation",
                "landfill_kg": "landfill waste", "contamination_pct": "bin contamination"}
WHY_SYSTEM = ("Rephrase this campus facility alert in at most two plain sentences. Use only the facts in the JSON. "
              "Keep every number exactly as given. Do not add causes, equipment, places or numbers that are not in it.")


def _facts(rec):
    """The only fields the model may see: P1's evidence for one recommendation (attribution.recommend)."""
    keys = ["building_id", "building_name", "stream", "cause", "unusual", "confidence", "action",
            "rupees_saved", "co2_kg", "how_computed", "runner_up"]
    f = {k: rec[k] for k in keys if k in rec}
    f["evidence"] = [e[0] if isinstance(e, (list, tuple)) else e for e in rec.get("evidence", [])]
    return f


def _key(facts):
    """Stable hash of the evidence, so a cached text is only reused for exactly the same facts."""
    return hashlib.sha1(json.dumps(facts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _numbers(text):
    return {n.replace(",", "").rstrip(".") for n in re.findall(r"\d[\d,]*\.?\d*", text)}


def _grounded(text, facts):
    """True if every number in the model's text also appears in the facts (no invented figures)."""
    allowed = _numbers(json.dumps(facts, default=str)) | {"1", "2"}
    allowed |= {f"{float(n):.0f}" for n in allowed if n.replace(".", "", 1).isdigit()}
    return _numbers(text) <= allowed


def _template_why(f):
    """Fallback: two sentences built only from P1's fields."""
    where = f"{f.get('building_name', f.get('building_id', 'A building'))} ({f.get('building_id', '?')})"
    stream = _STREAM_NAME.get(f.get("stream"), f.get("stream", "usage"))
    cause = str(f.get("cause", "unexplained")).replace("_", " ")
    first = f"{where} {stream} was {f.get('unusual', 'unusual')}, most likely {cause}"
    first += f" ({f['evidence'][0]})." if f.get("evidence") else "."
    second = f"Action: {f.get('action', 'inspect the building').rstrip('.')}"
    second += f" ({f['how_computed']})." if f.get("rupees_saved") else "."
    return f"{first} {second}"


def _llm_why(facts):
    """(text, source) from Claude Haiku, then Groq; None if neither is available or the text adds numbers."""
    user = json.dumps(facts, default=str)
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            import anthropic
            msg = anthropic.Anthropic().messages.create(
                model="claude-haiku-5-5", max_tokens=150, system=WHY_SYSTEM,
                messages=[{"role": "user", "content": user}])
            text = msg.content[0].text.strip()
            if text and _grounded(text, facts):
                return text, "claude-haiku-5-5"
        except Exception:
            pass
    if os.environ.get("GROQ_API_KEY"):
        try:
            from groq import Groq
            completion = Groq().chat.completions.create(
                model="llama-3.3-70b-versatile", max_tokens=150, temperature=0.2,
                messages=[{"role": "system", "content": WHY_SYSTEM}, {"role": "user", "content": user}])
            text = completion.choices[0].message.content.strip()
            if text and _grounded(text, facts):
                return text, "groq llama-3.3-70b-versatile"
        except Exception:
            pass
    return None


def why(recommendation):
    """
    One or two plain sentences for one of P1's recommendations (a dict from attribution.recommend).
    Order: cache keyed on the evidence -> Claude Haiku -> Groq -> template. The LLM text is rejected
    if it contains a number that is not in P1's evidence.
    """
    if not recommendation:
        return "No alert details provided."
    if isinstance(recommendation, str):
        return recommendation
    facts = _facts(recommendation)
    hit = _CACHE_DATA.get("why", {}).get(_key(facts))
    if hit:
        return hit["text"]
    llm = _llm_why(facts)
    return llm[0] if llm else _template_why(facts)


def build_cache(times=DEMO_TIMES, top=5):
    """Precompute why() for P1's real recommendations at the demo times. Run: python3 src/explain.py --build-cache"""
    import sys
    sys.path.insert(0, os.path.dirname(_CURRENT_DIR))
    from attribution import recommend  # P1's file, repo root
    out = {}
    for t in times:
        for rec in recommend(t, top=top):
            facts = _facts(rec)
            text, source = _llm_why(facts) or (_template_why(facts), "template")
            out[_key(facts)] = {"as_of": t, "building_id": rec["building_id"], "cause": rec["cause"],
                                "stream": rec["stream"], "source": source, "text": text}
    _CACHE_DATA["why"] = out
    with open(_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(_CACHE_DATA, f, indent=2, ensure_ascii=False)
    return out


def tag_note(note):
    """
    Reads a staff note and returns exactly one of: 'leak', 'maintenance', 'fest', 'other'.
    If the LLM returns anything else, returns 'other'.
    """
    if not note or not isinstance(note, str):
        return "other"

    note_clean = note.strip()

    # 1. Check cached note tags
    cached_notes = _CACHE_DATA.get("notes_tagged", {})
    if note_clean in cached_notes:
        return cached_notes[note_clean]

    # 2. Check Anthropic Claude
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=anthropic_key)
            msg = client.messages.create(
                model="claude-haiku-5-5",
                max_tokens=20,
                system="Classify the staff note into exactly one category: leak, maintenance, fest, other. "
                       "Output ONLY the category word.",
                messages=[{"role": "user", "content": note_clean}],
            )
            tag = msg.content[0].text.strip().lower()
            if tag in VALID_TAGS:
                return tag
        except Exception:
            pass

    # 3. Check Groq API
    groq_key = os.environ.get("GROQ_API_KEY")
    if groq_key:
        try:
            from groq import Groq
            client = Groq(api_key=groq_key)
            completion = client.chat.completions.create(
                model="llama-3.1-8b-instant",
                max_tokens=20,
                messages=[
                    {
                        "role": "system",
                        "content": "Classify the staff note into exactly one category: leak, maintenance, fest, other. "
                                   "Output ONLY the category word."
                    },
                    {
                        "role": "user",
                        "content": note_clean
                    }
                ],
                temperature=0.0
            )
            tag = completion.choices[0].message.content.strip().lower()
            if tag in VALID_TAGS:
                return tag
        except Exception:
            pass

    # 4. Deterministic fallback tagger
    lower = note_clean.lower()
    if any(k in lower for k in ["leak", "burst", "wet patch", "dripping", "overflow"]):
        return "leak"
    elif any(k in lower for k in ["maintenance", "repair", "pump", "inverter", "calibrat", "motor", "stuck", "flicker", "vendor", "plumber"]):
        return "maintenance"
    elif any(k in lower for k in ["fest", "alumni", "cooking", "event", "celebration", "gathering"]):
        return "fest"
    else:
        return "other"


if __name__ == "__main__":
    import sys
    if "--build-cache" in sys.argv:
        built = build_cache()
        print(f"cached {len(built)} explanations:", {v["source"] for v in built.values()})
    # A record shaped like attribution.recommend() output (B04 inverter, 2026-10-09 06:00).
    rec = {"rank": 1, "building_id": "B04", "building_name": "Engineering Labs & Innovation Centre",
           "stream": "solar_kwh", "cause": "equipment_down", "confidence": 0.5,
           "unusual": "only 0% of the usual for a typical day",
           "evidence": [("staff note (lab_technician, 07 Oct 11:30): 'Rooftop solar inverter showing red error light since Tuesday.'", 3)],
           "action": "Call vendor to reset/repair the B04 rooftop solar inverter; 907 kWh of solar lost so far (bought from the grid).",
           "rupees_saved": 7258.8, "co2_kg": 635.14, "how_computed": "907 kWh lost x Rs 8 = Rs 7,259; x 0.7 kg = 635 kg CO2"}
    text = _template_why(_facts(rec))
    assert "Rs 7,259" in text and "red error light" in text and _grounded(text, _facts(rec)), text
    assert not _grounded("Saving Rs 1,472 today.", _facts(rec))  # an invented number is caught
    assert _key(_facts(rec)) == _key(_facts({**rec, "rank": 3, "why": "x"}))  # rank/why do not change the key
    print("why():", why(rec))

    import pandas as pd
    notes = pd.read_csv(os.path.join(os.path.dirname(_CURRENT_DIR), "datasets", "raw", "manual_logs.csv"))
    notes = notes[notes.stream == "note"].note.str.strip().unique()
    tagged = _CACHE_DATA.get("notes_tagged", {})
    assert all(n in tagged for n in notes), [n for n in notes if n not in tagged]
    assert all(tag_note(n) in VALID_TAGS for n in notes)
    print(f"tag_note(): all {len(notes)} staff notes tagged, e.g.", {n[:40]: tag_note(n) for n in notes[:3]})
    print("explain.py self-check passed")
