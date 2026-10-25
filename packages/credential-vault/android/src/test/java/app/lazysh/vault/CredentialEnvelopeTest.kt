package app.lazysh.vault

import org.junit.Assert.*
import org.junit.Test

class CredentialEnvelopeTest {
    private val prefix = "app.lazysh.client.credentials.biometric."
    private val identity = prefix + "dc8c30d7-fd6f-4004-a661-369b5ed80cc4"
    private val iv = "AAAAAAAAAAAAAAAA"
    private val ciphertext = "AAAAAAAAAAAAAAAAAAAAAA=="
    @Test fun protectedRecordsCannotSelectLegacyKeysOrLoseTheirProtection() {
        val protected = CredentialEnvelope.parse("v2b:$identity:$iv:$ciphertext", prefix)
        assertTrue(protected.biometric); assertEquals(identity, protected.alias)
        assertFalse(CredentialEnvelope.parse("$iv:$ciphertext", prefix).biometric)
        for (value in listOf("v2b:foreign:$iv:$ciphertext", "v2b:$prefix:$iv:$ciphertext", "v2b:$identity:$iv", "v3:$identity:$iv:$ciphertext", "v2b:$identity:bad:$ciphertext", "x".repeat(180001))) {
            try { CredentialEnvelope.parse(value, prefix); fail("Invalid credential envelope accepted") } catch (_: IllegalArgumentException) {}
        }
    }
}
