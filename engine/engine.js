// The interview loop: EXTRACT → MERGE/RANK → QUESTION → (stop when the construct can carry a song) → COMPILE.
// Small model extracts and asks; code does everything else.
"use strict";

const fs = require("fs");
const path = require("path");
const S = require("./state");
const { extractFromAnswer } = require("./extract");
const { nextQuestion } = require("./question");
const { renderHandoff, renderDossier, renderFinish } = require("./compile");

const OPENING = fs.readFileSync(path.join(__dirname, "..", "prompts", "opening.txt"), "utf8").trim();

/**
 * Run a full interview.
 * @param {string} model - the small model id (what ships in the APK)
 * @param {(question: string, reflection: string|null) => Promise<string>} answerFn - the customer
 * @param {(msg: string) => void} [log]
 */
async function runInterview(model, answerFn, log = () => {}) {
  const state = S.createState();
  let question = OPENING;
  let reflection = null;

  while (true) {
    state.turn++;
    state.asked.push(question);
    log(`Q${state.turn}: ${question}`);
    const answer = await answerFn(question, reflection);
    log(`A${state.turn}: ${answer.slice(0, 120).replace(/\n/g, " ")}${answer.length > 120 ? "…" : ""}`);
    state.transcript.push({ q: question, a: answer, turn: state.turn, ts: Date.now() });

    const factoids = await extractFromAnswer(model, question, answer);
    for (const f of factoids) {
      const rec = S.addFactoid(state, f);
      if (rec && rec.flags.includes("name") && !state.name) {
        state.name = rec.verbatim || rec.text.replace(/^name:\s*/i, "");
      }
    }
    log(`  extracted ${factoids.length} factoids; total ${state.factoids.length}; gaps: ${S.gaps(state).join(",") || "none"}`);

    const ready = S.readiness(state);
    if (ready.stop) {
      state.done = true;
      state.thin = ready.gaps;
      log(`STOP (${ready.reason}) after ${state.turn} turns`);
      break;
    }

    const nq = await nextQuestion(model, state, answer);
    question = nq.question;
    reflection = nq.reflection;
    if (nq.source === "fallback") log("  (fallback question used)");
  }

  return {
    state,
    handoff: renderHandoff(state),
    dossier: renderDossier(state),
    finish: renderFinish(state),
  };
}

module.exports = { runInterview, OPENING };
