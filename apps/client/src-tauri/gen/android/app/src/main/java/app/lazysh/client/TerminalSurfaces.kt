package app.lazysh.client

import android.app.Activity
import android.graphics.Color
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import java.lang.ref.WeakReference

/**
 * The `SurfaceView` of one session, stacked below the WebView (docs/architecture/android-surface-composition-poc.md). Once detached it
 * ignores the window's late callbacks, which belong to a surface its session no longer has.
 */
internal class SurfaceHost(activity: Activity, private val web: View, private val frame: FrameLayout, private val lifecycle: SurfaceLifecycle<Surface>, anchor: SurfaceAnchor) {
    val view = SurfaceView(activity)
    private var detached = false

    init {
        // Touch, focus, IME and accessibility belong to #1328 and #1329: until then the page above owns every touch and the pane is not announced.
        view.isFocusable = false
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        // A SurfaceView asks for RGB_565 unless told otherwise, which would band a terminal's colours; the pane is drawn in 8-bit channels.
        view.holder.setFormat(PixelFormat.RGBA_8888)
        view.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) { if (!detached) lifecycle.created() }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) { if (!detached) lifecycle.changed(holder.surface, width, height) }
            override fun surfaceDestroyed(holder: SurfaceHolder) { if (!detached) lifecycle.destroyed() }
        })
        // Index 0 draws first, so the WebView paints over the surface and every DOM overlay stays on top of it.
        frame.addView(view, 0, params(anchor))
    }

    /** Margins are from the padding box, so the surface moves with every inset that moves the WebView; only the page's own layout needs a new anchor. */
    fun place(anchor: SurfaceAnchor) {
        val next = params(anchor)
        val now = view.layoutParams as FrameLayout.LayoutParams
        if (now.width != next.width || now.height != next.height || now.leftMargin != next.leftMargin || now.topMargin != next.topMargin) view.layoutParams = next
    }

    private fun params(anchor: SurfaceAnchor): FrameLayout.LayoutParams {
        val at = SurfacePlacement.of(anchor, web.left, web.top, frame.paddingLeft, frame.paddingTop)
        return FrameLayout.LayoutParams(at.width, at.height, Gravity.TOP or Gravity.LEFT).apply { leftMargin = at.left; topMargin = at.top }
    }

    fun detach() {
        if (detached) return
        detached = true
        (view.parent as? ViewGroup)?.removeView(view)
        lifecycle.destroyed()
    }
}

/** Fills the surface with the pane's background: what shows before a renderer draws, and what a renderer replaces. */
internal class BackgroundPainter(private val background: () -> Int) : SurfaceClient<Surface> {
    override fun onSurfaceReady(surface: Surface, generation: Int, width: Int, height: Int) = paint(surface)
    override fun onSurfaceChanged(surface: Surface, generation: Int, width: Int, height: Int) = paint(surface)
    override fun onSurfaceLost(generation: Int) {}

    private fun paint(surface: Surface) {
        if (!surface.isValid) return
        // The window can release the surface between the check and the lock; that is a lost surface, not a failure.
        val canvas = try { surface.lockCanvas(null) } catch (_: IllegalArgumentException) { return } catch (_: Surface.OutOfResourcesException) { return }
        try { canvas.drawColor(background()) } finally { surface.unlockCanvasAndPost(canvas) }
    }
}

/** What a renderer can learn about a session's surface. `generation` is 0 until the first surface exists. */
internal data class SurfaceState(val placed: Boolean, val ready: Boolean, val generation: Int, val width: Int, val height: Int)

internal class SurfaceUnavailable(message: String) : Exception(message)

/**
 * Every session's surface, owned by the process and not by an Activity: a session keeps its generation count and its client through
 * stop and start (the window destroys and recreates the surface) and through Activity recreation, which only drops the host views; the
 * page of the new window places the session again. Which sessions may outlive their Activity is decided with the core (#1319), not
 * here. Developer-only: a release build refuses (see [enabled]). Everything runs on the UI thread.
 */
internal object TerminalSurfaces {
    /** Developer builds only until the rollout stages open the native backend (docs/architecture/terminal-migration-plan.md). */
    @JvmField var enabled: Boolean = BuildConfig.DEBUG

    /** Who draws a session's surface; the renderer replaces the default, which paints the background. */
    @JvmField var clientFactory: (background: () -> Int) -> SurfaceClient<Surface> = { BackgroundPainter(it) }

    private class Entry(factory: (() -> Int) -> SurfaceClient<Surface>) {
        var background = Color.BLACK
        var host: SurfaceHost? = null
        val lifecycle = SurfaceLifecycle(factory { background })
    }

    private val entries = HashMap<String, Entry>()
    private var watched = WeakReference<Activity>(null)

    /** Puts the session's surface at the anchor of the WebView in `activity`, creating the session on first use. `background` is `0xRRGGBB`. */
    fun place(activity: Activity, id: String, anchor: SurfaceAnchor, background: Int): SurfaceState {
        if (!enabled) throw SurfaceUnavailable("native_surface_disabled")
        val web = EdgeGestureExclusion.webView(activity.window.decorView) ?: throw SurfaceUnavailable("native_surface_no_webview")
        val frame = web.parent as? FrameLayout ?: throw SurfaceUnavailable("native_surface_no_frame")
        val entry = entries.getOrPut(id) { Entry(clientFactory) }
        val color = Color.rgb(background shr 16 and 0xff, background shr 8 and 0xff, background and 0xff)
        val repaint = entry.background != color
        entry.background = color
        watch(activity)
        val host = entry.host
        if (host != null && host.view.parent === frame) {
            host.place(anchor)
            if (repaint) entry.lifecycle.redraw()
        } else {
            host?.detach()
            entry.host = SurfaceHost(activity, web, frame, entry.lifecycle, anchor)
        }
        return state(id)
    }

    /** The session is over: its surface goes and its generation count with it. */
    fun remove(id: String) { entries.remove(id)?.host?.detach() }

    fun state(id: String): SurfaceState {
        val entry = entries[id] ?: return SurfaceState(placed = false, ready = false, generation = 0, width = 0, height = 0)
        val ready = entry.lifecycle.current
        return SurfaceState(entry.host != null, ready != null, entry.lifecycle.generation, ready?.width ?: 0, ready?.height ?: 0)
    }

    /** One observer per Activity: its destruction drops the host views of its window; the sessions wait for the next page to place them. */
    private fun watch(activity: Activity) {
        if (watched.get() === activity) return
        watched = WeakReference(activity)
        (activity as? LifecycleOwner)?.lifecycle?.addObserver(LifecycleEventObserver { _, event ->
            if (event != Lifecycle.Event.ON_DESTROY) return@LifecycleEventObserver
            for (entry in entries.values) if (entry.host?.view?.context === activity) { entry.host?.detach(); entry.host = null }
        })
    }
}
