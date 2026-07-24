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

function validateQuestion(q, state) {
  const problems = [];
  if (!q || typeof q !== "string" || !q.trim()) { problems.push("empty"); return problems; }
  if (!q.includes("?")) problems.push("not a question");
  if ((q.match(/\?/g) || []).length > 1) problems.push("more than one question");
  if (/^why\b/i.test(q.trim())) problems.push("why-question (use What/How)");
  if (YESNO.test(q.trim())) problems.push("yes/no question");
  if (q.split(/\s+/).length > 38) problems.push("too long");
  if (state.turn >= 1 && META.test(q)) problems.push("meta-question / restatement of the opening");
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
  const parsed = await chatJson(model, [
    { role: "system", content: `You check whether a topic is already covered by known facts. Output ONLY JSON: {"covered": boolean, "evidence": string}. covered=true ONLY if the facts genuinely contain material about the topic; evidence = the fact text that covers it, copied exactly. When unsure, covered=false.` },
    { role: "user", content: `TOPIC: ${S.CATEGORIES[gapKey].label}\n\nKNOWN FACTS:\n${S.knownDigest(state, 120)}` },
  ], { temperature: 0.1 });
  if (parsed && parsed.covered === true && typeof parsed.evidence === "string" && parsed.evidence.trim()) {
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
      const problems = validateQuestion(parsed.question, state);
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
  return { question: FALLBACKS[cat] || FALLBACKS.specific, reflection: null, target: cat, source: "fallback" };
}

module.exports = { nextQuestion, validateQuestion, reflectionGrounded, buildContext, FALLBACKS };
