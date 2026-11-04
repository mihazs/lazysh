package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Test

class SettledPhaseTest {
    private fun firstAdmitted(phase: SettledPhase, samples: List<Triple<Long, Boolean, String>>) =
        samples.firstOrNull { (at, matches, sample) -> phase.admit(at, matches, sample) }

    @Test
    fun transientMoshFrameBeforeRemoteRepaintIsNotTheBaseline() {
        // Observed Android failure: the keyboard closes, Mosh first grows its
        // framebuffer with the cursor still on old row 8, then Herdr repaints it
        // on the bottom row. The first matching poll used to become the baseline.
        val transient = """{"rows":23,"cursorRow":8} ime=false"""
        val repainted = """{"rows":23,"cursorRow":22} ime=false"""
        val polls = listOf(0L to transient, 50L to transient, 100L to repainted) +
            (150L..1_000L step 50L).map { it to repainted }
        val admitted = firstAdmitted(SettledPhase(500), polls.map { (at, sample) -> Triple(at, true, sample) })
        assertEquals(Triple(600L, true, repainted), admitted)
    }

    @Test
    fun intermediateImeLayoutDoesNotBecomeTheComposerPhase() {
        // Observed Android failure: the composer opened at 18 rows before the
        // keyboard finished showing at 9 rows; the 18-row layout was admitted.
        val polls = listOf(0L to "rows=18", 100L to "rows=18", 300L to "rows=9", 600L to "rows=9", 800L to "rows=9")
        val admitted = firstAdmitted(SettledPhase(500), polls.map { (at, sample) -> Triple(at, true, sample) })
        assertEquals(Triple(800L, true, "rows=9"), admitted)
    }

    @Test
    fun anyNonMatchingOrChangedSampleRestartsTheWindow() {
        val phase = SettledPhase(500)
        val polls = listOf(
            Triple(0L, true, "a"), Triple(400L, false, "a"), Triple(450L, true, "a"),
            Triple(900L, true, "b"), Triple(1_350L, true, "b"), Triple(1_400L, true, "b"),
        )
        assertEquals(Triple(1_400L, true, "b"), firstAdmitted(phase, polls))
        phase.reset()
        assertEquals(false, phase.admit(1_450L, true, "b"))
        assertEquals(true, phase.admit(1_950L, true, "b"))
    }
}
