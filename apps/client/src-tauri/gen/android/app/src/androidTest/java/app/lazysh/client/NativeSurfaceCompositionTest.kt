package app.lazysh.client

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.os.SystemClock
import android.view.ActionMode
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.graphics.Rect
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import app.lazysh.client.surfacepoc.Anchor
import app.lazysh.client.surfacepoc.NativeSurfaceHost
import app.lazysh.client.surfacepoc.POC_TEXT
import app.lazysh.client.surfacepoc.PocSession
import app.lazysh.client.surfacepoc.Strategy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.roundToInt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Composition proof of concept for a native terminal surface beside the Tauri WebView (#1310).
 * The placement, input, lifecycle and accessibility cases use the real Activity and its real WebView.
 * The pixel cases cannot dim the real app, so they stack a transparent fixture WebView in the same
 * content frame and move the real one aside; they prove Android's compositing order, not the Tauri
 * WebView's own background. Physical devices, soft-keyboard IME composition and TalkBack are not covered.
 */
@RunWith(AndroidJUnit4::class)
class NativeSurfaceCompositionTest {
    private val scenario get() = NativeActivityFixture.scenario
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()

    private fun <T> ui(block: (MainActivity) -> T): T {
        var out: Any? = null
        scenario.onActivity { out = block(it) }
        @Suppress("UNCHECKED_CAST") return out as T
    }

    private fun until(what: String, timeoutMillis: Long = 30_000, detail: () -> String = { "" }, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeoutMillis
        while (!condition()) {
            assertTrue("Timed out waiting for $what ${if (SystemClock.uptimeMillis() < deadline) "" else detail()}", SystemClock.uptimeMillis() < deadline)
            Thread.sleep(100)
        }
    }

    private fun realWebView(activity: Activity) = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) { "the Tauri WebView is not in the window" } as WebView
    private fun awaitWebView() = until("the Tauri WebView in the window") { ui { EdgeGestureExclusion.webView(it.window.decorView) != null } }
    private fun frameOf(web: View) = web.parent as ViewGroup

    private fun js(web: () -> WebView, expression: String): String {
        val result = AtomicReference<String>()
        val done = CountDownLatch(1)
        ui { web().evaluateJavascript(expression) { result.set(it); done.countDown() } }
        assertTrue("WebView evaluation timed out", done.await(30, TimeUnit.SECONDS))
        return result.get()
    }

    private fun anchorOf(web: () -> WebView, element: String): Anchor {
        val json = JSONObject(js(web, "(() => { const r = $element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio }; })()"))
        return Anchor(json.getDouble("x"), json.getDouble("y"), json.getDouble("width"), json.getDouble("height"), json.getDouble("dpr"))
    }

    /** A hidden, non-interactive element stands in for the terminal's DOM anchor; it is always removed again. */
    private fun withDomAnchor(style: String, block: (() -> Anchor) -> Unit) {
        val real = { ui { realWebView(it) } }
        awaitWebView()
        // The Tauri page, not the initial about:blank document that a fresh or recreated WebView starts with.
        until("the Tauri page") { js(real, "document.readyState === 'complete' && !!window.__TAURI_INTERNALS__?.invoke && !!document.body") == "true" }
        js(real, "(() => { const a = document.createElement('div'); a.id = 'surface-poc'; a.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;$style'; document.body.appendChild(a); return 1 })()")
        try { block { anchorOf(real, "document.getElementById('surface-poc')") } }
        finally { runCatching { js(real, "(document.getElementById('surface-poc')?.remove(), 1)") } }
    }

    private fun attach(strategy: Strategy, session: PocSession, anchor: Anchor) = ui { activity ->
        val web = realWebView(activity)
        NativeSurfaceHost(activity, strategy, session).also { it.attach(frameOf(web) as FrameLayout, web, anchor) }
    }

    private fun screenRect(view: View) = IntArray(2).also { view.getLocationOnScreen(it) }.let { Rect(it[0], it[1], it[0] + view.width, it[1] + view.height) }

    private fun expectedRect(web: View, anchor: Anchor) = screenRect(web).let { origin ->
        val left = origin.left + (anchor.x * anchor.dpr).roundToInt()
        val top = origin.top + (anchor.y * anchor.dpr).roundToInt()
        Rect(left, top, left + (anchor.width * anchor.dpr).roundToInt(), top + (anchor.height * anchor.dpr).roundToInt())
    }

    private fun near(a: Rect, b: Rect) = abs(a.left - b.left) <= 1 && abs(a.top - b.top) <= 1 && abs(a.right - b.right) <= 1 && abs(a.bottom - b.bottom) <= 1

    private fun validSurface(host: NativeSurfaceHost) = ui { (host.view as? android.view.SurfaceView)?.holder?.surface?.isValid ?: true }

    @Test fun surfaceFollowsTheDomAnchorAndTheInsetsThatMoveIt() = withDomAnchor("left:40px;bottom:200px;width:200px;height:100px") { read ->
        val session = PocSession()
        val first = read()
        val host = attach(Strategy.SURFACE_ABOVE, session, first)
        val real = { ui { realWebView(it) } }
        val frame = { frameOf(real()) as FrameLayout }
        val params = ui { real().layoutParams as FrameLayout.LayoutParams }
        val originalBottom = params.bottomMargin
        try {
            ui { assertEquals("the Tauri WebView sits directly in the content frame", android.R.id.content, (real().parent as View).id) }
            until("the surface at the anchor's screen rectangle") { ui { near(screenRect(host.view), expectedRect(real(), first)) } }
            until("a created, valid surface") { host.created.get() == 1 && validSurface(host) }
            assertTrue("a frame was drawn", session.frames.get() >= 1)
            // A docked keyboard shrinks the WebView; a bottom-anchored element then moves up and the surface must follow it.
            val heightBefore = ui { real().height }
            ui { real().layoutParams = params.also { it.bottomMargin = originalBottom + 300 } }
            until("the WebView to shrink and the anchor to move up", detail = { "height $heightBefore -> ${ui { real().height }}, innerHeight ${js(real, "innerHeight")}, y ${first.y} -> ${read().y}" }) { read().y < first.y }
            val moved = read()
            ui { host.place(frame(), real(), moved) }
            until("the surface at the moved anchor") { ui { near(screenRect(host.view), expectedRect(real(), moved)) } }
        } finally {
            ui { host.detach(); real().layoutParams = params.also { it.bottomMargin = originalBottom } }
        }
    }

    @Test fun touchesReachTheSurfaceOnlyWhenItIsStackedAboveTheWebView() = withDomAnchor("left:10%;top:25%;width:50%;height:30%") { read ->
        val anchor = read()
        for ((strategy, reached) in listOf(Strategy.SURFACE_ABOVE to true, Strategy.SURFACE_BELOW to false)) {
            val host = attach(strategy, PocSession(), anchor)
            try {
                until("$strategy in place") { ui { near(screenRect(host.view), expectedRect(realWebView(it), anchor)) } }
                // DOWN then CANCEL: the web page under the surface must not receive a click.
                ui { activity ->
                    val centre = IntArray(2).also { host.view.getLocationInWindow(it) }
                    val x = centre[0] + host.view.width / 2f
                    val y = centre[1] + host.view.height / 2f
                    val now = SystemClock.uptimeMillis()
                    for (action in intArrayOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_CANCEL)) {
                        val event = MotionEvent.obtain(now, now, action, x, y, 0)
                        activity.window.decorView.dispatchTouchEvent(event)
                        event.recycle()
                    }
                }
                assertEquals("$strategy receives touches inside its rectangle", reached, host.touches.get() > 0)
            } finally { ui { host.detach() } }
        }
    }

    @Test fun focusHandsOverBetweenTheSurfaceAndTheWebView() = withDomAnchor("left:10%;top:25%;width:50%;height:30%") { read ->
        val host = attach(Strategy.SURFACE_ABOVE, PocSession(), read())
        try {
            ui { assertTrue(host.view.requestFocus()) }
            ui { assertTrue("the surface holds focus", host.view.hasFocus() && !realWebView(it).hasFocus()) }
            // Observation only: whether the IMM treats the surface as the served editor depends on the installed IME.
            val manager = ui { it.getSystemService(InputMethodManager::class.java) }
            var served = false
            val deadline = SystemClock.uptimeMillis() + 5_000
            while (!served && SystemClock.uptimeMillis() < deadline) { served = ui { manager.isActive(host.view) }; if (!served) Thread.sleep(100) }
            Log.i("lazysh-surface-poc", "imm.isActive(surface)=$served")
            ui { assertTrue(realWebView(it).requestFocus()) }
            ui { assertTrue("focus returned to the WebView", !host.view.hasFocus() && realWebView(it).hasFocus()) }
        } finally { ui { host.detach(); realWebView(it).requestFocus() } }
    }

    @Test fun sessionStateOutlivesSurfaceDestructionStopStartAndActivityRecreation() = withDomAnchor("left:10%;top:25%;width:50%;height:30%") { read ->
        val session = PocSession()
        val anchor = read()
        var host = attach(Strategy.SURFACE_BELOW, session, anchor)
        try {
            until("the first surface") { host.created.get() == 1 && validSurface(host) }
            val first = session.frames.get()
            assertTrue(first >= 1)
            scenario.moveToState(Lifecycle.State.CREATED)
            // Whether Android destroys the surface on stop is observed, not assumed; the logged counts show which happened.
            Log.i("lazysh-surface-poc", "after stop: created=${host.created.get()} destroyed=${host.destroyed.get()}")
            session.colour = Color.CYAN
            scenario.moveToState(Lifecycle.State.RESUMED)
            until("a valid surface after restart") { validSurface(host) }
            Log.i("lazysh-surface-poc", "after restart: created=${host.created.get()} destroyed=${host.destroyed.get()}")
            ui { host.redraw() }
            assertTrue("the session redrew onto the surface", session.frames.get() > first)
            assertEquals("no draw reached an invalid surface", 0, host.invalidDraws.get())
            val before = session.frames.get()
            val original = ui { it }
            ui { host.detach() }
            scenario.recreate()
            assertNotSame(original, ui { it })
            awaitWebView()
            host = attach(Strategy.SURFACE_BELOW, session, anchor)
            until("a surface on the recreated Activity") { host.created.get() == 1 && validSurface(host) }
            assertTrue("the same session drew on the new Activity", session.frames.get() > before)
        } finally { ui { host.detach() } }
    }

    @Test fun accessibilityServiceReadsTextExposedForTheSurface() = withDomAnchor("left:10%;top:25%;width:50%;height:30%") { read ->
        val host = attach(Strategy.SURFACE_ABOVE, PocSession(), read())
        try {
            until("the surface created") { host.created.get() == 1 }
            val device = UiDevice.getInstance(instrumentation)
            assertTrue("the virtual node is visible to an accessibility client", device.wait(Until.hasObject(By.text(POC_TEXT)), 20_000))
            val seen = device.findObject(By.text(POC_TEXT)).visibleBounds
            val surface = ui { screenRect(host.view) }
            assertTrue("the node lies inside the surface: $seen vs $surface", surface.contains(seen.left + 1, seen.top + 1) && surface.contains(seen.right - 2, seen.bottom - 2))
        } finally { ui { host.detach() } }
    }

    @Test fun surfaceCanHostTheFloatingSelectionToolbar() = withDomAnchor("left:10%;top:25%;width:50%;height:30%") { read ->
        val host = attach(Strategy.SURFACE_ABOVE, PocSession(), read())
        try {
            until("the surface in the window") { ui { host.view.isAttachedToWindow && host.view.width > 0 } }
            var created = false
            val callback = object : ActionMode.Callback2() {
                override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean { created = true; menu.add("Copy"); return true }
                override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false
                override fun onActionItemClicked(mode: ActionMode, item: android.view.MenuItem) = false
                override fun onDestroyActionMode(mode: ActionMode) {}
                override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) { outRect.set(0, 0, view.width, view.height / 2) }
            }
            val mode = ui { host.view.startActionMode(callback, ActionMode.TYPE_FLOATING) }
            assertNotNull("a floating ActionMode starts from the surface", mode)
            assertTrue(created)
            ui { mode.finish() }
        } finally { ui { host.detach() } }
    }

    // Composition order, read back from the composited display. The fixture page is transparent
    // except an opaque blue bar and a red box that overlaps the corner of the transparent hole.
    private val fixturePage = """<body style="margin:0;background:transparent">
        <div id="hole" style="position:fixed;left:10%;top:20%;width:60%;height:40%"></div>
        <div style="position:fixed;left:0;top:0;right:0;height:10%;background:#0000ff"></div>
        <div style="position:fixed;left:50%;top:45%;width:30%;height:25%;background:#ff0000"></div></body>"""

    private fun classify(pixel: Int): String {
        val palette = mapOf("magenta" to Color.MAGENTA, "red" to Color.RED, "blue" to Color.BLUE)
        val best = palette.minByOrNull { (_, c) -> abs(Color.red(pixel) - Color.red(c)) + abs(Color.green(pixel) - Color.green(c)) + abs(Color.blue(pixel) - Color.blue(c)) }!!
        val distance = abs(Color.red(pixel) - Color.red(best.value)) + abs(Color.green(pixel) - Color.green(best.value)) + abs(Color.blue(pixel) - Color.blue(best.value))
        return if (distance < 100) best.key else "other(#%06x)".format(pixel and 0xffffff)
    }

    private fun composite(strategy: Strategy, overlapIs: String) {
        awaitWebView()
        val real = ui { realWebView(it) }
        val frame = frameOf(real) as FrameLayout
        assumeTrue("FLAG_SECURE blanks display screenshots", ui { it.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0 })
        val loaded = CountDownLatch(1)
        val fixture = ui { activity ->
            real.translationX = real.width * 2f
            WebView(activity).apply {
                setBackgroundColor(Color.TRANSPARENT)
                settings.javaScriptEnabled = true
                webViewClient = object : WebViewClient() { override fun onPageFinished(view: WebView, url: String) { loaded.countDown() } }
                frame.addView(this, FrameLayout.LayoutParams(-1, -1))
                loadDataWithBaseURL(null, fixturePage, "text/html", "utf-8", null)
            }
        }
        var host: NativeSurfaceHost? = null
        try {
            assertTrue("fixture page loaded", loaded.await(30, TimeUnit.SECONDS))
            val anchor = anchorOf({ fixture }, "document.getElementById('hole')")
            host = ui { activity -> NativeSurfaceHost(activity, strategy, PocSession()).also { it.attach(frame, fixture, anchor) } }
            val probe = { xPercent: Int, yPercent: Int ->
                val shot: Bitmap? = instrumentation.uiAutomation.takeScreenshot()
                assumeTrue("display screenshots are unavailable", shot != null)
                val origin = screenRect(fixture)
                classify(shot!!.getPixel(origin.left + origin.width() * xPercent / 100, origin.top + origin.height() * yPercent / 100))
            }
            // The control points prove the page painted and the bitmap is the composited display.
            until("the page to paint its bar and box", 20_000) { probe(50, 5) == "blue" && probe(75, 65) == "red" }
            var holeOnly = ""; var overlap = ""
            until("the surface colour in the hole, or the final colours", 10_000) { holeOnly = probe(25, 30); overlap = probe(60, 52); holeOnly == "magenta" && overlap == overlapIs }
            assertEquals("hole away from the overlay", "magenta", holeOnly)
            assertEquals("overlay over the hole", overlapIs, overlap)
        } finally {
            ui { host?.detach(); frame.removeView(fixture); fixture.destroy(); real.translationX = 0f }
        }
    }

    @Test fun surfaceBelowATransparentWebViewShowsThroughAndDomOverlaysStayOnTop() = composite(Strategy.SURFACE_BELOW, "red")
    @Test fun textureBelowATransparentWebViewShowsThroughAndDomOverlaysStayOnTop() = composite(Strategy.TEXTURE_BELOW, "red")
    @Test fun surfaceOnTopHidesDomOverlaysThatOverlapIt() = composite(Strategy.SURFACE_ABOVE, "magenta")
}
