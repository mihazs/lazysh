package app.lazysh.client

import android.os.Build
import android.os.SystemClock
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
    /** Tauri attaches its WebView after the activity is resumed, so wait for it instead of racing it. */
    private fun awaitWebView(): View {
        var found: View? = null
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (found == null && SystemClock.uptimeMillis() < deadline) {
            NativeActivityFixture.scenario.onActivity { found = EdgeGestureExclusion.webView(it.window.decorView) }
            if (found == null) Thread.sleep(250)
        }
        assertNotNull("the Tauri WebView is part of the window", found)
        return found!!
    }

    @Test fun webViewKeepsTheClaimedBandsWithinItsBoundsAndReleasesThem() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        val found = awaitWebView()
        NativeActivityFixture.scenario.onActivity {
            val webView = found
            // Ask for the whole height: the shell must cut it to 200dp and keep it clear of the bottom gesture zone.
            val heightDp = (webView.height / webView.resources.displayMetrics.density).toInt()
            EdgeGestureExclusion.apply(webView, 24, left = true, right = true, rowTopDp = 0, rowBottomDp = heightDp)
            val claimed = webView.systemGestureExclusionRects
            // A view that has not been laid out yet has no size to claim from; the plugin re-applies on layout.
            if (webView.width > 0 && webView.height > 0) {
                assertEquals(2, claimed.size)
                for (rect in claimed) {
                    assertTrue(rect.left >= 0 && rect.right <= webView.width && rect.top >= 0 && rect.bottom <= webView.height)
                    assertTrue("a thin edge band, not the whole screen", rect.width() < webView.width / 4)
                    assertTrue("Android caps the excluded height at 200dp", rect.height() <= 200 * webView.resources.displayMetrics.density + 1)
                }
            }
            EdgeGestureExclusion.apply(webView, 24, left = false, right = false, rowTopDp = 0, rowBottomDp = heightDp)
            assertTrue(webView.systemGestureExclusionRects.isEmpty())
        }
    }

    @Test fun theShellReportsInsetsThatMatchTheWindowAndNeverNegative() {
        val found = awaitWebView()
        NativeActivityFixture.scenario.onActivity {
            val density = found.resources.displayMetrics.density
            val windowInsets = ViewCompat.getRootWindowInsets(found)
            // Gesture navigation, three buttons or none: the bands exist only as far as the live insets say, and never leave the window.
            val insets = EdgeGestureInsets.read(found)
            assertTrue(insets.left >= 0 && insets.right >= 0 && insets.bottom >= 0 && insets.mandatoryBottom >= 0)
            assertTrue(insets.navigation in setOf("gesture", "buttons", "unknown"))
            if (windowInsets != null) {
                val gestures = windowInsets.getInsets(WindowInsetsCompat.Type.systemGestures())
                // A zone reaches into the viewport no further than it reaches into the screen.
                assertTrue(insets.left <= Math.ceil(gestures.left / density.toDouble()).toInt())
                assertTrue(insets.right <= Math.ceil(gestures.right / density.toDouble()).toInt())
            }
        }
    }
}
