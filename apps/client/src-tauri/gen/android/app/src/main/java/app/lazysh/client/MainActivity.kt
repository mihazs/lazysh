package app.lazysh.client

import android.os.Bundle
import android.webkit.WebView
import app.lazysh.vault.VaultPlugin
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onWebViewCreate(webView: WebView) {
    VaultPlugin.onWebViewCreated(this, webView)
    super.onWebViewCreate(webView)
  }
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
