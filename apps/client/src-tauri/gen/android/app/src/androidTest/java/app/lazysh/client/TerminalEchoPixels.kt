package app.lazysh.client

import android.app.UiAutomation
import android.graphics.Rect

/** Samples the composited Android display. The first matching capture is an upper bound on visibility. */
internal class TerminalEchoPixels(private val automation: UiAutomation, bounds: Rect) {
    private val bounds = Rect(bounds)
    private var initialized = false
    private val before = pixels()
    private var previousInk = 0

    private fun pixels(): IntArray {
        val image = checkNotNull(automation.takeScreenshot()) { "Android display capture failed" }
        return try {
            if (!initialized) {
                check(bounds.intersect(0, 0, image.width, image.height)) { "Terminal echo rows are outside the Android display" }
                initialized = true
            }
            val width = bounds.width()
            val height = bounds.height()
            IntArray(width * height).also {
                image.getPixels(it, 0, width, bounds.left, bounds.top, width, height)
            }
        } finally {
            image.recycle()
        }
    }

    fun awaitEcho(dispatchedAt: Double): Double {
        val deadline = System.nanoTime() + 5_000_000_000L
        do {
            val pixels = pixels()
            val capturedAt = System.nanoTime() / 1e6
            val ink = pixels.indices.count { pixels[it] != before[it] }
            if (ink > previousInk) {
                previousInk = ink
                return capturedAt - dispatchedAt
            }
        } while (System.nanoTime() < deadline)
        throw AssertionError("The next glyph did not become visible in the captured terminal rows")
    }
}
