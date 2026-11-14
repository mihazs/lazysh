package app.lazysh.client

import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.lazysh.vault.VaultPlugin
import app.tauri.AppPlugin
import app.tauri.plugin.PluginManager
import app.lazysh.displayidle.DisplayIdlePlugin
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  companion object {
    /** Tauri's own `AppPlugin` has been bound to the first activity of this process. */
    private var backBound = false
  }

  override fun onWebViewCreate(webView: WebView) {
    ClipboardPlugin.onWebViewCreated(this, webView)
    VaultPlugin.onWebViewCreated(this, webView)
    DisplayIdlePlugin.onWebViewCreated(this, webView)
    EdgeGesturePlugin.onWebViewCreated(this, webView)
    rebindBack(webView)
    PrivateKeyboard.attach(webView)
    EdgeGestureInsets.attach(webView)
    super.onWebViewCreate(webView)
  }

  /**
   * `AppPlugin` registers its Back callback on the activity it was built with, the first one. On a recreated activity (a navigation overlay
   * change) no callback exists, so Back finishes the app instead of reaching the page's handler (#1449, #1435). A new `AppPlugin` for this
   * activity restores both the callback and the page's Back listener.
   */
  private fun rebindBack(webView: WebView) {
    if (!backBound) { backBound = true; return }
    val replacement = AppPlugin(this)
    PluginManager.load(webView, "app", replacement, "null")
    replacement.handle?.loaded = true
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    if (BuildConfig.DEBUG) Log.i("LazyshActivityCreate", "onCreate:enter")
    // Insets expose the fixed native window background, independent of WebView themes.
    val nativeBars = SystemBarStyle.dark(getColor(R.color.ic_launcher_background))
    enableEdgeToEdge(statusBarStyle = nativeBars, navigationBarStyle = nativeBars)
    if (BuildConfig.DEBUG) Log.i("LazyshActivityCreate", "onCreate:afterEdgeToEdge")
    super.onCreate(savedInstanceState)
    if (BuildConfig.DEBUG) Log.i("LazyshActivityCreate", "onCreate:afterSuper")
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      // Resize the WebView itself, so percentage-height layouts and xterm's
      // ResizeObserver agree on the space above any docked keyboard.
      val types = WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      val insets = windowInsets.getInsets(types)
      EdgeGestureInsets.update(this, windowInsets)
      view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
      // Forward zeroed insets, including hide transitions, to prevent WebView
      // from applying the same occlusion twice or retaining stale safe areas.
      WindowInsetsCompat.Builder(windowInsets).setInsets(types, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
