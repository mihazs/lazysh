package app.lazysh.client

import org.junit.Assert.*
import org.junit.Test

class SessionBackgroundStateTest {
    @Test fun delayedServiceStartReconcilesLatestOwnershipAndNeverResurrectsStoppedWorkers() {
        val state = SessionBackgroundState()
        val actions = mutableListOf<String>()
        val callback = { state.reconcileStart({ actions.add("start") }, { actions.add("stop") }) }
        state.apply(1, true)
        state.apply(2, false)
        state.apply(3, true)
        callback() // Delayed callback from the first request must admit the current worker.
        state.apply(4, false)
        callback() // A delayed callback after last release must stop, without a new foreground hold.
        assertEquals(listOf("start", "stop"), actions)
        assertEquals(4L, state.revision)
        assertFalse(state.active)
    }
    @Test fun lateStartsAndStopsCannotReplaceCurrentWorkerOwnership() {
        val state = SessionBackgroundState()
        assertTrue(state.apply(1, true))
        assertTrue(state.apply(3, true))
        assertFalse(state.apply(2, false))
        assertTrue(state.active)
        assertTrue(state.apply(4, false))
        assertFalse(state.apply(3, true))
        assertFalse(state.apply(4, true))
        assertFalse(state.active)
        assertEquals(4L, state.revision)
    }
    @Test fun newerActiveRevisionKeepsExecutionActive() {
        val shared = SessionBackgroundState()
        assertTrue(shared.apply(8, true))
        assertTrue(shared.apply(9, true))
        assertTrue(shared.active)
        assertFalse(shared.apply(8, false))
        assertTrue(shared.apply(10, false))
    }
    @Test fun malformedRevisionsCannotClaimExecution() {
        val state = SessionBackgroundState()
        for (revision in listOf(0L, -1L, Long.MAX_VALUE)) {
            try { state.apply(revision, true); fail("invalid revision admitted") }
            catch (_: IllegalArgumentException) { }
        }
        assertFalse(state.active)
    }
}
