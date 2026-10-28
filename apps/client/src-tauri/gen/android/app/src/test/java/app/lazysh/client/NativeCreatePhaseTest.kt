package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeCreatePhaseTest {
    @Test
    fun compiledVariantRetainsCreationLogsOnlyInDebug() {
        val expected = when (BuildConfig.BUILD_TYPE) {
            "debug" -> true
            "release" -> false
            else -> throw AssertionError("Expected the standard debug or release variant")
        }
        assertEquals("Generated variant must agree with its logging policy", expected, BuildConfig.DEBUG)
        // Read the actual compiled app class without loading an Android Activity
        // or invoking a mocked Log method. Release must omit all logging operands.
        val resource = javaClass.getResourceAsStream("/app/lazysh/client/MainActivity.class")
        assertNotNull("Compiled MainActivity must be present in the variant test classpath", resource)
        val bytes = requireNotNull(resource).use { it.readNBytes(64 * 1024 + 1) }
        assertTrue("Compiled startup class exceeds the fixture bound", bytes.size <= 64 * 1024)
        val constants = String(bytes, Charsets.ISO_8859_1)
        for (literal in listOf("android/util/Log", "LazyshActivityCreate", "onCreate:enter",
            "onCreate:afterEdgeToEdge", "onCreate:afterSuper")) {
            assertEquals("Compiled ${BuildConfig.BUILD_TYPE} startup logging operand: $literal",
                expected, constants.contains(literal))
        }
    }
}
