package app.lazysh.client

import android.os.Build
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
        NativeActivityFixture.scenario.onActivity { activity ->
            val found = EdgeGestureExclusion.webView(activity.window.decorView)
            assertNotNull("the Tauri WebView is part of the window", found)
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
