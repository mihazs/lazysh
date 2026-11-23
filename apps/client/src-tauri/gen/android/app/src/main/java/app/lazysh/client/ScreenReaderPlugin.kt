package app.lazysh.client

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.content.Context
import android.view.accessibility.AccessibilityManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin as MobilePlugin

/** Whether a screen reader is on (#1329): the native terminal draws no text a reader can reach, so the client's registry refuses it while this is true. */
internal object ScreenReader {
    /** The feedback types of a service that reads the screen to the user. */
    const val READERS = AccessibilityServiceInfo.FEEDBACK_SPOKEN or AccessibilityServiceInfo.FEEDBACK_BRAILLE
    /** TalkBack and its kin turn on touch exploration; a spoken or braille service without it (a braille display, Select to Speak) reads views the same way and cannot read a GPU surface either. */
    fun active(touchExploration: Boolean, readerServices: Int): Boolean = touchExploration || readerServices > 0
    fun active(manager: AccessibilityManager): Boolean =
        active(manager.isTouchExplorationEnabled, manager.getEnabledAccessibilityServiceList(READERS).size)
}

/** The accessibility state for the Rust screen_reader module; renderer calls to this plugin are refused in Rust. */
@TauriPlugin
class ScreenReaderPlugin(owner: Activity) : MobilePlugin(owner) {
    // The application context outlives every Activity (a recreation destroys the one this plugin was built with), and the service answers the same for all of them.
    private val accessibility = owner.applicationContext.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
    @Command fun status(invoke: Invoke) {
        try { invoke.resolve(JSObject().put("active", ScreenReader.active(accessibility))) }
        catch (_: Exception) { invoke.reject("screen_reader_unavailable") }
    }
}
