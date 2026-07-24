# Story Mode — Android

The interview engine wrapped in an APK. Same loop as the desktop harness (`../engine/`), ported 1:1 to Kotlin: extract → merge/rank → question → stop → compile. The customer talks; the finish screen mirrors their own words back; the operator gets the dossier + the paste-ready Gemini prompt.

## The brain is swappable (LlmBridge)

1. **On-device (shipping mode)** — MediaPipe LLM Inference (`tasks-genai`). If a model file exists at
   `Android/data/com.sensorysymphony.storymode/files/model.task` (or `.litertlm`), the app runs fully offline.
   Get a model (one-time, on any PC):
   - Gemma 3 1B IT (int4 .task, ~550 MB): https://huggingface.co/litert-community/Gemma3-1B-IT (accept license, download the `.task`)
   - Push it: `adb push Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task /sdcard/Android/data/com.sensorysymphony.storymode/files/model.task`
     (or copy via any file manager after the app's first launch creates the folder)
2. **LAN dev mode (default fallback)** — no model file present → talks to the desktop's Ollama
   (`http://<desktop-ip>:11434`, `qwen2.5:3b` — the same weights the gate evidence was earned on).
   Host/model live in SharedPreferences (`ollama_host`, `ollama_model`).

## Prompts are data

`app/src/main/assets/{extract,question,opening}.txt` + `handoff.md` are the operator-editable language —
identical files to `../prompts/` and `../templates/`. Editing them changes how it listens and what it hands off.

## Build

```
cd android
gradlew.bat assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
```

SDK path comes from `local.properties` (`C:\Android\Sdk`).

## Nothing gets lost

Every answer is written to disk (`files/session.json`) **before** any model work happens; kill the app
mid-interview and it resumes at the exact question. Finished interviews persist as `files/finished-*.json`.
