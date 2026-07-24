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
const GENERIC = /\b(stood out|stands? out|notice(d)? most|remember most|makes? (him|her|them) (so )?special|most about (him|her|them))\b/i;

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
  // Near-duplicate of an already-asked question?
  for (const prev of state.asked) {
    if (S.jaccard(prev, q) >= 0.45) problems.push("near-duplicate of an asked question");
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
  // (music-ish for sound, occasion-ish for job), recategorize it — no model roulette.
  if (gapKey === "sound" || gapKey === "job") {
    const hit = state.factoids.find((f) => f.category !== gapKey && S.plausibleCategory(gapKey, f.text) === true && ["specific", "scene", "emotion"].includes(f.category));
    if (hit) {
      S.addFactoid(state, { category: gapKey, text: hit.text, verbatim: hit.verbatim, weight: hit.weight, flags: ["recategorized"] });
      return true;
    }
  }
  const parsed = await chatJson(model, [
    { role: "system", content: `You check whether a topic is already covered by known facts. Output ONLY JSON: {"covered": boolean, "evidence": string}. covered=true ONLY if the facts genuinely contain material about the topic; evidence = the fact text that covers it, copied exactly. When unsure, covered=false.` },
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
  // Follow the heat: a hot thread from the last answer that still serves an open gap.
  const g = S.gaps(state);
  const heat = S.heatFrom(state, state.turn);
  if (heat[0] && heat[0].weight >= 4 && (g.includes("scene") || g.includes("emotion"))) {
    return { kind: "heat", thread: heat[0], target: g.includes("scene") ? "scene" : "emotion" };
  }
  // Otherwise: first gap that isn't secretly covered already.
  for (const cat of g) {
    if (await gapAlreadyCovered(model, state, cat)) continue;
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
  if (target.kind === "consent") {
    const w = target.wound.text.length > 80 ? target.wound.text.slice(0, 77) + "…" : target.wound.text;
    return { question: `You touched on something tender — "${w}". Would you like the song to hold that part of the story, or steer around it?`, reflection: null, target: "consent", source: "fallback" };
  }
  const cat = target.target || "specific";
  const q = fallbackFor(state, cat);
  if (q) return { question: q, reflection: null, target: cat, source: "fallback" };
  // This category's fallbacks are exhausted — try the other open gaps before giving up.
  for (const other of S.gaps(state)) {
    if (other === cat) continue;
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

function fallbackFor(state, cat) {
  const short = (t) => t.replace(/[.!?]+$/, "").length > 60 ? t.replace(/[.!?]+$/, "").slice(0, 57) + "…" : t.replace(/[.!?]+$/, "");
  if (ANCHOR_ASKS[cat]) {
    const anchorCats = cat === "scene" ? ["scene", "specific"] : [cat === "specific" ? "specific" : cat, "specific"];
    const anchors = [...state.factoids]
      .filter((f) => anchorCats.includes(f.category) && f.text.split(/\s+/).length <= 14)
      .sort((a, b) => b.turn - a.turn || b.weight - a.weight);
    for (const a of anchors) {
      const q = ANCHOR_ASKS[cat](short(a.text));
      if (notAsked(state, q)) return q;
    }
  }
  const generic = FALLBACKS[cat];
  if (generic && notAsked(state, generic)) return generic;
  return null;
}

module.exports = { nextQuestion, validateQuestion, reflectionGrounded, buildContext, FALLBACKS };
