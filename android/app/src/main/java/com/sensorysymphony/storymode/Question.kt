package com.sensorysymphony.storymode

/** Mirrors engine/question.js — code picks the target; the model only words the question. */
object Question {

    private val YESNO = Regex("^(do|does|did|is|are|was|were|have|has|had|can|could|would|will|should)\\b", RegexOption.IGNORE_CASE)
    private val META = Regex("\\b(comes? to (your )?mind|first (thing|came)|describe them|thought about|tell me about them)\\b", RegexOption.IGNORE_CASE)
    private val GENERIC = Regex("\\b(stood out|stands? out|notice(d)? most|remember most|makes? (him|her|them) (so )?special|most about (him|her|them)|stay(ed|s)? with you( the)? most|most represents?|best (shows|describes|captures)|captures who (he|she|they)|you think most|only you (knew|know)|no ?one else (knew|knows|did|does)|nobody else (knew|knows))\\b", RegexOption.IGNORE_CASE)
    private val COMPOUND = Regex("\\band (why|what|how|when|where|who)\\b", RegexOption.IGNORE_CASE)

    val FALLBACKS = mapOf(
        "identity" to "Who is this song for — what's their name, and who are they to you?",
        "specific" to "What's one thing about them that almost nobody else does — a habit, a saying, a ritual?",
        "scene" to "Tell me about one specific time with them that you still think about — what happened?",
        "emotion" to "When you picture them right now, what's the feeling that comes up first?",
        "job" to "Where does this song get played — what's the occasion, and who's in the room?",
        "sound" to "What should this sound like — what music do they love, or what artist feels right?",
        "boundary" to "What should this song stay away from — anything that shouldn't be mentioned?",
    )

    private val EXCLUSION = Regex("\\b(besides|another|one more|something else|anything else|different|other than|new)\\b", RegexOption.IGNORE_CASE)
    private val DEEPEN = Regex("\\b(a time|one time|one moment|the (day|night|morning|moment) |that (day|night|morning)|what happened|when (he|she|they|you|it) )\\b", RegexOption.IGNORE_CASE)
    private val COMMON_BIGRAM_WORDS = setOf("about", "there", "their", "would", "could", "should", "always", "never", "really", "thing", "things", "something", "someone")

    /** Reusing the customer's distinctive phrase from ANY prior answer without exclusion/deepening framing is re-telling and re-asking. */
    private fun recyclesKnown(q: String, state: StoryState): Boolean {
        if (EXCLUSION.containsMatchIn(q) || DEEPEN.containsMatchIn(q)) return false
        val allAnswers = state.transcript.joinToString(" ") { it.a }
        if (allAnswers.isBlank()) return false
        fun strip(s: String) = StoryState.tokens(s).filter { it.length >= 4 && it !in COMMON_BIGRAM_WORDS }
        val qt = strip(q)
        val an = " " + strip(allAnswers).joinToString(" ") + " "
        for (i in 0 until qt.size - 1) {
            if (an.contains(" " + qt[i] + " " + qt[i + 1] + " ")) return true
        }
        return false
    }

    fun validate(q: String?, state: StoryState, kind: String? = null, lastAnswer: String? = null): List<String> {
        val problems = mutableListOf<String>()
        if (q.isNullOrBlank()) { problems.add("empty"); return problems }
        if (!q.contains("?")) problems.add("not a question")
        if (q.count { it == '?' } > 1) problems.add("more than one question")
        // Consent is a decision question — yes/no is legal there, and only there.
        if (kind != "consent") {
            if (q.trim().startsWith("why", ignoreCase = true)) problems.add("why-question (use What/How)")
            if (YESNO.containsMatchIn(q.trim())) problems.add("yes/no question")
        }
        if (q.split(Regex("\\s+")).size > 38) problems.add("too long")
        if (state.turn >= 1 && META.containsMatchIn(q)) problems.add("meta-question / restatement of the opening")
        if (state.turn >= 1 && GENERIC.containsMatchIn(q)) problems.add("generic 'what stood out' form — name a known detail and ask for something different")
        if (COMPOUND.containsMatchIn(q)) problems.add("compound question — one ask only")
        if (kind != "consent" && recyclesKnown(q, state)) problems.add("reuses the customer's own phrase without 'Besides…' or 'a time when…' framing — that asks for what they already gave")
        if (Regex("[\\[\\]]|\\bname:").containsMatchIn(q)) problems.add("internal notation leaked into the question")
        if (state.asked.any { jaccard(it, q) >= 0.45 }) problems.add("near-duplicate of an asked question")
        // Revisiting the same moment in new words: any shared 3-gram with a prior question,
        // computed over stopword-stripped tokens so "the night"/"that night" can't dodge it.
        val stop = setOf("the", "that", "this", "and", "with", "you", "your", "for", "was", "were", "did", "does")
        val pronoun = setOf("him", "her", "them", "he", "she", "they", "his", "hers", "their")
        fun strip(s: String) = StoryState.tokens(s).filter { it !in stop }.map { if (it in pronoun) "prn" else it }
        val qt = strip(q)
        run {
            for (prev in state.asked) {
                val pn = " " + strip(prev).joinToString(" ") + " "
                for (i in 0..qt.size - 3) {
                    if (pn.contains(" " + qt.subList(i, i + 3).joinToString(" ") + " ")) {
                        problems.add("revisits a moment already asked about — pick a different thread")
                        return@run
                    }
                }
            }
        }
        return problems
    }

