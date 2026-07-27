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
    var nameAsked = false
    var mode = "person"
    var modeLens = ""
    var modeLabels: Map<String, String> = emptyMap()
    var modeNameAsk: String? = null
    val fallbackCounts = mutableMapOf<String, Int>()
    private var nextId = 0

    private fun stripNotation(s: String) = s.replace(Regex("^\\s*(?:-\\s*)?\\[[a-z]+\\]\\s*", RegexOption.IGNORE_CASE), "").trim()

    fun addFactoid(category: String, text: String, verbatim0: String, weight: Double, flags: List<String>): Factoid? {
        val t = stripNotation(text)
        val verbatim = stripNotation(verbatim0)
        if (t.isEmpty()) return null
        var cat0 = category
        if (!plausibleCategory(cat0, "$t $verbatim")) cat0 = "specific"
        // Sacred phrases are short by nature — a filed paragraph is material, not scripture.
        if (cat0 == "sacred" && t.split(Regex("\\s+")).size > 12) cat0 = "emotion"
        val cat = if (CATEGORIES.containsKey(cat0)) cat0 else "specific"
        val cleanFlags = if ("wound" in flags && !plausibleWound("$t $verbatim")) flags.filter { it != "wound" } else flags
        for (g in factoids) {
            if (g.category == cat && jaccard(g.text, t) >= 0.6) {
                if (weight > g.weight) { g.text = t; g.weight = weight; if (verbatim.isNotBlank()) g.verbatim = verbatim }
                return g
            }
        }
        val rec = Factoid(++nextId, cat, t, verbatim.trim(), weight.coerceIn(0.0, 10.0), cleanFlags.toMutableList(), turn)
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
        put("mode", mode); put("nameAsked", nameAsked)
        put("woundConsentAsked", woundConsentAsked); put("nextId", nextId)
        put("thin", JSONArray(thin)); put("asked", JSONArray(asked))
        put("factoids", JSONArray().apply { factoids.forEach { f -> put(JSONObject().apply {
            put("id", f.id); put("category", f.category); put("text", f.text); put("verbatim", f.verbatim)
            put("weight", f.weight); put("flags", JSONArray(f.flags)); put("turn", f.turn) }) } })
        put("transcript", JSONArray().apply { transcript.forEach { t -> put(JSONObject().apply {
            put("q", t.q); put("a", t.a); put("turn", t.turn); put("ts", t.ts) }) } })
    }

    companion object {
        // Plausibility floors for the load-bearing slots — junk in sound/job silently
        // "completes" the slot and kills the question that should have been asked.
        private val SOUND_RE = Regex("\\b(music|song|songs|sing|singer|singing|sings|band|artist|album|genre|country|rock|folk|jazz|blues|rap|hip.?hop|r&b|soul|gospel|pop|acoustic|guitar|piano|fiddle|drums?|melody|radio|playlist|record|vinyl|hums?|humming|whistl\\w*|voice|vocal|tempo|upbeat|ballad|anthem|lullaby|hits|tunes?|tracks?|jams?|blast(s|ing|ed)?|listen\\w*|[A-Z]\\w+ (Mac|Haggard|Cash|Strait|Nicks|Seger))\\b", RegexOption.IGNORE_CASE)
        private val IDENTITY_RE = Regex("\\b(my (wife|husband|dad|father|mom|mother|son|daughter|brother|sister|best friend|friend|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|partner|fianc\\w*|boyfriend|girlfriend|boss|mentor|neighbor|coworker)|wife of \\d+|husband of \\d+|(he|she)('s| is) my \\w+)\\b", RegexOption.IGNORE_CASE)
        private val JOB_RE = Regex("\\b(birthday|wedding|anniversar\\w*|memorial|funeral|retirement|graduation|proposal|christmas|reunion|party|celebration|reception|dinner|gathering|ceremony|surprise|occasion|plays? (at|for)|played at|hall|church|toast|slideshow|septemb\\w*|octob\\w*|novemb\\w*|decemb\\w*|januar\\w*|februar\\w*|march|april|may|june|july|august)\\b", RegexOption.IGNORE_CASE)
        fun plausibleCategory(cat: String, text: String): Boolean = when (cat) {
            "sound" -> SOUND_RE.containsMatchIn(text)
            "job" -> JOB_RE.containsMatchIn(text)
            else -> true
        }
        private val SCENE_RE = Regex("\\b(the (night|day|morning|afternoon|evening|summer|winter|spring|fall|year|time|moment) (of|when|she|he|we|i|before|after)|one (night|day|time|morning)|that (night|day|morning|time)|when (he|she|we|i|they) \\w+|there was (a|this|one)|i remember (the|when|that))\\b", RegexOption.IGNORE_CASE)
        private val EMOTION_RE = Regex("\\b(feel|feels|felt|feeling|love[ds]?|loving|joy|joyful|smile[ds]?|laugh\\w* (made|makes|brought|brings)|warmth|warms?( my)? heart|proud|pride|grateful|gratitude|miss(es|ed)? (him|her|them)|happy|happiness|comfort\\w*|peace(ful)?|bittersweet|heart (aches?|swells?|full))\\b", RegexOption.IGNORE_CASE)
        fun coversGap(cat: String, text: String): Boolean = when (cat) {
            "sound" -> SOUND_RE.containsMatchIn(text)
            "job" -> JOB_RE.containsMatchIn(text)
            "identity" -> IDENTITY_RE.containsMatchIn(text)
            "scene" -> SCENE_RE.containsMatchIn(text)
            "emotion" -> EMOTION_RE.containsMatchIn(text)
            else -> false
        }

        // A "wound" needs actual pain in it — a consent question aimed at warmth reads as a re-ask.
        private val WOUND_RE = Regex("\\b(died?|dying|death|passed( away)?|cancer|funeral|buried|grave|lost (him|her|them|my)|loss|grief|griev\\w*|mourn\\w*|divorc\\w*|cheat\\w*|betray\\w*|affair|accident|crash|hospital|hospice|diagnos\\w*|heart attack|stroke|suicide|overdos\\w*|addict\\w*|rehab|sober|abus\\w*|estrang\\w*|didn'?t (speak|talk)|not (speak|talk)ing|no longer (here|with us)|gone now|miss (him|her|them)|widow\\w*|jail|prison|deploy\\w*|war|ptsd|depress\\w*|anxiety|cried|crying|tears|wreck|painful|the pain|hurt\\w*|struggl\\w*|nightmare)\\b", RegexOption.IGNORE_CASE)
        fun plausibleWound(text: String) = WOUND_RE.containsMatchIn(text)

        private val NAME_STOP = setOf("The","She","He","They","We","And","But","So","Oh","You","It","My","Her","His","Their","When","What","Like","Just","Every","One","That","This","There","Then","Now","Well","Yeah","Also","Even","Not","All","If","Or","Because","January","February","March","April","May","June","July","August","September","October","November","December","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday","Christmas","God","Mom","Dad","Ma","Pa","Grandma","Grandpa")

        private val REL_WORDS_RE = Regex("^(wife|husband|dad|father|mom|mother|son|daughter|brother|sister|friend|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|partner|boyfriend|girlfriend|boss|mentor|neighbor|coworker)$", RegexOption.IGNORE_CASE)

        /** Most frequent repeated proper noun with real name evidence — confirmed, never assumed. */
        fun nameCandidate(state: StoryState): String? {
            val total = mutableMapOf<String, Int>(); val strong = mutableMapOf<String, Int>(); val paired = mutableMapOf<String, Int>()
            fun isCap(s: String?) = s != null && Regex("^[A-Z][a-z]{2,}$").matches(s.replace(Regex("[^A-Za-z']"), "").removeSuffix("'s"))
            for (t in state.transcript) {
                for (sentence in t.a.split(Regex("[.!?\\n]+"))) {
                    val words = sentence.trim().split(Regex("\\s+"))
                    for (i in words.indices) {
                        var w = words[i].replace(Regex("[^A-Za-z']"), "")
                        val possessive = w.endsWith("'s")
                        w = w.removeSuffix("'s").replace("'", "")
                        if (!Regex("^[A-Z][a-z]{2,}$").matches(w) || w in NAME_STOP) continue
                        total[w] = (total[w] ?: 0) + 1
                        if (isCap(words.getOrNull(i - 1)) || isCap(words.getOrNull(i + 1))) paired[w] = (paired[w] ?: 0) + 1
                        val c1 = (words.getOrNull(i + 1) ?: "").replace(Regex("[^A-Za-z]"), "")
                        val c2 = (words.getOrNull(i + 2) ?: "").replace(Regex("[^A-Za-z]"), "")
                        val intro = (c1.matches(Regex("(?i)was|is")) && c2.matches(Regex("(?i)my"))) ||
                            (c1.matches(Regex("(?i)my")) && REL_WORDS_RE.matches(c2))
                        if (i > 0 || possessive || intro) strong[w] = (strong[w] ?: 0) + 1
                    }
                }
            }
            // A word that ONLY appears next to another capitalized word is a compound, not a name.
            for (w in total.keys) if ((paired[w] ?: 0) >= (total[w] ?: 0)) strong.remove(w)
            return total.entries.filter { (strong[it.key] ?: 0) >= 1 }
                .maxByOrNull { it.value }?.key
        }

        /** Multi-word proper-noun candidate ("Shear Bliss") — adjacent capitalized words as a phrase. */
        fun nameCandidatePhrase(state: StoryState): String? {
            val counts = mutableMapOf<String, Int>()
            for (t in state.transcript) {
                for (sentence in t.a.split(Regex("[.!?\\n]+"))) {
                    val words = sentence.trim().split(Regex("\\s+")).map { it.replace(Regex("[^A-Za-z']"), "").removeSuffix("'s") }
                    for (i in 0 until words.size - 1) {
                        val a = words[i]; val b = words[i + 1]
                        if (Regex("^[A-Z][a-z]{2,}$").matches(a) && Regex("^[A-Z][a-z]{2,}$").matches(b) && a !in NAME_STOP && b !in NAME_STOP) {
                            val k = "$a $b"
                            counts[k] = (counts[k] ?: 0) + 1
                        }
                    }
                }
            }
            return counts.entries.maxByOrNull { it.value }?.key ?: nameCandidate(state)
        }

        /** Code-only heal: recategorize plainly-matching factoids into open gaps before target selection. */
        fun syncHeal(state: StoryState) {
            for (gapKey in listOf("sound", "job", "identity", "scene", "emotion")) {
                if (gapKey !in state.gaps()) continue
                val hit = state.factoids.firstOrNull { it.category != gapKey && coversGap(gapKey, "${it.text} ${it.verbatim}") }
                if (hit != null) state.addFactoid(gapKey, hit.text, hit.verbatim, hit.weight, listOf("recategorized"))
            }
        }

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
            s.mode = o.optString("mode").ifBlank { "person" }; s.nameAsked = o.optBoolean("nameAsked")
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
