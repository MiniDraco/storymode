// QUESTION — pick the single next question from state. Model proposes, code disposes.
"use strict";

const fs = require("fs");
const path = require("path");
const { chatJson } = require("./llm");
const S = require("./state");

const PROMPT = fs.readFileSync(path.join(__dirname, "..", "prompts", "question.txt"), "utf8");

// Craft-rule validation. A rejected question gets one retry with feedback, then a safe fallback.
const YESNO = /^(do|does|did|is|are|was|were|have|has|had|can|could|would|will|should)\b/i;

const META = /\b(comes? to (your )?mind|first (thing|came)|describe them|thought about|tell me about them)\b/i;
// Generic elicitation forms are re-asks the moment the customer has said anything.
const GENERIC = /\b(stood out|stands? out|notice(d)? most|remember most|makes? (him|her|them) (so )?special|most about (him|her|them)|stay(ed|s)? with you( the)? most|most represents?|best (shows|describes|captures)|captures who (he|she|they)|you think most)\b/i;
// Compound questions smuggle a second ask behind "and".
const COMPOUND = /\band (why|what|how|when|where|who)\b/i;

function validateQuestion(q, state, kind) {
  const problems = [];
  if (!q || typeof q !== "string" || !q.trim()) { problems.push("empty"); return problems; }
  if (!q.includes("?")) problems.push("not a question");
  if ((q.match(/\?/g) || []).length > 1) problems.push("more than one question");
  // Consent is a decision question — "should the song hold this?" is legal there, and only there.
  if (kind !== "consent") {
    if (/^why\b/i.test(q.trim())) problems.push("why-question (use What/How)");
    if (YESNO.test(q.trim())) problems.push("yes/no question");
  }
  if (q.split(/\s+/).length > 38) problems.push("too long");
  if (state.turn >= 1 && META.test(q)) problems.push("meta-question / restatement of the opening");
  if (state.turn >= 1 && GENERIC.test(q)) problems.push("generic 'what stood out' form — name a known detail and ask for something different");
  if (COMPOUND.test(q)) problems.push("compound question — one ask only");
  // Near-duplicate of an already-asked question?
  for (const prev of state.asked) {
    if (S.jaccard(prev, q) >= 0.45) { problems.push("near-duplicate of an asked question"); break; }
  }
  // Revisiting the same moment in new words: any shared 3-gram with a prior question,
  // computed over stopword-stripped tokens so "the night"/"that night" can't dodge it.
  const STOP = new Set(["the", "that", "this", "and", "with", "you", "your", "for", "was", "were", "did", "does"]);
  const strip = (s) => S.tokens(s).filter((w) => !STOP.has(w));
  const qt = strip(q);
  outer: for (const prev of state.asked) {
    const pn = " " + strip(prev).join(" ") + " ";
    for (let i = 0; i + 2 < qt.length; i++) {
      if (pn.includes(" " + qt.slice(i, i + 3).join(" ") + " ")) {
        problems.push("revisits a moment already asked about — pick a different thread");
        break outer;
      }
    }
  }
  return problems;
}

// Reflection must quote the customer: require a 3-word run from their last answer.
function reflectionGrounded(refl, lastAnswer) {
  if (!refl) return false;
  const rt = S.tokens(refl), at = S.norm(lastAnswer);
  if (rt.length < 3) return false;
  for (let i = 0; i + 2 < rt.length; i++) {
    if (at.includes(rt.slice(i, i + 3).join(" "))) return true;
  }
  // Fallback: strong token overlap
  const aset = new Set(S.tokens(lastAnswer));
  const hits = rt.filter((w) => aset.has(w)).length;
  return hits >= Math.min(4, Math.ceil(rt.length * 0.4));
}

