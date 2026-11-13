package app.lazysh.webviewbench;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

/** Throwaway host of the terminal benchmark page in the Android System WebView (#1323): a full-window WebView with remote debugging, nothing else. */
public class WebActivity extends Activity {
    private WebView view;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(true);
        view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        setContentView(view);
        load(getIntent().getStringExtra("url"));
    }

    @Override
    protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        load(intent.getStringExtra("url"));
    }

    private void load(String url) {
        view.loadUrl(url == null ? "about:blank" : url);
    }
}
