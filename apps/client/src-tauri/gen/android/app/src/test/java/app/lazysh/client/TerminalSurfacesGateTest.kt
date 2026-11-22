package app.lazysh.client

import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalSurfacesGateTest {
    // Release and debug alike: the explicit choice, the probe and the kill switch gate the native backend before the page asks for a surface.
    @Test fun theHostIsOpenInEveryBuildAndGatedByTheChoice() = assertTrue(TerminalSurfaces.enabled)
}
