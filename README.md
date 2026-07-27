# Story Mode — the interview engine

An on-device interviewer for custom-song intake. A small (phone-class) LLM interviews the customer, extracts **grounded factoids** from every answer, and compiles a self-contained **handoff prompt** — paste it into a frontier model (Gemini) and it writes Suno-ready lyrics + style + exclude fields. The small model is a **compiler, never an author**: it quotes and files, it never narrates.

**The chain:** Customer (APK) → interview → factoid construct → paste #1 into Gemini → lyrics + Suno fields → paste #2 into Suno → song. Zero API keys, zero hosting, zero bills.

## The fork (who is this song for?)

One question at the front door decides the whole interview's shape. `prompts/modes.json` is
operator-editable data — each mode carries its own opening question, checklist labels, interviewer
lens, and name question:

| mode | subject | what changes |
|---|---|---|
| `person` | someone they love | the default |
| `memorial` | someone they've lost | gentle pacing, grief as expected material |
| `wedding` | a couple | both names, the story of the two of them |
| `self` | the customer | asks about *you*, never "them" |
| `business` | a shop or brand | no relationship questions; regulars' rituals, what customers *feel* |

Adding a mode is a JSON entry — no code, no rebuild of the engine.

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
- `prompts/` — **operator-editable**: `extract.txt`, `question.txt`, `opening.txt`, `modes.json` (ship as APK assets)
- `templates/handoff.md` — **operator-editable**: head = voice, body = per-customer payload, tail = Suno output contract
- `harness/` — persona players + re-ask judge; `personas/personas.json`
- `runs/` — saved evidence: transcripts, audits, dossiers, handoffs

## Run it

```
node play.js                           # be the customer yourself
node harness/gates.js qwen2.5:1.5b     # all five personas + re-ask audit (the shipped brain)
node harness/gates.js qwen2.5:3b       # regression on the bigger brain
node harness/stranger.js runs/<run>.json qwen3:14b
```

Models (all local via Ollama): interviewer `qwen2.5:1.5b` (the class that ships in the APK) with
`qwen2.5:3b` as regression, persona actor `hermes3:8b`, judge `qwen3:14b`.

**Judges must think.** Ollama's `format=json` makes qwen3 go degenerate — the judges call the model
plainly and parse JSON out of the reply.

## Gates — all currently PASS on both brains

1. **Chapters test** (flagship) — 2,233-word first answer spanning ~15 topics; every later question must target genuinely new material. Any re-ask = fail.
2. **Stranger test** — the handoff prompt alone must let a songwriter model produce the right song with zero follow-ups.
3. Terse dad (7-word answers; honest thinness, no guilt) · Messy typist (voice-to-text chaos) · Grieving mother (memorial mode; consent at wounds, no chirp) · Business owner (business mode; no relationship questions, no slogans).

Every fix in this engine came from a failed transcript, and nearly every one moved authority from the
model into code: plausibility floors, deterministic heals, fixed question templates, anchored
fallbacks, and validators that reject a question before a customer ever sees it.
