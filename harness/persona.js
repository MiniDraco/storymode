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
    const sys = { role: "system", content: p.card + `\nStyle: ${p.style}. Reply with ONLY your in-character answer — no quotes, no narration, no stage directions.` };
    let reply = await chat(actorModel, [sys, ...history], { temperature: 0.7 });
    let clean = reply.trim().replace(/^["']|["']$/g, "");
    // Enforce terse personas for real: one retry, then hard cut at a sentence boundary.
    if (p.maxWords && clean.split(/\s+/).length > p.maxWords + 3) {
      reply = await chat(actorModel, [sys, ...history,
        { role: "assistant", content: clean },
        { role: "user", content: `(That was too many words for ${p.label}. Answer again, ${p.maxWords} words or fewer.)` },
      ], { temperature: 0.7 });
      clean = reply.trim().replace(/^["']|["']$/g, "");
      if (clean.split(/\s+/).length > p.maxWords + 3) {
        const first = clean.match(/[^.!?]+[.!?]?/);
        clean = (first ? first[0] : clean).split(/\s+/).slice(0, p.maxWords).join(" ");
      }
    }
    history.push({ role: "assistant", content: clean });
    return clean;
  };
}

module.exports = { makeAnswerFn, PERSONAS };
