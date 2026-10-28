package app.lazysh.client

import android.os.Bundle
import android.util.Log
import android.webkit.WebView
import app.lazysh.vault.VaultPlugin
import app.lazysh.displayidle.DisplayIdlePlugin
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
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
  }
}
