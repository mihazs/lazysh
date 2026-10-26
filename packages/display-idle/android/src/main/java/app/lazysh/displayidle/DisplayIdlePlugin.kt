package app.lazysh.displayidle

import android.app.Activity
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import java.lang.ref.WeakReference

@TauriPlugin
class DisplayIdlePlugin(private val owner: Activity) : Plugin(owner) {
    companion object {
        private var current = WeakReference<DisplayIdlePlugin>(null)
        @JvmStatic fun onWebViewCreated(activity: Activity, webView: WebView) {
            current.get()?.let { plugin -> plugin.owner.runOnUiThread {
                plugin.invalidateLifecycle()
                if (activity === plugin.owner) plugin.load(webView)
                else plugin.handle?.let { handle ->
                    plugin.detach()
                    val replacement = DisplayIdlePlugin(activity)
                    PluginManager.load(webView, handle.name, replacement, handle.config)
                    replacement.handle?.loaded = true
                }
            } }
        }
        // The host calls this before document navigation/reload; no WebViewClient is replaced.
        @JvmStatic fun onDocumentLoading(activity: Activity) {
            current.get()?.let { if (it.owner === activity) activity.runOnUiThread { it.invalidateLifecycle() } }
        }
    }
    private var webview: WebView? = null
    private var lifecycleError: String? = null
    private val state = DisplayIdleState({ enabled ->
        if (enabled) owner.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else owner.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }, { owner.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0 })
    private val focus = ViewTreeObserver.OnWindowFocusChangeListener { focused -> if (!focused) invalidateLifecycle() }
    private val layout = ViewTreeObserver.OnGlobalLayoutListener { if (!ready()) invalidateLifecycle() }
    private val attach = object : View.OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) { invalidateLifecycle() }
        override fun onViewDetachedFromWindow(view: View) { invalidateLifecycle() }
    }
    override fun load(webView: WebView) = owner.runOnUiThread {
        invalidateLifecycle()
        detach()
        current = WeakReference(this); webview = webView
        webView.addOnAttachStateChangeListener(attach)
        webView.viewTreeObserver.addOnWindowFocusChangeListener(focus)
        webView.viewTreeObserver.addOnGlobalLayoutListener(layout)
    }
    private fun detach() {
        webview?.let {
            it.removeOnAttachStateChangeListener(attach)
            if (it.viewTreeObserver.isAlive) {
                it.viewTreeObserver.removeOnWindowFocusChangeListener(focus)
                it.viewTreeObserver.removeOnGlobalLayoutListener(layout)
            }
        }
        webview = null
    }
    private fun ready(): Boolean = !owner.isFinishing && !owner.isDestroyed &&
        (owner as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true &&
        webview?.let { it.isAttachedToWindow && it.isShown && it.hasWindowFocus() } == true
    private fun invalidateLifecycle() {
        try { state.invalidate(); lifecycleError = null }
        catch (error: Exception) { lifecycleError = error.message ?: "Native display release failed"; Log.e("DisplayIdle", lifecycleError, error) }
    }
    private fun result(ticket: Long): JSObject {
        check(lifecycleError == null) { lifecycleError ?: "Display lifecycle error" }
        val available = ready()
        return JSObject().apply {
            put("available", available); put("reason", if (available) "Native display owner is ready" else "Native display owner is not foreground and focused")
            put("active", state.active); put("epoch", state.epoch); put("ticket", ticket)
        }
    }
    private fun command(invoke: Invoke, action: () -> JSObject?) = owner.runOnUiThread {
        try { val value = action(); if (value == null) invoke.resolve() else invoke.resolve(value) }
        catch (error: Exception) { invoke.reject(error.message ?: "Native display operation failed") }
    }
    private fun ticket(invoke: Invoke): Pair<String, Long> {
        val args = invoke.getArgs()
        val epoch = args.get("epoch"); val number = args.get("ticket")
        require(epoch is String && epoch.length == 36 && java.util.UUID.fromString(epoch).toString().equals(epoch, ignoreCase = true) && number is Number) { "Invalid display ticket" }
        val value = number.toDouble()
        require(value.isFinite() && value >= 1 && value <= DisplayIdleState.MAX_TICKET.toDouble() && value % 1.0 == 0.0) { "Invalid display ticket number" }
        return epoch to value.toLong()
    }
    @Command fun status(invoke: Invoke) = command(invoke) { result(state.issue()) }
    @Command fun acquire(invoke: Invoke) = command(invoke) {
        val (epoch, ticket) = ticket(invoke)
        check(lifecycleError == null) { lifecycleError ?: "Display lifecycle error" }
        state.acquire(epoch, ticket, ready()); result(ticket)
    }
    @Command fun release(invoke: Invoke) = command(invoke) {
        val (epoch, ticket) = ticket(invoke); state.release(epoch, ticket); result(ticket)
    }
    @Command fun invalidate(invoke: Invoke) = command(invoke) { state.invalidate(); lifecycleError = null; null }
    override fun onPause(activity: AppCompatActivity) { if (activity === owner) owner.runOnUiThread { invalidateLifecycle() } }
    override fun onStop(activity: AppCompatActivity) { if (activity === owner) owner.runOnUiThread { invalidateLifecycle() } }
    override fun onDestroy(activity: AppCompatActivity) { if (activity === owner) owner.runOnUiThread { invalidateLifecycle(); detach() } }
}
