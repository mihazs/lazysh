package app.lazysh.client

import android.app.Activity
import android.graphics.Rect
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.annotation.RequiresApi
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** A rectangle in view pixels; kept free of android.graphics so the geometry runs as a plain JVM test. */
internal data class Band(val left: Int, val top: Int, val right: Int, val bottom: Int)

/**
 * Gesture navigation gives the system the left and right edges (Back). The app may exclude a band
 * of each edge, but Android caps the excluded height per edge at 200dp, and the bottom edge (Home)
 * cannot be excluded at all. The bands sit in the lower part of the screen, clear of the vertical
 * middle where the thumb rests and where the system keeps Back reliable, and end ABOVE_BOTTOM_DP
 * above the view's bottom edge so the Home gesture keeps its corner. The WebView is already padded
 * above the system gesture bar, so the bottom swipe starts in its lowest zone, not in a rect.
 */
internal object EdgeGestureBands {
    const val MAX_HEIGHT_DP = 200
    const val ABOVE_BOTTOM_DP = 72
    fun bands(widthPx: Int, heightPx: Int, density: Float, zoneDp: Int, left: Boolean, right: Boolean): List<Band> {
        if (widthPx < 2) return emptyList()
        val zone = (zoneDp * density).toInt().coerceIn(1, widthPx / 2)
        val bottom = heightPx - (ABOVE_BOTTOM_DP * density).toInt()
        val top = maxOf(0, bottom - minOf((MAX_HEIGHT_DP * density).toInt(), heightPx / 3))
        if (bottom <= top) return emptyList()
        return listOfNotNull(
            if (left) Band(0, top, zone, bottom) else null,
            if (right) Band(widthPx - zone, top, widthPx, bottom) else null,
        )
    }
}

/** Applies the bands to the real view; Android reads them back as set, which the instrumented test relies on. */
internal object EdgeGestureExclusion {
    @RequiresApi(29)
    fun apply(target: View, zoneDp: Int, left: Boolean, right: Boolean) {
        target.systemGestureExclusionRects = EdgeGestureBands
            .bands(target.width, target.height, target.resources.displayMetrics.density, zoneDp, left, right)
            .map { Rect(it.left, it.top, it.right, it.bottom) }
    }

    fun webView(root: View): View? {
        if (root is WebView) return root
        if (root is ViewGroup) for (index in 0 until root.childCount) webView(root.getChildAt(index))?.let { return it }
        return null
    }
}

@TauriPlugin
class EdgeGesturePlugin(private val owner: Activity) : Plugin(owner) {
    private var layout: View.OnLayoutChangeListener? = null
    private var view: View? = null

    /** Rects are in view coordinates and Android drops them on every layout pass, so they follow the view. */
    @Command fun setExclusion(invoke: Invoke) {
        owner.runOnUiThread {
            val args = try { invoke.getArgs() } catch (_: Exception) { invoke.reject("edge_gesture_exclusion_unavailable"); return@runOnUiThread }
            val left = args.getBoolean("left"); val right = args.getBoolean("right"); val zoneDp = args.getInt("zoneDp")
            val target = view ?: run {
                // The WebView, not the padded content frame, is what receives the edge touches.
                val found = EdgeGestureExclusion.webView(owner.window.decorView)
                view = found
                found
            }
            if (target == null || Build.VERSION.SDK_INT < 29) { invoke.resolve(); return@runOnUiThread }
            layout?.let { target.removeOnLayoutChangeListener(it) }
            layout = null
            val apply = { if (Build.VERSION.SDK_INT >= 29) EdgeGestureExclusion.apply(target, zoneDp, left, right) }
            apply()
            if (left || right) {
                val listener = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> apply() }
                target.addOnLayoutChangeListener(listener)
                layout = listener
            }
            invoke.resolve()
        }
    }
}
