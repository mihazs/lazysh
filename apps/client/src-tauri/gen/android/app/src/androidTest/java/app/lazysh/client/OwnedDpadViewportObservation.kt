package app.lazysh.client

import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.Window
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject

/** Test-only, query-only D-pad observation. Never changes focus, insets or input. */
internal class OwnedDpadViewportObservation(
    private val window: Window,
    private val web: WebView,
    private val epoch: Long,
) : Window.Callback by checkNotNull(window.callback) {
    private val original = checkNotNull(window.callback)
    private val root = window.decorView
    private val rows = JSONArray()
    private val added = mutableListOf<View>()
    private var installed = false
    private var active = false
    private var held = false
    private var overflow = false
    private var attempts = 0
    private var lastGeometry: String? = null
    private val layout = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
        if (active && held) runCatching { sample("layout", true) }
    }
    companion object {
        fun project(phase: String, at: Long, ime: Boolean?, bottom: Int?, web: List<Int>?, root: List<Int>?, frame: List<Int>?): JSONObject {
            require(phase in listOf("down-before", "down-after", "move-before", "move-after", "up-before", "up-after", "cancel-before", "cancel-after", "layout"))
            require(at in 0..65_535)
            val complete = ime != null && bottom != null && bottom in 0..65_535 &&
                listOf(web, root, frame).all { it != null && it.size == 4 && it.all { value -> value in -65_535..65_535 } } &&
                web!![2] > 0 && web[3] > 0 && root!![2] > 0 && root[3] > 0 && frame!![2] > frame[0] && frame[3] > frame[1]
            val row = JSONObject().put("phase", phase).put("atMs", at).put("state", if (complete) "observed" else "unavailable")
            if (complete) row.put("ime", if (ime == true) "visible" else "hidden").put("imeBottom", bottom)
                .put("web", JSONArray(web)).put("root", JSONArray(root)).put("frame", JSONArray(frame))
            return row
        }
    }
    fun install(): Boolean {
        if (active || installed || added.isNotEmpty()) return false
        return try {
            check(window.callback === original && web.rootView === root && web.isAttachedToWindow && root.isAttachedToWindow)
            for (view in listOf<View>(web, root).distinct()) { view.addOnLayoutChangeListener(layout); added.add(view) }
            window.callback = this; installed = true; active = true; true
        } catch (_: Throwable) { close(); false }
    }
    private fun sample(phase: String, dedup: Boolean = false) {
        if (!active) return
        if (attempts++ >= 32) { overflow = true; return }
        val at = (SystemClock.uptimeMillis() - epoch).coerceIn(0, 65_535)
        val row = try {
            check(window.callback === this && web.rootView === root && window.decorView === root && web.isAttachedToWindow && root.isAttachedToWindow)
            val webPoint = IntArray(2); val rootPoint = IntArray(2); val frame = Rect()
            web.getLocationOnScreen(webPoint); root.getLocationOnScreen(rootPoint); web.getWindowVisibleDisplayFrame(frame)
            val insets = ViewCompat.getRootWindowInsets(root)
            val value = project(phase, at, insets?.isVisible(WindowInsetsCompat.Type.ime()), insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom,
                listOf(webPoint[0], webPoint[1], web.width, web.height), listOf(rootPoint[0], rootPoint[1], root.width, root.height),
                listOf(frame.left, frame.top, frame.right, frame.bottom))
            check(window.callback === this && web.rootView === root && window.decorView === root && web.isAttachedToWindow && root.isAttachedToWindow)
            value
        } catch (_: Throwable) { project(phase, at, null, null, null, null, null) }
        val geometry = JSONObject(row.toString()).apply { remove("phase"); remove("atMs") }.toString()
        synchronized(rows) {
            if (!dedup || geometry != lastGeometry) {
                if (rows.length() < 16) rows.put(row) else overflow = true
                lastGeometry = geometry
            }
        }
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val action = runCatching { when (event.actionMasked) { MotionEvent.ACTION_DOWN -> "down"; MotionEvent.ACTION_MOVE -> "move"; MotionEvent.ACTION_UP -> "up"; MotionEvent.ACTION_CANCEL -> "cancel"; else -> null } }.getOrNull()
        val owned = runCatching { active && event.downTime == epoch && event.pointerCount == 1 && event.getPointerId(0) == 0 &&
            event.getToolType(0) == MotionEvent.TOOL_TYPE_FINGER && event.isFromSource(android.view.InputDevice.SOURCE_TOUCHSCREEN) }.getOrDefault(false)
        if (owned && action == "down") held = true
        val observe = owned && held && action != null
        if (observe) runCatching { sample("$action-before") }
        try { return original.dispatchTouchEvent(event) }
        finally {
            if (observe) runCatching { sample("$action-after") }
            if (owned && (action == "up" || action == "cancel")) held = false
        }
    }
    fun failureSummary(): String = synchronized(rows) {
        JSONObject().put("state", if (installed) "observed" else "unavailable").put("overflow", overflow)
            .put("epoch", "owned-native-uptime").put("events", JSONArray(rows.toString())).toString()
    }
    fun close() {
        active = false; held = false
        var failure: Throwable? = null
        val pending = mutableListOf<View>()
        for (view in added.toList()) try { view.removeOnLayoutChangeListener(layout) } catch (error: Throwable) { pending.add(view); if (failure == null) failure = error else failure!!.addSuppressed(error) }
        added.clear(); added.addAll(pending)
        if (installed) {
            if (window.callback === this) { window.callback = original; installed = false }
            else { val error = IllegalStateException("Owned D-pad viewport callback changed"); if (failure == null) failure = error else failure!!.addSuppressed(error) }
        }
        failure?.let { throw it }
    }
}
