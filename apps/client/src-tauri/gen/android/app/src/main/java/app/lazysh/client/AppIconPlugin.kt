package app.lazysh.client

import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin as MobilePlugin

/**
 * Exactly one bundled launcher alias is enabled. Selection enables the new entry before it
 * disables the others, so the launcher never loses every entry, and always reports PackageManager
 * readback rather than the requested value. Aliases target LauncherActivity, never MainActivity,
 * so disabling one leaves the running workspace task, its WebView and sessions in place.
 */
internal object LauncherIcons {
    val aliases = linkedMapOf("default" to ".LauncherDefault", "amber" to ".LauncherAmber")
    // Alias names are resolved against the manifest namespace, which is fixed across build variants.
    fun component(context: Context, icon: String) =
        ComponentName(context.packageName, "app.lazysh.client" + aliases.getValue(icon))
    @Suppress("DEPRECATION")
    private fun declared(manager: PackageManager, component: ComponentName) =
        manager.getActivityInfo(component, PackageManager.MATCH_DISABLED_COMPONENTS).enabled
    fun enabled(context: Context, icon: String): Boolean {
        val manager = context.packageManager
        val component = component(context, icon)
        return when (manager.getComponentEnabledSetting(component)) {
            PackageManager.COMPONENT_ENABLED_STATE_ENABLED -> true
            PackageManager.COMPONENT_ENABLED_STATE_DEFAULT -> declared(manager, component)
            else -> false
        }
    }
    fun current(context: Context): String = aliases.keys.filter { enabled(context, it) }.singleOrNull() ?: "unknown"
    fun select(context: Context, icon: String): String {
        require(icon in aliases) { "Choose a bundled lazysh app icon" }
        val manager = context.packageManager
        for (name in listOf(icon) + (aliases.keys - icon)) {
            val component = component(context, name)
            val wanted = name == icon
            // Restoring the manifest's own state keeps Default identical to a fresh install.
            val state = when {
                wanted == declared(manager, component) -> PackageManager.COMPONENT_ENABLED_STATE_DEFAULT
                wanted -> PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else -> PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            }
            manager.setComponentEnabledSetting(component, state, PackageManager.DONT_KILL_APP)
        }
        return current(context)
    }
}

/** Launcher-icon commands for the Rust app_icons module; renderer calls to this plugin are refused in Rust. */
@TauriPlugin
class AppIconPlugin(private val owner: Activity) : MobilePlugin(owner) {
    private companion object {
        const val REASON = "The launcher icon is managed by Android on this device. Your open sessions stay connected; " +
            "the launcher may take a moment to show the new icon."
    }
    private fun reply(current: String) = JSObject().put("available", true).put("current", current).put("reason", REASON)
    // The Apply tap reaches a focused, live window; a backgrounded or closing Activity is refused.
    private fun foreground() = owner.hasWindowFocus() && !owner.isFinishing

    @Command fun status(invoke: Invoke) = owner.runOnUiThread {
        try { invoke.resolve(reply(LauncherIcons.current(owner))) }
        catch (_: Exception) { invoke.reject("Cannot read the Android launcher icon") }
    }

    @Command fun select(invoke: Invoke) = owner.runOnUiThread {
        val icon = runCatching { invoke.getArgs().getString("icon") }.getOrNull()
        if (icon == null || icon !in LauncherIcons.aliases) { invoke.reject("Choose a bundled lazysh app icon"); return@runOnUiThread }
        if (!foreground()) { invoke.reject("Open lazysh before changing the launcher icon"); return@runOnUiThread }
        val actual = try { LauncherIcons.select(owner, icon) } catch (_: Exception) {
            invoke.reject("Android could not change the launcher icon. Refresh to read the current icon."); return@runOnUiThread
        }
        if (actual != icon) { invoke.reject("Android did not apply the launcher icon. Refresh to read the current icon."); return@runOnUiThread }
        invoke.resolve(reply(actual))
    }
}
