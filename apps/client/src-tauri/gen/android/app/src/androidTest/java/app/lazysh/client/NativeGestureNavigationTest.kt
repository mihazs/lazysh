package app.lazysh.client

import android.app.Activity
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.provider.Settings
import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * #1380 and #1435 on the real system: the gesture zones the shell reads under each navigation overlay, the bands the app claims against
 * them, and Android Back reaching the app after the activity is recreated. The overlay is switched with `cmd overlay enable-exclusive`
 * through UiAutomation (shell identity) and always restored. A device or emulator without the overlay skips that case; a build whose
 * system never owns the edges (three buttons only) still proves the three-button and recreation cases.
 *
 * Whether the system then takes a swipe is not provable here (instrumentation cannot send a real edge swipe); tests/android-gestures.test.ts
 * drives the swipes with `adb shell input` and reads the system's own state from dumpsys.
 */
@RunWith(AndroidJUnit4::class)
class NativeGestureNavigationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val scenario get() = NativeActivityFixture.scenario
    private val category = "com.android.internal.systemui.navbar."
    private val zoneWidthsDp = listOf(16, 40, 96)

    private fun shell(command: String): String {
        val pipe = instrumentation.uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(pipe).use { it.readBytes().toString(Charsets.UTF_8) }
    }

    private fun overlayExists(name: String) = shell("cmd overlay list --user 0 android").lines().any { it.trim().endsWith(category + name) }

    private fun enabledNavigationOverlays() = shell("cmd overlay list --user 0 android").lines()
        .filter { it.trim().startsWith("[x]") && it.contains(category) }.map { it.substringAfter(category).trim() }

    private fun navigationMode() = Settings.Secure.getInt(instrumentation.targetContext.contentResolver, "navigation_mode", -1)

    private inline fun <T> poll(what: String, seconds: Long = 30, read: () -> T?): T {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        while (true) {
            val value = try { read() } catch (_: Throwable) { null }
            if (value != null) return value
            assertTrue("Timed out waiting for $what", System.nanoTime() < deadline)
            Thread.sleep(200)
        }
    }

    private fun onActivityView(block: (View) -> Unit) {
        scenario.onActivity { block(requireNotNull(EdgeGestureExclusion.webView(it.window.decorView)) { "the Tauri WebView" }) }
    }

    private fun js(expression: String): String {
        val result = AtomicReference<String>()
        val done = CountDownLatch(1)
        scenario.onActivity { activity ->
            (requireNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) as android.webkit.WebView)
                .evaluateJavascript(expression) { result.set(it); done.countDown() }
        }
        assertTrue("WebView evaluation timed out", done.await(30, TimeUnit.SECONDS))
        return result.get()
    }

    /** A renderer-side IPC call as the page makes it: the access header carries the unlock nonce, and the outcome lands in `window.__outcome`. */
    private fun invokeFromPage(command: String, arguments: String = "{}") {
        js("""(()=>{window.__outcome='pending';
            window.__TAURI_INTERNALS__.invoke('app_lock_status').then(status=>window.__TAURI_INTERNALS__.invoke('$command',$arguments,{headers:{'X-Lazysh-Access':status.nonce??''}}))
              .then(value=>{window.__outcome=JSON.stringify(value??null)},error=>{window.__outcome='error '+error});return true})()""")
    }

    private fun outcome(what: String): String = poll(what, 30) { js("window.__outcome").takeIf { it != "\"pending\"" } }.trim('"').replace("\\\"", "\"")

    private fun awaitPage(what: String, expression: String) = poll(what, 120) {
        if (NativeActivityFixture.readiness(scenario).ready && js(expression) == "true") true else null
    }

    /** The workspace is unlocked and showing its start page: the IPC refuses a claim until then. */
    private fun awaitStartPage() = awaitPage("the start page",
        """Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector("button[aria-label='Add host']")) && Boolean(document.querySelector("button[aria-label='Preferences']"))""")

    /** Runs `block` under `name`, then puts back the navigation overlays that were enabled (or none) whatever happens. */
    private fun underOverlay(name: String, block: () -> Unit) {
        assumeTrue("the $name navigation overlay is not installed", overlayExists(name))
        val before = enabledNavigationOverlays()
        try {
            shell("cmd overlay enable-exclusive --user 0 --category $category$name")
            val expected = if (name == "threebutton") 0 else 2
            poll("navigation_mode $expected", 20) { if (navigationMode() == expected) true else null }
            awaitRecreated()
            block()
        } finally {
            // Whatever this block enabled that was not enabled before is switched off again, then the original overlay returns.
            enabledNavigationOverlays().filter { it !in before }.forEach { shell("cmd overlay disable --user 0 $category$it") }
            before.firstOrNull()?.let { shell("cmd overlay enable-exclusive --user 0 --category $category$it") }
            awaitRecreated()
        }
    }

    /** An overlay change recreates the activity; a second change before the new one has resumed would stack two recreations. */
    private fun awaitRecreated() {
        Thread.sleep(500)
        poll("the activity to resume after the overlay change", 60) { if (NativeActivityFixture.readiness(scenario).ready) true else null }
    }

    private fun insetsOf(): GestureInsets {
        var read: GestureInsets? = null
        scenario.onActivity { read = EdgeGestureInsets.read(it.window.decorView) }
        return read!!
    }

    private fun claimed(zoneDp: Int, rowTopDp: Int, rowBottomDp: Int): Pair<List<Rect>, GestureInsets> {
        var rects: List<Rect> = emptyList()
        var insets: GestureInsets? = null
        onActivityView { view ->
            EdgeGestureExclusion.apply(view, zoneDp, left = true, right = true, rowTopDp = rowTopDp, rowBottomDp = rowBottomDp)
            rects = view.systemGestureExclusionRects
            insets = EdgeGestureInsets.read(view)
        }
        return rects to insets!!
    }

    /** What every claimed band must satisfy against the zones the system reports now. */
    private fun assertBandsAreSafe(label: String, zoneDp: Int, rects: List<Rect>, insets: GestureInsets) {
        var checked = false
        onActivityView { view ->
            val density = view.resources.displayMetrics.density
            val homePx = (maxOf(insets.bottom, insets.mandatoryBottom) * density).toInt()
            if (view.width > 0 && view.height > 0) {
                assertEquals("$label: both sides are claimed", 2, rects.size)
                for (rect in rects) {
                    assertTrue("$label: inside the view $rect", rect.left >= 0 && rect.right <= view.width && rect.top >= 0 && rect.bottom <= view.height)
                    assertTrue("$label: only as wide as the zone $rect", rect.width() <= (zoneDp * density).toInt() + 1 && rect.width() <= view.width / 2)
                    assertTrue("$label: Android caps the excluded height at 200dp $rect", rect.height() <= (200 * density).toInt() + 1)
                    assertTrue("$label: the Home zone cannot be excluded, so no band reaches it ($rect, Home zone from ${view.height - homePx})", rect.bottom <= view.height - homePx)
                }
                assertTrue("$label: the two bands never overlap", rects[0].right <= rects[1].left)
                checked = true
            }
            // The mandatory gesture zone the window itself reports must stay clear of every band too.
            ViewCompat.getRootWindowInsets(view)?.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures())?.let { mandatory ->
                // The WebView sits inside a content frame padded by the system bars, so only what reaches past that padding is its own.
                val padding = (view.parent as? View)?.paddingBottom ?: 0
                val zoneTop = view.height - maxOf(0, mandatory.bottom - padding)
                for (rect in rects) assertTrue("$label: the window's mandatory zone starts at $zoneTop ($rect)", rect.bottom <= zoneTop)
            }
        }
        assertTrue("$label: the WebView has been laid out", checked)
    }

    @Test fun insetsAndBandsFollowEveryNavigationOverlay() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        for ((overlay, gestures) in listOf("threebutton" to false, "gestural_wide_back" to true, "gestural_extra_wide_back" to true)) {
            if (!overlayExists(overlay)) continue
            underOverlay(overlay) {
                val insets = poll("$overlay insets", 30) { insetsOf().takeIf { (it.navigation == "gesture") == gestures && ((it.left > 0) == gestures) } }
                assertEquals(overlay, if (gestures) "gesture" else "buttons", insets.navigation)
                if (gestures) {
                    assertEquals("$overlay: both Back zones are the same width", insets.left, insets.right)
                    onActivityView { view ->
                        // The navigation bar window already covers part of the launcher's strip, so the zone counts from where that padding ends.
                        val density = view.resources.displayMetrics.density
                        val strip = view.resources.getDimensionPixelSize(view.resources.getIdentifier("navigation_bar_frame_height", "dimen", "android"))
                        val padding = (view.parent as View).paddingBottom
                        assertTrue("$overlay: the Home zone ${insets.bottom} dp plus the ${padding}px bars reaches the launcher's ${strip}px swipe-up strip", insets.bottom * density + padding >= strip - 1)
                        assertTrue("$overlay: and so does the mandatory zone", insets.mandatoryBottom * density + padding >= strip - 1)
                    }
                } else assertEquals("$overlay: three buttons keep nothing at the sides", 0, insets.left + insets.right)
                for (zone in zoneWidthsDp) {
                    val (rects, applied) = claimed(zone, 0, 5000)
                    assertEquals("the insets do not change while the bands are claimed", insets, applied)
                    assertBandsAreSafe("$overlay zone $zone dp", zone, rects, applied)
                }
                onActivityView { view ->
                    EdgeGestureExclusion.apply(view, 40, left = false, right = false, rowTopDp = 0, rowBottomDp = 200)
                    assertTrue("$overlay: nothing claimed, nothing excluded", view.systemGestureExclusionRects.isEmpty())
                }
            }
        }
    }

    @Test fun theWideBackOverlayIsNoNarrowerThanTheDefaultAndExtraWideIsWider() {
        assumeTrue(overlayExists("gestural_wide_back") && overlayExists("gestural_extra_wide_back"))
        var wide = 0
        underOverlay("gestural_wide_back") { wide = poll("wide insets") { insetsOf().left.takeIf { it > 0 } } }
        underOverlay("gestural_extra_wide_back") {
            val extra = poll("extra wide insets") { insetsOf().left.takeIf { it > wide } }
            assertTrue("a wider Back sensitivity gives a wider system zone", extra > wide)
        }
    }

    private fun claim(zoneDp: Int, rowTopDp: Int, rowBottomDp: Int) =
        invokeFromPage("edge_gesture_exclusion", "{left:true,right:true,zoneDp:$zoneDp,rowTopDp:$rowTopDp,rowBottomDp:$rowBottomDp}")

    /**
     * The renderer's claim reaches the plugin through the real IPC and lands on the WebView in front, again and again across activity
     * recreations (#1449: the plugin Tauri built for the first activity kept claiming on its destroyed WebView), and the shell keeps
     * reporting the live zones of the new window.
     */
    @Test fun theClaimedBandsAndTheInsetsFollowTheActivityAcrossRecreations() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        awaitStartPage()
        fun rects(): List<Rect> { var found: List<Rect> = emptyList(); onActivityView { found = it.systemGestureExclusionRects }; return found }
        for (round in 1..3) {
            claim(40, 200, 400)
            assertEquals("round $round: the claim was accepted", "null", outcome("the claim (round $round)"))
            var density = 0f
            onActivityView { density = it.resources.displayMetrics.density }
            val applied = poll("two bands on the WebView in front (round $round)") { rects().takeIf { it.size == 2 } }
            for (rect in applied) {
                assertEquals("round $round: the band starts at the requested row", (200 * density).toInt(), rect.top)
                assertEquals("round $round: and ends at the requested row", (400 * density).toInt(), rect.bottom)
            }
            invokeFromPage("edge_gesture_insets")
            val reported = JSONObject(outcome("the insets (round $round)"))
            assertEquals("round $round: the shell reads the window in front", insetsOf().navigation, reported.getString("navigation"))
            assertEquals("round $round: and its zones", insetsOf().left, reported.getInt("left"))
            scenario.recreate()
            awaitStartPage()
            assertTrue("round $round: a new WebView starts with nothing claimed, so the renderer must claim again", rects().isEmpty())
        }
    }

    /**
     * The device plugins Tauri built with the first activity must act on the one in front after a recreation (#1462): the launcher icon
     * is refused with "Open lazysh before changing the launcher icon" when its plugin judges a destroyed activity not to be in front, and
     * the soft keyboard refuses with `soft_keyboard_unavailable`. CI saw the first one fail in `NativeWorkspaceTest` once this class had recreated the activity.
     * The file exchange and background session plugins read the activity through the same `currentActivity`, which is asserted directly: their
     * commands need a staged download or a live session, which this class has none of.
     */
    @Test fun theDevicePluginsActOnTheActivityInFrontAfterRecreation() {
        awaitStartPage()
        var first: Activity? = null
        scenario.onActivity { first = it }
        scenario.recreate()
        awaitStartPage()
        scenario.onActivity {
            assertNotSame("the recreation built a new activity", first, it)
            assertSame("a plugin Tauri built with the first activity reads the one in front", it, currentActivity(first!!))
        }
        invokeFromPage("app_icon_status")
        val current = JSONObject(outcome("the launcher icon")).getString("current")
        invokeFromPage("set_app_icon", "{icon:'$current'}")
        val selected = outcome("the launcher icon is set again")
        assertFalse("the launcher icon plugin sees the activity in front: $selected", selected.startsWith("error"))
        invokeFromPage("soft_keyboard", "{action:'status'}")
        val keyboard = outcome("the soft keyboard status")
        assertFalse("the soft keyboard plugin sees the activity in front: $keyboard", keyboard.startsWith("error"))
        try {
            invokeFromPage("terminal_private_keyboard", "{active:true}")
            val privateKeyboard = outcome("the private keyboard mode")
            assertFalse("the private keyboard plugin accepts the command: $privateKeyboard", privateKeyboard.startsWith("error"))
            poll("the private keyboard mode to be on") { PrivateKeyboard.active.takeIf { it } }
        } finally {
            invokeFromPage("terminal_private_keyboard", "{active:false}")
            outcome("the private keyboard mode is off again")
        }
        assertFalse("the private keyboard mode follows the command back off", PrivateKeyboard.active)
    }

    /** The Rust command refuses what Android would clamp or ignore: a row taller than the 200 dp cap, an inverted row, a zone outside 1 to 96 dp. */
    @Test fun theShellRefusesRowsAndZonesAndroidCouldNotHonour() {
        awaitStartPage()
        val outcomes = listOf(
            "zoneDp:40,rowTopDp:100,rowBottomDp:301" to "refused",
            "zoneDp:40,rowTopDp:300,rowBottomDp:300" to "refused",
            "zoneDp:97,rowTopDp:100,rowBottomDp:300" to "refused",
            "zoneDp:0,rowTopDp:100,rowBottomDp:300" to "refused",
            "zoneDp:96,rowTopDp:100,rowBottomDp:300" to "claimed",
            "zoneDp:1,rowTopDp:100,rowBottomDp:300" to "claimed",
        )
        try {
            for ((arguments, expected) in outcomes) {
                invokeFromPage("edge_gesture_exclusion", "{left:true,right:true,$arguments}")
                val result = outcome("the outcome of $arguments")
                assertEquals(arguments, expected, if (result.startsWith("error")) "refused" else "claimed")
            }
        } finally {
            invokeFromPage("edge_gesture_exclusion", "{left:false,right:false,zoneDp:40,rowTopDp:0,rowBottomDp:1}")
        }
    }

    /** The plugin re-applies the bands on every layout pass, so a window that changes size never keeps rects outside it. */
    @Test fun theBandsFollowALayoutChange() {
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        awaitStartPage()
        claim(40, 100, 300)
        assertEquals("null", outcome("the claim"))
        var content: View? = null
        var original = 0
        scenario.onActivity { content = it.findViewById(android.R.id.content); original = content!!.paddingBottom }
        try {
            scenario.onActivity { content!!.setPadding(content!!.paddingLeft, content!!.paddingTop, content!!.paddingRight, original + 600) }
            poll("the bands inside the smaller WebView") {
                var inside = false
                onActivityView { view -> inside = view.systemGestureExclusionRects.let { r -> r.size == 2 && r.all { it.bottom <= view.height && it.top >= 0 } } && view.height > 0 }
                inside.takeIf { it }
            }
        } finally {
            scenario.onActivity { content!!.setPadding(content!!.paddingLeft, content!!.paddingTop, content!!.paddingRight, original) }
            invokeFromPage("edge_gesture_exclusion", "{left:false,right:false,zoneDp:40,rowTopDp:0,rowBottomDp:1}")
        }
    }

    /**
     * #1435 observation 1: Back reached the system, and left the app, right after the activity was recreated. The page opens Preferences (the
     * same `canHandleBack` effect as the navigation page and the bottom menu); Back must close it at once, every time, with the activity
     * recreated every tenth cycle. If a Back arrives before the handler is registered the activity finishes and the instrumentation
     * process ends, which fails the run.
     */
    @Test fun backClosesAnOpenPageAfterEveryRecreationHundredCycles() {
        val device = UiDevice.getInstance(instrumentation)
        val open = """(()=>{document.querySelector("button[aria-label='Preferences']").click();return true})()"""
        val pageOpen = "Boolean(document.querySelector('[role=dialog]'))"
        awaitStartPage()
        for (cycle in 1..100) {
            if (cycle % 10 == 1 && cycle > 1) { scenario.recreate(); awaitStartPage() }
            js(open)
            poll("cycle $cycle: Preferences open", 30) { if (js(pageOpen) == "true") true else null }
            assertTrue("cycle $cycle: the activity is in front", NativeActivityFixture.readiness(scenario).ready)
            device.pressBack()
            poll("cycle $cycle: Back closed the page", 30) { if (js(pageOpen) == "false") true else null }
            assertFalse("cycle $cycle: Back did not leave the app", scenario.state == androidx.lifecycle.Lifecycle.State.DESTROYED)
        }
    }
}
