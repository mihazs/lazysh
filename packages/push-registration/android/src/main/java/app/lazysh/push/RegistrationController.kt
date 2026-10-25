package app.lazysh.push

/** Serializes explicit consent, token creation, rotation and revocation in this process. */
internal interface RegistrationStore {
    var enabled: Boolean
    var tokenPresent: Boolean
}

internal interface MessagingDriver {
    fun autoInit(enabled: Boolean)
    fun token(done: (Boolean) -> Unit)
    fun delete(done: (Boolean) -> Unit)
}

internal class RegistrationController(private val store: RegistrationStore, private val driver: MessagingDriver) {
    private var operation: String? = null
    private var rotation: Long = 0
    private var epoch: Long = 0
    private val disableWaiters = mutableListOf<(Boolean) -> Unit>()
    val enabled: Boolean @Synchronized get() = store.enabled
    val tokenPresent: Boolean @Synchronized get() = store.tokenPresent
    val busy: Boolean @Synchronized get() = operation != null

    @Synchronized fun register(expected: Long = 0, done: (Boolean) -> Unit) {
        if (expected < epoch || operation != null) { done(false); return }
        epoch = expected
        store.enabled = true
        driver.autoInit(true)
        operation = "register"
        driver.token { success ->
            synchronized(this) {
                if (store.enabled) {
                    // Never persist or expose the actual token: Firebase owns token storage.
                    if (success) store.tokenPresent = true
                    operation = null
                    done(success)
                } else {
                    done(false)
                    // Token creation may finish after Disable. Revoke only after it settles.
                    beginDelete()
                }
            }
        }
    }

    @Synchronized fun disable(expected: Long = 0, done: (Boolean) -> Unit) {
        if (expected < epoch) { done(false); return }
        epoch = expected
        store.enabled = false
        driver.autoInit(false)
        disableWaiters.add(done)
        if (operation == null) beginDelete()
    }

    @Synchronized fun rotated() {
        rotation++
        store.tokenPresent = true
        if (!store.enabled && operation == null) beginDelete()
    }

    private fun beginDelete() {
        operation = "delete"
        val started = rotation
        driver.delete { success ->
            synchronized(this) {
                if (success && started != rotation) { beginDelete(); return@synchronized }
                // On failure keep a conservative marker so the UI offers retry.
                store.tokenPresent = !success
                operation = null
                val waiters = disableWaiters.toList()
                disableWaiters.clear()
                waiters.forEach { it(success) }
            }
        }
    }
}
