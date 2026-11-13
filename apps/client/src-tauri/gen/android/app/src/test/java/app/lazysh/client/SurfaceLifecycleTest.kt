package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SurfaceLifecycleTest {
    /** Records what the renderer is told, as one line per call. */
    private class Client : SurfaceClient<String> {
        val calls = mutableListOf<String>()
        override fun onSurfaceReady(surface: String, generation: Int, width: Int, height: Int) { calls += "ready $surface #$generation ${width}x$height" }
        override fun onSurfaceChanged(surface: String, generation: Int, width: Int, height: Int) { calls += "changed $surface #$generation ${width}x$height" }
        override fun onSurfaceLost(generation: Int) { calls += "lost #$generation" }
    }

    private val client = Client()
    private val lifecycle = SurfaceLifecycle(client)

    private fun surfaceAppears(surface: String, width: Int = 1080, height: Int = 600) { lifecycle.created(); lifecycle.changed(surface, width, height) }

    @Test fun theFirstSizeAfterCreationIsTheReadySurface() {
        lifecycle.created()
        assertEquals("nothing is ready before the window gives a size", emptyList<String>(), client.calls)
        lifecycle.changed("a", 1080, 600)
        assertEquals(listOf("ready a #1 1080x600"), client.calls)
        assertEquals(1, lifecycle.generation)
    }

    @Test fun aResizeKeepsTheSurfaceAndTheGenerationAndARepeatedSizeIsSilent() {
        surfaceAppears("a")
        lifecycle.changed("a", 1080, 600)
        lifecycle.changed("a", 1080, 420)
        assertEquals(listOf("ready a #1 1080x600", "changed a #1 1080x420"), client.calls)
        assertEquals(420, lifecycle.current?.height)
    }

    @Test fun lossIsReportedOncePerSurface() {
        surfaceAppears("a")
        lifecycle.destroyed()
        lifecycle.destroyed()
        assertEquals(listOf("ready a #1 1080x600", "lost #1"), client.calls)
        assertNull(lifecycle.current)
        assertEquals("the count outlives the surface", 1, lifecycle.generation)
    }

    @Test fun aRecreatedSurfaceIsANewGenerationOfTheSameSession() {
        surfaceAppears("a")
        lifecycle.destroyed()
        surfaceAppears("b", 1080, 640)
        lifecycle.destroyed()
        surfaceAppears("c")
        assertEquals(
            listOf("ready a #1 1080x600", "lost #1", "ready b #2 1080x640", "lost #2", "ready c #3 1080x600"),
            client.calls,
        )
    }

    @Test fun aLateSizeAfterDestructionDoesNotBringTheSurfaceBack() {
        surfaceAppears("a")
        lifecycle.destroyed()
        lifecycle.changed("a", 1080, 600)
        assertEquals(listOf("ready a #1 1080x600", "lost #1"), client.calls)
        assertNull(lifecycle.current)
    }

    @Test fun aSizeWithoutACreationIsIgnored() {
        lifecycle.changed("a", 1080, 600)
        assertEquals(emptyList<String>(), client.calls)
        assertNull(lifecycle.current)
    }

    @Test fun anEmptySurfaceIsNoSurfaceYet() {
        lifecycle.created()
        lifecycle.changed("a", 0, 600)
        lifecycle.changed("a", 1080, 0)
        assertEquals(emptyList<String>(), client.calls)
        lifecycle.changed("a", 1080, 600)
        assertEquals(listOf("ready a #1 1080x600"), client.calls)
        lifecycle.changed("a", 0, 0)
        assertEquals("a shrink to nothing is not a resize", 1, client.calls.size)
    }

    @Test fun redrawAsksForTheWholeSessionOnTheLiveSurfaceOnly() {
        lifecycle.redraw()
        assertEquals(emptyList<String>(), client.calls)
        surfaceAppears("a")
        lifecycle.redraw()
        lifecycle.destroyed()
        lifecycle.redraw()
        assertEquals(listOf("ready a #1 1080x600", "changed a #1 1080x600", "lost #1"), client.calls)
    }
}
