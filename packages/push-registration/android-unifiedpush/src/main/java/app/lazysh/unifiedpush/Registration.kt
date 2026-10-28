package app.lazysh.unifiedpush

import java.net.URI

internal fun usableEndpoint(url: String, hasKeys: Boolean): Boolean {
    if (!hasKeys || url.length > 1000 || url.toByteArray(Charsets.UTF_8).size > 1000) return false
    return try {
        val uri = URI(url)
        uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawFragment == null
    } catch (_: Exception) { false }
}

internal enum class Phase { OFF, SELECTING, REQUESTED, READY, FAILED, UNAVAILABLE, REVOKE_PENDING }

/** No endpoints, keys or message bodies are stored by this registration-only slice. */
internal data class Registration(val instance: String? = null, val enabled: Boolean = false, val phase: Phase = Phase.OFF)
internal interface RegistrationStore { var value: Registration }
internal interface DistributorDriver {
    fun register(instance: String)
    fun unregister(instance: String)
}

internal class RegistrationController(
    private val store: RegistrationStore,
    private val driver: DistributorDriver,
    private val newInstance: () -> String,
) {
    private var epoch = 0L
    private var selecting = false
    private var selection = 0L
    val registration: Registration @Synchronized get() = store.value
    val busy: Boolean @Synchronized get() = selecting

    @Synchronized fun register(expected: Long, select: ((Boolean) -> Unit) -> Unit, done: (Boolean) -> Unit) {
        if (expected < epoch || selecting || store.value.phase == Phase.REVOKE_PENDING) { done(false); return }
        epoch = expected
        val instance = store.value.instance ?: newInstance()
        store.value = Registration(instance, true, Phase.SELECTING)
        selecting = true
        val ticket = ++selection
        try {
            select { selected ->
                synchronized(this) {
                    if (!selecting || ticket != selection) return@synchronized
                    selecting = false
                    if (!store.value.enabled || store.value.instance != instance) {
                        // Disable already invalidated this selection. Never issue Register now.
                        done(false)
                    } else if (!selected) {
                        revoke()
                        done(false)
                    } else {
                        store.value = store.value.copy(phase = Phase.REQUESTED)
                        try { driver.register(instance); done(true) }
                        catch (_: Exception) { store.value = store.value.copy(phase = Phase.FAILED); done(false) }
                    }
                }
            }
        } catch (_: Exception) {
            selecting = false
            revoke()
            done(false)
        }
    }

    @Synchronized fun disable(expected: Long): Boolean {
        if (expected < epoch) return false
        epoch = expected
        return revoke()
    }

    private fun revoke(): Boolean {
        val instance = store.value.instance
        // Persist rejection before touching the connector or receiving another callback.
        store.value = Registration(instance, false, if (instance == null) Phase.OFF else Phase.REVOKE_PENDING)
        if (instance == null) return true
        return try {
            driver.unregister(instance)
            store.value = Registration()
            true
        } catch (_: Exception) { false }
    }

    @Synchronized fun endpoint(instance: String, usable: Boolean, temporary: Boolean) {
        update(instance, if (temporary) Phase.UNAVAILABLE else if (usable) Phase.READY else Phase.FAILED)
    }

    @Synchronized fun failed(instance: String) { update(instance, Phase.FAILED) }
    @Synchronized fun unavailable(instance: String) { update(instance, Phase.UNAVAILABLE) }
    private fun update(instance: String, phase: Phase) {
        if (store.value.enabled && store.value.instance == instance) store.value = store.value.copy(phase = phase)
    }

    @Synchronized fun unregistered(instance: String) {
        if (store.value.instance == instance) store.value = Registration()
    }
}
