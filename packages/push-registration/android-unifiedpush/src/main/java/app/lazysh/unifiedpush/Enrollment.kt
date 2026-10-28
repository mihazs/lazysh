package app.lazysh.unifiedpush

import java.net.URI
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.Executor

internal fun relayOrigin(value: String): String {
    require(value.toByteArray(Charsets.UTF_8).size <= 2048)
    val uri = URI(value)
    require(uri.scheme == "https" && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null &&
        uri.rawQuery == null && uri.rawFragment == null && uri.rawPath in listOf("", "/") &&
        uri.port in -1..65535 && uri.port != 0 && !value.any(Char::isISOControl))
    return URI("https", null, uri.host.lowercase(), if (uri.port == 443) -1 else uri.port, null, null, null).toASCIIString()
}
internal fun capability(value: String): Boolean = value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }
internal fun canonicalUuid(value: String): Boolean = try {
    UUID.fromString(value).let { it != UUID(0, 0) && it.toString() == value }
} catch (_: Exception) { false }
internal fun newCredential(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }
    .joinToString("") { "%02x".format(it.toInt() and 255) }

internal enum class EnrollmentPhase { BOOTSTRAP, REGISTER, SUBSCRIBE, VERIFY, CONFIRMED, FAILED, REVOKE_PENDING }

/** Private state: its only serialization is encrypted storage, never IPC or logging. */
internal data class EnrollmentState(
    val localId: String,
    val epoch: Long,
    val origin: String,
    val credential: String,
    val bootstrapId: String,
    val enrollment: String?,
    val phase: EnrollmentPhase,
    val deviceId: String? = null,
    val generation: Long? = null,
    val vapid: String? = null,
    val instance: String? = null,
    val endpoint: EndpointKeys? = null,
    val subscriptionId: String? = null,
    val challengeId: String? = null,
) {
    override fun toString() = "PrivateEnrollment"
}
internal data class EndpointKeys(val endpoint: String, val publicKey: String, val auth: String) {
    override fun toString() = "PrivateEndpointKeys"
}
internal data class BootstrapReply(val deviceId: String, val generation: Long, val vapid: String)
internal data class Challenge(val deviceId: String, val generation: Long, val challengeId: String, val nonce: String) {
    override fun toString() = "PrivateChallenge"
}
internal interface EnrollmentStore { var value: EnrollmentState? }

/** Every implementation must hold the registration gate before invoking action.
 * Enrollment never calls this gate while holding its own monitor. */
internal interface EnrollmentGate {
    fun reserved(epoch: Long, action: () -> Unit): Boolean
    fun current(instance: String, action: () -> Unit): Boolean
}
/** Keeps native enrollment and its controlled fixtures on the same consent gate. */
internal class RegistrationEnrollmentGate(private val registration: RegistrationController): EnrollmentGate {
    override fun reserved(epoch: Long, action: () -> Unit) = registration.withReserved(epoch, action)
    override fun current(instance: String, action: () -> Unit) = registration.withCurrent(instance, action)
}
internal class EnrollmentCall {
    private var cancelled = false
    private var abort: (() -> Unit)? = null
    @Synchronized fun install(action: () -> Unit) {
        if (cancelled) action() else abort = action
    }
    @Synchronized fun cancel() {
        cancelled = true
        val action=abort
        abort=null
        try { action?.invoke() } catch (_:Exception) { /* Cancellation still retires authority. */ }
    }
    @Synchronized fun active() = !cancelled
}
internal interface EnrollmentRelay {
    fun bootstrap(state: EnrollmentState, call: EnrollmentCall): BootstrapReply
    fun subscribe(state: EnrollmentState, call: EnrollmentCall): String
    fun confirm(state: EnrollmentState, proof: Challenge, call: EnrollmentCall)
    fun revoke(state: EnrollmentState, call: EnrollmentCall)
}

/** One private lifecycle, no event or notification-display authority. Network work
 * is outside both monitors; every publication re-enters the original consent gate. */
