package app.lazysh.unifiedpush

import android.app.Activity
import android.content.Context
import app.lazysh.push.common.RegistrationPlugin
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import java.util.UUID
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
            override fun register(instance: String) { UnifiedPush.register(app, instance = instance, messageForDistributor = "lazysh registration only") }
            override fun unregister(instance: String) { UnifiedPush.unregister(app, instance) }
        }
        return RegistrationController(store, driver) { UUID.randomUUID().toString() }.also { instance = it }
    }
}

/** The SDK owns keys/protocol identity. This slice deliberately admits no message content. */
class RegistrationService : PushService() {
    private fun controller() = PushRegistration.controller(applicationContext)
    override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
        controller().endpoint(instance, usableEndpoint(endpoint.url, endpoint.pubKeySet != null), endpoint.temporary)
    }
    override fun onMessage(message: PushMessage, instance: String) { /* No storage, display or delivery authority. */ }
    override fun onRegistrationFailed(reason: FailedReason, instance: String) { controller().failed(instance) }
    override fun onUnregistered(instance: String) { controller().unregistered(instance) }
    override fun onTempUnavailable(instance: String) { controller().unavailable(instance) }
}

@TauriPlugin
class PushPlugin(private val activity: Activity) : RegistrationPlugin(activity) {
    private fun controller() = PushRegistration.controller(activity)
    private fun statusValue() = run {
        val controller = controller()
        val registration = controller.registration
        val available = UnifiedPush.resolveDefaultDistributor(activity) !is ResolvedDistributor.NoneAvailable
        registrationStatus("unifiedpush", available, registration.enabled, registration.instance != null,
            controller.busy, when {
                !available -> "Install and configure a free-software UnifiedPush distributor. No delivery service is connected."
                controller.busy -> "Waiting for your distributor selection. You can pause registration."
                registration.phase == Phase.REVOKE_PENDING -> "Registration is paused; local connector cleanup needs retry."
                registration.phase == Phase.READY -> "Distributor endpoint received. No delivery service is connected; remote messages are ignored."
                registration.phase == Phase.UNAVAILABLE -> "Distributor temporarily unavailable. No delivery service is connected."
                registration.phase == Phase.FAILED -> "Distributor registration failed. Refresh or pause registration; no delivery service is connected."
                registration.enabled -> "Registration requested; waiting for the distributor. No delivery service is connected."
                else -> "Registration is off. Enabling lets you choose a distributor; no delivery service is connected."
            })
    }
    @Command fun status(invoke: Invoke) {
        try { invoke.resolve(statusValue()) } catch (_: Exception) { invoke.reject("Cannot inspect UnifiedPush registration") }
    }
    @Command fun register(invoke: Invoke) {
        try {
            if (!notificationPermission()) { invoke.reject("Enable system notification permission from the inbox first"); return }
            controller().register(operationEpoch(invoke), { complete ->
                activity.runOnUiThread {
                    try {
                        if (activity.isFinishing || activity.isDestroyed) complete(false)
                        else UnifiedPush.tryUseCurrentOrDefaultDistributor(activity) { selected ->
                            complete(selected && !activity.isFinishing && !activity.isDestroyed)
                        }
                    } catch (_: Exception) { complete(false) }
                }
            }) { success ->
                if (success) invoke.resolve(statusValue()) else invoke.reject("Registration was cancelled, failed or paused; inspect status")
            }
        } catch (_: Exception) { invoke.reject("Cannot register with UnifiedPush") }
    }
    @Command fun disable(invoke: Invoke) {
        try {
            if (controller().disable(operationEpoch(invoke))) invoke.resolve(statusValue())
            else invoke.reject("Registration is paused; connector cleanup needs retry")
        } catch (_: Exception) { invoke.reject("Cannot pause UnifiedPush registration; inspect status") }
    }
}
