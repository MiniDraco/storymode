package com.sensorysymphony.storymode

import android.content.Context
import com.google.mediapipe.tasks.genai.llminference.LlmInference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

data class Msg(val role: String, val content: String)

/** The engine's only door to a model. Desktop harness parity: same contract as engine/llm.js. */
interface LlmBridge {
    suspend fun chat(messages: List<Msg>, json: Boolean, temperature: Double): String
    val label: String
}

/** Robust JSON reader for small-model replies (fences, stray prose). Mirrors llm.js readJson. */
fun readJson(raw: String?): JSONObject? {
    if (raw == null) return null
    val candidates = mutableListOf<String>()
    raw.split("```").map { it.removePrefix("json").trim() }.filter { it.isNotEmpty() }
        .filterTo(candidates) { it.startsWith("{") || it.startsWith("[") }
    candidates.add(raw)
    for (c in candidates) {
        val start = c.indexOfFirst { it == '{' || it == '[' }
        if (start < 0) continue
        var sub = c.substring(start)
        val end = maxOf(sub.lastIndexOf('}'), sub.lastIndexOf(']'))
        if (end >= 0) sub = sub.substring(0, end + 1)
        try { return JSONObject(sub) } catch (_: Exception) {}
    }
    return null
}

suspend fun LlmBridge.chatJson(messages: List<Msg>, temperature: Double = 0.4): JSONObject? {
    var raw = chat(messages, json = true, temperature = temperature)
    readJson(raw)?.let { return it }
    raw = chat(
        messages + listOf(Msg("assistant", raw), Msg("user", "That was not valid JSON. Reply with ONLY the JSON object, nothing else.")),
        json = true, temperature = temperature
    )
    return readJson(raw)
}

/** Dev bridge: Ollama over LAN (the desktop box is the server). */
class OllamaBridge(private val host: String, private val model: String) : LlmBridge {
    override val label = "ollama:$model@$host"
    override suspend fun chat(messages: List<Msg>, json: Boolean, temperature: Double): String =
        withContext(Dispatchers.IO) {
            val body = JSONObject().apply {
                put("model", model)
                put("stream", false)
                if (json) put("format", "json")
                put("options", JSONObject().put("num_gpu", 99).put("num_ctx", 8192).put("temperature", temperature))
                put("messages", org.json.JSONArray().apply {
                    messages.forEach { m -> put(JSONObject().put("role", m.role).put("content", m.content)) }
                })
            }
            val conn = URL("$host/api/chat").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 10_000
            conn.readTimeout = 300_000
            conn.setRequestProperty("content-type", "application/json")
            conn.outputStream.use { it.write(body.toString().toByteArray()) }
            val text = conn.inputStream.bufferedReader().readText()
            JSONObject(text).optJSONObject("message")?.optString("content") ?: ""
        }
}

/** Shipping bridge: on-device via MediaPipe LLM Inference (Gemma-class .task/.litertlm model file). */
class MediaPipeBridge(context: Context, modelFile: File) : LlmBridge {
    override val label = "on-device:${modelFile.name}"
    private val llm: LlmInference

    init {
        val options = LlmInference.LlmInferenceOptions.builder()
            .setModelPath(modelFile.absolutePath)
            .setMaxTokens(4096) // matches the shipped model's ekv4096 KV window
            .build()
        llm = LlmInference.createFromOptions(context, options)
    }

    override suspend fun chat(messages: List<Msg>, json: Boolean, temperature: Double): String =
        withContext(Dispatchers.Default) {
            // MediaPipe takes a single prompt: flatten roles, then nudge JSON-only output.
            val prompt = buildString {
                messages.forEach { m ->
                    when (m.role) {
                        "system" -> append(m.content).append("\n\n")
                        "user" -> append(m.content).append("\n\n")
                        "assistant" -> append("Previous reply: ").append(m.content).append("\n\n")
                    }
                }
                if (json) append("Reply with ONLY the JSON object, nothing else.")
            }
            llm.generateResponse(prompt) ?: ""
        }

    fun close() = llm.close()
}
