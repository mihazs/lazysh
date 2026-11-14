package app.lazysh.client

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import app.tauri.plugin.Plugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Invoke
import app.tauri.annotation.TauriPlugin
import app.tauri.annotation.Command

internal enum class AuthRoute { LAUNCH, NOTIFY, BLOCKED }

/**
 * Where a sign-in page goes (ADR 0004). Android 10 and later refuse to start an activity from the background and a foreground
 * service is not an exemption, so a page asked for while another app is in front waits in a notification, whose tap the system allows.
 */
internal object AuthBrowserRoute {
    fun of(inFront: Boolean, notificationsEnabled: Boolean) = when {
        inFront -> AuthRoute.LAUNCH
        notificationsEnabled -> AuthRoute.NOTIFY
        else -> AuthRoute.BLOCKED
    }
    /** The same intent a Custom Tab launch builds (an in-app style tab), or a plain `VIEW` for the default browser. */
    fun viewIntent(uri: Uri, inApp: Boolean): Intent =
        (if (inApp) CustomTabsIntent.Builder().build().intent else Intent(Intent.ACTION_VIEW)).setData(uri)

    /** Only web pages: Rust has validated the URL, and a plugin never trusts that for an intent that starts another app. */
    fun isWeb(url: String) = url.startsWith("http://", ignoreCase = true) || url.startsWith("https://", ignoreCase = true)
}

/** Opens a sign-in page in a Custom Tab (lazysh stays the app in front) or the default browser, or notifies. Its only caller is `open_auth_url`. */
@TauriPlugin
class AuthBrowserPlugin(private val initialOwner: Activity) : Plugin(initialOwner) {
    /** The activity in front: Tauri builds this plugin once, with the first activity, which a recreation destroys (#1462). */
    private val owner: Activity get() = currentActivity(initialOwner)

    @Command fun present(invoke: Invoke) = owner.runOnUiThread {
        try {
            val args = invoke.getArgs()
            val url = args.getString("url")
            require(AuthBrowserRoute.isWeb(url)) { "web_only" }
            val uri = Uri.parse(url)
            val inApp = args.getBoolean("inApp")
            val context = owner.applicationContext
            // STARTED is the visible window the background-start rule asks for; the activity reports it at once, unlike the process.
            val inFront = (owner as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) == true
            val route = AuthBrowserRoute.of(inFront, notificationsEnabled(context))
            when (route) {
                AuthRoute.LAUNCH ->
                    // From an activity, a Custom Tab joins lazysh's task: no NEW_TASK, so Back returns here.
                    if (inApp) CustomTabsIntent.Builder().build().launchUrl(owner, uri)
                    else owner.startActivity(AuthBrowserRoute.viewIntent(uri, inApp = false).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                AuthRoute.NOTIFY -> notify(context, uri, args.optString("host", uri.host.orEmpty()), inApp)
                AuthRoute.BLOCKED -> { invoke.reject("notifications_blocked", "notifications_blocked"); return@runOnUiThread }
            }
            invoke.resolve(JSObject().put("outcome", if (route == AuthRoute.LAUNCH) "opened" else "notified"))
        } catch (_: Exception) { invoke.reject("browser_unavailable") }
    }

    private fun notificationsEnabled(context: Context): Boolean {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channel = if (Build.VERSION.SDK_INT >= 26) manager.getNotificationChannel(CHANNEL) else null
        return manager.areNotificationsEnabled() && channel?.importance != NotificationManager.IMPORTANCE_NONE
    }

    private fun notify(context: Context, uri: Uri, host: String, inApp: Boolean) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.auth_notification_channel),
                NotificationManager.IMPORTANCE_HIGH))
        }
        val open = PendingIntent.getActivity(context, 0, AuthBrowserRoute.viewIntent(uri, inApp).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL)
            else @Suppress("DEPRECATION") Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
        builder.setSmallIcon(R.drawable.lazysh_monochrome)
            .setContentTitle(context.getString(R.string.auth_notification_title))
            // The host being opened, never the query: it carries the sign-in state.
            .setContentText(context.getString(R.string.auth_notification_text, host))
            .setContentIntent(open).setAutoCancel(true).setCategory(Notification.CATEGORY_MESSAGE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
        // A request the person never answered is stale after two minutes (ADR 0004).
        if (Build.VERSION.SDK_INT >= 26) builder.setTimeoutAfter(TIMEOUT_MS)
        manager.notify(NOTIFICATION, builder.build())
    }

    internal companion object {
        const val CHANNEL = "sign-in-requests"
        /** One request at a time: a newer one replaces the older. */
        const val NOTIFICATION = 8462
        const val TIMEOUT_MS = 120_000L
    }
}