internal class EnrollmentController(
    storage: EnrollmentStore,
    private val relay: EnrollmentRelay,
    private val gate: EnrollmentGate,
    private val executor: Executor,
    private val uuid: () -> String = { UUID.randomUUID().toString() },
    private val secret: () -> String = ::newCredential,
) {
    private val lock = Any()
    private var storageFailed=false
    private fun <T> checkedStorage(action:()->T):T {
        check(!storageFailed) { "Private enrollment storage unavailable" }
        return try { action() } catch (_:Exception) {
            storageFailed=true
            throw IllegalStateException("Private enrollment storage unavailable")
        }
    }
    private val store=object:EnrollmentStore {
        override var value:EnrollmentState?
            get()=checkedStorage { storage.value }
            set(value) { checkedStorage { storage.value=value } }
    }
    private var active: EnrollmentCall? = null
    private var revoking=false
    private var buffered: Challenge? = null
    fun cancel() = synchronized(lock) { if (!revoking) active?.cancel(); buffered = null }
    fun state(): EnrollmentState? = synchronized(lock) { store.value }
    fun busy(): Boolean = synchronized(lock) { active != null }
    fun unavailable():Boolean = synchronized(lock) { storageFailed }

    fun begin(epoch: Long, origin: String, enrollment: String, done: (Boolean) -> Unit) {
        val canonical = relayOrigin(origin)
        require(capability(enrollment))
        var captured: EnrollmentState? = null
        gate.reserved(epoch) {
            synchronized(lock) {
                check(active == null && store.value == null)
                val credential = secret()
                check(capability(credential) && credential != enrollment)
                captured = EnrollmentState(uuid(), epoch, canonical, credential, uuid(), enrollment, EnrollmentPhase.BOOTSTRAP)
                store.value = captured
            }
        }
        val state = captured ?: return done(false)
        bootstrap(state, done)
    }
    fun resume(epoch: Long, done: (Boolean) -> Unit) {
        var captured: EnrollmentState? = null
        gate.reserved(epoch) {
            synchronized(lock) {
                check(active == null)
                val previous = checkNotNull(store.value)
                check(previous.phase != EnrollmentPhase.REVOKE_PENDING && previous.instance == null)
                captured = previous.copy(epoch = epoch)
                store.value = captured
            }
        }
        val state = captured ?: return done(false)
        if (state.deviceId != null) done(true) else bootstrap(state, done)
    }
    private fun bootstrap(state: EnrollmentState, done: (Boolean) -> Unit) {
        launch(state, { relay.bootstrap(state, it) }, { reply ->
            publish(state, state.copy(enrollment = null, phase = EnrollmentPhase.REGISTER,
                deviceId = reply.deviceId, generation = reply.generation, vapid = reply.vapid))
        }, done)
    }
    /** Called by the existing registration driver inside its registration gate. */
    fun bind(instance: String): String? = synchronized(lock) {
        val state = store.value ?: return null
        check(state.phase != EnrollmentPhase.REVOKE_PENDING && state.deviceId != null && state.vapid != null)
        check(state.instance == null || state.instance == instance)
        store.value = state.copy(instance = instance)
        state.vapid
    }
    fun endpoint(instance: String, endpoint: EndpointKeys) {
        var captured: EnrollmentState? = null
        gate.current(instance) {
            synchronized(lock) {
                val state = store.value ?: return@synchronized
                if (state.instance != instance || state.phase == EnrollmentPhase.REVOKE_PENDING) return@synchronized
                if (state.endpoint == endpoint && (active != null || state.phase == EnrollmentPhase.CONFIRMED)) return@synchronized
                active?.cancel(); active = null; buffered = null
                captured = state.copy(endpoint = endpoint, subscriptionId = uuid(), challengeId = null, phase = EnrollmentPhase.SUBSCRIBE)
                store.value = captured
            }
        }
        val state = captured ?: return
        launch(state, { relay.subscribe(state, it) }, { challengeId ->
            publish(state, state.copy(challengeId = challengeId, phase = EnrollmentPhase.VERIFY))
        }) { success ->
            if (success) {
                val pending = synchronized(lock) { buffered.also { buffered = null } }
                if (pending != null) message(instance, pending)
            }
        }
    }
    fun message(instance: String, proof: Challenge) {
        var captured: EnrollmentState? = null
        gate.current(instance) {
            synchronized(lock) {
                val state = store.value ?: return@synchronized
                if (state.instance != instance || state.deviceId != proof.deviceId || state.generation != proof.generation ||
                    state.phase !in listOf(EnrollmentPhase.SUBSCRIBE, EnrollmentPhase.VERIFY)) return@synchronized
                if (state.challengeId == null) { buffered = proof; return@synchronized }
                if (active != null || state.challengeId != proof.challengeId) return@synchronized
                captured = state
            }
        }
        val state = captured ?: return
        launch(state, { relay.confirm(state, proof, it) }, {
            publish(state, state.copy(phase = EnrollmentPhase.CONFIRMED, challengeId = null))
        }) {}
    }
    /** Local consent must be retired first by the registration controller. */
    fun pause(instance: String? = null) {
        val state = synchronized(lock) {
            val current = store.value ?: return
            if (instance != null && current.instance != instance) return
            if (current.phase == EnrollmentPhase.REVOKE_PENDING && (instance != null || active != null)) return
            active?.cancel(); active = null; buffered = null
            current.copy(phase = EnrollmentPhase.REVOKE_PENDING, enrollment = null).also { store.value = it }
        }
        launch(state, { relay.revoke(state, it) }, {
            synchronized(lock) { if (same(state)) { store.value = null; true } else false }
        }) {}
    }
    private fun publish(previous:EnrollmentState, next:EnrollmentState):Boolean {
        var accepted=false
        val update={ synchronized(lock) { if (same(previous)) { store.value=next; accepted=true } }; Unit }
        val allowed=if (previous.instance==null) gate.reserved(previous.epoch,update) else gate.current(previous.instance,update)
        return allowed && accepted
    }
    private fun same(state: EnrollmentState): Boolean {
        return store.value == state
    }
    private fun admit(state:EnrollmentState, call:EnrollmentCall):Boolean {
        var admitted=false
        val check={ synchronized(lock) { admitted=active===call && call.active() && same(state) }; Unit }
        val allowed=when {
            state.phase==EnrollmentPhase.REVOKE_PENDING -> { check(); true }
            state.instance==null -> gate.reserved(state.epoch,check)
            else -> gate.current(state.instance,check)
        }
        return allowed && admitted
    }
    private fun <T> launch(state: EnrollmentState, work: (EnrollmentCall) -> T, publish: (T) -> Boolean, done: (Boolean) -> Unit) {
        val call = synchronized(lock) {
            if (!same(state) || active != null) null else EnrollmentCall().also { active = it; revoking=state.phase==EnrollmentPhase.REVOKE_PENDING }
        } ?: return done(false)
        try {
            executor.execute {
                var success = false
                try {
                    check(admit(state,call))
                    val result = work(call)
                    if (call.active()) {
                        release(call)
                        success = publish(result) && call.active()
                    }
                } catch (_: Exception) {
                    try { synchronized(lock) {
                        if (active === call && same(state)) {
                            buffered=null
                            if (state.phase != EnrollmentPhase.REVOKE_PENDING) store.value = state.copy(phase = EnrollmentPhase.FAILED)
                        }
                    } } catch (_:Exception) { /* Remain unconfirmed; never echo storage errors. */ }
                } finally {
                    release(call)
                    done(success)
                }
            }
        } catch (_: Exception) {
            release(call)
            done(false)
        }
    }
    private fun release(call:EnrollmentCall) = synchronized(lock) { if (active===call) { active=null; revoking=false } }
}
