package app.lazysh.client

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** The intents and content URIs behind Files > Open, Download and Share, against the real FileProvider. */
@RunWith(AndroidJUnit4::class)
class FileExchangeTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private fun staged(name: String, bytes: ByteArray): File {
        val directory = File(context.cacheDir, "host-files/${UUID.randomUUID()}").apply { mkdirs() }
        return File(directory, name).apply { writeBytes(bytes) }
    }

    @Test fun openAndShareGrantReadOnlyContentUrisThatServeTheStagedBytes() {
        val bytes = ByteArray(70_000) { (it % 251).toByte() }
        val file = staged("rapport final.pdf", bytes)
        try {
            val view = FileExchange.view(context, file, file.name)
            assertEquals(Intent.ACTION_VIEW, view.action)
            assertEquals("application/pdf", view.type)
            assertEquals("content", view.data!!.scheme)
            assertEquals(context.packageName + ".fileprovider", view.data!!.authority)
            assertTrue(view.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
            assertEquals(0, view.flags and Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            assertArrayEquals(bytes, context.contentResolver.openInputStream(view.data!!)!!.use { it.readBytes() })
            val send = FileExchange.send(context, file, file.name)
            assertEquals(Intent.ACTION_SEND, send.action)
            assertEquals(view.data, send.getParcelableExtra<android.net.Uri>(Intent.EXTRA_STREAM))
        } finally { file.parentFile!!.deleteRecursively() }
    }

    @Test fun saveOffersTheDocumentPickerWithTheNameAndCopiesOnlyThatFile() {
        val file = staged("notes.txt", "hello 世界".toByteArray())
        val target = File(context.cacheDir, "host-files/${UUID.randomUUID()}-saved.txt")
        try {
            val create = FileExchange.create("notes.txt")
            assertEquals(Intent.ACTION_CREATE_DOCUMENT, create.action)
            assertEquals("text/plain", create.type)
            assertEquals("notes.txt", create.getStringExtra(Intent.EXTRA_TITLE))
            assertTrue(create.categories.contains(Intent.CATEGORY_OPENABLE))
            FileExchange.copy(context, file, android.net.Uri.fromFile(target))
            assertEquals("hello 世界", target.readText())
        } finally { file.parentFile!!.deleteRecursively(); target.delete() }
    }

    @Test fun onlyRegularFilesInsideTheAppCacheAreAccepted() {
        val file = staged("a.txt", byteArrayOf(1))
        try {
            assertEquals(file.canonicalPath, FileExchange.staged(context, file.path).path)
            for (path in listOf("/etc/hosts", file.parent!!, File(file.parentFile, "../../../files/x").path)) {
                assertThrows(IllegalArgumentException::class.java) { FileExchange.staged(context, path) }
            }
            assertEquals("application/octet-stream", FileExchange.mime("noextension"))
            assertEquals("image/png", FileExchange.mime("PHOTO.PNG"))
        } finally { file.parentFile!!.deleteRecursively() }
    }
}
