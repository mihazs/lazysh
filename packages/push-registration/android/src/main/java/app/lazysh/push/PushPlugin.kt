package app.lazysh.push

import android.app.Activity
import android.content.Context
import app.lazysh.push.common.RegistrationPlugin
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService

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
internal class FcmPlugin(private val activity: Activity) : RegistrationPlugin(activity) {
    override val providerChoices = listOf("unifiedpush", "fcm")
    private fun controller() = PushRegistration.controller(activity.applicationContext)
    internal fun statusValue() = run {
        val controller = controller()
        val saved=activity.getSharedPreferences("lazysh-push-registration",Context.MODE_PRIVATE)
        val presence=fcmPresence(controller,saved.getBoolean("enabled",false),saved.getBoolean("tokenPresent",false))
        val services = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) == ConnectionResult.SUCCESS
        registrationStatus("fcm", controller != null && services, presence.enabled,
            presence.tokenPresent, controller?.busy == true, when {
                controller == null && (presence.enabled || presence.tokenPresent) -> "Saved FCM registration is retained. Use a build configured for the original Firebase project to revoke it before switching services."
                controller == null -> "This build has no Firebase application configuration. Select UnifiedPush for Firebase-free remote push."
                !services -> "Compatible Google Play services are required for FCM registration."
                controller.busy -> "Native registration or token revocation is in progress."
                controller.enabled -> "Device registration enabled. No delivery service is configured by this control."
                controller.tokenPresent -> "Registration is paused; token revocation needs retry."
                else -> "Remote registration is off. Enabling contacts Google's Firebase service."
            })
    }
    @Command fun status(invoke: Invoke) {
        try { invoke.resolve(statusValue()) } catch (_: Exception) { invoke.reject("Cannot inspect native push registration") }
    }
    @Command fun register(invoke: Invoke) {
        try {
            val controller = controller() ?: run { invoke.reject("This build has no Firebase application configuration"); return }
            if (GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(activity) != ConnectionResult.SUCCESS) { invoke.reject("Compatible Google Play services are required"); return }
            if (!notificationPermission()) { invoke.reject("Enable system notification permission from the inbox first"); return }
            controller.register(operationEpoch(invoke)) { success ->
                if (success) invoke.resolve(statusValue()) else invoke.reject("Registration failed, was paused, or another operation is active; inspect status and retry")
            }
        } catch (_: Exception) { invoke.reject("Cannot register this device for remote push") }
    }
    @Command fun disable(invoke: Invoke) = revoke(invoke, ::statusValue)
    internal fun revoke(invoke: Invoke, response: () -> JSObject) {
        try {
            val controller = controller() ?: run {
                val saved=statusValue()
                if(saved.getBoolean("enabled") || saved.getBoolean("tokenPresent"))
                    invoke.reject("Saved FCM registration needs its original Firebase project configuration for revocation")
                else invoke.resolve(response())
                return
            }
            controller.disable(operationEpoch(invoke)) { success ->
                if (success) invoke.resolve(response()) else invoke.reject("Registration is paused, but token revocation failed; retry when online")
            }
        } catch (_: Exception) { invoke.reject("Cannot revoke native push registration; inspect status and retry") }
    }
}

internal object GoogleProviderSelection {
    private var instance:ProviderSelection?=null
    @Synchronized fun controller(context:Context):ProviderSelection {
        instance?.let { return it }
        val prefs=context.applicationContext.getSharedPreferences("lazysh-push-provider",Context.MODE_PRIVATE)
        val legacy=context.applicationContext.getSharedPreferences("lazysh-push-registration",Context.MODE_PRIVATE)
        return ProviderSelection(object:ProviderStore {
            override var selected:String?
                get()=prefs.getString("provider",null)
                set(value){check(prefs.edit().putString("provider",value).commit())}
            override val legacyFcmActive:Boolean
                get()=legacy.getBoolean("enabled",false) || legacy.getBoolean("tokenPresent",false)
        }).also {instance=it}
    }
}

/** Both distributors remain opt-in. No provider is switched while it owns state. */
@TauriPlugin
class PushPlugin(private val activity: Activity) : app.lazysh.unifiedpush.PushPlugin(activity) {
    override val providerChoices = listOf("unifiedpush", "fcm")
    private val fcm = FcmPlugin(activity)
    private val choice = GoogleProviderSelection.controller(activity)
    private fun inactive() = !activity.getSharedPreferences("lazysh-push-registration",Context.MODE_PRIVATE).let {
        it.getBoolean("enabled",false) || it.getBoolean("tokenPresent",false)
    } && listOf(fcm.statusValue(),super.statusValue()).all {
        !it.getBoolean("enabled") && !it.getBoolean("tokenPresent") && !it.getBoolean("busy")
    }
    private fun cleanup(unified:JSObject,fcmStatus:JSObject) = previousFcmCleanup(
        choice.provider(),unified.getBoolean("enabled") || unified.getBoolean("tokenPresent") || unified.getBoolean("busy"),
        FcmPresence(fcmStatus.getBoolean("enabled"),fcmStatus.getBoolean("tokenPresent")),fcmStatus.getBoolean("busy"))
    protected override fun statusValue():JSObject {
        if(choice.provider()=="fcm")return fcm.statusValue()
        val unified=super.statusValue();val previous=fcm.statusValue();val cleanup=cleanup(unified,previous)
        if(cleanup.pending) {
            unified.put("tokenPresent",true)
            unified.put("busy",unified.getBoolean("busy") || previous.getBoolean("busy"))
            val action=if(cleanup.retryFcm) "Retry removal cleans the previous FCM registration only; UnifiedPush stays selected."
                else "Pause UnifiedPush first, then retry removal for the previous FCM registration; UnifiedPush stays selected."
            unified.put("reason",action + if(!previous.getBoolean("configured"))
                " FCM revocation requires the original Firebase project configuration and compatible Google Play services." else "")
        }
        return unified
    }
    @Command override fun status(invoke: Invoke) {
        try {invoke.resolve(statusValue())} catch(_:Exception) {invoke.reject("Cannot inspect native push registration")}
    }
    @Command fun selectProvider(invoke: Invoke) {
        try {
            val args=invoke.parseArgs(app.lazysh.push.common.PushProviderControl::class.java)
            if(!choice.change(args.provider,args.operationEpoch,::inactive)) {
                invoke.reject("Pause registration and finish private cleanup before changing provider");return
            }
            status(invoke)
        } catch(_:Exception) {invoke.reject("Cannot change push provider; inspect registration")}
    }
    private fun control(invoke:Invoke,action:(String)->Unit) {
        try {if(!choice.control(operationEpoch(invoke),action))invoke.reject("Push control was superseded")}
        catch(_:Exception) {invoke.reject("Cannot complete push control; inspect registration")}
    }
    @Command override fun register(invoke: Invoke) = control(invoke) {
        if(it=="fcm")fcm.register(invoke) else super.register(invoke)
    }
    @Command override fun disable(invoke: Invoke) = control(invoke) {
        if(it=="fcm" || cleanup(super.statusValue(),fcm.statusValue()).retryFcm)
            fcm.revoke(invoke,::statusValue)
        else super.disable(invoke)
    }
    @Command override fun enroll(invoke: Invoke) = control(invoke) {
        if(it=="unifiedpush")super.enroll(invoke) else invoke.reject("Select UnifiedPush for private relay enrollment")
    }
    @Command override fun display(invoke: Invoke) {
        if(choice.provider()=="unifiedpush")super.display(invoke) else invoke.reject("Select UnifiedPush for authenticated event display")
    }
}
