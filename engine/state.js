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

// Plausibility floors for the load-bearing slots. A small model sometimes sprays
// categories; junk in sound/job silently "completes" the slot and kills the question
// that should have been asked. Demotion (not deletion) keeps the text and the question.
const SOUND_RE = /\b(music|song|songs|sing|singer|singing|sings|band|artist|album|genre|country|rock|folk|jazz|blues|rap|hip.?hop|r&b|soul|gospel|pop|acoustic|guitar|piano|fiddle|drums?|melody|radio|playlist|record|vinyl|hums?|humming|whistl\w*|voice|vocal|tempo|upbeat|ballad|anthem|lullaby|hits|tunes?|tracks?|jams?|blast(s|ing|ed)?|listen\w*|[A-Z]\w+ (Mac|Haggard|Cash|Strait|Nicks|Seger))\b/i;
const JOB_RE = /\b(birthday|wedding|anniversar\w*|memorial|funeral|retirement|graduation|proposal|christmas|reunion|party|celebration|reception|dinner|gathering|ceremony|surprise|occasion|plays? (at|for)|played at|hall|church|toast|slideshow|septemb\w*|octob\w*|novemb\w*|decemb\w*|januar\w*|februar\w*|march|april|may|june|july|august)\b/i;
// Relationship words prove identity coverage even when the extractor filed them elsewhere.
const IDENTITY_RE = /\b(my (wife|husband|dad|father|mom|mother|son|daughter|brother|sister|best friend|friend|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|partner|fianc\w*|boyfriend|girlfriend|boss|mentor|neighbor|coworker)|wife of \d+|husband of \d+|(he|she)('s| is) my \w+)\b/i;

function plausibleCategory(cat, text) {
  if (cat === "sound") return SOUND_RE.test(text);
  if (cat === "job") return JOB_RE.test(text);
  if (cat === "identity") return true; // identity is healed by IDENTITY_RE, never demoted
  return true;
}
// Scene-shaped language: a told moment with a when/what-happened spine.
const SCENE_RE = /\b(the (night|day|morning|afternoon|evening|summer|winter|spring|fall|year|time|moment) (of|when|she|he|we|i|before|after)|one (night|day|time|morning)|that (night|day|morning|time)|when (he|she|we|i|they|my|our|his|her|their) \w+|there was (a|this|one)|i remember (the|when|that)|\bonce\b|the time (he|she|they|we|i)|\bshowed up\b|\bdrove \w+ (hours?|miles?|to)\b)/i;
// Feeling language: the emotional center expressed directly.
const EMOTION_RE = /\b(feel|feels|felt|feeling|love[ds]?|loving|joy|joyful|smile[ds]?|laugh\w* (made|makes|brought|brings)|warmth|warms?( my)? heart|proud|pride|grateful|gratitude|miss(es|ed)? (him|her|them)|happy|happiness|comfort\w*|peace(ful)?|bittersweet|heart (aches?|swells?|full))\b/i;

function coversGap(cat, text) {
  if (cat === "sound") return SOUND_RE.test(text);
  if (cat === "job") return JOB_RE.test(text);
  if (cat === "identity") return IDENTITY_RE.test(text);
  if (cat === "scene") return SCENE_RE.test(text);
  if (cat === "emotion") return EMOTION_RE.test(text);
  return false;
}

// A "wound" needs actual pain in it — small models spray the flag onto warmth,
// and a consent question aimed at a non-wound reads as a re-ask (and feels absurd).
const WOUND_RE = /\b(died?|dying|death|passed( away)?|cancer|funeral|buried|grave|lost (him|her|them|my)|loss|grief|griev\w*|mourn\w*|divorc\w*|cheat\w*|betray\w*|affair|accident|crash|hospital|hospice|diagnos\w*|heart attack|stroke|suicide|overdos\w*|addict\w*|rehab|sober|abus\w*|estrang\w*|didn'?t (speak|talk)|not (speak|talk)ing|no longer (here|with us)|gone now|miss (him|her|them)|widow\w*|jail|prison|deploy\w*|war|ptsd|depress\w*|anxiety|cried|crying|tears|wreck|painful|the pain|hurt\w*|struggl\w*|nightmare)\b/i;
function plausibleWound(text) { return WOUND_RE.test(text); }

let _id = 0;
// Internal digest notation ("- [specific] ...") must never survive into stored text —
// models copying digest lines back at us is a known failure mode.
function stripNotation(s) {
  return String(s || "").replace(/^\s*(?:-\s*)?\[[a-z]+\]\s*/i, "").trim();
}
function addFactoid(state, f) {
  const text = stripNotation(f.text);
  if (!text) return null;
  f = { ...f, text, verbatim: stripNotation(f.verbatim) };
  if (!plausibleCategory(f.category, text + " " + (f.verbatim || ""))) f = { ...f, category: "specific" };
  // Sacred phrases are short by nature. A filed paragraph is material, not scripture.
  if (f.category === "sacred" && text.split(/\s+/).length > 12) f = { ...f, category: "emotion" };
  if (Array.isArray(f.flags) && f.flags.includes("wound") && !plausibleWound(text + " " + (f.verbatim || ""))) {
    f = { ...f, flags: f.flags.filter((x) => x !== "wound") };
  }
  // Dedupe: same category + high token overlap = same fact. Keep the heavier one.
  // Category-scoped on purpose — "whistles Merle Haggard" may legitimately live as
  // both a specific (habit) and a sound (music direction).
  const cat = CAT_KEYS.includes(f.category) ? f.category : "specific";
  for (const g of state.factoids) {
    if (g.category === cat && jaccard(g.text, text) >= 0.6) {
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
// A surfaced wound without consent is NOT complete: whether the song holds the pain or
// steers around it is a compositional fact the dossier requires.
function readiness(state) {
  const g = gaps(state);
  if (state.turn >= HARD_CEILING) return { stop: true, reason: "ceiling", gaps: g };
  const wound = state.factoids.find((f) => f.flags.includes("wound"));
  if (g.length === 0 && wound && !state.woundConsentAsked) return { stop: false, reason: "consent", gaps: [] };
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

// Deterministic name-candidate scan: the most frequent mid-sentence capitalized word
// in the customer's own answers. Used only when extraction never flagged a name —
// the candidate is CONFIRMED with the customer, never assumed.
const NAME_STOP = new Set(["The","She","He","They","We","And","But","So","Oh","You","It","My","Her","His","Their","When","What","Like","Just","Every","One","That","This","There","Then","Now","Well","Yeah","Also","Even","Not","All","If","Or","Because","January","February","March","April","May","June","July","August","September","October","November","December","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","Christmas","God","Mom","Dad","Ma","Pa","Grandma","Grandpa"]);
const REL_WORDS_RE = /^(wife|husband|dad|father|mom|mother|son|daughter|brother|sister|friend|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|partner|boyfriend|girlfriend|boss|mentor|neighbor|coworker)$/i;

function nameCandidate(state) {
  const total = {}, strong = {}, paired = {}; // strong = real name evidence; paired = adjacent to another capital
  const isCap = (s) => /^[A-Z][a-z]{2,}$/.test(String(s || "").replace(/[^A-Za-z']/g, "").replace(/'s$/, ""));
  for (const t of state.transcript) {
    for (const sentence of String(t.a).split(/[.!?\n]+/)) {
      const words = sentence.trim().split(/\s+/);
      for (let i = 0; i < words.length; i++) {
        let w = words[i].replace(/[^A-Za-z']/g, "");
        const possessive = /'s$/.test(w);
        w = w.replace(/'s$/, "").replace(/'/g, "");
        if (!/^[A-Z][a-z]{2,}$/.test(w) || NAME_STOP.has(w)) continue;
        total[w] = (total[w] || 0) + 1;
        // Compound proper nouns ("Fleetwood Mac", "Lake Michigan") are not personal names:
        // track whether this word travels with another capitalized neighbor.
        if (isCap(words[i - 1]) || isCap(words[i + 1])) paired[w] = (paired[w] || 0) + 1;
        // Strong evidence: mid-sentence, possessive, or a name-introduction
        // ("Danny was my son" / "Karen is my wife" / "Karen, my wife").
        const clean1 = String(words[i + 1] || "").replace(/[^A-Za-z]/g, "");
        const clean2 = String(words[i + 2] || "").replace(/[^A-Za-z]/g, "");
        const intro = (/^(was|is)$/i.test(clean1) && /^my$/i.test(clean2)) ||
                      (/^my$/i.test(clean1) && REL_WORDS_RE.test(clean2));
        if (i > 0 || possessive || intro) strong[w] = (strong[w] || 0) + 1;
      }
    }
  }
  // A word that ONLY ever appears next to another capitalized word is a compound, not a name.
  for (const w of Object.keys(total)) if ((paired[w] || 0) >= total[w]) delete strong[w];
  // One mid-sentence/possessive occurrence is enough — the candidate gets CONFIRMED
  // with the customer, so the cost of a wrong pick is one gentle correction.
  const best = Object.entries(total)
    .filter(([w]) => (strong[w] || 0) >= 1)
    .sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}

// Multi-word proper-noun candidate ("Shear Bliss", "Jazmin and Marcus" reduced to pairs):
// adjacent capitalized words counted as a phrase. Used by modes whose subject has a
// compound name; falls back to the single-word candidate.
function nameCandidatePhrase(state) {
  const counts = {};
  for (const t of state.transcript) {
    for (const sentence of String(t.a).split(/[.!?\n]+/)) {
      const words = sentence.trim().split(/\s+/).map((w) => w.replace(/[^A-Za-z']/g, "").replace(/'s$/, ""));
      for (let i = 0; i + 1 < words.length; i++) {
        const a = words[i], b = words[i + 1];
        if (/^[A-Z][a-z]{2,}$/.test(a) && /^[A-Z][a-z]{2,}$/.test(b) && !NAME_STOP.has(a) && !NAME_STOP.has(b)) {
          const k = a + " " + b;
          counts[k] = (counts[k] || 0) + 1;
        }
      }
    }
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : nameCandidate(state);
}

// Code-only heal pass: recategorize plainly-matching factoids into open gaps.
// Runs before target selection so the heat branch never hunts an already-told scene.
function syncHeal(state) {
  for (const gapKey of ["sound", "job", "identity", "scene", "emotion"]) {
    if (!gaps(state).includes(gapKey)) continue;
    const hit = state.factoids.find((f) => f.category !== gapKey && coversGap(gapKey, f.text + " " + (f.verbatim || "")));
    if (hit) addFactoid(state, { category: gapKey, text: hit.text, verbatim: hit.verbatim, weight: hit.weight, flags: ["recategorized"] });
  }
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
  plausibleCategory, plausibleWound, coversGap, nameCandidate, nameCandidatePhrase, syncHeal,
};
