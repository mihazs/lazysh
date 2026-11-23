package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeSurfaceClientTest {
    private val calls = mutableListOf<String>()

    private class Host(val calls: MutableList<String>, var draws: Boolean, var keeps: Boolean = true, var why: String? = null) : NativeSurface<String> {
        override fun reason(id: String) = why
        override fun ready(id: String, surface: String, generation: Int, width: Int, height: Int, density: Float, background: Int): Boolean {
            calls += "host ready $id $surface #$generation ${width}x$height $density %06x".format(background); return draws
        }
        override fun changed(id: String, width: Int, height: Int, density: Float, background: Int): Boolean { calls += "host changed ${width}x$height"; return keeps }
        override fun lost(id: String, generation: Int) { calls += "host lost #$generation" }
        override fun remove(id: String) { calls += "host remove $id" }
    }

    private val fallback = object : SurfaceClient<String> {
        override fun onSurfaceReady(surface: String, generation: Int, width: Int, height: Int) { calls += "fallback ready $surface" }
        override fun onSurfaceChanged(surface: String, generation: Int, width: Int, height: Int) { calls += "fallback changed $surface" }
        override fun onSurfaceLost(generation: Int) { calls += "fallback lost" }
    }

    private fun client(host: Host) = NativeSurfaceClient("s", { 0x1a2b3c }, host, fallback, { 2.5f })

    @Test fun aSurfaceTheHostDrawsIsLeftToItFromReadyToLost() {
        val client = client(Host(calls, draws = true))
        client.onSurfaceReady("a", 1, 100, 50)
        client.onSurfaceChanged("a", 1, 120, 60)
        client.onSurfaceLost(1)
        assertEquals(listOf("host ready s a #1 100x50 2.5 1a2b3c", "host changed 120x60", "host lost #1"), calls)
    }

    @Test fun aSurfaceTheHostRefusesShowsTheBackgroundAndIsNeverTold() {
        val client = client(Host(calls, draws = false))
        client.onSurfaceReady("a", 1, 100, 50)
        client.onSurfaceChanged("a", 1, 120, 60)
        client.onSurfaceLost(1)
        assertEquals(listOf("host ready s a #1 100x50 2.5 1a2b3c", "fallback ready a", "fallback changed a", "fallback lost"), calls)
    }

    @Test fun aHostThatCannotResizeHandsTheSurfaceBackToTheBackground() {
        val client = client(Host(calls, draws = true, keeps = false))
        client.onSurfaceReady("a", 1, 100, 50)
        client.onSurfaceChanged("a", 1, 120, 60)
        client.onSurfaceLost(1)
        assertEquals(listOf("host ready s a #1 100x50 2.5 1a2b3c", "host changed 120x60", "fallback changed a", "fallback lost"), calls)
    }

    @Test fun aSurfaceTheHostRefusesSaysWhyAndASurfaceItDrawsSaysNothing() {
        val drawn = client(Host(calls, draws = true, why = "left over from an earlier surface"))
        assertEquals(false, drawn.drawing)
        drawn.onSurfaceReady("a", 1, 100, 50)
        assertEquals(true to null, drawn.drawing to drawn.refusal)

        val refused = client(Host(calls, draws = false, why = "no adapter could create a device"))
        refused.onSurfaceReady("a", 1, 100, 50)
        assertEquals(false to "no adapter could create a device", refused.drawing to refused.refusal)
        // A host that cannot say why still gives the page something to show.
        val silent = client(Host(calls, draws = false))
        silent.onSurfaceReady("a", 1, 100, 50)
        assertEquals("the renderer did not draw on the surface", silent.refusal)
        // A resize the host gave up on, and a lost surface, are not drawing either.
        val resized = client(Host(calls, draws = true, keeps = false, why = "the swapchain could not be resized"))
        resized.onSurfaceReady("a", 1, 100, 50)
        resized.onSurfaceChanged("a", 1, 120, 60)
        assertEquals(false to "the swapchain could not be resized", resized.drawing to resized.refusal)
        drawn.onSurfaceLost(1)
        assertEquals(false, drawn.drawing)
    }

    @Test fun closingTheClientEndsTheHostsSession() {
        client(Host(calls, draws = true)).close()
        assertEquals(listOf("host remove s"), calls)
    }
}