    fun reflectionGrounded(refl: String?, lastAnswer: String): Boolean {
        if (refl.isNullOrBlank()) return false
        val rt = StoryState.tokens(refl)
        if (rt.size < 3) return false
        val at = StoryState.norm(lastAnswer)
        for (i in 0..rt.size - 3) if (at.contains(rt.subList(i, i + 3).joinToString(" "))) return true
        val aset = StoryState.tokens(lastAnswer).toSet()
        val hits = rt.count { it in aset }
        return hits >= minOf(4, Math.ceil(rt.size * 0.4).toInt())
    }

    sealed class Target {
        data class Consent(val wound: Factoid) : Target()
        data class Heat(val thread: Factoid, val target: String) : Target()
        data class Gap(val target: String) : Target()
        object Name : Target()
        data class NameConfirm(val candidate: String) : Target()
        object ModeName : Target()
        object Relationship : Target()
        object Done : Target()
    }

    private suspend fun gapAlreadyCovered(llm: LlmBridge, state: StoryState, gapKey: String): Boolean {
        // Deterministic pre-pass: a known factoid plainly matching the gap's pattern gets
        // recategorized directly — no model roulette.
        if (gapKey in listOf("sound", "job", "identity", "scene", "emotion")) {
            val hit = state.factoids.firstOrNull {
                it.category != gapKey && StoryState.coversGap(gapKey, "${it.text} ${it.verbatim}")
            }
            if (hit != null) {
                state.addFactoid(gapKey, hit.text, hit.verbatim, hit.weight, listOf("recategorized"))
                return true
            }
        }
        val parsed = llm.chatJson(listOf(
            Msg("system", "You check whether a topic is already covered by known facts. Output ONLY JSON: {\"covered\": boolean, \"evidence\": string}. covered=true ONLY if the facts genuinely contain material about the topic; evidence = the fact text that covers it, copied exactly. When unsure, covered=false.\nExample: TOPIC \"The sound (genre / reference artists / energy)\" with a fact \"loves TLC and SWV, classic hits at the reception\" → {\"covered\": true, \"evidence\": \"loves TLC and SWV, classic hits at the reception\"} — named artists or songs the subject loves DO cover the sound topic."),
            Msg("user", "TOPIC: ${CATEGORIES[gapKey]?.label}\n\nKNOWN FACTS:\n${state.knownDigest(120)}"),
        ), temperature = 0.1) ?: return false
        if (parsed.optBoolean("covered") && parsed.optString("evidence").isNotBlank()) {
            // The heal must clear the same plausibility floor as extraction — no junk coverage.
            if (!StoryState.plausibleCategory(gapKey, parsed.optString("evidence"))) return false
            state.addFactoid(gapKey, parsed.optString("evidence").trim(), "", 3.0, listOf("recategorized"))
            return true
        }
        return false
    }

