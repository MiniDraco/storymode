package com.sensorysymphony.storymode

/** Mirrors engine/question.js — code picks the target; the model only words the question. */
object Question {

    private val YESNO = Regex("^(do|does|did|is|are|was|were|have|has|had|can|could|would|will|should)\\b", RegexOption.IGNORE_CASE)
    private val META = Regex("\\b(comes? to (your )?mind|first (thing|came)|describe them|thought about|tell me about them)\\b", RegexOption.IGNORE_CASE)
    private val GENERIC = Regex("\\b(stood out|stands? out|notice(d)? most|remember most|makes? (him|her|them) (so )?special|most about (him|her|them))\\b", RegexOption.IGNORE_CASE)

    val FALLBACKS = mapOf(
        "identity" to "Who is this song for — what's their name, and who are they to you?",
        "specific" to "What's one thing about them that almost nobody else does — a habit, a saying, a ritual?",
        "scene" to "Tell me about one specific time with them that you still think about — what happened?",
        "emotion" to "When you picture them right now, what's the feeling that comes up first?",
        "job" to "Where does this song get played — what's the occasion, and who's in the room?",
        "sound" to "What should this sound like — what music do they love, or what artist feels right?",
        "boundary" to "What should this song stay away from — anything that shouldn't be mentioned?",
    )

    fun validate(q: String?, state: StoryState, kind: String? = null): List<String> {
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
        for (prev in state.asked) if (jaccard(prev, q) >= 0.45) problems.add("near-duplicate of an asked question")
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
        object Done : Target()
    }

    private suspend fun gapAlreadyCovered(llm: LlmBridge, state: StoryState, gapKey: String): Boolean {
        // Deterministic pre-pass: a known factoid plainly matching the gap's pattern gets
        // recategorized directly — no model roulette.
        if (gapKey == "sound" || gapKey == "job") {
            val hit = state.factoids.firstOrNull {
                it.category != gapKey && it.category in listOf("specific", "scene", "emotion") &&
                    StoryState.plausibleCategory(gapKey, it.text)
            }
            if (hit != null) {
                state.addFactoid(gapKey, hit.text, hit.verbatim, hit.weight, listOf("recategorized"))
                return true
            }
        }
        val parsed = llm.chatJson(listOf(
            Msg("system", "You check whether a topic is already covered by known facts. Output ONLY JSON: {\"covered\": boolean, \"evidence\": string}. covered=true ONLY if the facts genuinely contain material about the topic; evidence = the fact text that covers it, copied exactly. When unsure, covered=false."),
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
        val wound = state.factoids.firstOrNull { "wound" in it.flags }
        if (wound != null && !state.woundConsentAsked) {
            state.woundConsentAsked = true
            return Target.Consent(wound)
        }
        val g = state.gaps()
        val heat = state.heatFrom(state.turn)
        val hot = heat.firstOrNull()
        if (hot != null && hot.weight >= 4 && (g.contains("scene") || g.contains("emotion"))) {
            return Target.Heat(hot, if (g.contains("scene")) "scene" else "emotion")
        }
        for (cat in g) {
            if (gapAlreadyCovered(llm, state, cat)) continue
            return Target.Gap(cat)
        }
        return Target.Done
    }

    private fun buildContext(state: StoryState, lastAnswer: String, target: Target): String {
        val heat = state.heatFrom(state.turn)
        val targetLine = when (target) {
            is Target.Consent -> "TARGET: something painful surfaced — \"${target.wound.text}\". Name it plainly and gently, and ask whether the song should hold it or steer around it. That is the entire question."
            is Target.Heat -> "TARGET: go deeper into this thread from their last answer: \"${target.thread.text}\". Ask for the ${if (target.target == "scene") "specific moment — what happened" else "feeling inside it"}."
            is Target.Gap -> "TARGET: ${target.target} — ${CATEGORIES[target.target]?.label}. Your question must pursue exactly this and nothing else. Anchor it in a detail from KNOWN when natural."
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
        val ctx = buildContext(state, lastAnswer, target)
        val kind = when (target) { is Target.Consent -> "consent"; is Target.Heat -> "heat"; is Target.Gap -> "gap"; else -> null }
        var messages = mutableListOf(Msg("system", systemPrompt), Msg("user", ctx))
        repeat(2) {
            val parsed = llm.chatJson(messages, temperature = 0.5)
            val q = parsed?.optString("question")
            if (parsed != null && !q.isNullOrBlank()) {
                val problems = validate(q, state, kind)
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
        if (target is Target.Consent) {
            val w = target.wound.text.let { if (it.length > 80) it.take(77) + "…" else it }
            return Next("You touched on something tender — \"$w\". Would you like the song to hold that part of the story, or steer around it?", null, "consent", "fallback")
        }
        val cat = when (target) { is Target.Gap -> target.target; is Target.Heat -> target.target; else -> "specific" }
        fallbackFor(state, cat)?.let { return Next(it, null, cat, "fallback") }
        for (other in state.gaps()) {
            if (other == cat) continue
            fallbackFor(state, other)?.let { return Next(it, null, other, "fallback") }
        }
        return Next(null, null, null, "exhausted", done = true)
    }

    // Anchored, dedupe-aware fallbacks: anchors rotate newest-first; near-repeats are skipped.
    private val ANCHOR_ASKS: Map<String, (String) -> String> = mapOf(
        "specific" to { a -> "Besides $a — what's one more thing about them almost nobody else does?" },
        "scene" to { a -> "Besides $a — tell me about one more moment with them that stays with you?" },
        "emotion" to { a -> "When you think about $a — what's the feeling underneath it?" },
    )

    private fun notAsked(state: StoryState, q: String) = state.asked.all { jaccard(it, q) < 0.45 }

    fun fallbackFor(state: StoryState, cat: String): String? {
        fun short(t: String): String {
            val s = t.trimEnd('.', '!', '?')
            return if (s.length > 60) s.take(57) + "…" else s
        }
        ANCHOR_ASKS[cat]?.let { ask ->
            val anchorCats = if (cat == "scene") listOf("scene", "specific") else listOf(cat, "specific").distinct()
            val anchors = state.factoids
                .filter { it.category in anchorCats && it.text.split(Regex("\\s+")).size <= 14 }
                .sortedWith(compareByDescending<Factoid> { it.turn }.thenByDescending { it.weight })
            for (a in anchors) {
                val q = ask(short(a.text))
                if (notAsked(state, q)) return q
            }
        }
        val generic = FALLBACKS[cat]
        if (generic != null && notAsked(state, generic)) return generic
        return null
    }
}
