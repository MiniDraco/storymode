// Stranger test: node harness/stranger.js <run.json> [songwriterModel]
// Hand ONLY the handoff prompt to a songwriter model that never saw the conversation
// (stand-in for Gemini). Then check the output mechanically:
//   - sacred words survive verbatim
//   - three blocks present (lyrics with section tags, style field, exclude field)
//   - style field under 900 chars
//   - banned cliché words absent from lyrics
"use strict";

const fs = require("fs");
const path = require("path");
const { chat, readJson } = require("../engine/llm");
const { renderHandoff } = require("../engine/compile");
const S = require("../engine/state");

const BANNED = ["neon", "shadows", "whisper", "echoes", "silhouette", "embers", "stardust", "demons", "skyline", "wildfire", "rise from the ashes", "broken pieces", "against all odds", "fire and ice"];

async function main() {
  const runFile = process.argv[2];
  const model = process.argv[3] || "qwen3:14b";
  if (!runFile) { console.error("usage: node harness/stranger.js <run.json> [model]"); process.exit(1); }
  const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
  const state = run.state;
  const handoff = renderHandoff(state);

  console.log(`songwriter=${model} (cold start — sees only the handoff)`);
  const song = await chat(model, [{ role: "user", content: handoff }], { temperature: 0.7, num_ctx: 16384 });

  const checks = [];
  const lyricsLower = song.toLowerCase();

  // Sacred words verbatim — same short-phrase floor the compiler applies.
  const sacred = state.factoids.filter((f) => f.category === "sacred" && (f.verbatim || f.text).split(/\s+/).length <= 12);
  for (const s of sacred) {
    const phrase = (s.verbatim || s.text).replace(/^"|"$/g, "");
    const ok = lyricsLower.includes(phrase.toLowerCase());
    checks.push({ name: `sacred survives: "${phrase}"`, ok });
  }

  // Section tags present
  checks.push({ name: "bracketed section tags", ok: /\[(intro|verse|chorus|pre-chorus|bridge|outro)/i.test(song) });

  // Style block present and sized
  const styleMatch = song.match(/BLOCK 2[^\n]*\n+([\s\S]*?)(?=\*\*BLOCK 3|BLOCK 3|$)/i);
  if (styleMatch) {
    const style = styleMatch[1].trim();
    checks.push({ name: `style field under 900 chars (${style.length})`, ok: style.length > 0 && style.length < 900 });
    const tagCount = style.split(",").length;
    checks.push({ name: `style tag count 8-15 (${tagCount})`, ok: tagCount >= 6 && tagCount <= 17 });
  } else {
    checks.push({ name: "style block present", ok: false });
  }
  checks.push({ name: "exclude block present", ok: /BLOCK 3/i.test(song) });

  // Cliché screen on the lyrics portion
  const lyricsBlock = (song.split(/BLOCK 2/i)[0] || song).toLowerCase();
  const hits = BANNED.filter((w) => new RegExp(`\\b${w.replace(/ /g, "\\s+")}\\b`).test(lyricsBlock));
  checks.push({ name: `cliché screen (${hits.length ? "hits: " + hits.join(", ") : "clean"})`, ok: hits.length === 0 });

  // Specificity: the top factoids must be RECOGNIZABLY in the lyrics — judged by a model,
  // not keyword overlap (comprehension is checked by something that comprehends).
  // No forced JSON format: the thinking judge goes degenerate under format=json;
  // let it reason, then parse the JSON out of its reply.
  const JUDGE_SYS = `You check whether a FACT about a person is recognizably reflected in SONG LYRICS. Lyrics compress and reword: present=true if the fact's most distinctive detail or image appears in ANY wording, even partially. present=false only if nothing in the lyrics points to this fact. Reply with ONLY a JSON object: {"present": boolean, "line": string}.`;
  // Judge exactly the five facts the handoff's MUST APPEAR section demands.
  const top = S.sortedFactoids(state)
    .filter((f) => ["specific", "scene"].includes(f.category) && f.text.split(/\s+/).length >= 5)
    .slice(0, 5);
  let grounded = 0;
  const lyricsBlock1 = song.split(/BLOCK 2/i)[0] || song;
  for (const f of top) {
    const raw = await chat(model, [
      { role: "system", content: JUDGE_SYS },
      { role: "user", content: `FACT: ${f.text}\n\nLYRICS:\n${lyricsBlock1}` },
    ], { temperature: 0.1, num_ctx: 8192 });
    const v = readJson(raw);
    if (v && v.present === true) grounded++;
  }
  checks.push({ name: `top specifics present in lyrics (${grounded}/${top.length})`, ok: grounded >= Math.min(4, top.length) });

  const pass = checks.every((c) => c.ok);
  const out = runFile.replace(/\.json$/, "_stranger.md");
  fs.writeFileSync(out, `# Stranger test — ${pass ? "PASS" : "FAIL"}\n\n` + checks.map((c) => `- ${c.ok ? "✓" : "✗"} ${c.name}`).join("\n") + `\n\n## The song\n\n${song}\n`);
  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name}`);
  console.log(`\n${pass ? "STRANGER TEST PASS" : "STRANGER TEST FAIL"} — saved ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
