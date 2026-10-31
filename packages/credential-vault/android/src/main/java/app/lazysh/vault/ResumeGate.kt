package app.lazysh.vault

/** Native view authority. All platform events happen before their Rust notifications. */
internal class ResumeGate {
    var nativeGeneration: Long = 0
        private set
    private var authorityGeneration: Long = -1
    private var enabled: Boolean? = null
    private var locked = true
    private var privacy = false
    private var foreground = true
    val awaitingPolicy get() = enabled == null
    val covered get() = enabled != false && (locked || privacy || !foreground)
    val protectsContent get() = enabled != false
    fun rebind(resumed: Boolean) { nativeGeneration++; enabled = null; locked = true; foreground = resumed; privacy = !resumed }
    fun pause() { privacy = true }
    fun background() { nativeGeneration++; foreground = false; privacy = true; if (enabled != false) locked = true }
    fun resume() { foreground = true; privacy = false }
    fun apply(covered: Boolean, enabled: Boolean, generation: Long, nativeGeneration: Long): Boolean {
        if (generation < authorityGeneration || (!(covered && enabled) && nativeGeneration != this.nativeGeneration) || (!covered && enabled && !foreground)) return false
        authorityGeneration = generation
        this.enabled = enabled
        locked = covered
        return true
    }
}
