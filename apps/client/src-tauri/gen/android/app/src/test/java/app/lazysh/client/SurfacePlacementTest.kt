package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfacePlacementTest {
    private fun anchor(x: Double = 0.0, y: Double = 0.0, width: Double = 100.0, height: Double = 50.0, dpr: Double = 2.0) = SurfaceAnchor(x, y, width, height, dpr)

    @Test fun cssPixelsBecomeDevicePixels() {
        val at = SurfacePlacement.of(anchor(x = 40.0, y = 30.0, width = 200.0, height = 100.0, dpr = 2.625), 0, 0, 0, 0)
        assertEquals(SurfacePlacement(width = 525, height = 263, left = 105, top = 79), at)
    }

    @Test fun marginsAreFromThePaddingBoxWhereTheInsetsPutTheWebView() {
        // A cutout of 96 px on the left and a status bar of 72 px: the frame is padded by both and the WebView sits inside them.
        val padded = SurfacePlacement.of(anchor(x = 10.0, y = 5.0), webLeft = 96, webTop = 72, paddingLeft = 96, paddingTop = 72)
        assertEquals("the padding is not counted twice", SurfacePlacement(200, 100, 20, 10), padded)
        // A WebView offset by something other than the padding (a toolbar above it) moves the surface with it.
        assertEquals(172, SurfacePlacement.of(anchor(y = 5.0), webLeft = 0, webTop = 262, paddingLeft = 0, paddingTop = 100).top)
    }

    @Test fun anAnchorScrolledAboveOrLeftOfThePageKeepsItsNegativePosition() {
        val at = SurfacePlacement.of(anchor(x = -12.5, y = -3.0), 0, 0, 0, 0)
        assertEquals(-25, at.left)
        assertEquals(-6, at.top)
    }

    @Test fun aSurfaceIsNeverSmallerThanOnePixel() {
        val at = SurfacePlacement.of(anchor(width = 0.1, height = 0.0, dpr = 1.0), 0, 0, 0, 0)
        assertEquals(1, at.width)
        assertEquals(1, at.height)
    }

    @Test fun anAnchorIsARealBoxInsideWhatAGpuHolds() {
        assertTrue(anchor(width = 411.0, height = 600.0, dpr = 2.625).isValid)
        assertTrue("a pane scrolled partly off starts above the page", anchor(x = -40.0, y = -10.0).isValid)
        assertFalse(anchor(width = 0.0).isValid)
        assertFalse(anchor(height = -1.0).isValid)
        assertFalse(anchor(dpr = 0.0).isValid)
        assertFalse(anchor(dpr = SurfaceAnchor.MAX_DPR + 0.5).isValid)
        assertTrue(anchor(width = SurfaceAnchor.MAX_PIXELS.toDouble(), dpr = 1.0).isValid)
        assertFalse(anchor(width = SurfaceAnchor.MAX_PIXELS + 1.0, dpr = 1.0).isValid)
        assertFalse("pixels, not CSS pixels, are bounded", anchor(width = 5000.0, dpr = 4.0).isValid)
        assertFalse(anchor(x = 1e9).isValid)
        for (bad in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            assertFalse(anchor(x = bad).isValid)
            assertFalse(anchor(width = bad).isValid)
            assertFalse(anchor(dpr = bad).isValid)
        }
    }
}
