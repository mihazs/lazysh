package app.lazysh.client

import android.app.Activity
import android.webkit.WebView
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginHandle
import app.tauri.plugin.PluginManager

/**
 * The activity Tauri's plugin manager holds now, which is the one in front after a recreation (the old one is removed when it is
 * destroyed, before the new one is created). A plugin that Tauri built with the first activity reads it through this instead of keeping
 * the constructor argument, which a recreation leaves destroyed (#1462). `fallback` is the activity at construction.
 */
internal fun currentActivity(fallback: Activity): Activity = PluginManager.activity ?: fallback

/**
 * Replaces a plugin Tauri built for the first activity with one built for the activity that is in front, under the same name and
 * configuration, and marks it loaded so the SDK does not load it a second time. The renderer's next call reaches the replacement.
 */
internal fun rebindPlugin(webView: WebView, handle: PluginHandle, replacement: Plugin) {
    PluginManager.load(webView, handle.name, replacement, handle.config)
    replacement.handle?.loaded = true
}
