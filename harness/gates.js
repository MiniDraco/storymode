// Run the full gate suite sequentially: node harness/gates.js [interviewerModel]
// Sequential on purpose — three models share one 12GB card; parallel = VRAM thrash.
"use strict";

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MODEL = process.argv[2] || "qwen2.5:3b";
const PERSONAS = ["chapters_writer", "terse_dad", "messy_typist", "grieving_mother"];

const results = [];
for (const p of PERSONAS) {
  console.log(`\n=== GATE: ${p} ===`);
  try {
    const out = execFileSync("node", [path.join(__dirname, "run.js"), p, MODEL], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 30 * 60 * 1000 });
    process.stdout.write(out);
    const pass = /AUDIT PASS/.test(out);
    results.push({ persona: p, pass });
  } catch (e) {
    console.error(`gate ${p} crashed: ${e.message}`);
    results.push({ persona: p, pass: false, crashed: true });
  }
}

console.log("\n=== GATE SUMMARY ===");
for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.persona}${r.crashed ? " (crashed)" : ""}`);
const all = results.every((r) => r.pass);
console.log(all ? "\nALL GATES PASS" : "\nGATES FAILING — iterate");
process.exit(all ? 0 : 1);
