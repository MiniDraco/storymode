// Ollama client — the only place the engine touches a model.
// On the APK this file is replaced by a llama.cpp/MediaPipe binding with the same signature.
"use strict";

const HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

async function chat(model, messages, opts = {}) {
  const body = {
    model,
    messages,
    stream: false,
    options: {
      num_gpu: 99,
      num_ctx: opts.num_ctx || 8192,
      temperature: opts.temperature ?? 0.4,
      ...(opts.options || {}),
    },
  };
  if (opts.json) body.format = "json";
  const res = await fetch(HOST + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message?.content ?? "";
}

// Robust JSON reader for small-model replies (fences, stray prose).
function readJson(raw) {
  if (typeof raw !== "string") return null;
  const candidates = [];
  const fenced = raw.split("```").map((s) => s.replace(/^json/i, "").trim()).filter(Boolean);
  for (const f of fenced) if (/^[\[{]/.test(f)) candidates.push(f);
  candidates.push(raw);
  for (const c of candidates) {
    const start = c.search(/[\[{]/);
    if (start < 0) continue;
    let sub = c.slice(start);
    const end = Math.max(sub.lastIndexOf("}"), sub.lastIndexOf("]"));
    if (end >= 0) sub = sub.slice(0, end + 1);
    try { return JSON.parse(sub); } catch (_) {}
  }
  return null;
}

// chatJson: call, parse, one silent retry with a format nudge. Returns null only after both fail.
async function chatJson(model, messages, opts = {}) {
  let raw = await chat(model, messages, { ...opts, json: true });
  let parsed = readJson(raw);
  if (parsed) return parsed;
  raw = await chat(
    model,
    [...messages, { role: "assistant", content: raw }, { role: "user", content: "That was not valid JSON. Reply with ONLY the JSON object, nothing else." }],
    { ...opts, json: true }
  );
  return readJson(raw);
}

module.exports = { chat, chatJson, readJson, HOST };
