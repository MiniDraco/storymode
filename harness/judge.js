// Judge — the re-ask detector. Runs AFTER the interview (batch) so models don't thrash VRAM.
// The judge's question: does question N ask for information the customer already provided?
"use strict";

// No forced JSON format: thinking judges go degenerate under format=json.
// Let the model reason, then parse the JSON out of its reply.
const { chat, readJson } = require("../engine/llm");

const JUDGE_SYS = `You are auditing an interview for one specific failure: asking the customer for information they ALREADY provided.

You get the interview so far (questions and answers) and one CANDIDATE question that was asked next.

A candidate FAILS (reask=true) only if a reasonable person would say "I already told you that" — the information was genuinely already given, in substance, even in different words.

A candidate PASSES (reask=false) if it:
- asks for genuinely new information, OR
- goes DEEPER into something mentioned (asking for more detail about a story that was only summarized is NOT a re-ask), OR
- asks the customer to confirm a spelling/date/decision (confirmation is allowed), OR
- asks the customer to choose or decide something (e.g. whether to include a painful topic).

Be strict about real repeats and fair about depth. Quote the exact prior answer text as evidence when you fail a question.

Output ONLY JSON: {"reask": boolean, "evidence": string, "reasoning": string}`;

async function judgeQuestion(judgeModel, priorTranscript, candidateQuestion) {
  const convo = priorTranscript.map((t) => `Q${t.turn}: ${t.q}\nA${t.turn}: ${t.a}`).join("\n\n");
  const raw = await chat(judgeModel, [
    { role: "system", content: JUDGE_SYS },
    { role: "user", content: `INTERVIEW SO FAR:\n${convo}\n\nCANDIDATE (the next question that was asked):\n${candidateQuestion}` },
  ], { temperature: 0.1, num_ctx: 16384 });
  const parsed = readJson(raw);
  if (!parsed) return { reask: null, evidence: "", reasoning: "judge failed to answer" };
  return { reask: !!parsed.reask, evidence: parsed.evidence || "", reasoning: parsed.reasoning || "" };
}

// Audit a finished interview: every question after the first gets judged against everything before it.
async function auditInterview(judgeModel, state, log = () => {}) {
  const verdicts = [];
  for (let i = 1; i < state.transcript.length; i++) {
    const prior = state.transcript.slice(0, i);
    const q = state.transcript[i].q;
    const v = await judgeQuestion(judgeModel, prior, q);
    verdicts.push({ turn: state.transcript[i].turn, question: q, ...v });
    log(`  judge Q${state.transcript[i].turn}: ${v.reask === null ? "ERROR" : v.reask ? "RE-ASK ✗" : "ok"}`);
  }
  const reasks = verdicts.filter((v) => v.reask === true);
  return { verdicts, reasks, pass: reasks.length === 0 };
}

module.exports = { auditInterview, judgeQuestion };
