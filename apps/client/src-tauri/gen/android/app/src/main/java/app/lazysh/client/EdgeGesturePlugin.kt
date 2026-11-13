package app.lazysh.client

import android.app.Activity
import android.content.Context
import android.graphics.Rect
import android.os.Build
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.lang.ref.WeakReference
import kotlin.math.ceil

/** A rectangle in view pixels; kept free of android.graphics so the geometry runs as a plain JVM test. */
internal data class Band(val left: Int, val top: Int, val right: Int, val bottom: Int)

/**
 * Gesture navigation gives the system the left and right edges (Back). The app may exclude a band
 * of each edge, but Android caps the excluded height per edge at 200dp, and the bottom edge (Home)
 * cannot be excluded at all. The renderer asks for a row (top and bottom in dp) where its handle sits;
 * the band is cut to the 200dp cap and ends above the bottom gesture zone, which the WebView's
 * viewport already reaches into only as far as the live insets say (`clearBottomPx`).
 */
internal object EdgeGestureBands {
    const val MAX_HEIGHT_DP = 200
    const val HOME_SWIPE_DP = 48
    fun bands(widthPx: Int, heightPx: Int, density: Float, zoneDp: Int, left: Boolean, right: Boolean, rowTopDp: Int, rowBottomDp: Int, clearBottomPx: Int): List<Band> {
        if (widthPx < 2) return emptyList()
        val zone = (zoneDp * density).toInt().coerceIn(1, widthPx / 2)
        val bottom = minOf((rowBottomDp * density).toInt(), heightPx - clearBottomPx)
        val top = maxOf(0, (rowTopDp * density).toInt(), bottom - (MAX_HEIGHT_DP * density).toInt())
        if (bottom <= top) return emptyList()
        return listOfNotNull(
            if (left) Band(0, top, zone, bottom) else null,
            if (right) Band(widthPx - zone, top, widthPx, bottom) else null,
        )
    }

    /** dp a system zone reaches past the padding the WebView already has; rounded up, so a partial dp is never treated as free. */
    fun reach(zonePx: Int, paddingPx: Int, density: Float): Int = ceil(maxOf(0, zonePx - paddingPx) / density).toInt()

    /**
     * Gesture navigation starts Home from a taller strip than `mandatorySystemGestures()` reports: the launcher takes every touch that
     * begins in the platform's `navigation_bar_frame_height` (48dp, where the insets say 32dp), so the bottom zone is never thinner.
     */
    fun homeZone(zonePx: Int, navigation: String, homeSwipePx: Int): Int = if (navigation == "gesture") maxOf(zonePx, homeSwipePx) else zonePx

    /** `navigation_mode` is 0 (three buttons), 1 (two buttons) or 2 (gestures); where a vendor hides it, a side zone means gestures. */
    fun navigation(mode: Int, left: Int, right: Int): String = when {
        mode == 2 -> "gesture"
        mode == 0 || mode == 1 -> "buttons"
        left > 0 || right > 0 -> "gesture"
        else -> "unknown"
    }
}

/** The system gesture zones as they reach into the web viewport, in dp (CSS px). */
internal data class GestureInsets(val left: Int, val right: Int, val bottom: Int, val mandatoryBottom: Int, val navigation: String) {
    fun toJson() = """{"left":$left,"right":$right,"bottom":$bottom,"mandatoryBottom":$mandatoryBottom,"navigation":"$navigation"}"""
}

/**
 * Reads `systemGestures()` and `mandatorySystemGestures()` live. The WebView is padded by the system bars, the cutout and the keyboard,
 * so a zone only matters as far as it reaches past that padding, which is what the renderer measures its own edges against.
 */
internal object EdgeGestureInsets {
    private val padding = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
    private var webView: WeakReference<WebView>? = null
    private var last: GestureInsets? = null

