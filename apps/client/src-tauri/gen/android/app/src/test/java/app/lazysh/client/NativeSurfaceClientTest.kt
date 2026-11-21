package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Test

class NativeSurfaceClientTest {
    private val calls = mutableListOf<String>()

    private class Host(val calls: MutableList<String>, var draws: Boolean, var keeps: Boolean = true) : NativeSurface<String> {
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

    @Test fun closingTheClientEndsTheHostsSession() {
        client(Host(calls, draws = true)).close()
        assertEquals(listOf("host remove s"), calls)
    }
}
