package app.lazysh.vault

internal class CredentialEpoch {
    private var floor = 0L
    var lifecycle = 0L
        private set
    private var foreground = true
    fun cancel(epoch: Long) { require(epoch >= 0); floor = maxOf(floor, epoch) }
    fun background() { foreground = false; lifecycle++ }
    fun resume() { foreground = true }
    fun permits(epoch: Long, started: Long = lifecycle) = epoch >= floor && epoch >= 0 && started == lifecycle && foreground
}