    fun read(context: Context, insets: WindowInsetsCompat): GestureInsets {
        val density = context.resources.displayMetrics.density
        val gestures = insets.getInsets(WindowInsetsCompat.Type.systemGestures())
        val mandatory = insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())
        val pad = insets.getInsets(padding)
        val left = EdgeGestureBands.reach(gestures.left, pad.left, density)
        val right = EdgeGestureBands.reach(gestures.right, pad.right, density)
        val mode = try { Settings.Secure.getInt(context.contentResolver, "navigation_mode", -1) } catch (_: Exception) { -1 }
        val navigation = EdgeGestureBands.navigation(mode, left, right)
        val homePx = homeSwipePx(context, density)
        val bottom = EdgeGestureBands.reach(EdgeGestureBands.homeZone(gestures.bottom, navigation, homePx), pad.bottom, density)
        return GestureInsets(left, right, bottom, EdgeGestureBands.reach(EdgeGestureBands.homeZone(mandatory.bottom, navigation, homePx), pad.bottom, density), navigation)
    }

    private fun homeSwipePx(context: Context, density: Float): Int {
        val resources = context.resources
        val id = resources.getIdentifier("navigation_bar_frame_height", "dimen", "android")
        return if (id != 0) resources.getDimensionPixelSize(id) else (EdgeGestureBands.HOME_SWIPE_DP * density).toInt()
    }

    /** The live insets of a view's window, or none reaching in before the first layout. */
    fun read(view: View): GestureInsets {
        val root = ViewCompat.getRootWindowInsets(view) ?: return GestureInsets(0, 0, 0, 0, "unknown")
        return read(view.context, root)
    }

    fun attach(view: WebView) { webView = WeakReference(view) }

    /** Called from the activity's insets listener; the renderer hears about a change once. */
    fun update(context: Context, insets: WindowInsetsCompat) {
        val next = read(context, insets)
        if (next == last) return
        last = next
        webView?.get()?.let { view ->
            view.post { view.evaluateJavascript("window.dispatchEvent(new CustomEvent('lazysh-gesture-insets',{detail:${next.toJson()}}))", null) }
        }
    }
}

/** Applies the bands to the real view; Android reads them back as set, which the instrumented test relies on. */
internal object EdgeGestureExclusion {
    @RequiresApi(29)
    fun apply(target: View, zoneDp: Int, left: Boolean, right: Boolean, rowTopDp: Int, rowBottomDp: Int) {
        val density = target.resources.displayMetrics.density
        val inset = EdgeGestureInsets.read(target)
        val clearBottomPx = (maxOf(inset.bottom, inset.mandatoryBottom) * density).toInt()
        target.systemGestureExclusionRects = EdgeGestureBands
            .bands(target.width, target.height, density, zoneDp, left, right, rowTopDp, rowBottomDp, clearBottomPx)
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

    /** The live gesture zones, for the renderer's first read; later changes arrive as a window event. */
    @Command fun getInsets(invoke: Invoke) {
        owner.runOnUiThread {
            val insets = EdgeGestureInsets.read(owner.window.decorView)
            invoke.resolve(JSObject().apply {
                put("left", insets.left); put("right", insets.right); put("bottom", insets.bottom)
                put("mandatoryBottom", insets.mandatoryBottom); put("navigation", insets.navigation)
            })
        }
    }

    /** Rects are in view coordinates and Android drops them on every layout pass, so they follow the view. */
    @Command fun setExclusion(invoke: Invoke) {
        owner.runOnUiThread {
            val args = try { invoke.getArgs() } catch (_: Exception) { invoke.reject("edge_gesture_exclusion_unavailable"); return@runOnUiThread }
            val left = args.getBoolean("left"); val right = args.getBoolean("right"); val zoneDp = args.getInt("zoneDp")
            val rowTopDp = args.getInt("rowTopDp"); val rowBottomDp = args.getInt("rowBottomDp")
            val target = view ?: run {
                // The WebView, not the padded content frame, is what receives the edge touches.
                val found = EdgeGestureExclusion.webView(owner.window.decorView)
                view = found
                found
            }
            if (target == null || Build.VERSION.SDK_INT < 29) { invoke.resolve(); return@runOnUiThread }
            layout?.let { target.removeOnLayoutChangeListener(it) }
            layout = null
            val apply = { if (Build.VERSION.SDK_INT >= 29) EdgeGestureExclusion.apply(target, zoneDp, left, right, rowTopDp, rowBottomDp) }
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
