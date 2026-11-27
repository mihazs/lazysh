package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.SurfaceView
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import org.json.JSONObject
import org.json.JSONTokener
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

    /** The result of `block` run on the UI thread against the Activity in front. */
    fun <T> onActivity(block: (MainActivity) -> T): T {
        var out: Any? = null
        scenario.onActivity { out = block(it) }
        @Suppress("UNCHECKED_CAST") return out as T
    }

    /** What the surface itself holds, read from its buffer with `PixelCopy` and not from the composited screen. */
    fun pixelsOf(view: SurfaceView): Bitmap {
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val done = CountDownLatch(1)
        var result = -1
        onActivity { PixelCopy.request(view, bitmap, { result = it; done.countDown() }, Handler(Looper.getMainLooper())) }
        assertTrue("PixelCopy answered", done.await(30, TimeUnit.SECONDS))
        assertTrue("PixelCopy succeeded: $result", result == PixelCopy.SUCCESS)
        return bitmap
    }

    /** Two screen rectangles agree to within a pixel of rounding. */
    fun near(a: Rect, b: Rect) = listOf(a.left - b.left, a.top - b.top, a.right - b.right, a.bottom - b.bottom).all { abs(it) <= 1 }

    /** The page script that puts a saved `localStorage` value back (removed when there was none) and tells the app its storage changed. `previous` is the earlier read, interpolated as the page expression it was. */
    fun restoreStorageScript(key: String, previous: Any?) = """(() => {
        if ($previous === null) localStorage.removeItem('$key');
        else localStorage.setItem('$key', $previous);
        window.dispatchEvent(new StorageEvent('storage', {key: '$key'}));
        return true;
    })()"""

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

    /** One IPC call as the page makes it; the outcome is the JSON of the result, or `error ` and the rejection (as JSON when it is an object, such as an `SshError`). */
    fun invoke(command: String, arguments: String = "{}", evaluate: (String) -> String = ::js): String {
        evaluate("""(()=>{window.__outcome='pending';
            window.__TAURI_INTERNALS__.invoke('app_lock_status').then(status=>window.__TAURI_INTERNALS__.invoke('$command',$arguments,{headers:{'X-Lazysh-Access':status.nonce??''}}))
              .then(value=>{window.__outcome=JSON.stringify(value??null)},error=>{window.__outcome='error '+(typeof error==='string'?error:JSON.stringify(error))});return true})()""")
        val text = poll("the outcome of $command") { evaluate("window.__outcome").takeIf { it != "\"pending\"" } }
        // The WebView hands the outcome back as a JS string literal, so a text result keeps its quotes and newlines.
        return JSONTokener(text).nextValue() as String
    }

    /** Puts a hidden element on the page and returns its `getBoundingClientRect()` and pixel ratio as the renderer would read them. */
    fun anchor(style: String): JSONObject {
        js("(() => { document.getElementById('surface-anchor')?.remove(); const a = document.createElement('div'); a.id = 'surface-anchor'; a.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;$style'; document.body.appendChild(a); return 1 })()")
        return JSONObject(js("(() => { const r = document.getElementById('surface-anchor').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio }; })()"))
    }

    fun removeAnchor() { runCatching { js("(document.getElementById('surface-anchor')?.remove(), 1)") } }
}
