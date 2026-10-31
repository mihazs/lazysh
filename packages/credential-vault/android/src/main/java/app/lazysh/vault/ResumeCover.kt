package app.lazysh.vault

import android.app.Activity
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.Gravity
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.webkit.WebView
import android.widget.ImageView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.plugin.Channel
import app.tauri.plugin.JSObject

internal class ResumeCover(private var activity: Activity) {
    private val gate = ResumeGate()
    private var overlay: View? = null
    private var webview: WebView? = null
    private var events: Channel? = null
    private var logo: ImageView? = null
    private var unlock: Button? = null
    private var title: TextView? = null
    private var status: TextView? = null
    private var failed = false
    val ready get() = overlay != null && webview != null
    fun load(view: WebView, owner: Activity = activity) {
        if (webview === view && activity === owner) { render(); return }
        val replacement = webview != null
        val resumed = (owner as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
        if (replacement) {
            gate.rebind(resumed)
            webview?.visibility = View.INVISIBLE
            (overlay?.parent as? ViewGroup)?.removeView(overlay)
            overlay = null; logo = null; title = null; status = null; unlock = null; failed = false
        }
        activity = owner
        webview = view
        val root = activity.window.decorView as? ViewGroup ?: return
        val panel = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
            setBackgroundColor(Color.rgb(11, 23, 40)); isFocusable = true; isFocusableInTouchMode = true
            logo = ImageView(activity).apply {
                setImageDrawable(activity.applicationInfo.loadIcon(activity.packageManager))
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }.also { addView(it, LinearLayout.LayoutParams((128 * resources.displayMetrics.density).toInt(), (128 * resources.displayMetrics.density).toInt())) }
            title = TextView(activity).apply { textSize = 24f; setTextColor(Color.WHITE) }.also { addView(it) }
            status = TextView(activity).apply { setTextColor(Color.WHITE); setPadding(24, 24, 24, 24) }.also { addView(it) }
            unlock = Button(activity).apply {
                isEnabled = events != null
                setOnClickListener { if (gate.covered) send("unlock") }
            }.also { addView(it) }
        }
        overlay = panel
        root.addView(panel, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        render()
        if (replacement) send("rebind")
        if (events != null) send("ready")
        if (replacement && resumed) send("foreground")
    }
    private fun send(kind: String) {
        val value = JSObject(); value.put("kind", kind); value.put("nativeGeneration", gate.nativeGeneration)
        events?.send(value)
    }
    fun register(channel: Channel) { events = channel; unlock?.isEnabled = true; if (ready) send("ready") }
    fun apply(covered: Boolean, enabled: Boolean, generation: Long, nativeGeneration: Long): Boolean {
        if (!ready || !gate.apply(covered, enabled, generation, nativeGeneration)) return false
        render(); return true
    }
    fun relabel() = relabel(NativeUiLocale.presentationContext(activity))
    fun relabel(strings: Context) {
        title?.text = strings.getString(R.string.lazysh_resume_title)
        status?.text = strings.getString(if (failed) R.string.lazysh_resume_failure else R.string.lazysh_resume_detail)
        unlock?.text = strings.getString(R.string.lazysh_resume_unlock)
        overlay?.contentDescription = strings.getString(if (gate.awaitingPolicy && !failed) R.string.lazysh_starting else R.string.lazysh_resume_privacy)
    }
    fun failure() { if (gate.covered) { failed = true; render() } }
    fun pause() { gate.pause(); render() }
    fun background() { gate.background(); render(); send("background") }
    fun resume() { gate.resume(); render(); if (ready) send("foreground") }
    private fun render() {
        relabel()
        val starting = gate.awaitingPolicy && !failed
        logo?.visibility = if (starting) View.VISIBLE else View.GONE
        for (view in listOf(title, status, unlock)) view?.visibility = if (starting) View.GONE else View.VISIBLE
        val covered = gate.covered
        if (gate.protectsContent) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        webview?.apply {
            visibility = if (covered) View.INVISIBLE else View.VISIBLE
            importantForAccessibility = if (covered) View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS else View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
            isEnabled = !covered
            if (covered) (activity.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(windowToken, 0)
        }
        overlay?.apply { visibility = if (covered) View.VISIBLE else View.GONE; if (covered) { bringToFront(); requestFocus() } }
    }
}
