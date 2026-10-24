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
for path in _POSSIBLE_CACHE_PATHS:
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                _CACHE_DATA = json.load(f)
            break
        except Exception:
            pass

VALID_TAGS = {"leak", "maintenance", "fest", "other"}


def _deterministic_template_why(rec):
    """Fallback generator using only provided facts."""
    if isinstance(rec, str):
        return rec
    bldg = rec.get("building", rec.get("building_id", "Campus building"))
    cause = rec.get("cause", "an unexpected consumption deviation")
    action = rec.get("action", "inspect facility connections")
    reading = rec.get("reading", rec.get("value", ""))
    stream = rec.get("stream", "resource")
    rupees = rec.get("rupees_saved", rec.get("rupees", ""))
    co2 = rec.get("co2_kg", "")
    note = rec.get("staff_note", rec.get("note", ""))
    event = rec.get("calendar_event", rec.get("event", ""))

    first_sentence = f"In {bldg}, unusual {stream} reading ({reading}) was flagged due to {cause}."
    if note and note not in ["approx", "evening reading", "as per meter", "daily total", "counted at end of day"]:
        first_sentence = f"In {bldg}, unusual {stream} reading ({reading}) matches staff log: '{note}'."
    elif event:
        first_sentence = f"In {bldg}, consumption anomaly coincides with scheduled calendar event: {event}."

    savings_parts = []
    if rupees != "" and rupees is not None:
        savings_parts.append(f"Rs {rupees}")
    if co2 != "" and co2 is not None:
        savings_parts.append(f"{co2} kg CO2")

    if savings_parts:
        second_sentence = f"Action needed: {action}, saving approximately {' and '.join(savings_parts)}."
    else:
        second_sentence = f"Recommended action is to {action} immediately."

    return f"{first_sentence} {second_sentence}".strip()


def why(recommendation):
    """
    Returns 1-2 plain sentences explaining a facility alert/action.
    Claude/Groq uses strictly the provided evidence without inventing facts.
    Falls back gracefully to why_cache.json and deterministic templates.
    """
    if not recommendation:
        return "No alert details provided."

    # 1. Check offline cache
    cache_key = None
    if isinstance(recommendation, dict):
        bldg = recommendation.get("building", recommendation.get("building_id", ""))
        cause = recommendation.get("cause", "")
        stream = recommendation.get("stream", "")
        cache_key = f"{bldg}_{stream}_{cause}"
        if cache_key in _CACHE_DATA:
            return _CACHE_DATA[cache_key]

    # 2. Check Anthropic Claude Haiku
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    if anthropic_key:
        try:
            import anthropic
            client = anthropic.Anthropic(api_key=anthropic_key)
            msg = client.messages.create(
                model="claude-haiku-5-5",
                max_tokens=150,
                system="Explain this campus facility alert in at most two plain sentences. "
                       "Use only the facts given. Include the numbers.",
                messages=[{"role": "user", "content": json.dumps(recommendation)}],
            )
            text = msg.content[0].text.strip()
            if text:
                return text
        except Exception:
            pass

    # 3. Check Groq API if available
    groq_key = os.environ.get("GROQ_API_KEY")
    if groq_key:
        try:
            from groq import Groq
            client = Groq(api_key=groq_key)
            completion = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                max_tokens=150,
                messages=[
                    {
                        "role": "system",
                        "content": "Explain this campus facility alert in at most two plain sentences. "
                                   "Use only the facts given. Include the numbers. Do not invent any outside facts."
                    },
                    {
                        "role": "user",
                        "content": json.dumps(recommendation)
                    }
                ],
                temperature=0.2
            )
            text = completion.choices[0].message.content.strip()
            if text:
                return text
        except Exception:
            pass

    # 4. Fallback to deterministic template
    return _deterministic_template_why(recommendation)


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
    print("Testing explain.py...")
    sample_rec = {
        "building": "Boys Hostel (B05)",
        "stream": "water",
        "reading": "18,400 L/hr",
        "cause": "pipe rupture near washroom shaft",
        "action": "send emergency plumber to isolate valve",
        "rupees_saved": 1472,
        "co2_kg": 0
    }
    print("\nwhy() result:\n", why(sample_rec))
    
    test_notes = [
        "Plumber called. Leak suspected in underground line near block entrance.",
        "Rooftop solar inverter showing red error light since Tuesday.",
        "Alumni meet tomorrow, expecting 1500+ people. Extra cooking planned.",
        "evening reading"
    ]
    print("\ntag_note() results:")
    for n in test_notes:
        print(f"  '{n}' -> {tag_note(n)}")
