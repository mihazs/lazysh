package app.lazysh.unifiedpush

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.InvokeArg
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg class DisplayControl { var permit:String="" }
internal object NativeDisplayAuthority {
    external fun commit(permit:String, action:DisplayConsentCommit):Boolean
}
/** The JNI gate invokes only this fixed bounded local operation, never a queued
 * plugin call or an arbitrary renderer-provided runnable. */
internal class DisplayConsentCommit(private val context:Context, private val binding:DisplayBinding,
    private val enabled:Boolean) {
    fun run() {
        check(PushEnrollment.controller(context).withConfirmed(binding.instance) {
            check(it==binding)
            val display=PushDisplay.controller(context)
            if (enabled) display.disable() else display.enable(it)
        })
    }
}

/** One completion owns cleanup even when showing or dismissing the native window
 * throws; late dismiss callbacks cannot publish a second result. */
internal class ConsentDialogLifetime(private val release:()->Unit, private val done:(Boolean)->Unit) {
    private val completed=AtomicBoolean(false)
    fun finish(success:Boolean) {
        if (!completed.compareAndSet(false,true)) return
        try { release() } finally { done(success) }
    }
    fun show(open:()->Unit, dismiss:()->Unit) {
        try { open() } catch (_:Exception) {
            try { finish(false) } finally { try { dismiss() } catch (_:Exception) {} }
        }
    }
}

internal const val REMOTE_NOTIFICATION_CHANNEL="lazysh-remote-events-v1"
internal const val REMOTE_NOTIFICATION_TAG="lazysh-unifiedpush-event"
internal const val REMOTE_NOTIFICATION_ID=4201

internal class AndroidDisplayNotifications(context:Context):DisplayNotifications {
    private val app=context.applicationContext
    private val manager=app.getSystemService(NotificationManager::class.java)
    private fun channel() {
        if (Build.VERSION.SDK_INT>=26) manager.createNotificationChannel(NotificationChannel(
            REMOTE_NOTIFICATION_CHANNEL,"Remote agent events",NotificationManager.IMPORTANCE_DEFAULT))
    }
    override fun permitted():Boolean {
        channel()
        return NotificationManagerCompat.from(app).areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT<33 || ContextCompat.checkSelfPermission(app,Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED) &&
            (Build.VERSION.SDK_INT<26 || (manager.getNotificationChannel(REMOTE_NOTIFICATION_CHANNEL)?.importance
                ?: NotificationManager.IMPORTANCE_NONE)!=NotificationManager.IMPORTANCE_NONE)
    }
    override fun post() {
        check(permitted())
        val component=checkNotNull(app.packageManager.getLaunchIntentForPackage(app.packageName)?.component)
        check(component.packageName==app.packageName)
        // Construct afresh: no remote data, extras, URI, selector or terminal action.
        val intent=Intent(Intent.ACTION_MAIN).setComponent(component).addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pending=PendingIntent.getActivity(app,REMOTE_NOTIFICATION_ID,intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val generic=NotificationCompat.Builder(app,REMOTE_NOTIFICATION_CHANNEL)
            .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("lazysh")
            .setContentText("A remote agent event is available. Open lazysh to inspect your sessions.")
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setLocalOnly(true).setAutoCancel(true)
            .setContentIntent(pending).build()
        manager.notify(REMOTE_NOTIFICATION_TAG,REMOTE_NOTIFICATION_ID,generic)
    }
    override fun cancel() { manager.cancel(REMOTE_NOTIFICATION_TAG,REMOTE_NOTIFICATION_ID) }
}

internal object PushDisplay {
    private var instance:EventDisplayController?=null
    @Synchronized fun controller(context:Context):EventDisplayController {
        instance?.let { return it }
        val app=context.applicationContext
        return EventDisplayController(PrivateDisplayStore(app),AndroidDisplayNotifications(app)) {
            System.currentTimeMillis()/1000
        }.also { instance=it }
    }
    fun enabled(context:Context):Boolean {
        val enrollment=PushEnrollment.controller(context)
        val connector=enrollment.state()?.instance ?: return false
        var enabled=false
        enrollment.withConfirmed(connector) { enabled=controller(context).enabled(it) }
        return enabled
    }
    fun message(context:Context, connector:String, event:DisplayEvent) {
        PushEnrollment.controller(context).withConfirmed(connector) { controller(context).message(it,event) }
    }
}

internal object DisplayConsentDialog {
    private var current:AlertDialog?=null
    fun cancel(activity:Activity) { activity.runOnUiThread { current?.cancel() } }
    fun show(activity:Activity, permit:String, done:(Boolean)->Unit) {
        val completed=AtomicBoolean(false)
        fun finish(success:Boolean) { if (completed.compareAndSet(false,true)) done(success) }
        activity.runOnUiThread {
            var opened:AlertDialog?=null
            var cleanup:(()->Unit)?=null
            try {
                current?.cancel()
                check(canonicalUuid(permit) && !activity.isFinishing && !activity.isDestroyed)
                val enrollment=PushEnrollment.controller(activity)
                val connector=checkNotNull(enrollment.state()?.instance)
                var binding:DisplayBinding?=null
                check(enrollment.withConfirmed(connector) { binding=it })
                val selected=checkNotNull(binding)
                val display=PushDisplay.controller(activity)
                val enabled=display.enabled(selected)
                var admitted=false
                val dialog=AlertDialog.Builder(activity).setTitle("Remote notification display")
                    .setMessage(if (enabled) "Turn off remote event notifications on this device? Replay history remains protected."
                        else "Allow generic private notifications from this verified relay enrollment? Your relay operator must enable bound-v2 delivery. Notifications only open lazysh; they never run terminal actions.")
                    .setNegativeButton("Cancel") { _,_ -> }
                    .setPositiveButton(if (enabled) "Turn off" else "Allow") { _,_ ->
                        try {
                            check(!activity.isFinishing && !activity.isDestroyed)
                            admitted=NativeDisplayAuthority.commit(permit,DisplayConsentCommit(activity,selected,enabled))
                        } catch (_:Exception) { /* Fixed public failure returned below. */ }
                    }.create()
                checkNotNull(dialog.window).addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                opened=dialog
                cleanup=cancelDialogWhenBackgrounded(activity,dialog)
                val lifetime=ConsentDialogLifetime({
                    try { cleanup?.invoke() } catch (_:Exception) {}
                    finally {
                        cleanup=null
                        if (current===dialog) current=null
                    }
                },::finish)
                dialog.setOnDismissListener { lifetime.finish(admitted) }
                current=dialog
                lifetime.show({dialog.show()},{dialog.dismiss()})
            } catch (_:Exception) {
                opened?.setOnDismissListener(null)
                try { opened?.dismiss() } catch (_:Exception) {}
                try { cleanup?.invoke() } catch (_:Exception) {}
                cleanup=null
                if (current===opened) current=null
                finish(false)
            }
        }
    }
}
