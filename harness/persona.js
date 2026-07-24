// Persona player — an LLM-played customer. Uses a stronger local model than the interviewer,
// because the customer must be a convincing human, not a phone-class model.
"use strict";

const fs = require("fs");
const path = require("path");
const { chat } = require("../engine/llm");

const PERSONAS = JSON.parse(fs.readFileSync(path.join(__dirname, "personas", "personas.json"), "utf8"));

function makeAnswerFn(personaKey, actorModel) {
  const p = PERSONAS[personaKey];
  if (!p) throw new Error(`unknown persona: ${personaKey}`);
  const history = [];
  let turn = 0;
  return async function answer(question, reflection) {
    turn++;
    if (turn === 1 && p.firstAnswerFile) {
      const fixed = fs.readFileSync(path.join(__dirname, "personas", p.firstAnswerFile), "utf8").trim();
      history.push({ role: "user", content: question }, { role: "assistant", content: fixed });
      return fixed;
    }
    const shown = (reflection ? reflection + "\n\n" : "") + question;
    history.push({ role: "user", content: shown });
    const reply = await chat(actorModel, [
      { role: "system", content: p.card + `\nStyle: ${p.style}. Reply with ONLY your in-character answer — no quotes, no narration, no stage directions.` },
      ...history,
    ], { temperature: 0.7 });
    const clean = reply.trim().replace(/^["']|["']$/g, "");
    history.push({ role: "assistant", content: clean });
    return clean;
  };
}

module.exports = { makeAnswerFn, PERSONAS };