    suspend fun pickTarget(llm: LlmBridge, state: StoryState): Target {
        StoryState.syncHeal(state)
        val wound = state.factoids.firstOrNull { "wound" in it.flags }
        if (wound != null && !state.woundConsentAsked) {
            state.woundConsentAsked = true
            return Target.Consent(wound)
        }
        // A song needs the name: confirm the transcript's best candidate (confirmation can
        // never be a re-ask) — or ask plainly if there is none.
        if (state.name == null && !state.nameAsked && state.turn >= 1 && "identity" !in state.gaps()) {
            state.nameAsked = true
            if (state.modeNameAsk != null) {
                val phrase = StoryState.nameCandidatePhrase(state)
                if (phrase != null) { state.name = phrase; return Target.NameConfirm(phrase) }
                return Target.ModeName
            }
            val candidate = StoryState.nameCandidate(state)
            if (candidate != null) { state.name = candidate; return Target.NameConfirm(candidate) }
            return Target.Name
        }
        val g = state.gaps()
        val heat = state.heatFrom(state.turn)
        val hot = heat.firstOrNull()
        if (hot != null && hot.weight >= 4 && (g.contains("scene") || g.contains("emotion"))) {
            return Target.Heat(hot, if (g.contains("scene")) "scene" else "emotion")
        }
        for (cat in g) {
            if (gapAlreadyCovered(llm, state, cat)) continue
            // Identity decomposes: name flow or fixed relationship ask — never a compound generic.
            if (cat == "identity") {
                if (state.name == null && !state.nameAsked) {
                    state.nameAsked = true
                    val candidate = StoryState.nameCandidate(state)
                    if (candidate != null) { state.name = candidate; return Target.NameConfirm(candidate) }
                    return Target.Name
                }
                if (state.name != null) return Target.Relationship
                continue
            }
            return Target.Gap(cat)
        }
        return Target.Done
    }

    private fun catLabel(state: StoryState, cat: String) = state.modeLabels[cat] ?: CATEGORIES[cat]?.label ?: cat

    private fun buildContext(state: StoryState, lastAnswer: String, target: Target): String {
        val heat = state.heatFrom(state.turn)
        val targetLine = when (target) {
            is Target.Consent -> "TARGET: something painful surfaced — \"${target.wound.text}\". Name it plainly and gently, and ask whether the song should hold it or steer around it. That is the entire question."
            is Target.Heat -> "TARGET: go deeper into this thread from their last answer: \"${target.thread.text}\". Ask for the ${if (target.target == "scene") "specific moment — what happened" else "feeling inside it"}."
            is Target.Gap -> "TARGET: ${target.target} — ${catLabel(state, target.target)}. Your question must pursue exactly this and nothing else. Anchor it in a detail from KNOWN when natural."
            else -> ""
        }
        return listOf(
            "KNOWN (never ask about any of this):",
            state.knownDigest(120).ifEmpty { "- nothing yet" },
            "",
            targetLine,
            "",
            "HEAT (from the last answer):",
            heat.joinToString("\n") { "- [heat ${it.weight}${if ("wound" in it.flags) ", wound" else ""}] ${it.text}" }.ifEmpty { "- none" },
            "",
            "ASKED:",
            state.asked.mapIndexed { i, q -> "${i + 1}. $q" }.joinToString("\n").ifEmpty { "- none" },
            "",
            "LAST ANSWER:",
            lastAnswer.take(2000),
        ).joinToString("\n")
    }

    data class Next(val question: String?, val reflection: String?, val target: String?, val source: String, val done: Boolean = false)

    suspend fun next(llm: LlmBridge, systemPrompt: String, state: StoryState, lastAnswer: String): Next {
        val target = pickTarget(llm, state)
        if (target is Target.Done) return Next(null, null, null, "covered", done = true)
        if (target is Target.Name) return Next("What do you actually call them, day to day — any nickname the song should know about?", null, "identity", "fixed")
        if (target is Target.NameConfirm) return Next("I want the name sung exactly right — the song is about ${target.candidate}, spelled just like that?", null, "identity", "fixed")
        if (target is Target.ModeName) return Next(state.modeNameAsk!!, null, "identity", "fixed")
        if (target is Target.Relationship) return Next("Who is ${state.name} to you — how do you two know each other?", null, "identity", "fixed")
        // Consent is too load-bearing for model wording — the code-authored form has never failed an audit.
        if (target is Target.Consent) {
            val src = target.wound.verbatim.ifBlank { target.wound.text }.trim('"', '\'', ' ')
            val w = if (src.length > 80) src.take(77) + "…" else src
            return Next("You touched on something tender — \"$w\". Would you like the song to hold that part of the story, or steer around it?", null, "consent", "fixed")
        }
        val ctx = buildContext(state, lastAnswer, target)
        val kind = when (target) { is Target.Consent -> "consent"; is Target.Heat -> "heat"; is Target.Gap -> "gap"; else -> null }
        var messages = mutableListOf(Msg("system", systemPrompt), Msg("user", ctx))
        repeat(2) {
            val parsed = llm.chatJson(messages, temperature = 0.5)
            val q = parsed?.optString("question")
            if (parsed != null && !q.isNullOrBlank()) {
                val problems = validate(q, state, kind, lastAnswer)
                if (problems.isEmpty()) {
                    var refl = parsed.optString("reflection").takeIf { it.isNotBlank() && it != "null" }
                    if (refl != null && !reflectionGrounded(refl, lastAnswer)) refl = null
                    val tgt = when (target) { is Target.Gap -> target.target; is Target.Heat -> target.target; is Target.Consent -> "consent"; else -> null }
                    return Next(q.trim(), refl, tgt, "model")
                }
                messages = (messages + Msg("assistant", parsed.toString()) +
                    Msg("user", "Rejected: ${problems.joinToString("; ")}. Produce a corrected JSON object following every rule.")).toMutableList()
            }
        }
        val cat = when (target) { is Target.Gap -> target.target; is Target.Heat -> target.target; else -> "specific" }
        fallbackFor(state, cat)?.let { return Next(it, null, cat, "fallback") }
        // Cross-gap fallbacks must clear the heal check, or they re-ask hidden coverage.
        for (other in state.gaps()) {
            if (other == cat || other == "identity") continue
            if (gapAlreadyCovered(llm, state, other)) continue
            fallbackFor(state, other)?.let { return Next(it, null, other, "fallback") }
        }
        return Next(null, null, null, "exhausted", done = true)
    }

