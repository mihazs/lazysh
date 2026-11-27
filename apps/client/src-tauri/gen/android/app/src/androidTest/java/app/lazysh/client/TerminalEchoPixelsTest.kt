package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class TerminalEchoPixelsTest {
    @Test fun aMissingFrameDoesNotReplaceTheRealDisplayObservation() {
        val frames = listOf(null, image(Color.BLACK), null, image(Color.GREEN)).iterator()
        val capture = TerminalEchoPixels(Rect(0, 0, 1, 1), frames::next)
        val latency = capture.awaitColor(Color.GREEN and 0xffffff, System.nanoTime())
        assertTrue(latency >= 0 && !frames.hasNext())
    }

    @Test(expected = IllegalStateException::class)
    fun aMissingBaselineFailsTheCapture() {
        TerminalEchoPixels(Rect(0, 0, 1, 1)) { null }
    }

    private fun image(color: Int): Bitmap =
        Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }
}
