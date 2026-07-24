package com.sensorysymphony.storymode

import android.content.Context
import org.json.JSONObject
import java.io.File

/** The interview loop as a step machine the UI drives. Autosaves after every answer — nothing gets lost. */
class InterviewSession(
    private val context: Context,
    private val llm: LlmBridge,
) {
    val extractPrompt = asset("extract.txt")
    val questionPrompt = asset("question.txt")
    val opening = asset("opening.txt").trim()
    val handoffTemplate = asset("handoff.md")

    var state = StoryState()
        private set
    var currentQuestion: String = opening
        private set
    var currentReflection: String? = null
        private set

    private fun asset(name: String) = context.assets.open(name).bufferedReader().readText()
    private val saveFile get() = File(context.filesDir, "session.json")

    sealed class Step {
        data class Ask(val reflection: String?, val question: String) : Step()
        data class Done(val finish: String, val dossier: String, val handoff: String) : Step()
    }

    fun resumeIfPresent(): Boolean {
        if (!saveFile.exists()) return false
        return try {
            val o = JSONObject(saveFile.readText())
            state = StoryState.fromJson(o.getJSONObject("state"))
            currentQuestion = o.optString("currentQuestion", opening)
            currentReflection = o.optString("currentReflection").takeIf { it.isNotBlank() && it != "null" }
            !state.done
        } catch (_: Exception) { false }
    }

    private fun save() {
        val o = JSONObject()
            .put("state", state.toJson())
            .put("currentQuestion", currentQuestion)
            .put("currentReflection", currentReflection ?: JSONObject.NULL)
        saveFile.writeText(o.toString())
    }

    fun reset() {
        state = StoryState()
        currentQuestion = opening
        currentReflection = null
        if (saveFile.exists()) saveFile.delete()
    }

    suspend fun submit(answer: String, onProgress: (String) -> Unit = {}): Step {
        state.turn++
        state.asked.add(currentQuestion)
        state.transcript.add(TurnRec(currentQuestion, answer, state.turn, System.currentTimeMillis()))
        save() // the answer is on disk before anything else happens

        onProgress("reading what you wrote…")
        val extracted = Extract.fromAnswer(llm, extractPrompt, currentQuestion, answer) { i, n ->
            onProgress("reading what you wrote… ($i/$n)")
        }
        for (f in extracted) {
            val rec = state.addFactoid(f.category, f.text, f.verbatim, f.weight, f.flags)
            if (rec != null && "name" in rec.flags && state.name == null) {
                val cand = rec.verbatim.ifBlank { rec.text.removePrefix("name:").trim() }.trim()
                if (cand.isNotEmpty() && cand.split(Regex("\\s+")).size <= 3 && cand.length <= 30) state.name = cand
            }
        }
        save()

        val (stop, _) = state.readiness()
        if (stop) return finish()

        onProgress("thinking about what matters…")
        val nq = Question.next(llm, questionPrompt, state, answer)
        if (nq.done) return finish()

        currentQuestion = nq.question!!
        currentReflection = nq.reflection
        save()
        return Step.Ask(nq.reflection, nq.question)
    }

    private fun finish(): Step.Done {
        state.done = true
        state.thin = state.gaps()
        save()
        val done = Step.Done(
            finish = Compile.renderFinish(state),
            dossier = Compile.renderDossier(state),
            handoff = Compile.renderHandoff(state, handoffTemplate),
        )
        // Keep the finished session on disk for the operator (export happens from the finish screen).
        File(context.filesDir, "finished-${System.currentTimeMillis()}.json").writeText(state.toJson().toString())
        return done
    }
}
