package app.lazysh.client

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.KeyEvent
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.HandlerThread
import android.net.Uri
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.typeTextIntoFocusedView
import androidx.test.espresso.action.ViewActions.pressKey
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.GeneralClickAction
import androidx.test.espresso.action.Press
import androidx.test.espresso.action.Tap
import androidx.test.espresso.action.EspressoKey
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.assertion.ViewAssertions.matches
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.DriverAtoms.webScrollIntoView
import androidx.test.espresso.web.webdriver.Locator
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeWorkspaceTest {
    private fun webView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) webView(view.getChildAt(index))?.let { return it }
        return null
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, expression: String, timeoutMillis: Long = 30_000): String {
        val result = AtomicReference<String>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            val web = requireNotNull(webView(activity.window.decorView))
            web.evaluateJavascript(expression) { value -> result.set(value); completed.countDown() }
        }
        assertTrue("WebView evaluation timed out", completed.await(timeoutMillis, TimeUnit.MILLISECONDS))
        return result.get()
    }

    private fun awaitDocument(scenario: ActivityScenario<MainActivity>, stage: String, expression: String,
        observe: ((Long) -> String)? = null) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        var firstObservation: String? = null
        var lastObservation: String? = null
        while (true) {
            val native = NativeActivityFixture.readiness(scenario)
            if (native.ready && evaluate(scenario, expression) == "true") return
            val error = evaluate(scenario, "document.querySelector('[role=dialog] [role=alert]')?.textContent?.slice(0,320) || ''")
            assertTrue("Native workspace failed at $stage: $error", error == "\"\"")
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
            if (observe != null && remaining > 0) {
                lastObservation = try { observe(remaining.coerceAtMost(1_000)) } catch (_: Throwable) { "unavailable" }
                if (firstObservation == null) firstObservation = lastObservation
            }
            if (System.nanoTime() >= deadline) {
                val observations = if (observe == null) "" else "; first=$firstObservation; last=$lastObservation"
                throw AssertionError("Native workspace not ready at $stage: $native; windows=${NativeActivityFixture.windowDiagnostics()}$observations")
            }
            Thread.sleep(200)
        }
    }

    // QR-only public state, never frame pixels, track labels, payloads or renderer globals.
    private fun qrVideoObservation(scenario: ActivityScenario<MainActivity>): (Long) -> String {
        var firstReady: JSONObject? = null
        return { remaining ->
            val encoded = evaluate(scenario, """JSON.stringify((() => {
              const q=document.querySelector('.theme-qr-panel'), v=q?.querySelector('video');
              const statuses=Array.from(q?.querySelectorAll('[role=status]')??[]).map(x=>x.textContent);
              const bounded=n=>Number.isFinite(n)?Math.min(1000000,Math.max(0,n)):null;
              const stream=v?.srcObject, tracks=stream instanceof MediaStream?stream.getVideoTracks():[];
              return {present:!!v,visible:document.visibilityState==='visible',hidden:v?.hidden??null,
                detailsOpen:v?.closest('details')?.open??null,readyState:bounded(v?.readyState),
                width:bounded(v?.videoWidth),height:bounded(v?.videoHeight),paused:v?.paused??null,
                timeMs:bounded(Math.round((v?.currentTime??NaN)*1000)),
                frames:bounded(v?.getVideoPlaybackQuality?.().totalVideoFrames),src:!!stream,
                liveTracks:bounded(tracks.filter(x=>x.readyState==='live').length),
                endedTracks:bounded(tracks.filter(x=>x.readyState==='ended').length),
                permission:statuses.includes('Waiting for camera permission…'),
                scanning:statuses.includes('Looking for a theme QR code…'),
                decoding:statuses.includes('Decoding QR image…'),
                finishing:statuses.includes('The stopped request is still finishing. Wait before scanning again.'),
                cancelled:statuses.includes('QR scan stopped.'),timeout:statuses.includes('QR scan stopped after 30 seconds.'),
                busy:Array.from(q?.querySelectorAll('[role=alert]')??[]).some(x=>x.textContent==='Another QR request is still finishing. Try again when it finishes.'),
                alert:!!q?.querySelector('[role=alert]')};
            })())""", remaining)
            val sample = JSONObject(JSONArray("[$encoded]").getString(0))
            assertTrue("QR diagnostics contain only finite public state", sample.keys().asSequence().all {
                val value = sample.get(it); value == JSONObject.NULL || value is Boolean || value is Number
            })
            if (firstReady == null && sample.optInt("readyState") >= 2) firstReady = sample
            JSONObject().put("firstReady", firstReady ?: JSONObject.NULL).put("current", sample).toString().also {
                require(it.length <= 2_048) { "QR diagnostic bound" }
            }
        }
    }

    private enum class TypingPhase { CONSTRAINTS, FOCUS_CHECK, NATIVE_INJECTION, SETTLING }

    // Failure metadata only: no selector, input value or renderer content is retained.
    private class TypingTiming(val started: Long, val deadline: Long) {
        var phase = TypingPhase.CONSTRAINTS
        var constraintChecks = 0
        var constraintsReady: Long? = null
        var focusStarted: Long? = null
        var focusReturned: Long? = null
        var injectionStarted: Long? = null
        var injectionReturned: Long? = null
        var settlePolls = 0
        var lastPollStarted: Long? = null
        var lastPollReturned: Long? = null
        var lastPollMatched: Boolean? = null
        var deadlineObserved: Long? = null
        var snapshotStarted: Long? = null
        var snapshotReturned: Long? = null
        var snapshotAvailable = false

        fun report(now: Long): JSONObject {
            fun elapsed(at: Long?): Any = at?.let { TimeUnit.NANOSECONDS.toMillis(it - started) } ?: JSONObject.NULL
            val boundary = when {
                injectionReturned?.let { it >= deadline } == true -> "injection_returned_after_deadline"
                focusReturned?.let { it >= deadline } == true -> "focus_returned_after_deadline"
                lastPollReturned?.let { it >= deadline } == true -> "poll_returned_after_deadline"
                deadlineObserved != null -> "deadline_observed"
                else -> "operation_failed"
            }
            return JSONObject().put("phase", phase.name).put("boundary", boundary)
                .put("elapsedMs", elapsed(now)).put("budgetMs", elapsed(deadline))
                .put("constraintChecks", constraintChecks).put("constraintsReadyMs", elapsed(constraintsReady))
                .put("focusStartedMs", elapsed(focusStarted)).put("focusReturnedMs", elapsed(focusReturned))
                .put("injectionStartedMs", elapsed(injectionStarted)).put("injectionReturnedMs", elapsed(injectionReturned))
                .put("settlePolls", settlePolls).put("lastPollStartedMs", elapsed(lastPollStarted))
                .put("lastPollReturnedMs", elapsed(lastPollReturned)).put("lastPollMatched", lastPollMatched ?: JSONObject.NULL)
                .put("deadlineObservedMs", elapsed(deadlineObserved)).put("afterDeadlineSnapshotStartedMs", elapsed(snapshotStarted))
                .put("afterDeadlineSnapshotReturnedMs", elapsed(snapshotReturned)).put("afterDeadlineSnapshotAvailable", snapshotAvailable)
        }
    }

    private fun typeInto(scenario: ActivityScenario<MainActivity>, selector: String, text: String) {
        // Grant native View focus before selecting the DOM input: requesting
        // native focus afterward can restore or blur a different DOM focus target.
        scenario.onActivity { activity ->
            val web = requireNotNull(webView(activity.window.decorView))
            if (!web.hasFocus()) assertTrue("Native WebView focus was denied", web.requestFocus())
            assertTrue("Native WebView did not acquire focus", web.hasFocus())
        }
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webClick())
        scenario.onActivity { activity ->
            assertTrue("DOM selection lost native WebView focus", requireNotNull(webView(activity.window.decorView)).hasFocus())
        }
        val focus = evaluate(scenario, """JSON.stringify({
          activeTag:document.activeElement?.tagName,
          activePlaceholder:document.activeElement?.getAttribute('placeholder'),
          targetExists:Boolean(document.querySelector(${JSONObject.quote(selector)})),
          documentFocused:document.hasFocus()
        })""")
        assertEquals("DOM input focus changed for $selector: $focus", "true", evaluate(scenario,
            "document.activeElement === document.querySelector(${JSONObject.quote(selector)})"))
        // DOM focus can precede Chromium's native input connection. The hosted
        // textarea fixture reached this point with focus=true but no connection.
        // Wait for the exact native type action's constraints, without refocusing
        // or attempting input, within the existing five-second typing budget.
        val typing = typeTextIntoFocusedView(text)
        val started = System.nanoTime()
        val deadline = started + TimeUnit.SECONDS.toNanos(5)
        val timing = TypingTiming(started, deadline)
        try {
            while (true) {
                if (System.nanoTime() >= deadline) {
                    timing.deadlineObserved = System.nanoTime()
                    throw AssertionError("Native typing constraints did not become ready for $selector; native=${NativeActivityFixture.readiness(scenario)}; windows=${NativeActivityFixture.windowDiagnostics()}")
                }
                var ready = false
                timing.constraintChecks++
                scenario.onActivity { activity ->
                    ready = typing.constraints.matches(requireNotNull(webView(activity.window.decorView)))
                }
                if (ready) { timing.constraintsReady = System.nanoTime(); break }
                Thread.sleep(25)
            }
            timing.phase = TypingPhase.FOCUS_CHECK
            timing.focusStarted = System.nanoTime()
            val focusRemainingMillis = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1)
            val stillFocused = evaluate(scenario,
                "document.activeElement === document.querySelector(${JSONObject.quote(selector)})", focusRemainingMillis)
            timing.focusReturned = System.nanoTime()
            assertEquals("DOM input focus changed while awaiting native typing for $selector", "true", stillFocused)
            assertTrue("Native typing readiness exhausted the shared budget for $selector", System.nanoTime() < deadline)
            // Espresso webKeys uses JS value assignment. React tracks that setter,
            // so its later synthetic change can be ignored. Inject native keys once
            // into the focused WebView, preserving normal browser input events.
            timing.phase = TypingPhase.NATIVE_INJECTION
            timing.injectionStarted = System.nanoTime()
            onView(isAssignableFrom(WebView::class.java)).perform(typing)
            timing.injectionReturned = System.nanoTime()
            timing.phase = TypingPhase.SETTLING
            // Espresso acknowledges key injection, not the separate WebView renderer.
            // Wait only for the exact result; never retype or assign the input value.
            val typed = "document.querySelector(${JSONObject.quote(selector)})?.value === ${JSONObject.quote(text)}"
            while (true) {
                if (System.nanoTime() >= deadline) {
                    timing.deadlineObserved = System.nanoTime()
                    timing.snapshotStarted = System.nanoTime()
                    val diagnostics = try { evaluate(scenario, """JSON.stringify((() => {
                      const target=document.querySelector(${JSONObject.quote(selector)});
                      const actual=target?.value ?? '', expected=${JSONObject.quote(text)};
                      let mismatch=0;
                      while(mismatch<Math.min(actual.length,expected.length) && actual[mismatch]===expected[mismatch]) mismatch++;
                      return {actualLength:actual.length,expectedLength:expected.length,firstMismatchIndex:mismatch,
                        activeTag:document.activeElement?.tagName,
                        activeField:document.activeElement?.getAttribute('placeholder'),
                        targetFocused:document.activeElement===target,documentFocused:document.hasFocus()};
                    })())""").also { timing.snapshotAvailable = true } } catch (_: Throwable) { "unavailable" }
                    timing.snapshotReturned = System.nanoTime()
                    throw AssertionError("Native typed input did not settle for $selector; after-deadline snapshot: $diagnostics")
                }
                val remainingMillis = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1)
                timing.settlePolls++
                timing.lastPollStarted = System.nanoTime()
                timing.lastPollReturned = null
                timing.lastPollMatched = null
                val matched = evaluate(scenario, typed, remainingMillis) == "true"
                timing.lastPollReturned = System.nanoTime()
                timing.lastPollMatched = matched
                if (matched) break
                Thread.sleep(50)
            }
        } catch (failure: Throwable) {
            // Metadata must never replace the original assertion/type/cause.
            runCatching { failure.addSuppressed(AssertionError("Native typing timing: ${timing.report(System.nanoTime())}")) }
            throw failure
        }
    }

    @Test fun nativeTypingTimingDistinguishesLateInjectionFromLatePollingWithoutInputData() {
        val origin = 123_000_000L
        val deadline = origin + TimeUnit.SECONDS.toNanos(5)
        val injection = TypingTiming(origin, deadline).apply {
            phase = TypingPhase.SETTLING
            injectionStarted = origin + 10_000_000L
            injectionReturned = deadline + 100_000_000L
            deadlineObserved = injectionReturned
            snapshotStarted = deadline + 110_000_000L
            snapshotReturned = deadline + 120_000_000L
            snapshotAvailable = true
        }.report(deadline + 120_000_000L)
        assertEquals("injection_returned_after_deadline", injection.getString("boundary"))
        assertEquals(0, injection.getInt("settlePolls"))
        assertTrue(injection.isNull("lastPollMatched"))
        assertTrue(injection.getLong("afterDeadlineSnapshotStartedMs") > injection.getLong("budgetMs"))
        val polling = TypingTiming(origin, deadline).apply {
            phase = TypingPhase.SETTLING
            injectionReturned = origin + 100_000_000L
            settlePolls = 1
            lastPollStarted = deadline - 10_000_000L
            lastPollReturned = deadline + 10_000_000L
            lastPollMatched = false
        }.report(deadline + 10_000_000L)
        assertEquals("poll_returned_after_deadline", polling.getString("boundary"))
        assertTrue(polling.isNull("afterDeadlineSnapshotStartedMs"))
        assertEquals(false, polling.getBoolean("afterDeadlineSnapshotAvailable"))
        assertEquals("operation_failed", TypingTiming(origin, deadline).report(origin).getString("boundary"))
        val allowed = setOf("phase", "boundary", "elapsedMs", "budgetMs", "constraintChecks", "constraintsReadyMs",
            "focusStartedMs", "focusReturnedMs", "injectionStartedMs", "injectionReturnedMs", "settlePolls",
            "lastPollStartedMs", "lastPollReturnedMs", "lastPollMatched", "deadlineObservedMs",
            "afterDeadlineSnapshotStartedMs", "afterDeadlineSnapshotReturnedMs", "afterDeadlineSnapshotAvailable")
        assertEquals(allowed, injection.keys().asSequence().toSet())
        for (key in allowed - setOf("phase", "boundary")) {
            val value = injection.get(key)
            assertTrue("Timing metadata is finite and cannot hold input content", value == JSONObject.NULL || value is Number || value is Boolean)
        }
    }

    // A dedicated first instrumentation invocation selects only this method.
    // This exercises first-Activity/native-runtime startup, not a force-stopped
    // external process. Closing the last Tauri Activity would kill the runner.
    @Test fun themeLinksUseFirstActivityAndWarmIntentWithExplicitReview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.runOnMainSync {
            val lifecycle = ActivityLifecycleMonitorRegistry.getInstance()
            assertTrue("Theme-link acceptance must run before any MainActivity", Stage.values().all { stage ->
                lifecycle.getActivitiesInStage(stage).none { it is MainActivity }
            })
        }
        fun intent(name: String): Intent {
            val theme = JSONObject().put("v", 1).put("name", name).put("mode", "light")
                .put("colors", JSONObject().put("background", "#fafafa").put("foreground", "#121212"))
            val data = Base64.encodeToString(theme.toString().toByteArray(Charsets.UTF_8),
                Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            // No explicit component: the actual packaged manifest must resolve
            // this VIEW/BROWSABLE route, while restricting it to our owned APK.
            return Intent(Intent.ACTION_VIEW, Uri.parse("lazysh://theme?data=$data"))
                .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.packageName)
        }
        fun click(label: String) {
            onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(text())='$label']")).perform(webClick())
        }
        val cold = intent("Android first activity")
        assertEquals("Packaged APK must resolve implicit theme links to MainActivity", MainActivity::class.java.name,
            context.packageManager.resolveActivity(cold, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.name)
        assertTrue("The acceptance intent must not bypass manifest resolution", cold.component == null)
        for (scheme in listOf("lazysh-invalid", "https")) {
            val unsupported = Intent(cold).setData(Uri.parse("$scheme://theme?data=invalid"))
            assertEquals("Unrelated schemes must not resolve to this APK", null,
                context.packageManager.resolveActivity(unsupported, PackageManager.MATCH_DEFAULT_ONLY))
        }
        val scenario = NativeActivityFixture.launch(cold)
        val original = AtomicReference<MainActivity>()
        scenario.onActivity { original.set(it) }
        val review = "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Review linked theme')"
        val noReview = "!($review) && !document.querySelector('[aria-label=\"Linked theme preview\"]')"
        fun appearance(expected: String) = "document.documentElement.dataset.appTheme === ${JSONObject.quote(expected)}"
        fun warm(next: Intent) {
            context.startActivity(next.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            awaitDocument(scenario, "warm theme link delivery", review)
            scenario.onActivity { assertSame("Warm singleTask delivery must reuse the original Activity", original.get(), it) }
        }
        awaitDocument(scenario, "first-Activity theme link", review)
        assertEquals("A received cold link must not apply itself", "true", evaluate(scenario, appearance("forest")))
        click("Review linked theme")
        awaitDocument(scenario, "cold explicit preview", "document.querySelector('[aria-label=\"Linked theme preview\"] h2')?.textContent==='Android first activity'")
        assertEquals("Review must not apply the theme", "true", evaluate(scenario, appearance("forest")))
        click("Discard theme link")
        awaitDocument(scenario, "cold explicit discard", noReview)
        assertEquals("Discard must preserve the theme", "true", evaluate(scenario, appearance("forest")))

        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Preferences']")).perform(webClick())
        onWebView().withElement(findElement(Locator.XPATH, "//summary[text()='Import and share theme']")).perform(webClick())
        val draftSelector = "textarea[aria-label='Theme JSON or share code']"
        val draft = "unfinished native theme draft"
        typeInto(scenario, draftSelector, draft)
        closeSoftKeyboard()
        val draftKept = "document.querySelector(${JSONObject.quote(draftSelector)})?.value === ${JSONObject.quote(draft)}"
        val sameUrl = intent("Android first activity")
        assertEquals("Warm reopen must use the exact same URL", cold.data, sameUrl.data)
        warm(sameUrl)
        assertEquals("Warm delivery must preserve the manual draft", "true", evaluate(scenario, draftKept))
        assertEquals("Warm delivery must not apply itself", "true", evaluate(scenario, appearance("forest")))
        click("Review linked theme")
        awaitDocument(scenario, "warm same-URL preview", "document.querySelector('[aria-label=\"Linked theme preview\"] h2')?.textContent==='Android first activity'")
        assertEquals("Review must preserve the manual draft", "true", evaluate(scenario, draftKept))
        click("Apply linked theme")
        awaitDocument(scenario, "warm explicit apply", appearance("custom") + " && " + noReview)
        assertEquals("Apply must preserve the manual draft", "true", evaluate(scenario, draftKept))
        assertEquals("Applied app colors must match the reviewed palette", "true", evaluate(scenario,
            "document.querySelector('[aria-label=\"Terminal preferences\"] select') !== null && document.documentElement.style.getPropertyValue('--theme-bg') === '#fafafa'"))

        warm(intent("Android replacement"))
        click("Review linked theme")
        awaitDocument(scenario, "replacement explicit preview", "document.querySelector('[aria-label=\"Linked theme preview\"] h2')?.textContent==='Android replacement'")
        click("Discard theme link")
        awaitDocument(scenario, "replacement explicit discard", noReview)
        assertEquals("Discarding a replacement keeps the applied theme", "true", evaluate(scenario, appearance("custom")))
        assertEquals("Replacement review/discard must preserve the manual draft", "true", evaluate(scenario, draftKept))
        // Only this isolated acceptance's own appearance state is changed. Reset
        // through the actual UI before the ordinary native workspace suite.
        click("Reset preferences")
        awaitDocument(scenario, "theme fixture reset", appearance("forest"))
    }

    private class QrCameraObservation(private val rear: Set<String>) : CameraManager.AvailabilityCallback() {
        private val available = mutableSetOf<String>()
        private val opened = mutableSetOf<String>()
        private var armed = false
        val idle = CountDownLatch(1)
        val released = CountDownLatch(1)
        @Synchronized override fun onCameraUnavailable(id: String) {
            available.remove(id)
            if (armed && id in rear) opened.add(id)
        }
        @Synchronized override fun onCameraAvailable(id: String) {
            if (id in rear) available.add(id)
            if (available.containsAll(rear)) idle.countDown()
            if (armed && id in opened) released.countDown()
        }
        @Synchronized fun arm() {
            assertTrue("Previous capture must release every rear camera before a new Scan", available.containsAll(rear))
            armed = true
        }
        @Synchronized fun openedAny() = opened.isNotEmpty()
    }

    @Test fun qrCameraReleaseRequiresTheSuccessfulAttemptsOwnOpenAndClose() {
        val first = QrCameraObservation(setOf("owned-rear"))
        first.onCameraAvailable("owned-rear"); first.arm()
        first.onCameraUnavailable("owned-rear"); first.onCameraAvailable("owned-rear")
        assertEquals(0L, first.released.count)
        val fresh = QrCameraObservation(setOf("owned-rear"))
        fresh.onCameraAvailable("owned-rear"); fresh.arm()
        first.onCameraAvailable("owned-rear") // A queued old callback cannot release fresh work.
        assertTrue(!fresh.openedAny()); assertEquals(1L, fresh.released.count)
        fresh.onCameraUnavailable("owned-rear"); first.onCameraAvailable("owned-rear")
        assertTrue(fresh.openedAny()); assertEquals(1L, fresh.released.count)
        fresh.onCameraAvailable("other-camera"); assertEquals(1L, fresh.released.count)
        fresh.onCameraAvailable("owned-rear"); assertEquals(0L, fresh.released.count)
    }

    // Dedicated invocation with an owned emulator imagefile camera; no mocked frames or IPC.
    @Test fun ownedQrCameraRequiresPermissionAndExplicitPreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assertEquals("Camera permission must start ungranted", PackageManager.PERMISSION_DENIED,
            context.checkSelfPermission(android.Manifest.permission.CAMERA))
        val camera = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val rear = camera.cameraIdList.filter { camera.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }.toSet()
        assertTrue("Owned rear imagefile camera must exist", rear.isNotEmpty())
        val scenario = NativeActivityFixture.scenario
        val observer = HandlerThread("owned-qr-camera-observer").apply { start() }
        var observation: QrCameraObservation? = null
        fun observe(): QrCameraObservation {
            observation?.let { camera.unregisterAvailabilityCallback(it) }
            val next = QrCameraObservation(rear); observation = next
            camera.registerAvailabilityCallback(next, Handler(observer.looper))
            assertTrue("Rear camera must be idle before explicit Scan", next.idle.await(5, TimeUnit.SECONDS))
            next.arm()
            return next
        }
        fun button(label: String) {
            onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(text())='$label']")).perform(webClick())
        }
        val preview = "Boolean(document.querySelector('.theme-preview'))"
        val stopped = "document.querySelector('.theme-qr-panel video')?.srcObject===null"
        val available = "Boolean(document.querySelector('.theme-qr-panel button') && !document.querySelector('.theme-qr-panel button').disabled)"
        val draftSelector = "[aria-label='Theme JSON or share code']"
        val draft = "manual owned QR draft stays literal"
        var permissionController: String? = null
        fun permission(id: String) {
            val selector = permissionController?.let { By.res(it, id) }
                ?: By.res(Pattern.compile("[a-zA-Z0-9_.]+:id/" + Pattern.quote(id)))
            val device = UiDevice.getInstance(instrumentation)
            assertTrue("Expected real owned camera permission choice: $id", device.wait(Until.hasObject(selector), 5_000))
            val choices = device.findObjects(selector)
            assertEquals("Permission choice must be unambiguous", 1, choices.size)
            val target = choices.single()
            val owner = requireNotNull(target.applicationPackage) { "Permission owner unavailable" }
            val info = context.packageManager.getApplicationInfo(owner, 0)
            assertTrue("Permission choice must belong to a system application", info.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0)
            if (permissionController == null) permissionController = owner
            assertEquals("Permission choices must retain the same system owner", permissionController, owner)
            target.click()
        }
        var primary: Throwable? = null
        var propagating = false
        try {
            var capture = observe()
            awaitDocument(scenario, "QR workspace ready", "Boolean(document.querySelector('button[aria-label=Preferences]'))")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label=Preferences]")).perform(webClick())
            onWebView().withElement(findElement(Locator.XPATH, "//summary[normalize-space(text())='Import and share theme']")).perform(webClick())
            awaitDocument(scenario, "explicit QR controls", available)
            typeInto(scenario, draftSelector, draft)
            closeSoftKeyboard()
            val saved = evaluate(scenario, "localStorage.getItem('lazysh.preferences.v1')")
            button("Scan QR with camera")
            permission("permission_deny_button")
            awaitDocument(scenario, "QR denied camera settles", "$available && $stopped")
            assertEquals("Denied choice must leave camera permission ungranted", PackageManager.PERMISSION_DENIED,
                context.checkSelfPermission(android.Manifest.permission.CAMERA))
            assertEquals("Denied camera must not preview", "false", evaluate(scenario, preview))
            assertEquals("Denial keeps explicit image fallback available", "true", evaluate(scenario,
                "Boolean(document.querySelector('.theme-qr-panel input[type=file]:not(:disabled)'))"))
            assertTrue("Denied request must not open the camera", !capture.openedAny())
            println("lazysh QR UI: real permission denied; fallback available")
            // This is a new explicit user action, not revival of the denied attempt.
            capture = observe()
            button("Scan QR with camera")
            permission("permission_allow_foreground_only_button")
            assertEquals("Explicit Allow must grant camera permission", PackageManager.PERMISSION_GRANTED,
                context.checkSelfPermission(android.Manifest.permission.CAMERA))
            awaitDocument(scenario, "QR granted permission settles", "$preview || ($available && $stopped)")
            if (evaluate(scenario, preview) != "true") {
                // A real permission dialog can hide/stop the Activity. The original
                // cancelled pipeline must stay cancelled; require fresh user intent.
                assertEquals("Only a lifecycle-cancelled attempt may need fresh Scan", "true", evaluate(scenario,
                    "Array.from(document.querySelectorAll('.theme-qr-panel [role=status]')).some(x=>x.textContent==='QR scan stopped.')"))
                assertEquals("Interrupted permission must not publish a stale preview", "false", evaluate(scenario, preview))
                println("lazysh QR UI: permission lifecycle cancelled; explicit fresh scan")
                capture = observe()
                button("Scan QR with camera")
            }
            awaitDocument(scenario, "actual Rust-decoded QR preview", "document.querySelector('.theme-preview h3')?.textContent==='QR fixture'", qrVideoObservation(scenario))
            assertEquals("QR preview must preserve the manual draft", "true", evaluate(scenario,
                "document.querySelector(${JSONObject.quote(draftSelector)})?.value===${JSONObject.quote(draft)}"))
            assertTrue("QR preview must not apply preferences", saved == evaluate(scenario, "localStorage.getItem('lazysh.preferences.v1')"))
            assertTrue("The actual rear camera must have opened", capture.openedAny())
            awaitDocument(scenario, "QR video detached after decode", stopped)
            assertTrue("Native rear camera must be released after decode", capture.released.await(5, TimeUnit.SECONDS))
            button("Cancel preview")
            awaitDocument(scenario, "QR explicit preview discarded", "!($preview) && $stopped && $available")
            assertTrue("Discarded preview must not apply preferences", saved == evaluate(scenario, "localStorage.getItem('lazysh.preferences.v1')"))
            println("lazysh QR UI: decoded preview discarded; camera released; draft unchanged")
        } catch (failure: Throwable) { primary = failure; propagating = true; throw failure }
        finally {
            fun cleanup(action: () -> Unit) { try { action() } catch (failure: Throwable) {
                if (primary == null) primary = failure else primary!!.addSuppressed(AssertionError("Owned QR cleanup also failed"))
            } }
            cleanup {
                val device = UiDevice.getInstance(instrumentation)
                permissionController?.let { if (device.hasObject(By.pkg(it))) device.pressBack() }
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Close Preferences']")).perform(webClick())
            }
            cleanup { observation?.let { camera.unregisterAvailabilityCallback(it) } }
            cleanup { observer.quitSafely(); observer.join(5_000); assertTrue("Camera observer must retire", !observer.isAlive) }
            if (!propagating && primary != null) throw primary!!
        }
    }

    // Dedicated, serialized Gradle invocation. The fixture contains only ephemeral owned data.
    @Test fun ownedOpenSshConnectsThroughRealUi() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val path = InstrumentationRegistry.getArguments().getString("lazyshSshFixture")
        require(path != null && Regex("/data/local/tmp/lazysh-ui-ssh-[a-f0-9]{32}/fixture[.]json").matches(path)) {
            "An owned SSH fixture path is required"
        }
        val bytes = instrumentation.uiAutomation.executeShellCommand("cat $path").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { stream ->
                val buffer = ByteArray(16 * 1024 + 1)
                var count = 0
                while (count < buffer.size) {
                    val read = stream.read(buffer, count, buffer.size - count)
                    if (read < 0) break
                    count += read
                }
                require(count <= 16 * 1024) { "Owned SSH fixture exceeds bound" }
                buffer.copyOf(count)
            }
        }
        val fixture = try { JSONObject(String(bytes, Charsets.UTF_8)) }
        catch (_: Exception) { throw AssertionError("Owned SSH fixture JSON is invalid") }
        val nonce = fixture.getString("nonce")
        require(Regex("[a-f0-9]{32}").matches(nonce)) { "Invalid owned SSH nonce" }
        val name = "Android SSH $nonce"
        require(fixture.getString("name") == name && fixture.getInt("port") in 1..65535)
        val privateKey = fixture.getString("privateKey")
        require(privateKey.length in 1..8192) { "Invalid owned identity size" }
        val scenario = NativeActivityFixture.scenario
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val label = "lazysh-ui-ssh-$nonce"
        fun clickButton(text: String) {
            onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(text())='$text']")).perform(webClick())
        }
        fun present(selector: String) = "Boolean(document.querySelector(${JSONObject.quote(selector)}))"
        fun screenContains(text: String) = "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.includes(${JSONObject.quote(text)}))"
        fun selectSsh() {
            val selector = "[role=dialog] select"
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webScrollIntoView())
            // A DOM click atom does not activate Chromium's native select popup.
            // Read only this control's viewport geometry, then inject one native tap.
            val geometry = JSONArray(evaluate(scenario, """(() => {
              const target=document.querySelector(${JSONObject.quote(selector)});
              const r=target.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
              return [x,y,innerWidth,innerHeight,r.width,r.height,document.elementFromPoint(x,y)===target];
            })()"""))
            val values = (0..5).map { geometry.getDouble(it) }
            assertTrue("Transport control geometry must be finite and visible", values.all { it.isFinite() } &&
                values[2] > 0 && values[3] > 0 && values[4] > 0 && values[5] > 0 &&
                values[0] >= 0 && values[0] < values[2] && values[1] >= 0 && values[1] < values[3] && geometry.getBoolean(6))
            onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE, { view ->
                val origin = IntArray(2)
                view.getLocationOnScreen(origin)
                val scale = view.width.toDouble() / values[2]
                val x = values[0] * scale
                val y = values[1] * scale
                assertTrue("Transport control must remain inside the native WebView", x < view.width && y < view.height)
                floatArrayOf((origin[0] + x).toFloat(), (origin[1] + y).toFloat())
            }, Press.FINGER))
            val option = onView(withText("SSH")).inRoot(isDialog())
            option.check(matches(isDisplayed()))
            println("lazysh SSH UI: native transport chooser ready")
            option.perform(click())
            assertEquals("SSH must be selected through the actual chooser", "true", evaluate(scenario,
                "document.querySelector('[role=dialog] select')?.value==='ssh'"))
            println("lazysh SSH UI: native transport selected")
        }
        var primaryFailure: Throwable? = null
        try {
            awaitDocument(scenario, "SSH workspace ready", present("button[aria-label='Add host']"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Add host']")).perform(webClick())
            typeInto(scenario, "input[placeholder='Home workstation']", name)
            typeInto(scenario, "input[placeholder='workstation.local']", "127.0.0.1")
            typeInto(scenario, "input[placeholder='Your SSH username']", fixture.getString("username"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".port-field input")).perform(webClick())
            onView(isAssignableFrom(WebView::class.java)).perform(
                pressKey(EspressoKey.Builder().withKeyCode(KeyEvent.KEYCODE_A).withCtrlPressed(true).build()),
                pressKey(KeyEvent.KEYCODE_DEL))
            typeInto(scenario, ".port-field input", fixture.getInt("port").toString())
            closeSoftKeyboard()
            selectSsh()
            clickButton("Save host")
            val connect = "button[aria-label='Connect to $name']"
            awaitDocument(scenario, "SSH fixture host saved", present(connect))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, connect)).perform(webClick())
            awaitDocument(scenario, "SSH authentication dialog", present("[role=dialog] input[type=password]"))
            selectSsh()
            clickButton("Private key")
            val keySelector = "[role=dialog] textarea[placeholder='-----BEGIN OPENSSH PRIVATE KEY-----']"
            scenario.onActivity { activity -> requireNotNull(webView(activity.window.decorView)).requestFocus() }
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, keySelector)).perform(webClick())
            val pasteDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            val inputConstraints = typeTextIntoFocusedView("readiness-only").constraints
            while (true) {
                var ready = false
                scenario.onActivity { activity -> ready = inputConstraints.matches(requireNotNull(webView(activity.window.decorView))) }
                if (ready) break
                assertTrue("Native key field input connection did not become ready", System.nanoTime() < pasteDeadline)
                Thread.sleep(25)
            }
            assertEquals("Key field must own DOM focus before paste", "true", evaluate(scenario,
                "document.activeElement===document.querySelector(${JSONObject.quote(keySelector)})",
                TimeUnit.NANOSECONDS.toMillis(pasteDeadline - System.nanoTime()).coerceAtLeast(1)))
            instrumentation.runOnMainSync {
                val clip = ClipData.newPlainText(label, privateKey)
                clip.description.extras = android.os.PersistableBundle().apply {
                    putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
                }
                clipboard.setPrimaryClip(clip)
            }
            onView(isAssignableFrom(WebView::class.java)).perform(pressKey(KeyEvent.KEYCODE_PASTE))
            // Boolean only: never retain a key value, DOM dump or screenshot in diagnostics.
            while (true) {
                assertTrue("Native paste did not reach the controlled key field", System.nanoTime() < pasteDeadline)
                val remaining = TimeUnit.NANOSECONDS.toMillis(pasteDeadline - System.nanoTime()).coerceAtLeast(1)
                if (evaluate(scenario, "document.querySelector(${JSONObject.quote(keySelector)})?.value===${JSONObject.quote(privateKey)}", remaining) == "true") break
                Thread.sleep(50)
            }
            assertEquals("Remember credentials must remain off", "true", evaluate(scenario,
                "Array.from(document.querySelectorAll('[role=dialog] input[type=checkbox]')).every(x=>!x.checked)"))
            closeSoftKeyboard()
            clickButton("Connect")
            awaitDocument(scenario, "explicit SSH fingerprint review", present(".fingerprint code"))
            assertEquals("Exact ephemeral server fingerprint must be reviewed", "true", evaluate(scenario,
                "document.querySelector('.fingerprint code')?.textContent===${JSONObject.quote(fixture.getString("fingerprint"))}"))
            assertEquals("No terminal before explicit trust", "false", evaluate(scenario, present(".terminal-canvas .xterm-screen")))
            clickButton("Trust key and connect")
            awaitDocument(scenario, "authenticated owned SSH prompt", screenContains(fixture.getString("prompt")))
            clickButton("Compose")
            typeInto(scenario, ".terminal-compose textarea", fixture.getString("challenge"))
            closeSoftKeyboard()
            clickButton("Paste draft")
            assertEquals("Paste draft must leave the terminal input focused", "true", evaluate(scenario,
                "document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea')"))
            // Paste draft focuses xterm; normal native Enter submits the real shell input.
            onView(isAssignableFrom(WebView::class.java)).perform(pressKey(KeyEvent.KEYCODE_ENTER))
            awaitDocument(scenario, "remote expanded SSH challenge and returned prompt",
                screenContains(fixture.getString("expected")) + " && Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.lastIndexOf(${JSONObject.quote(fixture.getString("prompt"))})>x.textContent.indexOf(${JSONObject.quote(fixture.getString("expected"))}))")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Disconnect $name']")).perform(webClick())
            awaitDocument(scenario, "owned SSH disconnected", "!" + present(".terminal-canvas"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Delete $name']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "[role='dialog'][aria-label='Delete host'] button.danger-button")).perform(webClick())
            awaitDocument(scenario, "owned SSH host deleted", "!" + present(connect))
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            var cleanupFailure: Throwable? = null
            fun retainCleanup(failure: Throwable, message: String) {
                val first = primaryFailure ?: cleanupFailure
                if (first != null) first.addSuppressed(AssertionError(message))
                else cleanupFailure = failure
            }
            try {
                val disconnect = "button[aria-label='Disconnect $name']"
                val authentication = "[role=dialog] textarea, [role=dialog] .fingerprint code, [role=dialog] .destination"
                if (evaluate(scenario, present(authentication)) == "true") {
                    clickButton("Cancel")
                    // An already-visible original error must not abort this cleanup wait.
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    while (true) {
                        assertTrue("Owned SSH authentication dialog did not dismiss", System.nanoTime() < deadline)
                        val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1)
                        if (evaluate(scenario, "!" + present(authentication), remaining) == "true") break
                        Thread.sleep(50)
                    }
                }
                if (evaluate(scenario, present(disconnect)) == "true") {
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, disconnect)).perform(webClick())
                }
                val delete = "button[aria-label='Delete $name']"
                if (evaluate(scenario, present("button[aria-label='Connect to $name']")) == "true") {
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, delete)).perform(webClick())
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, "[role='dialog'][aria-label='Delete host'] button.danger-button")).perform(webClick())
                }
            } catch (cleanup: Throwable) { retainCleanup(cleanup, "Owned SSH UI cleanup failed") }
            try {
                instrumentation.runOnMainSync {
                    if (clipboard.primaryClipDescription?.label?.toString() == label) {
                        if (android.os.Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip()
                        else clipboard.setPrimaryClip(ClipData.newPlainText(label, ""))
                    }
                }
            } catch (cleanup: Throwable) { retainCleanup(cleanup, "Owned SSH clipboard cleanup failed") }
            cleanupFailure?.let { throw it }
        }
    }

    @Test fun bundledWorkspaceSavesHostsThroughNativeIpcAndSurvivesActivityRecreation() {
        val fixture = "Instrumentation ${UUID.randomUUID()}"
        val selector = "button[aria-label='Connect to $fixture']"
        run { val scenario = NativeActivityFixture.scenario
            awaitDocument(scenario, "initial load", "Boolean(document.querySelector('button.welcome-connect'))")
            assertEquals("true", evaluate(scenario, "Boolean(window.__TAURI_INTERNALS__)"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Add host']")).perform(webClick())
            typeInto(scenario, "input[placeholder='Home workstation']", fixture)
            typeInto(scenario, "input[placeholder='workstation.local']", "instrumentation.invalid")
            typeInto(scenario, "input[placeholder='Your SSH username']", "test")
            closeSoftKeyboard()
            val diagnostics = evaluate(scenario, """JSON.stringify({
              valid:document.querySelector('form')?.checkValidity(),
              nameMatches:document.querySelector("input[placeholder='Home workstation']")?.value===${JSONObject.quote(fixture)},
              hostnameMatches:document.querySelector("input[placeholder='workstation.local']")?.value==='instrumentation.invalid',
              usernameMatches:document.querySelector("input[placeholder='Your SSH username']")?.value==='test',
              invalidFields:Array.from(document.querySelectorAll('form input:invalid')).map(x=>x.getAttribute('placeholder')||x.type)
            })""")
            android.util.Log.i("lazysh-instrumentation", "Fixture form diagnostics: $diagnostics")
            assertEquals("true", evaluate(scenario, "Boolean(document.querySelector('form')?.checkValidity())"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "form button.primary-button")).perform(webClick())
            awaitDocument(scenario, "saved host before recreation", "Boolean(document.querySelector(\"$selector\"))")
            scenario.recreate()
            awaitDocument(scenario, "saved host after recreation", "Boolean(document.querySelector(\"$selector\"))")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Delete $fixture']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "[role='dialog'][aria-label='Delete host'] button.danger-button")).perform(webClick())
            awaitDocument(scenario, "fixture deletion", "!document.querySelector(\"$selector\")")
        }
    }

    @Test fun cloudCommandsReachNativeValidationThroughTheBundledWebView() {
        val scenario = NativeActivityFixture.scenario
        awaitDocument(scenario, "Cloud IPC bridge", """Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector("button[aria-label='Add host']"))""")
        // The runtime CI job installs this app on a fresh isolated emulator.
        // Do not clear the vault or enroll a device to establish the fixture.
        assertEquals("true", evaluate(scenario, """(() => {
          window.__lazyshCloudIpcResult = undefined;
          window.__TAURI_INTERNALS__.invoke('app_lock_status', {}).then(access =>
            window.__TAURI_INTERNALS__.invoke('voice_cloud_status', {}, {headers: access.nonce ? {'X-Lazysh-Access':access.nonce} : {}})
          ).then(
            value => { window.__lazyshCloudIpcResult = {ok:true,value}; },
            () => { window.__lazyshCloudIpcResult = {ok:false}; }
          );
          return true;
        })()"""))
        awaitDocument(scenario, "Cloud status reply", "window.__lazyshCloudIpcResult !== undefined")
        assertEquals("Cloud status was denied by the native bridge", "true",
            evaluate(scenario, "window.__lazyshCloudIpcResult.ok === true"))
        assertEquals("Fresh emulator Cloud status must contain only configured:false", "true",
            evaluate(scenario, """(() => {
              const status = window.__lazyshCloudIpcResult.value;
              return status?.configured === false && Object.keys(status).length === 1;
            })()"""))

        assertEquals("true", evaluate(scenario, """(() => {
          window.__lazyshCloudIpcResult = undefined;
          window.__TAURI_INTERNALS__.invoke('app_lock_status', {}).then(access =>
            window.__TAURI_INTERNALS__.invoke('voice_cloud_enroll', {
            origin:'https://cloud-ipc.instrumentation.invalid', token:'invalid-instrumentation-device-token'
          }, {headers: access.nonce ? {'X-Lazysh-Access':access.nonce} : {}})).then(
            () => { window.__lazyshCloudIpcResult = {ok:true}; },
            error => { window.__lazyshCloudIpcResult = {ok:false,error:String(error)}; }
          );
          return true;
        })()"""))
        awaitDocument(scenario, "Cloud token validation reply", "window.__lazyshCloudIpcResult !== undefined")
        assertEquals("Enrollment must reach native token validation before HTTP or vault writes", "true",
            evaluate(scenario, """window.__lazyshCloudIpcResult.ok === false &&
              window.__lazyshCloudIpcResult.error === "Enter the service's 64-character device token"
            """))
        evaluate(scenario, "delete window.__lazyshCloudIpcResult")
    }

}
