// Story state — the factoid construct. Pure code: no model calls in this file.
"use strict";

// Checklist categories and how many earned entries each needs before the interview may stop.
const CATEGORIES = {
  identity: { need: 1, label: "Who the song is about (name + relationship)" },
  specific: { need: 3, label: "Unmistakable specifics (objects, habits, sayings, rituals)" },
  scene:    { need: 1, label: "A scene with a beginning, middle, end" },
  emotion:  { need: 1, label: "The emotional center (and any tension inside it)" },
  job:      { need: 1, label: "The song's job (occasion, room, moment)" },
  sound:    { need: 1, label: "The sound (genre / reference artists / energy)" },
  boundary: { need: 0, label: "What must NOT appear" },
  sacred:   { need: 0, label: "Phrases that must survive verbatim" },
};
const CAT_KEYS = Object.keys(CATEGORIES);

// Priority when choosing what to ask for next (earlier = asked sooner).
// Identity first, then story material while rapport builds, practical slots last.
const GAP_PRIORITY = ["identity", "specific", "scene", "emotion", "job", "sound", "boundary"];

const HARD_CEILING = 12; // max customer turns, per the brief's budget

function createState() {
  return {
    factoids: [],        // {id, category, text, verbatim, weight, flags[], turn}
    transcript: [],      // {q, a, turn, ts}
    asked: [],           // questions asked, in order
    turn: 0,
    name: null,          // subject's name once learned
    done: false,
    thin: [],            // categories flagged thin at finish
  };
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s) { return norm(s).split(" ").filter((w) => w.length > 2); }

function jaccard(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

let _id = 0;
function addFactoid(state, f) {
  const text = String(f.text || "").trim();
  if (!text) return null;
  // Dedupe: same category + high token overlap = same fact. Keep the heavier one.
  for (const g of state.factoids) {
    if (jaccard(g.text, text) >= 0.6) {
      if ((f.weight || 0) > g.weight) { g.text = text; g.weight = f.weight; g.verbatim = f.verbatim || g.verbatim; }
      return g;
    }
  }
  const rec = {
    id: ++_id,
    category: CAT_KEYS.includes(f.category) ? f.category : "specific",
    text,
    verbatim: String(f.verbatim || "").trim(),
    weight: Math.max(0, Math.min(10, f.weight || 3)),
    flags: Array.isArray(f.flags) ? f.flags : [],
    turn: state.turn,
  };
  state.factoids.push(rec);
  return rec;
}

function byCategory(state, cat) { return state.factoids.filter((f) => f.category === cat); }

function coverage(state) {
  const out = {};
  for (const k of CAT_KEYS) {
    const have = byCategory(state, k).length;
    const need = CATEGORIES[k].need;
    out[k] = { have, need, ok: have >= need, label: CATEGORIES[k].label };
  }
  return out;
}

function gaps(state) {
  const cov = coverage(state);
  return GAP_PRIORITY.filter((k) => !cov[k].ok);
}

// The interview may stop when every needed slot is earned, or must stop at the ceiling.
function readiness(state) {
  const g = gaps(state);
  if (state.turn >= HARD_CEILING) return { stop: true, reason: "ceiling", gaps: g };
  if (g.length === 0) return { stop: true, reason: "complete", gaps: [] };
  return { stop: false, reason: "gaps", gaps: g };
}

// Sorted, ordered factoid list — highest identity-bearing material first.
// Category nudges keep story material above logistics at equal heat.
const CAT_BONUS = { scene: 1.5, specific: 1.2, emotion: 1.2, sacred: 1.4, identity: 1.0, boundary: 0.8, job: 0.5, sound: 0.5 };
function sortedFactoids(state) {
  return [...state.factoids].sort(
    (a, b) => b.weight * (CAT_BONUS[b.category] || 1) - a.weight * (CAT_BONUS[a.category] || 1)
  );
}

// Compact "already known" digest for the question prompt — the anti-re-ask armor.
function knownDigest(state, max = 40) {
  return sortedFactoids(state).slice(0, max).map((f) => `- [${f.category}] ${f.text}`).join("\n");
}

// Top-heat threads from a given turn (for follow-the-heat questioning).
function heatFrom(state, turn, n = 3) {
  return state.factoids
    .filter((f) => f.turn === turn && ["scene", "emotion", "specific", "sacred"].includes(f.category))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, n);
}

module.exports = {
  CATEGORIES, CAT_KEYS, GAP_PRIORITY, HARD_CEILING,
  createState, addFactoid, byCategory, coverage, gaps, readiness,
  sortedFactoids, knownDigest, heatFrom, jaccard, norm, tokens,
};
