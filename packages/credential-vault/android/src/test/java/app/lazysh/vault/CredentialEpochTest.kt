package app.lazysh.vault

import org.junit.Assert.*
import org.junit.Test

class CredentialEpochTest {
    @Test fun cancelledQueuedRequestsCannotPresentPromptsAndBackgroundDoesNotDesynchronizeRustEpochs() {
        val state = CredentialEpoch()
        assertTrue(state.permits(0))
        state.cancel(1)
        assertFalse(state.permits(0)); assertTrue(state.permits(1))
        state.cancel(0)
        assertFalse(state.permits(0))
        val before = state.lifecycle
        state.background(); assertFalse(state.permits(1)); state.resume()
        assertFalse(state.permits(1, before)); assertTrue(state.permits(1))
    }
}
