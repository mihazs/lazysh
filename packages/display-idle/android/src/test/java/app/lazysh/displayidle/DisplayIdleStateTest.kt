package app.lazysh.displayidle

import org.junit.Assert.*
import org.junit.Test

class DisplayIdleStateTest {
    @Test fun orderedTicketsSurviveProbesAndOldCleanup() {
        var flag = false
        val state = DisplayIdleState({ flag = it }, { flag })
        val epoch = state.epoch
        val first = state.issue(); val second = state.issue()
        assertFalse(flag)
        state.acquire(epoch, first, true); state.issue(); assertTrue(flag)
        state.acquire(epoch, second, true)
        state.release(epoch, first); assertTrue(state.active)
        state.release(epoch, second); assertFalse(flag)
        assertThrows(IllegalArgumentException::class.java) { state.acquire(epoch, second, true) }
    }
    @Test fun cancellationBeforeAcquisitionAndEpochRotationFenceLateWork() {
        var flag = false
        val state = DisplayIdleState({ flag = it }, { flag })
        val epoch = state.epoch; val ticket = state.issue()
        state.release(epoch, ticket)
        assertThrows(IllegalArgumentException::class.java) { state.acquire(epoch, ticket, true) }
        val next = state.issue(); state.acquire(epoch, next, true)
        state.invalidate(); assertFalse(flag); assertNotEquals(epoch, state.epoch)
        assertThrows(IllegalArgumentException::class.java) { state.acquire(epoch, next, true) }
        state.release(epoch, next); assertFalse(flag)
    }
    @Test fun hiddenOwnerUnissuedNumbersAndUnappliedFlagsCannotSucceed() {
        val state = DisplayIdleState({}, { false })
        val epoch = state.epoch; val ticket = state.issue()
        assertThrows(IllegalStateException::class.java) { state.acquire(epoch, ticket, false) }
        for (invalid in listOf(-1L, 0L, ticket + 1, DisplayIdleState.MAX_TICKET + 1)) {
            assertThrows(IllegalArgumentException::class.java) { state.acquire(epoch, invalid, true) }
        }
        assertThrows(IllegalStateException::class.java) { state.acquire(epoch, state.issue(), true) }
        assertFalse(state.active)
    }
    @Test fun failedReleaseRemainsOwnedForExplicitRetry() {
        var flag = false; var fail = false
        val state = DisplayIdleState({ if (fail) error("OS release failed") else flag = it }, { flag })
        val epoch = state.epoch; val ticket = state.issue(); state.acquire(epoch, ticket, true)
        fail = true
        assertThrows(IllegalStateException::class.java) { state.release(epoch, ticket) }
        assertTrue(state.active); fail = false
        state.release(epoch, ticket); assertFalse(flag)
    }
}
