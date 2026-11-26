package app.lazysh.client

import android.app.UiAutomation
import android.graphics.Bitmap
import android.graphics.Rect

/** Samples the composited Android display. The first matching capture is an upper bound on visibility. */
internal class TerminalEchoPixels(bounds: Rect, private val capture: () -> Bitmap?) {
    constructor(automation: UiAutomation, bounds: Rect) : this(bounds, automation::takeScreenshot)

    private val bounds = Rect(bounds)
    private var initialized = false
    private val before = pixels(System.nanoTime() + 500_000_000L)
    private var previousInk = 0

    private fun pixels(deadline: Long): IntArray {
        var frame = capture()
        while (frame == null && System.nanoTime() < deadline) {
            Thread.sleep(5)
            frame = capture()
        }
        val image = checkNotNull(frame) { "Android display capture failed before the deadline" }
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

    fun awaitColor(rgb: Int, started: Long): Double {
        fun matches(pixels: IntArray) = pixels.any { it and 0xffffff == rgb }
        check(!matches(before)) { "The stream completion color was visible before release" }
        val deadline = System.nanoTime() + 15_000_000_000L
        do {
            val sample = pixels(deadline)
            val captured = System.nanoTime()
            if (matches(sample)) return (captured - started) / 1_000_000.0
        } while (System.nanoTime() < deadline)
        throw AssertionError("The stream completion color did not reach the captured display")
    }
    fun awaitEcho(dispatchedAt: Double): Double {
        val deadline = System.nanoTime() + 5_000_000_000L
        do {
            val pixels = pixels(deadline)
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
