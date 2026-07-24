// Play the interview yourself: node play.js [interviewerModel]
// You are the customer. Answers end with an empty line (paste chapters freely).
"use strict";

const readline = require("readline");
const fs = require("fs");
const path = require("path");
const { runInterview } = require("./engine/engine");

const MODEL = process.argv[2] || "qwen2.5:3b";
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask() {
  return new Promise((resolve) => {
    const lines = [];
    const onLine = (line) => {
      if (line.trim() === "" && lines.length) { rl.off("line", onLine); resolve(lines.join("\n")); }
      else if (line.trim() !== "" || lines.length) lines.push(line);
    };
    rl.on("line", onLine);
  });
}

async function main() {
  console.log(`\n(interviewer: ${MODEL} — answer, then press Enter on an empty line to send)\n`);
  const result = await runInterview(MODEL, async (question, reflection) => {
    console.log("\n────────────────────────────────");
    if (reflection) console.log(`\x1b[3m${reflection}\x1b[0m`);
    console.log(`\x1b[1m${question}\x1b[0m\n`);
    return await ask();
  }, () => {});
  rl.close();

  console.log("\n════════ YOUR FINISH SCREEN ════════\n" + result.finish);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = path.join(__dirname, "runs", `play_${stamp}`);
  fs.writeFileSync(base + ".md", "# Live play\n\n" + result.dossier + "\n\n## Handoff\n\n```\n" + result.handoff + "\n```\n");
  console.log(`\n(dossier + handoff saved: ${base}.md)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
