// COMPILE — deterministic assembly of the dossier + handoff prompt. No model calls.
// The factoid DB and Billy's template stay separate until this moment; the prompt is a render, not a bake.
"use strict";

const fs = require("fs");
const path = require("path");
const S = require("./state");

function loadTemplate() {
  return fs.readFileSync(path.join(__dirname, "..", "templates", "handoff.md"), "utf8");
}

function section(items, empty) {
  return items.length ? items.map((s) => `- ${s}`).join("\n") : `- ${empty}`;
}

function renderHandoff(state, template) {
  const tpl = template || loadTemplate();
  const sorted = S.sortedFactoids(state);
  const ident = S.byCategory(state, "identity").map((f) => f.text);
  const job = S.byCategory(state, "job").map((f) => f.text);
  const sound = S.byCategory(state, "sound").map((f) => f.text);
  const sacred = S.byCategory(state, "sacred").map((f) => `"${f.verbatim || f.text}"`);
  const bounds = S.byCategory(state, "boundary").map((f) => f.text);
  const phonetic = state.factoids.filter((f) => f.flags.includes("phonetic")).map((f) => f.text);

  const material = sorted
    .filter((f) => ["specific", "scene", "emotion"].includes(f.category))
    .map((f, i) => `${i + 1}. [${f.category}, heat ${f.weight}] ${f.text}${f.flags.includes("wound") ? "  (a wound — customer consented; hold it with care)" : ""}`)
    .join("\n");

  const cov = S.coverage(state);
  const thin = Object.entries(cov)
    .filter(([k, v]) => v.need > 0 && v.have < v.need)
    .map(([k, v]) => `${v.label}: THIN — the customer gave little here. Do not invent depth to fill it.`);

  const transcript = state.transcript
    .map((t) => `Q${t.turn}: ${t.q}\nA${t.turn}: ${t.a}`)
    .join("\n\n");

  return tpl
    .replace("{{IDENTITY}}", section(ident.concat(phonetic), "not fully established — see transcript"))
    .replace("{{JOB}}", section(job, "not stated — a warm, giftable tone is safe"))
    .replace("{{FACTOIDS}}", material || "- (thin — see transcript)")
    .replace("{{SACRED}}", section(sacred, "none given"))
    .replace("{{BOUNDARIES}}", section(bounds, "none given"))
    .replace("{{SOUND}}", section(sound, "not stated — choose to fit the emotional center"))
    .replace("{{THIN}}", thin.length ? thin.map((s) => `- ${s}`).join("\n") : "- none; all core slots earned")
    .replace("{{TRANSCRIPT}}", transcript);
}

// Operator dossier — everything, structured, conclusions beside their evidence.
function renderDossier(state, meta = {}) {
  const cov = S.coverage(state);
  const lines = [];
  lines.push(`# DOSSIER — ${state.name || "unnamed subject"}`);
  lines.push("");
  lines.push("## Fulfillment");
  lines.push(`- Customer: ${meta.customer || "(from link params)"}`);
  lines.push(`- Channel/order: ${meta.order || "(from link params)"}`);
  lines.push(`- Occasion date: ${meta.date || "(none given)"}`);
  lines.push("");
  lines.push("## Coverage");
  for (const [k, v] of Object.entries(cov)) {
    const mark = v.need === 0 ? (v.have ? "✓" : "—") : v.ok ? "✓" : "THIN";
    lines.push(`- ${mark} ${v.label} (${v.have}${v.need ? "/" + v.need : ""})`);
  }
  lines.push("");
  lines.push("## Factoids (sorted, each with its source)");
  for (const f of S.sortedFactoids(state)) {
    lines.push(`- [${f.category} | heat ${f.weight} | turn ${f.turn}${f.flags.length ? " | " + f.flags.join(",") : ""}] ${f.text}`);
    if (f.verbatim && f.verbatim !== f.text) lines.push(`  > "${f.verbatim}"`);
  }
  lines.push("");
  lines.push("## Transcript (verbatim)");
  for (const t of state.transcript) {
    lines.push(`**Q${t.turn}:** ${t.q}`);
    lines.push(`**A${t.turn}:** ${t.a}`);
    lines.push("");
  }
  return lines.join("\n");
}

// The customer's finish paragraph — their own words mirrored back. Code-rendered, zero generation.
function renderFinish(state) {
  const top = S.sortedFactoids(state)
    .filter((f) => ["specific", "scene", "emotion"].includes(f.category))
    .slice(0, 4);
  const who = state.name || "them";
  if (!top.length) return `Your story is in. Everything you told me about ${who} goes straight to the person writing their song.`;
  const bits = top.map((f) => f.verbatim || f.text);
  return [
    `Here's what I'm carrying to the songwriter — in your words:`,
    ...bits.map((b) => `“${b}”`),
    `That's ${who}. Nobody else. Your story is in — the song is next.`,
  ].join("\n");
}

module.exports = { renderHandoff, renderDossier, renderFinish, loadTemplate };
