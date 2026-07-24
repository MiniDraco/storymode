package com.sensorysymphony.storymode

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.io.File

class MainActivity : AppCompatActivity() {

    private lateinit var session: InterviewSession
    private lateinit var reflectionView: TextView
    private lateinit var questionView: TextView
    private lateinit var answerInput: EditText
    private lateinit var sendBtn: Button
    private lateinit var statusView: TextView
    private lateinit var spinner: ProgressBar
    private lateinit var finishGroup: View
    private lateinit var finishView: TextView
    private var handoffText: String? = null
    private var dossierText: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        reflectionView = findViewById(R.id.reflection)
        questionView = findViewById(R.id.question)
        answerInput = findViewById(R.id.answer)
        sendBtn = findViewById(R.id.send)
        statusView = findViewById(R.id.status)
        spinner = findViewById(R.id.spinner)
        finishGroup = findViewById(R.id.finishGroup)
        finishView = findViewById(R.id.finishText)

        session = InterviewSession(this, buildBridge())

        val resumed = session.resumeIfPresent()
        showQuestion(session.currentReflection, session.currentQuestion)
        if (resumed) toast("Welcome back — picking up right where you left off.")

        sendBtn.setOnClickListener { submit() }
        findViewById<Button>(R.id.copyHandoff).setOnClickListener {
            handoffText?.let { copy("handoff", it); toast("Copied — paste into Gemini.") }
        }
        findViewById<Button>(R.id.shareDossier).setOnClickListener {
            dossierText?.let { share(it) }
        }
        findViewById<Button>(R.id.newInterview).setOnClickListener {
            session.reset()
            finishGroup.visibility = View.GONE
            findViewById<View>(R.id.interviewGroup).visibility = View.VISIBLE
            showQuestion(null, session.opening)
        }
    }

    /** On-device model if a model file is present; otherwise LAN Ollama (dev mode). */
    private fun buildBridge(): LlmBridge {
        val modelFile = File(getExternalFilesDir(null), "model.task")
            .takeIf { it.exists() } ?: File(getExternalFilesDir(null), "model.litertlm").takeIf { it.exists() }
        return if (modelFile != null) {
            try { MediaPipeBridge(this, modelFile) }
            catch (e: Exception) { toast("Model failed to load (${e.message}) — using LAN bridge"); lanBridge() }
        } else lanBridge()
    }

    private fun lanBridge(): LlmBridge {
        val prefs = getSharedPreferences("storymode", Context.MODE_PRIVATE)
        val host = prefs.getString("ollama_host", "http://192.168.1.100:11434")!!
        val model = prefs.getString("ollama_model", "qwen2.5:3b")!!
        return OllamaBridge(host, model)
    }

    private fun submit() {
        val answer = answerInput.text.toString().trim()
        if (answer.isEmpty()) { toast("Take your time — anything that comes to mind."); return }
        setBusy(true)
        lifecycleScope.launch {
            try {
                val step = session.submit(answer) { msg -> runOnUiThread { statusView.text = msg } }
                when (step) {
                    is InterviewSession.Step.Ask -> {
                        answerInput.setText("")
                        showQuestion(step.reflection, step.question)
                    }
                    is InterviewSession.Step.Done -> showFinish(step)
                }
            } catch (e: Exception) {
                toast("Hit a snag (${e.message}). Your words are saved — try again.")
            } finally {
                setBusy(false)
            }
        }
    }

    private fun showQuestion(reflection: String?, question: String) {
        reflectionView.text = reflection ?: ""
        reflectionView.visibility = if (reflection.isNullOrBlank()) View.GONE else View.VISIBLE
        questionView.text = question
        statusView.text = ""
    }

    private fun showFinish(done: InterviewSession.Step.Done) {
        handoffText = done.handoff
        dossierText = done.dossier + "\n\n---\n\n## HANDOFF PROMPT\n\n" + done.handoff
        findViewById<View>(R.id.interviewGroup).visibility = View.GONE
        finishGroup.visibility = View.VISIBLE
        finishView.text = done.finish
    }

    private fun setBusy(b: Boolean) {
        sendBtn.isEnabled = !b
        answerInput.isEnabled = !b
        spinner.visibility = if (b) View.VISIBLE else View.GONE
        if (!b) statusView.text = ""
    }

    private fun copy(label: String, text: String) {
        val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText(label, text))
    }

    private fun share(text: String) {
        startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
        }, "Send story"))
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
