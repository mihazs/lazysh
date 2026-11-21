package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Surface
import android.view.SurfaceView
import android.view.ViewGroup
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The native terminal surface host (#1327) on the real MainActivity and its Tauri WebView, driven through the renderer's own IPC:
 * placement at a DOM anchor, the surface lifecycle (stop and start, Activity recreation, removal) with the session's client told in
 * order, what is drawn on each new surface, and the developer-only gate. The composition order itself (surface below a transparent
 * WebView, overlays on top) is [NativeSurfaceCompositionTest]. No renderer, input, accessibility or physical device is involved.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalSurfaceTest {
    private val scenario get() = NativeActivityFixture.scenario
    private val session = "surface-test"
    private val background = 0x1a2b3c
    private val opaque = background or 0xff000000.toInt()

    /** What a renderer is told, in order, while the default painter still draws the background so the surface can be read back. */
    private class Recorder(background: () -> Int) : SurfaceClient<Surface> {
        private val painter = BackgroundPainter(background)
        val events = CopyOnWriteArrayList<String>()
        override fun onSurfaceReady(surface: Surface, generation: Int, width: Int, height: Int) { events += "ready $generation ${width}x$height"; painter.onSurfaceReady(surface, generation, width, height) }
        override fun onSurfaceChanged(surface: Surface, generation: Int, width: Int, height: Int) { events += "changed $generation ${width}x$height"; painter.onSurfaceChanged(surface, generation, width, height) }
        override fun onSurfaceLost(generation: Int) { events += "lost $generation" }
    }

    private lateinit var recorder: Recorder
    private val factoryBefore = TerminalSurfaces.clientFactory
    private val enabledBefore = TerminalSurfaces.enabled

    @Before fun developerBuild() {
        TerminalSurfaces.enabled = true
        TerminalSurfaces.clientFactory = { Recorder(it).also { made -> recorder = made } }
        PageDriver.awaitStartPage()
    }

    @After fun cleanUp() {
        runCatching { scenario.moveToState(Lifecycle.State.RESUMED) }
        runCatching { scenario.onActivity { TerminalSurfaces.remove(session) } }
        PageDriver.removeAnchor()
        TerminalSurfaces.clientFactory = factoryBefore
        TerminalSurfaces.enabled = enabledBefore
    }

    private fun <T> ui(block: (MainActivity) -> T): T {
        var out: Any? = null
        scenario.onActivity { out = block(it) }
        @Suppress("UNCHECKED_CAST") return out as T
    }

    private fun placeArguments(anchor: JSONObject) = """{session:'$session',anchor:${anchor},background:$background}"""

    private fun place(anchor: JSONObject) = JSONObject(PageDriver.invoke("native_terminal_surface_place", placeArguments(anchor)))
    private fun state() = JSONObject(PageDriver.invoke("native_terminal_surface_state", "{session:'$session'}"))

    private fun surfaceViews(): List<SurfaceView> = ui { activity ->
        val frame = EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup
        frame?.let { (0 until it.childCount).map(it::getChildAt).filterIsInstance<SurfaceView>() } ?: emptyList()
    }

    private fun surfaceView() = surfaceViews().firstOrNull()

    private fun screenRect(view: android.view.View) = ui { IntArray(2).also(view::getLocationOnScreen).let { Rect(it[0], it[1], it[0] + view.width, it[1] + view.height) } }

    /** Where the page's anchor is on the screen: the WebView's own origin plus the anchor in device pixels. */
    private fun expectedRect(anchor: JSONObject): Rect {
        val web = ui { screenRect(checkNotNull(EdgeGestureExclusion.webView(it.window.decorView))) }
        fun px(name: String) = (anchor.getDouble(name) * anchor.getDouble("dpr")).roundToInt()
        return Rect(web.left + px("x"), web.top + px("y"), web.left + px("x") + px("width"), web.top + px("y") + px("height"))
    }

    /** The pixel at the middle of what the surface itself holds, read from its buffer and not from the composited screen. */
    private fun centreOfSurface(view: SurfaceView): Int {
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        val done = CountDownLatch(1)
        var result = -1
        ui { PixelCopy.request(view, bitmap, { result = it; done.countDown() }, Handler(Looper.getMainLooper())) }
        assertTrue("PixelCopy answered", done.await(30, TimeUnit.SECONDS))
        assertEquals("PixelCopy succeeded", PixelCopy.SUCCESS, result)
        return bitmap.getPixel(view.width / 2, view.height / 2)
    }

    private fun awaitBackground() {
        var seen = "no surface"
        try {
            PageDriver.poll("the background on the surface") { surfaceView()?.let { view -> runCatching { centreOfSurface(view) }.onSuccess { seen = "#%08x".format(it) }.onFailure { seen = "PixelCopy failed: $it" }.getOrNull()?.let { if (it == opaque) true else null } } }
        } catch (error: AssertionError) {
            throw AssertionError("${error.message}: wanted #${"%08x".format(opaque)}, last read from the surface: $seen", error)
        }
    }

    private fun awaitReady(generation: Int) = PageDriver.poll("a ready surface of generation $generation") {
        state().takeIf { it.getBoolean("ready") && it.getInt("generation") == generation }
    }

    @Test fun theSurfaceIsPlacedAtTheDomAnchorThroughTheRendererIpcAndHoldsTheBackground() {
        val anchor = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        val placed = place(anchor)
        assertTrue(placed.getBoolean("placed"))
        val ready = awaitReady(1)
        val expected = expectedRect(anchor)
        PageDriver.poll("the surface at the anchor's screen rectangle") { surfaceView()?.let { if (PageDriver.near(screenRect(it), expected)) it else null } }
        assertEquals("the surface has the anchor's size in pixels", expected.width(), ready.getInt("width"))
        assertEquals(expected.height(), ready.getInt("height"))
        assertEquals(listOf("ready 1 ${expected.width()}x${expected.height()}"), recorder.events.toList())
        awaitBackground()
    }

    @Test fun placingAgainMovesAndResizesTheSameSurfaceWithoutANewGeneration() {
        val first = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(first)
        awaitReady(1)
        val second = PageDriver.anchor("left:20%;top:30%;width:40%;height:20%")
        place(second)
        val expected = expectedRect(second)
        PageDriver.poll("the surface at the second anchor") { surfaceView()?.let { if (PageDriver.near(screenRect(it), expected)) it else null } }
        PageDriver.poll("the resize reaching the client") { recorder.events.takeIf { it.any { event -> event.startsWith("changed 1") } } }
        assertEquals("no second surface was made", 1, state().getInt("generation"))
        assertEquals(1, surfaceViews().size)
    }

    @Test fun stopAndStartGiveTheSameSessionANewSurfaceThatIsDrawnFromItsState() {
        val anchor = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(anchor)
        awaitReady(1)
        scenario.moveToState(Lifecycle.State.CREATED)
        PageDriver.poll("the surface lost on stop") { recorder.events.takeIf { it.contains("lost 1") } }
        scenario.moveToState(Lifecycle.State.RESUMED)
        PageDriver.awaitStartPage()
        awaitReady(2)
        val expected = expectedRect(anchor)
        assertEquals("one ready per surface and one loss for the first", listOf("ready 1", "lost 1", "ready 2"), recorder.events.map { it.split(' ').take(2).joinToString(" ") })
        assertEquals("the new surface has the old size", expected.width(), state().getInt("width"))
        awaitBackground()
    }

    @Test fun activityRecreationDropsTheHostAndTheNextPagePlacesTheSameSessionAgain() {
        val anchor = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(anchor)
        awaitReady(1)
        val before = ui { it }
        scenario.recreate()
        assertFalse("the Activity was replaced", before === ui { it })
        PageDriver.awaitStartPage()
        assertTrue("the old window's surface was reported lost", recorder.events.contains("lost 1"))
        val dropped = state()
        assertFalse("nothing is shown on the new page until it places the session", dropped.getBoolean("placed") || dropped.getBoolean("ready"))
        assertNull(surfaceView())
        assertEquals("the session keeps its count", 1, dropped.getInt("generation"))
        val fresh = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(fresh)
        awaitReady(2)
        PageDriver.poll("the new surface at the anchor") { surfaceView()?.let { if (PageDriver.near(screenRect(it), expectedRect(fresh))) it else null } }
        awaitBackground()
    }

    @Test fun removingTheSessionEndsItsSurfaceAndItsCount() {
        place(PageDriver.anchor("left:10%;top:25%;width:50%;height:30%"))
        awaitReady(1)
        assertEquals("null", PageDriver.invoke("native_terminal_surface_remove", "{session:'$session'}"))
        PageDriver.poll("the surface gone") { if (surfaceView() == null) true else null }
        assertEquals(listOf("ready 1", "lost 1"), recorder.events.map { it.split(' ').take(2).joinToString(" ") })
        val gone = state()
        assertFalse(gone.getBoolean("placed"))
        assertEquals(0, gone.getInt("generation"))
        assertEquals("removing what is not there is not an error", "null", PageDriver.invoke("native_terminal_surface_remove", "{session:'$session'}"))
    }

    @Test fun aReleaseBuildRefusesAndShowsNothing() {
        TerminalSurfaces.enabled = false
        val anchor = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        assertEquals("error native_surface_disabled", PageDriver.invoke("native_terminal_surface_place", placeArguments(anchor)))
        assertNull(surfaceView())
        assertFalse(state().getBoolean("placed"))
    }

    @Test fun anAnchorThatIsNoElementIsRefusedBeforeAnythingIsCreated() {
        val empty = """{session:'$session',anchor:{x:0,y:0,width:0,height:100,dpr:2},background:$background}"""
        assertEquals("error Invalid surface anchor.", PageDriver.invoke("native_terminal_surface_place", empty))
        assertEquals("error Invalid terminal session id.", PageDriver.invoke("native_terminal_surface_state", "{session:'a b'}"))
        assertEquals("error Invalid surface background.", PageDriver.invoke("native_terminal_surface_place", """{session:'$session',anchor:{x:0,y:0,width:10,height:10,dpr:2},background:16777216}"""))
        assertNull(surfaceView())
        assertFalse(state().getBoolean("placed"))
    }
}
