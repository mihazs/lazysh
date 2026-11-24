package app.lazysh.client

/** What the keyboard delivered to a native surface, for the page to forward to the session's core. */
sealed interface SurfaceInput {
    data class Text(val text: String) : SurfaceInput
    data class Key(val key: TerminalKey) : SurfaceInput
    data class Paste(val text: String) : SurfaceInput

    /** The text the keyboard is composing (null: none), which the page draws at the cursor until it is committed or dropped. */
    data class Preedit(val text: String?) : SurfaceInput
}

/**
 * The sink of a native surface's [TerminalInputView]: it holds what was typed, in order, until the page asks for it, and hands
 * it over once. Owned by the session and not by the host view, so a recreated Activity loses nothing and repeats nothing: an
 * event leaves the queue in the one delivery that carries it. At most one page waits; a newer wait ends the older with nothing.
 */
class InputRelay : TerminalInputSink {
    private val queue = ArrayList<SurfaceInput>()
    private var waiter: ((List<SurfaceInput>) -> Unit)? = null
    private var preedit: String? = null

    override fun text(text: String) = push(SurfaceInput.Text(text))
    override fun key(key: TerminalKey) = push(SurfaceInput.Key(key))
    override fun paste(pasted: String) = push(SurfaceInput.Paste(pasted))

    // The bridge keeps the text on the device for review; the page has no review surface yet.
    override fun unapplied(edit: UnappliedEdit?) {}

    fun preedit(text: String?) {
        if (text == preedit) return
        preedit = text
        push(SurfaceInput.Preedit(text))
    }

    fun take(deliver: (List<SurfaceInput>) -> Unit) {
        waiter?.invoke(emptyList())
        waiter = null
        if (queue.isEmpty()) waiter = deliver else flush(deliver)
    }

    /** End the old poll so the page can request input from its next surface. */
    fun clear() {
        queue.clear()
        preedit = null
        val pending = waiter
        waiter = null
        pending?.invoke(emptyList())
    }

    private fun push(event: SurfaceInput) {
        queue += event
        if (queue.size > LIMIT) queue.removeAt(0)
        waiter?.let { waiter = null; flush(it) }
    }

    private fun flush(deliver: (List<SurfaceInput>) -> Unit) {
        val batch = ArrayList(queue)
        queue.clear()
        deliver(batch)
    }

    private companion object { const val LIMIT = 1024 }
}
