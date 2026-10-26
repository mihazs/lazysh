package app.lazysh.vault

import java.util.concurrent.CountDownLatch
import java.util.concurrent.FutureTask
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class UiLocaleStoreTest {
    @Test fun heldPersistenceDoesNotBlockPresentationAndQueuedStaleMutationCannotReplay() {
        var actual = UiLocaleState("system", "0")
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val writes = AtomicInteger()
        val store = UiLocaleStore({ actual }, { next ->
            writes.incrementAndGet(); entered.countDown()
            check(release.await(5, TimeUnit.SECONDS)); actual = next
        })
        UiLocaleWorkQueue().use { queue ->
            val first = FutureTask { store.set("es", "0") }
            val stale = FutureTask { store.set("pt-BR", "0") }
            try {
                assertTrue(queue.execute { first.run() })
                assertTrue(entered.await(2, TimeUnit.SECONDS))
                assertTrue(queue.execute { stale.run() })
                // This is the exact lock-free accessor used by native cover/prompt labels.
                val presentation = FutureTask { store.presentation() }
                Thread(presentation).start()
                assertEquals("system", presentation.get(2, TimeUnit.SECONDS).choice)
                assertFalse(first.isDone); assertFalse(stale.isDone)
            } finally { release.countDown() }
            val committed = first.get(2, TimeUnit.SECONDS)
            assertEquals("es", committed.choice)
            assertEquals(committed, store.presentation())
            assertThrows(java.util.concurrent.ExecutionException::class.java) { stale.get(2, TimeUnit.SECONDS) }
            assertEquals(1, writes.get())
        }
    }

    @Test fun failedCommitReconcilesChangedMemoryAndUnreadableStateStillFails() {
        var actual = UiLocaleState("system", "0")
        var unreadable = false
        val store = UiLocaleStore(
            { check(!unreadable); actual },
            { next -> actual = next; error("Synthetic persistence failure") },
        )
        assertThrows(IllegalStateException::class.java) { store.set("en", "0") }
        assertEquals("en", store.presentation().choice)
        assertEquals(actual, store.refresh())
        unreadable = true
        assertThrows(IllegalStateException::class.java) { store.refresh() }
        assertThrows(IllegalStateException::class.java) { store.presentation() }
    }

    @Test fun saturatedWorkerRejectsWithoutRunningOnSubmittingThread() {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        val completed = CountDownLatch(16)
        val caller = Thread.currentThread()
        val wrongThread = AtomicInteger()
        UiLocaleWorkQueue().use { queue ->
            try {
                assertTrue(queue.execute { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) })
                assertTrue(entered.await(2, TimeUnit.SECONDS))
                repeat(16) { assertTrue(queue.execute {
                    if (Thread.currentThread() === caller) wrongThread.incrementAndGet()
                    completed.countDown()
                }) }
                assertFalse(queue.execute { fail("A saturated queue must not run the task inline") })
            } finally { release.countDown() }
            assertTrue(completed.await(2, TimeUnit.SECONDS))
            assertEquals(0, wrongThread.get())
        }
    }
}
