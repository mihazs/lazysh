package app.lazysh.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** An ongoing user connection, independent of Activity visibility or renderer ACKs. */
class SessionForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        SessionBackgroundRuntime.started(this)
        return START_NOT_STICKY
    }
    internal fun acquireExecution() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL,
                getString(R.string.session_notification_channel), NotificationManager.IMPORTANCE_LOW))
        }
        val launch = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL)
            else Notification.Builder(this)
        val notification = builder.setSmallIcon(R.drawable.lazysh_monochrome)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.session_notification_active))
            .setContentIntent(launch).setOngoing(true).setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_SECRET).setCategory(Notification.CATEGORY_SERVICE).build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else startForeground(NOTIFICATION, notification)
        if (wakeLock == null) {
            val lock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "lazysh:terminal-connections")
            lock.setReferenceCounted(false)
            wakeLock = lock
            lock.acquire()
        }
    }
    internal fun releaseExecution() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(true)
    }
    override fun onDestroy() {
        releaseExecution()
        SessionBackgroundRuntime.destroyed(this)
        super.onDestroy()
    }
    private companion object {
        const val CHANNEL = "terminal-connections"
        const val NOTIFICATION = 8461
    }
}
