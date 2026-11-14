package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Rect
import android.content.pm.ActivityInfo
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.MotionEvent
import android.view.PixelCopy
import android.view.Surface
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
    private val TAG = "lazysh-surface"
    private val scenario get() = NativeActivityFixture.scenario
    private val session = "surface-test"
    private val background = 0x1a2b3c
    private val opaque = background or 0xff000000.toInt()

    /** What a renderer is told, in order, while the default painter still draws the background so the surface can be read back. */
    private class Recorder(background: () -> Int) : SurfaceClient<Surface> {
        private val painter = BackgroundPainter(background)
        val events = CopyOnWriteArrayList<String>()
        /** `elapsedRealtime` of every ready call, for the latency observations. */
        val readyAt = CopyOnWriteArrayList<Long>()
        override fun onSurfaceReady(surface: Surface, generation: Int, width: Int, height: Int) { readyAt += SystemClock.elapsedRealtime(); events += "ready $generation ${width}x$height"; painter.onSurfaceReady(surface, generation, width, height) }
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
        runCatching { scenario.onActivity { it.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED } }
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
    private fun expectedRect(anchor: JSONObject, web: Rect = webRect()): Rect {
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
        val resumed = SystemClock.elapsedRealtime()
        scenario.moveToState(Lifecycle.State.RESUMED)
        PageDriver.awaitStartPage()
        awaitReady(2)
        // An observation, not a gate: the emulator or a loaded CI host says nothing about a phone (#1327 records the device matrix).
        Log.i(TAG, "stop and start: the client was told ready ${recorder.readyAt.last() - resumed} ms after RESUMED was requested")
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

    private fun contentFrame() = ui { checkNotNull(EdgeGestureExclusion.webView(it.window.decorView)?.parent as? FrameLayout) }

    private fun webRect() = ui { screenRect(checkNotNull(EdgeGestureExclusion.webView(it.window.decorView))) }

    @Test fun theSurfaceMovesWithTheInsetsThatMoveThePage() {
        val anchor = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(anchor)
        awaitReady(1)
        val frame = contentFrame()
        val webBefore = webRect()
        val resting = expectedRect(anchor, webBefore)
        try {
            // The Activity's own listener turns these into padding on the content frame, as a cutout and a docked keyboard would. The system
            // puts the real insets back within a frame, so the layout is forced in the same turn and read before that.
            val shown = WindowInsetsCompat.Builder()
                .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.of(0, 80, 0, 0))
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, 300)).build()
            val (web, surface, padding) = ui {
                ViewCompat.dispatchApplyWindowInsets(frame, shown)
                frame.measure(View.MeasureSpec.makeMeasureSpec(frame.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(frame.height, View.MeasureSpec.EXACTLY))
                frame.layout(frame.left, frame.top, frame.right, frame.bottom)
                Triple(webRect(), screenRect(checkNotNull(surfaceView())), frame.paddingTop to frame.paddingBottom)
            }
            assertEquals("the cutout and the keyboard became the frame's padding", 80 to 300, padding)
            assertTrue("the page moved down and was shortened ($webBefore to $web)", web.top > webBefore.top && web.bottom < webBefore.bottom)
            assertTrue("the surface moved with the page: $surface, wanted ${expectedRect(anchor, web)}", PageDriver.near(surface, expectedRect(anchor, web)))
            assertEquals("the surface kept its size: only the page's own layout asks for another", resting.width() to resting.height(), surface.width() to surface.height())
        } finally {
            ui { ViewCompat.requestApplyInsets(frame) }
        }
        PageDriver.poll("the page back where it was") { webRect().takeIf { PageDriver.near(it, webBefore) } }
        PageDriver.poll("the surface back at the anchor") { surfaceView()?.let { if (PageDriver.near(screenRect(it), resting)) it else null } }
        assertEquals("insets are not a new surface", 1, state().getInt("generation"))
    }

    @Test fun aTouchOverThePlacedSurfaceReachesThePageAndNeverTheSurface() {
        place(PageDriver.anchor("left:10%;top:25%;width:50%;height:30%"))
        awaitReady(1)
        val view = checkNotNull(surfaceView())
        var reachedSurface = 0
        ui { view.setOnTouchListener { _, _ -> reachedSurface++; false } }
        PageDriver.js("(() => { window.__surfacePointerdowns = 0; window.__surfaceCount = () => { window.__surfacePointerdowns++; }; document.addEventListener('pointerdown', window.__surfaceCount, true); return 1; })()")
        try {
            ui { activity ->
                val at = IntArray(2).also(view::getLocationInWindow)
                val x = at[0] + view.width / 2f
                val y = at[1] + view.height / 2f
                val now = SystemClock.uptimeMillis()
                for (action in intArrayOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                    val event = MotionEvent.obtain(now, now, action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
                    activity.window.decorView.dispatchTouchEvent(event)
                    event.recycle()
                }
            }
            PageDriver.poll("the page receiving the pointer") { PageDriver.js("window.__surfacePointerdowns").takeIf { it.toIntOrNull()?.let { count -> count > 0 } == true } }
            assertEquals("the surface receives no touch of its own", 0, reachedSurface)
        } finally {
            PageDriver.js("(() => { document.removeEventListener('pointerdown', window.__surfaceCount, true); return 1; })()")
        }
        assertFalse("the surface takes no focus, so no IME is served to it", ui { view.isFocusable || view.hasFocus() })
        assertFalse("and it is not announced as a second terminal", ui { view.isImportantForAccessibility })
    }

    @Test fun aPausedWindowThatIsStillVisibleKeepsItsSurfaceAndItsClient() {
        place(PageDriver.anchor("left:10%;top:25%;width:50%;height:30%"))
        awaitReady(1)
        scenario.moveToState(Lifecycle.State.STARTED)
        Thread.sleep(1_000)
        assertEquals("nothing is told lost or ready while the window is only paused", listOf("ready 1"), recorder.events.map { it.split(' ').take(2).joinToString(" ") })
        assertTrue(state().getBoolean("ready"))
        scenario.moveToState(Lifecycle.State.RESUMED)
        assertEquals(1, state().getInt("generation"))
        awaitBackground()
    }

    @Test fun aRotationResizesTheSameSurfaceOnceThePageHasPlacedItAgain() {
        val anchor = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(anchor)
        awaitReady(1)
        val upright = webRect()
        val wanted = if (upright.width() >= upright.height()) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        ui { it.requestedOrientation = wanted }
        PageDriver.poll("the window turning") { webRect().takeIf { it.width() != upright.width() } }
        // The page lays itself out again for the new size and places the surface at its new anchor, as the anchor tracker does.
        val turned = PageDriver.anchor("left:10%;top:25%;width:50%;height:30%")
        place(turned)
        val expected = expectedRect(turned)
        PageDriver.poll("the surface at the turned anchor") { surfaceView()?.let { if (PageDriver.near(screenRect(it), expected)) it else null } }
        PageDriver.poll("the client told of the new size") { recorder.events.takeIf { it.contains("changed 1 ${expected.width()}x${expected.height()}") } }
        assertEquals("a rotation is a resize, not a new surface", 1, state().getInt("generation"))
        assertFalse("no loss on the way", recorder.events.any { it.startsWith("lost") })
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
