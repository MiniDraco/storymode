// EXTRACT — chunk an answer, pull grounded factoids with the small model.
// The model quotes and files; it never narrates. Ungrounded output is dropped in code.
"use strict";

const fs = require("fs");
const path = require("path");
const { chatJson } = require("./llm");
const { norm } = require("./state");

const PROMPT = fs.readFileSync(path.join(__dirname, "..", "prompts", "extract.txt"), "utf8");

// Paragraph-aware chunking, ~target words per chunk. Small inputs = small-model food.
function chunk(text, target = 120) {
  const paras = String(text).split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = [];
  let count = 0;
  const flush = () => { if (cur.length) { chunks.push(cur.join("\n")); cur = []; count = 0; } };
  for (const p of paras) {
    const w = p.split(/\s+/).length;
    if (w > target * 1.8) {
      // Giant paragraph: split on sentences.
      flush();
      let scur = [], scount = 0;
      for (const s of p.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [p]) {
        const sw = s.split(/\s+/).length;
        if (scount + sw > target && scur.length) { chunks.push(scur.join(" ")); scur = []; scount = 0; }
        scur.push(s.trim()); scount += sw;
      }
      if (scur.length) chunks.push(scur.join(" "));
      continue;
    }
    if (count + w > target && cur.length) flush();
    cur.push(p); count += w;
  }
  flush();
  return chunks.length ? chunks : [String(text)];
}

// Grounding check: the verbatim must actually appear in the source chunk.
// Anti-invention armor — if the model made it up, it does not enter the construct.
function grounded(verbatim, source) {
  const v = norm(verbatim), s = norm(source);
  if (!v) return false;
  if (s.includes(v)) return true;
  // Fuzzy: 80% of the verbatim's tokens appear in order-agnostic form in the source.
  const vt = v.split(" ").filter((w) => w.length > 2);
  if (!vt.length) return false;
  const st = new Set(s.split(" "));
  const hits = vt.filter((w) => st.has(w)).length;
  return hits / vt.length >= 0.8;
}

async function extractFromAnswer(model, question, answer, onProgress) {
  const chunks = chunk(answer);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i + 1, chunks.length);
    const user = `INTERVIEW QUESTION THAT PROMPTED THIS:\n${question}\n\nCUSTOMER'S WORDS:\n${chunks[i]}`;
    const parsed = await chatJson(model, [
      { role: "system", content: PROMPT },
      { role: "user", content: user },
    ], { temperature: 0.2 });
    if (!parsed || !Array.isArray(parsed.factoids)) continue;
    for (const f of parsed.factoids) {
      if (!f || typeof f.text !== "string") continue;
      const verbatim = typeof f.verbatim === "string" ? f.verbatim : f.text;
      if (!grounded(verbatim, chunks[i])) continue; // dropped: not in the customer's words
      out.push({
        category: f.category,
        text: f.text,
        verbatim,
        weight: Number(f.heat) || 3,
        flags: Array.isArray(f.flags) ? f.flags.filter((x) => typeof x === "string") : [],
      });
    }
    if (parsed.name && typeof parsed.name === "string") {
      out.push({ category: "identity", text: `name: ${parsed.name}`, verbatim: parsed.name, weight: 8, flags: ["name"] });
    }
  }
  return out;
}

module.exports = { chunk, grounded, extractFromAnswer };
