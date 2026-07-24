# Story Mode — the interview engine

An on-device interviewer for custom-song intake. A small (phone-class) LLM interviews the customer, extracts **grounded factoids** from every answer, and compiles a self-contained **handoff prompt** — paste it into a frontier model (Gemini) and it writes Suno-ready lyrics + style + exclude fields. The small model is a **compiler, never an author**: it quotes and files, it never narrates.

**The chain:** Customer (APK) → interview → factoid construct → paste #1 into Gemini → lyrics + Suno fields → paste #2 into Suno → song. Zero API keys, zero hosting, zero bills.

## The loop

```
EXTRACT  — chunk each answer (~120 words), pull factoids {category, text, verbatim, heat}.
           Code drops any factoid whose verbatim isn't actually in the customer's words
           (anti-invention armor).
MERGE    — dedupe into the story state (token-overlap), keep the heavier fact.
RANK     — weight × category bonus; the sorted list is the construct.
QUESTION — model sees KNOWN / GAPS / HEAT / ASKED, returns one question.
           Code validates craft rules (no why, no yes/no, no compounds, no near-dupes);
           two strikes → deterministic fallback question.
STOP     — when the checklist is earned (3 specifics, 1 scene, emotion, identity, job,
           sound) or at the 12-turn ceiling. Unfilled slots are flagged THIN, honestly.
COMPILE  — deterministic render: dossier (operator) + handoff prompt (template merge)
           + finish screen (customer's own words mirrored back — zero generation).
```

## Layout

- `engine/` — the portable core (ports to Kotlin for the APK): `llm.js` `state.js` `extract.js` `question.js` `compile.js` `engine.js`
- `prompts/` — **operator-editable**: `extract.txt`, `question.txt`, `opening.txt` (ship as APK assets)
- `templates/handoff.md` — **operator-editable**: head = voice, body = per-customer payload, tail = Suno output contract
- `harness/` — persona players + re-ask judge; `personas/personas.json`
- `runs/` — saved evidence: transcripts, audits, dossiers, handoffs

## Run it

```
node play.js                          # be the customer yourself (qwen2.5:3b)
node harness/run.js chapters_writer   # the flagship gate: 2,233-word first answer, zero re-asks allowed
node harness/run.js terse_dad
node harness/run.js messy_typist
node harness/run.js grieving_mother
```

Models (all local via Ollama): interviewer `qwen2.5:3b` (phone-class stand-in for the APK model), persona actor `hermes3:8b`, judge `qwen3:14b`.

## Gates

1. **Chapters test** — 2,233-word first answer spanning ~15 topics; every later question must target genuinely new material. Judge audits every question against the full prior transcript. Any re-ask = fail.
2. **Stranger test** — the handoff prompt alone must let a songwriter model produce the right song with zero follow-ups.
Supporting: terse (honest thinness, no guilt), messy typist (understood anyway), grieving mother (consent at wounds, no chirp).
