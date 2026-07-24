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

    companion object {
        // Qwen2.5-1.5B q8, 4096-token KV — ungated, anonymously downloadable, one time.
        // Little sibling of the desktop model every interview gate was earned on.
        const val MODEL_URL = "https://huggingface.co/litert-community/Qwen2.5-1.5B-Instruct/resolve/main/Qwen2.5-1.5B-Instruct_multi-prefill-seq_q8_ekv4096.task"
        const val MODEL_MB = 1525
    }

    private var session: InterviewSession? = null
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

        sendBtn.setOnClickListener { submit() }
        findViewById<TextView>(R.id.kicker).setOnLongClickListener { showBridgeSettings(); true }
        findViewById<Button>(R.id.downloadModel).setOnClickListener { startModelDownload() }

        boot()
        findViewById<Button>(R.id.copyHandoff).setOnClickListener {
            handoffText?.let { copy("handoff", it); toast("Copied — paste into Gemini.") }
        }
        findViewById<Button>(R.id.shareDossier).setOnClickListener {
            dossierText?.let { share(it) }
        }
        findViewById<Button>(R.id.newInterview).setOnClickListener {
            val s = session ?: return@setOnClickListener
            s.reset()
            finishGroup.visibility = View.GONE
            findViewById<View>(R.id.interviewGroup).visibility = View.VISIBLE
            showQuestion(null, s.opening)
        }
    }

    private fun modelFile(): File? =
        File(getExternalFilesDir(null), "model.task").takeIf { it.exists() && it.length() > 100_000_000 }
            ?: File(getExternalFilesDir(null), "model.litertlm").takeIf { it.exists() && it.length() > 100_000_000 }

    /** Self-contained by default: on-device model, or the first-run download screen.
     *  The LAN bridge exists ONLY behind the hidden long-press dev setting. */
    private fun boot() {
        val mf = modelFile()
        if (mf != null) {
            try {
                startSession(MediaPipeBridge(this, mf))
                return
            } catch (e: Exception) {
                toast("Brain failed to load (${e.message}) — re-download it.")
                mf.delete()
            }
        }
        val prefs = getSharedPreferences("storymode", Context.MODE_PRIVATE)
        if (prefs.getBoolean("dev_lan", false)) { startSession(lanBridge()); return }
        showSetup()
    }

    private fun startSession(bridge: LlmBridge) {
        findViewById<View>(R.id.setupGroup).visibility = View.GONE
        findViewById<View>(R.id.interviewGroup).visibility = View.VISIBLE
        val s = InterviewSession(this, bridge)
        session = s
        val resumed = s.resumeIfPresent()
        showQuestion(s.currentReflection, s.currentQuestion)
        if (resumed) toast("Welcome back — picking up right where you left off.")
    }

    private fun showSetup() {
        findViewById<View>(R.id.interviewGroup).visibility = View.GONE
        finishGroup.visibility = View.GONE
        findViewById<View>(R.id.setupGroup).visibility = View.VISIBLE
    }

    private fun startModelDownload() {
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as android.app.DownloadManager
        val req = android.app.DownloadManager.Request(android.net.Uri.parse(MODEL_URL))
            .setTitle("Story Mode brain")
            .setDescription("One-time download — after this, everything stays on your phone.")
            .setDestinationInExternalFilesDir(this, null, "model.task")
            .setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE)
        val id = dm.enqueue(req)
        findViewById<Button>(R.id.downloadModel).isEnabled = false
        val status = findViewById<TextView>(R.id.setupStatus)
        lifecycleScope.launch {
            while (true) {
                kotlinx.coroutines.delay(1500)
                val c = dm.query(android.app.DownloadManager.Query().setFilterById(id))
                if (!c.moveToFirst()) { c.close(); break }
                val done = c.getLong(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val st = c.getInt(c.getColumnIndexOrThrow(android.app.DownloadManager.COLUMN_STATUS))
                c.close()
                when (st) {
                    android.app.DownloadManager.STATUS_SUCCESSFUL -> {
                        status.text = "Done. Waking the brain…"
                        boot(); break
                    }
                    android.app.DownloadManager.STATUS_FAILED -> {
                        status.text = "Download failed — check connection and try again."
                        findViewById<Button>(R.id.downloadModel).isEnabled = true; break
                    }
                    else -> status.text = "Downloading… ${done / 1_048_576} / $MODEL_MB MB"
                }
            }
        }
    }

    private fun lanBridge(): LlmBridge {
        val prefs = getSharedPreferences("storymode", Context.MODE_PRIVATE)
        val host = prefs.getString("ollama_host", "http://192.168.1.125:11434")!!
        val model = prefs.getString("ollama_model", "qwen2.5:3b")!!
        return OllamaBridge(host, model)
    }

    /** Hidden dev settings: long-press the kicker to point the LAN bridge somewhere else. */
    private fun showBridgeSettings() {
        val prefs = getSharedPreferences("storymode", Context.MODE_PRIVATE)
        val layout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(48, 24, 48, 0)
        }
        val hostInput = EditText(this).apply {
            hint = "http://192.168.1.125:11434"
            setText(prefs.getString("ollama_host", "http://192.168.1.125:11434"))
        }
        val modelInput = EditText(this).apply {
            hint = "qwen2.5:3b"
            setText(prefs.getString("ollama_model", "qwen2.5:3b"))
        }
        layout.addView(hostInput); layout.addView(modelInput)
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("LAN bridge (dev only)")
            .setView(layout)
            .setPositiveButton("Use LAN") { _, _ ->
                prefs.edit()
                    .putString("ollama_host", hostInput.text.toString().trim())
                    .putString("ollama_model", modelInput.text.toString().trim())
                    .putBoolean("dev_lan", true)
                    .apply()
                startSession(lanBridge())
                toast("Dev LAN bridge on.")
            }
            .setNeutralButton("On-device") { _, _ ->
                prefs.edit().putBoolean("dev_lan", false).apply()
                boot()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun submit() {
        val s = session ?: return
        val answer = answerInput.text.toString().trim()
        if (answer.isEmpty()) { toast("Take your time — anything that comes to mind."); return }
        setBusy(true)
        lifecycleScope.launch {
            try {
                val step = s.submit(answer) { msg -> runOnUiThread { statusView.text = msg } }
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
