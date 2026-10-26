package app.lazysh.vault

import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal data class UiLocaleState(val choice: String, val revision: String)

/** One owned writer; admission never runs persistence on the submitting/UI thread. */
internal class UiLocaleWorkQueue : AutoCloseable {
    private val executor = ThreadPoolExecutor(
        1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue<Runnable>(16),
        { task -> Thread(task, "lazysh-ui-locale").apply { isDaemon = true } },
        ThreadPoolExecutor.AbortPolicy(),
    )
    fun execute(action: () -> Unit): Boolean = try {
        executor.execute(action); true
    } catch (_: RejectedExecutionException) { false }
    override fun close() { executor.shutdown() }
}

/** Last inspected presentation is independent of a potentially slow persistence transaction. */
internal class UiLocaleStore(
    private val read: () -> UiLocaleState,
    private val write: (UiLocaleState) -> Unit,
) {
    private val mutations = Any()
    @Volatile private var snapshot = runCatching { read() }
    fun presentation(): UiLocaleState = snapshot.getOrThrow()
    fun refresh(): UiLocaleState = synchronized(mutations) { inspect() }
    private fun inspect(): UiLocaleState {
        snapshot = runCatching { read() }
        return snapshot.getOrThrow()
    }
    fun set(choice: String, expectedRevision: String): UiLocaleState = synchronized(mutations) {
        require(UiLocalePolicy.validChoice(choice) && UiLocalePolicy.validRevision(expectedRevision)) { "Invalid interface language" }
        val previous = inspect()
        check(previous.revision == expectedRevision) { "Interface language changed; refresh and retry" }
        if (previous.choice == choice) return@synchronized previous
        val next = UiLocaleState(choice, UUID.randomUUID().toString())
        try { write(next) } finally {
            // SharedPreferences may update memory even when commit reports a disk failure.
            snapshot = runCatching { read() }
        }
        snapshot.getOrThrow()
    }
}
