package app.lazysh.client

import android.app.Activity
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import androidx.core.view.inputmethod.EditorInfoCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin as MobilePlugin
import java.lang.ref.WeakReference

/**
 * Private keyboard mode. While the page reports the terminal's hidden editor focused with the setting on, the
 * WebView's editor setup asks the soft keyboard to act as a plain key source: text without suggestions, shown as a
 * visible password so keyboards stop composing, and with no personalised learning (incognito). The Chat composer and
 * every other field report inactive and keep the editor setup Chromium computed. The page cannot express these
 * flags itself: Chromium maps only autocomplete and autocorrect to EditorInfo, and only password inputs to a
 * password variation.
 */
internal object PrivateKeyboard {
    /** Termux's setup for its terminal view; keyboards answer it with committed characters and key events instead of composing regions. */
    const val INPUT_TYPE = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
        InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS

    @Volatile var active = false
        private set
    private var webView = WeakReference<WebView>(null)

    fun attach(view: WebView) { webView = WeakReference(view) }

    /** Runs after Chromium filled `outAttrs`; a null connection means no editable element is focused. */
    fun shape(connection: InputConnection?, outAttrs: EditorInfo): InputConnection? {
        if (connection != null && active) {
            outAttrs.inputType = INPUT_TYPE
            outAttrs.imeOptions = outAttrs.imeOptions or EditorInfoCompat.IME_FLAG_NO_PERSONALIZED_LEARNING
        }
        return connection
    }

    /** Main thread. A change makes the keyboard ask the focused editor for its setup again, without reconnecting. */
    fun set(value: Boolean) {
        if (active == value) return
        active = value
        webView.get()?.let { view -> view.context.getSystemService(InputMethodManager::class.java)?.restartInput(view) }
    }
}

/** Reached only through the Rust `terminal_private_keyboard` command; renderer calls to the plugin itself are refused there. */
@TauriPlugin
class PrivateKeyboardPlugin(private val owner: Activity) : MobilePlugin(owner) {
    @Command fun set(invoke: Invoke) {
        val active = runCatching { invoke.getArgs().getBoolean("active") }.getOrNull()
            ?: return invoke.reject("private_keyboard_invalid")
        owner.runOnUiThread { PrivateKeyboard.set(active); invoke.resolve() }
    }
}
