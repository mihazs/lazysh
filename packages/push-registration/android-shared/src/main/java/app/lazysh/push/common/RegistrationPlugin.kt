package app.lazysh.push.common

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.InvokeArg
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg class PushControl { var operationEpoch: Long = 0 }

/** Provider-independent permission, argument and public status contract. */
abstract class RegistrationPlugin(private val registrationActivity: Activity) : Plugin(registrationActivity) {
    protected fun notificationPermission(): Boolean =
        NotificationManagerCompat.from(registrationActivity).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(registrationActivity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    protected fun operationEpoch(invoke: Invoke): Long = invoke.parseArgs(PushControl::class.java).operationEpoch

    protected fun registrationStatus(provider: String, configured: Boolean, enabled: Boolean, tokenPresent: Boolean, busy: Boolean, reason: String): JSObject =
        JSObject().apply {
            put("provider", provider)
            put("supported", true)
            put("configured", configured)
            put("enabled", enabled)
            put("tokenPresent", tokenPresent)
            put("busy", busy)
            put("reason", reason)
        }
}
