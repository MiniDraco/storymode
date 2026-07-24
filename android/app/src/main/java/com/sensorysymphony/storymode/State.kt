package com.sensorysymphony.storymode

import org.json.JSONArray
import org.json.JSONObject

/** Mirrors engine/state.js — the factoid construct. Pure code, no model calls. */

data class CatSpec(val need: Int, val label: String)

val CATEGORIES = linkedMapOf(
    "identity" to CatSpec(1, "Who the song is about (name + relationship)"),
    "specific" to CatSpec(3, "Unmistakable specifics (objects, habits, sayings, rituals)"),
    "scene" to CatSpec(1, "A scene with a beginning, middle, end"),
    "emotion" to CatSpec(1, "The emotional center (and any tension inside it)"),
    "job" to CatSpec(1, "The song's job (occasion, room, moment)"),
    "sound" to CatSpec(1, "The sound (genre / reference artists / energy)"),
    "boundary" to CatSpec(0, "What must NOT appear"),
    "sacred" to CatSpec(0, "Phrases that must survive verbatim"),
)

val GAP_PRIORITY = listOf("identity", "specific", "scene", "emotion", "job", "sound", "boundary")
const val HARD_CEILING = 12

data class Factoid(
    val id: Int,
    val category: String,
    var text: String,
    var verbatim: String,
    var weight: Double,
    val flags: MutableList<String>,
    val turn: Int,
)

data class TurnRec(val q: String, val a: String, val turn: Int, val ts: Long)

class StoryState {
    val factoids = mutableListOf<Factoid>()
    val transcript = mutableListOf<TurnRec>()
    val asked = mutableListOf<String>()
    var turn = 0
    var name: String? = null
    var done = false
    var thin = listOf<String>()
    var woundConsentAsked = false
    private var nextId = 0

    fun addFactoid(category: String, text: String, verbatim: String, weight: Double, flags: List<String>): Factoid? {
        val t = text.trim()
        if (t.isEmpty()) return null
        val cat = if (CATEGORIES.containsKey(category)) category else "specific"
        for (g in factoids) {
            if (g.category == cat && jaccard(g.text, t) >= 0.6) {
                if (weight > g.weight) { g.text = t; g.weight = weight; if (verbatim.isNotBlank()) g.verbatim = verbatim }
                return g
            }
        }
        val rec = Factoid(++nextId, cat, t, verbatim.trim(), weight.coerceIn(0.0, 10.0), flags.toMutableList(), turn)
        factoids.add(rec)
        return rec
    }

    fun byCategory(cat: String) = factoids.filter { it.category == cat }

    fun coverage(): Map<String, Triple<Int, Int, Boolean>> =
        CATEGORIES.mapValues { (k, v) -> Triple(byCategory(k).size, v.need, byCategory(k).size >= v.need) }

    fun gaps(): List<String> {
        val cov = coverage()
        return GAP_PRIORITY.filter { !(cov[it]?.third ?: true) }
    }

    fun readiness(): Pair<Boolean, String> {
        val g = gaps()
        if (turn >= HARD_CEILING) return true to "ceiling"
        // A surfaced wound without consent is not complete — hold-or-steer is a compositional fact.
        val wound = factoids.any { "wound" in it.flags }
        if (g.isEmpty() && wound && !woundConsentAsked) return false to "consent"
        if (g.isEmpty()) return true to "complete"
        return false to "gaps"
    }

    fun sortedFactoids(): List<Factoid> {
        val bonus = mapOf("scene" to 1.5, "specific" to 1.2, "emotion" to 1.2, "sacred" to 1.4, "identity" to 1.0, "boundary" to 0.8, "job" to 0.5, "sound" to 0.5)
        return factoids.sortedByDescending { it.weight * (bonus[it.category] ?: 1.0) }
    }

    fun knownDigest(max: Int = 120): String =
        sortedFactoids().take(max).joinToString("\n") { "- [${it.category}] ${it.text}" }

    fun heatFrom(t: Int, n: Int = 3): List<Factoid> =
        factoids.filter { it.turn == t && it.category in listOf("scene", "emotion", "specific", "sacred") }
            .sortedByDescending { it.weight }.take(n)

    // ---- persistence (nothing gets lost, ever) ----
    fun toJson(): JSONObject = JSONObject().apply {
        put("turn", turn); put("name", name ?: JSONObject.NULL); put("done", done)
        put("woundConsentAsked", woundConsentAsked); put("nextId", nextId)
        put("thin", JSONArray(thin)); put("asked", JSONArray(asked))
        put("factoids", JSONArray().apply { factoids.forEach { f -> put(JSONObject().apply {
            put("id", f.id); put("category", f.category); put("text", f.text); put("verbatim", f.verbatim)
            put("weight", f.weight); put("flags", JSONArray(f.flags)); put("turn", f.turn) }) } })
        put("transcript", JSONArray().apply { transcript.forEach { t -> put(JSONObject().apply {
            put("q", t.q); put("a", t.a); put("turn", t.turn); put("ts", t.ts) }) } })
    }

    companion object {
        fun norm(s: String) = s.lowercase().replace(Regex("[^a-z0-9\\s]"), " ").replace(Regex("\\s+"), " ").trim()
        fun tokens(s: String) = norm(s).split(" ").filter { it.length > 2 }
        fun jaccard(a: String, b: String): Double {
            val ta = tokens(a).toSet(); val tb = tokens(b).toSet()
            if (ta.isEmpty() || tb.isEmpty()) return 0.0
            val inter = ta.count { it in tb }
            return inter.toDouble() / (ta.size + tb.size - inter)
        }

        fun fromJson(o: JSONObject): StoryState {
            val s = StoryState()
            s.turn = o.optInt("turn"); s.name = o.optString("name").takeIf { it.isNotBlank() && it != "null" }
            s.done = o.optBoolean("done"); s.woundConsentAsked = o.optBoolean("woundConsentAsked")
            val fa = o.optJSONArray("factoids") ?: JSONArray()
            for (i in 0 until fa.length()) {
                val f = fa.getJSONObject(i)
                val flags = mutableListOf<String>()
                val fl = f.optJSONArray("flags") ?: JSONArray()
                for (j in 0 until fl.length()) flags.add(fl.getString(j))
                s.factoids.add(Factoid(f.getInt("id"), f.getString("category"), f.getString("text"),
                    f.optString("verbatim"), f.getDouble("weight"), flags, f.getInt("turn")))
            }
            val ta = o.optJSONArray("transcript") ?: JSONArray()
            for (i in 0 until ta.length()) {
                val t = ta.getJSONObject(i)
                s.transcript.add(TurnRec(t.getString("q"), t.getString("a"), t.getInt("turn"), t.optLong("ts")))
            }
            val aa = o.optJSONArray("asked") ?: JSONArray()
            for (i in 0 until aa.length()) s.asked.add(aa.getString(i))
            return s
        }
    }
}

fun jaccard(a: String, b: String) = StoryState.jaccard(a, b)
