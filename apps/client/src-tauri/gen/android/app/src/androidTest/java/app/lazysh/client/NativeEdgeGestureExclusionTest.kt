package app.lazysh.client

import android.os.Build
import android.os.SystemClock
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real WebView accepts the claimed bands and hands the edges back. Whether the system Back
 * gesture then stays quiet in the band depends on the device's navigation mode and needs a
 * gesture-navigation device; this proves the platform-side contract only.
 */
@RunWith(AndroidJUnit4::class)
class NativeEdgeGestureExclusionTest {
    @Test fun webViewKeepsTheClaimedBandsWithinItsBoundsAndReleasesThem() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        // Tauri attaches its WebView after the activity is resumed, so wait for it instead of racing it.
        var found: View? = null
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (found == null && SystemClock.uptimeMillis() < deadline) {
            NativeActivityFixture.scenario.onActivity { found = EdgeGestureExclusion.webView(it.window.decorView) }
            if (found == null) Thread.sleep(250)
        }
        assertNotNull("the Tauri WebView is part of the window", found)
        NativeActivityFixture.scenario.onActivity {
            val webView = found!!
            EdgeGestureExclusion.apply(webView, 24, left = true, right = true)
            val claimed = webView.systemGestureExclusionRects
            // A view that has not been laid out yet has no size to claim from; the plugin re-applies on layout.
            if (webView.width > 0 && webView.height > 0) {
                assertEquals(2, claimed.size)
                for (rect in claimed) {
                    assertTrue(rect.left >= 0 && rect.right <= webView.width && rect.top >= 0 && rect.bottom <= webView.height)
                    assertTrue("a thin edge band, not the whole screen", rect.width() < webView.width / 4)
                }
            }
            EdgeGestureExclusion.apply(webView, 24, left = false, right = false)
            assertTrue(webView.systemGestureExclusionRects.isEmpty())
        }
    }
}
