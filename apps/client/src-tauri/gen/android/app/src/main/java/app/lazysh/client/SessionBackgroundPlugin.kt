package app.lazysh.client

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** Revisions belong to native workers, and survive plugin/Activity replacement. */
internal class SessionBackgroundState {
    var revision = 0L
        private set
    var active = false
        private set
    fun apply(next: Long, connected: Boolean): Boolean {
        require(next in 1..9_007_199_254_740_991L)
        if (next <= revision) return false
        revision = next
        active = connected
        return true
    }
    fun reconcileStart(start: () -> Unit, stop: () -> Unit) {
        if (active) start() else stop()
    }
}

/** All access runs on Android's main thread; it never owns host or credential data. */
internal object SessionBackgroundRuntime {
    private const val FAILURE = "background_execution_unavailable"
    val state = SessionBackgroundState()
    private var pending: Invoke? = null
    private var service: SessionForegroundService? = null

    fun update(context: Context, revision: Long, active: Boolean, invoke: Invoke) {
        if (!state.apply(revision, active)) {
            invoke.reject(FAILURE)
            return
        }
        pending?.reject(FAILURE)
        pending = null
        if (!active) {
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
            owner.acquireExecution()
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

    fun destroyed(owner: SessionForegroundService) {
        if (service === owner) {
            service = null
            pending?.reject(FAILURE)
            pending = null
        }
    }
}

@TauriPlugin
class SessionBackgroundPlugin(private val owner: Activity) : Plugin(owner) {
    @Command fun update(invoke: Invoke) = owner.runOnUiThread {
        try {
            val args = invoke.getArgs()
            SessionBackgroundRuntime.update(owner.applicationContext,
                args.getLong("revision"), args.getBoolean("active"), invoke)
        } catch (_: Exception) { invoke.reject("background_execution_unavailable") }
    }
}
