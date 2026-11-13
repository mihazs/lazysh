package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeGestureBandsTest {
    // A 411 x 891 dp phone at density 2.625 (1080 x 2339 px).
    private val width = 1080
    private val height = 2339
    private val density = 2.625f
    private fun px(dp: Int) = (dp * density).toInt()

    // The renderer's side row for this window: 200dp, ending 80dp above the bottom.
    private fun bands(zoneDp: Int = 24, left: Boolean = true, right: Boolean = true, topDp: Int = 611, bottomDp: Int = 811, clearBottomPx: Int = 0, widthPx: Int = width, heightPx: Int = height, density: Float = this.density) =
        EdgeGestureBands.bands(widthPx, heightPx, density, zoneDp, left, right, topDp, bottomDp, clearBottomPx)

    @Test fun claimsTheConfiguredWidthOnBothSidesAtTheRequestedRow() {
        val bands = bands()
        assertEquals(2, bands.size)
        val zone = px(24)
        assertEquals(0, bands[0].left); assertEquals(zone, bands[0].right)
        assertEquals(width - zone, bands[1].left); assertEquals(width, bands[1].right)
        for (band in bands) {
            assertEquals(px(611), band.top)
            assertEquals(px(811), band.bottom)
        }
    }

    @Test fun anEdgeSwitchedOffClaimsNothing() {
        assertEquals(1, bands(left = true, right = false).size)
        assertEquals(width, bands(left = false, right = true).single().right)
        assertTrue(bands(left = false, right = false).isEmpty())
    }

    @Test fun neverExceedsTheAndroidCapEvenWhenAskedForMore() {
        for (band in bands(topDp = 100, bottomDp = 811)) {
            assertEquals("Android caps the excluded height per edge at 200dp", px(200), band.bottom - band.top)
            assertEquals("the cap keeps the bottom of the row", px(811), band.bottom)
        }
    }

    @Test fun neverReachesIntoTheBottomGestureZone() {
        val zone = px(48)
        for (band in bands(bottomDp = 880, clearBottomPx = zone)) assertTrue(band.bottom <= height - zone)
        assertTrue("a row that sits wholly inside the zone claims nothing", bands(topDp = 800, bottomDp = 880, clearBottomPx = height - px(790)).isEmpty())
    }

    @Test fun aRowOffTheWindowIsClamped() {
        for (band in bands(topDp = 0, bottomDp = 5000)) assertTrue(band.bottom <= height && band.top >= 0)
    }

    @Test fun aShortWindowShrinksTheBandAndATinyOneClaimsNothing() {
        val landscape = bands(left = true, right = false, topDp = 20, bottomDp = 100, widthPx = 2339, heightPx = 300).single()
        assertTrue(landscape.bottom <= 300)
        assertTrue(bands(widthPx = 0).isEmpty())
        assertTrue(bands(topDp = 200, bottomDp = 200).isEmpty())
        assertTrue(bands(heightPx = 150, topDp = 100, bottomDp = 300).isEmpty())
    }

    @Test fun twoZonesNeverOverlapOnANarrowWindow() {
        val (left, right) = bands(zoneDp = 48, widthPx = 40, density = 1f)
        assertTrue(left.right <= right.left)
    }

    @Test fun aZoneCountsOnlyWhereItReachesPastThePaddingAndRoundsUp() {
        assertEquals(0, EdgeGestureBands.reach(60, 63, density))
        assertEquals(0, EdgeGestureBands.reach(0, 0, density))
        assertEquals(30, EdgeGestureBands.reach(100, 40, 2f))
        assertEquals(1, EdgeGestureBands.reach(41, 40, 2f))
    }

    @Test fun theNavigationModeComesFromTheSettingAndFallsBackToTheInsets() {
        assertEquals("gesture", EdgeGestureBands.navigation(2, 0, 0))
        assertEquals("buttons", EdgeGestureBands.navigation(0, 24, 24))
        assertEquals("buttons", EdgeGestureBands.navigation(1, 0, 0))
        assertEquals("gesture", EdgeGestureBands.navigation(-1, 0, 24))
        assertEquals("unknown", EdgeGestureBands.navigation(-1, 0, 0))
    }

    @Test fun gestureNavigationReservesTheLaunchersWholeSwipeUpStripAtTheBottom() {
        // 32dp reported by the insets, 48dp read by the launcher, at density 2.625.
        assertEquals(126, EdgeGestureBands.homeZone(84, "gesture", 126))
        assertEquals(126, EdgeGestureBands.homeZone(0, "gesture", 126))
        assertEquals(200, EdgeGestureBands.homeZone(200, "gesture", 126))
        assertEquals(0, EdgeGestureBands.homeZone(0, "buttons", 126))
        assertEquals(0, EdgeGestureBands.homeZone(0, "unknown", 126))
    }

    @Test fun theRendererReceivesTheInsetsAsOneJsonObject() {
        assertEquals(
            """{"left":24,"right":24,"bottom":20,"mandatoryBottom":32,"navigation":"gesture"}""",
            GestureInsets(24, 24, 20, 32, "gesture").toJson(),
        )
    }
}
