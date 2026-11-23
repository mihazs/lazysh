package app.lazysh.client

import android.content.res.Resources
import android.view.Surface

/** The Rust renderer host's way to a surface (`native_terminal_surface/android.rs`); every call answers false when it cannot draw. */
internal interface NativeSurface<S : Any> {
    /** Draws the session on this surface from a snapshot. `background` is `0xRRGGBB`. */
    fun ready(id: String, surface: S, generation: Int, width: Int, height: Int, density: Float, background: Int): Boolean

    /** The same surface changed size, or the pane's colour did. */
    fun changed(id: String, width: Int, height: Int, density: Float, background: Int): Boolean

    /** Destroys the renderer's handles on the surface before it returns. */
    fun lost(id: String, generation: Int)

    /** The session is over. */
    fun remove(id: String)

    /** Why the host last refused this session's surface, or null when it draws or was never asked (a host that cannot tell). */
    fun reason(id: String): String? = null
}

internal object JniSurface : NativeSurface<Surface> {
    /** Absent in a build without the native terminal: the pane then shows its background. */
    private val loaded = try { System.loadLibrary("lazysh_lib"); true } catch (_: UnsatisfiedLinkError) { false }

    @JvmStatic private external fun nativeReady(id: String, surface: Surface, generation: Int, width: Int, height: Int, density: Float, background: Int): Boolean
    @JvmStatic private external fun nativeChanged(id: String, width: Int, height: Int, density: Float, background: Int): Boolean
    @JvmStatic private external fun nativeLost(id: String, generation: Int)
    @JvmStatic private external fun nativeRemove(id: String)
    @JvmStatic private external fun nativeReason(id: String): String?

    // A library built without the feature loads but has no entry points: that is the same "cannot draw".
    private inline fun <R> linked(otherwise: R, call: () -> R): R = if (!loaded) otherwise else try { call() } catch (_: UnsatisfiedLinkError) { otherwise }

    override fun ready(id: String, surface: Surface, generation: Int, width: Int, height: Int, density: Float, background: Int) =
        linked(false) { nativeReady(id, surface, generation, width, height, density, background) }
    override fun changed(id: String, width: Int, height: Int, density: Float, background: Int) = linked(false) { nativeChanged(id, width, height, density, background) }
    override fun lost(id: String, generation: Int) = linked(Unit) { nativeLost(id, generation) }
    override fun remove(id: String) = linked(Unit) { nativeRemove(id) }
    // Without the library the answer is the reason there is no renderer at all.
    override fun reason(id: String): String? = if (!loaded) "this build has no native terminal library" else linked("this build has no native terminal renderer") { nativeReason(id) }
}

/**
 * Draws a session's surface with the renderer host and falls back to `fallback` (the pane background) whenever the host cannot: no native
 * build, no GPU, no native core for the session. Once the host has refused a surface, that surface and its size changes stay with the fallback.
 */
internal class NativeSurfaceClient<S : Any>(
    private val id: String,
    private val background: () -> Int,
    private val native: NativeSurface<S>,
    private val fallback: SurfaceClient<S>,
    private val density: () -> Float = { Resources.getSystem().displayMetrics.density },
    /** Where the stages go: logcat in the app (`lazysh-native`), nowhere in a JVM test. */
    private val log: (String) -> Unit = {},
) : SurfaceClient<S>, AutoCloseable {
    /** Whether the renderer host draws on the surface the session has now, and why not when it does not (what the page shows in place of a blank pane). */
    var drawing = false
        private set
    val refusal: String? get() = if (drawing) null else native.reason(id) ?: "the renderer did not draw on the surface"

    override fun onSurfaceReady(surface: S, generation: Int, width: Int, height: Int) {
        drawing = native.ready(id, surface, generation, width, height, density(), background())
        log("surface of $id #$generation ${width}x$height: ${if (drawing) "the renderer draws" else "the pane background only: $refusal"}")
        if (!drawing) fallback.onSurfaceReady(surface, generation, width, height)
    }

    override fun onSurfaceChanged(surface: S, generation: Int, width: Int, height: Int) {
        if (drawing) drawing = native.changed(id, width, height, density(), background())
        // A host that gave up on the resize left nothing on the surface: the pane background shows until the next surface.
        if (!drawing) fallback.onSurfaceChanged(surface, generation, width, height)
    }

    override fun onSurfaceLost(generation: Int) {
        if (drawing) native.lost(id, generation) else fallback.onSurfaceLost(generation)
        drawing = false
    }

    override fun close() = native.remove(id)
}
