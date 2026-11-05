package app.lazysh.client

import org.junit.Assert.*
import org.junit.Test

class SessionBackgroundStateTest {
    @Test fun delayedServiceStartReconcilesLatestOwnershipAndNeverResurrectsStoppedWorkers() {
        val state = SessionBackgroundState()
        val actions = mutableListOf<String>()
        val callback = { state.reconcileStart({ actions.add("start") }, { actions.add("stop") }) }
        state.apply(1, 1)
        state.apply(2, 0)
        state.apply(3, 1)
        callback() // Delayed callback from the first request must admit the current worker.
        state.apply(4, 0)
        callback() // A delayed callback after last release must stop, without a new foreground hold.
        assertEquals(listOf("start", "stop"), actions)
        assertEquals(4L, state.revision)
        assertFalse(state.active)
    }
    @Test fun lateStartsAndStopsCannotReplaceCurrentWorkerOwnership() {
        val state = SessionBackgroundState()
        assertTrue(state.apply(1, 1))
        assertTrue(state.apply(3, 1))
        assertFalse(state.apply(2, 0))
        assertTrue(state.active)
        assertTrue(state.apply(4, 0))
        assertFalse(state.apply(3, 1))
        assertFalse(state.apply(4, 1))
        assertFalse(state.active)
        assertEquals(4L, state.revision)
    }
    @Test fun newerActiveRevisionKeepsExecutionActive() {
        val shared = SessionBackgroundState()
        assertTrue(shared.apply(8, 1))
        assertTrue(shared.apply(9, 1))
        assertTrue(shared.active)
        assertFalse(shared.apply(8, 0))
        assertTrue(shared.apply(10, 0))
    }
    @Test fun sessionCountFollowsTheNewestRevisionOnly() {
        val state = SessionBackgroundState()
        assertTrue(state.apply(1, 1))
        assertTrue(state.apply(2, 3))
        assertEquals(3, state.sessions)
        assertFalse("A late revision cannot replace the shown count", state.apply(2, 1))
        assertTrue(state.apply(3, 2))
        assertEquals(2, state.sessions)
        assertTrue(state.active)
        assertTrue(state.apply(4, 0))
        assertEquals(0, state.sessions)
        assertFalse(state.active)
    }
    @Test fun malformedCountsCannotClaimExecution() {
        val state = SessionBackgroundState()
        for (count in listOf(-1, 65_536)) {
            try { state.apply(1, count); fail("invalid count admitted") }
            catch (_: IllegalArgumentException) { }
        }
        assertFalse(state.active)
        assertEquals(0L, state.revision)
    }
    @Test fun notificationPermissionIsRequestedOnceFromAVisibleWorkspaceOnAndroid13AndLater() {
        assertTrue(SessionNotificationPermission.shouldRequest(33, granted = false, requested = false, visible = true))
        assertTrue(SessionNotificationPermission.shouldRequest(36, granted = false, requested = false, visible = true))
        assertFalse("Older Android grants notifications at install", SessionNotificationPermission.shouldRequest(32, false, false, true))
        assertFalse("A grant needs no prompt", SessionNotificationPermission.shouldRequest(36, true, false, true))
        assertFalse("A denial or dismissal is never asked again", SessionNotificationPermission.shouldRequest(36, false, true, true))
        assertFalse("A background connection cannot prompt", SessionNotificationPermission.shouldRequest(36, false, false, false))
    }
    @Test fun malformedRevisionsCannotClaimExecution() {
        val state = SessionBackgroundState()
        for (revision in listOf(0L, -1L, Long.MAX_VALUE)) {
            try { state.apply(revision, 1); fail("invalid revision admitted") }
            catch (_: IllegalArgumentException) { }
        }
        assertFalse(state.active)
    }
}
