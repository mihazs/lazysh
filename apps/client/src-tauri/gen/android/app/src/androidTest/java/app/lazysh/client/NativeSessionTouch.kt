package app.lazysh.client

import android.content.ClipboardManager
import android.content.Context
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import kotlin.math.abs
import kotlin.math.floor
import org.json.JSONObject
import org.junit.Assert.assertTrue

/**
 * Real fingers on a PLACED native session (#2501): touches injected into the window at the screen position of a terminal cell, so they go
 * through the WebView over the SurfaceView as a user's do, and the page's own controls tapped where they are drawn. The position of a cell
 * is the page's own arithmetic (`NativeTerminalAdapter.cellAt`): the pane's rectangle in the page and the renderer's cell, asked of the
 * shell as the page asks it (`native_terminal_surface_cell`). The text of a row is the core's (`terminal_core_text`), not the DOM's.
 */
internal class NativeSessionTouch(private val driver: NativeSessionDriver, private val session: String) {
    private val automation get() = driver.instrumentation.uiAutomation

    /** Where the pane's cells are on the screen, in screen pixels. */
    class Grid(val left: Double, val top: Double, val cellWidth: Double, val cellHeight: Double, val columns: Int, val rows: Int) {
        fun centreOf(column: Int, row: Int) = Point((left + (column + 0.5) * cellWidth).toFloat(), (top + (row + 0.5) * cellHeight).toFloat())
    }

    class Point(val x: Float, val y: Float)

    /** The CSS pixel as screen pixels, and the WebView's own origin: what a rectangle of the page measures in on the screen. */
    private fun webView() = driver.ui { activity ->
        val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) { "the WebView" }
        val origin = IntArray(2).also(web::getLocationOnScreen)
        doubleArrayOf(origin[0].toDouble(), origin[1].toDouble(), web.width.toDouble())
    }

    /** The pane and its cells. The grid the page keeps must agree with the cell the shell reports, or the touches would land beside the text. */
    fun grid(): Grid {
        val pane = JSONObject(driver.js("""(() => { const r = document.querySelector(${driver.quoted(driver.nativePane)}).getBoundingClientRect();
            return {left: r.left, top: r.top, width: r.width, view: innerWidth, dpr: devicePixelRatio}; })()"""))
        val dpr = pane.getDouble("dpr")
        // The default font size: the case changes no preference. The cell is in device pixels, a layout pixel is `dpr` of them.
        val cell = JSONObject(PageDriver.invoke("native_terminal_surface_cell", "{fontSize:14,dpr:$dpr}"))
        val (originX, originY, webWidth) = webView().let { Triple(it[0], it[1], it[2]) }
        val scale = webWidth / pane.getDouble("view")
        val cellWidth = cell.getDouble("width") / dpr
        val cellHeight = cell.getDouble("height") / dpr
        val state = JSONObject(driver.invoke("terminal_core_snapshot", session)).getJSONObject("state")
        val columns = state.getInt("columns")
        val fitted = floor(pane.getDouble("width") / cellWidth).toInt()
        assertTrue("the page's grid of $columns columns fits the pane at the shell's cell (${cell.getDouble("width")} px wide, ${pane.getDouble("width")} css px of pane): $fitted columns", abs(fitted - columns) <= 1)
        return Grid(originX + pane.getDouble("left") * scale, originY + pane.getDouble("top") * scale, cellWidth * scale, cellHeight * scale, columns, state.getInt("rows"))
    }

    /**
     * The screen row and column where `word` is printed in the row that reads exactly `row`. The core's text has one line for a line the program
     * printed, however many screen rows the terminal wrapped it over, so each line before it counts for as many rows as its width needs, and the word's
     * own offset can carry it onto a wrapped row.
     */
    fun locate(row: String, word: String): Pair<Int, Int> {
        val columns = JSONObject(driver.invoke("terminal_core_snapshot", session)).getJSONObject("state").getInt("columns")
        val lines = driver.coreText(session).lines()
        val index = lines.indexOfFirst { it.trim() == row }
        check(index >= 0) { "the row '$row' is not on the core's screen" }
        val screenRows = lines.take(index).sumOf { maxOf(1, (it.length + columns - 1) / columns) }
        val offset = lines[index].indexOf(word)
        return Pair(screenRows + offset / columns, offset % columns)
    }

    private fun inject(action: Int, downTime: Long, at: Point) {
        val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, at.x, at.y, 0)
        event.source = InputDevice.SOURCE_TOUCHSCREEN
        try { assertTrue("the touch was injected", automation.injectInputEvent(event, true)) } finally { event.recycle() }
    }

    /** One finger: down at the first point, along the others, still for `holdMs` at the last, then up. */
    fun finger(path: List<Point>, holdMs: Long) {
        val down = SystemClock.uptimeMillis()
        inject(MotionEvent.ACTION_DOWN, down, path.first())
        for (point in path.drop(1)) { Thread.sleep(30); inject(MotionEvent.ACTION_MOVE, down, point) }
        Thread.sleep(holdMs)
        inject(MotionEvent.ACTION_UP, down, path.last())
    }

    fun tap(at: Point) = finger(listOf(at), 60)

    /** A finger held still past the page's selection delay (450 ms). */
    fun longPress(at: Point) = finger(listOf(at), 900)

    /** The centre of a visible page element, in screen pixels, or null while it is not drawn. */
    fun centreOfElement(selector: String, text: String? = null): Point? {
        val found = driver.js("""(() => { const e = window.__lz.find(${driver.quoted(selector)}${text?.let { ", ${driver.quoted(it)}" } ?: ""}); if (!e) return null;
            const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, view: innerWidth}; })()""")
        if (found == "null") return null
        val box = JSONObject(found)
        val (originX, originY, webWidth) = webView().let { Triple(it[0], it[1], it[2]) }
        val scale = webWidth / box.getDouble("view")
        return Point((originX + box.getDouble("x") * scale).toFloat(), (originY + box.getDouble("y") * scale).toFloat())
    }

    /** One real tap on a page element, once it is drawn. */
    fun tapElement(selector: String, text: String? = null) = tap(PageDriver.poll("a tappable $selector ${text ?: ""}", 30) { centreOfElement(selector, text) })

    /** A finger on `from` moves in steps to `to`, as a handle is dragged. */
    fun drag(from: Point, to: Point) = finger((0..10).map { Point(from.x + (to.x - from.x) * it / 10, from.y + (to.y - from.y) * it / 10) }, 200)

    fun clipboardText(): String? = driver.ui { activity ->
        (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString()
    }

    fun awaitClipboard(expected: String) {
        try { PageDriver.poll("the system clipboard to hold exactly '$expected'", 20) { Unit.takeIf { clipboardText() == expected } } }
        catch (error: AssertionError) { throw AssertionError("${error.message}; it holds '${clipboardText()?.take(80)}'", error) }
    }

    /** SystemUI previews a copied clip over the bottom left for a few seconds, which could cover the next tap. */
    fun letTheClipboardPreviewGo() = Thread.sleep(6_000)
}
