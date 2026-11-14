package app.lazysh.client

import android.app.Activity
import android.view.Window
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin as MobilePlugin

/** The window's IME controller: it shows the keyboard for the focused web input even when that input already had focus, and hides it without blurring anything. */
internal object SoftKeyboard {
    fun set(window: Window, visible: Boolean) {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        if (visible) controller.show(WindowInsetsCompat.Type.ime()) else controller.hide(WindowInsetsCompat.Type.ime())
    }
    fun visible(window: Window): Boolean =
        ViewCompat.getRootWindowInsets(window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
}

/** Soft-keyboard commands for the Rust soft_keyboard module; renderer calls to this plugin are refused in Rust. */
@TauriPlugin
class SoftKeyboardPlugin(private val initialOwner: Activity) : MobilePlugin(initialOwner) {
    /** The activity in front: Tauri builds this plugin once, with the first activity, which a recreation destroys (#1462). */
    private val owner: Activity get() = currentActivity(initialOwner)
    // The reply is the keyboard as Android reports it right after the request; its animation settles later.
    private fun request(invoke: Invoke, visible: Boolean?) = owner.runOnUiThread {
        // A backgrounded or closing Activity has no window the keyboard could attach to.
        if (!owner.hasWindowFocus() || owner.isFinishing) { invoke.reject("soft_keyboard_unavailable"); return@runOnUiThread }
        try {
            if (visible != null) SoftKeyboard.set(owner.window, visible)
            invoke.resolve(JSObject().put("visible", SoftKeyboard.visible(owner.window)))
        } catch (_: Exception) { invoke.reject("soft_keyboard_unavailable") }
    }
    @Command fun show(invoke: Invoke) = request(invoke, true)
    @Command fun hide(invoke: Invoke) = request(invoke, false)
    @Command fun status(invoke: Invoke) = request(invoke, null)
}
