package app.lazysh.client

import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class ClipboardReadTest {
    private val first = "00000000-0000-4000-8000-000000000001"
    private val second = "00000000-0000-4000-8000-000000000002"
    private fun rejected(code: String, action: () -> Unit) {
        val failure = assertThrows(Exception::class.java, action)
        assertEquals(code, ClipboardPayload.failure(failure))
    }
    private fun png(width: Int, height: Int): ByteArray = ByteArray(24).also {
        byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82).copyInto(it)
        for ((offset, value) in listOf(16 to width, 20 to height)) {
            for (index in 0..3) it[offset + index] = (value ushr (24 - index * 8)).toByte()
        }
    }
    private fun jpeg(width: Int, height: Int) = byteArrayOf(255.toByte(), 216.toByte(), 255.toByte(), 192.toByte(),
        0, 8, 8, (height ushr 8).toByte(), height.toByte(), (width ushr 8).toByte(), width.toByte(), 1)

    @Test fun focusLifecycleDocumentAndDeadlineFenceOriginalOperations() {
        var now = 0L
        val state = ClipboardReadState { now }
        rejected("clipboard_unavailable") { state.begin(first, false, 0) }
        rejected("clipboard_unavailable") { state.begin("private clipboard URI", true, 0) }
        val operation = state.begin(first, true, 0)
        assertTrue(state.current(operation, true)); assertFalse(state.current(operation, false))
        now = TimeUnit.SECONDS.toNanos(5)
        assertFalse(state.current(operation, true))
        state.invalidate(); now = 0
        assertFalse(state.current(operation, true))
        state.finish(operation)
        state.advanceDocument(2)
        rejected("clipboard_cancelled") { state.advanceDocument(1) }
        rejected("clipboard_unavailable") { state.advanceDocument(-1) }
        rejected("clipboard_unavailable") { state.advanceDocument(9_007_199_254_740_992L) }
        val current = state.begin(second, true, 2)
        assertNull(state.advanceDocument(2))
        assertTrue(state.current(current, true))
        assertSame(current, state.advanceDocument(3))
        assertFalse(state.current(current, true))
    }

    @Test fun canceledProviderKeepsItsSlotUntilTheActualWorkerStops() {
        val state = ClipboardReadState()
        val operation = state.begin(first, true, 0)
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val worker = Thread {
            try { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)) }
            finally { state.finish(operation) }
        }
        worker.start()
        try {
            assertTrue(entered.await(5, TimeUnit.SECONDS))
            assertNull(state.cancel(second)); assertTrue(state.current(operation, true))
            assertSame(operation, state.cancel(first)); assertFalse(state.current(operation, true))
            assertTrue(state.owns(first)); assertFalse(state.owns(second))
            rejected("clipboard_busy") { state.begin(second, true, 0) }
            state.advanceDocument(1)
            rejected("clipboard_busy") { state.begin(second, true, 1) }
        } finally { release.countDown(); worker.join(5000) }
        assertFalse(worker.isAlive)
        assertFalse(state.owns(first))
        val next = state.begin(second, true, 1)
        state.finish(operation)
        assertTrue(state.current(next, true))
    }

    @Test fun sameDocumentResumeCannotFreshenAnOldEpochOrCancelItsReplacement() {
        val state = ClipboardReadState()
        val old = state.begin(first, true, 0)
        state.invalidate()
        assertNull(state.advanceDocument(0))
        assertFalse(state.current(old, true))
        rejected("clipboard_busy") { state.begin(second, true, 0) }
        state.finish(old)
        val replacement = state.begin(second, true, 0)
        state.finish(old)
        assertNull(state.cancel(first))
        assertFalse(state.owns(first)); assertTrue(state.owns(second))
        assertTrue(state.current(replacement, true))
        state.invalidate()
        assertFalse(state.current(replacement, true))
    }

    @Test fun literalTextUsesUtf8BytesAndNeverCoercesOtherItems() {
        assertEquals("hello\n世界", ClipboardPayload.text("hello\n世界"))
        assertEquals(65536, ClipboardPayload.text("a".repeat(65536)).length)
        assertEquals(32768, ClipboardPayload.text("é".repeat(32768)).length)
        rejected("clipboard_limit") { ClipboardPayload.text("é".repeat(32769)) }
        rejected("clipboard_limit") { ClipboardPayload.text("a".repeat(65537)) }
        rejected("clipboard_empty") { ClipboardPayload.text(null) }
        for (scheme in listOf(null, "file", "https", "intent", "CONTENT")) {
            rejected("clipboard_unsupported") { ClipboardPayload.contentUri(scheme) }
        }
        ClipboardPayload.contentUri("content")
    }

    @Test fun actualStreamBoundAndCancellationApplyWithoutTrustingReportedSize() {
        val exact = ByteArray(ClipboardPayload.IMAGE_LIMIT)
        assertArrayEquals(exact, ClipboardPayload.bytes(ByteArrayInputStream(exact)) { true })
        rejected("clipboard_limit") {
            ClipboardPayload.bytes(ByteArrayInputStream(ByteArray(ClipboardPayload.IMAGE_LIMIT + 1))) { true }
        }
        var read = false
        val input = object : InputStream() {
            override fun read(): Int { read = true; return 1 }
            override fun read(buffer: ByteArray, offset: Int, length: Int): Int { read = true; return 1 }
        }
        rejected("clipboard_cancelled") { ClipboardPayload.bytes(input) { false } }
        assertFalse(read)
        rejected("clipboard_cancelled") { ClipboardPayload.bytes(input) { !read } }
        assertTrue(read)
    }

    @Test fun imageHeadersDimensionsAndMimeAreValidatedBeforeDecoding() {
        ClipboardPayload.image(png(4096, 2048), "image/png")
        ClipboardPayload.image(jpeg(8192, 1), "image/jpeg")
        for (image in listOf(png(0, 1), png(8193, 1), png(4096, 2049), jpeg(65535, 1))) {
            rejected("clipboard_limit") { ClipboardPayload.image(image, if (image.size == 24) "image/png" else "image/jpeg") }
        }
        rejected("clipboard_unsupported") { ClipboardPayload.image(png(2, 2), "image/jpeg") }
        rejected("clipboard_unsupported") { ClipboardPayload.image(jpeg(2, 2), "image/png") }
        rejected("clipboard_unsupported") { ClipboardPayload.image(png(2, 2).also { it[12] = 0 }, "image/png") }
        rejected("clipboard_unsupported") { ClipboardPayload.image(byteArrayOf(255.toByte(), 216.toByte(), 255.toByte(), 192.toByte(), 0, 1), "image/jpeg") }
        rejected("clipboard_unsupported") { ClipboardPayload.image("private provider bytes".toByteArray(), "image/png") }
        assertEquals("clipboard_unavailable", ClipboardPayload.failure(SecurityException("content://private/provider?secret=clipboard")))
    }
}
