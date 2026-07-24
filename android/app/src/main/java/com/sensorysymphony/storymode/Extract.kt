package com.sensorysymphony.storymode

import org.json.JSONArray

/** Mirrors engine/extract.js — chunk answers, pull grounded factoids. Ungrounded output is dropped. */
object Extract {

    fun chunk(text: String, target: Int = 120): List<String> {
        val paras = text.split(Regex("\n+")).map { it.trim() }.filter { it.isNotEmpty() }
        val chunks = mutableListOf<String>()
        var cur = mutableListOf<String>()
        var count = 0
        fun flush() { if (cur.isNotEmpty()) { chunks.add(cur.joinToString("\n")); cur = mutableListOf(); count = 0 } }
        for (p in paras) {
            val w = p.split(Regex("\\s+")).size
            if (w > target * 1.8) {
                flush()
                var scur = mutableListOf<String>(); var scount = 0
                val sentences = Regex("[^.!?]+[.!?]+|\\S[^.!?]*$").findAll(p).map { it.value }.toList().ifEmpty { listOf(p) }
                for (s in sentences) {
                    val sw = s.split(Regex("\\s+")).size
                    if (scount + sw > target && scur.isNotEmpty()) { chunks.add(scur.joinToString(" ")); scur = mutableListOf(); scount = 0 }
                    scur.add(s.trim()); scount += sw
                }
                if (scur.isNotEmpty()) chunks.add(scur.joinToString(" "))
                continue
            }
            if (count + w > target && cur.isNotEmpty()) flush()
            cur.add(p); count += w
        }
        flush()
        return chunks.ifEmpty { listOf(text) }
    }

    /** Anti-invention armor: the verbatim must actually appear in the source chunk. */
    fun grounded(verbatim: String, source: String): Boolean {
        val v = StoryState.norm(verbatim); val s = StoryState.norm(source)
        if (v.isEmpty()) return false
        if (s.contains(v)) return true
        val vt = v.split(" ").filter { it.length > 2 }
        if (vt.isEmpty()) return false
        val st = s.split(" ").toSet()
        return vt.count { it in st }.toDouble() / vt.size >= 0.8
    }

    data class Extracted(val category: String, val text: String, val verbatim: String, val weight: Double, val flags: List<String>)

    suspend fun fromAnswer(llm: LlmBridge, systemPrompt: String, question: String, answer: String,
                           onProgress: (Int, Int) -> Unit = { _, _ -> }): List<Extracted> {
        val chunks = chunk(answer)
        val out = mutableListOf<Extracted>()
        chunks.forEachIndexed { i, ch ->
            onProgress(i + 1, chunks.size)
            val user = "INTERVIEW QUESTION THAT PROMPTED THIS:\n$question\n\nCUSTOMER'S WORDS:\n$ch"
            val parsed = llm.chatJson(listOf(Msg("system", systemPrompt), Msg("user", user)), temperature = 0.2) ?: return@forEachIndexed
            val fa = parsed.optJSONArray("factoids") ?: JSONArray()
            for (j in 0 until fa.length()) {
                val f = fa.optJSONObject(j) ?: continue
                val text = f.optString("text"); if (text.isBlank()) continue
                val verbatim = f.optString("verbatim").ifBlank { text }
                if (!grounded(verbatim, ch)) continue
                val flags = mutableListOf<String>()
                val fl = f.optJSONArray("flags") ?: JSONArray()
                for (k in 0 until fl.length()) fl.optString(k)?.let { if (it.isNotBlank()) flags.add(it) }
                out.add(Extracted(f.optString("category"), text, verbatim, f.optDouble("heat", 3.0), flags))
            }
            val name = parsed.optString("name")
            if (name.isNotBlank() && name != "null") {
                out.add(Extracted("identity", "name: $name", name, 8.0, listOf("name")))
            }
        }
        return out
    }
}
