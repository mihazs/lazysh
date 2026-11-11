package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EdgeGestureBandsTest {
    // A 411 x 891 dp phone at density 2.625 (1080 x 2339 px).
    private val width = 1080
    private val height = 2339
    private val density = 2.625f

    @Test fun claimsTheConfiguredWidthOnBothSidesAtTheCappedHeight() {
        val bands = EdgeGestureBands.bands(width, height, density, 24, left = true, right = true)
        assertEquals(2, bands.size)
        val zone = (24 * density).toInt()
        assertEquals(0, bands[0].left); assertEquals(zone, bands[0].right)
        assertEquals(width - zone, bands[1].left); assertEquals(width, bands[1].right)
        for (band in bands) {
            assertEquals("Android caps the excluded height per edge at 200dp", (200 * density).toInt(), band.bottom - band.top)
            assertEquals("the band ends 72dp above the bottom edge", height - (72 * density).toInt(), band.bottom)
        }
    }

    @Test fun anEdgeSwitchedOffClaimsNothing() {
        assertEquals(1, EdgeGestureBands.bands(width, height, density, 24, left = true, right = false).size)
        assertEquals(width, EdgeGestureBands.bands(width, height, density, 24, left = false, right = true).single().right)
        assertTrue(EdgeGestureBands.bands(width, height, density, 24, left = false, right = false).isEmpty())
    }

    @Test fun neverReachesTheVerticalMiddleOrTheBottomGestureArea() {
        for (band in EdgeGestureBands.bands(width, height, density, 48, left = true, right = true)) {
            assertTrue(band.top >= height / 2)
            assertTrue(band.bottom <= height - (EdgeGestureBands.ABOVE_BOTTOM_DP * density).toInt())
        }
    }

    @Test fun aShortWindowShrinksTheBandAndATinyOneClaimsNothing() {
        val landscape = EdgeGestureBands.bands(2339, 300, density, 24, left = true, right = false).single()
        assertTrue(landscape.bottom - landscape.top <= 100)
        assertTrue(EdgeGestureBands.bands(0, height, density, 24, left = true, right = true).isEmpty())
        assertTrue(EdgeGestureBands.bands(2339, 150, density, 24, left = true, right = true).isEmpty())
    }

    @Test fun twoZonesNeverOverlapOnANarrowWindow() {
        val (left, right) = EdgeGestureBands.bands(40, height, 1f, 48, left = true, right = true)
        assertTrue(left.right <= right.left)
    }
}
