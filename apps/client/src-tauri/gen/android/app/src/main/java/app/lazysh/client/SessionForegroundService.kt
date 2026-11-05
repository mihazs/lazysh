package app.lazysh.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** An ongoing user connection, independent of Activity visibility or renderer ACKs. */
class SessionForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private var foreground = false
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        SessionBackgroundRuntime.started(this)
        return START_NOT_STICKY
    }
    internal fun acquireExecution(sessions: Int) {
        // Once foreground, only the session count changes; that needs no new foreground start.
        if (foreground) publish(sessions)
        else {
            val notification = sessionNotification(this, sessions)
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else startForeground(NOTIFICATION, notification)
            foreground = true
        }
        if (wakeLock == null) {
            val lock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lazysh:terminal-connections")
            lock.setReferenceCounted(false)
            wakeLock = lock
            lock.acquire()
        }
    }
    /** Re-posts the ongoing notification, for a new count or a permission granted after start. */
    internal fun publish(sessions: Int) {
        if (!foreground) return
        // Without POST_NOTIFICATIONS the system drops the post; the connection keeps running.
        runCatching {
            getSystemService(NotificationManager::class.java).notify(NOTIFICATION, sessionNotification(this, sessions))
        }
    }
    internal fun releaseExecution() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        foreground = false
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(true)
    }
    override fun onDestroy() {
        releaseExecution()
        SessionBackgroundRuntime.destroyed(this)
        super.onDestroy()
    }
    internal companion object {
        const val CHANNEL = "terminal-connections"
        const val NOTIFICATION = 8461

        /** "lazysh is running" with the live session count; a tap returns to the workspace task. */
        fun sessionNotification(context: Context, sessions: Int): Notification {
            if (Build.VERSION.SDK_INT >= 26) {
                context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel(CHANNEL,
                    context.getString(R.string.session_notification_channel), NotificationManager.IMPORTANCE_LOW))
            }
            // The MainActivity base intent that the LauncherActivity trampoline starts: a tap brings the
            // existing workspace task forward unchanged.
            val workspace = Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            val launch = PendingIntent.getActivity(context, 0, workspace,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL)
                else @Suppress("DEPRECATION") Notification.Builder(context)
            builder.setSmallIcon(R.drawable.lazysh_monochrome)
                .setContentTitle(context.getString(R.string.session_notification_title))
                .setContentText(context.resources.getQuantityString(R.plurals.session_notification_sessions, sessions, sessions))
                .setContentIntent(launch).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_SECRET).setCategory(Notification.CATEGORY_SERVICE)
            // Show at once instead of after Android 12's ten-second foreground-service deferral.
            if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
            return builder.build()
        }
    }
}
