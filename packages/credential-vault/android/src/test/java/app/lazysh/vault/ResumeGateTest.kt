package app.lazysh.vault

import org.junit.Assert.*
import org.junit.Test

class ResumeGateTest {
    @Test fun secureWindowPolicyPersistsThroughUnlockAndClearsOnlyForDisabledPolicy() {
        val gate = ResumeGate(); assertTrue(gate.protectsContent)
        assertTrue(gate.apply(false, true, 1, 0)); assertFalse(gate.covered); assertTrue(gate.protectsContent)
        assertTrue(gate.apply(false, false, 2, 0)); assertFalse(gate.protectsContent)
    }
    @Test fun recreatedViewKeepsCounterAndRequiresFreshPolicyAcknowledgment() {
        val gate = ResumeGate(); gate.background(); gate.resume()
        assertTrue(gate.apply(false, true, 2, 1)); assertFalse(gate.covered)
        gate.rebind(true); assertEquals(2L, gate.nativeGeneration); assertTrue(gate.covered); assertTrue(gate.awaitingPolicy)
        assertFalse(gate.apply(false, true, 2, 1)); assertTrue(gate.covered); assertTrue(gate.awaitingPolicy)
        assertTrue(gate.apply(true, true, 3, 2)); assertTrue(gate.covered); assertFalse(gate.awaitingPolicy)
        assertTrue(gate.apply(false, true, 4, 2)); assertFalse(gate.covered)
        gate.rebind(false); assertEquals(3L, gate.nativeGeneration); assertTrue(gate.covered)
        assertTrue(gate.apply(false, false, 5, 3)); assertFalse(gate.covered); assertFalse(gate.protectsContent)
    }
    @Test fun unknownStartsCoveredAndDisabledPolicyDoesNotChangeBackgroundDefaults() {
        val gate = ResumeGate(); assertTrue(gate.covered); assertTrue(gate.awaitingPolicy)
        assertTrue(gate.apply(false, false, 1, 0)); assertFalse(gate.covered); assertFalse(gate.awaitingPolicy)
        gate.pause(); gate.background(); assertFalse(gate.covered)
    }
    @Test fun disabledStartupCanResolveDuringBackgroundButProtectedRevealCannot() {
        val gate = ResumeGate(); gate.background()
        assertFalse(gate.apply(false, true, 1, 1)); assertTrue(gate.covered)
        assertTrue(gate.apply(false, false, 1, 1)); assertFalse(gate.covered)
        assertTrue(gate.apply(true, true, 2, 0)); assertTrue(gate.covered)
    }
    @Test fun newBackgroundRejectsAProofAcknowledgedBeforeRustReceivesThatBackground() {
        val gate = ResumeGate(); assertTrue(gate.apply(false, true, 2, 0)); assertFalse(gate.covered)
        gate.background(); assertTrue(gate.covered); gate.resume(); assertTrue(gate.covered)
        assertFalse(gate.apply(false, true, 3, 0)); assertTrue(gate.covered)
        assertTrue(gate.apply(false, true, 3, 1)); assertFalse(gate.covered)
        assertFalse(gate.apply(true, true, 2, 1)); assertFalse(gate.covered)
    }
    @Test fun temporaryPermissionOrBiometricSheetOnlyAddsAPrivacyCover() {
        val gate = ResumeGate(); assertTrue(gate.apply(false, true, 2, 0))
        gate.pause(); assertTrue(gate.covered)
        assertTrue(gate.apply(false, true, 3, 0)); assertTrue(gate.covered)
        gate.resume(); assertFalse(gate.covered); assertEquals(0, gate.nativeGeneration)
    }
}
