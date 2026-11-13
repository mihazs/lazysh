package app.lazysh.client

import android.app.Instrumentation
import android.app.Instrumentation.ActivityMonitor
import android.app.Instrumentation.ActivityResult
import android.app.NotificationManager
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.test.uiautomator.By
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The guest-open path of a sign-in (ADR 0004, #1513) against the real Activity, notification manager and, for the live cases, a
 * real browser. The live cases need an installed browser and one that has finished its first run, so they run only when the
 * instrumentation argument `lazyshLiveBrowser` is `true` (a Waydroid or phone run); the others need no browser.
 */
@RunWith(AndroidJUnit4::class)
class AuthBrowserTest {
    private val instrumentation: Instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val notifications = context.getSystemService(NotificationManager::class.java)
    private val scenario get() = NativeActivityFixture.scenario
    private val live get() = InstrumentationRegistry.getArguments().getString("lazyshLiveBrowser") == "true"

    @Before fun grantNotificationsAndClear() {
        if (Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, "android.permission.POST_NOTIFICATIONS")
        notifications.cancel(AuthBrowserPlugin.NOTIFICATION)
        scenario.moveToState(Lifecycle.State.RESUMED)
    }

    @After fun restore() {
        notifications.cancel(AuthBrowserPlugin.NOTIFICATION)
        scenario.moveToState(Lifecycle.State.RESUMED)
    }

    /** Counts the web pages the app starts and lets none of them open a browser. */
    private fun launches() = ActivityMonitor(IntentFilter(Intent.ACTION_VIEW).apply { addDataScheme("http"); addDataScheme("https") }, ActivityResult(0, null), true)
        .also { instrumentation.addMonitor(it) }

    private fun present(url: String, inApp: Boolean = true): JSONObject {
        val reply = VaultReply()
        scenario.onActivity { activity ->
            AuthBrowserPlugin(activity).present(reply.invoke("present", JSONObject().put("url", url).put("host", java.net.URI(url).host).put("inApp", inApp)))
        }
        val response = reply.await()
        assertTrue("the plugin rejected: ${response.json}", response.resolved)
        return JSONObject(response.json)
    }

    private fun stopped() {
        scenario.moveToState(Lifecycle.State.CREATED)
        assertEquals(Lifecycle.State.CREATED, scenario.state)
    }

    @Test fun aTabOpensWhileLazyshIsInFrontAndNothingIsNotified() {
        val launches = launches()
        assertEquals("opened", present("https://idp.example/authorize?state=SECRET-STATE&redirect_uri=http%3A%2F%2F127.0.0.1%3A36151%2Fcb").getString("outcome"))
        instrumentation.removeMonitor(launches)
        assertEquals(1, launches.hits)
        assertTrue(notifications.activeNotifications.none { it.id == AuthBrowserPlugin.NOTIFICATION })
    }

    @Test fun theBrowserChoiceDecidesBetweenACustomTabAndAPlainViewIntent() {
        val uri = android.net.Uri.parse("https://idp.example/login")
        val tab = AuthBrowserRoute.viewIntent(uri, inApp = true)
        val view = AuthBrowserRoute.viewIntent(uri, inApp = false)
        for (intent in listOf(tab, view)) { assertEquals(Intent.ACTION_VIEW, intent.action); assertEquals(uri, intent.data) }
        assertTrue("not a Custom Tab", tab.hasExtra("android.support.customtabs.extra.SESSION"))
        assertFalse(view.hasExtra("android.support.customtabs.extra.SESSION"))
    }

    @Test fun theSystemBrowserChoiceStillOpensAPage() {
        val launches = launches()
        assertEquals("opened", present("https://idp.example/login", inApp = false).getString("outcome"))
        instrumentation.removeMonitor(launches)
        assertEquals(1, launches.hits)
    }

    @Test fun anotherAppInFrontMakesItANotificationThatNamesOnlyTheHost() {
        stopped()
        val launches = launches()
        val url = "https://idp.example/authorize?state=SECRET-STATE&code_challenge=SECRET-PKCE"
        assertEquals("notified", present(url).getString("outcome"))
        instrumentation.removeMonitor(launches)
        assertEquals("the app started an activity from the background", 0, launches.hits)
        val posted = notifications.activeNotifications.single { it.id == AuthBrowserPlugin.NOTIFICATION }.notification
        assertNotNull("a tap must be able to open the page", posted.contentIntent)
        val text = posted.extras.getCharSequence(android.app.Notification.EXTRA_TEXT).toString()
        assertTrue(text, text.contains("idp.example"))
        assertFalse(text, text.contains("SECRET"))
        assertTrue(posted.flags and android.app.Notification.FLAG_AUTO_CANCEL != 0)
    }

    @Test fun aNewerRequestReplacesTheOlderNotification() {
        stopped()
        present("https://one.example/a")
        present("https://two.example/b")
        val posted = notifications.activeNotifications.filter { it.id == AuthBrowserPlugin.NOTIFICATION }
        assertEquals(1, posted.size)
        assertTrue(posted.single().notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT).toString().contains("two.example"))
    }

    @Test fun onlyWebPagesAreAccepted() {
        for (url in listOf("intent://scan/#Intent;scheme=zxing;end", "file:///data/data", "javascript:alert(1)")) {
            val reply = VaultReply()
            scenario.onActivity { AuthBrowserPlugin(it).present(reply.invoke("present", JSONObject().put("url", url).put("inApp", true))) }
            assertFalse(url, reply.await().resolved)
        }
    }

    /** The sign-in page and the callback listener of a fake identity provider, both on this device's loopback. */
    private class FakeIdentityProvider {
        private val loopback = InetAddress.getByName("127.0.0.1")
        private val page = ServerSocket(0, 8, loopback)
        /** The listener the tunnel would hold: the redirect lands here. */
        private val callback = ServerSocket(0, 8, loopback)
        val requests = CopyOnWriteArrayList<String>()
        val callbackSeen = CountDownLatch(1)
        val authorizeUrl get() = "http://127.0.0.1:${page.localPort}/authorize?state=S1&redirect_uri=http%3A%2F%2F127.0.0.1%3A${callback.localPort}%2Foauth%2Fcallback"
        val callbackPort get() = callback.localPort

        init {
            serve(page) { _ -> "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:${callback.localPort}/oauth/callback?code=FAKE-CODE&state=S1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n" }
            serve(callback) { line ->
                if (line.contains("/oauth/callback?code=FAKE-CODE")) callbackSeen.countDown()
                "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 20\r\nConnection: close\r\n\r\nYou can close this. "
            }
        }

        private fun serve(server: ServerSocket, answer: (String) -> String) = Thread {
            while (!server.isClosed) try {
                server.accept().use { socket ->
                    val line = socket.getInputStream().bufferedReader().readLine().orEmpty()
                    if (line.startsWith("GET /")) requests.add(line.substringBefore('?').removeSuffix(" HTTP/1.1"))
                    socket.getOutputStream().apply { write(answer(line).toByteArray()); flush() }
                }
            } catch (_: Exception) {}
        }.apply { isDaemon = true; start() }

        fun close() { page.close(); callback.close() }
    }

    private fun liveCallback(start: (String) -> Unit) {
        assumeTrue("set -e lazyshLiveBrowser true on a device with a browser", live)
        val provider = FakeIdentityProvider()
        try {
            start(provider.authorizeUrl)
            assertTrue("the redirect never reached the callback listener: ${provider.requests}", provider.callbackSeen.await(40, TimeUnit.SECONDS))
            assertEquals(listOf("GET /authorize", "GET /oauth/callback"), provider.requests.toList())
        } finally { provider.close() }
    }

    @Test fun liveInAppTabFollowsTheRedirectToTheLoopbackListener() = liveCallback { url ->
        assertEquals("opened", present(url).getString("outcome"))
    }

    @Test fun liveNotificationTapReachesTheLoopbackListenerWhileLazyshStaysInTheBackgroundWithItsForegroundService() = liveCallback { url ->
        val device = UiDevice.getInstance(instrumentation)
        val service = VaultReply()
        scenario.onActivity { SessionBackgroundRuntime.update(context, SessionBackgroundRuntime.state.revision + 1, 1, service.invoke("update", JSONObject())) }
        try {
            assertTrue("the session foreground service did not start", service.await().resolved)
            device.pressHome()
            assertTrue(device.wait(Until.gone(By.pkg(context.packageName)), 10_000))
            stopped()
            assertEquals("notified", present(url).getString("outcome"))
            device.openNotification()
            val title = context.getString(R.string.auth_notification_title)
            val entry = device.wait(Until.findObject(By.text(title)), 10_000)
            assertNotNull("the sign-in notification is not shown", entry)
            entry.click()
            assertTrue("the foreground service stopped while the page was open", SessionBackgroundRuntime.state.active)
        } finally {
            scenario.onActivity { SessionBackgroundRuntime.update(context, SessionBackgroundRuntime.state.revision + 1, 0, VaultReply().invoke("update", JSONObject())) }
        }
    }
}
