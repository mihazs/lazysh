package app.lazysh.client

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject

/** The host-written fixture of an owned SSH case, read once from its private device path. */
internal fun ownedSshFixture(): JSONObject {
    val path = InstrumentationRegistry.getArguments().getString("lazyshSshFixture")
    require(path != null && Regex("/data/local/tmp/lazysh-ui-ssh-[a-f0-9]{32}/fixture[.]json").matches(path)) {
        "An owned SSH fixture path is required"
    }
    val bytes = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand("cat $path").use { descriptor ->
        android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
            val buffer = ByteArray(32 * 1024 + 1)
            var count = 0
            while (count < buffer.size) {
                val read = stream.read(buffer, count, buffer.size - count)
                if (read < 0) break
                count += read
            }
            require(count <= 32 * 1024) { "Owned SSH fixture exceeds bound" }
            buffer.copyOf(count)
        }
    }
    return try { JSONObject(String(bytes, Charsets.UTF_8)) }
    catch (_: Exception) { throw AssertionError("Owned SSH fixture JSON is invalid") }
}
