package app.lazysh.unifiedpush

import android.app.Activity
import android.content.Context
import app.lazysh.push.common.RegistrationPlugin
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage
import org.unifiedpush.android.connector.data.ResolvedDistributor

internal object PushRegistration {
    private var instance: RegistrationController? = null
    @Synchronized fun controller(context: Context): RegistrationController {
        instance?.let { return it }
        val app = context.applicationContext
        val prefs = app.getSharedPreferences("lazysh-unifiedpush-registration", Context.MODE_PRIVATE)
        val store = object : RegistrationStore {
            override var value: Registration
                get() {
                    val phase = try { Phase.valueOf(prefs.getString("phase", "OFF")!!) }
                        catch (_: Exception) { Phase.OFF }
                    return Registration(prefs.getString("instance", null), prefs.getBoolean("enabled", false), phase)
                }
                set(value) {
                    check(prefs.edit().putString("instance", value.instance).putBoolean("enabled", value.enabled)
                        .putString("phase", value.phase.name).commit())
                }
        }
        val driver = object : DistributorDriver {
            override fun register(instance: String) {
                val vapid=PushEnrollment.controller(app).bind(instance)
                UnifiedPush.register(app, instance=instance, vapid=vapid,
                    messageForDistributor=if (vapid==null) "lazysh registration only" else "lazysh relay verification")
            }
            override fun unregister(instance: String) { UnifiedPush.unregister(app, instance) }
        }
        return RegistrationController(store, driver) { UUID.randomUUID().toString() }.also { instance = it }
    }
}

/** The SDK owns keys/protocol identity. Only decrypted challenges and strictly
 * bound events enter their separate native consent gates. */
class RegistrationService : PushService() {
    private fun controller() = PushRegistration.controller(applicationContext)
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        try {
            val usable=usableEndpoint(endpoint.url,endpoint.pubKeySet!=null)
            controller().endpoint(instance,usable,endpoint.temporary)
            val keys=endpoint.pubKeySet
            if (usable && !endpoint.temporary && keys!=null)
                PushEnrollment.controller(applicationContext).endpoint(instance,EndpointKeys(endpoint.url,keys.pubKey,keys.auth))
        } catch (_:Exception) { /* Fail closed without echoing callback/private storage values. */ }
    }
    override fun onMessage(message: PushMessage, instance: String) {
        try {
            val proof=parseChallenge(message.content,message.decrypted)
            if (proof!=null) PushEnrollment.controller(applicationContext).message(instance,proof)
            else parseDisplayEvent(message.content,message.decrypted)?.let { PushDisplay.message(applicationContext,instance,it) }
        } catch (_:Exception) { /* No storage fallback, unbound confirmation or display retry. */ }
    }
    override fun onRegistrationFailed(reason: FailedReason, instance: String) { controller().failed(instance) }
    override fun onUnregistered(instance: String) {
        controller().unregistered(instance)
        // Instance-aware cleanup cannot let a late old callback pause a newer
        // enrollment's display consent.
        try { PushDisplay.controller(applicationContext).disableInstance(instance) } catch (_:Exception) { /* Local binding is retired. */ }
        try { PushEnrollment.controller(applicationContext).pause(instance) } catch (_:Exception) { /* Remain locally off. */ }
    }
    override fun onTempUnavailable(instance: String) { controller().unavailable(instance) }
}

