package app.lazysh.client

import android.webkit.WebView
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginHandle
import app.tauri.plugin.PluginManager

/**
 * Replaces a plugin Tauri built for the first activity with one built for the activity that is in front, under the same name and
 * configuration, and marks it loaded so the SDK does not load it a second time. The renderer's next call reaches the replacement.
 */
internal fun rebindPlugin(webView: WebView, handle: PluginHandle, replacement: Plugin) {
    PluginManager.load(webView, handle.name, replacement, handle.config)
    replacement.handle?.loaded = true
}