// Code-authored fallbacks per gap — safe, craft-legal, generic-but-warm.
const FALLBACKS = {
  identity: "Who is this song for — what's their name, and who are they to you?",
  specific: "What's one thing about them that almost nobody else does — a habit, a saying, a ritual?",
  scene: "Tell me about one specific time with them that you still think about — what happened?",
  emotion: "When you picture them right now, what's the feeling that comes up first?",
  job: "Where does this song get played — what's the occasion, and who's in the room?",
  sound: "What should this sound like — what music do they love, or what artist feels right?",
  boundary: "What should this song stay away from — anything that shouldn't be mentioned?",
};

// Before asking for a "gap", check whether the material is already sitting in KNOWN under
// the wrong category. Miscategorized coverage is how a system re-asks what it was told.
// A covered gap gets a synthetic factoid so the coverage map heals itself.
async function gapAlreadyCovered(model, state, gapKey) {
  // Deterministic pre-pass: if a known factoid plainly matches the gap's pattern
  // (music-ish for sound, occasion-ish for job, relationship words for identity),
  // recategorize it — no model roulette.
  if (["sound", "job", "identity", "scene"].includes(gapKey)) {
    const hit = state.factoids.find((f) => f.category !== gapKey && S.coversGap(gapKey, f.text + " " + (f.verbatim || "")));
    if (hit) {
      S.addFactoid(state, { category: gapKey, text: hit.text, verbatim: hit.verbatim, weight: hit.weight, flags: ["recategorized"] });
      return true;
    }
  }
  const parsed = await chatJson(model, [
    { role: "system", content: `You check whether a topic is already covered by known facts. Output ONLY JSON: {"covered": boolean, "evidence": string}. covered=true ONLY if the facts genuinely contain material about the topic; evidence = the fact text that covers it, copied exactly. When unsure, covered=false.\nExample: TOPIC "The sound (genre / reference artists / energy)" with a fact "loves TLC and SWV, classic hits at the reception" → {"covered": true, "evidence": "loves TLC and SWV, classic hits at the reception"} — named artists or songs the subject loves DO cover the sound topic.` },
    { role: "user", content: `TOPIC: ${S.CATEGORIES[gapKey].label}\n\nKNOWN FACTS:\n${S.knownDigest(state, 120)}` },
  ], { temperature: 0.1 });
  if (parsed && parsed.covered === true && typeof parsed.evidence === "string" && parsed.evidence.trim()) {
    // The heal must clear the same plausibility floor as extraction — no junk coverage.
    if (!S.plausibleCategory(gapKey, parsed.evidence)) return false;
    S.addFactoid(state, { category: gapKey, text: parsed.evidence.trim(), verbatim: "", weight: 3, flags: ["recategorized"] });
    return true;
  }
  return false;
}

// Code picks the target; the model only words the question. Deciding is ours, phrasing is theirs.
async function pickTarget(model, state) {
  // Wound consent comes first, once, when a wound has surfaced.
  const wound = state.factoids.find((f) => f.flags.includes("wound"));
  if (wound && !state.woundConsentAsked) {
    state.woundConsentAsked = true;
    return { kind: "consent", wound };
  }
  // A song needs the name. If extraction never flagged one, confirm the transcript's
  // best candidate (confirmation can never be a re-ask) — or ask plainly if there is none.
  if (!state.name && !state.nameAsked && state.turn >= 1 && !S.gaps(state).includes("identity")) {
    state.nameAsked = true;
    const candidate = S.nameCandidate(state);
    if (candidate) { state.name = candidate; return { kind: "nameConfirm", candidate }; }
    return { kind: "name" };
  }
  // Follow the heat: a hot thread from the last answer that still serves an open gap.
  const g = S.gaps(state);
  const heat = S.heatFrom(state, state.turn);
  if (heat[0] && heat[0].weight >= 4 && (g.includes("scene") || g.includes("emotion"))) {
    return { kind: "heat", thread: heat[0], target: g.includes("scene") ? "scene" : "emotion" };
  }
  // Otherwise: first gap that isn't secretly covered already.
  for (const cat of g) {
    if (await gapAlreadyCovered(model, state, cat)) continue;
    // Identity decomposes: the name flow handles names; relationship gets a fixed ask.
    // A generic "who is this song for" is compound and re-asks whichever half is known.
    if (cat === "identity") {
      if (!state.name && !state.nameAsked) {
        state.nameAsked = true;
        const candidate = S.nameCandidate(state);
        if (candidate) { state.name = candidate; return { kind: "nameConfirm", candidate }; }
        return { kind: "name" };
      }
      if (state.name) return { kind: "relationship" };
      continue; // name asked and unanswered — don't hammer identity
    }
    return { kind: "gap", target: cat };
  }
  return { kind: "done" };
}

