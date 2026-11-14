package app.lazysh.client

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.net.Uri
import android.provider.Settings
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** Revisions belong to native workers, and survive plugin/Activity replacement. */
internal class SessionBackgroundState {
    var revision = 0L
        private set
    /** Live terminal workers; the ongoing notification shows this count. */
    var sessions = 0
        private set
    val active get() = sessions > 0
    fun apply(next: Long, count: Int): Boolean {
        require(next in 1..9_007_199_254_740_991L)
        require(count in 0..MAX_SESSIONS)
        if (next <= revision) return false
        revision = next
        sessions = count
        return true
    }
    fun reconcileStart(start: () -> Unit, stop: () -> Unit) {
        if (active) start() else stop()
    }
    private companion object {
        const val MAX_SESSIONS = 65_535
    }
}

/**
 * Android 13+ hides a foreground service notification without POST_NOTIFICATIONS. lazysh asks
 * once per install, from the visible workspace once a first session is connected; a denial only
 * hides the notification and never blocks or stops a connection.
 */
internal object SessionNotificationPermission {
    fun shouldRequest(sdk: Int, granted: Boolean, requested: Boolean, visible: Boolean) =
        sdk >= 33 && !granted && !requested && visible
}

/** All access runs on Android's main thread; it never owns host or credential data. */
internal object SessionBackgroundRuntime {
    private const val FAILURE = "background_execution_unavailable"
    val state = SessionBackgroundState()
    private var pending: Invoke? = null
    private var service: SessionForegroundService? = null

    fun update(context: Context, revision: Long, sessions: Int, invoke: Invoke) {
        if (!state.apply(revision, sessions)) {
            invoke.reject(FAILURE)
            return
        }
        pending?.reject(FAILURE)
        pending = null
        if (!state.active) {
            val previous = service
            service = null
            previous?.releaseExecution()
            context.stopService(Intent(context, SessionForegroundService::class.java))
            invoke.resolve()
            return
        }
        pending = invoke
        service?.let { started(it); return }
        try {
            val intent = Intent(context, SessionForegroundService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent)
            else context.startService(intent)
        } catch (_: Exception) {
            pending = null
            invoke.reject(FAILURE)
        }
    }

    fun started(owner: SessionForegroundService) = state.reconcileStart(start = {
        // A delayed start services the current native owners, never its obsolete intent.
        service = owner
        try {
            owner.acquireExecution(state.sessions)
            pending?.resolve()
        } catch (_: Exception) {
            if (service === owner) service = null
            owner.releaseExecution()
            owner.stopSelf()
            pending?.reject(FAILURE)
        }
        pending = null
    }, stop = {
        if (service === owner) service = null
        owner.releaseExecution()
        owner.stopSelf()
    })

    /** Shows the notification again once the workspace returns, e.g. after a permission grant. */
    fun refresh() {
        if (state.active) service?.publish(state.sessions)
    }

    fun destroyed(owner: SessionForegroundService) {
        if (service === owner) {
            service = null
            pending?.reject(FAILURE)
            pending = null
        }
    }
}

@TauriPlugin
class SessionBackgroundPlugin(private val initialOwner: Activity) : Plugin(initialOwner) {
    /** The activity in front: Tauri builds this plugin once, with the first activity, which a recreation destroys (#1462). */
    private val owner: Activity get() = currentActivity(initialOwner)
    @Command fun update(invoke: Invoke) = owner.runOnUiThread {
        try {
            val args = invoke.getArgs()
            val sessions = args.getInt("sessions")
            SessionBackgroundRuntime.update(owner.applicationContext, args.getLong("revision"), sessions, invoke)
        } catch (_: Exception) { invoke.reject("background_execution_unavailable") }
    }

    /**
     * The renderer asks once a connected session is adopted: the system prompt pauses the WebView,
     * which cancels credential operations, so it must never cover a connection still in flight.
     */
    @Command fun requestNotificationPermission(invoke: Invoke) = owner.runOnUiThread {
        if (SessionBackgroundRuntime.state.active) promptForNotifications()
        invoke.resolve()
    }

    @Command fun openNotificationSettings(invoke: Invoke) = owner.runOnUiThread {
        try {
            val intent = if (Build.VERSION.SDK_INT >= 26)
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, owner.packageName)
            else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${owner.packageName}"))
            owner.startActivity(intent)
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("notification_settings_unavailable") }
    }

    override fun onResume(activity: AppCompatActivity) = SessionBackgroundRuntime.refresh()

    private fun promptForNotifications() {
        if (Build.VERSION.SDK_INT < 33) return
        val preferences = owner.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val granted = owner.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val visible = (owner as? AppCompatActivity)?.lifecycle?.currentState
            ?.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) == true
        if (!SessionNotificationPermission.shouldRequest(Build.VERSION.SDK_INT, granted,
                preferences.getBoolean(REQUESTED, false), visible)) return
        preferences.edit().putBoolean(REQUESTED, true).apply()
        // The result needs no handling: onResume re-posts the notification if it was granted.
        runCatching { owner.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_CODE) }
    }

    private companion object {
        const val PREFERENCES = "lazysh-session-notification"
        const val REQUESTED = "postNotificationsRequested"
        const val REQUEST_CODE = 8461
    }
}
