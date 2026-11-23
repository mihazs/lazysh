package app.lazysh.client

import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Regression for #2313: wry queued WebView messages for the main looper in a bounded(8) channel, and
 * Activity.onCreate sends from that same thread, so a recreation with a full queue deadlocked the main thread.
 */
@RunWith(AndroidJUnit4::class)
class NativeRecreateTest {
    @Test fun activityRecreationSurvivesQueuedWebViewMessages() {
        val scenario = NativeActivityFixture.scenario
        repeat(40) { round ->
            // Each Tauri event emit makes Rust queue an eval message for the main looper; recreate before it drains.
            scenario.onActivity { activity ->
                val webView = activity.window.decorView.findViewWithTag<WebView>("lazysh-webview")
                    ?: generateSequence(listOf(activity.window.decorView)) { views -> views.filterIsInstance<android.view.ViewGroup>().flatMap { g -> (0 until g.childCount).map(g::getChildAt) } }
                        .takeWhile { it.isNotEmpty() }.flatten().filterIsInstance<WebView>().first()
                webView.evaluateJavascript("for (let i = 0; i < 24; i++) window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'lazysh-recreate-$round', payload: i })", null)
            }
            val done = CountDownLatch(1)
            Thread { scenario.recreate(); done.countDown() }.start()
            assertEquals("Activity.recreate() wedged on round $round", true, done.await(30, TimeUnit.SECONDS))
        }
    }
}