    // Anchored, dedupe-aware fallbacks: anchors rotate newest-first; near-repeats are skipped.
    private val ANCHOR_ASKS: Map<String, (String) -> String> = mapOf(
        "specific" to { a -> "Besides $a — what's one more thing almost nobody else would know?" },
        "scene" to { a -> "Besides $a — tell me about one more moment that stays with you?" },
        "emotion" to { a -> "When you think about $a — what's the feeling underneath it?" },
    )

    private fun notAsked(state: StoryState, q: String) = state.asked.all { jaccard(it, q) < 0.45 }

    // Anchor dedupe compares the ANCHOR, not the whole question — a shared template
    // must not block rotation onto new anchors.
    private fun anchorUnused(state: StoryState, anchorText: String): Boolean {
        val a = StoryState.norm(anchorText).take(40)
        return a.isNotEmpty() && state.asked.all { !StoryState.norm(it).contains(a) }
    }

    /** Single most distinctive clause of a factoid — identity clauses and bare names dropped. */
    private fun anchorClause(t: String): String {
        val base = t.trimEnd('.', '!', '?')
        val clauses = base.split(Regex(",|;| and ", RegexOption.IGNORE_CASE)).map { it.trim() }.filter { it.split(Regex("\\s+")).size >= 3 }
        val concrete = clauses.filter {
            !Regex("^(my|his|her|their) (wife|husband|dad|father|mom|mother|son|daughter|friend|best friend)\\b", RegexOption.IGNORE_CASE).containsMatchIn(it) &&
                !Regex("^[A-Z][a-z]+$").matches(it)
        }
        val pick = (concrete.ifEmpty { clauses }).maxByOrNull { it.length } ?: base
        return if (pick.length > 60) pick.take(57) + "…" else pick
    }

    fun fallbackFor(state: StoryState, cat: String): String? {
        fun short(t: String) = anchorClause(t)
        ANCHOR_ASKS[cat]?.let { ask ->
            // At most 2 anchored fallbacks per story-material category — then move on.
            if ((state.fallbackCounts[cat] ?: 0) >= 2) return null
            val anchorCats = if (cat == "scene") listOf("scene", "specific") else listOf(cat, "specific").distinct()
            // Names and spellings are not moments — never anchor on them.
            val anchors = state.factoids
                .filter { it.category in anchorCats && it.text.split(Regex("\\s+")).size in 3..14 }
                .filter { "name" !in it.flags && "spelling" !in it.flags && !Regex("\\bspelled\\b|\\b(?:[A-Za-z]-){2,}[A-Za-z]\\b", RegexOption.IGNORE_CASE).containsMatchIn(it.text) }
                .filter { !(cat == "emotion" && it.turn == state.turn) }
                .sortedWith(compareByDescending<Factoid> { it.turn }.thenByDescending { it.weight })
            for (a in anchors) {
                if (!anchorUnused(state, short(a.text))) continue
                state.fallbackCounts[cat] = (state.fallbackCounts[cat] ?: 0) + 1
                return ask(short(a.text))
            }
            // Anchors exist but are spent → never fall to the generic form; move to another gap.
            if (anchors.isNotEmpty()) return null
            val generic = FALLBACKS[cat]
            if (generic != null && notAsked(state, generic) && state.byCategory(cat).isEmpty()) {
                state.fallbackCounts[cat] = (state.fallbackCounts[cat] ?: 0) + 1
                return generic
            }
            return null
        }
        val generic = FALLBACKS[cat]
        if (generic != null && notAsked(state, generic)) return generic
        return null
    }
}
