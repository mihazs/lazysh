package app.lazysh.displayidle

import java.util.UUID

internal class DisplayIdleState(private val set: (Boolean) -> Unit, private val read: () -> Boolean) {
    companion object { const val MAX_TICKET = 9007199254740991L }
    var epoch = UUID.randomUUID().toString(); private set
    private var issued = 0L
    private var highwater = 0L
    private var owner: Long? = null
    val active get() = owner != null && read()
    fun issue(): Long { check(issued < MAX_TICKET) { "Display ticket limit reached" }; return ++issued }
    private fun valid(expected: String, ticket: Long) = expected == epoch && ticket > 0 && ticket <= issued
    fun acquire(expected: String, ticket: Long, ready: Boolean) {
        require(valid(expected, ticket) && ticket > highwater) { "Expired display ticket" }
        highwater = ticket
        check(ready) { "Native display owner is not foreground and focused" }
        owner = ticket
        try { set(true); check(read()) { "Native display flag was not enabled" } }
        catch (error: Exception) { clear(); throw error }
    }
    fun release(expected: String, ticket: Long) {
        if (!valid(expected, ticket)) return
        highwater = maxOf(highwater, ticket)
        if (owner == ticket) clear()
    }
    fun invalidate() { epoch = UUID.randomUUID().toString(); issued = 0; highwater = 0; clear() }
    private fun clear() {
        if (owner == null) return
        set(false); check(!read()) { "Native display flag was not released" }; owner = null
    }
}
