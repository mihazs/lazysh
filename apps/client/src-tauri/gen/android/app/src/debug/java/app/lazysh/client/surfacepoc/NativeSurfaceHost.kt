package app.lazysh.client.surfacepoc

import android.content.Context
import android.graphics.Color
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.os.Bundle
import android.view.Gravity
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.FrameLayout
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.roundToInt

/*
 * Debug-only composition proof of concept (#1310). It answers where a native terminal surface can sit
 * relative to the Tauri WebView; it draws a solid colour with plain Android APIs, no wgpu and no
 * terminal. The src/debug source set keeps it out of every release build, and nothing reaches it
 * from the app: only instrumentation attaches it. A Tauri command would only carry [Anchor] to [place].
 */

/** Stand-in for one terminal session's state: owned by the process, never by a surface or an Activity. */
class PocSession {
    val frames = AtomicInteger()
    /** What the next frame shows; a real session would hold the VT screen here. */
    @Volatile var colour = Color.MAGENTA
}

/** Where the native surface is stacked relative to the WebView in the content FrameLayout. */
enum class Strategy { SURFACE_BELOW, SURFACE_ABOVE, TEXTURE_BELOW }

/** A DOM element's getBoundingClientRect() in CSS pixels plus window.devicePixelRatio, as the renderer would send it. */
data class Anchor(val x: Double, val y: Double, val width: Double, val height: Double, val dpr: Double)

/** Text a screen reader should hear; the pixels of a surface carry no semantics of their own. */
const val POC_TEXT = "poc line"

private const val ROW_ID = 1

class NativeSurfaceHost(
    context: Context,
    val strategy: Strategy,
    private val session: PocSession,
) {
    val created = AtomicInteger()
    val destroyed = AtomicInteger()
    val touches = AtomicInteger()
    /** Draws that found no valid surface; a renderer must never see this above zero. */
    val invalidDraws = AtomicInteger()
    val sizes = CopyOnWriteArrayList<String>()

    private val surfaceView = object : SurfaceView(context) {
        override fun onCheckIsTextEditor() = true
        override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
            outAttrs.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN
            return BaseInputConnection(this, false)
        }
    }
    private val textureView = TextureView(context)
    val view: View = if (strategy == Strategy.TEXTURE_BELOW) textureView else surfaceView

    init {
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.setOnTouchListener { _, _ -> touches.incrementAndGet(); true }
        view.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        view.setAccessibilityDelegate(object : View.AccessibilityDelegate() {
            override fun getAccessibilityNodeProvider(host: View) = provider
        })
        if (strategy == Strategy.SURFACE_ABOVE) surfaceView.setZOrderOnTop(true)
        surfaceView.holder.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) { created.incrementAndGet(); draw(holder.surface) }
            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) { sizes.add("${width}x$height"); draw(holder.surface) }
            override fun surfaceDestroyed(holder: SurfaceHolder) { destroyed.incrementAndGet() }
        })
        textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                created.incrementAndGet(); sizes.add("${width}x$height")
                val surface = Surface(texture); try { draw(surface) } finally { surface.release() }
            }
            override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) { sizes.add("${width}x$height") }
            override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean { destroyed.incrementAndGet(); return true }
            override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}
        }
    }

    /** Draws the current session state again, as a renderer does when it resumes without a new surface. */
    fun redraw() { if (strategy != Strategy.TEXTURE_BELOW) draw(surfaceView.holder.surface) }

    private fun draw(surface: Surface) {
        if (!surface.isValid) { invalidDraws.incrementAndGet(); return }
        val canvas = surface.lockCanvas(null)
        canvas.drawColor(session.colour)
        surface.unlockCanvasAndPost(canvas)
        session.frames.incrementAndGet()
    }

    /** Below the WebView means earlier in draw order, so the WebView paints over the surface and DOM overlays stay on top. */
    fun attach(parent: ViewGroup, anchorView: View, anchor: Anchor) {
        val below = strategy != Strategy.SURFACE_ABOVE
        parent.addView(view, if (below) 0 else parent.childCount, FrameLayout.LayoutParams(1, 1))
        place(parent, anchorView, anchor)
    }

    /** Margins are relative to the parent's padding box, which is where the insets listener puts the WebView. */
    fun place(parent: ViewGroup, anchorView: View, anchor: Anchor) {
        view.layoutParams = FrameLayout.LayoutParams(
            (anchor.width * anchor.dpr).roundToInt().coerceAtLeast(1),
            (anchor.height * anchor.dpr).roundToInt().coerceAtLeast(1),
            Gravity.TOP or Gravity.START,
        ).apply {
            leftMargin = anchorView.left - parent.paddingLeft + (anchor.x * anchor.dpr).roundToInt()
            topMargin = anchorView.top - parent.paddingTop + (anchor.y * anchor.dpr).roundToInt()
        }
    }

    fun detach() { (view.parent as? ViewGroup)?.removeView(view) }

    private val provider = object : AccessibilityNodeProvider() {
        override fun createAccessibilityNodeInfo(virtualViewId: Int): AccessibilityNodeInfo? {
            if (virtualViewId == AccessibilityNodeProvider.HOST_VIEW_ID) {
                val info = AccessibilityNodeInfo.obtain(view)
                view.onInitializeAccessibilityNodeInfo(info)
                info.addChild(view, ROW_ID)
                return info
            }
            if (virtualViewId != ROW_ID) return null
            val bounds = IntArray(2).also { view.getLocationOnScreen(it) }
            return AccessibilityNodeInfo.obtain().apply {
                setSource(view, ROW_ID); setParent(view)
                packageName = view.context.packageName; className = "android.widget.TextView"; text = POC_TEXT
                isVisibleToUser = true; isEnabled = true
                setBoundsInScreen(Rect(bounds[0], bounds[1], bounds[0] + view.width, bounds[1] + view.height))
            }
        }

        override fun performAction(virtualViewId: Int, action: Int, arguments: Bundle?) = false
    }
}
