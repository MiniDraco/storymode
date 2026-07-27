// Harness runner: node harness/run.js <persona> [interviewerModel] [--no-judge]
// Runs a full interview with an LLM-played customer, then audits it, then saves evidence.
"use strict";

const fs = require("fs");
const path = require("path");
const { runInterview } = require("../engine/engine");
const { makeAnswerFn } = require("./persona");
const { auditInterview } = require("./judge");

const INTERVIEWER = process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : "qwen2.5:3b";
const ACTOR = process.env.ACTOR_MODEL || "hermes3:8b";
const JUDGE = process.env.JUDGE_MODEL || "qwen3:14b";
const NO_JUDGE = process.argv.includes("--no-judge");

async function main() {
  const personaKey = process.argv[2];
  if (!personaKey) {
    console.error("usage: node harness/run.js <persona> [interviewerModel] [--no-judge]");
    process.exit(1);
  }
  const t0 = Date.now();
  console.log(`persona=${personaKey} interviewer=${INTERVIEWER} actor=${ACTOR} judge=${JUDGE}`);

  const { PERSONAS } = require("./persona");
  const mode = PERSONAS[personaKey].mode || "person";
  const answerFn = makeAnswerFn(personaKey, ACTOR);
  const result = await runInterview(INTERVIEWER, answerFn, (m) => console.log(m), mode);

  let audit = null;
  if (!NO_JUDGE) {
    console.log("auditing for re-asks…");
    audit = await auditInterview(JUDGE, result.state, (m) => console.log(m));
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(__dirname, "..", "runs", `${personaKey}_${INTERVIEWER.replace(/[:/]/g, "-")}_${stamp}`);
  fs.writeFileSync(base + ".json", JSON.stringify({ persona: personaKey, interviewer: INTERVIEWER, actor: ACTOR, judge: NO_JUDGE ? null : JUDGE, state: result.state, audit }, null, 2));

  const md = [];
  md.push(`# Run: ${personaKey} / ${INTERVIEWER} — ${stamp}`);
  md.push(`Turns: ${result.state.turn} | Factoids: ${result.state.factoids.length} | Stopped: ${result.state.thin.length ? "gaps thin: " + result.state.thin.join(",") : "complete"}`);
  if (audit) {
    md.push(`\n## AUDIT: ${audit.pass ? "PASS — zero re-asks" : `FAIL — ${audit.reasks.length} re-ask(s)`}`);
    for (const v of audit.verdicts) {
      md.push(`- Q${v.turn} ${v.reask === null ? "⚠ judge error" : v.reask ? "✗ RE-ASK" : "✓"}: ${v.question}`);
      if (v.reask) md.push(`  - evidence: ${v.evidence}`);
    }
  }
  md.push(`\n## Transcript`);
  for (const t of result.state.transcript) {
    md.push(`**Q${t.turn}:** ${t.q}\n\n**A${t.turn}:** ${t.a}\n`);
  }
  md.push(`\n## Customer finish screen\n\n${result.finish}`);
  md.push(`\n## Dossier\n\n${result.dossier}`);
  md.push(`\n## Handoff prompt (paste #1 → Gemini)\n\n\`\`\`\n${result.handoff}\n\`\`\``);
  fs.writeFileSync(base + ".md", md.join("\n"));

  console.log(`\nsaved ${base}.md`);
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (audit) console.log(audit.pass ? "AUDIT PASS — zero re-asks" : `AUDIT FAIL — ${audit.reasks.length} re-asks`);
}

main().catch((e) => { console.error(e); process.exit(1); });
