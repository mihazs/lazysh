package app.lazysh.client

import android.app.Activity
import android.graphics.Color
import android.graphics.PixelFormat
import android.util.Log
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
import java.lang.ref.WeakReference
import java.util.WeakHashMap

/**
 * The `SurfaceView` of one session, stacked below the WebView (docs/architecture/android-surface-composition-poc.md). Once detached it
 * ignores the window's late callbacks, which belong to a surface its session no longer has.
 */
internal class SurfaceHost(activity: Activity, val web: View, private val frame: FrameLayout, private val lifecycle: SurfaceLifecycle<Surface>, anchor: SurfaceAnchor, relay: InputRelay) {
    val view = SurfaceView(activity)
    /** The keyboard's editor for this session (#1328): a one-pixel invisible view that takes focus and the `InputConnection`; the page never types into a DOM editor here. */
    val input = TerminalInputView(activity, relay, onComposing = relay::preedit).apply { alpha = 0f; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
    private var detached = false
    private var pendingInputFocus: Runnable? = null

    init {
        // The page above owns every touch and the pane is not announced (#1329); the keyboard goes to [input], not to this view.
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
        frame.addView(input, FrameLayout.LayoutParams(1, 1, Gravity.TOP or Gravity.LEFT))
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

    fun focusInput(focused: Boolean, keyboard: Boolean, ifIdle: Boolean) {
        if (!focused && ifIdle && (!input.hasFocus() || !input.hasWindowFocus() || !input.editor.canDismissKeyboard))
            throw SurfaceUnavailable("native_surface_input_busy")
        cancelInputFocus()
        val imm = input.context.getSystemService(InputMethodManager::class.java)
        if (!focused) {
            input.clearFocus()
            web.requestFocus()
            if (keyboard) imm?.hideSoftInputFromWindow(input.windowToken, 0)
            return
        }
        // A WebView touch can restore its own focus while the event is still being dispatched.
        // Transfer focus after the touch settles, and retry once when Android has updated its served view.
        val request = Runnable {
            if (!input.isAttachedToWindow || !input.hasWindowFocus()) return@Runnable
            if (!input.hasFocus()) input.requestFocus()
            if (input.hasFocus()) imm?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
        }
        pendingInputFocus = request
        input.post(request)
        input.postDelayed(request, 150)
    }

    private fun cancelInputFocus() {
        pendingInputFocus?.let(input::removeCallbacks)
        pendingInputFocus = null
    }

    fun detach() {
        if (detached) return
        detached = true
        cancelInputFocus()
        (view.parent as? ViewGroup)?.removeView(view)
        (input.parent as? ViewGroup)?.removeView(input)
        lifecycle.destroyed()
    }
}

/**
 * Makes the WebView see-through while at least one native pane is placed beside it, and opaque again when none is. The surfaces are below the
 * WebView, so the page can show one only where it paints nothing (`TerminalNativeSurface.css` clears every ancestor of a native pane), and a
 * WebView's own background is opaque white unless it is told otherwise. An xterm.js session never places a surface, so its WebView is never touched,
 * and a page that paints its own background (every page but a native pane) looks the same either way.
 */
internal object SeeThrough {
    /** The WebViews made transparent. A recreated Activity has a new WebView, which starts opaque and is made transparent when its page places the session again. */
    private val made = WeakHashMap<View, Boolean>()

    fun set(web: View, seeThrough: Boolean) {
        val webView = web as? WebView ?: return
        if (seeThrough && made.put(web, true) == null) webView.setBackgroundColor(Color.TRANSPARENT)
        // shortcut: opaque white is the WebView's own default (wry sets no background colour); read it back if the app ever configures one.
        else if (!seeThrough && made.remove(web) != null) webView.setBackgroundColor(Color.WHITE)
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
internal data class SurfaceState(val placed: Boolean, val ready: Boolean, val generation: Int, val width: Int, val height: Int, val drawing: Boolean? = null, val reason: String? = null)

internal class SurfaceUnavailable(message: String) : Exception(message)

/**
 * Every session's surface, owned by the process and not by an Activity: a session keeps its generation count and its client through
 * stop and start (the window destroys and recreates the surface) and through Activity recreation, which only drops the host views; the
 * page of the new window places the session again. Which sessions may outlive their Activity is decided with the core (#1319), not
 * here. Open to release builds: the page asks for a surface only for a session whose backend the registry selected, which Auto never does (native is not
 * auto-eligible), so a surface exists only when the user picked Native, the probe passed and the build kill switch is off (see [enabled]). Everything runs on the UI thread.
 */
internal object TerminalSurfaces {
    /** True in every build; the choice, the probe and the kill switch (`LAZYSH_NATIVE_TERMINAL=off`, refused in Rust) decide who reaches it. Tests turn it off to hold the refusal. */
    @JvmField var enabled: Boolean = true

    /** Who draws a session's surface, given its id and the pane's background. The default is the Rust renderer host, which paints the background when it cannot draw. */
    @JvmField var clientFactory: (id: String, background: () -> Int) -> SurfaceClient<Surface> =
        { id, background -> NativeSurfaceClient(id, background, JniSurface, BackgroundPainter(background), log = { Log.i("lazysh-native", it) }) }

    private class Entry(id: String, factory: (String, () -> Int) -> SurfaceClient<Surface>) {
        var background = Color.BLACK
        var host: SurfaceHost? = null
        val client = factory(id) { background }
        val lifecycle = SurfaceLifecycle(client)
        val relay = InputRelay()
    }

    private val entries = HashMap<String, Entry>()
    private var watched = WeakReference<Activity>(null)

    /** Puts the session's surface at the anchor of the WebView in `activity`, creating the session on first use. `background` is `0xRRGGBB`. */
    fun place(activity: Activity, id: String, anchor: SurfaceAnchor, background: Int): SurfaceState {
        if (!enabled) throw SurfaceUnavailable("native_surface_disabled")
        val web = EdgeGestureExclusion.webView(activity.window.decorView) ?: throw SurfaceUnavailable("native_surface_no_webview")
        val frame = web.parent as? FrameLayout ?: throw SurfaceUnavailable("native_surface_no_frame")
        val entry = entries.getOrPut(id) { Entry(id, clientFactory) }
        val color = Color.rgb(background shr 16 and 0xff, background shr 8 and 0xff, background and 0xff)
        val repaint = entry.background != color
        entry.background = color
        watch(activity)
        val host = entry.host
        if (host != null && host.view.parent === frame) {
            host.place(anchor)
            if (repaint) entry.lifecycle.redraw()
        } else {
            host?.let { release(it) }
            entry.host = SurfaceHost(activity, web, frame, entry.lifecycle, anchor, entry.relay)
        }
        SeeThrough.set(web, true)
        return state(id)
    }

    /** The sessions the page has placed or that have a client: the ones an instrumentation case can look at. */
    fun ids(): Set<String> = entries.keys.toSet()

    /** The session is over: its surface goes and its generation count with it. */
    fun remove(id: String) {
        val entry = entries.remove(id) ?: return
        entry.host?.let { release(it) }
        entry.relay.clear()
        (entry.client as? AutoCloseable)?.close()
    }

    /** Detaches a host, and gives the WebView its opaque background back when no other session is placed beside it. */
    private fun release(host: SurfaceHost) {
        host.detach()
        if (entries.values.none { it.host?.web === host.web }) SeeThrough.set(host.web, false)
    }

    /** What the keyboard typed since the last call, once, in order; waits for the next input when there is none. */
    fun takeInput(id: String, deliver: (List<SurfaceInput>) -> Unit) {
        (entries[id] ?: throw SurfaceUnavailable("native_surface_session")).relay.take(deliver)
    }

    /**
     * Gives the session's keyboard editor focus and opens the soft keyboard, or takes focus away: the editor hands Android's view focus
     * back to the WebView, so a field of the page (the composer, a dialog, the search box) is the one the keyboard types into, and the
     * keyboard closes unless `keyboard` is false (the page took the keyboard itself).
     */
    fun focus(id: String, focused: Boolean, keyboard: Boolean = true, ifIdle: Boolean = false) {
        val host = entries[id]?.host ?: throw SurfaceUnavailable("native_surface_session")
        host.focusInput(focused, keyboard, ifIdle)
    }

    fun state(id: String): SurfaceState {
        val entry = entries[id] ?: return SurfaceState(placed = false, ready = false, generation = 0, width = 0, height = 0)
        val ready = entry.lifecycle.current
        // Only the renderer client can say whether it drew; a surface that is not there yet says nothing, and a test's client has no opinion.
        val client = if (ready != null) entry.client as? NativeSurfaceClient<*> else null
        return SurfaceState(entry.host != null, ready != null, entry.lifecycle.generation, ready?.width ?: 0, ready?.height ?: 0, client?.drawing, client?.refusal)
    }

    /** One observer per Activity: its destruction drops the host views of its window; the sessions wait for the next page to place them. */
    private fun watch(activity: Activity) {
        if (watched.get() === activity) return
        watched = WeakReference(activity)
        (activity as? LifecycleOwner)?.lifecycle?.addObserver(LifecycleEventObserver { _, event ->
            if (event != Lifecycle.Event.ON_DESTROY) return@LifecycleEventObserver
            for (entry in entries.values) if (entry.host?.view?.context === activity) { val gone = entry.host; entry.host = null; gone?.let { release(it) } }
        })
    }
}
