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
  // Defense in depth: only short phrases render as sacred, whatever the state holds.
  const sacred = S.byCategory(state, "sacred")
    .map((f) => f.verbatim || f.text)
    .filter((t) => t.split(/\s+/).length <= 12)
    .map((t) => `"${t}"`);
  const bounds = S.byCategory(state, "boundary").map((f) => f.text);
  const phonetic = state.factoids.filter((f) => f.flags.includes("phonetic")).map((f) => f.text);

  const material = sorted
    .filter((f) => ["specific", "scene", "emotion"].includes(f.category))
    .map((f, i) => `${i + 1}. [${f.category}, heat ${f.weight}] ${f.text}${f.flags.includes("wound") ? "  (a wound — customer consented; hold it with care)" : ""}`)
    .join("\n");

  // The five facts the song cannot skip: highest-ranked story material with a real
  // image in it (fragments carry nothing to ground a lyric on).
  const mustAppear = sorted
    .filter((f) => ["specific", "scene"].includes(f.category) && f.text.split(/\s+/).length >= 5)
    .slice(0, 5)
    .map((f, i) => `${i + 1}. ${f.text}`)
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
    .replace("{{MUSTAPPEAR}}", mustAppear || "- (thin — ground in whatever the transcript offers)")
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
// Screenshot-sized: short punchy quotes only, never paragraphs.
function renderFinish(state) {
  const who = state.name && state.name.length <= 30 ? state.name : "them";
  const quotable = S.sortedFactoids(state)
    .filter((f) => ["specific", "scene", "emotion", "sacred"].includes(f.category))
    .map((f) => {
      // Prefer the shorter of text/verbatim; a good mirror line is 3-20 words.
      const cands = [f.verbatim, f.text].filter(Boolean).map((s) => s.trim())
        .filter((s) => { const w = s.split(/\s+/).length; return w >= 3 && w <= 20; })
        .sort((a, b) => a.length - b.length);
      return cands[0] ? { q: cands[0], w: f.weight } : null;
    })
    .filter(Boolean)
    .slice(0, 4);
  if (!quotable.length) return `Your story is in. Everything you told me about ${who} goes straight to the person writing their song.`;
  return [
    `Here's what I'm carrying to the songwriter — in your words:`,
    ...quotable.map((b) => `“${b.q}”`),
    `That's ${who}. Nobody else. Your story is in — the song is next.`,
  ].join("\n");
}

module.exports = { renderHandoff, renderDossier, renderFinish, loadTemplate };
