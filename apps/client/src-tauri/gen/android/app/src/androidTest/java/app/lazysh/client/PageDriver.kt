package app.lazysh.client

import android.graphics.Rect
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import org.json.JSONObject
import org.junit.Assert.assertTrue

/** Drives the real Tauri page of [NativeActivityFixture] the way the renderer does: JavaScript in the WebView and IPC with the unlock nonce. */
internal object PageDriver {
    private val scenario get() = NativeActivityFixture.scenario

    fun <T> poll(what: String, seconds: Long = 30, read: () -> T?): T {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        while (true) {
            val value = try { read() } catch (_: Throwable) { null }
            if (value != null) return value
            assertTrue("Timed out waiting for $what", System.nanoTime() < deadline)
            Thread.sleep(200)
        }
    }

    /** Two screen rectangles agree to within a pixel of rounding. */
    fun near(a: Rect, b: Rect) = listOf(a.left - b.left, a.top - b.top, a.right - b.right, a.bottom - b.bottom).all { abs(it) <= 1 }

    /** The result of `expression` as JSON text; the WebView is looked up again for every call, since a recreation replaces it. */
    fun js(expression: String): String {
        val result = AtomicReference<String>()
        val done = CountDownLatch(1)
        scenario.onActivity { activity ->
            (checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) { "the Tauri WebView" } as WebView)
                .evaluateJavascript(expression) { result.set(it); done.countDown() }
        }
        assertTrue("WebView evaluation timed out", done.await(30, TimeUnit.SECONDS))
        return result.get()
    }

    /** The unlocked workspace is showing its start page, which is when the IPC admits a command. */
    fun awaitStartPage() = poll("the start page", 120) {
        val ready = """Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector("button[aria-label='Add host']"))"""
        if (NativeActivityFixture.readiness(scenario).ready && js(ready) == "true") true else null
    }

    /** One IPC call as the page makes it; the outcome is the JSON of the result, or `error ` and the rejection. */
    fun invoke(command: String, arguments: String = "{}"): String {
        js("""(()=>{window.__outcome='pending';
            window.__TAURI_INTERNALS__.invoke('app_lock_status').then(status=>window.__TAURI_INTERNALS__.invoke('$command',$arguments,{headers:{'X-Lazysh-Access':status.nonce??''}}))
              .then(value=>{window.__outcome=JSON.stringify(value??null)},error=>{window.__outcome='error '+error});return true})()""")
        val text = poll("the outcome of $command") { js("window.__outcome").takeIf { it != "\"pending\"" } }
        return text.trim('"').replace("\\\"", "\"")
    }

    /** Puts a hidden element on the page and returns its `getBoundingClientRect()` and pixel ratio as the renderer would read them. */
    fun anchor(style: String): JSONObject {
        js("(() => { document.getElementById('surface-anchor')?.remove(); const a = document.createElement('div'); a.id = 'surface-anchor'; a.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;$style'; document.body.appendChild(a); return 1 })()")
        return JSONObject(js("(() => { const r = document.getElementById('surface-anchor').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio }; })()"))
    }

    fun removeAnchor() { runCatching { js("(document.getElementById('surface-anchor')?.remove(), 1)") } }
}