@TauriPlugin
class PushPlugin(private val activity: Activity) : RegistrationPlugin(activity) {
    private fun controller() = PushRegistration.controller(activity)
    private fun statusValue() = run {
        val controller = controller()
        val registration = controller.registration
        val enrollment=PushEnrollment.controller(activity)
        val privateState=try { enrollment.state() } catch (_:Exception) { null }
        val available = UnifiedPush.resolveDefaultDistributor(activity) !is ResolvedDistributor.NoneAvailable
        registrationStatus("unifiedpush", available, registration.enabled, registration.instance != null || privateState!=null || enrollment.unavailable(),
            controller.busy || enrollment.busy(), PushEnrollment.reason(activity) ?: when {
                !available -> "Install and configure a free-software UnifiedPush distributor. No delivery service is connected."
                controller.busy -> "Waiting for your distributor selection. You can pause registration."
                registration.phase == Phase.REVOKE_PENDING -> "Registration is paused; local connector cleanup needs retry."
                registration.phase == Phase.READY -> "Distributor endpoint received. No delivery service is connected; remote messages are ignored."
                registration.phase == Phase.UNAVAILABLE -> "Distributor temporarily unavailable. No delivery service is connected."
                registration.phase == Phase.FAILED -> "Distributor registration failed. Refresh or pause registration; no delivery service is connected."
                registration.enabled -> "Registration requested; waiting for the distributor. No delivery service is connected."
                else -> "Registration is off. Enabling lets you choose a distributor; no delivery service is connected."
            }).apply {
                put("displaySupported",privateState?.phase==EnrollmentPhase.CONFIRMED)
                put("displayEnabled",try { PushDisplay.enabled(activity) } catch (_:Exception) { false })
            }
    }
    @Command fun status(invoke: Invoke) {
        try { invoke.resolve(statusValue()) } catch (_: Exception) { invoke.reject("Cannot inspect UnifiedPush registration") }
    }
    @Command fun display(invoke:Invoke) {
        val permit=try { invoke.parseArgs(DisplayControl::class.java).permit }
            catch (_:Exception) { invoke.reject("Cannot start native notification consent"); return }
        DisplayConsentDialog.show(activity,permit) { success ->
            try {
                if (success) invoke.resolve(statusValue())
                else invoke.reject("Notification display was cancelled or unavailable; inspect permission and enrollment")
            } catch (_:Exception) { invoke.reject("Cannot inspect notification display") }
        }
    }
    @Command fun register(invoke: Invoke) {
        try {
            if (!notificationPermission()) { invoke.reject("Enable system notification permission from the inbox first"); return }
            val state=PushEnrollment.controller(activity).state()
            if (state!=null && (state.phase==EnrollmentPhase.REVOKE_PENDING || state.deviceId==null)) {
                invoke.reject("Complete or pause the private relay enrollment first"); return
            }
            startRegistration(operationEpoch(invoke)) { success ->
                if (success) invoke.resolve(statusValue()) else invoke.reject("Registration was cancelled, failed or paused; inspect status")
            }
        } catch (_: Exception) { invoke.reject("Cannot register with UnifiedPush") }
    }
    private fun startRegistration(epoch:Long, done:(Boolean)->Unit) {
            controller().register(epoch, { complete ->
                activity.runOnUiThread {
                    try {
                        if (activity.isFinishing || activity.isDestroyed) complete(false)
                        else UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { selected ->
                            complete(selected && !activity.isFinishing && !activity.isDestroyed)
                        }
                    } catch (_: Exception) { complete(false) }
                }
            },done)
    }
    @Command fun enroll(invoke:Invoke) {
        val completed=AtomicBoolean(false)
        fun finish(success:Boolean) {
            if (!completed.compareAndSet(false,true)) return
            try { if (success) invoke.resolve(statusValue()) else invoke.reject("Private enrollment was cancelled or failed; inspect status") }
            catch (_:Exception) { invoke.reject("Cannot complete private enrollment") }
        }
        try {
            if (!notificationPermission() || UnifiedPush.resolveDefaultDistributor(activity) is ResolvedDistributor.NoneAvailable) {
                invoke.reject("Enable notification permission and install a UnifiedPush distributor first"); return
            }
            val epoch=operationEpoch(invoke)
            val enrollment=PushEnrollment.controller(activity)
            val state=enrollment.state()
            if (state?.phase==EnrollmentPhase.REVOKE_PENDING || !controller().reserveEnrollment(epoch)) {
                invoke.reject("Pause existing registration or finish private relay removal first"); return
            }
            EnrollmentDialog.show(activity,state,{ origin,code ->
                val ready:(Boolean)->Unit={ success ->
                    if (!success || activity.isFinishing || activity.isDestroyed) finish(false)
                    else try { startRegistration(epoch,::finish) } catch (_:Exception) { finish(false) }
                }
                try {
                    if (state==null) enrollment.begin(epoch,checkNotNull(origin),checkNotNull(code),ready)
                    else enrollment.resume(epoch,ready)
                } catch (_:Exception) { finish(false) }
            },{ finish(false) })
        } catch (_:Exception) { finish(false) }
    }
    @Command fun disable(invoke: Invoke) {
        try {
            val enrollment=PushEnrollment.controller(activity)
            var admitted=false
            val local=controller().disable(operationEpoch(invoke)) {
                admitted=true
                enrollment.cancel()
                EnrollmentDialog.cancel(activity)
                DisplayConsentDialog.cancel(activity)
                // A display-storage error must not prevent the original durable
                // registration revocation; its failed controller remains closed.
                try { PushDisplay.controller(activity).disable() } catch (_:Exception) {}
            }
            if (admitted) enrollment.pause()
            if (local) invoke.resolve(statusValue())
            else invoke.reject("Registration is paused; connector cleanup needs retry")
        } catch (_: Exception) { invoke.reject("Cannot pause UnifiedPush registration; inspect status") }
    }
}
