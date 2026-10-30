package app.lazysh.client

import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.lazysh.vault.VaultPlugin
import app.lazysh.displayidle.DisplayIdlePlugin
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    ClipboardPlugin.onWebViewCreated(this, webView)
    VaultPlugin.onWebViewCreated(this, webView)
    DisplayIdlePlugin.onWebViewCreated(this, webView)
    super.onWebViewCreate(webView)
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    if (BuildConfig.DEBUG) Log.i("LazyshActivityCreate", "onCreate:enter")
    enableEdgeToEdge()
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
      view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
      // Forward zeroed insets, including hide transitions, to prevent WebView
      // from applying the same occlusion twice or retaining stale safe areas.
      WindowInsetsCompat.Builder(windowInsets).setInsets(types, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