function buildContext(state, lastAnswer, target) {
  const heat = S.heatFrom(state, state.turn);
  const targetLine =
    target.kind === "consent"
      ? `TARGET: something painful surfaced — "${target.wound.text}". Name it plainly and gently, and ask whether the song should hold it or steer around it. That is the entire question.`
      : target.kind === "heat"
        ? `TARGET: go deeper into this thread from their last answer: "${target.thread.text}". Ask for the ${target.target === "scene" ? "specific moment — what happened" : "feeling inside it"}.`
        : `TARGET: ${target.target} — ${S.CATEGORIES[target.target].label}. Your question must pursue exactly this and nothing else. Anchor it in a detail from KNOWN when natural.`;
  return [
    "KNOWN (never ask about any of this):",
    S.knownDigest(state, 120) || "- nothing yet",
    "",
    targetLine,
    "",
    "HEAT (from the last answer):",
    heat.map((f) => `- [heat ${f.weight}${f.flags.includes("wound") ? ", wound" : ""}] ${f.text}`).join("\n") || "- none",
    "",
    "ASKED:",
    state.asked.map((q, i) => `${i + 1}. ${q}`).join("\n") || "- none",
    "",
    "LAST ANSWER:",
    String(lastAnswer || "").slice(0, 2000),
  ].join("\n");
}

async function nextQuestion(model, state, lastAnswer) {
  const target = await pickTarget(model, state);
  if (target.kind === "done") return { question: null, reflection: null, target: null, source: "covered", done: true };
  if (target.kind === "name") {
    // Nickname framing: new information even if a formal name is already on the page.
    return { question: "What do you actually call them, day to day — any nickname the song should know about?", reflection: null, target: "identity", source: "fixed" };
  }
  if (target.kind === "nameConfirm") {
    return { question: `I want the name sung exactly right — the song is about ${target.candidate}, spelled just like that?`, reflection: null, target: "identity", source: "fixed" };
  }
  if (target.kind === "relationship") {
    return { question: `Who is ${state.name} to you — how do you two know each other?`, reflection: null, target: "identity", source: "fixed" };
  }
  // Consent is too load-bearing for model wording: the code-authored form names the
  // wound plainly and asks the one decision. It has never failed an audit.
  if (target.kind === "consent") {
    const w = target.wound.text.length > 80 ? target.wound.text.slice(0, 77) + "…" : target.wound.text;
    return { question: `You touched on something tender — "${w}". Would you like the song to hold that part of the story, or steer around it?`, reflection: null, target: "consent", source: "fixed" };
  }
  const ctx = buildContext(state, lastAnswer, target);
  let messages = [
    { role: "system", content: PROMPT },
    { role: "user", content: ctx },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = await chatJson(model, messages, { temperature: 0.5 });
    if (parsed && typeof parsed.question === "string") {
      const problems = validateQuestion(parsed.question, state, target.kind);
      if (!problems.length) {
        let reflection = typeof parsed.reflection === "string" ? parsed.reflection.trim() : null;
        if (reflection && !reflectionGrounded(reflection, lastAnswer)) reflection = null;
        return { question: parsed.question.trim(), reflection, target: target.target || target.kind, source: "model" };
      }
      messages = [
        ...messages,
        { role: "assistant", content: JSON.stringify(parsed) },
        { role: "user", content: `Rejected: ${problems.join("; ")}. Produce a corrected JSON object following every rule.` },
      ];
    }
  }
  // Model failed twice — deterministic fallback keeps the interview alive.
  const cat = target.target || "specific";
  const q = fallbackFor(state, cat);
  if (q) return { question: q, reflection: null, target: cat, source: "fallback" };
  // This category's fallbacks are exhausted — try the other open gaps before giving up.
  // Each must clear the heal check first, or the fallback re-asks hidden coverage.
  for (const other of S.gaps(state)) {
    if (other === cat || other === "identity") continue;
    if (await gapAlreadyCovered(model, state, other)) continue;
    const oq = fallbackFor(state, other);
    if (oq) return { question: oq, reflection: null, target: other, source: "fallback" };
  }
  return { question: null, reflection: null, target: null, source: "exhausted", done: true };
}

