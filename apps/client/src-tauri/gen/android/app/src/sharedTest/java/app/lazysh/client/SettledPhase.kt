package app.lazysh.client

/**
 * Test-only admission for an asynchronous UI phase. A matching sample becomes
 * the phase result only after the identical sample has persisted for [stableMs].
 * Mosh can deliver a resized frame before its remote program repaints it, and an
 * IME animation can dispatch intermediate layouts; neither is a settled phase.
 */
internal class SettledPhase(private val stableMs: Long) {
    private var candidate: String? = null
    private var since = 0L

    init {
        require(stableMs in 1..10_000) { "Settled phase window bound" }
    }

    /** Returns true once [sample] has matched, unchanged, for at least [stableMs]. */
    fun admit(nowMs: Long, matches: Boolean, sample: String): Boolean {
        if (!matches) {
            candidate = null
            return false
        }
        if (sample != candidate || nowMs < since) {
            candidate = sample
            since = nowMs
            return false
        }
        return nowMs - since >= stableMs
    }

    fun reset() {
        candidate = null
    }
}
