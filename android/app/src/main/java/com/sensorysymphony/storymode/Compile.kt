package com.sensorysymphony.storymode

/** Mirrors engine/compile.js — deterministic assembly. No model calls. */
object Compile {

    private fun section(items: List<String>, empty: String) =
        if (items.isNotEmpty()) items.joinToString("\n") { "- $it" } else "- $empty"

    fun renderHandoff(state: StoryState, template: String): String {
        val sorted = state.sortedFactoids()
        val ident = state.byCategory("identity").map { it.text }
        val job = state.byCategory("job").map { it.text }
        val sound = state.byCategory("sound").map { it.text }
        val sacred = state.byCategory("sacred").map { "\"${it.verbatim.ifBlank { it.text }}\"" }
        val bounds = state.byCategory("boundary").map { it.text }
        val phonetic = state.factoids.filter { "phonetic" in it.flags }.map { it.text }

        val material = sorted.filter { it.category in listOf("specific", "scene", "emotion") }
            .mapIndexed { i, f -> "${i + 1}. [${f.category}, heat ${f.weight}] ${f.text}${if ("wound" in f.flags) "  (a wound — customer consented; hold it with care)" else ""}" }
            .joinToString("\n")

        val thin = state.coverage().entries
            .filter { it.value.second > 0 && it.value.first < it.value.second }
            .map { "${CATEGORIES[it.key]?.label}: THIN — the customer gave little here. Do not invent depth to fill it." }

        val transcript = state.transcript.joinToString("\n\n") { "Q${it.turn}: ${it.q}\nA${it.turn}: ${it.a}" }

        return template
            .replace("{{IDENTITY}}", section(ident + phonetic, "not fully established — see transcript"))
            .replace("{{JOB}}", section(job, "not stated — a warm, giftable tone is safe"))
            .replace("{{FACTOIDS}}", material.ifEmpty { "- (thin — see transcript)" })
            .replace("{{SACRED}}", section(sacred, "none given"))
            .replace("{{BOUNDARIES}}", section(bounds, "none given"))
            .replace("{{SOUND}}", section(sound, "not stated — choose to fit the emotional center"))
            .replace("{{THIN}}", if (thin.isNotEmpty()) thin.joinToString("\n") { "- $it" } else "- none; all core slots earned")
            .replace("{{TRANSCRIPT}}", transcript)
    }

    fun renderDossier(state: StoryState): String {
        val lines = mutableListOf<String>()
        lines.add("# DOSSIER — ${state.name ?: "unnamed subject"}")
        lines.add("")
        lines.add("## Coverage")
        for ((k, v) in state.coverage()) {
            val (have, need, ok) = v
            val mark = if (need == 0) (if (have > 0) "✓" else "—") else if (ok) "✓" else "THIN"
            lines.add("- $mark ${CATEGORIES[k]?.label} ($have${if (need > 0) "/$need" else ""})")
        }
        lines.add("")
        lines.add("## Factoids (sorted, each with its source)")
        for (f in state.sortedFactoids()) {
            lines.add("- [${f.category} | heat ${f.weight} | turn ${f.turn}${if (f.flags.isNotEmpty()) " | " + f.flags.joinToString(",") else ""}] ${f.text}")
            if (f.verbatim.isNotBlank() && f.verbatim != f.text) lines.add("  > \"${f.verbatim}\"")
        }
        lines.add("")
        lines.add("## Transcript (verbatim)")
        for (t in state.transcript) {
            lines.add("**Q${t.turn}:** ${t.q}")
            lines.add("**A${t.turn}:** ${t.a}")
            lines.add("")
        }
        return lines.joinToString("\n")
    }

    /** Screenshot-sized finish: the customer's own words mirrored back. Zero generation. */
    fun renderFinish(state: StoryState): String {
        val who = state.name?.takeIf { it.length <= 30 } ?: "them"
        val quotable = state.sortedFactoids()
            .filter { it.category in listOf("specific", "scene", "emotion", "sacred") }
            .mapNotNull { f ->
                listOf(f.verbatim, f.text).filter { it.isNotBlank() }.map { it.trim() }
                    .filter { it.split(Regex("\\s+")).size in 3..20 }
                    .minByOrNull { it.length }
            }
            .take(4)
        if (quotable.isEmpty()) return "Your story is in. Everything you told me about $who goes straight to the person writing their song."
        return buildString {
            append("Here's what I'm carrying to the songwriter — in your words:\n")
            quotable.forEach { append("“").append(it).append("”\n") }
            append("That's $who. Nobody else. Your story is in — the song is next.")
        }
    }
}
