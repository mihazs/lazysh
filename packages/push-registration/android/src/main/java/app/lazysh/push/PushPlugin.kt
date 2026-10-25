package app.lazysh.push

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService

@InvokeArg class PushControl { var operationEpoch: Long = 0 }

internal object PushRegistration {
    private var instance: RegistrationController? = null
    @Synchronized fun controller(context: Context): RegistrationController? {
        instance?.let { return it }
        // Build resources must identify a real Firebase project. No invented/default project.
        val app = FirebaseApp.getApps(context).firstOrNull { it.name == FirebaseApp.DEFAULT_APP_NAME }
            ?: FirebaseApp.initializeApp(context) ?: return null
        val options = app.options
        if (options.applicationId.isEmpty() || options.apiKey.isEmpty() || options.projectId.isNullOrEmpty() || options.gcmSenderId.isNullOrEmpty()) return null
        val prefs = context.getSharedPreferences("lazysh-push-registration", Context.MODE_PRIVATE)
        val store = object : RegistrationStore {
            override var enabled: Boolean
                get() = prefs.getBoolean("enabled", false)
                set(value) { check(prefs.edit().putBoolean("enabled", value).commit()) }
            override var tokenPresent: Boolean
                get() = prefs.getBoolean("tokenPresent", false)
                set(value) { check(prefs.edit().putBoolean("tokenPresent", value).commit()) }
        }
        val messaging = FirebaseMessaging.getInstance()
        val driver = object : MessagingDriver {
            override fun autoInit(enabled: Boolean) { messaging.isAutoInitEnabled = enabled }
            override fun token(done: (Boolean) -> Unit) { messaging.token.addOnCompleteListener { done(it.isSuccessful && !it.result.isNullOrEmpty()) } }
            override fun delete(done: (Boolean) -> Unit) { messaging.deleteToken().addOnCompleteListener { done(it.isSuccessful) } }
        }
        driver.autoInit(store.enabled)
        return RegistrationController(store, driver).also { instance = it }
    }
}

/** No message bodies are logged, persisted or forwarded to the SSH inbox. */
class PushMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        try { PushRegistration.controller(applicationContext)?.rotated() } catch (_: Exception) { /* UI exposes retry. */ }
    }
}

@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
    private fun controller() = PushRegistration.controller(activity.applicationContext)
    private fun statusValue(): JSObject {
        val controller = controller()
        val services = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS
        return JSObject().apply {
            put("provider", "fcm")
            put("supported", true)
            put("configured", controller != null && services)
            put("enabled", controller?.enabled == true)
            put("tokenPresent", controller?.tokenPresent == true)
            put("busy", controller?.busy == true)
            put("reason", when {
                controller == null -> "This build has no Firebase application configuration. Remote push is unavailable."
                !services -> "Compatible Google Play services are required for FCM registration."
                controller.busy -> "Native registration or token revocation is in progress."
                controller.enabled -> "Device registration enabled. No delivery service is configured by this control."
                controller.tokenPresent -> "Registration is paused; token revocation needs retry."
                else -> "Remote registration is off. Enabling contacts Google's Firebase service."
            })
        }
    }
    @Command fun status(invoke: Invoke) {
        try { invoke.resolve(statusValue()) } catch (_: Exception) { invoke.reject("Cannot inspect native push registration") }
    }
    @Command fun register(invoke: Invoke) {
        try {
            val controller = controller() ?: run { invoke.reject("This build has no Firebase application configuration"); return }
            if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) != ConnectionResult.SUCCESS) { invoke.reject("Compatible Google Play services are required"); return }
            val permitted = NotificationManagerCompat.from(activity).areNotificationsEnabled() &&
                (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            if (!permitted) { invoke.reject("Enable system notification permission from the inbox first"); return }
            controller.register(invoke.parseArgs(PushControl::class.java).operationEpoch) { success ->
                if (success) invoke.resolve(statusValue()) else invoke.reject("Registration failed, was paused, or another operation is active; inspect status and retry")
            }
        } catch (_: Exception) { invoke.reject("Cannot register this device for remote push") }
    }
    @Command fun disable(invoke: Invoke) {
        try {
            val controller = controller() ?: run { invoke.resolve(statusValue()); return }
            controller.disable(invoke.parseArgs(PushControl::class.java).operationEpoch) { success ->
                if (success) invoke.resolve(statusValue()) else invoke.reject("Registration is paused, but token revocation failed; retry when online")
            }
        } catch (_: Exception) { invoke.reject("Cannot revoke native push registration; inspect status and retry") }
    }
}