// Anchored, dedupe-aware fallbacks. Anchors rotate newest-first so a repeat ask is
// impossible by construction; a question too close to anything already asked is skipped.
const ANCHOR_ASKS = {
  specific: (a) => `Besides ${a} — what's one more thing about them almost nobody else does?`,
  scene: (a) => `Besides ${a} — tell me about one more moment with them that stays with you?`,
  emotion: (a) => `When you think about ${a} — what's the feeling underneath it?`,
};

function notAsked(state, q) {
  return q && state.asked.every((prev) => S.jaccard(prev, q) < 0.45);
}

// Anchor dedupe compares the ANCHOR, not the whole question — a shared template
// must not block rotation onto new anchors.
function anchorUnused(state, anchorText) {
  const a = S.norm(anchorText).slice(0, 40);
  return a && state.asked.every((prev) => !S.norm(prev).includes(a));
}

function fallbackFor(state, cat) {
  const short = (t) => t.replace(/[.!?]+$/, "").length > 60 ? t.replace(/[.!?]+$/, "").slice(0, 57) + "…" : t.replace(/[.!?]+$/, "");
  state.fallbackCounts = state.fallbackCounts || {};
  if (ANCHOR_ASKS[cat]) {
    // At most 2 anchored fallbacks per story-material category — then move on.
    // Hammering one gap the extractor keeps missing is worse than an honest THIN flag.
    if ((state.fallbackCounts[cat] || 0) >= 2) return null;
    const anchorCats = cat === "scene" ? ["scene", "specific"] : [cat === "specific" ? "specific" : cat, "specific"];
    const anchors = [...state.factoids]
      .filter((f) => anchorCats.includes(f.category) && f.text.split(/\s+/).length <= 14)
      .sort((a, b) => b.turn - a.turn || b.weight - a.weight);
    for (const a of anchors) {
      if (!anchorUnused(state, short(a.text))) continue;
      const q = ANCHOR_ASKS[cat](short(a.text));
      state.fallbackCounts[cat] = (state.fallbackCounts[cat] || 0) + 1;
      return q;
    }
    // Anchors exist but are all spent → do NOT fall to the generic form; it would
    // ask for what the anchors already prove was given. Move to another gap.
    if (anchors.length) return null;
    // Nothing known in this territory at all → the generic form cannot be a re-ask.
    const generic = FALLBACKS[cat];
    if (generic && notAsked(state, generic) && state.factoids.filter((f) => f.category === cat).length === 0) {
      state.fallbackCounts[cat] = (state.fallbackCounts[cat] || 0) + 1;
      return generic;
    }
    return null;
  }
  const generic = FALLBACKS[cat];
  if (generic && notAsked(state, generic)) return generic;
  return null;
}

module.exports = { nextQuestion, validateQuestion, reflectionGrounded, buildContext, FALLBACKS };
