package app.lazysh.client

import kotlin.math.abs
import kotlin.math.roundToInt

/** A DOM element's `getBoundingClientRect()` in CSS pixels and the page's `devicePixelRatio`, as the renderer sends it. */
internal data class SurfaceAnchor(val x: Double, val y: Double, val width: Double, val height: Double, val dpr: Double) {
    /** A real element: finite numbers, a non-empty box no larger than a GPU texture, a plausible pixel ratio and a position near the window. */
    val isValid: Boolean
        get() = listOf(x, y, width, height, dpr).all { it.isFinite() } && width > 0 && height > 0 && dpr > 0 && dpr <= MAX_DPR &&
            width * dpr <= MAX_PIXELS && height * dpr <= MAX_PIXELS && abs(x * dpr) <= MAX_PIXELS * 4 && abs(y * dpr) <= MAX_PIXELS * 4

    companion object {
        const val MAX_DPR = 8.0
        const val MAX_PIXELS = 16_384
    }
}

/** Where a surface sits in its parent `FrameLayout`: its size in pixels and its margins from the parent's padding box. */
internal data class SurfacePlacement(val width: Int, val height: Int, val left: Int, val top: Int) {
    companion object {
        /**
         * The activity pads the content frame by the system bars, the cutout and the keyboard and lays the WebView out inside that padding,
         * so a margin from the padding box is the WebView's own offset plus the anchor's, and the surface follows every inset the page does.
         */
        fun of(anchor: SurfaceAnchor, webLeft: Int, webTop: Int, paddingLeft: Int, paddingTop: Int) = SurfacePlacement(
            (anchor.width * anchor.dpr).roundToInt().coerceAtLeast(1),
            (anchor.height * anchor.dpr).roundToInt().coerceAtLeast(1),
            webLeft - paddingLeft + (anchor.x * anchor.dpr).roundToInt(),
            webTop - paddingTop + (anchor.y * anchor.dpr).roundToInt(),
        )
    }
}

/**
 * What draws a session's surface, told in order and always on the UI thread. The renderer implements it. A surface comes and goes with
 * the window (stop and start, hidden, destroyed) while the session lives on, so every [onSurfaceReady] is a request to draw the whole
 * session. A window that is paused but still visible (multi-window) keeps its surface and its session keeps drawing.
 */
internal interface SurfaceClient<S : Any> {
    /** A new surface of this size exists. `generation` rises by one for each new surface of a session, so a late callback can be told apart. */
    fun onSurfaceReady(surface: S, generation: Int, width: Int, height: Int)

    /** The same surface changed size, or the session asks for a redraw: draw the whole session again. */
    fun onSurfaceChanged(surface: S, generation: Int, width: Int, height: Int)

    /** The surface is gone: release every handle to it before this returns. Called once per [onSurfaceReady]. */
    fun onSurfaceLost(generation: Int)
}

/** A surface as it stands: valid and sized. */
internal data class SurfaceReady<S : Any>(val surface: S, val generation: Int, val width: Int, val height: Int)

/**
 * Turns the raw `SurfaceHolder` and Activity callbacks of one session into the ordered [SurfaceClient] calls: ready, then any number of
 * changed, then lost, never a change without a ready or two lost for one ready, whatever order the window
 * delivers them in. It outlives each surface and each host view, which is what keeps the generation counting through stop and start.
 */
internal class SurfaceLifecycle<S : Any>(private val client: SurfaceClient<S>) {
    private var alive = false

    /** Surfaces this session has had; the generation of the current one, or of the last one while there is none. */
    var generation = 0
        private set

    /** The current surface, or `null` while there is none. */
    var current: SurfaceReady<S>? = null
        private set

    fun created() { alive = true }

    /** `surfaceChanged` also delivers the first size after `surfaceCreated`; a zero size is no surface yet. */
    fun changed(surface: S, width: Int, height: Int) {
        if (!alive || width <= 0 || height <= 0) return
        val was = current
        current = SurfaceReady(surface, was?.generation ?: ++generation, width, height)
        when {
            was == null -> client.onSurfaceReady(surface, generation, width, height)
            was.width != width || was.height != height -> client.onSurfaceChanged(surface, was.generation, width, height)
        }
    }

    fun destroyed() {
        alive = false
        val was = current ?: return
        current = null
        client.onSurfaceLost(was.generation)
    }

    /** Asks the client to draw the whole session again on the surface that exists; nothing if there is none. */
    fun redraw() { current?.let { client.onSurfaceChanged(it.surface, it.generation, it.width, it.height) } }
}
