package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlin.math.abs
import kotlin.math.roundToInt
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real page over a placed native pane (#2094, G13), looked at the way a user sees it: the composited screen (`UiAutomation.takeScreenshot`), not the
 * surface's own buffer. The real MainActivity and its Tauri WebView, a surface placed through the renderer's own IPC and painted with the pane colour,
 * and a stand-in pane on the page: an element with the native marker whose ancestors paint nothing, which is the rule `TerminalNativeSurface.css` gives
 * the real pane (checked in a browser by `terminal-native-surface.spec.ts`; the real pane over a surface is `NativeTerminalSessionTest`). What it proves
 * is Android's half: the WebView lets the surface through only while a pane is placed, a DOM overlay stays above the surface, and a page that paints
 * its own background (an xterm.js pane) hides the surface exactly as it did before.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalCompositionTest {
    private val scenario get() = NativeActivityFixture.scenario
    private val session = "composition-test"
    private val paneColour = 0x1a2b3c
    private val overlayColour = 0xff00aa
    private val factoryBefore = TerminalSurfaces.clientFactory
    private val enabledBefore = TerminalSurfaces.enabled

    @Before fun painterOnly() {
        TerminalSurfaces.enabled = true
        // The pane colour on the surface, as the host shows it before (or without) a renderer: this case is about what the window shows of it.
        TerminalSurfaces.clientFactory = { _, background -> BackgroundPainter(background) }
        PageDriver.awaitStartPage()
    }

    @After fun cleanUp() {
        runCatching { scenario.onActivity { TerminalSurfaces.remove(session) } }
        runCatching { PageDriver.js("(document.getElementById('lz-composition-style')?.remove(), document.querySelectorAll('.lz-composition').forEach(e => e.remove()), 1)") }
        TerminalSurfaces.clientFactory = factoryBefore
        TerminalSurfaces.enabled = enabledBefore
    }

    private fun <T> ui(block: (MainActivity) -> T) = PageDriver.onActivity(block)

    /**
     * A pane element stands where the surface goes (10%, 25%, 50% x 30%) and an opaque overlay covers the top right of it and reaches beyond. `native`
     * is a native pane: the element is marked, everything else the app drew is hidden and its ancestors paint nothing, as the real rule does. Otherwise
     * the app is as it was, the xterm.js case, where the pane's own page paints everywhere.
     */
    private fun page(native: Boolean) {
        val style = """.lz-composition{position:fixed;margin:0;border:0;padding:0}
            ${if (native) "body > *:not(.lz-composition){visibility:hidden !important}" else ""}
            #lz-pane{left:10%;top:25%;width:50%;height:30%;background:transparent}
            #lz-overlay{left:45%;top:20%;width:30%;height:20%;background:#${"%06x".format(overlayColour)}}
            ${if (native) "html, body {background:transparent !important}" else ""}"""
        PageDriver.js("""(() => {
          document.getElementById('lz-composition-style')?.remove();
          const style = document.createElement('style'); style.id = 'lz-composition-style'; style.textContent = ${JSONObject.quote(style)}; document.head.appendChild(style);
          for (const id of ['lz-pane', 'lz-overlay']) if (!document.getElementById(id)) { const e = document.createElement('div'); e.id = id; e.className = 'lz-composition'; document.body.appendChild(e); }
          const pane = document.getElementById('lz-pane'); pane.classList.add('terminal-canvas');
          if (${native}) pane.setAttribute('data-terminal-surface', 'native'); else pane.removeAttribute('data-terminal-surface');
          return 1 })()""")
    }

    private fun rectOf(id: String) = JSONObject(PageDriver.js("(() => { const r = document.getElementById('$id').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, dpr: window.devicePixelRatio }; })()"))

    /** The screen position of a point at `fx`, `fy` (fractions) of an element of the page. */
    private fun screenPoint(rect: JSONObject, fx: Double, fy: Double): Pair<Int, Int> {
        val web = ui { activity -> IntArray(2).also { checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)).getLocationOnScreen(it) } }
        val dpr = rect.getDouble("dpr")
        return Pair(web[0] + ((rect.getDouble("x") + rect.getDouble("width") * fx) * dpr).roundToInt(), web[1] + ((rect.getDouble("y") + rect.getDouble("height") * fy) * dpr).roundToInt())
    }

    private class Samples(val surface: Int, val overlay: Int, val outside: Int) {
        override fun toString() = "surface #%08x, overlay #%08x, outside #%08x".format(surface, overlay, outside)
    }

    /**
     * Three pixels of the composited screen: inside the pane and clear of the overlay, inside both, and in neither. A screenshot is the display as
     * composed, the surface's layer included, which `PixelCopy` of the surface's own buffer is not.
     */
    private fun samples(): Samples {
        val pane = rectOf("lz-pane")
        val overlay = rectOf("lz-overlay")
        val screen: Bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()) { "the screenshot" }
        fun at(point: Pair<Int, Int>) = screen.getPixel(point.first, point.second)
        return Samples(at(screenPoint(pane, 0.2, 0.8)), at(screenPoint(overlay, 0.2, 0.8)), at(screenPoint(pane, 1.3, 1.4)))
    }

    private fun close(expected: Int, actual: Int) = listOf(Color.red(expected) - Color.red(actual), Color.green(expected) - Color.green(actual), Color.blue(expected) - Color.blue(actual)).all { abs(it) <= 3 } && Color.alpha(actual) == 255

    private fun colour(rgb: Int) = rgb or 0xff000000.toInt()

    /** Polls until `ok` holds for the screen, since the compositor presents a changed page a frame or two after its commit; fails with what it last saw. */
    private fun awaitScreen(what: String, ok: (Samples) -> Boolean): Samples {
        var seen: Samples? = null
        try {
            return PageDriver.poll(what) { samples().also { seen = it }.takeIf(ok) }
        } catch (error: AssertionError) {
            throw AssertionError("${error.message}; the last screen showed $seen", error)
        }
    }

    private fun place() {
        val pane = rectOf("lz-pane")
        val anchor = """{x:${pane.getDouble("x")},y:${pane.getDouble("y")},width:${pane.getDouble("width")},height:${pane.getDouble("height")},dpr:${pane.getDouble("dpr")}}"""
        val placed = JSONObject(PageDriver.invoke("native_terminal_surface_place", "{session:'$session',anchor:$anchor,background:$paneColour}"))
        assertTrue(placed.getBoolean("placed"))
        PageDriver.poll("a ready surface") { JSONObject(PageDriver.invoke("native_terminal_surface_state", "{session:'$session'}")).takeIf { it.getBoolean("ready") } }
    }

    /** The screen once two captures in a row agree, so a page still being presented is not taken for the state it settles in. */
    private fun settled(what: String): Samples {
        var last: Samples? = null
        return PageDriver.poll(what) {
            val now = samples()
            val previous = last
            last = now
            now.takeIf { previous != null && close(previous.surface, it.surface) && close(previous.overlay, it.overlay) && close(previous.outside, it.outside) }
        }
    }

    @Test fun thePageShowsTheSurfaceThroughItsNativePaneWithItsOverlayAboveAndTheWebViewIsOpaqueAgainWhenItEnds() {
        page(native = true)
        // No surface yet: the WebView is opaque, so a page that paints nothing shows the WebView's own background.
        val opaque = settled("the page without a surface").outside
        place()

        val composed = awaitScreen("the surface through the pane") { close(colour(paneColour), it.surface) }
        assertTrue("an opaque overlay of the page stays above the surface: $composed", close(colour(overlayColour), composed.overlay))
        assertNotEquals("where the page paints nothing and no surface is, the window shows, not the WebView's background: $composed", opaque, composed.outside)
        assertFalse("the surface is the pane's, not the window's: $composed", close(colour(paneColour), composed.outside))

        // The surface ends: the WebView is opaque again, as before it, and shows the same background where the page paints nothing.
        assertEquals("null", PageDriver.invoke("native_terminal_surface_remove", "{session:'$session'}"))
        val restored = awaitScreen("the opaque WebView again") { close(opaque, it.outside) }
        assertFalse("nothing of the removed surface is left: $restored", close(colour(paneColour), restored.surface))
    }

    @Test fun aPlacedSurfaceChangesNothingOnAPageThatIsNotANativePane() {
        // The xterm.js case: the app paints its own background everywhere, so what the screen shows is the app, with or without a surface placed.
        page(native = false)
        val without = settled("the app without a surface")
        place()
        Thread.sleep(2_000)
        val with = settled("the app with a surface placed behind it")
        assertFalse("the surface does not show through the app: $with", close(colour(paneColour), with.surface))
        assertTrue("the app looks the same with a surface placed: without $without, with $with", close(without.surface, with.surface) && close(without.overlay, with.overlay) && close(without.outside, with.outside))
    }

    @Test fun aRecreatedActivityStartsOpaqueAndShowsTheSurfaceAgainOnceItsPagePlacesIt() {
        page(native = true)
        place()
        awaitScreen("the surface through the first page") { close(colour(paneColour), it.surface) }

        val before = ui { it }
        scenario.recreate()
        assertFalse("the Activity was replaced", before === ui { it })
        PageDriver.awaitStartPage()
        page(native = true)
        // Nothing is shown until the new page places the session, and its WebView is the new, opaque one.
        val waiting = settled("the new page without a surface")
        assertFalse("the session is not shown on a page that has not placed it: $waiting", close(colour(paneColour), waiting.surface))
        place()
        val again = awaitScreen("the surface through the new page") { close(colour(paneColour), it.surface) }
        assertTrue("the overlay is above the surface on the new page: $again", close(colour(overlayColour), again.overlay))
        assertNotEquals("the new WebView became transparent when its page placed the session: $again", waiting.outside, again.outside)
    }
}
