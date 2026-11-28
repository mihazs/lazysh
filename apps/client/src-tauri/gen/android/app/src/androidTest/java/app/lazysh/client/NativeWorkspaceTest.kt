package app.lazysh.client

import android.app.Activity
import android.app.Instrumentation
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.content.Intent
import android.content.IntentFilter
import android.os.PatternMatcher
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Build
import android.graphics.Point
import android.graphics.Rect
import android.view.Display
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import android.net.Uri
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import android.view.View
import android.view.ViewGroup
import android.view.ViewConfiguration
import android.webkit.WebView
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.Espresso.onData
import org.hamcrest.Matchers.anyOf
import org.hamcrest.Matchers.anything
import android.widget.ListView
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.typeTextIntoFocusedView
import androidx.test.espresso.action.ViewActions.pressKey
import androidx.test.espresso.action.ViewActions.click
import androidx.test.espresso.action.GeneralClickAction
import androidx.test.espresso.action.CoordinatesProvider
import androidx.test.espresso.action.GeneralSwipeAction
import androidx.test.espresso.action.Swipe
import androidx.test.espresso.action.Press
import androidx.test.espresso.action.Tap
import androidx.test.espresso.action.EspressoKey
import androidx.test.espresso.matcher.ViewMatchers.withText
import androidx.test.espresso.matcher.ViewMatchers.isDisplayed
import androidx.test.espresso.matcher.RootMatchers.isDialog
import androidx.test.espresso.matcher.RootMatchers.isPlatformPopup
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
import kotlin.math.roundToInt
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import androidx.test.uiautomator.Configurator
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// Instrumentation-only: observe the original Window dispatch without consuming or rewriting input.
private class OwnedFingerWindowObserver(
    private val original: android.view.Window.Callback,
    private val epoch: Long,
    private val now: () -> Long = { android.os.SystemClock.uptimeMillis() },
) : android.view.Window.Callback by original {
    private val rows = JSONArray()
    @Volatile private var unavailable = false
    private var overflow = false
    companion object {
        fun coordinate(value: Float): Any = if (value.isFinite()) value.coerceIn(-65_535f, 65_535f).toDouble() else JSONObject.NULL
    }
    fun failureSummary(): String = try {
        val snapshot=snapshot();require(snapshot.length<=16_384)
        val source=JSONObject(snapshot);val state=source.get("state");val overflow=source.get("overflow")
        require(state in listOf("observed","unavailable") && overflow is Boolean)
        val events=source.getJSONArray("events");require(events.length()<=6)
        val projected=JSONArray()
        for(index in 0 until events.length()) {
            val event=events.getJSONObject(index);val action=event.get("action");val outcome=event.get("outcome")
            require(action in listOf("down","move","up","cancel","other") && outcome in listOf("handled","unhandled","threw"))
            val row=JSONObject().put("action",action).put("outcome",outcome)
            for(name in listOf("pointerMatches","finger","touchscreen")) {
                val flag=event.get(name);require(flag is Boolean);row.put(name,flag)
            }
            for(name in listOf("eventAtMs","dispatchAtMs","returnedAtMs")) {
                val value=event.get(name);require(value is Int || value is Long)
                require((value as Number).toLong() in 0..65_535);row.put(name,value)
            }
            projected.put(row)
        }
        JSONObject().put("state",state).put("overflow",overflow).put("eventCount",events.length()).put("events",projected).toString()
    } catch (_: Throwable) { "{\"state\":\"unavailable\"}" }
    // Report motion relative to DOWN, without exposing absolute touch coordinates.
    fun verticalFailureSummary(): String = try {
        val source = JSONObject(snapshot())
        val events = source.getJSONArray("events")
        require(source.getString("state") == "observed" && !source.getBoolean("overflow") && events.length() in 1..6)
        require(events.getJSONObject(0).getString("action") == "down")
        val first = events.getJSONObject(0).getJSONArray("point").getDouble(3)
        require(first.isFinite())
        val deltas = JSONArray()
        for (index in 0 until events.length()) {
            val event = events.getJSONObject(index)
            val action = event.getString("action")
            val y = event.getJSONArray("point").getDouble(3)
            require(action in listOf("down", "move", "up", "cancel", "other") && y.isFinite())
            deltas.put(JSONObject().put("action", action).put("rawYFromDown", (y - first).coerceIn(-65_535.0, 65_535.0)))
        }
        JSONObject().put("state", "observed").put("events", deltas).toString()
    } catch (_: Throwable) { "{\"state\":\"unavailable\"}" }
    private fun elapsed(value: Long) = (value - epoch).coerceIn(0, 65_535)
    private fun record(row: JSONObject?, outcome: String) {
        try {
            if (row != null) synchronized(rows) {
                if (rows.length() < 6) rows.put(row.put("outcome", outcome).put("returnedAtMs", elapsed(now())))
                else overflow = true
            }
        } catch (_: Throwable) { unavailable = true }
    }
    override fun dispatchTouchEvent(event: android.view.MotionEvent): Boolean {
        val row = try {
            if (event.downTime != epoch) null else JSONObject()
                .put("action", when (event.actionMasked) {
                    android.view.MotionEvent.ACTION_DOWN -> "down"
                    android.view.MotionEvent.ACTION_MOVE -> "move"
                    android.view.MotionEvent.ACTION_UP -> "up"
                    android.view.MotionEvent.ACTION_CANCEL -> "cancel"
                    else -> "other"
                })
                .put("eventAtMs", elapsed(event.eventTime)).put("dispatchAtMs", elapsed(now()))
                .put("point", JSONArray(listOf(event.x, event.y, event.rawX, event.rawY).map(::coordinate)))
                .put("historyCount", event.historySize.coerceIn(0, 8))
                .put("pointerMatches", event.pointerCount == 1 && event.getPointerId(0) == 0)
                .put("finger", event.pointerCount > 0 && event.getToolType(0) == android.view.MotionEvent.TOOL_TYPE_FINGER)
                .put("touchscreen", event.isFromSource(android.view.InputDevice.SOURCE_TOUCHSCREEN))
        } catch (_: Throwable) { unavailable = true; null }
        try {
            val handled = original.dispatchTouchEvent(event)
            record(row, if (handled) "handled" else "unhandled")
            return handled
        } catch (failure: Throwable) { record(row, "threw"); throw failure }
    }
    fun snapshot(): String = try {
        synchronized(rows) { JSONObject().put("state", if (unavailable) "unavailable" else "observed")
            .put("overflow", overflow).put("events", JSONArray(rows.toString())).toString() }
    } catch (_: Throwable) { "{\"state\":\"unavailable\"}" }
    fun restore(window: android.view.Window) {
        check(window.callback === this) { "Owned finger Window callback changed" }
        window.callback = original
    }
}

private class NtfyFirstLaunch(started: Long) {
    val deadline = started + TimeUnit.SECONDS.toNanos(6)
    var attempted = false
        private set
    private var lastAllow = 0L
    fun active(now: Long) = now < deadline
    // A tap on a freshly shown permission dialog can be dropped, so re-tap while the owned prompt
    // stays visible, paced so a dialog that is already dismissing is not tapped again.
    fun allow(now: Long, ownedPrompt: Boolean): Boolean {
        if (!active(now) || !ownedPrompt) return false
        if (attempted && now - lastAllow < retryNanos) return false
        attempted = true
        lastAllow = now
        return true
    }
    private val retryNanos = TimeUnit.MILLISECONDS.toNanos(500)
    private var stage="none"
    private var before="unavailable"
    private var after="unavailable"
    private var action="none"
    private var snapshot="unavailable"
    private var clickBefore="unavailable"
    private var clickAfter="unavailable"
    private var firstExpiry="none"
    private fun budget(now:Long)=if(active(now))"positive" else "expired"
    fun start(stage:String,now:Long) {
        require(stage in listOf("foreground","allow","deny","toolbar","prompt","menu","click"))
        this.stage=stage;before=budget(now);after="unavailable"
        if(firstExpiry=="none" && before=="expired")firstExpiry="between"
        if(stage=="click") {
            if(clickBefore=="unavailable")clickBefore=before
            action="calling"
        }
    }
    fun finish(now:Long) {
        after=budget(now)
        if(firstExpiry=="none" && before=="positive" && after=="expired")firstExpiry=stage
        if(stage=="click") {
            if(clickAfter=="unavailable")clickAfter=after
            action="returned"
        }
    }
    fun failed() {if(action=="calling")action="threw"}
    fun sampled() {snapshot=if(action=="none")"beforeAction" else "afterAction"}
    fun observation(permission:String):String {
        require(permission in listOf("granted","denied","unavailable"))
        return "Ntfy first-launch action[stage=$stage before=$before after=$after action=$action snapshot=$snapshot permission=$permission clickBefore=$clickBefore clickAfter=$clickAfter firstExpiry=$firstExpiry]"
    }
}
private class NtfySettingsScroll(started: Long) {
    val deadline = started + TimeUnit.SECONDS.toNanos(5)
    var attempts = 0
        private set
    fun active(now: Long) = now < deadline
    fun scroll(now: Long, ownedSettings: Boolean): Boolean {
        if (!active(now) || !ownedSettings || attempts >= 2) return false
        attempts++
        return true
    }
}

private enum class NtfyReturnRole { settings, defaultDialog, add, certificate, allow, deny, ime }
private data class NtfyReturnSnapshot(val foreground:String,val roles:Map<NtfyReturnRole,Boolean?>) {
    init {require(foreground in listOf("ntfy","permission","lazysh","aospIme","other","unavailable"))}
    fun closed()="foreground=$foreground "+NtfyReturnRole.entries.joinToString(" ") { "$it=${roles[it]?.toString() ?: "unavailable"}" }
    companion object {
        fun observe(foreground:()->String?,role:(NtfyReturnRole)->Boolean):NtfyReturnSnapshot {
            val name=runCatching { foreground() }.getOrNull()
            val closed=when(name) {
                null -> "unavailable"
                "io.heckel.ntfy" -> "ntfy"
                "com.android.permissioncontroller" -> "permission"
                "app.lazysh.client" -> "lazysh"
                "com.android.inputmethod.latin" -> "aospIme"
                else -> "other"
            }
            return NtfyReturnSnapshot(closed,NtfyReturnRole.entries.associateWith { runCatching { role(it) }.getOrNull() })
        }
    }
}
private fun ntfyChallengeTrafficFailure(primary:Throwable,observe:()->String) {
    runCatching {primary.addSuppressed(AssertionError(observe()))}
}
private fun ntfyReturnFailure(primary:Throwable,snapshot:()->NtfyReturnSnapshot) {
    // Observation/report failures must never replace the original action failure.
    runCatching {
        val unavailable=NtfyReturnSnapshot("unavailable",emptyMap())
        val state=runCatching(snapshot).getOrDefault(unavailable)
        primary.addSuppressed(AssertionError("Ntfy return state[${state.closed()}]"))
    }
}

@RunWith(AndroidJUnit4::class)
class NativeWorkspaceTest {
    private fun webView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) webView(view.getChildAt(index))?.let { return it }
        return null
    }

    private fun dispatchEvaluationIfPresent(root: View, expression: String, receive: (String) -> Unit): Boolean {
        val web = webView(root) ?: return false
        web.evaluateJavascript(expression) { receive(it) }
        return true
    }

    private fun evaluateIfPresent(scenario: ActivityScenario<MainActivity>, expression: String, timeoutMillis: Long = 30_000): String? {
        val result = AtomicReference<String>()
        val completed = CountDownLatch(1)
        var dispatched = false
        scenario.onActivity { activity ->
            dispatched = dispatchEvaluationIfPresent(activity.window.decorView, expression) { value ->
                result.set(value); completed.countDown()
            }
        }
        if (!dispatched) return null
        assertTrue("WebView evaluation timed out", completed.await(timeoutMillis, TimeUnit.MILLISECONDS))
        return result.get()
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, expression: String, timeoutMillis: Long = 30_000): String =
        requireNotNull(evaluateIfPresent(scenario, expression, timeoutMillis))

    /** A screenshot of the frame the WebView has just committed, so the pixels show the page's latest DOM. */
    private fun committedScreenshot(scenario: ActivityScenario<MainActivity>, requestId: Long): android.graphics.Bitmap {
        if (android.os.Build.VERSION.SDK_INT < 29) throw AssertionError("Native capture requires frame commits")
        val committed = CountDownLatch(1)
        val frame = Runnable { committed.countDown() }
        var observing = true
        var tree: android.view.ViewTreeObserver? = null
        scenario.onActivity { activity ->
            val view = checkNotNull(webView(activity.window.decorView))
            assertTrue("Native WebView must render frames", view.isAttachedToWindow && view.isHardwareAccelerated)
            view.postVisualStateCallback(requestId, object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) {
                    if (observing && view.isAttachedToWindow) {
                        tree = view.viewTreeObserver
                        tree?.registerFrameCommitCallback(frame)
                        view.invalidate()
                    }
                }
            })
        }
        val submitted = try { committed.await(5, TimeUnit.SECONDS) } finally {
            scenario.onActivity {
                observing = false
                tree?.takeIf { it.isAlive }?.unregisterFrameCommitCallback(frame)
            }
        }
        assertTrue("Native DOM must reach a committed frame", submitted)
        return requireNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
    }

    /**
     * Phones hide the top bar in a connected session by default (the side menu replaces it). These suites drive the top bar's
     * controls, so the device keeps "Show top bar" on; the side menu itself is covered by the Playwright phone project.
     * The first-run gesture tour opens over the first connected phone session, so this device has already seen it.
     */
    private fun keepTopBar(scenario: ActivityScenario<MainActivity>) {
        evaluate(scenario, "(()=>{localStorage.setItem('lazysh.show-top-bar.v1','true');localStorage.setItem('lazysh.gestureTour.v1','999');window.dispatchEvent(new Event('storage'));return true})()")
        awaitDocument(scenario, "top bar kept", "Boolean(document.querySelector('.workspace-header'))")
    }

    private fun awaitUnlockedWorkspace(scenario: ActivityScenario<MainActivity>, stage: String) {
        awaitDocument(scenario, stage, """Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector("button[aria-label='Add host']"))""")
        keepTopBar(scenario)
    }

    private fun awaitDocument(scenario: ActivityScenario<MainActivity>, stage: String, expression: String,
        deadline: Long = System.nanoTime() + TimeUnit.SECONDS.toNanos(120),
        observe: ((Long) -> String)? = null) {
        var firstObservation: String? = null
        var lastObservation: String? = null
        var unfocusedSince: Long? = null
        var recovered = false
        while (true) {
            val native = NativeActivityFixture.readiness(scenario)
            // A system overlay (an expanded shade, a dialog) that took the focus is closed once; the wait stays bounded by the deadline.
            if (native.activityState == androidx.lifecycle.Lifecycle.State.RESUMED && !native.windowFocused) {
                val since = unfocusedSince ?: System.nanoTime().also { unfocusedSince = it }
                if (!recovered && System.nanoTime() - since > TimeUnit.SECONDS.toNanos(5)) {
                    recovered = true
                    NativeActivityFixture.clearSystemOverlays()
                }
            } else unfocusedSince = null
            if (native.ready && evaluateIfPresent(scenario, expression) == "true") return
            val error = evaluateIfPresent(scenario, "document.querySelector('[role=dialog] [role=alert]')?.textContent?.slice(0,320) || ''")
            assertTrue("Native workspace failed at $stage: $error", error == null || error == "\"\"")
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

    private enum class QrCaptureStage { BUDGET, DISPATCH, CALLBACK, RESULT, VIDEO, CONTEXT, DRAW, ENCODE, ENCODED_LIMIT, BASE64, HEADER, DIMENSIONS, PRIVATE_OPEN, PRIVATE_WRITE, PRIVATE_CLOSE, COMPLETE }
    private enum class QrCaptureReason { NOT_ATTEMPTED, EMPTY_BUDGET, FAILED, UNAVAILABLE, INVALID, LIMIT, SAVED }

    // Only typed categories and bounded numbers survive an exception; never its message or cause.
    private class QrCaptureDiagnostic(budget: Long) {
        var stage = QrCaptureStage.BUDGET
        var reason = QrCaptureReason.NOT_ATTEMPTED
        val budgetMs = budget.coerceIn(0, 1_000)
        var encodedChars = 0
        var errno: Int? = null
        fun failed(error: Throwable) {
            reason = QrCaptureReason.FAILED
            errno = (error as? android.system.ErrnoException)?.errno?.takeIf { it in 1..4_095 }
        }
        fun report(): JSONObject = JSONObject().put("stage", stage.name).put("reason", reason.name)
            .put("budgetMs", budgetMs).put("encodedChars", encodedChars.coerceIn(0, 1_000_000))
            .put("errno", errno ?: JSONObject.NULL)
    }

    private enum class QrPermissionPhase { LOOKUP, WINDOW, INJECTION, EFFECT, COMPLETE }
    private class QrPermissionProgress(private val start: Long, private val expected: Int) {
        var phase = QrPermissionPhase.LOOKUP
        var ready = false
        var windows: Int? = null
        var choices: Int? = null
        var dismissed = false
        var permissionBefore: Int? = null
        var permissionAfter: Int? = null
        var delivery: Boolean? = null
            private set
        var clicks = 0
            private set
        fun remaining(now: Long): Long = TimeUnit.NANOSECONDS.toMillis(start + TimeUnit.SECONDS.toNanos(5) - now).coerceIn(0, 5_000)
        fun admit(now: Long): Boolean {
            if (!ready || clicks != 0 || remaining(now) == 0L) return false
            clicks = 1; phase = QrPermissionPhase.INJECTION
            return true
        }
        fun delivered(accepted: Boolean) {
            check(clicks == 1 && delivery == null)
            delivery = accepted; phase = QrPermissionPhase.EFFECT
        }
        fun complete(now: Long): Boolean = remaining(now) > 0 && delivery == true && dismissed && permissionAfter == expected
        private fun permissionLabel(value: Int?): String = when (value) {
            null -> "unobserved"; PackageManager.PERMISSION_GRANTED -> "granted"; PackageManager.PERMISSION_DENIED -> "denied"; else -> "other"
        }
        fun report(now: Long): JSONObject = JSONObject().put("phase", phase.name).put("ready", ready)
            .put("choice", if (expected == PackageManager.PERMISSION_GRANTED) "allowForeground" else "deny")
            .put("windows", windows?.coerceIn(0, 17) ?: JSONObject.NULL).put("choices", choices?.coerceIn(0, 17) ?: JSONObject.NULL)
            .put("clicks", clicks).put("deliveryAccepted", delivery ?: JSONObject.NULL).put("dialogDismissed", dismissed)
            .put("permissionBefore", permissionLabel(permissionBefore)).put("permissionAfter", permissionLabel(permissionAfter))
            .put("remainingMs", remaining(now))
    }

    private companion object {
        const val QR_OBSERVATION_LIMIT = 2 * 262166 + 4096
        val QR_SAMPLE_BOOLEANS = setOf("present", "visible", "src", "permission", "scanning", "decoding", "finishing", "cancelled", "timeout", "busy", "alert")
        val QR_SAMPLE_NULLABLE_BOOLEANS = setOf("hidden", "detailsOpen", "paused")
        val QR_SAMPLE_NULLABLE_NUMBERS = setOf("readyState", "width", "height", "timeMs", "frames")
        val QR_SAMPLE_NUMBERS = setOf("liveTracks", "endedTracks")
        val QR_SAMPLE_KEYS = QR_SAMPLE_BOOLEANS + QR_SAMPLE_NULLABLE_BOOLEANS + QR_SAMPLE_NULLABLE_NUMBERS + QR_SAMPLE_NUMBERS
    }

    private class QrCaptureReservation {
        private enum class State { AVAILABLE, IN_FLIGHT, SPENT }
        private var state = State.AVAILABLE
        fun reserve(): Boolean {
            if (state != State.AVAILABLE) return false
            state = State.IN_FLIGHT
            return true
        }
        fun finishNotReady(): Boolean {
            if (state != State.IN_FLIGHT) return false
            state = State.AVAILABLE
            return true
        }
        fun consume() { state = State.SPENT }
    }

    private fun parseQrObservation(encoded: String): JSONObject {
        require(encoded.length <= QR_OBSERVATION_LIMIT) { "QR observation result bound" }
        return JSONObject(encoded)
    }

    private fun validQrSample(sample: JSONObject): Boolean {
        if (sample.length() != QR_SAMPLE_KEYS.size || !sample.keys().asSequence().all { it in QR_SAMPLE_KEYS }) return false
        return QR_SAMPLE_KEYS.all { key ->
            val value = sample.get(key)
            when (key) {
                in QR_SAMPLE_BOOLEANS -> value is Boolean
                in QR_SAMPLE_NULLABLE_BOOLEANS -> value == JSONObject.NULL || value is Boolean
                else -> {
                    val nullable = key in QR_SAMPLE_NULLABLE_NUMBERS
                    if (value == JSONObject.NULL) nullable
                    else value is Number && value.toDouble().isFinite() &&
                        value.toDouble() in 0.0..(if (key == "readyState") 4.0 else 1_000_000.0) &&
                        value.toDouble() == value.toLong().toDouble()
                }
            }
        }
    }

    private fun isUnattemptedQrFrame(response: JSONObject, sample: JSONObject): Boolean =
        validQrSample(sample) && response.keys().asSequence().toSet() == setOf("attempted", "stage", "reason", "length", "data") &&
            response.opt("attempted") == false && response.opt("stage") == "VIDEO" &&
            response.opt("reason") == "UNAVAILABLE" && response.opt("length") == 0 && response.isNull("data") &&
            (!sample.optBoolean("present") || sample.optInt("readyState") < 2 ||
                sample.optInt("width") == 0 || sample.optInt("height") == 0)

    private fun saveOwnedQrFrame(response: JSONObject, destination: File, diagnostic: QrCaptureDiagnostic): Boolean {
        try {
            val limit = 192 * 1024
            val prefix = "data:image/png;base64,"
            diagnostic.stage = QrCaptureStage.RESULT
            diagnostic.reason = QrCaptureReason.INVALID
            if (response.opt("attempted") != true) return false
            val length = response.opt("length")
            if (length !is Number || length.toDouble() != length.toInt().toDouble() || length.toInt() !in 0..1_000_000) return false
            diagnostic.encodedChars = length.toInt()
            val outcome = when (response.optString("stage") to response.optString("reason")) {
                "VIDEO" to "UNAVAILABLE" -> QrCaptureStage.VIDEO to QrCaptureReason.UNAVAILABLE
                "CONTEXT" to "UNAVAILABLE" -> QrCaptureStage.CONTEXT to QrCaptureReason.UNAVAILABLE
                "DRAW" to "FAILED" -> QrCaptureStage.DRAW to QrCaptureReason.FAILED
                "ENCODE" to "FAILED" -> QrCaptureStage.ENCODE to QrCaptureReason.FAILED
                "ENCODED_LIMIT" to "LIMIT" -> QrCaptureStage.ENCODED_LIMIT to QrCaptureReason.LIMIT
                "COMPLETE" to "SAVED" -> QrCaptureStage.COMPLETE to QrCaptureReason.SAVED
                else -> return false
            }
            if (outcome.first != QrCaptureStage.COMPLETE) {
                diagnostic.stage = outcome.first; diagnostic.reason = outcome.second; return false
            }
            val data = response.opt("data")
            if (data !is String || !data.startsWith(prefix) || data.length != diagnostic.encodedChars || data.length > limit * 4 / 3 + prefix.length) return false
            diagnostic.stage = QrCaptureStage.BASE64
            val bytes = Base64.decode(data.substring(prefix.length), Base64.DEFAULT)
            diagnostic.stage = QrCaptureStage.HEADER
            if (bytes.size !in 24..limit || !bytes.copyOfRange(0, 8).contentEquals(byteArrayOf(-119,80,78,71,13,10,26,10))) return false
            diagnostic.stage = QrCaptureStage.DIMENSIONS
            val dimensions = java.nio.ByteBuffer.wrap(bytes, 16, 8)
            if (dimensions.int !in 1..500 || dimensions.int !in 1..500) return false
            diagnostic.stage = QrCaptureStage.PRIVATE_OPEN
            val descriptor = Os.open(destination.absolutePath, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW,
                OsConstants.S_IRUSR or OsConstants.S_IWUSR)
            FileOutputStream(descriptor).use {
                diagnostic.stage = QrCaptureStage.PRIVATE_WRITE
                it.write(bytes)
                diagnostic.stage = QrCaptureStage.PRIVATE_CLOSE
            }
            diagnostic.stage = QrCaptureStage.COMPLETE
            diagnostic.reason = QrCaptureReason.SAVED
            return true
        } catch (error: Throwable) {
            diagnostic.failed(error)
            return false
        }
    }

    private class QrObservedProgress {
        private var firstAttached: JSONObject? = null
        private var samples = 0
        private var maxReadyState = 0
        private var maxFrames = 0
        private var everScanning = false
        private var everDecoding = false
        fun observe(sample: JSONObject) {
            fun bounded(name: String, maximum: Int) = sample.optInt(name).coerceIn(0, maximum)
            samples = (samples + 1).coerceAtMost(1_000)
            maxReadyState = maxOf(maxReadyState, bounded("readyState", 4))
            maxFrames = maxOf(maxFrames, bounded("frames", 1_000_000))
            everScanning = everScanning || sample.optBoolean("scanning")
            everDecoding = everDecoding || sample.optBoolean("decoding")
            if (firstAttached == null && (sample.optBoolean("src") || bounded("liveTracks", 100) > 0)) {
                firstAttached = JSONObject().put("readyState", bounded("readyState", 4))
                    .put("paused", sample.optBoolean("paused")).put("liveTracks", bounded("liveTracks", 100))
                    .put("width", bounded("width", 1_000_000)).put("height", bounded("height", 1_000_000))
            }
        }
        fun report(): JSONObject = JSONObject().put("firstAttached", firstAttached ?: JSONObject.NULL)
            .put("samples", samples).put("maxReadyState", maxReadyState).put("maxFrames", maxFrames)
            .put("everScanning", everScanning).put("everDecoding", everDecoding)
    }

    // Public state only in messages; one attested synthetic frame is stored privately, never logged.
    private fun qrVideoObservation(scenario: ActivityScenario<MainActivity>, frame: File?): (Long) -> String {
        var firstReady: JSONObject? = null
        var frameAttempted: Boolean? = false
        var frameSaved = false
        var capture: QrCaptureDiagnostic? = null
        val reservation = QrCaptureReservation()
        val progress = QrObservedProgress()
        return { remaining ->
            val reserved = frame != null && reservation.reserve()
            if (reserved) frameAttempted = null
            val diagnostic = if (reserved) QrCaptureDiagnostic(remaining) else null
            val result = AtomicReference<String>()
            val completed = CountDownLatch(1)
            var callbackUnavailable = false
            val sample = try {
                if (diagnostic != null) { capture = diagnostic; diagnostic.stage = QrCaptureStage.DISPATCH }
                scenario.onActivity { activity ->
                    val web = requireNotNull(webView(activity.window.decorView))
                    web.evaluateJavascript("""(() => {
                      const q=document.querySelector('.theme-qr-panel'), v=q?.querySelector('video');
                      const statuses=Array.from(q?.querySelectorAll('[role=status]')??[]).map(x=>x.textContent);
                      const bounded=n=>Number.isFinite(n)?Math.min(1000000,Math.max(0,n)):null;
                      const stream=v?.srcObject, tracks=stream instanceof MediaStream?stream.getVideoTracks():[];
                      const sample={present:!!v,visible:document.visibilityState==='visible',hidden:v?.hidden??null,
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
                      const capture=()=>{
                        const out=(stage,reason,length=0,data=null,attempted=true)=>({attempted,stage,reason,length,data});
                        if(!v||v.readyState<2||!v.videoWidth||!v.videoHeight)return out('VIDEO','UNAVAILABLE',0,null,false);
                        console.warn('lazysh.qr.capture:enter');
                        const scale=Math.min(1,500/v.videoWidth,500/v.videoHeight),c=document.createElement('canvas');
                        c.width=Math.max(1,Math.floor(v.videoWidth*scale));c.height=Math.max(1,Math.floor(v.videoHeight*scale));
                        const ctx=c.getContext('2d');if(!ctx)return out('CONTEXT','UNAVAILABLE');
                        console.warn('lazysh.qr.capture:before_draw');
                        try {ctx.drawImage(v,0,0,c.width,c.height);} catch {return out('DRAW','FAILED');}
                        console.warn('lazysh.qr.capture:after_draw');
                        console.warn('lazysh.qr.capture:before_encode');
                        let png;try {png=c.toDataURL('image/png');} catch {return out('ENCODE','FAILED');}
                        console.warn('lazysh.qr.capture:after_encode');
                        const length=Math.min(png.length,1000000);
                        console.warn('lazysh.qr.capture:return');
                        return png.length<=262166?out('COMPLETE','SAVED',length,png):out('ENCODED_LIMIT','LIMIT',length);
                      };
                      return {sample,capture:${reserved} ? capture() : null};
                    })()""") { value ->
                        // Inspect only a fixed structural token, never log or parse private image bytes here.
                        if (reserved && value.length <= QR_OBSERVATION_LIMIT && value.contains("\"attempted\":true")) {
                            android.util.Log.w("LazyshQrCapture", "lazysh.qr.capture:callback_entry")
                        }
                        result.set(value); completed.countDown()
                    }
                }
                if (diagnostic != null) diagnostic.stage = QrCaptureStage.CALLBACK
                callbackUnavailable = !completed.await(remaining.coerceIn(1, 1_000), TimeUnit.MILLISECONDS)
                assertTrue("QR observation callback unavailable", !callbackUnavailable)
                if (diagnostic != null) { diagnostic.stage = QrCaptureStage.RESULT; diagnostic.reason = QrCaptureReason.INVALID }
                val response = parseQrObservation(requireNotNull(result.get()) { "QR observation result unavailable" })
                require(response.keys().asSequence().toSet() == setOf("sample", "capture")) { "QR observation shape" }
                val current = response.getJSONObject("sample")
                require(validQrSample(current)) { "QR observation contains only the closed public schema" }
                if (reserved) {
                    val encodedFrame = response.getJSONObject("capture")
                    if (isUnattemptedQrFrame(encodedFrame, current)) {
                        check(reservation.finishNotReady()) { "QR capture reservation" }
                        capture = null
                        frameAttempted = false
                    } else {
                        reservation.consume()
                        require(encodedFrame.opt("attempted") == true) { "QR capture attempt shape" }
                        frameAttempted = true
                        frameSaved = saveOwnedQrFrame(encodedFrame, requireNotNull(frame), requireNotNull(diagnostic))
                    }
                } else require(response.isNull("capture")) { "Unreserved QR capture" }
                current
            } catch (error: Throwable) {
                if (reserved) {
                    reservation.consume(); diagnostic?.failed(error)
                    if (callbackUnavailable && diagnostic != null) diagnostic.reason = QrCaptureReason.UNAVAILABLE
                }
                null
            }
            if (sample != null) {
                progress.observe(sample)
                if (firstReady == null && sample.optInt("readyState") >= 2) firstReady = sample
            }
            JSONObject().put("firstReady", firstReady ?: JSONObject.NULL).put("current", sample ?: JSONObject.NULL)
                .put("frameEnabled", frame != null).put("frameAttempted", frameAttempted ?: JSONObject.NULL).put("frameSaved", frameSaved)
                .put("capture", capture?.report() ?: JSONObject.NULL).put("observed", progress.report()).toString().also {
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

        fun settledBeforeDeadline(): Boolean =
            lastPollMatched == true && lastPollReturned?.let { it < deadline } == true

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

    private fun replaceNativeText(scenario: ActivityScenario<MainActivity>, selector: String, value: String) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webClick())
        onView(isAssignableFrom(WebView::class.java)).perform(
            pressKey(EspressoKey.Builder().withKeyCode(KeyEvent.KEYCODE_A).withCtrlPressed(true).build()),
            pressKey(KeyEvent.KEYCODE_DEL))
        // Typing before the renderer applies the clear lets the IME's stale view of the old value drop the first
        // key past the prefix it shares with the new one (#2735: always the character after the shared `…/cards/`).
        awaitDocument(scenario, "$selector cleared before typing", "document.querySelector(${JSONObject.quote(selector)})?.value===''",
            System.nanoTime() + TimeUnit.SECONDS.toNanos(5))
        typeInto(scenario, selector, value)
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
        val typingConstraints = typeTextIntoFocusedView(text).constraints
        val keyEvents = requireNotNull(KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD).getEvents(text.toCharArray())) {
            "Native typing fixture contains characters without virtual keyboard events"
        }
        // Keep the event log limited to generated transcript paths. Record no key or input text.
        val trace = text.startsWith("/tmp/lazysh-android-ssh-") && text.contains("/recorded-conversations/")
        val unhandledDown = mutableListOf<Int>()
        var dispatchIndex = 0
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
                    ready = typingConstraints.matches(requireNotNull(webView(activity.window.decorView)))
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
            if (trace) {
                val traceBudget = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1)
                assertEquals("Recorded fixture event trace did not attach", "true", evaluate(scenario, """(() => {
                    const target = document.activeElement;
                    const controller = new AbortController(), events = [];
                    window.__lazyshFixtureTypingTrace = {controller, events};
                    for (const [index, type] of ['keydown','beforeinput','input','keyup'].entries()) {
                      target.addEventListener(type, event => {
                        if (events.length < 512) events.push(index + ':' + target.value.length + (event.isTrusted ? '+' : '-'));
                      }, {signal: controller.signal});
                    }
                    return true;
                })()""", traceBudget))
            }
            assertTrue("Native typing readiness exhausted the shared budget for $selector", System.nanoTime() < deadline)
            // Espresso webKeys uses JS value assignment. React tracks that setter,
            // so its later synthetic change can be ignored. Inject native keys once
            // into the focused WebView, preserving normal browser input events.
            timing.phase = TypingPhase.NATIVE_INJECTION
            timing.injectionStarted = System.nanoTime()
            // Give Chromium a renderer round trip between batches without refocusing or replaying input.
            for (batch in keyEvents.asList().chunked(16)) {
                assertTrue("Native key dispatch exhausted the shared budget for $selector", System.nanoTime() < deadline)
                scenario.onActivity { activity ->
                    val target = requireNotNull(webView(activity.window.decorView))
                    assertTrue("Native WebView focus changed before typing", target.hasFocus())
                    for (event in batch) {
                        val handled = target.dispatchKeyEvent(event)
                        if (trace && !handled && event.action == KeyEvent.ACTION_DOWN) unhandledDown.add(dispatchIndex)
                        dispatchIndex++
                    }
                }
                val remainingMillis = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1)
                assertEquals("DOM input focus changed during native typing for $selector", "true", evaluate(scenario,
                    "document.activeElement === document.querySelector(${JSONObject.quote(selector)})", remainingMillis))
            }
            timing.injectionReturned = System.nanoTime()
            timing.phase = TypingPhase.SETTLING
            // Android key dispatch does not acknowledge WebView renderer delivery.
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
                // A late renderer callback cannot establish a match within the shared budget.
                if (timing.settledBeforeDeadline()) break
                Thread.sleep(50)
            }
        } catch (failure: Throwable) {
            // Metadata must never replace the original assertion/type/cause.
            runCatching { failure.addSuppressed(AssertionError("Native typing timing: ${timing.report(System.nanoTime())}")) }
            if (trace) runCatching {
                val events = evaluate(scenario, "window.__lazyshFixtureTypingTrace?.events.join(' ') ?? ''", 1_000)
                failure.addSuppressed(AssertionError("Recorded fixture typing trace: dispatched=$dispatchIndex, unhandledDown=$unhandledDown, events (keydown/beforeinput/input/keyup, length, trusted + or -)=$events"))
            }
            throw failure
        } finally {
            if (trace) runCatching {
                evaluate(scenario, """(() => {
                    window.__lazyshFixtureTypingTrace?.controller.abort();
                    delete window.__lazyshFixtureTypingTrace;
                })()""", 1_000)
            }
        }
    }

    @Test fun systemBarsContrastWithTheNativeWindowBackground() {
        NativeActivityFixture.scenario.onActivity { activity ->
            val background = activity.window.decorView.background as? android.graphics.drawable.ColorDrawable
            assertNotNull("Native window must retain its opaque color background", background)
            val color = background!!.color
            assertEquals("System bars expose the native background", activity.getColor(R.color.ic_launcher_background), color)
            assertEquals("Native background must be opaque", 255, android.graphics.Color.alpha(color))
            assertTrue("Light icons must contrast with the native background",
                androidx.core.graphics.ColorUtils.calculateContrast(android.graphics.Color.WHITE, color) >= 4.5)
            val controller = WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            assertFalse("Status bar icons must remain light over navy", controller.isAppearanceLightStatusBars)
            assertFalse("Navigation bar icons must remain light over navy", controller.isAppearanceLightNavigationBars)
        }
    }

    @Test fun edgeToEdgeInsetsReserveBarsCutoutAndKeyboardWithoutAccumulatingPadding() {
        val scenario = NativeActivityFixture.scenario
        scenario.onActivity { activity ->
            val content = activity.findViewById<View>(android.R.id.content)
            val bars = WindowInsetsCompat.Type.systemBars()
            val cutout = WindowInsetsCompat.Type.displayCutout()
            val ime = WindowInsetsCompat.Type.ime()
            val original = ViewCompat.getRootWindowInsets(content)
            try {
                for (keyboard in listOf(320, 0, 240, 0)) {
                    val input = WindowInsetsCompat.Builder()
                        .setInsets(bars, Insets.of(0, 24, 0, 28))
                        .setInsets(cutout, Insets.of(36, 0, 0, 0))
                        .setInsets(ime, Insets.of(0, 0, 0, keyboard))
                        .setVisible(ime, keyboard > 0).build()
                    val forwarded = ViewCompat.dispatchApplyWindowInsets(content, input)
                    assertEquals("Landscape cutout must constrain WebView width", 36, content.paddingLeft)
                    assertEquals("Status bar must constrain WebView height", 24, content.paddingTop)
                    assertEquals(0, content.paddingRight)
                    assertEquals("Keyboard and navigation bar overlap, rather than add", maxOf(28, keyboard), content.paddingBottom)
                    assertEquals("WebView must receive hide updates without double insets", Insets.NONE,
                        forwarded.getInsets(bars or cutout or ime))
                }
            } finally {
                if (original != null) ViewCompat.dispatchApplyWindowInsets(content, original)
                ViewCompat.requestApplyInsets(content)
            }
        }
    }

    /**
     * The soft-keyboard command's controller must bring Android's real keyboard up for the focused page input and
     * take it down again, as Android itself reports it. The Rust command and the page's icon logic are covered elsewhere.
     */
    @Test fun softKeyboardControllerShowsAndHidesTheRealImeForAFocusedPageInput() {
        val scenario = NativeActivityFixture.scenario
        awaitUnlockedWorkspace(scenario, "soft keyboard workspace")
        val probe = "lazysh-soft-keyboard-probe"
        assertEquals("true", evaluate(scenario, """(()=>{const input=document.createElement('input');input.id='$probe';
            input.style.cssText='position:fixed;top:0;left:0;width:200px;height:40px;z-index:2147483647';document.body.appendChild(input);return true})()"""))
        fun imeVisible(): Boolean {
            var visible = false
            scenario.onActivity { visible = SoftKeyboard.visible(it.window) }
            return visible
        }
        fun reached(expected: Boolean): Boolean {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20)
            while (imeVisible() != expected) {
                if (System.nanoTime() >= deadline) return false
                Thread.sleep(100)
            }
            return true
        }
        fun awaitIme(expected: Boolean, stage: String) =
            assertTrue("The soft keyboard did not become ${if (expected) "visible" else "hidden"} after $stage", reached(expected))
        try {
            scenario.onActivity { activity ->
                val web = requireNotNull(webView(activity.window.decorView))
                if (!web.hasFocus()) assertTrue("Native WebView focus was denied", web.requestFocus())
            }
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "#$probe")).perform(webClick())
            // Whether the tap itself raised the keyboard varies by emulator image; the controller must reach each state either way.
            scenario.onActivity { SoftKeyboard.set(it.window, true) }
            // An emulator image with a hardware keyboard and no on-screen one never shows an IME: nothing to verify there.
            org.junit.Assume.assumeTrue("This device shows no on-screen keyboard", reached(true))
            scenario.onActivity { SoftKeyboard.set(it.window, false) }
            awaitIme(false, "the controller hid it")
            scenario.onActivity { SoftKeyboard.set(it.window, true) }
            awaitIme(true, "the controller showed it again")
        } finally {
            scenario.onActivity { SoftKeyboard.set(it.window, false) }
            evaluate(scenario, "(()=>{document.getElementById('$probe')?.remove();return true})()")
        }
    }

    /** Reconnect pacing reads the WebView's network signal; it must follow Android connectivity both ways. */
    @Test fun webViewNetworkSignalFollowsAndroidConnectivity() {
        val scenario = NativeActivityFixture.scenario
        awaitUnlockedWorkspace(scenario, "network signal workspace")
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val signals = "(window.__lazyshNetworkSignals||[])"
        assertEquals("true", evaluate(scenario, """(()=>{window.__lazyshNetworkSignals=[];
            for(const name of ['online','offline'])window.addEventListener(name,()=>window.__lazyshNetworkSignals.push(name));
            return navigator.onLine})()"""))
        fun within(seconds: Long) = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
        try {
            device.executeShellCommand("cmd connectivity airplane-mode enable")
            awaitDocument(scenario, "WebView offline signal", "navigator.onLine===false && $signals.includes('offline')", within(60))
        } finally {
            // Later cases need the emulator network; restore it even when the offline signal never came.
            device.executeShellCommand("cmd connectivity airplane-mode disable")
        }
        awaitDocument(scenario, "WebView online signal", "navigator.onLine===true && $signals.includes('online')", within(90))
    }

    @Test fun documentEvaluationCanWaitForAWebViewInsertedAfterTheNativeRoot() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val pageReady = CountDownLatch(1)
        val evaluated = CountDownLatch(1)
        val result = AtomicReference<String>()
        lateinit var root: android.widget.FrameLayout
        var web: WebView? = null
        try {
            instrumentation.runOnMainSync {
                root = android.widget.FrameLayout(instrumentation.targetContext)
                assertTrue("An existing native root is not a document", !dispatchEvaluationIfPresent(root, "true") {
                    throw AssertionError("Missing WebView must not dispatch JavaScript")
                })
                val owned = WebView(instrumentation.targetContext)
                web = owned
                owned.settings.javaScriptEnabled = true
                owned.webViewClient = object : android.webkit.WebViewClient() {
                    override fun onPageFinished(view: WebView, url: String) { pageReady.countDown() }
                }
                root.addView(owned)
                owned.loadData("""<!doctype html><title>owned evaluation fixture</title>
                    <section class="keep-awake-control"><input type="checkbox" checked disabled>
                    <p role="status">Native display owner is not foreground and focused</p><p role="alert">private fixture text</p></section>""", "text/html", "UTF-8")
            }
            assertTrue("Owned native WebView did not load", pageReady.await(5, TimeUnit.SECONDS))
            instrumentation.runOnMainSync {
                assertTrue("An inserted descendant must receive evaluation", dispatchEvaluationIfPresent(root, BoardReadinessObservation.expression) {
                    result.set(it); evaluated.countDown()
                })
            }
            assertTrue("Owned native WebView did not evaluate", evaluated.await(5, TimeUnit.SECONDS))
            val sample = BoardReadinessObservation.parse(requireNotNull(result.get()))
            for (field in listOf("board", "checkbox", "checked", "disabled", "alert")) assertEquals(true, sample.get(field))
            assertEquals("NOT_READY", sample.getString("status"))
            assertTrue("Observation must exclude arbitrary alert text", !sample.toString().contains("private fixture text"))
        } finally {
            instrumentation.runOnMainSync {
                web?.let { root.removeView(it); it.destroy() }
            }
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

    @Test fun nativeTypingRequiresAnExactMatchObservedStrictlyBeforeTheOriginalDeadline() {
        val origin = 123_000_000L
        val deadline = origin + TimeUnit.SECONDS.toNanos(5)
        val timing = TypingTiming(origin, deadline)
        assertTrue("An absent poll cannot settle input", !timing.settledBeforeDeadline())
        timing.lastPollMatched = true
        assertTrue("A missing observation time cannot settle input", !timing.settledBeforeDeadline())
        for (offset in listOf(-1L, 0L, 1L)) {
            timing.lastPollReturned = deadline + offset
            timing.lastPollMatched = true
            assertEquals("Exact-match deadline offset=$offset", offset < 0, timing.settledBeforeDeadline())
            timing.lastPollMatched = false
            assertTrue("An unmatched poll cannot settle input", !timing.settledBeforeDeadline())
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
        preferencesCategory(scenario, "appearance")
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
        preferencesCategory(scenario, "reset")
        click("Reset preferences")
        awaitDocument(scenario, "theme fixture reset", appearance("forest"))
    }

    /**
     * The Android WebView composites `backdrop-filter` with its own renderer, which Playwright's Chromium and the Linux GUI's
     * WebKitGTK never sample (#1723). For a dialog this reads its computed material, then lays a black and white underlay
     * beneath it and measures the pixels the device shows across the underlay's edge: a translucent material lets through what
     * its alpha leaves, and a blur turns the hard edge into a gradient. A dialog whose fallback is opaque (Preferences is a full
     * page on a phone) must show neither. The default app theme is sampled; Playwright covers the others.
     */
    private fun assertCompositedMaterial(scenario: ActivityScenario<MainActivity>, name: String, dialog: String, glassWhen: String) {
        val quoted = JSONObject.quote(dialog)
        awaitDocument(scenario, "$name settled", "Boolean(document.querySelector($quoted)) && document.getAnimations().every(a=>a.effect?.getComputedTiming().iterations===Infinity||a.playState==='finished')")
        val material = JSONObject(evaluate(scenario, """
            (()=>{
              const dialog=document.querySelector($quoted),backdrop=dialog.parentElement,bounds=dialog.getBoundingClientRect(),style=getComputedStyle(dialog);
              const canvas=document.createElement('canvas').getContext('2d');canvas.fillStyle=style.backgroundColor;canvas.fillRect(0,0,1,1);
              const filter=style.backdropFilter||style.getPropertyValue('-webkit-backdrop-filter');
              const renderable=(CSS.supports('backdrop-filter','blur(1px)')||CSS.supports('-webkit-backdrop-filter','blur(1px)'))
                &&CSS.supports('background','color-mix(in srgb, black 90%, transparent)')
                &&!matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)').matches;
              const centre=bounds.left+bounds.width/2;
              // The underlay sits between the page and the dialog; hiding the content leaves only the dialog's own material.
              const probe=document.createElement('div');probe.id='glass-probe';
              probe.style.cssText='position:absolute;inset:0;z-index:-1;background:linear-gradient(90deg,#000 '+centre+'px,#fff '+centre+'px)';
              backdrop.prepend(probe);backdrop.style.background='transparent';backdrop.style.animation='none';
              for(const child of dialog.children)child.style.visibility='hidden';
              return {glass:renderable&&$glassWhen,alpha:canvas.getImageData(0,0,1,1).data[3],blurred:filter.includes('blur('),filter,background:style.backgroundColor,
                opacity:style.opacity,centre,row:bounds.top+bounds.height/2,width:bounds.width,viewport:innerWidth};
            })()
        """))
        try {
            val glass = material.getBoolean("glass")
            val alpha = material.getInt("alpha")
            assertEquals("$name opacity", "1", material.getString("opacity"))
            assertTrue("$name must be ${if (glass) "translucent" else "opaque"}: $material", if (glass) alpha in 1..254 else alpha == 255)
            assertEquals("$name backdrop blur: $material", glass, material.getBoolean("blurred"))
            val origin = IntArray(2)
            var scale = 0.0
            scenario.onActivity { activity ->
                val view = checkNotNull(webView(activity.window.decorView))
                view.getLocationOnScreen(origin)
                scale = view.width / material.getDouble("viewport")
            }
            fun capture(): List<Double> {
                val shot = committedScreenshot(scenario, System.nanoTime())
                try {
                    return (-80..80).map { offset ->
                        val pixel = shot.getPixel(
                            (origin[0] + (material.getDouble("centre") + offset) * scale).roundToInt(),
                            (origin[1] + material.getDouble("row") * scale).roundToInt())
                        0.2126 * android.graphics.Color.red(pixel) + 0.7152 * android.graphics.Color.green(pixel) + 0.0722 * android.graphics.Color.blue(pixel)
                    }
                } finally { shot.recycle() }
            }
            // Plateaus well clear of the edge, then how many CSS pixels the edge takes to go from 10% to 90%.
            fun shown(luma: List<Double>) = luma.takeLast(21).average() - luma.take(21).average()
            fun transition(luma: List<Double>): Int {
                val dark = luma.take(21).average()
                val range = shown(luma)
                return luma.count { it > dark + range * 0.1 && it < dark + range * 0.9 }
            }
            fun accepted(luma: List<Double>) = Math.abs(255.0 - alpha - shown(luma)) <= 8.0 && (if (glass) transition(luma) >= 15 else transition(luma) <= 3)
            // The compositor presents a mutated page a frame or two after the frame commit, so a first capture can still
            // be the page as it was. The material must hold in two captures in a row, at least a second after the underlay.
            val laid = System.nanoTime()
            var luma = capture()
            var holds = 0
            val deadline = laid + TimeUnit.SECONDS.toNanos(15)
            while (true) {
                holds = if (accepted(luma)) holds + 1 else 0
                if (holds >= 2 && System.nanoTime() - laid >= TimeUnit.SECONDS.toNanos(1)) break
                if (System.nanoTime() >= deadline) break
                Thread.sleep(300)
                luma = capture()
            }
            android.util.Log.i("lazysh-glass", "$name: $material shown=${shown(luma)} transition=${transition(luma)} scale=$scale")
            assertEquals("$name: the underlay must show through by what the alpha leaves ($material)", 255.0 - alpha, shown(luma), 8.0)
            assertTrue("$name: a ${if (glass) "blurred" else "solid"} edge took ${transition(luma)} CSS px ($material)", if (glass) transition(luma) >= 15 else transition(luma) <= 3)
        } finally {
            evaluate(scenario, """
                (()=>{const dialog=document.querySelector($quoted),backdrop=dialog?.parentElement;
                  document.getElementById('glass-probe')?.remove();backdrop?.style.removeProperty('background');backdrop?.style.removeProperty('animation');
                  for(const child of dialog?.children??[])child.style.visibility='';return true;})()
            """)
        }
    }

    @Test fun webViewCompositesTheGlassMaterialOfItsDialogsOrKeepsTheOpaqueFallback() {
        val scenario = NativeActivityFixture.scenario
        awaitUnlockedWorkspace(scenario, "glass material workspace")
        closeHostsDrawer(scenario, "hosts closed before glass material")
        // The tools dialog is glass at every width. Preferences is only glass beside a sidebar: on a phone it is an opaque page.
        openWorkspaceTools(scenario, System.nanoTime() + TimeUnit.SECONDS.toNanos(120))
        try { assertCompositedMaterial(scenario, "Workspace tools", workspaceToolsDialog, "true") }
        finally { onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Close Workspace tools']")).perform(webClick()) }
        awaitDocument(scenario, "workspace tools closed", "!Boolean(document.querySelector(${JSONObject.quote(workspaceToolsDialog)}))")
        openPreferences(scenario)
        try { assertCompositedMaterial(scenario, "Preferences", "[role=dialog][aria-label='Preferences']", "matchMedia('(min-width: 601px)').matches") }
        finally { closePreferences() }
    }

    private fun openAppearance(scenario: ActivityScenario<MainActivity>, stage: String) {
        awaitUnlockedWorkspace(scenario, stage)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Preferences']")).perform(webClick())
        preferencesCategory(scenario, "appearance")
    }
    private fun closePreferences() =
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Close Preferences']")).perform(webClick())
    /** Closes the Shareable uploads dialog: choosing that category closes Preferences and opens this dialog, which covers and inerts the workspace until it is closed. */
    private fun closeShareDialog(scenario: ActivityScenario<MainActivity>) {
        val dialog = "[role=dialog][aria-label='Shareable uploads']"
        val close = "button[aria-label='Close Shareable uploads']"
        val gone = "!Boolean(document.querySelector(${JSONObject.quote(dialog)}))"
        if (evaluate(scenario, gone) == "true") return
        awaitDocument(scenario, "the Shareable uploads close control", "Boolean(document.querySelector(${JSONObject.quote(close)}))",
            observe = { remaining -> evaluate(scenario, "JSON.stringify(Array.from(document.querySelectorAll('[role=dialog]')).map(d=>d.getAttribute('aria-label')+':'+d.innerText.slice(0,120)))", remaining) })
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, close)).perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "Shareable uploads closed", gone)
    }
    private fun webButton(label: String) =
        onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(text())='$label']")).perform(webScrollIntoView()).perform(webClick())
    private fun visibleStatus(text: String) =
        "Array.from(document.querySelectorAll('[role=status]')).some(x=>x.textContent===${JSONObject.quote(text)})"

    // The Appearance button reads the actual system clipboard through the native Android path.
    @Test fun clipboardThemeImportReadsTheNativeClipboardWithExplicitReview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val scenario = NativeActivityFixture.scenario
        fun clip(text: String) = instrumentation.runOnMainSync { clipboard.setPrimaryClip(ClipData.newPlainText("lazysh theme fixture", text)) }
        val saved = "localStorage.getItem('lazysh.preferences.v1')"
        val noPreview = "!document.querySelector('.theme-preview')"
        val theme = JSONObject().put("v", 1).put("name", "Android clipboard").put("mode", "light")
            .put("colors", JSONObject().put("background", "#f4efe6").put("foreground", "#1d1d1d")).toString()
        openAppearance(scenario, "clipboard theme workspace")
        try {
            onWebView().withElement(findElement(Locator.XPATH, "//summary[normalize-space(text())='Import and share theme']")).perform(webClick())
            awaitDocument(scenario, "native clipboard platform ready",
                "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Read theme from clipboard' && !x.disabled)")
            val before = evaluate(scenario, saved)
            val appTheme = evaluate(scenario, "document.documentElement.dataset.appTheme")
            clip(theme)
            webButton("Read theme from clipboard")
            awaitDocument(scenario, "native clipboard theme preview", "document.querySelector('.theme-preview h3')?.textContent==='Android clipboard'")
            assertEquals("Clipboard input fills the draft", "true", evaluate(scenario,
                "document.querySelector(\"[aria-label='Theme JSON or share code']\")?.value===${JSONObject.quote(theme)}"))
            assertEquals("A clipboard preview must not apply itself", before, evaluate(scenario, saved))
            assertEquals("A clipboard preview must not change the app theme", appTheme, evaluate(scenario, "document.documentElement.dataset.appTheme"))
            webButton("Cancel preview")
            awaitDocument(scenario, "clipboard preview discarded", noPreview)
            val draft = JSONObject.quote("manual draft before an oversized clipboard")
            assertEquals("A manual draft replaces the clipboard text", "true", evaluate(scenario, """(()=>{
                const area=document.querySelector("[aria-label='Theme JSON or share code']");if(!area)return false;
                Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,$draft);
                area.dispatchEvent(new Event('input',{bubbles:true}));return area.value===$draft;})()"""))
            clip("{\"name\":\"" + "x".repeat(20_000) + "\"}")
            webButton("Read theme from clipboard")
            awaitDocument(scenario, "oversized clipboard rejected", visibleStatus("Theme input exceeds 16 KiB."))
            assertEquals("Oversized input must not preview", "true", evaluate(scenario, noPreview))
            assertEquals("Oversized input must keep the manual draft", "true", evaluate(scenario,
                "document.querySelector(\"[aria-label='Theme JSON or share code']\")?.value===$draft"))
            clip("{\"v\":1,\"name\":\"Unsafe\",\"mode\":\"light\",\"colors\":{\"background\":\"url(evil)\",\"foreground\":\"#fff\"}}")
            webButton("Read theme from clipboard")
            awaitDocument(scenario, "invalid clipboard rejected", visibleStatus("Invalid theme color: background"))
            assertEquals("Invalid input must not preview", "true", evaluate(scenario, noPreview))
            assertEquals("Rejected input must not save preferences", before, evaluate(scenario, saved))
        } finally {
            instrumentation.runOnMainSync { if (Build.VERSION.SDK_INT >= 28) clipboard.clearPrimaryClip() }
            closePreferences()
        }
    }

    // The inbox test action posts through the packaged notification plugin; Android's own
    // notification records and the SystemUI shade, not the DOM, prove the delivery.
    @Test fun inboxTestNotificationReachesTheShadeAndPauseDisablesIt() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = context.getSystemService(android.app.NotificationManager::class.java)
        val device = UiDevice.getInstance(instrumentation)
        val scenario = NativeActivityFixture.scenario
        val title = "lazysh notifications"
        val body = "Local notifications are enabled on this device."
        val inbox = "[role='dialog'][aria-label='Notification inbox']"
        val stored = "JSON.parse(localStorage.getItem('lazysh.inbox.v1')??'{}').notifications===true"
        fun posted() = manager.activeNotifications.filter {
            it.notification.extras.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString() == title
        }
        fun testButton(enabled: Boolean) = "Array.from(document.querySelectorAll(${JSONObject.quote("$inbox button")}))" +
            ".some(x=>x.textContent==='Test notification' && x.disabled===${!enabled})"
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        posted().forEach { manager.cancel(it.tag, it.id) }
        awaitUnlockedWorkspace(scenario, "notification inbox workspace")
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Preferences']")).perform(webClick())
        preferencesCategory(scenario, "inbox", inbox)
        try {
            if (evaluate(scenario, stored) == "true") webButton("Pause system notifications")
            awaitDocument(scenario, "test action waits for enabled notifications", testButton(false))
            webButton("Enable system notifications")
            awaitDocument(scenario, "granted notification permission enables the inbox",
                visibleStatus("System notifications enabled for new attention events while connected.") + " && " + stored)
            webButton("Test notification")
            awaitDocument(scenario, "test notification submitted",
                visibleStatus("Test notification submitted. Delivery depends on your system notification settings."))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (posted().isEmpty() && System.nanoTime() < deadline) Thread.sleep(100)
            val record = posted().singleOrNull()
            assertNotNull("The test action must post exactly one Android notification", record)
            assertEquals("Test notification body", body,
                record!!.notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString())
            val shade = device.openNotification()
            try {
                assertTrue("Notification shade must open", shade)
                // SystemUI animates a new row into the shade, so wait for the title first.
                val heading = device.wait(Until.findObject(By.pkg("com.android.systemui").text(title)), 5000)
                assertNotNull("Test notification title must reach the SystemUI shade", heading)
                val ancestors = generateSequence(heading!!) { it.parent }.toList()
                val row = ancestors.firstOrNull { it.resourceName == "com.android.systemui:id/expandableNotificationRow" }
                assertNotNull("Title must sit in a notification row: ${ancestors.map { it.resourceName }}", row)
                // A collapsed row ellipsizes a long body, so expand it before reading the full text.
                if (!row!!.hasObject(By.text(body))) row.findObject(By.res("android", "expand_button"))?.click()
                assertTrue("Test notification body must share the title's shade row: ${row.findObjects(By.textContains("")).map { it.text }}",
                    row.wait(Until.hasObject(By.text(body)), 5000))
            } finally {
                manager.cancel(record.tag, record.id)
                if (shade) device.pressBack()
            }
            val focus = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (!NativeActivityFixture.readiness(scenario).ready && System.nanoTime() < focus) Thread.sleep(50)
            assertTrue("Workspace must be ready after the shade closes: ${NativeActivityFixture.readiness(scenario)}",
                NativeActivityFixture.readiness(scenario).ready)
            webButton("Pause system notifications")
            awaitDocument(scenario, "pause disables system notifications and the test action",
                testButton(false) + " && !($stored) && Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Enable system notifications')")
        } finally {
            posted().forEach { manager.cancel(it.tag, it.id) }
            if (evaluate(scenario, "Boolean(document.querySelector(${JSONObject.quote(inbox)}))") == "true")
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Close Notification inbox']")).perform(webClick())
        }
    }

    // Launcher entries are aliases of LauncherActivity, so switching never removes the workspace task.
    @Test fun appIconAliasSwitchKeepsTheRunningWorkspaceActivity() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val manager = context.packageManager
        val scenario = NativeActivityFixture.scenario
        fun component(icon: String) = LauncherIcons.component(context, icon)
        fun launcherEntries() = manager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
            .setPackage(context.packageName), 0).map { it.activityInfo.name }
        val original = AtomicReference<MainActivity>()
        scenario.onActivity { original.set(it) }
        val workspaceTasks = {
            context.getSystemService(android.app.ActivityManager::class.java).appTasks.mapNotNull { runCatching { it.taskInfo }.getOrNull() }
                .filter { info -> listOf(info.baseIntent.component?.className, info.baseActivity?.className, info.topActivity?.className)
                    .any { it == MainActivity::class.java.name } }
        }
        // Re-enter through the real launcher alias and observe the trampoline run, not just the scenario state.
        fun relaunch(stage: String, icon: String) {
            val launch = requireNotNull(manager.getLaunchIntentForPackage(context.packageName))
            assertEquals("$stage must resolve to the $icon launcher alias", component(icon), launch.component)
            val events = java.util.Collections.synchronizedList(mutableListOf<Pair<android.app.Activity, Stage>>())
            val callback = androidx.test.runner.lifecycle.ActivityLifecycleCallback { activity, observed -> events.add(activity to observed) }
            val lifecycle = ActivityLifecycleMonitorRegistry.getInstance()
            instrumentation.runOnMainSync { lifecycle.addLifecycleCallback(callback) }
            fun trampolined(): Boolean = synchronized(events) {
                val paused = events.indexOfFirst { it.first === original.get() && it.second == Stage.PAUSED }
                events.any { it.first is LauncherActivity && it.second == Stage.DESTROYED } && paused >= 0 &&
                    events.drop(paused + 1).any { it.first === original.get() && it.second == Stage.RESUMED }
            }
            try {
                context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
                while (!trampolined() && System.nanoTime() < deadline) Thread.sleep(50)
                assertTrue("$stage must run LauncherActivity and bring the original workspace back: " +
                    synchronized(events) { events.map { "${it.first.javaClass.simpleName}:${it.second}" } }, trampolined())
            } finally {
                instrumentation.runOnMainSync { lifecycle.removeLifecycleCallback(callback) }
            }
            // The lifecycle monitor is main-thread only; assert outside so a failure reports instead of crashing.
            val resumed = AtomicReference<List<android.app.Activity>>()
            instrumentation.runOnMainSync { resumed.set(lifecycle.getActivitiesInStage(Stage.RESUMED).toList()) }
            assertEquals("$stage must leave only the original workspace resumed", listOf<android.app.Activity>(original.get()), resumed.get())
            assertEquals("$stage must not start a second workspace task", 1, workspaceTasks().size)
            scenario.onActivity { assertSame("$stage must reuse the original workspace Activity", original.get(), it) }
        }
        fun choose(icon: String, label: String) {
            assertEquals("Icon selector must accept $icon", "true", evaluate(scenario, """(()=>{
                const select=Array.from(document.querySelectorAll('label')).find(x=>x.textContent.startsWith('Home Screen icon'))?.querySelector('select');
                if(!select||select.disabled)return false;
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSONObject.quote(icon)});
                select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()"""))
            webButton("Apply app icon")
            awaitDocument(scenario, "$icon launcher icon readback", visibleStatus("Current icon: $label"))
        }
        assertEquals("A fresh install exposes only the Default launcher entry", listOf(component("default").className), launcherEntries())
        // Filter resolution, including disabled aliases: an explicit component would bypass intent filters.
        assertEquals("Only the two icon aliases declare launcher filters; MainActivity never does",
            setOf(component("default").className, component("amber").className),
            manager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setPackage(context.packageName),
                PackageManager.MATCH_DISABLED_COMPONENTS).map { it.activityInfo.name }.toSet())
        relaunch("Default launcher alias", "default")
        val marker = JSONObject.quote(UUID.randomUUID().toString())
        try {
            openAppearance(scenario, "app icon workspace")
            awaitDocument(scenario, "Android icon status", visibleStatus("Current icon: Default"))
            evaluate(scenario, "window.__lazyshIconMarker=$marker")
            choose("amber", "Amber")
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, manager.getComponentEnabledSetting(component("amber")))
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, manager.getComponentEnabledSetting(component("default")))
            assertEquals("Exactly the Amber launcher entry remains", listOf(component("amber").className), launcherEntries())
            // Package-changed cleanup is asynchronous; give it time to act on any matching task.
            Thread.sleep(3_000)
            assertEquals("Switching must leave the workspace resumed", androidx.lifecycle.Lifecycle.State.RESUMED, scenario.state)
            scenario.onActivity { assertSame("Switching must keep the original Activity", original.get(), it); assertFalse(it.isFinishing) }
            assertEquals("Switching must not reload the WebView", "true", evaluate(scenario, "window.__lazyshIconMarker===$marker"))
            closePreferences()
            relaunch("Amber launcher alias", "amber")
            assertEquals("Relaunch must not reload the WebView", "true", evaluate(scenario, "window.__lazyshIconMarker===$marker"))
            openAppearance(scenario, "app icon restore")
            awaitDocument(scenario, "Amber readback after relaunch", visibleStatus("Current icon: Amber"))
            choose("default", "Default")
            assertEquals("Default restores the manifest state", PackageManager.COMPONENT_ENABLED_STATE_DEFAULT,
                manager.getComponentEnabledSetting(component("default")))
            assertEquals(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, manager.getComponentEnabledSetting(component("amber")))
            assertEquals(listOf(component("default").className), launcherEntries())
            assertEquals("Restoring must not reload the WebView", "true", evaluate(scenario, "window.__lazyshIconMarker===$marker"))
        } finally {
            instrumentation.runOnMainSync { LauncherIcons.select(context, "default") }
            runCatching { closePreferences() }
        }
    }

    /**
     * Test-only seam that holds the camera frame the QR panel just drew, before it is encoded. The stream stays live and
     * nothing reaches native decoding, so a cancel lands on a capture that is provably mid-stream instead of racing the
     * first decode. [release] hands the held frame back late, the way a slow encoder would.
     */
    private class QrFrameGate(private val key: String = "__lazyshQrFrameGate_" + UUID.randomUUID().toString().replace("-", "")) {
        private val gate = "window[${JSONObject.quote(key)}]"
        // Holding a frame also records, in the same page task, whether the video's tracks are live and whether a preview shows, then
        // presses the page's own Cancel button (a script click, as Espresso's web click is) so no harness round trip is needed while streaming.
        val install = "(()=>{const proto=HTMLCanvasElement.prototype,original=proto.toBlob,held=[];" +
            "$gate={original,held,live:null,previewed:null};proto.toBlob=function(callback,type,quality){" +
            "const stream=document.querySelector('.theme-qr-panel video')?.srcObject;" +
            "$gate.live=stream instanceof MediaStream&&stream.getVideoTracks().some(x=>x.readyState==='live');" +
            "$gate.previewed=Boolean(document.querySelector('.theme-preview'));" +
            "held.push(()=>original.call(this,callback,type,quality));" +
            "setTimeout(()=>Array.from(document.querySelectorAll('.theme-qr-panel button')).find(x=>x.textContent.trim()==='Cancel QR scan')?.click(),0);};return true;})()"
        val live = "$gate.live===true"
        val previewed = "$gate.previewed===true"
        val held = "$gate.held.length"
        val release = "(()=>{$gate.held.splice(0).forEach(run=>run());return true;})()"
        val restore = "(()=>{const saved=$gate;if(saved){HTMLCanvasElement.prototype.toBlob=saved.original;saved.held.splice(0).forEach(run=>run());delete window[${JSONObject.quote(key)}];}return true;})()"
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

    @Test fun qrCaptureReservationCannotRearmAfterTimeoutOrAnActualAttempt() {
        val reservation = QrCaptureReservation()
        assertTrue("Initial diagnostic can reserve", reservation.reserve())
        assertTrue("Only one dispatch may own the reservation", !reservation.reserve())
        assertTrue("Certified no-attempt can rearm", reservation.finishNotReady())
        assertTrue("A later ready observation can reserve", reservation.reserve())
        reservation.consume()
        assertTrue("Actual attempt or timeout permanently consumes capacity", !reservation.reserve())
        assertTrue("A late no-attempt callback cannot rearm consumed capacity", !reservation.finishNotReady())
        assertTrue("A late completion cannot permit another capture", !reservation.reserve())
    }

    private fun qrNotReadySample() = JSONObject("""{
        "present":true,"visible":true,"hidden":false,"detailsOpen":true,
        "readyState":0,"width":0,"height":0,"paused":true,"timeMs":0,"frames":0,
        "src":false,"liveTracks":0,"endedTracks":0,"permission":true,"scanning":false,
        "decoding":false,"finishing":false,"cancelled":false,"timeout":false,"busy":false,"alert":false
    }""")

    private fun qrNoAttemptResponse() = JSONObject().put("attempted", false).put("stage", "VIDEO").put("reason", "UNAVAILABLE")
        .put("length", 0).put("data", JSONObject.NULL)

    @Test fun qrMalformedSamplesCannotRearmCaptureThroughOptDefaults() {
        val response = qrNoAttemptResponse()
        val missingPresent = qrNotReadySample().also { it.remove("present") }
        val malformed = listOf(JSONObject(), missingPresent, qrNotReadySample().put("extra", false),
            qrNotReadySample().put("present", 0), qrNotReadySample().put("src", 1),
            qrNotReadySample().put("readyState", "0"), qrNotReadySample().put("hidden", 0),
            qrNotReadySample().put("present", JSONObject.NULL), qrNotReadySample().put("liveTracks", JSONObject.NULL),
            qrNotReadySample().put("readyState", 5), qrNotReadySample().put("frames", -1),
            qrNotReadySample().put("timeMs", 0.5))
        malformed.forEachIndexed { index, sample ->
            assertTrue("Malformed sample cannot certify no attempt: case $index", !isUnattemptedQrFrame(response, sample))
        }
        assertTrue("Full actual not-ready shape may certify no attempt", isUnattemptedQrFrame(response, qrNotReadySample()))
        val absent = qrNotReadySample().put("present", false)
        for (key in listOf("hidden", "detailsOpen", "paused", "readyState", "width", "height", "timeMs", "frames")) absent.put(key, JSONObject.NULL)
        assertTrue("Actual absent-video nullable fields remain valid", isUnattemptedQrFrame(response, absent))
    }

    @Test fun qrCombinedObservationRequiresExactNoAttemptAndBoundsBeforeParsing() {
        val notReady = qrNotReadySample()
        val response = qrNoAttemptResponse()
        assertTrue("Exact not-ready response may release reservation", isUnattemptedQrFrame(response, notReady))
        assertTrue("An attempted frame cannot rearm", !isUnattemptedQrFrame(JSONObject(response.toString()).put("attempted", true), notReady))
        assertTrue("An extra field cannot certify no attempt", !isUnattemptedQrFrame(JSONObject(response.toString()).put("extra", false), notReady))
        assertTrue("A ready sample cannot certify no attempt", !isUnattemptedQrFrame(response,
            JSONObject(notReady.toString()).put("readyState", 4).put("width", 480).put("height", 640)))
        val oversized = "{\"sample\":{},\"capture\":null}" + " ".repeat(QR_OBSERVATION_LIMIT)
        val rejected = runCatching { parseQrObservation(oversized) }.exceptionOrNull()
        assertEquals("QR observation result bound", rejected?.message)
        assertTrue("Malformed JSON cannot release capacity", runCatching { parseQrObservation("{") }.isFailure)
    }

    @Test fun qrObservedProgressRetainsAttachmentBeforeReadyAndOnlyBoundedMilestones() {
        val progress = QrObservedProgress()
        val permission = JSONObject().put("src", false).put("liveTracks", 0).put("readyState", 0)
            .put("frames", 0).put("paused", true).put("scanning", false).put("decoding", false)
        progress.observe(permission)
        assertTrue("Permission alone does not establish attachment", progress.report().isNull("firstAttached"))
        val attached = JSONObject(permission.toString()).put("src", true).put("liveTracks", 1)
            .put("width", 0).put("height", 0).put("privateIgnored", "private-payload-sentinel")
        progress.observe(attached)
        progress.observe(JSONObject(attached.toString()).put("readyState", 4).put("frames", 9)
            .put("width", 480).put("height", 640).put("paused", false).put("scanning", true))
        progress.observe(JSONObject(permission.toString()).put("decoding", true))
        progress.observe(permission)
        val report = progress.report()
        val first = report.getJSONObject("firstAttached")
        assertEquals(setOf("readyState", "paused", "liveTracks", "width", "height"), first.keys().asSequence().toSet())
        assertEquals(0, first.getInt("readyState"))
        assertTrue("Attachment can precede play", first.getBoolean("paused"))
        assertEquals(1, first.getInt("liveTracks"))
        assertEquals(5, report.getInt("samples"))
        assertEquals(4, report.getInt("maxReadyState"))
        assertEquals(9, report.getInt("maxFrames"))
        assertTrue("Observed milestones survive timeout", report.getBoolean("everScanning") && report.getBoolean("everDecoding"))
        assertTrue("Only whitelisted metadata is retained", !report.toString().contains("sentinel"))
        repeat(1_010) { progress.observe(JSONObject().put("readyState", 99).put("frames", Int.MAX_VALUE)) }
        assertEquals(1_000, progress.report().getInt("samples"))
        assertEquals(4, progress.report().getInt("maxReadyState"))
        assertEquals(1_000_000, progress.report().getInt("maxFrames"))
        assertTrue("Progress metadata remains bounded", progress.report().toString().length <= 320)
    }

    @Test fun qrCaptureFailureMetadataIsFiniteAndExcludesPrivateExceptionData() {
        val diagnostic = QrCaptureDiagnostic(4_000)
        diagnostic.stage = QrCaptureStage.PRIVATE_OPEN
        diagnostic.encodedChars = 2_000_000
        diagnostic.failed(android.system.ErrnoException("private-frame-path-sentinel", OsConstants.EACCES))
        val report = diagnostic.report()
        assertEquals("PRIVATE_OPEN", report.getString("stage"))
        assertEquals("FAILED", report.getString("reason"))
        assertEquals(1_000, report.getInt("budgetMs"))
        assertEquals(1_000_000, report.getInt("encodedChars"))
        assertEquals(OsConstants.EACCES, report.getInt("errno"))
        assertEquals(setOf("stage", "reason", "budgetMs", "encodedChars", "errno"), report.keys().asSequence().toSet())
        assertTrue("Capture metadata must exclude exception data", !report.toString().contains("sentinel"))
        diagnostic.failed(IllegalStateException("private-payload-sentinel"))
        assertTrue("Other failures have no invented errno", diagnostic.report().isNull("errno"))
        assertTrue("Capture metadata remains bounded", diagnostic.report().toString().length <= 256)
        assertEquals(0, QrCaptureDiagnostic(-1).report().getInt("budgetMs"))
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

    @Test fun qrPermissionChoiceRequiresDeliveredOneShotAndEffectWithinOriginalBudget() {
        val progress = QrPermissionProgress(0, PackageManager.PERMISSION_GRANTED)
        assertEquals(5_000L, progress.remaining(0)); assertTrue(!progress.admit(0))
        progress.ready = true
        assertTrue(progress.admit(1)); progress.delivered(false)
        progress.dismissed = true; progress.permissionAfter = PackageManager.PERMISSION_GRANTED
        assertTrue(!progress.complete(2)); assertTrue(!progress.admit(2)); assertEquals(1, progress.clicks)
        assertTrue(runCatching { progress.delivered(true) }.isFailure)
        val delayed = QrPermissionProgress(0, PackageManager.PERMISSION_GRANTED)
        delayed.ready = true; assertTrue(delayed.admit(0)); delayed.delivered(true)
        assertTrue(!delayed.complete(TimeUnit.SECONDS.toNanos(4)))
        delayed.dismissed = true; delayed.permissionAfter = PackageManager.PERMISSION_GRANTED
        assertTrue(delayed.complete(TimeUnit.SECONDS.toNanos(4)))
        assertTrue(!delayed.complete(TimeUnit.SECONDS.toNanos(5)))
        assertTrue(!delayed.admit(TimeUnit.SECONDS.toNanos(5)))
        assertTrue(delayed.report(Long.MAX_VALUE).toString().length <= 512)
        val denied = QrPermissionProgress(0, PackageManager.PERMISSION_DENIED)
        assertEquals("unobserved", denied.report(0).getString("permissionAfter"))
        assertTrue(denied.report(0).isNull("windows"))
        denied.dismissed = true; denied.permissionAfter = PackageManager.PERMISSION_DENIED
        assertTrue(!denied.complete(0)) // An already-denied permission does not prove a Deny click.
    }

    // The first real choice of a case fixes the sheet's system owner; every later choice must come from the same package.
    private var cameraPermissionOwner: String? = null

    /** Clicks one real choice ("permission_deny_button" or "permission_allow_foreground_only_button") of the system camera permission sheet and waits for its effect. */
    private fun chooseOwnedCameraPermission(id: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val expected = when (id) {
            "permission_deny_button" -> PackageManager.PERMISSION_DENIED
            "permission_allow_foreground_only_button" -> PackageManager.PERMISSION_GRANTED
            else -> throw AssertionError("Unsupported owned camera permission choice")
        }
        val progress = QrPermissionProgress(System.nanoTime(), expected)
        val selector = cameraPermissionOwner?.let { By.res(it, id) }
            ?: By.res(Pattern.compile("[a-zA-Z0-9_.]+:id/" + Pattern.quote(id)))
        val device = UiDevice.getInstance(instrumentation)
        try {
            assertTrue("Owned permission choice requires default-display window observations", Build.VERSION.SDK_INT >= 30)
            val lookup = progress.remaining(System.nanoTime())
            assertTrue("Expected real owned camera permission choice: $id", lookup > 0 && device.wait(Until.hasObject(selector), lookup))
            val choices = device.findObjects(selector)
            assertEquals("Permission choice must be unambiguous", 1, choices.size)
            val owner = requireNotNull(choices.single().applicationPackage) { "Permission owner unavailable" }
            val info = context.packageManager.getApplicationInfo(owner, 0)
            assertTrue("Permission choice must belong to a system application", info.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM != 0)
            if (cameraPermissionOwner == null) cameraPermissionOwner = owner
            assertEquals("Permission choices must retain the same system owner", cameraPermissionOwner, owner)
            // The preceding UiAutomator query configures interactive-window reporting.
            // Use the same connection flags, without another implicit idle wait.
            val automation = instrumentation.getUiAutomation(Configurator.getInstance().uiAutomationFlags)
            var selected: Pair<Int, Point>? = null
            progress.phase = QrPermissionPhase.WINDOW
            while (progress.remaining(System.nanoTime()) > 0 && selected == null) {
                val windows = automation.windows
                progress.windows = windows.size
                try {
                    assertTrue("Owned permission window inventory must stay bounded", windows.size <= 16)
                    val candidates = windows.filter { it.displayId == Display.DEFAULT_DISPLAY && it.isActive && it.isFocused }
                    val matches = mutableListOf<Pair<Int, Point>>()
                    progress.choices = 0
                    for (window in candidates) {
                        val root = window.root ?: continue
                        try {
                            if (root.packageName?.toString() != owner) continue
                            val nodes = root.findAccessibilityNodeInfosByViewId("$owner:id/$id")
                            progress.choices = (progress.choices ?: 0) + nodes.size
                            try {
                                assertTrue("Owned permission choice must remain unambiguous", progress.choices!! <= 1)
                                for (node in nodes) {
                                    val bounds = Rect(); node.getBoundsInScreen(bounds)
                                    val windowBounds = Rect(); window.getBoundsInScreen(windowBounds)
                                    if (node.windowId == window.id && node.isEnabled && node.isClickable && node.isVisibleToUser &&
                                        !bounds.isEmpty && windowBounds.contains(bounds) && bounds.left >= 0 && bounds.top >= 0 &&
                                        bounds.right <= device.displayWidth && bounds.bottom <= device.displayHeight) {
                                        matches.add(window.id to Point(bounds.centerX(), bounds.centerY()))
                                    }
                                }
                            } finally { nodes.forEach { it.recycle() } }
                        } finally { root.recycle() }
                    }
                    assertTrue("Owned permission focused window must be unique", matches.size <= 1)
                    selected = matches.singleOrNull()
                } finally { windows.forEach { it.recycle() } }
                if (selected == null) Thread.sleep(progress.remaining(System.nanoTime()).coerceAtMost(50))
            }
            progress.ready = selected != null
            progress.permissionBefore = context.checkSelfPermission(android.Manifest.permission.CAMERA)
            assertTrue("Owned permission choice must be input-ready within its original budget", progress.admit(System.nanoTime()))
            val (windowId, point) = requireNotNull(selected)
            progress.delivered(device.click(point.x, point.y))
            assertTrue("Owned permission click delivery must succeed", progress.delivery == true)
            while (progress.remaining(System.nanoTime()) > 0) {
                progress.permissionAfter = context.checkSelfPermission(android.Manifest.permission.CAMERA)
                val windows = automation.windows
                try {
                    progress.windows = windows.size
                    assertTrue("Owned permission window inventory must stay bounded", windows.size <= 16)
                    progress.dismissed = windows.none { it.id == windowId }
                } finally { windows.forEach { it.recycle() } }
                if (progress.complete(System.nanoTime())) { progress.phase = QrPermissionPhase.COMPLETE; return }
                Thread.sleep(progress.remaining(System.nanoTime()).coerceAtMost(50))
            }
            assertTrue("Owned permission effect must settle within its original budget", progress.complete(System.nanoTime()))
        } finally {
            // Only finite metadata leaves this helper; never UI text or raw framework errors.
            try { println("lazysh camera permission: ${progress.report(System.nanoTime())}") } catch (_: Throwable) { }
        }
    }

    // Dedicated invocation with an owned emulator imagefile camera; no mocked frames or IPC.
    @Test fun ownedQrCameraRequiresPermissionAndExplicitPreview() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val frameNonce = InstrumentationRegistry.getArguments().getString("lazyshQrFrameNonce")
        require(frameNonce != null && Regex("[a-f0-9]{32}").matches(frameNonce)) { "Owned QR frame nonce required" }
        val frameEnabled = InstrumentationRegistry.getArguments().getString("lazyshQrFrameEnabled")
        require(frameEnabled == "true" || frameEnabled == "false") { "Owned QR frame budget flag required" }
        val frame = if (frameEnabled == "true") File(context.cacheDir, "lazysh-qr-frame-$frameNonce.png") else null
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
        val cancelled = "Array.from(document.querySelectorAll('.theme-qr-panel [role=status]')).some(x=>x.textContent==='QR scan stopped.')"
        val frameGate = QrFrameGate()
        val draftSelector = "[aria-label='Theme JSON or share code']"
        val draft = "manual owned QR draft stays literal"
        fun permission(id: String) = chooseOwnedCameraPermission(id)
        var primary: Throwable? = null
        var propagating = false
        try {
            var capture = observe()
            awaitDocument(scenario, "QR workspace ready", "Boolean(document.querySelector('button[aria-label=Preferences]'))")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label=Preferences]")).perform(webClick())
            preferencesCategory(scenario, "appearance")
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
            awaitDocument(scenario, "actual Rust-decoded QR preview", "document.querySelector('.theme-preview h3')?.textContent==='QR fixture'", observe = qrVideoObservation(scenario, frame))
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
            // Active capture: permission is already granted, so Scan opens the rear camera without a sheet. A frame is held
            // after it is drawn, which proves the stream is live. While the camera streams, the test's own round trips into the page
            // (evaluateJavascript through the activity, Espresso's idle wait) have stalled for the page's whole 30 s deadline and then
            // found the camera already stopped (#2427), so the held frame itself records the proof and presses Cancel in the page, and
            // the test reads the record only after the camera has stopped.
            capture = observe()
            evaluate(scenario, frameGate.install)
            button("Scan QR with camera")
            awaitDocument(scenario, "QR active capture held a frame and was cancelled", "${frameGate.held}>=1 && !($preview) && $stopped && $cancelled")
            assertEquals("The held frame must come from a live camera track", "true", evaluate(scenario, frameGate.live))
            assertEquals("A frame that was not decoded must not preview", "false", evaluate(scenario, frameGate.previewed))
            assertTrue("Active capture must open the actual rear camera", capture.openedAny())
            assertTrue("Native rear camera must be released when the active capture is cancelled", capture.released.await(5, TimeUnit.SECONDS))
            assertEquals("The cancelled request still owns the pipeline until its held frame returns", "false", evaluate(scenario, available))
            evaluate(scenario, frameGate.release)
            awaitDocument(scenario, "QR late frame retired", "$available && !($preview) && $stopped && $cancelled")
            assertEquals("A late frame from the cancelled capture must not preview", "false", evaluate(scenario, preview))
            assertEquals("Cancelled capture must preserve the manual draft", "true", evaluate(scenario,
                "document.querySelector(${JSONObject.quote(draftSelector)})?.value===${JSONObject.quote(draft)}"))
            assertTrue("Cancelled capture must not apply preferences", saved == evaluate(scenario, "localStorage.getItem('lazysh.preferences.v1')"))
            println("lazysh QR UI: active capture cancelled mid-stream; camera released; late frame ignored; draft unchanged")
        } catch (failure: Throwable) { primary = failure; propagating = true; throw failure }
        finally {
            fun cleanup(action: () -> Unit) { try { action() } catch (failure: Throwable) {
                if (primary == null) primary = failure else primary!!.addSuppressed(AssertionError("Owned QR cleanup also failed"))
            } }
            cleanup { evaluateIfPresent(scenario, frameGate.restore) }
            cleanup {
                val device = UiDevice.getInstance(instrumentation)
                cameraPermissionOwner?.let { if (device.hasObject(By.pkg(it))) device.pressBack() }
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Close Preferences']")).perform(webClick())
            }
            cleanup { observation?.let { camera.unregisterAvailabilityCallback(it) } }
            cleanup { observer.quitSafely(); observer.join(5_000); assertTrue("Camera observer must retire", !observer.isAlive) }
            if (!propagating && primary != null) throw primary!!
        }
    }

    /** One real finger tap on the centre of a page element: a WebView file chooser needs the trusted user activation a scripted click lacks. */
    private fun fingerTapElement(scenario: ActivityScenario<MainActivity>, selector: String) {
        evaluate(scenario, "(document.querySelector(${JSONObject.quote(selector)})?.scrollIntoView({block:'center'}), true)")
        awaitDocument(scenario, "touchable $selector", workspaceElementVisible(selector, true))
        val centre = JSONArray(evaluate(scenario, """
            (()=>{const r=document.querySelector(${JSONObject.quote(selector)}).getBoundingClientRect();
              return [r.left+r.width/2,r.top+r.height/2,innerWidth];})()
        """))
        onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE, CoordinatesProvider { view ->
            val origin = IntArray(2); view.getLocationOnScreen(origin)
            val scale = view.width / centre.getDouble(2)
            floatArrayOf((origin[0] + centre.getDouble(0) * scale).toFloat(), (origin[1] + centre.getDouble(1) * scale).toFloat())
        }, Press.FINGER))
    }

    // The ordinary picker branch of the QR image fallback: no capture attribute, so Wry opens the system chooser (DocumentsUI)
    // and the chosen bytes reach the page through the real result path. It needs only the emulator, so it runs with the shared cases.
    @Test fun qrImageFallbackChoosesAFileThroughTheRealSystemPicker() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val scenario = NativeActivityFixture.scenario
        val name = "lazysh-qr-${UUID.randomUUID()}.png"
        val file = ".theme-qr-panel input[type=file]"
        val saved = "localStorage.getItem('lazysh.preferences.v1')"
        val noPreview = "!document.querySelector('.theme-preview')"
        val staged = OwnedFileChooser.stage(instrumentation, "theme-qr.png", name)
        var primary: Throwable? = null
        var propagating = false
        try {
            openAppearance(scenario, "QR image fallback workspace")
            onWebView().withElement(findElement(Locator.XPATH, "//summary[normalize-space(text())='Import and share theme']")).perform(webClick())
            awaitDocument(scenario, "QR image fallback enabled", "Boolean(document.querySelector(${JSONObject.quote(file)}) && !document.querySelector(${JSONObject.quote(file)}).disabled)")
            assertEquals("No preview before a file is chosen", "true", evaluate(scenario, noPreview))
            val before = evaluate(scenario, saved)
            // Records only outcomes (byte count, error class, decode result kind) of the page's own read and decode calls, for the failure report.
            evaluate(scenario, """(()=>{const rec=window.__lazyshQrDiag=[];const read=File.prototype.arrayBuffer;
                File.prototype.arrayBuffer=function(){return read.call(this).then(b=>{rec.push('read:'+b.byteLength);return b;},e=>{rec.push('read-error:'+e.name+':'+String(e.message).slice(0,60));throw e;});};
                const internals=window.__TAURI_INTERNALS__,invoke=internals&&internals.invoke;
                if(invoke)internals.invoke=function(cmd,...rest){const p=invoke.call(this,cmd,...rest);
                  if(cmd==='theme_qr_decode')p.then(r=>rec.push('decode:'+(r===null?'none':typeof r)),e=>rec.push('decode-error:'+String(e&&e.message||e).slice(0,60)));return p;};
                return true;})()""")
            // Chromium rejects the page's read of a chosen content file with NotReadableError when the file's state changed after it was chosen
            // (44964180752, 44990852306: the picker listed only the fixture), and MediaProvider rewrites the fixture's row after the insert.
            // The user's remedy is to choose the image again, so the case does that once, and only for that error; any other failure, or a
            // second read failure, ends the case with both attempts' evidence.
            var attempt = 0
            var firstFailure: String? = null
            while (true) {
                attempt++
                fingerTapElement(scenario, file)
                OwnedFileChooser.choose(instrumentation, name)
                try {
                    awaitDocument(scenario, "preview decoded from the chosen image", "document.querySelector('.theme-preview h3')?.textContent==='QR fixture'")
                    break
                } catch (failure: Throwable) {
                    val calls = runCatching { evaluate(scenario, "JSON.stringify(window.__lazyshQrDiag||[])") }.getOrDefault("unavailable")
                    failure.addSuppressed(AssertionError("QR page calls (attempt $attempt): $calls"))
                    firstFailure?.let { failure.addSuppressed(AssertionError("First attempt: $it")) }
                    if (attempt >= 2 || !calls.contains("read-error:NotReadableError")) throw failure
                    firstFailure = "${failure.message}; calls $calls"
                    println("lazysh QR UI: the page's read of the chosen image failed once ($calls); choosing it again")
                    evaluate(scenario, "(window.__lazyshQrDiag.length=0, true)")
                }
            }
            assertEquals("A chosen image must not apply itself", before, evaluate(scenario, saved))
            webButton("Cancel preview")
            awaitDocument(scenario, "chosen-image preview discarded", noPreview)
            assertEquals("Discarding the preview must not apply preferences", before, evaluate(scenario, saved))
            println("lazysh QR UI: real system picker chose the owned image; preview shown, not applied")
        } catch (failure: Throwable) { primary = failure; propagating = true; throw failure }
        finally {
            fun cleanup(action: () -> Unit) { try { action() } catch (failure: Throwable) {
                if (primary == null) primary = failure else primary!!.addSuppressed(failure)
            } }
            // A picker still open would hide the app from every later case.
            cleanup { OwnedFileChooser.dismiss(instrumentation) }
            cleanup { closePreferences() }
            cleanup { OwnedFileChooser.unstage(instrumentation, staged) }
            if (!propagating && primary != null) throw primary!!
        }
    }

    private fun workspaceElementVisible(selector: String, touchable: Boolean = false) = """
        (()=>{const element=document.querySelector(${JSONObject.quote(selector)});
          if(!element || !element.getClientRects().length || getComputedStyle(element).visibility==='hidden')return false;
          const bounds=element.getBoundingClientRect();
          if(bounds.width<=0 || bounds.height<=0 || bounds.right<=0 || bounds.bottom<=0 || bounds.left>=innerWidth || bounds.top>=innerHeight)return false;
          if(!$touchable)return true;
          const hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
          return bounds.left>=0 && bounds.top>=0 && bounds.right<=innerWidth && bounds.bottom<=innerHeight && Boolean(hit && element.contains(hit));})()
    """

    private fun workspaceButtonVisible(scope: String, text: String) = """
        (()=>{const buttons=Array.from(document.querySelectorAll(${JSONObject.quote("$scope button")}))
          .filter(element=>element.textContent.trim()===${JSONObject.quote(text)});
          if(buttons.length!==1)return false;
          const button=buttons[0],bounds=button.getBoundingClientRect();
          return bounds.width>0 && bounds.height>0 && bounds.left>=0 && bounds.top>=0 &&
            bounds.right<=innerWidth && bounds.bottom<=innerHeight &&
            document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2)?.closest('button')===button;})()
    """

    /** One real finger swipe across the Workspace tools carousel, towards the next or previous page. */
    private fun swipeWorkspaceToolPages(scenario: ActivityScenario<MainActivity>, menu: String, forward: Boolean) {
        val geometry = JSONArray(evaluate(scenario, """
            (()=>{const r=document.querySelector(${JSONObject.quote("$menu .workspace-tools-track")}).getBoundingClientRect();
              return [r.left,r.width,r.top+Math.min(r.height/2,60),innerWidth];})()
        """))
        val (from, to) = if (forward) 0.85 to 0.15 else 0.15 to 0.85
        fun point(fraction: Double) = CoordinatesProvider { view ->
            val origin = IntArray(2); view.getLocationOnScreen(origin)
            val scale = view.width / geometry.getDouble(3)
            floatArrayOf((origin[0] + (geometry.getDouble(0) + geometry.getDouble(1) * fraction) * scale).toFloat(),
                (origin[1] + geometry.getDouble(2) * scale).toFloat())
        }
        onView(isAssignableFrom(WebView::class.java)).perform(GeneralSwipeAction(Swipe.SLOW, point(from), point(to), Press.FINGER))
    }

    private val workspaceToolsDialog = "[role=dialog][aria-label='Workspace tools']"

    /** A phone-width connected workspace, like a wide one, keeps Preferences in its tools menu. */
    private fun openPreferences(scenario: ActivityScenario<MainActivity>) {
        if (evaluate(scenario, workspaceElementVisible("button[aria-label='Preferences']")) == "true")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Preferences']")).perform(webClick())
        else workspaceMenuAction(scenario, "Preferences")
    }

    /** An open hosts drawer makes the workspace inert, and an earlier case on the shared activity can leave it open. */
    private fun closeHostsDrawer(scenario: ActivityScenario<MainActivity>, stage: String) {
        val closeHosts = ".workspace-destination-heading button[aria-label='Return to terminal'], .sidebar > .brand:not([hidden]) button[aria-label='Close hosts']"
        if (evaluate(scenario, workspaceElementVisible(closeHosts)) == "true") {
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, closeHosts)).perform(webClick())
            awaitDocument(scenario, stage, "!" + workspaceElementVisible(closeHosts))
        }
    }

    private fun openWorkspaceTools(scenario: ActivityScenario<MainActivity>, deadline: Long) {
        keepTopBar(scenario)
        if (evaluate(scenario, workspaceElementVisible(workspaceToolsDialog)) != "true") {
            awaitDocument(scenario, "visible workspace More", workspaceElementVisible("button.mobile-tools"), deadline = deadline)
            val trigger = onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button.mobile-tools"))
            trigger.perform(webScrollIntoView())
            awaitDocument(scenario, "touchable workspace More", workspaceElementVisible("button.mobile-tools", true), deadline = deadline, observe = { remaining ->
                evaluate(scenario, """
                    (()=>{const bounds=document.querySelector('button.mobile-tools').getBoundingClientRect(),hit=document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2);
                      return JSON.stringify({bounds:[bounds.left,bounds.top,bounds.right,bounds.bottom],viewport:[innerWidth,innerHeight],
                        hit:hit&&(hit.tagName+'.'+hit.className+'['+(hit.getAttribute('aria-label')||'')+']'),inert:document.querySelector('main.workspace')?.inert});})()
                """, remaining)
            })
            trigger.perform(webClick())
        }
        awaitDocument(scenario, "workspace More opened", workspaceElementVisible(workspaceToolsDialog), deadline = deadline)
    }

    private fun workspaceMenuAction(scenario: ActivityScenario<MainActivity>, text: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        val menu = workspaceToolsDialog
        openWorkspaceTools(scenario, deadline)
        // Tool groups are carousel pages: turn them with a real finger swipe until the action's page is shown.
        val pageOffset = """
            (()=>{const target=Array.from(document.querySelectorAll(${JSONObject.quote("$menu .workspace-tools-page button")}))
              .find(button=>button.textContent.trim()===${JSONObject.quote(text)});
              const page=target?.closest('.workspace-tools-page');
              if(!page)return 0;
              const pages=Array.from(page.parentElement.children),shown=pages.findIndex(node=>!node.inert);
              return pages.indexOf(page)-shown;})()
        """
        val settled = """
            (()=>{const page=Array.from(document.querySelectorAll(${JSONObject.quote("$menu .workspace-tools-page")})).find(node=>!node.inert);
              return Boolean(page) && Math.abs(page.getBoundingClientRect().left-page.parentElement.getBoundingClientRect().left)<2;})()
        """
        val geometry = """
            (()=>{const track=document.querySelector(${JSONObject.quote("$menu .workspace-tools-track")});
              const page=Array.from(track?.children??[]).find(node=>!node.inert);
              if(!track||!page)return null;
              const {left:trackLeft,width:trackWidth}=track.getBoundingClientRect();
              const {left:pageLeft,width:pageWidth}=page.getBoundingClientRect();
              return {index:Array.from(track.children).indexOf(page),scrollLeft:track.scrollLeft,
                clientWidth:track.clientWidth,scrollWidth:track.scrollWidth,trackLeft,trackWidth,pageLeft,pageWidth};})()
        """
        // The dots and the shown tabpanel's label must follow every swipe in the real WebView.
        val indicated = """
            (()=>{const carousel=document.querySelector(${JSONObject.quote("$menu .workspace-tools-carousel")});
              const pages=Array.from(carousel?.querySelectorAll('.workspace-tools-page')??[]),shown=pages.findIndex(node=>!node.inert);
              const tabs=Array.from(carousel?.querySelectorAll('[role=tab]')??[]),page=pages[shown];
              if(!page||carousel.getAttribute('aria-roledescription')!=='carousel')return false;
              if(pages.length<2)return page.getAttribute('aria-roledescription')==='page';
              const tab=tabs.find(node=>node.getAttribute('aria-controls')===page.id);
              return tabs.length===pages.length&&page.getAttribute('role')==='tabpanel'&&page.getAttribute('aria-roledescription')==='page'
                &&tabs.every(node=>node.getAttribute('aria-selected')===String(node===tab))
                &&page.getAttribute('aria-label')===tab.getAttribute('aria-label')+', '+(shown+1)+' of '+pages.length
                &&pages.every(node=>node===page||node.getAttribute('aria-hidden')==='true');})()
        """
        for (attempt in 0 until 4) {
            awaitDocument(scenario, "workspace tools page settled", "$settled && $indicated", deadline = deadline)
            val offset = evaluate(scenario, pageOffset).toInt()
            if (offset == 0) break
            swipeWorkspaceToolPages(scenario, menu, offset > 0)
            val remaining = if (offset > 0) offset - 1 else offset + 1
            awaitDocument(scenario, "workspace tools page swiped", "$pageOffset===$remaining && $settled && $indicated", deadline = deadline,
                observe = { timeout ->
                    val value = evaluateIfPresent(scenario, "[$pageOffset,$settled,$indicated,$geometry]", timeout)
                    val parts = JSONArray(value)
                    val observedOffset = parts.getInt(0).coerceIn(-4, 4)
                    "offset=$observedOffset; expected=$remaining; settled=${parts.getBoolean(1)}; indicated=${parts.getBoolean(2)}; geometry=${parts.optJSONObject(3)}"
                })
        }
        val target = onWebView().withElement(findElement(Locator.XPATH,
            "//*[@role='dialog' and @aria-label='Workspace tools']//button[normalize-space(.)='$text']"))
        target.perform(webScrollIntoView())
        awaitDocument(scenario, "visible workspace menu action", workspaceButtonVisible(menu, text), deadline = deadline)
        target.perform(webClick())
        awaitDocument(scenario, "workspace More action dismissed", "!Boolean(document.querySelector(${JSONObject.quote(menu)}))", deadline = deadline)
    }

    private fun present(selector: String) = "Boolean(document.querySelector(${JSONObject.quote(selector)}))"

    private fun selectOwnedConnection(scenario: ActivityScenario<MainActivity>, name: String, requireMosh: Boolean = false) {
        val switcher = "[role=dialog][aria-label='Switch terminal session']"
        keepTopBar(scenario)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button.session-switcher-trigger")).perform(webClick())
        awaitDocument(scenario, "exact owned session choice", """
            (()=>{const choices=Array.from(document.querySelectorAll("$switcher .session-choice"));
              return choices.filter(choice=>choice.querySelector('.session-choice-name')?.textContent===${JSONObject.quote(name)}).length===1;})()
        """)
        val choice = onWebView().withElement(findElement(Locator.XPATH,
            "//*[@role='dialog' and @aria-label='Switch terminal session']//button[span[@class='session-choice-name' and text()='$name']]"))
        choice.perform(webScrollIntoView())
        choice.perform(webClick())
        awaitDocument(scenario, "exact owned session selected before End", """
            (()=>{const selected=document.querySelectorAll('.session-tabs [role=tab][aria-selected=true]');
              return !document.querySelector("$switcher") && selected.length===1 &&
                selected[0].textContent.trim()===${JSONObject.quote(name)} &&
                document.querySelector('.session-switcher-trigger')?.textContent===${JSONObject.quote(name)} &&
                document.querySelectorAll(${JSONObject.quote("button[aria-label='Disconnect $name']")}).length===1 &&
                ${if (requireMosh) "document.querySelector('.workspace-footer')?.textContent.includes('Mosh')" else "true"};})()
        """)
    }

    private fun endOwnedConnection(scenario: ActivityScenario<MainActivity>, name: String, requireMosh: Boolean = false) {
        closeHostsDrawer(scenario, "hosts closed before owned disconnect")
        val disconnect = "button[aria-label='Disconnect $name']"
        if (evaluate(scenario, workspaceElementVisible("button.mobile-tools", true)) == "true") {
            selectOwnedConnection(scenario, name, requireMosh)
            workspaceMenuAction(scenario, "End $name connection")
        } else if (evaluate(scenario, workspaceElementVisible(disconnect)) == "true") {
            val close = onWebView().withElement(findElement(Locator.CSS_SELECTOR, disconnect))
            close.perform(webScrollIntoView())
            awaitDocument(scenario, "touchable exact session disconnect", workspaceElementVisible(disconnect, true))
            close.perform(webClick())
        } else {
            workspaceMenuAction(scenario, "End $name connection")
        }
        awaitDocument(scenario, "exact owned connection ended", "!" + present(disconnect))
    }

    private fun sessionView(scenario: ActivityScenario<MainActivity>, text: String) {
        val menuVisible = evaluate(scenario, workspaceElementVisible(".mobile-session-views")) == "true"
        if (menuVisible || evaluate(scenario, workspaceElementVisible(".view-tabs")) != "true") {
            workspaceMenuAction(scenario, text)
            return
        }
        val target = onWebView().withElement(findElement(Locator.XPATH,
            "//nav[contains(@class,'view-tabs')]/button[span[normalize-space(text())='$text']]"))
        target.perform(webScrollIntoView())
        awaitDocument(scenario, "visible session view", workspaceButtonVisible(".view-tabs", text))
        target.perform(webClick())
    }

    // Called only from the real, authenticated owned-SSH UI flow below. Native
    // Window reads observe the shipping plugin; no test fixture changes its flag.
    private fun verifyBoardKeepAwake(scenario: ActivityScenario<MainActivity>, herdr: JSONObject? = null) {
        val checkbox = ".keep-awake-control input[type=checkbox]"
        val active = "This board owns an acknowledged idle-inhibition request."
        val off = "Keep awake is off."
        val paused = "Keep awake is paused until this board is visible and focused."
        var observedActivity: MainActivity? = null
        fun flag(): Boolean {
            var enabled = false
            scenario.onActivity { activity ->
                observedActivity = activity
                enabled = activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0
            }
            return enabled
        }
        fun awaitFlag(expected: Boolean, stage: String) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (flag() != expected) {
                assertTrue("Native display flag did not settle at $stage", System.nanoTime() < deadline)
                Thread.sleep(25)
            }
        }
        fun navigation(name: String) {
            onWebView().withElement(findElement(Locator.XPATH,
                "//nav[contains(@class,'workspace-navigation-modes')]/button[normalize-space(.)='$name']"))
                .perform(webScrollIntoView()).perform(webClick())
        }
        fun toggle() {
            onWebView().withElement(findElement(Locator.CSS_SELECTOR,
                ".agent-section-jumps:not([hidden]) button[aria-label='Reported agent activity']"))
                .perform(webScrollIntoView()).perform(webClick())
            val setup = ".agent-panel:not([hidden]) > .tool-bar button[aria-expanded]"
            val expanded = evaluate(scenario, """
                (()=>{const buttons=document.querySelectorAll(${JSONObject.quote(setup)});
                  if(buttons.length!==1)return null;
                  const state=buttons[0].getAttribute('aria-expanded');
                  return state==='true'?true:state==='false'?false:null;})()
            """)
            assertTrue("One current board Setup disclosure is required", expanded == "true" || expanded == "false")
            if (expanded == "false") {
                val button = onWebView().withElement(findElement(Locator.CSS_SELECTOR, setup))
                button.perform(webScrollIntoView())
                assertEquals("Current board Setup must be hit-testable", "true", evaluate(scenario,
                    workspaceButtonVisible(".agent-panel:not([hidden]) > .tool-bar", "Setup")))
                button.perform(webClick())
            }
            val control = onWebView().withElement(findElement(Locator.CSS_SELECTOR, checkbox))
            control.perform(webScrollIntoView())
            assertEquals("Current keep-awake checkbox must be hit-testable", "true", evaluate(scenario,
                workspaceElementVisible(checkbox, true)))
            control.perform(webClick())
        }
        fun status(text: String) = "Array.from(document.querySelectorAll('.keep-awake-control [role=status]')).some(x=>x.textContent===${JSONObject.quote(text)})"
        fun awaitActive(stage: String) {
            awaitDocument(scenario, stage, "document.querySelector('$checkbox:not(:disabled)')?.checked===true && ${status(active)}")
            awaitFlag(true, stage)
        }
        val liveHerdr = herdr?.let {
            val agent = it.getJSONObject("agent")
            val server = it.getString("name")
            val workspace = agent.getString("workspaceId")
            val tab = agent.getString("tabId")
            val pane = agent.getString("paneId")
            val terminal = agent.getString("terminalId")
            require(Regex("[a-zA-Z0-9._-]{1,64}").matches(server) &&
                Regex("w[0-9]+").matches(workspace) && workspace.length <= 50 &&
                Regex("${Regex.escape(workspace)}:t[0-9]+").matches(tab) && tab.length <= 50 &&
                Regex("${Regex.escape(workspace)}:p[0-9]+").matches(pane) && pane.length <= 50 &&
                terminal.length in 1..256 && terminal.none { c -> c.isISOControl() }) { "Owned Herdr report identity required" }
            // Pane/terminal membership and this label/cwd context come from the
            // same real host snapshot. Shipping navigation intentionally exposes labels, not IDs.
            val context = it.getString("agentContext")
            require(context.length in 1..4096 && context.none { c -> c.isISOControl() })
            val navigationOracle = InstrumentationRegistry.getInstrumentation().context.assets
                .open("owned-visible-herdr.js").use { it.readNBytes(4097) }
                .also { require(it.size <= 4096) { "Herdr navigation oracle bound" } }.toString(Charsets.UTF_8)
            """(()=>{
              $navigationOracle
              return ownedLiveHerdrNavigation(document,${JSONObject.quote(server)},${JSONObject.quote(context)}) &&
                Array.from(document.querySelectorAll('.agent-panel .panel-empty h3')).some(x=>x.textContent==='No agent events yet.') &&
                !document.querySelector('.agent-panel .agent-board .agent-card');
            })()"""
        } ?: "true"
        var primaryFailure: Throwable? = null
        try {
            awaitFlag(false, "connected terminal before opt-in")
            sessionView(scenario, "Agents")
            val boardDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
            val keepAwakeReady = "Boolean(document.querySelector('$checkbox:not(:disabled)')) && document.querySelector('$checkbox').checked===false && ${status(off)}"
            awaitDocument(scenario, "board keep-awake off and owned live Herdr navigation",
                "($keepAwakeReady) && ($liveHerdr)", deadline = boardDeadline, observe = { remaining ->
                    evaluateIfPresent(scenario, "JSON.stringify({keepAwakeReady:Boolean($keepAwakeReady),liveHerdrReady:Boolean($liveHerdr)})", remaining) ?: "unavailable"
                })
            if (herdr != null) {
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".herdr-navigation:not([hidden]) .herdr-navigation-row"))
                    .perform(webScrollIntoView())
                val viewportOracle = InstrumentationRegistry.getInstrumentation().context.assets
                    .open("owned-keyboard-viewport.js").use { it.readNBytes(2049) }
                    .also { require(it.size <= 2048) { "Viewport oracle bound" } }.toString(Charsets.UTF_8)
                val visualObservation = """
                    (()=>{try {
                      const cards=document.querySelectorAll('.herdr-navigation:not([hidden]) .herdr-navigation-row'), card=cards[0];
                      const group=card?.closest('section[aria-label]');
                      const labels=[card?.querySelector('strong'),group?.getAttribute('aria-label')===card?.querySelector(':scope > small')?.textContent?group?.querySelector(':scope > h4'):null,card?.querySelector('span > small')];
                      const bounded=value=>Number.isFinite(value)?Math.max(-65535,Math.min(65535,value)):null;
                      const box=rect=>rect?[rect.left,rect.top,rect.right,rect.bottom].map(bounded):null;
                      const viewport=window.visualViewport;
                      const kind=(hit,label)=>!hit?'none':hit===label?'label':label.contains(hit)?'label-descendant':hit===card?'card':card.contains(hit)?'card-descendant':'other';
                      const observed=labels.map(label=>{
                        if(!label)return {present:false,rect:null,glyphs:0,truncated:false,failedRect:null,hit:'none'};
                        const range=document.createRange();range.selectNodeContents(label);
                        const rectangles=Array.from(range.getClientRects()), failed=rectangles.slice(0,64).find(rect=>{
                          const hit=document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);
                          return hit!==label&&!label.contains(hit);
                        });
                        const hit=failed?document.elementFromPoint((failed.left+failed.right)/2,(failed.top+failed.bottom)/2):label;
                        return {present:true,rect:box(range.getBoundingClientRect()),glyphs:Math.min(64,rectangles.length),
                          truncated:rectangles.length>64,failedRect:box(failed),hit:kind(hit,label)};
                      });
                      $viewportOracle
                      return {state:'observed',liveReady:Boolean($liveHerdr),cards:Math.min(8,cards.length),
                        cardShown:!!card?.getClientRects().length,cardRect:box(card?.getBoundingClientRect()),
                        viewport:viewport?[viewport.offsetLeft,viewport.offsetTop,viewport.width,viewport.height,viewport.scale].map(bounded):null,
                        viewportReady:!!card&&observed.every(label=>label.present)&&ownedKeyboardViewportContains(viewport,
                          [card.getBoundingClientRect(),...labels.map(label=>{const range=document.createRange();range.selectNodeContents(label);return range.getBoundingClientRect();})]),
                        blockers:Math.min(8,Array.from(document.querySelectorAll('[role=dialog], main[inert]')).filter(node=>node.getClientRects().length>0).length),
                        labels:observed};
                    } catch {return {state:'unavailable'};}})()
                """.trimIndent()
                awaitDocument(scenario, "owned live Herdr report visually ready over empty companion reports", """
                    (()=>{
                      if(!($liveHerdr)) return false;
                      const card=document.querySelector('.herdr-navigation:not([hidden]) .herdr-navigation-row');
                      const group=card?.closest('section[aria-label]');
                      const labels=[card?.querySelector('strong'),group?.getAttribute('aria-label')===card?.querySelector(':scope > small')?.textContent?group?.querySelector(':scope > h4'):null,card?.querySelector('span > small')];
                      if(!card || labels.some(label=>!label)) return false;
                      const ranges=labels.map(label=>{
                        const range=document.createRange(); range.selectNodeContents(label); return range;
                      });
                      $viewportOracle
                      return ownedKeyboardViewportContains(window.visualViewport,
                        [card.getBoundingClientRect(),...ranges.map(range=>range.getBoundingClientRect())]) &&
                        ranges.every((range,index)=>Array.from(range.getClientRects()).every(r=>{
                          const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
                          return hit===labels[index] || labels[index].contains(hit);
                        }));
                    })()
                """, deadline = boardDeadline, observe = { remaining ->
                    runCatching { evaluate(scenario, visualObservation, remaining) }.getOrDefault("unavailable")
                })
                assertTrue("Owned live Herdr visual admission exceeded the original board deadline", System.nanoTime() < boardDeadline)
                println("lazysh live Herdr navigation: owned Codex row visible with exact server and host-readback context over empty companion reports")
            }
            assertEquals("A fresh owned fixture must not have opted in", "true", evaluate(scenario,
                "localStorage.getItem('lazysh.agent-board.keep-awake.v1')!=='true'"))
            awaitFlag(false, "board default off")
            toggle()
            awaitActive("explicit board opt-in")
            toggle()
            awaitDocument(scenario, "explicit board disable", status(off))
            awaitFlag(false, "explicit board disable")
            toggle()
            awaitActive("second explicit board opt-in")
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            awaitFlag(false, "actual Activity background")
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
            awaitActive("actual Activity foreground")
            navigation("Connections")
            awaitDocument(scenario, "persistent board mounted but hidden",
                "document.querySelectorAll('.keep-awake-control').length===1 && " +
                    "document.querySelector('.workspace-navigation-agents')?.hidden===true && " +
                    "document.querySelector('.keep-awake-control')?.hidden===true && " +
                    "document.querySelector('$checkbox:disabled')?.checked===true && ${status(paused)}")
            assertEquals("Hidden board must preserve explicit opt-in", "true", evaluate(scenario,
                "localStorage.getItem('lazysh.agent-board.keep-awake.v1')==='true'"))
            awaitFlag(false, "persistent board hidden")
            navigation("Agents")
            awaitDocument(scenario, "persistent board revealed",
                "document.querySelector('.workspace-navigation-agents')?.hidden===false && " +
                    "document.querySelector('.keep-awake-control')?.hidden===false")
            awaitActive("persisted opt-in on board reveal")
            toggle()
            awaitDocument(scenario, "final explicit board off", status(off))
            awaitFlag(false, "final explicit board off")
            assertEquals("Owned board preference must finish off", "true", evaluate(scenario,
                "localStorage.getItem('lazysh.agent-board.keep-awake.v1')==='false'"))
            println("lazysh board keep-awake: packaged opt-in/off, background/foreground and persistent board hide/reveal verified against actual Window flag")
        } catch (failure: Throwable) {
            primaryFailure = failure
            runCatching { failure.addSuppressed(AssertionError("Board readiness after failure: ${BoardReadinessObservation.collect(observedActivity, ::webView)}")) }
            throw failure
        } finally {
            try {
                if (scenario.state != androidx.lifecycle.Lifecycle.State.RESUMED)
                    scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                if (evaluate(scenario, "document.querySelector('$checkbox')?.checked===true") == "true") {
                    navigation("Agents")
                    toggle()
                }
                navigation("Connections")
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".sidebar-close")).perform(webClick())
                awaitFlag(false, "owned board cleanup")
            } catch (cleanup: Throwable) {
                if (primaryFailure != null) primaryFailure.addSuppressed(AssertionError("Owned board keep-awake cleanup also failed"))
                else throw cleanup
            }
        }
    }

    private fun swipeViewClearOfIme(visible: Boolean?, bottom: Int?, top: Int, height: Int, rootHeight: Int): Boolean {
        val end = top.toLong() + height
        if (top < 0 || height <= 0 || rootHeight <= 0 || end > rootHeight) return false
        return when (visible) {
            false -> true
            true -> bottom != null && bottom > 0 && end <= rootHeight.toLong() - bottom
            null -> false
        }
    }

    @Test fun ownedFingerWindowObservationPreservesDispatchAndExactRestoration() {
        NativeActivityFixture.scenario.onActivity { activity ->
            val window = activity.window
            val original = checkNotNull(window.callback)
            val epoch = android.os.SystemClock.uptimeMillis()
            val event = android.view.MotionEvent.obtain(epoch, epoch + 1, android.view.MotionEvent.ACTION_MOVE, 10f, 20f, 0)
            var calls = 0
            var expected = event
            var handled = false
            var failure: Throwable? = null
            val sentinel = AssertionError("private delegate failure")
            val delegate = object : android.view.Window.Callback by original {
                override fun dispatchTouchEvent(received: android.view.MotionEvent): Boolean {
                    calls++; assertSame(expected, received)
                    failure?.let { throw it }
                    return handled
                }
            }
            val observer = OwnedFingerWindowObserver(delegate, epoch) { epoch + 2 }
            try {
                assertFalse(observer.dispatchTouchEvent(event)); assertEquals(1, calls)
                handled = true
                assertTrue(observer.dispatchTouchEvent(event)); assertEquals(2, calls)
                failure = sentinel
                assertSame(sentinel, runCatching { observer.dispatchTouchEvent(event) }.exceptionOrNull())
                assertEquals(3, calls)
                failure = null
                repeat(8) { observer.dispatchTouchEvent(event) }
                val trace = JSONObject(observer.snapshot())
                assertEquals(6, trace.getJSONArray("events").length()); assertTrue(trace.getBoolean("overflow"))
                assertEquals("unhandled", trace.getJSONArray("events").getJSONObject(0).getString("outcome"))
                assertEquals("handled", trace.getJSONArray("events").getJSONObject(1).getString("outcome"))
                assertEquals("threw", trace.getJSONArray("events").getJSONObject(2).getString("outcome"))
                assertFalse(trace.toString().contains("private"))
                val summary=JSONObject(observer.failureSummary())
                assertEquals(setOf("state","overflow","eventCount","events"),summary.keys().asSequence().toSet())
                assertEquals(6,summary.getInt("eventCount"));assertTrue(summary.getBoolean("overflow"))
                val first=summary.getJSONArray("events").getJSONObject(0)
                assertEquals(setOf("action","outcome","pointerMatches","finger","touchscreen","eventAtMs","dispatchAtMs","returnedAtMs"),first.keys().asSequence().toSet())
                assertEquals("move",first.getString("action"));assertEquals("unhandled",first.getString("outcome"))
                assertEquals(1,first.getInt("eventAtMs"));assertEquals(2,first.getInt("dispatchAtMs"));assertEquals(2,first.getInt("returnedAtMs"))
                assertFalse(summary.toString().contains("\"point\""));assertFalse(summary.toString().contains("private"))
                for((offset,expectedTime) in listOf(-5L to 0,99_999L to 65_535)) {
                    val clamped=OwnedFingerWindowObserver(delegate,epoch) { epoch+offset }
                    clamped.dispatchTouchEvent(event)
                    val row=JSONObject(clamped.failureSummary()).getJSONArray("events").getJSONObject(0)
                    assertEquals(expectedTime,row.getInt("dispatchAtMs"));assertEquals(expectedTime,row.getInt("returnedAtMs"))
                }
                val vertical = OwnedFingerWindowObserver(delegate, epoch) { epoch + 2 }
                val down = android.view.MotionEvent.obtain(epoch, epoch, android.view.MotionEvent.ACTION_DOWN, 10f, 200f, 0)
                val move = android.view.MotionEvent.obtain(epoch, epoch + 1, android.view.MotionEvent.ACTION_MOVE, 10f, 175f, 0)
                try {
                    expected = down; vertical.dispatchTouchEvent(down)
                    expected = move; vertical.dispatchTouchEvent(move)
                    val movement = JSONObject(vertical.verticalFailureSummary())
                    assertEquals("observed", movement.getString("state"))
                    val rows = movement.getJSONArray("events")
                    assertEquals(0.0, rows.getJSONObject(0).getDouble("rawYFromDown"), 0.0)
                    assertEquals(-25.0, rows.getJSONObject(1).getDouble("rawYFromDown"), 0.0)
                    assertFalse(movement.toString().contains("200")); assertFalse(movement.toString().contains("point"))
                    assertEquals("unavailable", JSONObject(observer.verticalFailureSummary()).getString("state"))
                } finally { down.recycle(); move.recycle(); expected = event }
                val unavailable = OwnedFingerWindowObserver(delegate, epoch) { throw IllegalStateException("private observation failure") }
                handled = false
                assertFalse(unavailable.dispatchTouchEvent(event))
                failure = sentinel
                assertSame(sentinel, runCatching { unavailable.dispatchTouchEvent(event) }.exceptionOrNull())
                assertEquals("unavailable", JSONObject(unavailable.snapshot()).getString("state"))
                val unavailableSummary=unavailable.failureSummary()
                assertEquals("unavailable",JSONObject(unavailableSummary).getString("state"))
                assertFalse(unavailableSummary.contains("private"));assertFalse(unavailableSummary.contains("\"point\""))
                assertSame(JSONObject.NULL, OwnedFingerWindowObserver.coordinate(Float.NaN))
                assertSame(JSONObject.NULL, OwnedFingerWindowObserver.coordinate(Float.POSITIVE_INFINITY))
                assertEquals(65_535.0, OwnedFingerWindowObserver.coordinate(Float.MAX_VALUE))
                failure = null
                val foreign = android.view.MotionEvent.obtain(epoch + 10, epoch + 11, android.view.MotionEvent.ACTION_MOVE, 10f, 20f, 0)
                try {
                    expected = foreign
                    val filtered = OwnedFingerWindowObserver(delegate, epoch) { epoch + 2 }
                    val before = calls
                    assertFalse(filtered.dispatchTouchEvent(foreign)); assertEquals(before + 1, calls)
                    assertEquals(0, JSONObject(filtered.snapshot()).getJSONArray("events").length())
                } finally { foreign.recycle(); expected = event }
                window.callback = delegate
                window.callback = observer
                observer.restore(window); assertSame(delegate, window.callback)
                window.callback = observer
                window.callback = original
                assertTrue(runCatching { observer.restore(window) }.isFailure)
                assertSame(original, window.callback)
            } finally {
                if (window.callback === observer || window.callback === delegate) window.callback = original
                event.recycle()
            }
        }
    }

    @Test fun nativeSwipeAdmissionRequiresTheWholeWebViewAboveTheDockedIme() {
        assertTrue(swipeViewClearOfIme(false, 0, 10, 190, 200))
        assertTrue(swipeViewClearOfIme(true, 100, 10, 90, 200))
        assertFalse(swipeViewClearOfIme(true, 100, 10, 91, 200))
        assertFalse(swipeViewClearOfIme(null, null, 10, 90, 200))
        assertFalse(swipeViewClearOfIme(true, null, 10, 90, 200))
        assertFalse(swipeViewClearOfIme(true, 0, 10, 90, 200))
        assertFalse(swipeViewClearOfIme(false, 0, -1, 90, 200))
        assertFalse(swipeViewClearOfIme(false, 0, 10, 0, 200))
        assertFalse(swipeViewClearOfIme(false, 0, 10, 191, 200))
        assertFalse(swipeViewClearOfIme(false, 0, Int.MAX_VALUE, Int.MAX_VALUE, Int.MAX_VALUE))
    }

    private fun herdrConfirmationObservation(scenario: ActivityScenario<MainActivity>, expectedChild: String, expectedDraft: String): (Long) -> String {
        val expression = """
            (()=>{
              const expectedChild=${JSONObject.quote(expectedChild)},expectedDraft=${JSONObject.quote(expectedDraft)};
              const regions=Array.from(document.querySelectorAll("section[aria-label='Terminal input']"));
              const buttons=regions.flatMap(region=>Array.from(region.querySelectorAll('button')));
              const choose=buttons.filter(button=>button.textContent.trim()==='Choose terminal destination');
              const confirm=buttons.filter(button=>button.textContent.trim()==='Confirm this destination');
              const send=buttons.filter(button=>button.textContent.trim()==='Send to terminal');
              const alerts=regions.flatMap(region=>Array.from(region.querySelectorAll('[role=alert]')));
              const categories=new Map([
                ['Guarded input is unavailable for this Herdr terminal. Use Stage or open the terminal.','unavailable'],
                ['The terminal destination changed. Confirm it again.','stale'],
                ['This source or input is unsupported. Use Stage or the terminal.','invalid'],
                ['Send accepts up to 4,096 UTF-8 bytes, including line feeds and tabs. Other control characters are unsupported. Use Stage or the terminal for other drafts.','invalid'],
                ['Another terminal input is in progress. Confirm the destination again before trying.','busy'],
                ['The terminal returned an unsupported destination or input response. Choose the destination again.','invalidReply'],
                ['Queue admission was not confirmed. Input may have arrived and was not resent. Inspect the terminal before confirming again.','uncertain']
              ]);
              const footer=document.querySelector('.workspace-footer > span:last-child');
              return {
                regions:Math.min(8,regions.length),choose:Math.min(8,choose.length),confirm:Math.min(8,confirm.length),send:Math.min(8,send.length),
                chooseDisabled:choose.length>0&&choose.every(button=>button.disabled===true),
                pending:regions.some(region=>Array.from(region.querySelectorAll('[role=status]')).some(node=>node.textContent==='Waiting for the terminal response…')),
                errorPresent:alerts.length>0,error:alerts.length===0?'none':alerts.length===1?(categories.get(alerts[0].textContent)||'other'):'other',
                ownedChildDisconnected:Array.from(document.querySelectorAll('.session-tabs [role=tab]')).some(tab=>tab.textContent.trim()===expectedChild&&Boolean(tab.querySelector('.status-idle'))),
                moshFooter:Boolean(footer&&Array.from(footer.childNodes).some(node=>node.nodeType===3&&node.textContent.trim()==='Mosh')),
                draftMatches:document.querySelector('form.chat-composer textarea')?.value===expectedDraft
              };
            })()
        """
        return { remaining -> evaluateIfPresent(scenario, expression, remaining) ?: "unavailable" }
    }

    private fun verifyMoshResize(scenario: ActivityScenario<MainActivity>, name: String, nonce: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val device = UiDevice.getInstance(instrumentation)
        fun imeSettings() = listOf("default_input_method", "enabled_input_methods").map { key ->
            device.executeShellCommand("settings get secure $key").trim().also { require(it.length <= 4096) }
        }
        val originalIme = imeSettings()
        require(originalIme[0] in listOf("com.android.inputmethod.latin/.LatinIME", "com.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME")) {
            "Mosh resize requires the admitted ordinary AOSP keyboard"
        }
        val asset = instrumentation.context.assets.open("owned-mosh-history.js").use { it.readNBytes(4097) }
            .also { require(it.size <= 4096) { "Mosh history oracle bound" } }.toString(Charsets.UTF_8)
        lateinit var activity: MainActivity
        lateinit var web: WebView
        scenario.onActivity { activity = it; web = checkNotNull(webView(it.window.decorView)) }
        val window = activity.window
        val decor = window.decorView
        val orientation = activity.requestedOrientation
        val configuration = activity.resources.configuration.orientation
        require(configuration == Configuration.ORIENTATION_PORTRAIT) { "Owned Mosh resize starts in portrait" }
        val key = JSONObject.quote("__lazyshOwnedMoshResize_$nonce")
        val selector = JSONObject.quote(".terminal-canvas[aria-label='Terminal for $name']")
        var installed = false
        var primary: Throwable? = null
        var history = -1
        val observation = """
            (()=>{
              $asset
              const saved=window[$key],pane=document.querySelector($selector),tab=document.querySelector('[role=tab][aria-selected=true]');
              const owned=Boolean(saved&&saved.document===document&&saved.pane===pane&&saved.tab===tab&&
                saved.root===pane.querySelector('.xterm')&&!tab.querySelector('.status-idle')&&pane.getClientRects().length>0);
              const root=owned?saved.root:null;
              const result=ownedMoshHistory(root),rows=owned?Array.from(root.querySelectorAll('.xterm-rows > div')):[];
              const cursor=rows.findIndex(row=>row.querySelector('.xterm-cursor'));
              const editor=owned?root.querySelector('.xterm-helper-textarea'):null,viewport=window.visualViewport;
              // A row is shown when it lies inside the clipped pane and above the soft keyboard.
              const box=owned?pane.getBoundingClientRect():null,screen=owned?root.querySelector('.xterm-screen'):null;
              const shown=row=>{const r=row.getBoundingClientRect();return r.height>0&&r.top>=box.top-0.5&&r.bottom<=box.bottom+0.5&&
                (!viewport||(r.top>=viewport.offsetTop-0.5&&r.bottom<=viewport.offsetTop+viewport.height+0.5));};
              const sheet=owned?pane.parentElement?.querySelector(':scope > .terminal-composer-sheet'):null,cover=sheet?.getBoundingClientRect();
              return {...result,owned,cursorRow:cursor<0?null:cursor,domRows:rows.length,
                cursorShown:cursor>=0&&shown(rows[cursor]),newestShown:rows.some(row=>row.textContent.includes('OWNED_MOSH_ROW_511')&&shown(row)),
                panned:Boolean(screen&&screen.style.transform),
                composing:Boolean(sheet&&cover.height>0&&document.activeElement===sheet.querySelector('textarea')&&pane.hasAttribute('inert')&&
                  sheet.contains(document.elementFromPoint(cover.left+cover.width/2,cover.top+cover.height/2))),
                painted:rows.some(row=>/OWNED_MOSH_ROW_[0-9]{3}/.test(row.textContent)),
                editable:Boolean(editor&&!editor.readOnly&&!editor.disabled),
                centerOwned:Boolean(owned&&viewport?.scale===1&&viewport.offsetLeft===0&&viewport.offsetTop===0&&
                  root.contains(document.elementFromPoint(innerWidth/2,innerHeight/2)))};
            })()
        """.trimIndent()
        // The native IME state of the sample under acceptance.
        var phaseIme: Boolean? = null
        // A covered phase samples the terminal under the composer sheet, which pauses fitting,
        // so its stale geometry is not a measured viewport fit; only its DOM rows are compared.
        fun awaitPhase(stage: String, keyboard: Boolean?, dismissKeyboard: Boolean = false, covered: Boolean = false, accept: (JSONObject) -> Boolean): JSONObject {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            // Mosh can paint a resized frame before Herdr repaints it, and IME
            // animations dispatch intermediate layouts. Admit only a settled sample.
            val settled = SettledPhase(500)
            // A setup phase may still be racing the connection's own keyboard
            // request; dismiss it only after the native IME stays visible.
            val shown = SettledPhase(500)
            var dismissals = 0
            var last = "unavailable"
            while (true) {
                val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                assertTrue("Owned Mosh resize phase $stage did not settle: $last", remaining > 0)
                var ready = false
                var imeVisible: Boolean? = null
                scenario.onActivity { current ->
                    assertSame("Mosh resize retains its Activity", activity, current)
                    assertSame("Mosh resize retains its Window", window, current.window)
                    assertSame("Mosh resize retains its WebView", web, webView(current.window.decorView))
                    imeVisible = ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime())
                    ready = current.lifecycle.currentState == androidx.lifecycle.Lifecycle.State.RESUMED && web.isAttachedToWindow && web.isShown && web.hasWindowFocus() &&
                        imeVisible != null && (keyboard == null || imeVisible == keyboard)
                }
                val state = JSONObject(evaluate(scenario, observation, remaining.coerceAtMost(1000)))
                require(state.keys().asSequence().toSet() == setOf("valid", "rows", "historyRows", "owned", "cursorRow", "domRows", "composing", "painted", "editable", "centerOwned", "cursorShown", "newestShown", "panned"))
                last = state.toString().also { require(it.length <= 256) } + " ime=$imeVisible ready=$ready dismissals=$dismissals"
                val now = TimeUnit.NANOSECONDS.toMillis(System.nanoTime())
                if (dismissKeyboard && keyboard == false && dismissals < 3 && shown.admit(now, imeVisible == true, "ime")) {
                    dismissals++
                    shown.reset()
                    settled.reset()
                    device.pressBack()
                    continue
                }
                phaseIme = imeVisible
                val matches = ready && state.getBoolean("owned") && state.getBoolean("painted") && state.getBoolean("composing") == covered &&
                    (covered || (state.getBoolean("valid") && (history < 0 || state.getInt("historyRows") == history))) && accept(state)
                if (settled.admit(now, matches, "$state ime=$imeVisible") && System.nanoTime() < deadline) {
                    println("lazysh Mosh resize: phase=$stage rows=${state.opt("rows")} domRows=${state.getInt("domRows")} cursor=${state.opt("cursorRow")} history=${state.opt("historyRows")} keyboard=$imeVisible cursorShown=${state.getBoolean("cursorShown")} newestShown=${state.getBoolean("newestShown")} panned=${state.getBoolean("panned")}")
                    return state
                }
                val pause = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtMost(50)
                if (pause > 0) Thread.sleep(pause)
            }
        }
        fun button(label: String) = onWebView().withElement(findElement(Locator.XPATH, "//button[@aria-label='$label' or (not(@aria-label) and normalize-space(.)='$label')]"))
            .perform(webClick())
        try {
            installed = evaluate(scenario, """
                (()=>{const pane=document.querySelector($selector),root=pane?.querySelector('.xterm'),tab=document.querySelector('[role=tab][aria-selected=true]');
                  if(!root||!tab||Object.prototype.hasOwnProperty.call(window,$key))return false;
                  Object.defineProperty(window,$key,{value:{document,pane,root,tab},configurable:true});return true;})()
            """) == "true"
            assertTrue("Mosh resize owns only its original document and terminal", installed)
            if (ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true) device.pressBack()
            val baseline = awaitPhase("baseline", false, dismissKeyboard = true) { it.getBoolean("editable") && it.getBoolean("centerOwned") && !it.isNull("cursorRow") && it.getBoolean("cursorShown") }
            history = baseline.getInt("historyRows")
            // Espresso's ordinary native center tap is admitted only when the
            // current document proves that center belongs to its original xterm.
            onView(isAssignableFrom(WebView::class.java)).perform(click())
            // The remote application redraws at the smaller keyboard-sized terminal.
            val reduced = awaitPhase("keyboard-resize", true) {
                it.getInt("rows") < baseline.getInt("rows") && it.getBoolean("cursorShown") && !it.getBoolean("panned")
            }
            device.pressBack()
            val expanded = awaitPhase("keyboard-release", false) {
                it.getInt("rows") > reduced.getInt("rows") && it.getInt("rows") == baseline.getInt("rows") && it.getBoolean("cursorShown")
            }
            button("Compose")
            // The sheet covers the output and pauses fitting: the soft keyboard it raises must
            // leave the original terminal rows, and so the remote Mosh size, unchanged.
            awaitPhase("compose-cover", true, covered = true) { it.getInt("domRows") == expanded.getInt("rows") }
            button("Close composer")
            // Closing refits to the current viewport, including the keyboard if it remains open.
            awaitPhase("compose-refit", null) { it.getInt("rows") <= expanded.getInt("rows") && it.getBoolean("cursorShown") }
            if (ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true) device.pressBack()
            val portrait = awaitPhase("portrait", false, dismissKeyboard = true) { true }
            scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE }
            val landscape = awaitPhase("orientation-shrink", false) { activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE && it.getInt("rows") < portrait.getInt("rows") }
            scenario.onActivity { it.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT }
            awaitPhase("orientation-grow", false) { activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT && it.getInt("rows") > landscape.getInt("rows") }
            // The same append-only receiver's existing final exact chat ledger
            // excludes extra passive bytes posthoc; this is not a per-phase read.
            println("lazysh Mosh resize: keyboardResized=true newestAtBaseline=${baseline.getBoolean("newestShown")} ordinaryAosp=true receiverLedger=pending-host-final")
        } catch (failure: Throwable) { primary = failure; throw failure }
        finally {
            var cleanup: Throwable? = null
            for (action in listOf<() -> Unit>(
                { if (ViewCompat.getRootWindowInsets(decor)?.isVisible(WindowInsetsCompat.Type.ime()) == true) device.pressBack() },
                {
                    scenario.onActivity { it.requestedOrientation = orientation }
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                    var restored = false
                    while (!restored) {
                        scenario.onActivity { restored = it.resources.configuration.orientation == configuration }
                        assertTrue("Mosh resize restores its original orientation", System.nanoTime() < deadline)
                        if (!restored) Thread.sleep(50)
                    }
                },
                { assertTrue("Mosh resize preserves the original IME configuration", imeSettings() == originalIme) },
                { if (installed) assertEquals("Mosh resize removes its passive document guard", "true", evaluate(scenario,
                    "(()=>{const saved=window[$key];if(!saved||saved.document!==document)return false;return delete window[$key];})()")) }
            )) try { action() } catch (failure: Throwable) {
                val first = primary ?: cleanup
                if (first == null) cleanup = failure else first.addSuppressed(AssertionError("Owned Mosh resize cleanup also failed", failure))
            }
            cleanup?.let { throw it }
        }
    }

    private fun observedShortHistoryBaseline(row: Int, newest: Boolean): Int {
        require(row in 0..511 || (row == -1 && newest)) { "Owned short-drag baseline unavailable" }
        return if (row == -1) 512 else row
    }

    private fun completedShortHistoryProgress(before: Int, row: Int): Boolean =
        before in 0..512 && row in 0..511 && row < before

    @Test fun shortHerdrGroupsRequireProgressFromTheirObservedBaseline() {
        val before = observedShortHistoryBaseline(511, true)
        assertFalse("An unchanged OLD511 is not progress", completedShortHistoryProgress(before, 511))
        assertTrue("Older rows can progress while the newest row remains visible", completedShortHistoryProgress(before, 508))
        assertTrue("The observed Mosh redraw advanced from OLD506 to OLD498", completedShortHistoryProgress(506, 498))
        assertEquals(511, observedShortHistoryBaseline(511, false))
        assertEquals(512, observedShortHistoryBaseline(-1, true))
        assertTrue(completedShortHistoryProgress(observedShortHistoryBaseline(-1, true), 511))
        for (row in listOf(-2, 512, 513, Int.MIN_VALUE, Int.MAX_VALUE))
            for (newest in listOf(false, true)) assertTrue(runCatching { observedShortHistoryBaseline(row, newest) }.isFailure)
        assertTrue(runCatching { observedShortHistoryBaseline(-1, false) }.isFailure)
        for ((baseline, row) in listOf(511 to 512, 511 to -1, 0 to 0, -1 to 0, 513 to 511))
            assertFalse(completedShortHistoryProgress(baseline, row))
    }

    private fun verifyGuardedHerdrChat(scenario: ActivityScenario<MainActivity>, herdr: JSONObject, parent: String, label: String, alreadyAttached: Boolean = false) {
        val name = herdr.getString("name")
        val transcript = herdr.getString("transcript")
        val record = herdr.getString("record")
        val draft = herdr.getString("draft")
        require(name == "owned-guard")
        require(transcript.startsWith("/") && transcript.length <= 4096 && transcript.none { it.isISOControl() })
        require(draft.toByteArray(Charsets.UTF_8).size in 1..4096 && !draft.contains('\r') && !draft.contains('\u001b'))
        fun click(text: String) {
            onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(.)='$text']")).perform(webClick())
        }
        fun hasButton(text: String) = "Array.from(document.querySelectorAll('button')).filter(x=>x.textContent.trim()===${JSONObject.quote(text)}).length===1"
        val region = "section[aria-label='Terminal input']"
        val path = "input[placeholder='Absolute host path to session.jsonl']"
        fun replace(selector: String, value: String) {
            replaceNativeText(scenario, selector, value)
            closeSoftKeyboard()
        }
        if (!alreadyAttached) {
            sessionView(scenario, "Sessions")
            awaitDocument(scenario, "owned Herdr available", hasButton("List herdr sessions"))
            click("List herdr sessions")
            awaitDocument(scenario, "owned Herdr listed", hasButton("Attach herdr $name"))
            click("Attach herdr $name")
            awaitDocument(scenario, "owned guarded child attached", "document.querySelectorAll('[role=tab]').length===2")
        }
        val history = herdr.getJSONObject("history")
        val original = herdr.getJSONObject("agent")
        val historyTab = history.getString("tabId")
        val originalTab = original.getString("tabId")
        require(historyTab.matches(Regex("w[0-9]+:t[0-9]+")) && historyTab.length <= 50 &&
            originalTab.matches(Regex("w[0-9]+:t[0-9]+")) && originalTab.length <= 50 && historyTab != originalTab)
        val childDisconnect = JSONObject.quote("button[aria-label='Disconnect $parent / $name']")
        val discoveryObservation = """
            (()=>{
              const panels=Array.from(document.querySelectorAll('.multiplexer-panel'));
              const panel=panels.length===1?panels[0]:null;
              const list=Array.from(panel?.querySelectorAll('button')??[]).filter(x=>x.textContent.trim()==='List herdr sessions');
              const capabilityText=panel?.querySelector('p.muted')?.textContent.match(/(?:^| · )Herdr (detected|not installed|\S+ \((?:Supported|Limited)\))(?: · |${'$'})/)?.[1];
              const capability=capabilityText==='not installed'?'missing':capabilityText?'detected':'unknown';
              const selected=label=>Array.from(document.querySelectorAll('.view-tabs button[aria-current=page], .mobile-session-views button[aria-current=page]')).some(x=>x.textContent.trim()===label);
              const count=selector=>Math.min(8,document.querySelectorAll(selector).length);
              const child=document.querySelector($childDisconnect);
              return {panelCount:Math.min(8,panels.length),loading:Boolean(panel?.querySelector('.loading')),
                inlineError:Boolean(panel?.querySelector('.inline-error[role=alert]')),herdrCapability:capability,
                listCount:Math.min(8,list.length),listEnabled:list.length===1&&!list[0].disabled,
                sessionsSelected:selected('Sessions'),terminalSelected:selected('Terminal'),
                menuCount:count('.mobile-session-views'),tabsCount:count('[role=tab]'),
                terminalCount:count('.terminal-canvas'),childDisconnect:Boolean(child),
                endedPlaceholder:document.querySelector('.session-body > .panel-empty h3')?.textContent?.trim()==='This connection has ended.',
                expectedChildTabSelected:Boolean(child?.closest('.session-tab')?.querySelector('[role=tab][aria-selected=true]'))};
            })()
        """.trimIndent()
        fun focusTab(tab: String) {
            sessionView(scenario, "Sessions")
            awaitDocument(scenario, "owned Herdr discovery controls", hasButton("List herdr sessions"),
                observe = { remaining -> evaluate(scenario, discoveryObservation, remaining) })
            click("List herdr sessions")
            awaitDocument(scenario, "owned Herdr browse action", hasButton("Browse Herdr $name"))
            click("Browse Herdr $name")
            awaitDocument(scenario, "owned exact Herdr tab action", hasButton("Focus $tab"))
            onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(.)='Focus $tab']"))
                .perform(webScrollIntoView()).perform(webClick())
            awaitDocument(scenario, "owned Herdr tab focus acknowledged",
                "Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='Focus $tab')?.closest('details')?.querySelector('summary')?.textContent.endsWith(' · focused')===true")
            sessionView(scenario, "Terminal")
        }
        focusTab(historyTab)
        val screens = "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).filter(x=>x.getClientRects().length>0)"
        awaitDocument(scenario, "owned history newest row visible", "(() => {const screens=$screens; return screens.length===1 && screens[0].textContent.includes('NEW512');})()")
        val geometryDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        // Returning to the terminal is navigation: it neither focuses the terminal input nor raises the keyboard.
        awaitDocument(scenario, "owned history terminal shown without input focus", """
            (()=>{const screens=$screens;return screens.length===1 &&
              screens[0].parentElement.querySelector('.xterm-helper-textarea')!==document.activeElement;})()
        """, deadline = geometryDeadline)
        closeSoftKeyboard()
        val fingerSource = InstrumentationRegistry.getInstrumentation().context.assets.open("owned-herdr-finger.js")
            .use { it.readNBytes(16_385) }
        require(fingerSource.size <= 16_384)
        val fingerScript = fingerSource.toString(Charsets.UTF_8)
        val geometryScript = "(()=>{$fingerScript;return ownedHerdrSwipeGeometry($screens,window.visualViewport,devicePixelRatio,document);})()"
        var geometry = JSONObject()
        while (true) {
            val remaining = TimeUnit.NANOSECONDS.toMillis(geometryDeadline - System.nanoTime())
            assertTrue("Native swipe path did not settle inside its owned screen/viewport: diagnostic=${geometry.optJSONObject("diagnostic")}", remaining > 0)
            geometry = JSONObject(evaluate(scenario, geometryScript, remaining))
            if (geometry.getBoolean("ready") && System.nanoTime() < geometryDeadline) break
            val pause = TimeUnit.NANOSECONDS.toMillis(geometryDeadline - System.nanoTime()).coerceAtMost(50)
            if (pause > 0) Thread.sleep(pause)
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        lateinit var fingerActivity: MainActivity
        lateinit var fingerView: WebView
        lateinit var fingerDecor: View
        lateinit var fingerRoot: View
        var fingerWindow: OwnedFingerWindowObserver? = null
        scenario.onActivity { activity ->
            fingerActivity = activity; fingerDecor = activity.window.decorView
            fingerView = checkNotNull(webView(fingerDecor)); fingerRoot = fingerView.rootView
        }
        var startFrame: List<Int>? = null
        fun fingerFrame(view: View): List<Int> {
            val origin = IntArray(2); view.getLocationOnScreen(origin)
            return listOf(origin[0], origin[1], view.width, view.height)
        }
        fun ownsFingerView() = !fingerActivity.isFinishing && !fingerActivity.isDestroyed &&
            fingerActivity.window.decorView === fingerDecor && fingerView.rootView === fingerRoot &&
            fingerView.isAttachedToWindow && fingerView.isShown && fingerView.hasWindowFocus() &&
            (fingerWindow == null || fingerActivity.window.callback === fingerWindow) &&
            (startFrame == null || fingerFrame(fingerView) == startFrame)
        fun fingerPoint(view: View, fraction: Double, dispatch: JSONObject, geometry: JSONObject): FloatArray {
            val rect = geometry.getJSONArray("rect")
            val viewport = geometry.getJSONArray("viewport")
            val bounds = (0..3).map { rect.getDouble(it) }
            val visible = (0..4).map { viewport.getDouble(it) }
            require((bounds + visible).all { it.isFinite() } && visible[2] > 0 && visible[3] > 0 && visible[4] == 1.0 &&
                bounds[0] >= visible[0] && bounds[1] >= visible[1] && bounds[2] <= visible[0] + visible[2] &&
                bounds[3] <= visible[1] + visible[3] && bounds[2] > bounds[0] && bounds[3] > bounds[1])
            val frame = fingerFrame(view)
            if (startFrame == null) startFrame = frame else assertEquals("Swipe WebView frame must remain stable", startFrame, frame)
            val density = view.resources.displayMetrics.density.toDouble()
            val predicates = mapOf(
                "ownedView" to (view === fingerView && ownsFingerView()), "webView" to (view is WebView), "attached" to view.isAttachedToWindow, "shown" to view.isShown,
                "windowFocused" to view.hasWindowFocus(), "layoutSettled" to !view.isLayoutRequested,
                "sizePositive" to (view.width > 0 && view.height > 0), "densityValid" to (density.isFinite() && density > 0),
                "densityMatchesDom" to (geometry.getDouble("density") == density))
            val insets = ViewCompat.getRootWindowInsets(view.rootView)
            val imeVisible = insets?.isVisible(WindowInsetsCompat.Type.ime())
            val bottom = insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom
            val windowOrigin = IntArray(2); view.getLocationInWindow(windowOrigin)
            val rootOrigin = IntArray(2); view.rootView.getLocationInWindow(rootOrigin)
            val top = windowOrigin[1] - rootOrigin[1]
            val clear = swipeViewClearOfIme(imeVisible, bottom, top, view.height, view.rootView.height)
            val imeState = when (imeVisible) { true -> "visible"; false -> "hidden"; null -> "unavailable" }
            val imeGeometry = listOf(top, view.height, view.rootView.height, bottom ?: -1).map { it.coerceIn(-1, 65535) }
            dispatch.put("ime", imeState).put("imeClear", clear).put("imeGeometry", JSONArray(imeGeometry))
            assertTrue("Owned swipe requires the focused, stable WebView without IME overlap: native=$predicates ime=$imeState clear=$clear geometry=$imeGeometry",
                predicates.values.all { it } && clear)
            val scaleX = view.width / visible[2]
            val scaleY = view.height / visible[3]
            val travel = (bounds[3] - bounds[1]) * 0.5 * scaleY
            assertTrue("Owned native swipe must exceed both DOM scroll admission and native touch slop",
                travel > 10 * scaleY && travel > ViewConfiguration.get(view.context).scaledTouchSlop * 2 && travel > 10 * density)
            val x = ((bounds[0] + bounds[2]) / 2 - visible[0]) * scaleX
            val y = (bounds[1] + (bounds[3] - bounds[1]) * fraction - visible[1]) * scaleY
            assertTrue("Swipe finger must stay inside the measured native WebView", x > 0 && y > 0 && x < view.width && y < view.height)
            return floatArrayOf((frame[0] + x).toFloat(), (frame[1] + y).toFloat())
        }
        val fingerStarted = System.nanoTime()
        var fingerDeadline = fingerStarted + TimeUnit.SECONDS.toNanos(5)
        fun nativeFingerGesture(short: Boolean, before: Int, requireCompletedProgress: Boolean = false): JSONObject {
            val fingerKey = JSONObject.quote("__lazyshOwnedFinger_" + UUID.randomUUID().toString().replace("-", ""))
            val fingerObservation = """
                (()=>{$fingerScript;const screens=$screens;
                  const geometry=ownedHerdrSwipeGeometry(screens,window.visualViewport,devicePixelRatio,document,true);
                  return {geometry,installed:geometry.ready&&ownedHerdrObserveFinger(window,$fingerKey,screens,geometry)};})()
            """.trimIndent()
            var gestureGeometry: JSONObject? = null
            val downTime = android.os.SystemClock.uptimeMillis()
            val pointer = android.view.MotionEvent.PointerProperties().apply {
                id = 0; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER
            }
            var fingerDown = false
            var lastPoint = floatArrayOf()
            var fingerFailure: Throwable? = null
            val dispatches = JSONArray()
            fun elapsed() = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - fingerStarted).coerceIn(0, 65_535)
            fun sendFinger(action: Int, point: FloatArray) {
                val coordinate = android.view.MotionEvent.PointerCoords().apply {
                    x = point[0]; y = point[1]; pressure = 1f; size = 1f
                }
                val event = android.view.MotionEvent.obtain(downTime, android.os.SystemClock.uptimeMillis(), action,
                    1, arrayOf(pointer), arrayOf(coordinate), 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
                try {
                    assertEquals("One native finger identity throughout drag", 0, event.getPointerId(0))
                    assertEquals("One native DOWN epoch throughout drag", downTime, event.downTime)
                    instrumentation.sendPointerSync(event)
                } finally {event.recycle()}
            }
            fun injectFinger(action: Int, fraction: Double) {
                val dispatch = JSONObject().put("action", action).put("frameBeginMs", elapsed())
                if (dispatches.length() == 0) dispatch.put("geometry", checkNotNull(gestureGeometry).getJSONObject("diagnostic"))
                assertTrue("Owned finger dispatch trace is bounded", dispatches.length() < 6)
                dispatches.put(dispatch)
                // ActivityScenario.onActivity waits for UI idle before dispatch, outside its callback timeout.
                instrumentation.runOnMainSync {
                    lastPoint = fingerPoint(fingerView, fraction, dispatch, checkNotNull(gestureGeometry))
                    val global = Rect(); val visibleWindow = Rect()
                    dispatch.put("globalVisible", fingerView.getGlobalVisibleRect(global))
                    fingerView.getWindowVisibleDisplayFrame(visibleWindow)
                    dispatch.put("frame", JSONArray(startFrame)).put("point", JSONArray(lastPoint.map { it.toInt() }))
                        .put("scroll", JSONArray(listOf(fingerView.scrollX, fingerView.scrollY)))
                        .put("global", JSONArray(listOf(global.left, global.top, global.right, global.bottom)))
                        .put("window", JSONArray(listOf(visibleWindow.left, visibleWindow.top, visibleWindow.right, visibleWindow.bottom)))
                }
                dispatch.put("injectBeginMs", elapsed()).put("eventAgeMs", android.os.SystemClock.uptimeMillis() - downTime)
                if (action != android.view.MotionEvent.ACTION_UP)
                    assertTrue("Owned finger injection requires remaining original budget: dispatches=$dispatches", System.nanoTime() < fingerDeadline)
                sendFinger(action, lastPoint)
                dispatch.put("injectEndMs", elapsed())
            }
            var lastFingerSample = JSONObject()
            var samplePhase = 0
            var sampleSequence = 0
            var sampleAtMs = 0L
            fun fingerRead(expression: String, timeoutMillis: Long): String {
                val result = AtomicReference<String>()
                val completed = CountDownLatch(1)
                assertTrue("Owned finger probe dispatch rejected", fingerView.post {
                    if (ownsFingerView() && System.nanoTime() < fingerDeadline) {
                        fingerView.evaluateJavascript(expression) { value ->
                            if (ownsFingerView() && System.nanoTime() < fingerDeadline) result.set(value)
                            completed.countDown()
                        }
                    } else completed.countDown()
                })
                assertTrue("Owned finger probe exceeded original budget: dispatches=$dispatches cachedSample=$lastFingerSample", completed.await(timeoutMillis, TimeUnit.MILLISECONDS))
                return checkNotNull(result.get()) { "Owned finger probe lost view identity or original budget cachedSample=$lastFingerSample" }
            }
            fun fingerSample(timeoutMillis: Long) = fingerRead("window[$fingerKey].sample()", timeoutMillis)
            fun observedDelivery(ended: Boolean, before: Int? = null): JSONObject {
                while (true) {
                    val remaining = TimeUnit.NANOSECONDS.toMillis(fingerDeadline - System.nanoTime())
                    assertTrue("Owned short drag delivery exceeded original cohort budget: ended=$ended dispatches=$dispatches sample=$lastFingerSample", remaining > 0)
                    val sample = JSONObject(fingerSample(remaining.coerceAtMost(1_000)))
                    lastFingerSample = sample
                    assertFalse("Owned first DOWN landed outside its calibrated geometry: sample=$sample", sample.getBoolean("bindingRejected"))
                    val events = sample.getJSONObject("global").getJSONArray("events")
                    val touchStarts = (0 until events.length()).count { events.getJSONObject(it).getString("type") == "touchstart" }
                    val cancelled = (0 until events.length()).any { events.getJSONObject(it).getString("type") == "touchcancel" }
                    assertTrue("Short drag must not restart or cancel: sample=$sample", touchStarts <= 1 && !cancelled)
                    val endedOnce = (0 until events.length()).count { index ->
                        val event = events.getJSONObject(index)
                        event.getString("type") == "touchend" && event.getBoolean("trusted") && event.getBoolean("identityMatches")
                    } == 1
                    if (ended) {
                        val progressed = before == null || completedShortHistoryProgress(before, sample.getInt("row"))
                        if (touchStarts == 1 && endedOnce && !sample.getBoolean("active") && progressed && System.nanoTime() < fingerDeadline) return sample
                    } else {
                        assertTrue("Short drag cancelled or restarted before UP: sample=$sample", sample.getBoolean("active"))
                        if (sample.getBoolean("held") && sample.getInt("moves") >= 1 && System.nanoTime() < fingerDeadline) return sample
                    }
                    Thread.sleep(10)
                }
            }
            fun progress(before: Int, moves: Int): Int {
                while (true) {
                    val remaining = TimeUnit.NANOSECONDS.toMillis(fingerDeadline - System.nanoTime())
                    assertTrue("Owned continuous drag did not advance before UP: phase=$moves before=$before samplePhase=$samplePhase sampleSequence=$sampleSequence sampleAtMs=$sampleAtMs dispatches=$dispatches window=${fingerWindow?.snapshot()} sample=$lastFingerSample", remaining > 0)
                    val sample = JSONObject(fingerSample(remaining.coerceAtMost(1_000)))
                    lastFingerSample = sample
                    assertFalse("Owned first DOWN landed outside its calibrated geometry: sample=$sample", sample.getBoolean("bindingRejected"))
                    samplePhase = moves; sampleSequence++; sampleAtMs = elapsed()
                    assertTrue("Trusted finger stream must not restart, end or cancel before progress: phase=$moves before=$before sample=$lastFingerSample", sample.getBoolean("active"))
                    val row = sample.getInt("row")
                    if (sample.getBoolean("held") && sample.getInt("moves") >= moves && completedShortHistoryProgress(before, row) && System.nanoTime() < fingerDeadline) return row
                    Thread.sleep(10)
                }
            }
            try {
                // Geometry that is still settling after the previous redraw is re-measured; nothing retargets after DOWN.
                var installation: JSONObject
                while (true) {
                    val remaining = TimeUnit.NANOSECONDS.toMillis(fingerDeadline - System.nanoTime())
                    assertTrue("Owned native gesture requires remaining original cohort budget", remaining > 0)
                    installation = JSONObject(fingerRead(fingerObservation, remaining))
                    if (installation.getBoolean("installed") || installation.getJSONObject("geometry").getBoolean("ready")) break
                    val pause = TimeUnit.NANOSECONDS.toMillis(fingerDeadline - System.nanoTime()).coerceAtMost(50)
                    assertTrue("Owned current finger geometry did not settle within original cohort budget: ${installation.getJSONObject("geometry").optJSONObject("diagnostic")}", pause > 0)
                    Thread.sleep(pause)
                }
                assertTrue("Owned current finger geometry and observation required: ${installation.optJSONObject("geometry")?.optJSONObject("diagnostic")}", installation.getBoolean("installed"))
                val measured=installation.getJSONObject("geometry")
                val shortRowHeight=measured.getDouble("rowHeight")
                require(shortRowHeight.isFinite() && shortRowHeight > 0 && shortRowHeight <= 32.0) { "Owned two-short-drag group requires a finite positive public cell at most 32 CSS pixels" }
                gestureGeometry=measured
                val bounds=(0..3).map { measured.getJSONArray("rect").getDouble(it) }
                val visible=(0..4).map { measured.getJSONArray("viewport").getDouble(it) }
                instrumentation.runOnMainSync {
                    check(ownsFingerView()) { "Owned finger Window installation lost its view" }
                    val window = fingerActivity.window
                    val observer = OwnedFingerWindowObserver(checkNotNull(window.callback), downTime)
                    window.callback = observer
                    fingerWindow = observer
                }
                fingerDown = true
                injectFinger(android.view.MotionEvent.ACTION_DOWN, 0.25)
                if (short) {
                    val destination = 0.25 + 16.0 / (bounds[3] - bounds[1])
                    require(destination < 0.75)
                    assertTrue("16 CSS pixel short drag must exceed native touch slop",
                        16.0 * fingerView.height / visible[3] > ViewConfiguration.get(fingerView.context).scaledTouchSlop)
                    injectFinger(android.view.MotionEvent.ACTION_MOVE, destination)
                    observedDelivery(false)
                    injectFinger(android.view.MotionEvent.ACTION_UP, destination)
                } else {
                    injectFinger(android.view.MotionEvent.ACTION_MOVE, 0.5)
                    val firstRow = progress(before, 1)
                    injectFinger(android.view.MotionEvent.ACTION_MOVE, 0.75)
                    val secondRow = progress(firstRow, 2)
                    assertTrue("Second MOVE must reveal further history before the same finger lifts", secondRow < firstRow)
                    injectFinger(android.view.MotionEvent.ACTION_UP, 0.75)
                }
                fingerDown = false
                return observedDelivery(true, if (short && requireCompletedProgress) before else null)
            } catch (failure: Throwable) {fingerFailure = failure; throw failure}
            finally {
                var cleanup: Throwable? = null
                try {
                    if (fingerDown && lastPoint.size == 2) sendFinger(android.view.MotionEvent.ACTION_CANCEL, lastPoint)
                } catch (failure: Throwable) {cleanup = failure}
                try { instrumentation.runOnMainSync { fingerWindow?.restore(fingerActivity.window); fingerWindow = null } }
                catch (failure: Throwable) {if(cleanup==null)cleanup=failure else cleanup!!.addSuppressed(failure)}
                try {evaluate(scenario, "window[$fingerKey]?.dispose();delete window[$fingerKey];true")}
                catch (failure: Throwable) {if(cleanup==null)cleanup=failure else cleanup!!.addSuppressed(failure)}
                if(cleanup!=null) {if(fingerFailure!=null)fingerFailure!!.addSuppressed(cleanup!!) else throw cleanup!!}
            }
        }
        var shortRow = 512
        var completedProgress = 0
        val shortSamples = JSONArray()
        repeat(5) { index ->
            // Only completed groups wait for remote redraw; the first short drag may legitimately emit no wheel report.
            val groupComplete = index == 1 || index == 4
            val sample = nativeFingerGesture(true, shortRow, groupComplete)
            if (index == 0) {
                val baseline = sample.getJSONObject("baseline")
                shortRow = observedShortHistoryBaseline(baseline.getInt("row"), baseline.getBoolean("newest"))
            }
            val row = sample.getInt("row")
            val newest = sample.getBoolean("newest")
            shortSamples.put(JSONObject().put("row", row).put("newest", newest))
            if (groupComplete) {
                assertTrue("Completed short-drag group must reveal older receiver history: samples=$shortSamples", completedShortHistoryProgress(shortRow, row))
                completedProgress++; shortRow = row
            }
        }
        assertEquals("Both completed short-drag groups must advance remote history", 2, completedProgress)
        val swiped = nativeFingerGesture(false, shortRow).getInt("row")
        // A reader who lifts the finger in history and waits keeps scrolling with the next drag (#1040).
        Thread.sleep(1_500)
        fingerDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        nativeFingerGesture(false, swiped)
        awaitDocument(scenario, "native finger swipe reveals older owned Herdr rows", """
            (()=>{const screens=$screens; return screens.length===1 && /OLD[0-9]{3}/.test(screens[0].textContent) && !screens[0].textContent.includes('NEW512');})()
        """, observe = { remaining -> evaluate(scenario, """
            (()=>{$fingerScript;return JSON.stringify(ownedHerdrFailureMarkers($screens,window.visualViewport));})()
        """, remaining) })
        focusTab(originalTab)
        if (!alreadyAttached) {
            val question = """(()=>{const screens=$screens;const text=screens.length===1?screens[0].textContent:'';
                return text.includes('OWNED_QUESTION') && text.includes('> OPTION_ONE') && text.includes('OPTION_TWO');})()"""
            awaitDocument(scenario, "owned agent question and selection", question)
            // Focusing the original tab returns to the Terminal view, which is navigation and leaves the terminal input unfocused.
            awaitDocument(scenario, "owned agent terminal shown without input focus", """
                (()=>{const screens=$screens;return screens.length===1 &&
                  screens[0].parentElement.querySelector('.xterm-helper-textarea')!==document.activeElement;})()
            """)
            closeSoftKeyboard()
            fingerDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            nativeFingerGesture(true, 0)
            assertEquals("Finger swipe preserves the agent question and selected option", "true", evaluate(scenario, question))
            // The host's final exact receiver ledger also rejects any swipe-generated input bytes.
        }
        println("lazysh Herdr finger scroll: five short native drags advanced history repeatedly, then two MOVE phases advanced before one UP, again after a pause in history; original tab restored before guarded Chat")
        sessionView(scenario, "Transcript")
        awaitDocument(scenario, "owned Herdr transcript controls ready", "Boolean(document.querySelector(${JSONObject.quote(path)}))")
        typeInto(scenario, path, transcript)
        closeSoftKeyboard()
        click("Open transcript")
        awaitDocument(scenario, "real companion transcript read", "document.querySelector('.chat-messages')?.textContent.includes(${JSONObject.quote(record)}) && Boolean(document.querySelector(${JSONObject.quote(region)}))")
        assertEquals("No Send before explicit preparation", "false", evaluate(scenario, hasButton("Send to terminal")))
        pasteOwnedText(scenario, "form.chat-composer textarea", draft, label)
        closeSoftKeyboard()
        assertEquals("Native paste must preserve the exact draft", "true", evaluate(scenario,
            "document.querySelector('form.chat-composer textarea')?.value===${JSONObject.quote(draft)}"))
        click("Choose terminal destination")
        awaitDocument(scenario, "owned Herdr confirmation", hasButton("Confirm this destination"),
            observe = herdrConfirmationObservation(scenario, "$parent / $name", draft))
        assertEquals("Preparation alone must not enable Send", "false", evaluate(scenario, hasButton("Send to terminal")))
        click("Confirm this destination")
        awaitDocument(scenario, "explicit owned Herdr binding", hasButton("Send to terminal"))
        click("Send to terminal")
        awaitDocument(scenario, "actual native guarded queue acknowledgement",
            "Array.from(document.querySelectorAll('[role=status]')).some(x=>x.textContent==='Text and Enter queued for the confirmed terminal.')")
        assertEquals("Only acknowledged original draft is cleared", "true", evaluate(scenario,
            "document.querySelector('form.chat-composer textarea')?.value===''"))
        click("Request stop")
        awaitDocument(scenario, "actual native guarded Escape acknowledgement",
            "Array.from(document.querySelectorAll('[role=status]')).some(x=>x.textContent==='Escape queued for the confirmed terminal. The process may still be running.')")
        replace(path, transcript + ".different")
        awaitDocument(scenario, "source edit retires guarded controls", "!document.querySelector(${JSONObject.quote(region)})")
        replace(path, transcript)
        assertEquals("Returning to the source must not restore a confirmation", "false", evaluate(scenario, hasButton("Send to terminal")))
        if (!alreadyAttached) {
            val child = "button[aria-label='Disconnect $parent / $name']"
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, child)).perform(webClick())
            awaitDocument(scenario, "owned Herdr child disconnected", "document.querySelectorAll('[role=tab]').length===1")
        }
        println("lazysh guarded Herdr Chat: real packaged UI/companion/native SSH preparation, confirmation, queue acknowledgement and source retirement completed")
    }

    private fun verifySharedHerdrNavigation(scenario: ActivityScenario<MainActivity>, herdr: JSONObject, parent: String, label: String) {
        val navigation = herdr.getJSONObject("navigation")
        val server = herdr.getString("name")
        require(server == "owned-guard")
        val source = navigation.getJSONObject("source")
        val shell = navigation.getJSONObject("shell")
        val agent = navigation.getJSONObject("agent")
        val targets = listOf(source, shell, agent)
        targets.forEach { target ->
            require(Regex("w[0-9]{1,49}").matches(target.getString("workspaceId")))
            require(Regex("w[0-9]+:t[0-9]+").matches(target.getString("tabId")) && target.getString("tabId").length <= 50)
            require(Regex("w[0-9]+:p[0-9]+").matches(target.getString("paneId")) && target.getString("paneId").length <= 50)
            require(Regex("NAV_(SOURCE|SHELL|AGENT)_[a-f0-9]{32}").matches(target.getString("marker")))
        }
        // The host harness reports these states to the real server; the board must render exactly them.
        val statusText = mapOf("working" to "Working", "blocked" to "Needs attention")
        require(statusText.containsKey(source.getString("status")) && statusText.containsKey(agent.getString("status")) && !shell.has("status"))
        val first = "$parent / $server"
        val second = "$first / $server"
        val labels = listOf(parent, first, second)
        val observer = InstrumentationRegistry.getInstrumentation().context.assets.open("owned-visible-herdr.js").use { it.reader().readText() }
        require(observer.length <= 4096)
        fun click(text: String) = onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(.)='$text']")).perform(webScrollIntoView()).perform(webClick())
        fun visible(display: Int, target: JSONObject) {
            sessionView(scenario, "Terminal")
            val forbidden = JSONArray(targets.filter { it !== target }.map { it.getString("marker") })
            awaitDocument(scenario, "exact owned Herdr visible display and target", """
                (()=>{$observer;return ownedVisibleHerdr(document,${JSONArray(labels)},$display,${JSONObject.quote(target.getString("marker"))},$forbidden);})()
            """)
        }
        var capture = 0
        fun screenshot(name: String) {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val directory = java.io.File(requireNotNull(instrumentation.targetContext.getExternalFilesDir(null)), "herdr-navigation")
            require(directory.mkdirs() || directory.isDirectory)
            val bitmap = committedScreenshot(scenario, capture.toLong())
            try { java.io.File(directory, "${++capture}-$name.png").outputStream().use { assertTrue("Owned screenshot write", bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { bitmap.recycle() }
        }
        fun choose(display: Int) {
            if (evaluate(scenario, workspaceElementVisible("button.mobile-tools", true)) == "true") selectOwnedConnection(scenario, labels[display])
            else onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".session-tabs .session-tab:nth-child(${display + 1}) [role=tab]")).perform(webScrollIntoView()).perform(webClick())
        }
        fun select(display: Int, target: JSONObject) {
            choose(display)
            visible(display, target)
            screenshot("display-$display-${target.getString("marker").substringBeforeLast('_')}")
        }
        fun reopenSource() {
            sessionView(scenario, "Transcript")
            val path = "input[placeholder='Absolute host path to session.jsonl']"
            awaitDocument(scenario, "owned transcript source control", "Boolean(document.querySelector(${JSONObject.quote(path)}))")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, path)).perform(webClick())
            onView(isAssignableFrom(WebView::class.java)).perform(
                pressKey(EspressoKey.Builder().withKeyCode(KeyEvent.KEYCODE_A).withCtrlPressed(true).build()), pressKey(KeyEvent.KEYCODE_DEL))
            typeInto(scenario, path, herdr.getString("transcript")); closeSoftKeyboard(); click("Open transcript")
            awaitDocument(scenario, "exact owned navigation transcript loaded", "document.querySelector('.chat-messages')?.textContent.includes(${JSONObject.quote(herdr.getString("record"))})")
        }
        // A Herdr switch is not a typing request: the soft keyboard stays closed until the terminal or keyboard key asks for it.
        fun keyboardStaysClosed(display: Int, action: String) {
            val editable = "document.activeElement?.matches('input,textarea,select,[contenteditable]')===true"
            awaitDocument(scenario, "$action switched display $display", """
                document.querySelectorAll('.session-tabs [role=tab]')[$display]?.getAttribute('aria-selected')==='true' &&
                  document.querySelector('.herdr-navigation')?.getAttribute('aria-busy')==='false'
            """)
            // Activation focus lands a frame after the switch, so observe a settled window instead of one sample.
            val settled = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(1500)
            do {
                var ime: Boolean? = null
                scenario.onActivity { ime = ViewCompat.getRootWindowInsets(it.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) }
                assertNotNull("$action needs root insets to observe the soft keyboard", ime)
                assertFalse("$action must keep the soft keyboard closed", ime!!)
                assertEquals("$action must not focus an editable control", "false", evaluate(scenario, editable))
                Thread.sleep(100)
            } while (System.nanoTime() < settled)
        }
        // Herdr marks exactly the focused space, tab and pane current, and the marker follows the real shared focus.
        var focused = source
        fun currentLabels(target: JSONObject) = JSONArray(when {
            target === agent -> listOf(navigation.getString("workspaceLabel"), agent.getString("label"), "codex")
            target === shell -> listOf(navigation.getString("workspaceLabel"), shell.getString("label"), shell.getString("paneId"))
            else -> listOf(source.getString("label"), "codex")
        })
        // The Spaces layout is one remembered preference: the selector, storage and the tree's class must agree, and of the two real
        // spaces exactly `open` show their tabs (accordion: the focused one; list and grid: both).
        // A run that ended early may have left a layout behind; start from what storage holds, which a mounted sidebar already read.
        val storedLayout = evaluate(scenario, "localStorage.getItem('lazysh.multiplexer.layout')").trim('"')
        var shownLayout = if (storedLayout == "accordion" || storedLayout == "grid") storedLayout else "list"
        var layoutStored = storedLayout != "null"
        fun layoutIs(layout: String, stored: Boolean, open: Int? = null) = """
            (()=>{const root=document.querySelector(".herdr-navigation[data-mode='spaces']:not([hidden])");
              const select=Array.from(root?.querySelectorAll('label')??[]).find(x=>x.textContent.startsWith('Jump To layout'))?.querySelector('select');
              const spaces=Array.from(root?.querySelectorAll('li.herdr-space')??[]).map(li=>li.querySelector(':scope > ul')!==null);
              const stored=localStorage.getItem('lazysh.multiplexer.layout');
              return select?.value===${JSONObject.quote(layout)} && (stored??'list')===${JSONObject.quote(layout)} && (${!stored} || stored===${JSONObject.quote(layout)}) &&
                root.querySelector('.herdr-navigation-tree')?.classList.contains(${JSONObject.quote("herdr-layout-$layout")})===true &&
                (${open === null} || (spaces.length===2 && spaces.filter(Boolean).length===${open ?: 0}));})()
        """
        fun chooseLayout(layout: String, open: Int? = null) {
            // The earlier choice must still be what this opening shows, including a display whose sidebar mounts fresh.
            awaitDocument(scenario, "remembered $shownLayout Herdr layout", layoutIs(shownLayout, layoutStored))
            assertEquals("The layout selector must accept $layout", "true", evaluate(scenario, """(()=>{
                const select=Array.from(document.querySelectorAll(".herdr-navigation[data-mode='spaces']:not([hidden]) label")).find(x=>x.textContent.startsWith('Jump To layout'))?.querySelector('select');
                if(!select||select.disabled)return false;
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSONObject.quote(layout)});
                select.dispatchEvent(new Event('change',{bubbles:true}));return true;})()"""))
            awaitDocument(scenario, "chosen $layout Herdr layout", layoutIs(layout, true, open))
            shownLayout = layout
            layoutStored = true
        }
        fun navigate(mode: String, targetLabel: String, target: JSONObject, context: String? = null, fromParent: Boolean = false, status: String? = null, layout: String? = null, open: Int? = null) {
            // From the parent SSH display, the switch activates the first existing Herdr display.
            val display = if (fromParent) 1 else 2
            if (fromParent) {choose(0); closeSoftKeyboard()}
            keepTopBar(scenario)
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.XPATH, "//nav[contains(@class,'workspace-navigation-modes')]/button[normalize-space(.)='$mode']")).perform(webClick())
            if (layout != null) chooseLayout(layout, open)
            val match = if (context == null) "span[strong[normalize-space(.)='$targetLabel']]" else "span[strong[normalize-space(.)='$targetLabel'] and small[contains(.,'$context')]]"
            val state = if (status == null) "" else "[@data-agent-status='$status'][.//span[contains(@class,'row-tag-status')][normalize-space(.)='${statusText.getValue(status)}']]"
            val row = "//section[contains(@class,'herdr-navigation') and not(@hidden)]//button[contains(@class,'herdr-navigation-row')][$match]$state"
            awaitDocument(scenario, "shared Herdr navigation target ready", """
                (()=>{const rows=document.evaluate(${JSONObject.quote(row)},document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
                  return Array.from(document.querySelectorAll('.herdr-navigation:not([hidden]) p')).some(x=>x.textContent==='Shared focus changes focus for other connections to this server.') &&
                    rows.snapshotLength===1 && !rows.snapshotItem(0).disabled;})()
            """)
            if (mode == "Workspaces") awaitDocument(scenario, "shared Herdr tree marks the focused space, tab and pane current", """
                (()=>{const marked=Array.from(document.querySelectorAll('.herdr-navigation:not([hidden]) .herdr-navigation-row[data-current="true"]')).map(x=>x.querySelector('strong')?.textContent.trim());
                  return marked.length===3 && ${currentLabels(focused)}.every(label=>marked.includes(label));})()
            """)
            onWebView().withElement(findElement(Locator.XPATH, row)).perform(webScrollIntoView())
            screenshot(if (mode == "Agents") "agents" else "spaces")
            onWebView().withElement(findElement(Locator.XPATH, row)).perform(webClick())
            keyboardStaysClosed(display, "$mode $targetLabel")
            visible(display, target)
            focused = target
            select(1, target) // Stock public focus must move the other real client too.
            select(2, target)
        }
        // The Sessions panel's Herdr browser sends the typed create, rename, split and zoom actions (`--no-focus`, so the shared
        // focus the checks above rely on stays put). The host reads the workspace back from Herdr itself; the panel's refreshed
        // tree is only the synchronization point and the pane id source here.
        fun panelActions() {
            val nonce = navigation.getString("workspaceLabel").removePrefix("NAV_WORKSPACE_")
            require(Regex("[a-f0-9]{32}").matches(nonce)) { "Owned Herdr nonce required" }
            val created = "ANDROID_CREATED_$nonce"
            val renamed = "ANDROID_RENAMED_$nonce"
            val tab = "ANDROID_TAB_$nonce"
            val directory = requireNotNull(java.io.File(herdr.getString("transcript")).parent) { "Owned Herdr directory required" }
            require(directory.startsWith("/")) { "Owned Herdr directory must be absolute" }
            val section = "section[aria-label='Herdr $server workspaces']"
            val sectionPath = "//section[@aria-label='Herdr $server workspaces']"
            fun workspacePath(label: String) = "$sectionPath/details[starts-with(normalize-space(./summary),'$label')]"
            val idle = "(()=>{const s=document.querySelector(${JSONObject.quote(section)});return !!s && !s.querySelector('[role=status],[role=alert]');})()"
            fun summaries() = "Array.from(document.querySelectorAll(${JSONObject.quote("$section > details > summary")})).map(x=>x.textContent.trim())"
            fun inWorkspace(label: String, rows: String, text: String = "x.textContent.trim()") = """(()=>{const w=Array.from(document.querySelectorAll(${JSONObject.quote("$section > details")}))
                .find(x=>(x.querySelector(':scope > summary')?.textContent??'').trim().startsWith(${JSONObject.quote(label)}));
                return w ? Array.from(w.querySelectorAll($rows)).map(x=>$text) : [];})()"""
            fun paneIds(label: String) = inWorkspace(label, "'.mux-row strong'", "x.textContent.trim().split(' · ')[0]")
            fun tabSummaries(label: String) = inWorkspace(label, "':scope > details > summary'")
            fun clickPath(path: String) = onWebView().withElement(findElement(Locator.XPATH, path)).perform(webScrollIntoView()).perform(webClick())
            val labelInput = "$section form label:nth-of-type(1) input"
            val directoryInput = "$section form label:nth-of-type(2) input"
            sessionView(scenario, "Sessions")
            awaitDocument(scenario, "Herdr browser list ready", "Array.from(document.querySelectorAll('.multiplexer-panel button')).filter(x=>x.textContent.trim()==='List herdr sessions' && !x.disabled).length===1")
            click("List herdr sessions")
            awaitDocument(scenario, "Herdr browser lists $server", "Array.from(document.querySelectorAll('button')).filter(x=>x.textContent.trim()==='Browse Herdr $server' && !x.disabled).length===1")
            click("Browse Herdr $server")
            awaitDocument(scenario, "Herdr browser reads its two workspaces", "$idle && ${summaries()}.length===2")
            // Create: a new workspace in the fixture directory, not focused.
            click("New Herdr workspace")
            awaitDocument(scenario, "Herdr create form", "document.querySelectorAll(${JSONObject.quote(directoryInput)}).length===1")
            typeInto(scenario, labelInput, created); closeSoftKeyboard()
            replaceNativeText(scenario, directoryInput, directory); closeSoftKeyboard()
            clickPath("$sectionPath//form//button[normalize-space(.)='Save Herdr workspace']")
            awaitDocument(scenario, "Herdr panel lists the created workspace", "$idle && ${summaries()}.length===3 && ${summaries()}.some(x=>x.startsWith(${JSONObject.quote(created)}))")
            // Rename: the form starts from the current label.
            clickPath("${workspacePath(created)}/div[contains(@class,'tool-bar')]/button[normalize-space(.)='Rename Herdr workspace']")
            awaitDocument(scenario, "Herdr rename form", "document.querySelector(${JSONObject.quote(labelInput)})?.value===${JSONObject.quote(created)}")
            replaceNativeText(scenario, labelInput, renamed); closeSoftKeyboard()
            clickPath("$sectionPath//form//button[normalize-space(.)='Save Herdr workspace']")
            awaitDocument(scenario, "Herdr panel shows the renamed workspace", "$idle && ${summaries()}.some(x=>x.startsWith(${JSONObject.quote(renamed)})) && !${summaries()}.some(x=>x.startsWith(${JSONObject.quote(created)}))")
            // Split down the new workspace's only pane, then zoom it.
            awaitDocument(scenario, "the renamed workspace has one pane", "${paneIds(renamed)}.length===1")
            val pane = evaluate(scenario, "${paneIds(renamed)}[0]").trim('"')
            require(Regex("w[0-9]+:p[0-9]+").matches(pane)) { "Herdr panel pane id invalid" }
            clickPath("${workspacePath(renamed)}//button[normalize-space(.)='Split $pane down']")
            awaitDocument(scenario, "Herdr split adds a second pane", "$idle && ${paneIds(renamed)}.length===2 && ${paneIds(renamed)}.includes(${JSONObject.quote(pane)})")
            clickPath("${workspacePath(renamed)}//button[normalize-space(.)='Zoom $pane']")
            awaitDocument(scenario, "Herdr zoom settled without an error", "$idle && ${paneIds(renamed)}.length===2")
            // Tab: the renamed workspace's own button opens the same form; the tab is created beside the zoomed one, not focused.
            clickPath("${workspacePath(renamed)}/div[contains(@class,'tool-bar')]/button[normalize-space(.)='New Herdr tab']")
            awaitDocument(scenario, "Herdr tab create form", "document.querySelectorAll(${JSONObject.quote(directoryInput)}).length===1")
            typeInto(scenario, labelInput, tab); closeSoftKeyboard()
            replaceNativeText(scenario, directoryInput, directory); closeSoftKeyboard()
            clickPath("$sectionPath//form//button[normalize-space(.)='Save Herdr workspace']")
            awaitDocument(scenario, "Herdr panel lists the created tab in the renamed workspace", "$idle && ${tabSummaries(renamed)}.length===2 && ${tabSummaries(renamed)}.some(x=>x.includes(${JSONObject.quote(tab)})) && ${paneIds(renamed)}.length===3")
        }
        var primaryFailure: Throwable? = null
        try {
            for (display in 1..2) {
                sessionView(scenario, "Sessions")
                val discoveryDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
                awaitDocument(scenario, "owned Herdr list ready for display $display", "Array.from(document.querySelectorAll('.multiplexer-panel button')).filter(x=>x.textContent.trim()==='List herdr sessions' && !x.disabled).length===1", deadline = discoveryDeadline)
                click("List herdr sessions")
                awaitDocument(scenario, "owned server discovered for display $display", "Array.from(document.querySelectorAll('button')).filter(x=>x.textContent.trim()==='Attach herdr $server').length===1", deadline = discoveryDeadline)
                click("Attach herdr $server")
                awaitDocument(scenario, "distinct owned Herdr display $display", "document.querySelectorAll('.session-tabs [role=tab]').length===${display + 1} && document.querySelectorAll('.session-tabs [role=tab]')[${display}]?.getAttribute('aria-selected')==='true'")
            }
            visible(2, source)
            reopenSource()
            pasteOwnedText(scenario, "form.chat-composer textarea", herdr.getString("draft"), label); closeSoftKeyboard()
            click("Choose terminal destination")
            awaitDocument(scenario, "stock Herdr truthfully refuses private input preparation", "document.querySelector(\"section[aria-label='Terminal input'] [role=alert]\")?.textContent==='Guarded input is unavailable for this Herdr terminal. Use Stage or open the terminal.'")
            assertEquals("Stock Herdr cannot offer a private receipt", "false", evaluate(scenario, "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Send to terminal'||x.textContent==='Confirm this destination')"))
            // Accordion opens one of the two real spaces; grid and list open both. Each is chosen through the real selector, must be
            // what the next opening shows (the second one on a display whose sidebar mounts fresh) and must not change the exact
            // target a row focuses.
            navigate("Workspaces", navigation.getString("workspaceLabel"), agent, layout = "accordion", open = 1)
            navigate("Workspaces", shell.getString("label"), shell, fromParent = true, layout = "grid", open = 2)
            navigate("Agents", "codex", agent, agent.getString("label"), status = agent.getString("status"))
            navigate("Workspaces", shell.getString("paneId"), shell, layout = "list", open = 2)
            sessionView(scenario, "Transcript")
            assertEquals("Navigation cannot create stock input authority", "false", evaluate(scenario, "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Send to terminal'||x.textContent==='Confirm this destination')"))
            reopenSource()
            assertEquals("Reopening the old transcript cannot invent Send", "false", evaluate(scenario, "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Send to terminal'||x.textContent==='Confirm this destination')"))
            // Restore the exact old target through public navigation; stock still has no private receipt.
            navigate("Agents", "codex", source, source.getString("label"), status = source.getString("status"))
            reopenSource()
            assertEquals("Returning to the old destination cannot invent Send", "false", evaluate(scenario, "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Send to terminal'||x.textContent==='Confirm this destination')"))
            panelActions()
            println("lazysh shared Herdr navigation: two live display owners, visible target markers, shared focus, unavailable private Chat input, and the panel's workspace create, rename, split, zoom and new tab; no input action dispatched")
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            try {
            for (child in listOf(second, first)) {
                val selector = "button[aria-label='Disconnect $child']"
                if (evaluate(scenario, present(selector)) == "true") endOwnedConnection(scenario, child)
            }
            awaitDocument(scenario, "owned navigation children closed", "document.querySelectorAll('.session-tabs [role=tab]').length===1")
            } catch (cleanup: Throwable) {
                if (primaryFailure != null) primaryFailure.addSuppressed(cleanup) else throw cleanup
            }
        }
    }

    // The attached display a multiplexer case opened is closed whatever the case did; a failure to close it never replaces the case's own failure.
    private fun closeOwnedDisplay(scenario: ActivityScenario<MainActivity>, child: String, primaryFailure: Throwable?) {
        try {
            if (evaluate(scenario, present("button[aria-label='Disconnect $child']")) == "true") endOwnedConnection(scenario, child)
        } catch (cleanup: Throwable) {
            if (primaryFailure != null) primaryFailure.addSuppressed(cleanup) else throw cleanup
        }
    }

    // Opens the synthetic transcript the host companion reads, stages a draft, and sends it through the explicit
    // Choose, Confirm and Send steps to the pane this tmux display shows. The host later reads that exact pane back.
    private fun verifyOwnedTmuxChat(scenario: ActivityScenario<MainActivity>, chat: JSONObject, shown: JSONObject, session: String, label: String) {
        val transcript = chat.getString("transcript")
        val record = chat.getString("record")
        val draft = chat.getString("draft")
        require(transcript.startsWith("/") && transcript.length <= 4096 && transcript.none { it.isISOControl() })
        require(Regex("OWNED_TMUX_RECORD_[a-f0-9]{32}").matches(record))
        require(draft.toByteArray(Charsets.UTF_8).size in 1..4096 && draft.none { it.isISOControl() })
        require(chat.getString("window") == shown.getString("name"))
        val region = "section[aria-label='Terminal input']"
        val path = "input[placeholder='Absolute host path to session.jsonl']"
        val composer = "form.chat-composer textarea"
        fun hasButton(text: String) = "Array.from(document.querySelectorAll('button')).filter(x=>x.textContent.trim()===${JSONObject.quote(text)}).length===1"
        fun press(text: String) = onWebView().withElement(findElement(Locator.XPATH, "//button[normalize-space(.)='$text']")).perform(webScrollIntoView()).perform(webClick())
        sessionView(scenario, "Transcript")
        awaitDocument(scenario, "tmux transcript controls ready", present(path))
        typeInto(scenario, path, transcript)
        closeSoftKeyboard()
        press("Open transcript")
        awaitDocument(scenario, "real companion transcript read for the tmux display",
            "document.querySelector('.chat-messages')?.textContent.includes(${JSONObject.quote(record)}) && Boolean(document.querySelector(${JSONObject.quote(region)}))",
            observe = { remaining -> evaluate(scenario, """
                (()=>{const chat=document.querySelector('.chat-panel');
                  return JSON.stringify({chatPanel:!!chat,shown:chat?.hidden===false,messages:(document.querySelector('.chat-messages')?.textContent??'').slice(0,80),
                    region:!!document.querySelector(${JSONObject.quote(region)}),alert:(chat?.querySelector('[role=alert]')?.textContent??'').slice(0,160),
                    path:(chat?.querySelector('input[required]')?.value??'').length,tabs:document.querySelectorAll('.session-tabs [role=tab]').length});})()
            """, remaining) })
        assertEquals("No Send before the destination is confirmed", "false", evaluate(scenario, hasButton("Send to terminal")))
        pasteOwnedText(scenario, composer, draft, label)
        closeSoftKeyboard()
        assertEquals("Native paste must preserve the exact draft", "true", evaluate(scenario, "document.querySelector(${JSONObject.quote(composer)})?.value===${JSONObject.quote(draft)}"))
        press("Choose terminal destination")
        // The confirmation names the live display's session, window and pane; choosing alone never enables Send.
        awaitDocument(scenario, "tmux destination names the displayed window", """
            (()=>{const rows=Array.from(document.querySelectorAll(${JSONObject.quote("$region dl")}));if(rows.length!==1)return false;
              const text=Array.from(rows[0].children).map(x=>x.textContent.trim());
              return text.join('|').includes(${JSONObject.quote("tmux session|$session|tmux window|${shown.getString("name")}|")}) && ${hasButton("Confirm this destination")};})()
        """)
        assertEquals("Choosing the destination must not enable Send", "false", evaluate(scenario, hasButton("Send to terminal")))
        press("Confirm this destination")
        awaitDocument(scenario, "explicit tmux destination binding", hasButton("Send to terminal"))
        press("Send to terminal")
        awaitDocument(scenario, "tmux delivery acknowledged",
            "Array.from(document.querySelectorAll('[role=status]')).some(x=>x.textContent==='Text and Enter sent to the confirmed pane.')")
        assertEquals("Only the acknowledged draft is cleared", "true", evaluate(scenario, "document.querySelector(${JSONObject.quote(composer)})?.value===''"))
        sessionView(scenario, "Terminal")
    }

    private fun awaitNativeMultiplexerSurface(scenario: ActivityScenario<MainActivity>, stage: String) {
        awaitDocument(scenario, stage, """
            (() => {
              const pane = Array.from(document.querySelectorAll('.terminal-pane')).find(p => p.getClientRects().length && p.getBoundingClientRect().width > 0);
              return Boolean(pane?.querySelector(".terminal-canvas[data-terminal-surface='native']")) && !pane.querySelector('.xterm-screen');
            })()
        """)
    }

    /**
     * tmux copy mode through the packaged UI. The prefix shortcut "Copy mode" enters it on the displayed pane; native keys
     * then move onto the marker line, select it and copy it. tmux answers with an OSC 52 write, which the terminal holds for
     * consent, so the line reaches the system clipboard only after a real tap on Allow. The host proves the pane's copy mode
     * and the buffer tmux copied.
     */
    private fun nativeTmuxText(): String? {
        val session = PageDriver.onActivity { TerminalSurfaces.ids().singleOrNull() } ?: return null
        val result = PageDriver.invoke("terminal_core_text", "{sessionId:${JSONObject.quote(session)}}")
        return JSONTokener(result).nextValue() as? String
    }

    private fun verifyTmuxCopyMode(scenario: ActivityScenario<MainActivity>, marker: String, native: Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        fun copied(): String? {
            val text = AtomicReference<String?>()
            instrumentation.runOnMainSync { text.set(clipboard.primaryClip?.getItemAt(0)?.coerceToText(instrumentation.targetContext)?.toString()) }
            return text.get()
        }
        // A selected line carries its newline.
        val line = "$marker\n"
        fun awaitCopyMode(shown: Boolean) {
            val stage = if (shown) "tmux copy mode shows its position indicator" else "tmux copy leaves copy mode"
            if (native) PageDriver.poll(stage, 45) {
                nativeTmuxText()?.takeIf { it.isNotBlank() && it.contains("[0/0]") == shown }
            } else {
                val indicator = terminalScreenContains("[0/0]")
                awaitDocument(scenario, stage, if (shown) indicator else "!($indicator)")
            }
        }
        /** A real finger tap at the middle of the one matching element, hit-tested so a covering view cannot take it. */
        fun tap(elements: String) {
            val css = JSONArray(evaluate(scenario, """
                (()=>{const matches=$elements;if(matches.length!==1||matches[0].disabled)throw Error('Owned enabled tap target required');
                  const rect=matches[0].getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
                  if(!matches[0].contains(document.elementFromPoint(x,y)))throw Error('Owned tap hit target required');
                  return [x,y,innerWidth];})()
            """))
            fun coordinates(view: View): FloatArray {
                val origin = IntArray(2)
                view.getLocationOnScreen(origin)
                val scale = view.width / css.getDouble(2)
                return floatArrayOf((origin[0] + css.getDouble(0) * scale).toFloat(), (origin[1] + css.getDouble(1) * scale).toFloat())
            }
            if (native) {
                val point = PageDriver.onActivity { activity -> coordinates(checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView))) }
                assertTrue("the device tapped the owned target", UiDevice.getInstance(instrumentation).click(point[0].roundToInt(), point[1].roundToInt()))
            } else {
                onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE, ::coordinates, Press.FINGER))
            }
        }
        sessionView(scenario, "Sessions")
        val region = "section[aria-label='tmux prefix shortcuts']"
        val ready = "Array.from(document.querySelectorAll(${JSONObject.quote("$region button")})).filter(x=>x.textContent.trim()==='Copy mode' && !x.disabled).length===1"
        awaitDocument(scenario, "tmux Copy mode shortcut ready", ready)
        onWebView().withElement(findElement(Locator.XPATH, "//section[@aria-label='tmux prefix shortcuts']//button[normalize-space(.)='Copy mode']"))
            .perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "tmux Copy mode shortcut sent", "$ready && !document.querySelector(${JSONObject.quote("$region [role=alert]")})")
        sessionView(scenario, "Terminal")
        awaitCopyMode(true)
        val screen = if (native) ".terminal-canvas[data-terminal-surface='native']" else ".xterm-screen"
        tap("Array.from(document.querySelectorAll('.terminal-pane')).filter(p=>p.style.display!=='none').map(p=>p.querySelector(${JSONObject.quote(screen)}))")
        val connection = if (native) {
            val editor = PageDriver.poll("the native terminal input owns focus", 30) {
                PageDriver.onActivity { activity ->
                    val frame = EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup
                    frame?.let { (0 until it.childCount).map(it::getChildAt).filterIsInstance<TerminalInputView>().singleOrNull(View::hasFocus) }
                }
            }
            PageDriver.onActivity { checkNotNull(editor.onCreateInputConnection(EditorInfo())) }
        } else {
            awaitDocument(scenario, "tmux terminal input focused", "document.activeElement===Array.from(document.querySelectorAll('.terminal-pane')).find(p=>p.style.display!=='none')?.querySelector('.xterm-helper-textarea')")
            null
        }
        // The cursor starts below the marker: k moves onto it, V selects the line and Enter copies it and leaves copy mode.
        // One key at a time: tmux 3.4 did not copy when those three keys arrived in a single write.
        fun press(text: String, code: Int, shift: Boolean = false) {
            if (connection != null) {
                PageDriver.onActivity { assertTrue("the native editor accepted its input", connection.commitText(text, 1)) }
            } else {
                onView(isAssignableFrom(WebView::class.java)).perform(pressKey(EspressoKey.Builder().withKeyCode(code).withShiftPressed(shift).build()))
            }
            Thread.sleep(150)
        }
        press("k", KeyEvent.KEYCODE_K)
        press("V", KeyEvent.KEYCODE_V, shift = true)
        press("\n", KeyEvent.KEYCODE_ENTER)
        awaitDocument(scenario, "tmux copy reaches the remote clipboard request",
            "Array.from(document.querySelectorAll('[role=region]')).some(x=>x.getAttribute('aria-label')==='Remote clipboard request' && x.textContent.includes(${JSONObject.quote(marker)}))")
        assertTrue("The copied line must not reach the clipboard before Allow", copied() != line)
        // navigator.clipboard.writeText needs the user activation of a real touch, which a scripted click does not give.
        closeSoftKeyboard()
        tap("Array.from(document.querySelectorAll('button')).filter(x=>x.textContent.trim()==='Allow this copy')")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (copied() != line) {
            assertTrue("Allow did not write the copied tmux line to the system clipboard", System.nanoTime() < deadline)
            Thread.sleep(100)
        }
        // With the IME and consent open, the native viewport can shrink to a blank row.
        awaitCopyMode(false)
        // SystemUI previews a copied clip over the bottom-left for a few seconds; wait it out before the next tap.
        awaitClipboardPreviewGone(System.nanoTime())
        println("lazysh tmux: copy mode entered from its shortcut, a line copied and the system clipboard written after Allow")
    }

    // The host runs a hook-reporting stand-in agent in the displayed tmux pane, which reports to the real companion as Claude Code's
    // hooks do. This case drives only the packaged UI: a prompt typed through the Android terminal input starts a held turn, the
    // Agent view follows it, Terminal, Agent and Terminal keep the same xterm node, a prompt sent from the Agent view composer and
    // another typed one each become a turn, and Android Back from the Agent view returns to that terminal. The host then reads the
    // agent's own logs for one delivery of each prompt and no other key.
    private fun verifyOwnedTmuxAgentView(scenario: ActivityScenario<MainActivity>, tmux: JSONObject, parent: String, label: String) {
        val server = tmux.getString("name")
        require(server == "owned-tmux") { "Owned tmux fixture required" }
        val agent = tmux.getJSONObject("agent")
        val hold = agent.getString("hold")
        val sent = agent.getString("sent")
        val typed = agent.getString("typed")
        for (prompt in listOf(hold, sent, typed)) require(Regex("(hold|send|type) [a-f0-9]{8}").matches(prompt))
        val child = "$parent / $server"
        val view = "section.agent-view:not([hidden])"
        val turns = "$view section.agent-turn"
        val pane = "Array.from(document.querySelectorAll('.terminal-pane')).find(p=>p.style.display!=='none')"
        fun switchTo(name: String) = onWebView().withElement(findElement(Locator.XPATH,
            "//div[@role='group' and @aria-label='Session view']/button[@aria-label='$name']")).perform(webScrollIntoView()).perform(webClick())
        fun turnTexts() = "Array.from(document.querySelectorAll(${JSONObject.quote(turns)})).map(x=>x.textContent)"
        fun observeAgentView(remaining: Long) = evaluate(scenario, """JSON.stringify({view:!!document.querySelector(${JSONObject.quote(view)}),
            header:(document.querySelector(${JSONObject.quote("$view header")})?.textContent??'').slice(0,80),
            turns:${turnTexts()}.map(x=>x.slice(0,80)),pane:!!($pane)})""", remaining)
        // Terminal: the one original xterm node is visible again with the scroll height it had before the Agent view.
        fun terminalOriginal(height: String) = """(()=>{const node=document.querySelector('.xterm[data-agent-view-original]'),shown=node?.closest('.terminal-pane');
            return !!shown && shown.style.display!=='none' && !document.querySelector(${JSONObject.quote(view)}) &&
              document.querySelectorAll('.session-tabs [role=tab]').length===2 && shown.querySelector('.xterm-scroll-area')?.style.height===$height;})()"""
        fun typeInTerminal(text: String, stage: String) {
            // Only the shown pane takes the typing; the connection's own terminal stays hidden behind the tmux display.
            val focused = "document.activeElement?.classList.contains('xterm-helper-textarea')===true && document.activeElement.closest('.terminal-pane')?.style.display!=='none'"
            // Android Back and leaving the composer can leave the WebView without native focus, which native typing requires.
            scenario.onActivity { activity ->
                val web = requireNotNull(webView(activity.window.decorView))
                if (!web.hasFocus()) assertTrue("Native WebView focus was denied", web.requestFocus())
            }
            fun tap() = onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".terminal-pane[style*='display: flex'] .xterm-screen")).perform(webClick())
            if (evaluate(scenario, focused) != "true") tap()
            awaitDocument(scenario, "terminal input focused to type $stage", focused)
            // DOM focus can outlive the keyboard's input connection after Back; one more tap on the pane restores it.
            val typing = typeTextIntoFocusedView(text)
            val typingDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            var tapped = false
            while (true) {
                var ready = false
                scenario.onActivity { activity -> ready = typing.constraints.matches(requireNotNull(webView(activity.window.decorView))) }
                if (ready) break
                assertTrue("Native typing constraints did not become ready to type $stage", System.nanoTime() < typingDeadline)
                if (!tapped) { tapped = true; tap() }
                Thread.sleep(25)
            }
            onView(isAssignableFrom(WebView::class.java)).perform(typing, pressKey(KeyEvent.KEYCODE_ENTER))
            closeSoftKeyboard()
            awaitDocument(scenario, "the pane shows the prompt typed $stage", terminalScreenContains("> $text"))
        }
        sessionView(scenario, "Sessions")
        val attach = "Attach $server"
        awaitDocument(scenario, "live tmux session discovered for the agent pane", """
            Array.from(document.querySelectorAll('.multiplexer-panel button')).some(x=>x.textContent.trim()===${JSONObject.quote(attach)} && !x.disabled)""")
        onWebView().withElement(findElement(Locator.XPATH, "//section[contains(@class,'multiplexer-panel')]//button[normalize-space(.)='$attach']"))
            .perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "owned tmux display of the agent pane attached", """
            (()=>{const tabs=document.querySelectorAll('.session-tabs [role=tab]');
              return tabs.length===2 && tabs[1].textContent.trim()===${JSONObject.quote(child)} && tabs[1].getAttribute('aria-selected')==='true';})()""")
        sessionView(scenario, "Terminal")
        awaitDocument(scenario, "the reporting agent drew its pane", terminalScreenContains("manual mode on"))
        // The node and scroll height the Agent view must give back; Android Back and the Terminal control both return to them.
        val height = evaluate(scenario, """(()=>{const shown=$pane,node=shown?.querySelector('.xterm');if(!node)return '';
            node.dataset.agentViewOriginal='';return shown.querySelector('.xterm-scroll-area')?.style.height??'';})()""")
        require(height.length > 2 && height.startsWith("\"")) { "The reporting agent terminal must be shown before the Agent view" }
        typeInTerminal(hold, "to start a held turn")
        switchTo("Agent")
        awaitDocument(scenario, "the Agent view follows the running turn of the reporting pane", """
            (()=>{const turns=document.querySelectorAll(${JSONObject.quote(turns)});
              return turns.length===1 && turns[0].getAttribute('data-running')==='true' && turns[0].textContent.includes(${JSONObject.quote(hold)}) &&
                (document.querySelector(${JSONObject.quote("$view header")})?.textContent??'').includes('Working') && !($pane);})()""", observe = ::observeAgentView)
        switchTo("Terminal")
        awaitDocument(scenario, "Terminal after the mid-turn Agent view shows the same xterm node", terminalOriginal(height))
        switchTo("Agent")
        awaitDocument(scenario, "the Agent view again follows the still running turn", """
            (()=>{const turns=document.querySelectorAll(${JSONObject.quote(turns)});
              return turns.length===1 && turns[0].getAttribute('data-running')==='true';})()""", observe = ::observeAgentView)
        // The composer sends to the bound pane; the next prompt also ends the held turn.
        val composer = "$view textarea[aria-label='Draft for this terminal']"
        val send = "$view button[aria-label='Send to the agent']"
        pasteOwnedText(scenario, composer, sent, label)
        closeSoftKeyboard()
        // The keyboard can keep the pasted last word as an open composition, which the composer answers with Send off until it ends
        // (observed on Waydroid: compositionstart and compositionupdate, never compositionend). Leaving the field ends it.
        evaluate(scenario, "(()=>{document.activeElement?.blur();return true;})()")
        assertEquals("Native paste must preserve the exact prompt", "true", evaluate(scenario, "document.querySelector(${JSONObject.quote(composer)})?.value===${JSONObject.quote(sent)}"))
        awaitDocument(scenario, "the Agent view composer is bound to the pane", "Boolean(document.querySelector(${JSONObject.quote(send)}) && !document.querySelector(${JSONObject.quote(send)}).disabled)",
            observe = { remaining -> evaluate(scenario, """(()=>{const row=document.querySelector(${JSONObject.quote("$view .agent-composer")});
                const button=row?.querySelector('button[type=submit]');
                return JSON.stringify({button:button?.getAttribute('aria-label')??null,disabled:button?.disabled??null,
                  draft:(row?.querySelector('textarea')?.value??'').length,
                  notes:Array.from(row?.querySelectorAll('[role=status],[role=alert]')??[]).map(x=>x.textContent.slice(0,120)),
                  header:(document.querySelector(${JSONObject.quote("$view header")})?.textContent??'').slice(0,80),
                  active:document.activeElement?.tagName+':'+(document.activeElement?.getAttribute('aria-label')??'')});})()""", remaining) })
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, send)).perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "the sent prompt became a turn and the held turn ended", """
            (()=>{const texts=${turnTexts()},running=document.querySelectorAll(${JSONObject.quote("$turns[data-running=true]")}).length;
              return texts.length===2 && running===0 && texts[0].includes('Finished the held work.') && texts[1].includes(${JSONObject.quote("Answered: $sent")});})()""", observe = ::observeAgentView)
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
        awaitDocument(scenario, "Android Back from the bound Agent view shows the same terminal and node", terminalOriginal(height))
        // The pane shows the sent prompt once; the agent's own log counts the deliveries.
        assertEquals("The prompt sent from the Agent view must show once in the pane", "true", evaluate(scenario,
            "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.split(${JSONObject.quote("> $sent")}).length===2)"))
        typeInTerminal(typed, "after the Agent view")
        switchTo("Agent")
        // One follow interval is 2 s; the SSH exec round trip and the shared runner's slack stay inside five.
        awaitDocument(scenario, "the typed prompt became a turn within one follow interval", """
            ${turnTexts()}.length===3 && ${turnTexts()}[2].includes(${JSONObject.quote("Answered: $typed")})""",
            deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5), observe = ::observeAgentView)
        UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
        awaitDocument(scenario, "Android Back after the typed turn shows the same terminal and node", terminalOriginal(height))
        println("lazysh tmux Agent view: a mid-turn switch, a sent prompt, a typed prompt and Android Back followed the reporting pane")
        endOwnedConnection(scenario, child)
    }

    // The host harness owns this pinned tmux server and its two pane processes. This
    // case drives only the packaged UI: discovery, attach, Jump To, the numbered
    // window control, confirmed Chat input to the displayed pane, a top/bottom split and zoom of beta's pane
    // from the Sessions panel, a two-finger pinch zoom and unzoom and window swipes on the display,
    // tab-close detach and reattach. The host independently proves the remote
    // window state, the Chat draft in the original pane, that the split left the original pane untouched
    // and the zoom returned, that the gestures changed the zoom flag and active window in order,
    // and that the original server and panes survived.
    private fun verifyOwnedTmux(scenario: ActivityScenario<MainActivity>, tmux: JSONObject, parent: String, label: String, native: Boolean) {
        val server = tmux.getString("name")
        require(server == "owned-tmux") { "Owned tmux fixture required" }
        val windows = tmux.getJSONArray("windows")
        require(windows.length() == 2) { "Owned tmux topology required" }
        val alpha = windows.getJSONObject(0)
        val beta = windows.getJSONObject(1)
        require(alpha.getInt("index") == 0 && alpha.getString("name") == "alpha" && beta.getInt("index") == 1 && beta.getString("name") == "beta")
        for (window in listOf(alpha, beta)) require(Regex("TMUX_(ALPHA|BETA)_[a-f0-9]{32}").matches(window.getString("marker")))
        for (window in listOf(alpha, beta)) require(Regex("%[0-9]{1,9}").matches(window.getString("paneId")))
        val child = "$parent / $server"
        val labels = JSONArray(listOf(parent, child))
        val observer = InstrumentationRegistry.getInstrumentation().context.assets.open("owned-visible-herdr.js").use { it.reader().readText() }
        require(observer.length <= 4096)
        val jumpPanel = "section[aria-label='tmux Jump To']"
        fun title(window: JSONObject) = "${window.getInt("index")}: ${window.getString("name")}"
        fun click(xpath: String) = onWebView().withElement(findElement(Locator.XPATH, xpath)).perform(webScrollIntoView()).perform(webClick())
        // Jump To lists each window's panes under it, and its one Current marker sits on the pane row of the displayed window.
        val jumpMarker = "(panel=>{const rows=Array.from(panel.querySelectorAll('.mux-row')),marked=Array.from(panel.querySelectorAll('.mux-row button[aria-current=location]'))," +
            "row=marked.length===1?marked[0].closest('.mux-row'):null,owner=row?rows.slice(0,rows.indexOf(row)).reverse().find(x=>!x.classList.contains('mux-pane-row')):null;" +
            "return {windows:rows.filter(x=>!x.classList.contains('mux-pane-row')).map(x=>x.textContent.trim()),panes:rows.filter(x=>x.classList.contains('mux-pane-row')).length," +
            "marked:marked.length,onPane:!!row?.classList.contains('mux-pane-row'),owner:owner?.textContent.trim()};})"
        fun visible(target: JSONObject, other: JSONObject, stage: String) {
            sessionView(scenario, "Terminal")
            if (native) {
                awaitNativeMultiplexerSurface(scenario, "the owned attached display uses the native terminal")
                PageDriver.poll(stage, 45) {
                    nativeTmuxText()?.takeIf { it.contains(target.getString("marker")) && !it.contains(other.getString("marker")) }
                }
            } else {
                val forbidden = JSONArray(listOf(other.getString("marker")))
                awaitDocument(scenario, stage, "(()=>{$observer;return ownedVisibleHerdr(document,$labels,1,${JSONObject.quote(target.getString("marker"))},$forbidden);})()")
            }
        }
        // The Workspaces panel lists exactly these windows (title and active mark) in the one session, as read back from the host; `also` adds checks on its `panel`.
        fun panelWindows(expected: List<String>, also: String = "true") = """
            (()=>{const panels=document.querySelectorAll('.tool-panel.multiplexer-panel');if(panels.length!==1)return false;
              const panel=panels[0],sessions=Array.from(panel.querySelectorAll('.mux-list > details'));
              if(panel.querySelector('.loading,[role=alert]') || sessions.length!==1)return false;
              const expected=${JSONArray(expected)},windows=Array.from(sessions[0].querySelectorAll(':scope > details > summary')).map(x=>x.textContent.trim());
              return sessions[0].querySelector(':scope > summary')?.textContent.trim()===${JSONObject.quote("$server · ${expected.size} windows")} &&
                windows.length===expected.length && windows.every((x,i)=>x===expected[i]) && ($also);})()
        """
        fun attach(active: JSONObject, stage: String) {
            sessionView(scenario, "Sessions")
            awaitDocument(scenario, "live tmux sessions discovered $stage", panelWindows(listOf(alpha, beta).map { title(it) + if (it === active) " · active" else "" }, """
                /^tmux \S+ \((?:Supported|Limited)\)/.test(panel.querySelector('p.muted')?.textContent??'') &&
                  (attach=>attach.length===1 && !attach[0].disabled)(Array.from(panel.querySelectorAll('button')).filter(x=>x.textContent.trim()===${JSONObject.quote("Attach $server")}))
            """))
            click("//section[contains(@class,'multiplexer-panel')]//button[normalize-space(.)='Attach $server']")
            awaitDocument(scenario, "owned tmux display attached $stage", """
                (()=>{const tabs=document.querySelectorAll('.session-tabs [role=tab]');
                  return tabs.length===2 && tabs[1].textContent.trim()===${JSONObject.quote(child)} && tabs[1].getAttribute('aria-selected')==='true';})()
            """)
        }
        fun jump(target: JSONObject, current: JSONObject) {
            sessionView(scenario, "Terminal")
            keepTopBar(scenario)
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.XPATH, "//nav[contains(@class,'workspace-navigation-modes')]/button[normalize-space(.)='Workspaces']")).perform(webClick())
            // The current marker must come from the live tmux binding, including a switch made by the numbered control.
            awaitDocument(scenario, "live tmux Jump To marks ${title(current)} current", """
                (()=>{const panels=document.querySelectorAll(${JSONObject.quote(jumpPanel)});
                  if(panels.length!==1 || panels[0].querySelector('[role=status],[role=alert]'))return false;
                  const found=$jumpMarker(panels[0]);
                  return found.windows.length===2 && found.panes===2 && found.marked===1 && found.onPane && found.owner===${JSONObject.quote(title(current))} &&
                    found.windows.includes(${JSONObject.quote(title(target))});})()
            """)
            click("//section[@aria-label='tmux Jump To']//button[normalize-space(.)='${title(target)}']")
            awaitDocument(scenario, "tmux Jump To reached ${title(target)}", """
                (()=>{const panel=document.querySelector(${JSONObject.quote(jumpPanel)});
                  if(!panel)return true;
                  const found=$jumpMarker(panel);
                  return !panel.querySelector('[role=status],[role=alert]') && found.marked===1 && found.onPane && found.owner===${JSONObject.quote(title(target))};})()
            """)
        }
        fun numbered(target: JSONObject) {
            sessionView(scenario, "Sessions")
            val button = "Window ${target.getInt("index")}"
            val region = "section[aria-label='tmux prefix shortcuts']"
            val ready = "Array.from(document.querySelectorAll(${JSONObject.quote("$region button")})).filter(x=>x.textContent.trim()===${JSONObject.quote(button)} && !x.disabled).length===1"
            awaitDocument(scenario, "tmux numbered window control ready", ready)
            click("//section[@aria-label='tmux prefix shortcuts']//button[normalize-space(.)='$button']")
            awaitDocument(scenario, "tmux numbered window control sent", "$ready && !document.querySelector(${JSONObject.quote("$region [role=alert]")})")
        }
        fun detach(stage: String) {
            endOwnedConnection(scenario, child)
            awaitDocument(scenario, "tmux display detached $stage", """
                (()=>{const tabs=document.querySelectorAll('.session-tabs [role=tab]');return tabs.length===1 && tabs[0].textContent.trim()===${JSONObject.quote(parent)};})()
            """)
            if (evaluate(scenario, "document.querySelector('.session-tabs [role=tab]')?.getAttribute('aria-selected')==='true'") != "true") {
                if (evaluate(scenario, workspaceElementVisible("button.mobile-tools", true)) == "true") selectOwnedConnection(scenario, parent)
                else onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".session-tabs .session-tab:nth-child(1) [role=tab]")).perform(webScrollIntoView()).perform(webClick())
            }
        }
        // The Sessions panel lists each window's panes; the ids it shows are tmux's own, read after the action ran.
        val betaPanes = """
            (()=>{const window=Array.from(document.querySelectorAll('.tool-panel.multiplexer-panel .mux-list > details > details'))
              .find(x=>(x.querySelector(':scope > summary')?.textContent??'').trim().startsWith(${JSONObject.quote(title(beta))}));
              return window ? Array.from(window.querySelectorAll(':scope > .mux-row strong')).map(x=>x.textContent.trim().split(' · ')[1]) : [];})()
        """
        // The panel rereads the host when the Sessions view opens, so a pane button exists only once that read finished.
        fun clickPaneButton(label: String) {
            awaitDocument(scenario, "tmux pane control $label ready",
                "Array.from(document.querySelectorAll('section.multiplexer-panel button')).filter(x=>x.textContent.trim()===${JSONObject.quote(label)} && !x.disabled).length===1")
            click("//section[contains(@class,'multiplexer-panel')]//button[normalize-space(.)='$label']")
        }
        // The display is the real tmux client: a zoomed pane fills it, so beta's marker (printed by the original pane) leaves the screen.
        fun markerOnScreen(shown: Boolean, stage: String) {
            sessionView(scenario, "Terminal")
            awaitDocument(scenario, stage, """
                (()=>{const visible=n=>n.getClientRects().length>0&&n.getBoundingClientRect().width>0;
                  const panes=Array.from(document.querySelectorAll('.terminal-pane')).filter(visible);
                  const screens=panes.length===1?Array.from(panes[0].querySelectorAll('.xterm-screen')).filter(visible):[];
                  // A screen that is not painted yet has no text at all, so a missing marker on it proves nothing.
                  return screens.length===1 && screens[0].textContent.trim().length>0 &&
                    screens[0].textContent.includes(${JSONObject.quote(beta.getString("marker"))})===$shown;})()
            """) { ms -> evaluate(scenario, """(()=>{const visible=n=>n.getClientRects().length>0&&n.getBoundingClientRect().width>0;
                const panes=Array.from(document.querySelectorAll('.terminal-pane')).filter(visible);
                const screens=panes.length===1?Array.from(panes[0].querySelectorAll('.xterm-screen')).filter(visible):[];
                return [panes.length,screens.length,screens[0]?.textContent.trim().length>0,
                  screens[0]?.textContent.includes(${JSONObject.quote(beta.getString("marker"))})].join('|');})()""", ms) }
        }
        // Split writes a second pane under beta's original one; the panel's refreshed tree is the witness that the action ran.
        fun splitBeta(): String {
            val original = beta.getString("paneId")
            sessionView(scenario, "Sessions")
            awaitDocument(scenario, "tmux ${title(beta)} lists only its original pane", "JSON.stringify($betaPanes)===${JSONObject.quote("[\"$original\"]")}")
            clickPaneButton("Split $original top/bottom")
            awaitDocument(scenario, "tmux split adds a second pane to ${title(beta)}", "(()=>{const ids=$betaPanes;return ids.length===2 && ids.includes(${JSONObject.quote(original)});})()")
            val added = evaluate(scenario, "$betaPanes.find(id=>id!==${JSONObject.quote(original)})").trim('"')
            require(Regex("%[0-9]{1,9}").matches(added) && added != original) { "tmux split must add a distinct pane" }
            markerOnScreen(true, "tmux split keeps the original pane's output on the display")
            return added
        }
        // Zoom toggles: the zoomed pane fills the whole display and the toggle returns the split layout.
        fun zoomPane(pane: String, zoomed: Boolean) {
            sessionView(scenario, "Sessions")
            clickPaneButton("Zoom $pane")
            markerOnScreen(!zoomed, if (zoomed) "tmux zoom of $pane hides the original pane's output" else "tmux zoom toggle shows the original pane's output again")
        }
        // Agent view is another view of this same tmux display: Android back returns to its terminal,
        // the same xterm node with the same scrollback height, without reattaching.
        fun agentViewBack() {
            val terminal = "Array.from(document.querySelectorAll('.terminal-pane')).find(p=>p.style.display!=='none')"
            val before = evaluate(scenario, """(()=>{const pane=$terminal,x=pane?.querySelector('.xterm');if(!x)return '';
                x.dataset.agentViewOriginal='';return pane.querySelector('.xterm-scroll-area')?.style.height??'';})()""")
            // evaluateJavascript returns the height already as a JSON string literal.
            require(before.length > 2 && before.startsWith("\"")) { "Owned tmux terminal must be shown before the Agent view" }
            click("//div[@role='group' and @aria-label='Session view']/button[@aria-label='Agent']")
            awaitDocument(scenario, "Agent view replaces the visible tmux terminal", """
                (()=>{const pane=document.querySelector('.xterm[data-agent-view-original]')?.closest('.terminal-pane');
                  return !!pane && pane.style.display==='none' && Boolean(document.querySelector('section.agent-view:not([hidden])'));})()
            """)
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).pressBack()
            awaitDocument(scenario, "Android back from the Agent view shows the same terminal and scrollback", """
                (()=>{const pane=document.querySelector('.xterm[data-agent-view-original]')?.closest('.terminal-pane');
                  const pressed=Array.from(document.querySelectorAll("[aria-label='Session view'] button[aria-pressed=true]")).map(x=>x.getAttribute('aria-label'));
                  return !!pane && pane.style.display!=='none' && !document.querySelector('section.agent-view:not([hidden])') &&
                    pressed.length===1 && pressed[0]==='Terminal' && document.querySelectorAll('.session-tabs [role=tab]').length===2 &&
                    pane.querySelector('.xterm-scroll-area')?.style.height===$before;})()
            """) { ms -> evaluate(scenario, """(()=>{const pane=document.querySelector('.xterm[data-agent-view-original]')?.closest('.terminal-pane');
                return [pane?.style.display, !!document.querySelector('section.agent-view:not([hidden])'), document.querySelector("[aria-label='Session view'] button[aria-pressed=true]")?.getAttribute('aria-label'),
                  pane?.querySelector('.xterm-scroll-area')?.style.height, $before].join('|');})()""", ms) }
        }
        // One more window through the real UI, named by the host fixture: New window and Rename window in the Workspaces panel, then a held finger on its tab-strip
        // chip, Close and the confirmation. The host reads each state from its own tmux tree; the original windows stay listed.
        fun windowLifecycle(created: String, renamed: String) {
            val originals = listOf(alpha, beta).map { title(it) + if (it === beta) " · active" else "" }
            fun listed(vararg extra: String, stage: String) {
                sessionView(scenario, "Sessions")
                awaitDocument(scenario, stage, panelWindows(originals + extra))
            }
            fun chip(name: String) = ".mux-strip .mux-chip[title=${JSONObject.quote(name)}]"
            fun stripShows(name: String, shown: Boolean, stage: String) {
                sessionView(scenario, "Terminal")
                awaitDocument(scenario, stage, if (shown) present(chip(name)) else "!${present(chip(name))}")
            }
            fun nameWindow(open: String, name: String, stage: String) {
                click("//section[contains(@class,'multiplexer-panel')]$open")
                val field = "form[aria-label='Workspace details'] input[maxlength='200']"
                awaitDocument(scenario, "$stage form open", present(field)) { ms ->
                    evaluate(scenario, "JSON.stringify({forms:Array.from(document.querySelectorAll('form')).map(x=>x.getAttribute('aria-label')),panel:document.querySelector('.multiplexer-panel')?.innerText?.slice(0,400)})", ms)
                }
                replaceNativeText(scenario, field, name)
                closeSoftKeyboard()
                click("//form[@aria-label='Workspace details']//button[normalize-space(.)='Save workspace']")
            }
            listed(stage = "two windows listed before the extra one")
            // The prefix shortcuts also have a New window key; the session's own button is in the list.
            nameWindow("//div[contains(@class,'mux-list')]//button[normalize-space(.)='New window']", created, "New window")
            listed("2: $created", stage = "Workspaces panel lists the created window")
            stripShows(created, true, "tab strip shows the created window")
            listed("2: $created", stage = "Workspaces panel again lists the created window")
            nameWindow("//details[summary[starts-with(normalize-space(.),'2: $created')]]//button[normalize-space(.)='Rename window']", renamed, "Rename window")
            listed("2: $renamed", stage = "Workspaces panel lists the renamed window")
            stripShows(renamed, true, "tab strip shows the renamed window")
            stripShows(created, false, "tab strip no longer shows the old name")
            // The strip's own actions need a long press: a real finger held past its half second, then the menu's Close and the confirmation that names the window.
            awaitDocument(scenario, "tab strip chip touchable", workspaceElementVisible(chip(renamed), true))
            holdFinger(scenario, chip(renamed), 900)
            awaitDocument(scenario, "tab strip menu opened by the held finger", present(".mux-strip .mux-menu"))
            click("//div[contains(@class,'mux-menu')]//button[normalize-space(.)='Close']")
            awaitDocument(scenario, "tab strip confirmation names the window", "document.querySelector('.mux-strip [role=alertdialog]')?.textContent.includes(${JSONObject.quote(renamed)})===true")
            click("//div[@role='alertdialog']//button[normalize-space(.)='Close']")
            stripShows(renamed, false, "tab strip no longer shows the closed window")
            listed(stage = "Workspaces panel lists only the original windows again")
        }
        // Two real fingers on the attached display run the default gestures against the real tmux client behind it. The split's pane is beta's active pane (the
        // Sessions panel's zoom made it so), so a pinch zooms it and hides beta's original marker, a second pinch returns it, then a two-finger swipe left selects
        // the next window and a swipe right the previous one. Each state is held long enough for the host's tmux sampler (about every 100 ms) to read the active window and zoom flag.
        fun gestures() {
            val canvas = "Array.from(document.querySelectorAll('.terminal-pane')).filter(p=>p.style.display!=='none').map(p=>p.querySelector('.terminal-canvas')).find(Boolean)"
            fun at(vararg points: Double) = listOf(doubleArrayOf(points[0], points[1]), doubleArrayOf(points[2], points[3]))
            val together = at(-40.0, 0.0, 40.0, 0.0)
            val apart = at(-110.0, 0.0, 110.0, 0.0)
            fun swipe(dx: Double) = twoFingerGesture(scenario, canvas, together, at(-40.0 + dx, 0.0, 40.0 + dx, 0.0))
            val seen = 1_000L
            markerOnScreen(true, "beta's original pane shown before the pinch")
            twoFingerGesture(scenario, canvas, together, apart)
            markerOnScreen(false, "a pinch out zooms the split pane")
            Thread.sleep(seen)
            twoFingerGesture(scenario, canvas, apart, together)
            markerOnScreen(true, "a second pinch returns the split layout")
            Thread.sleep(seen)
            swipe(-120.0)
            visible(alpha, beta, "a two-finger swipe left shows the next window")
            Thread.sleep(seen)
            swipe(120.0)
            visible(beta, alpha, "a two-finger swipe right returns to beta")
        }
        val lifecycle = tmux.getJSONArray("lifecycle")
        require(lifecycle.length() == 2) { "Owned tmux window names required" }
        var primaryFailure: Throwable? = null
        try {
            attach(alpha, "before detach")
            visible(alpha, beta, "attached tmux shows its current window")
            if (!native) {
                agentViewBack()
                visible(alpha, beta, "Android back from the Agent view keeps the tmux window")
            }
            // Copy mode first: it needs the marker line right above the cursor, before Chat input adds lines to this pane.
            verifyTmuxCopyMode(scenario, alpha.getString("marker"), native)
            visible(alpha, beta, "tmux copy mode leaves the displayed window in place")
            // Chat input returns to the pane this display shows (alpha), and the host reads that pane back by id.
            if (!native) {
                tmux.optJSONObject("chat")?.let { verifyOwnedTmuxChat(scenario, it, alpha, server, label) }
                visible(alpha, beta, "Chat input leaves the displayed tmux window in place")
            }
            jump(beta, alpha)
            visible(beta, alpha, "tmux Jump To shows the selected window")
            numbered(alpha)
            visible(alpha, beta, "tmux numbered window control shows its window")
            jump(beta, alpha)
            visible(beta, alpha, "tmux Jump To returns to the selected window")
            if (native) {
                detach("after native controls")
                return
            }
            val added = splitBeta()
            zoomPane(added, zoomed = true)
            detach("by closing its tab")
            attach(beta, "after detach")
            // The zoom belongs to the host's window, so the reattached display still shows only the zoomed pane.
            markerOnScreen(false, "reattached tmux keeps the zoomed pane")
            zoomPane(added, zoomed = false)
            visible(beta, alpha, "reattached tmux shows the same selected window and pane")
            windowLifecycle(lifecycle.getString(0), lifecycle.getString(1))
            visible(beta, alpha, "the created, renamed and closed window leaves the original window shown")
            gestures()
            detach("after reattach")
            println("lazysh tmux: live discovery, Jump To current marker, numbered window, copy mode and a copied line, a created, renamed and closed window, split, zoom, a pinch zoom and unzoom, two-finger window swipes, tab-close detach and reattach completed")
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            closeOwnedDisplay(scenario, child, primaryFailure)
        }
    }

    // The host harness owns this pinned Zellij session and the command pane of each of its two tabs. This case drives only the
    // packaged UI: product discovery, the session list, attach, the numbered tab control, tab-close detach and reattach. While it
    // runs, the host reads the active tab back with `zellij action list-tabs --json` and afterwards proves that the original panes
    // were never restarted.
    private fun verifyOwnedZellij(scenario: ActivityScenario<MainActivity>, zellij: JSONObject, parent: String, native: Boolean) {
        val session = zellij.getString("name")
        require(Regex("owned-zellij-[a-f0-9]{12}").matches(session)) { "Owned Zellij fixture required" }
        val tabs = zellij.getJSONArray("tabs")
        require(tabs.length() == 2) { "Owned Zellij topology required" }
        val alpha = tabs.getJSONObject(0)
        val beta = tabs.getJSONObject(1)
        require(alpha.getInt("position") == 0 && alpha.getString("name") == "alpha" && beta.getInt("position") == 1 && beta.getString("name") == "beta")
        for (tab in listOf(alpha, beta)) require(Regex("ZELLIJ_(ALPHA|BETA)_[a-f0-9]{32}").matches(tab.getString("marker")))
        val child = "$parent / $session"
        val observer = InstrumentationRegistry.getInstrumentation().context.assets.open("owned-visible-herdr.js").use { it.reader().readText() }
        require(observer.length <= 4096)
        val panel = "section.multiplexer-panel"
        val panelPath = "//section[contains(@class,'multiplexer-panel')]"
        val controls = "section[aria-label='Zellij $session controls']"
        val quote = JSONObject::quote
        fun button(root: String, label: String) = "Array.from(document.querySelectorAll(${quote("$root button")})).filter(x=>x.textContent.trim()===${quote(label)} && !x.disabled).length===1"
        fun clickButton(xpathRoot: String, label: String) =
            onWebView().withElement(findElement(Locator.XPATH, "$xpathRoot//button[normalize-space(.)='$label']")).perform(webScrollIntoView()).perform(webClick())
        // The Sessions panel names the pinned Zellij after product discovery and lists exactly this one session on request.
        fun listSessions(stage: String) {
            sessionView(scenario, "Sessions")
            awaitDocument(scenario, "Zellij discovered $stage", """
                (()=>{const panels=document.querySelectorAll(${quote(panel)});
                  return panels.length===1 && !panels[0].querySelector('.loading,[role=alert]') &&
                    /Zellij 0\.45\.1 \(Supported\)/.test(panels[0].querySelector('p.muted')?.textContent??'') && ${button(panel, "List zellij sessions")};})()
            """)
            clickButton(panelPath, "List zellij sessions")
            awaitDocument(scenario, "Zellij session listed $stage", """
                (()=>{const found=document.querySelector(${quote(panel)});
                  if(!found || found.querySelector('.loading,[role=alert]'))return false;
                  const rows=Array.from(found.querySelectorAll('.mux-row strong')).map(x=>x.textContent.trim()).filter(x=>x.startsWith('zellij: '));
                  return rows.length===1 && rows[0]===${quote("zellij: $session")} && ${button(panel, "Attach zellij $session")};})()
            """)
        }
        fun attach(stage: String) {
            listSessions("before $stage")
            clickButton(panelPath, "Attach zellij $session")
            awaitDocument(scenario, "Zellij display attached $stage", """
                (()=>{const open=document.querySelectorAll('.session-tabs [role=tab]');
                  return open.length===2 && open[1].textContent.trim()===${quote(child)} && open[1].getAttribute('aria-selected')==='true';})()
            """)
        }
        // The visible display is the real Zellij client of the selected tab: its own marker is on screen and the other tab's is not.
        fun shows(target: JSONObject, other: JSONObject, stage: String) {
            sessionView(scenario, "Terminal")
            if (native) {
                awaitNativeMultiplexerSurface(scenario, "the selected Zellij tab uses the native surface")
                PageDriver.poll(stage, 45) {
                    var id: String? = null
                    scenario.onActivity { id = TerminalSurfaces.ids().singleOrNull() }
                    id?.let {
                        val result = PageDriver.invoke("terminal_core_text", "{sessionId:${quote(it)}}") { script ->
                            evaluate(scenario, script)
                        }
                        // A pinned tab paints its marker on one logical line, which can wrap on narrow panes.
                        (JSONTokener(result).nextValue() as? String)?.replace("\n", "")?.takeIf { text ->
                            text.contains(target.getString("marker")) && !text.contains(other.getString("marker"))
                        }
                    }
                }
            } else {
                awaitDocument(scenario, stage, "(()=>{$observer;return ownedVisibleHerdr(document,${JSONArray(listOf(parent, child))},1,${quote(target.getString("marker"))},${JSONArray(listOf(other.getString("marker")))});})()")
            }
        }
        // Control opens the quick-tab buttons of this session; the status line confirms the action reached Zellij.
        fun numbered(target: JSONObject) {
            val label = "Tab ${target.getInt("position") + 1}"
            listSessions("before $label")
            clickButton(panelPath, "Control Zellij $session")
            awaitDocument(scenario, "Zellij $label control ready", button(controls, label))
            clickButton("//section[@aria-label='Zellij $session controls']", label)
            awaitDocument(scenario, "Zellij $label sent", """
                ${button(controls, label)} && !document.querySelector(${quote("$controls [role=alert]")}) &&
                  document.querySelector(${quote("$controls [role=status]")})?.textContent.trim()===${quote("Action sent to Zellij.")}
            """)
        }
        fun detach(stage: String) {
            endOwnedConnection(scenario, child)
            awaitDocument(scenario, "Zellij display detached $stage", """
                (()=>{const open=document.querySelectorAll('.session-tabs [role=tab]');return open.length===1 && open[0].textContent.trim()===${quote(parent)};})()
            """)
            if (evaluate(scenario, "document.querySelector('.session-tabs [role=tab]')?.getAttribute('aria-selected')==='true'") != "true") selectOwnedConnection(scenario, parent)
        }
        var primaryFailure: Throwable? = null
        try {
            attach("first")
            shows(alpha, beta, "attached Zellij shows its first tab")
            numbered(beta)
            shows(beta, alpha, "Zellij numbered Tab 2 shows its tab")
            detach("by closing its tab")
            attach("again")
            shows(beta, alpha, "reattached Zellij shows the same selected tab")
            numbered(alpha)
            shows(alpha, beta, "Zellij numbered Tab 1 shows its tab")
            detach("after the second attach")
            println("lazysh Zellij: live discovery, session list, attach, numbered tabs, tab-close detach and reattach completed")
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            closeOwnedDisplay(scenario, child, primaryFailure)
        }
    }

    // The saved create-if-missing default (#1764): a second saved host of the same owned sshd whose Default multiplexer is tmux, named for a
    // session the owned server lacks. Connecting through the real host editor and connect flow must create and show that session, and after
    // its connection ends, connecting again must attach the same one. The host independently proves one session created once in the login
    // directory, attached, detached and attached again, with the original session and panes untouched. Saving the host copies the first host's
    // pin for the same address and port, so no second fingerprint review follows.
    private fun verifyOwnedTmuxDefault(scenario: ActivityScenario<MainActivity>, fixture: JSONObject, parent: String, label: String) {
        val session = fixture.getJSONObject("tmux").getString("defaultName")
        // tmux's status line names the session in its first ten columns: `[` + name + `]`.
        require(Regex("[A-Za-z0-9_-]{1,7}").matches(session) && session != fixture.getJSONObject("tmux").getString("name")) { "Owned tmux default session name required" }
        val host = "$parent default"
        val child = "$host / $session"
        fun connect(stage: String) {
            openOwnedConnect(scenario, host)
            awaitDocument(scenario, "saved tmux default and SSH transport reach authentication $stage", """
                (()=>{const transport=document.querySelector("[role=dialog] select:has(option[value='ssh'])");
                  return transport?.value==='ssh' && Array.from(document.querySelectorAll('[role=dialog] .security-note'))
                    .some(x=>x.textContent.includes(${JSONObject.quote("Enter tmux session $session directly after connecting.")}));})()
            """)
            chooseOwnedPrivateKey(scenario, fixture.getString("privateKey"), label)
            submitOwnedConnect(scenario)
            awaitDocument(scenario, "saved tmux default attached $stage", """
                (()=>{const tabs=Array.from(document.querySelectorAll('.session-tabs [role=tab]'));
                  const mine=tabs.filter(x=>x.textContent.trim()===${JSONObject.quote(child)});
                  return tabs.length===2 && mine.length===1 && mine[0].getAttribute('aria-selected')==='true';})()
            """)
            sessionView(scenario, "Terminal")
            // tmux's own status line names the session the display is attached to.
            awaitDocument(scenario, "saved tmux default shows its session $stage", """
                (()=>{const pane=Array.from(document.querySelectorAll('.terminal-pane')).find(p=>p.style.display!=='none');
                  return pane?.querySelector('.xterm-screen')?.textContent.includes(${JSONObject.quote("[$session]")})===true;})()
            """)
        }
        var primaryFailure: Throwable? = null
        try {
            revealOwnedHosts(scenario)
            addOwnedHost(scenario, host, "127.0.0.1", fixture.getString("username"), fixture.getInt("port")) {
                selectNativeOption(scenario, fixture.getString("nonce"), "[role=dialog] select:has(option[value='tmux'])", "tmux")
                typeInto(scenario, "[role=dialog] input[maxlength='200']", session)
                selectNativeOption(scenario, fixture.getString("nonce"), "[role=dialog] select:has(option[value='ssh'])", "ssh")
            }
            connect("when the session is missing")
            endOwnedConnection(scenario, child)
            connect("again after its connection ended")
            endOwnedConnection(scenario, child)
            println("lazysh tmux default: the saved create-if-missing default created and showed its session, then attached the same one again")
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            try {
                dismissOwnedAuthentication(scenario)
                if (evaluate(scenario, present("button[aria-label='Disconnect $child']")) == "true") endOwnedConnection(scenario, child)
                if (evaluate(scenario, present("button[aria-label='Connect to $host']")) == "true") deleteOwnedHost(scenario, host)
            } catch (cleanup: Throwable) {
                if (primaryFailure != null) primaryFailure.addSuppressed(cleanup) else throw cleanup
            }
        }
    }

    private fun pasteOwnedText(scenario: ActivityScenario<MainActivity>, selector: String, text: String, label: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val pasteDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        fun requireTime() = assertTrue("Owned native paste exceeded its input deadline", System.nanoTime() < pasteDeadline)
        scenario.onActivity { activity -> requireNotNull(webView(activity.window.decorView)).requestFocus() }
        requireTime()
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webClick())
        requireTime()
        val inputConstraints = typeTextIntoFocusedView("readiness-only").constraints
        while (true) {
            requireTime()
            var ready = false
            scenario.onActivity { activity -> ready = inputConstraints.matches(requireNotNull(webView(activity.window.decorView))) }
            requireTime()
            if (ready) break
            Thread.sleep(25)
        }
        assertEquals("Key field must own DOM focus before paste", "true", evaluate(scenario,
            "document.activeElement===document.querySelector(${JSONObject.quote(selector)})",
            TimeUnit.NANOSECONDS.toMillis(pasteDeadline - System.nanoTime()).coerceAtLeast(1)))
        requireTime()
        instrumentation.runOnMainSync {
            val clip = ClipData.newPlainText(label, text)
            clip.description.extras = android.os.PersistableBundle().apply {
                putBoolean(android.content.ClipDescription.EXTRA_IS_SENSITIVE, true)
            }
            clipboard.setPrimaryClip(clip)
        }
        requireTime()
        onView(isAssignableFrom(WebView::class.java)).perform(
            pressKey(EspressoKey.Builder().withKeyCode(KeyEvent.KEYCODE_A).withCtrlPressed(true).build()))
        requireTime()
        onView(isAssignableFrom(WebView::class.java)).perform(pressKey(KeyEvent.KEYCODE_PASTE))
        requireTime()
        // Boolean only: never retain a key value, DOM dump or screenshot in diagnostics.
        while (true) {
            requireTime()
            val remaining = TimeUnit.NANOSECONDS.toMillis(pasteDeadline - System.nanoTime()).coerceAtLeast(1)
            val matched = evaluate(scenario, "document.querySelector(${JSONObject.quote(selector)})?.value===${JSONObject.quote(text)}", remaining) == "true"
            requireTime()
            if (matched) break
            Thread.sleep(50)
        }
    }

    @Test fun boardReadinessObservationRetainsOnlyClosedBooleanAndStatusFields() {
        val sample = JSONObject().put("board", true).put("checkbox", true).put("checked", true)
            .put("disabled", false).put("alert", false).put("visible", true).put("focused", false).put("status", "NOT_READY")
        assertEquals(sample.toString(), BoardReadinessObservation.parse(sample.toString()).toString())
        for (invalid in listOf("{", " ".repeat(513), JSONObject(sample.toString()).put("status", "private text").toString(),
            JSONObject(sample.toString()).put("checked", "true").toString(),
            JSONObject(sample.toString()).put("rawDOM", "private text").toString(),
            JSONObject(sample.toString()).apply { remove("focused") }.toString())) {
            assertTrue("Unexpected diagnostic fields must fail closed", runCatching { BoardReadinessObservation.parse(invalid) }.isFailure)
        }
    }

    // Dedicated, serialized Gradle invocation. The fixture contains only ephemeral owned data.
    @Test fun ownedRecordedConversationsThroughRealUi() = ownedSshUi(false, requireRecorded = true)
    @Test fun ownedOpenSshConnectsThroughRealUi() = ownedSshUi(false)
    @Test fun ownedSshSurvivesDeniedNotificationPermission() {
        org.junit.Assume.assumeTrue(Build.VERSION.SDK_INT >= 33)
        ownedSshUi(false, requireDeniedNotification = true)
    }
    @Test fun ownedSshDpadPanThroughRealUi() = ownedSshUi(false, requireDpad = true)
    @Test fun ownedSshImeTransactionsThroughRealUi() = ownedSshUi(false, requireIme = true)
    @Test fun ownedGuardedHerdrChatThroughRealUi() = ownedSshUi(true)
    @Test fun ownedSharedHerdrNavigationThroughRealUi() = ownedSshUi(true, requireSharedHerdr = true)
    @Test fun ownedMoshDefaultHerdrChatThroughRealUi() = ownedSshUi(true, requireHerdrMosh = true)
    @Test fun ownedCompanionInstallsThroughRealUi() = ownedSshUi(false, true)
    @Test fun ownedMoshSurvivesBusyBackgroundThroughRealUi() = ownedSshUi(false, false, true)
    @Test fun ownedMoshUploadsLargeClipboardImageThroughRealUi() = ownedSshUi(false, requireAttachments = true)
    @Test fun ownedTmuxThroughRealUi() = ownedSshUi(false, requireTmux = true)
    @Test fun ownedTmuxAgentViewThroughRealUi() = ownedSshUi(false, requireTmux = true, requireTmuxAgent = true)
    @Test fun ownedTmuxControlsWithNativeEngine() {
        Os.setenv("LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU", "1", true)
        ownedSshUi(false, requireTmux = true, nativeTmux = true)
    }
    @Test fun ownedZellijThroughRealUi() = ownedSshUi(false, requireZellij = true)

    @Test fun ownedZellijTabsWithNativeEngine() {
        Os.setenv("LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU", "1", true)
        ownedSshUi(false, requireZellij = true, nativeZellij = true)
    }

    /**
     * Lost connection on a saved-credential tmux host (#1640). tests/support/androidLostConnection.ts runs the pinned
     * tmux behind a relay it can cut; this case only asks it to `cut`, `restore` and `observe`, and drives the real UI.
     */
    @Test fun ownedTmuxLostConnectionThroughRealUi() {
        val name = "Parity lost route"
        val label = "$name / owned-tmux"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val alpha = ownedTmuxAlpha(parity)
            val banner = "Array.from(document.querySelectorAll('section.connection-banner')).some(x=>" +
                "x.querySelector('h2')?.textContent.trim()===${JSONObject.quote("Connection lost for $label")} && x.textContent.includes('Connection lost.'))"
            connectOwnedSaved(scenario, parity, name)
            awaitDocument(scenario, "owned tmux pane before the route is cut", terminalScreenContains(alpha))
            assertEquals("Exactly one tmux client before the cut", 1, parity.awaitFact("attached", 20) { it.getInt("clients") == 1 }.getInt("clients"))

            parity.control("cut")
            awaitDocument(scenario, "lost-connection banner after the route is cut", banner)
            parity.awaitFact("tmux client gone with the route", 30) { it.getInt("clients") == 0 }
            // The host's observe call also proved the original tmux server and pane processes are still alive.
            val refused = parity.awaitFact("automatic retry refused by the cut route", 60) { it.getInt("refused") >= 1 }.getInt("refused")
            assertEquals("The banner must stay while the route is down", "true", evaluate(scenario, banner))

            parity.control("restore")
            awaitDocument(scenario, "banner closes by itself after the route returns", "!($banner)")
            awaitDocument(scenario, "reattached tmux pane shows its original output", terminalScreenContains(alpha))
            val back = parity.awaitFact("tmux client reattached", 30) { it.getInt("clients") == 1 }
            assertTrue("Reconnect must not need a new credential or a dialog: $back refused=$refused",
                evaluate(scenario, present("[role=dialog]")) == "false")

            // Close ends the session; a restored route must not bring it back.
            parity.control("cut")
            awaitDocument(scenario, "lost-connection banner before Close", banner)
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "section.connection-banner button[aria-label='Close $label']")).perform(webClick())
            awaitDocument(scenario, "banner gone after Close", "!($banner)")
            parity.control("restore")
            Thread.sleep(8_000)
            val idle = parity.control("observe")
            assertEquals("A closed session must not reattach tmux: $idle", 0, idle.getInt("clients"))
            assertEquals("A closed session must not reconnect: $idle", 0, idle.getInt("active"))
            println("lazysh lost connection: banner, refused automatic retry, same tmux pane after the route returned, and Close without reconnecting")
        }
    }

    private val restoreOffer = ".workspace-restore-row > button:first-child"
    private val restoreHost = "Parity restore"

    /**
     * What one restore case attaches: the multiplexer, its saved default session, the marker its first display shows, and
     * whether the pane's tty echoes typed bytes (tmux runs a plain `sleep`; a Herdr receiver records them and echoes nothing,
     * so the host's `typed` fact is the evidence that they arrived).
     */
    private inner class RestoreTarget(val multiplexer: String, val session: String, val echoes: Boolean, val marker: (OwnedParity) -> String) {
        val label = "$restoreHost / $session"
    }
    private val restoreTmux = RestoreTarget("tmux", "owned-tmux", true, this::ownedTmuxAlpha)
    private val restoreHerdr = RestoreTarget("herdr", "owned-guard", false, this::ownedHerdrSource)

    /** The bytes the pane's tty echoes back when typed through the app, checked against the shape the host writes. */
    private fun ownedRestoreToken(parity: OwnedParity) = parity.fixture.getString("restoreToken")
        .also { require(Regex("RESTORE_[a-f0-9]{32}").matches(it)) { "Owned restore token required" } }

    /** One half of a restore case: the shared host, session and the two fixture strings, around `ownedParityCase`. */
    private fun ownedRestoreCase(target: RestoreTarget, keepOnSuccess: Boolean, body: (ActivityScenario<MainActivity>, OwnedParity, String, String) -> Unit) =
        ownedParityCase(listOf(restoreHost), listOf(target.label), keepOnSuccess) { scenario, parity ->
            body(scenario, parity, target.marker(parity), ownedRestoreToken(parity))
        }

    /**
     * Waits until the one saved intent of the target's session has its host id in the WebView's on-disk Local Storage. The id
     * is a random UUID, so an older run's descriptor cannot satisfy it, and page memory alone would not survive the host's force-stop.
     */
    private fun awaitWorkspaceOnDisk(scenario: ActivityScenario<MainActivity>, target: RestoreTarget) {
        val intents = "JSON.stringify(JSON.parse(localStorage.getItem('lazysh.workspace.v1')||'[]')" +
            ".filter(x=>x.attached&&x.attached.kind===${JSONObject.quote(target.multiplexer)}&&x.attached.name===${JSONObject.quote(target.session)}).map(x=>x.hostId))"
        awaitDocument(scenario, "saved ${target.multiplexer} workspace intent", "($intents)!=='[]'")
        val hostId = JSONArray(JSONTokener(evaluate(scenario, intents)).nextValue() as String).getString(0)
        require(Regex("[a-f0-9-]{36}").matches(hostId)) { "Saved host id must be a UUID" }
        val storage = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.dataDir, "app_webview/Default/Local Storage")
        val encodings = listOf(Charsets.UTF_8, Charsets.UTF_16LE).map { hostId.toByteArray(it) }
        fun indexOf(bytes: ByteArray, needle: ByteArray): Boolean = bytes.size >= needle.size &&
            (0..bytes.size - needle.size).any { start -> needle.indices.all { bytes[start + it] == needle[it] } }
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (true) {
            val files = storage.walkTopDown().filter { it.isFile && it.length() in 1..(16L shl 20) }.take(256).toList()
            if (files.any { file -> val bytes = file.readBytes(); encodings.any { indexOf(bytes, it) } }) return
            assertTrue("The workspace descriptor never reached the WebView's on-disk storage (${files.size} files)", System.nanoTime() < deadline)
            Thread.sleep(250)
        }
    }

    /**
     * First half of the restore after a force-stop (#1639, #1827). tests/support/androidForceStopRestore.ts runs this case, force-stops
     * the app from the host and then runs the matching `...RestoreAfterForceStop` in a fresh instrumentation process; one method
     * cannot do both because the instrumentation lives in the app process. A passing phase 1 leaves the host and its open
     * session in place for phase 2.
     */
    private fun ownedRestoreBefore(target: RestoreTarget) {
        ownedRestoreCase(target, keepOnSuccess = true) { scenario, parity, marker, token ->
            connectOwnedSaved(scenario, parity, restoreHost, target.multiplexer, target.session)
            awaitDocument(scenario, "owned ${target.multiplexer} display before the force-stop", terminalScreenContains(marker))
            sendOwnedCommand(scenario, token, parity.label)
            // tmux redraws what its pane echoed after the restore; a Herdr receiver echoes nothing, so only the host's byte file shows arrival.
            if (target.echoes) awaitDocument(scenario, "bytes typed into the owned ${target.multiplexer} pane", terminalScreenContains(token))
            else parity.awaitFact("typed bytes reached the owned ${target.multiplexer} receiver", 20) { it.getBoolean("typed") }
            parity.awaitFact("one ${target.multiplexer} client before the force-stop", 20) { it.getInt("clients") == 1 }
            awaitWorkspaceOnDisk(scenario, target)
            println("lazysh restore phase 1: saved-credential ${target.multiplexer} session open, typed bytes in the pane and the workspace descriptor on disk")
        }
    }

    /**
     * Second half, in a fresh process after the host force-stopped the app: the restore offer shows with no terminal and no host
     * client, and only a click on it reattaches the same display with the saved credential.
     */
    private fun ownedRestoreAfter(target: RestoreTarget) {
        ownedRestoreCase(target, keepOnSuccess = false) { scenario, parity, marker, token ->
            val offer = "Array.from(document.querySelectorAll(${JSONObject.quote(restoreOffer)})).some(x=>x.textContent.trim()==='Restore previous workspace' && !x.disabled)"
            awaitDocument(scenario, "restore offer once the saved hosts load", offer)
            assertEquals("Relaunch alone must not open a terminal or ask for a credential", "false", evaluate(scenario,
                "Boolean(document.querySelector('.terminal-canvas .xterm-screen')||document.querySelector('[role=dialog]'))"))
            // A wrongful automatic restore would attach within this window; the original pane must stay unattended.
            Thread.sleep(5_000)
            parity.awaitFact("no ${target.multiplexer} client after the relaunch", 5) { it.getInt("clients") == 0 }

            clickOwnedButton("Restore previous workspace")
            awaitDocument(scenario, "restored ${target.multiplexer} display shows what it showed before the force-stop",
                terminalScreenContains(marker) + if (target.echoes) " && " + terminalScreenContains(token) else "")
            // The host fails `observe` itself if the original server or processes changed, or a Herdr receiver got a byte it was not typed.
            val restored = parity.awaitFact("exactly one ${target.multiplexer} client after the restore", 30) { it.getInt("clients") == 1 && (target.echoes || it.getBoolean("typed")) }
            assertTrue("Restore must use the saved credential without a dialog: $restored", evaluate(scenario, present("[role=dialog]")) == "false")
            assertEquals("The offer is gone once the workspace is restored", "false", evaluate(scenario, present(".workspace-restore")))
            println("lazysh restore phase 2: offer only on click, same ${target.multiplexer} display and typed bytes back, one client, saved credential used")
        }
    }

    @Test fun ownedTmuxRestoreBeforeForceStop() = ownedRestoreBefore(restoreTmux)
    @Test fun ownedTmuxRestoreAfterForceStop() = ownedRestoreAfter(restoreTmux)
    @Test fun ownedHerdrRestoreBeforeForceStop() = ownedRestoreBefore(restoreHerdr)
    @Test fun ownedHerdrRestoreAfterForceStop() = ownedRestoreAfter(restoreHerdr)

    // The toolbar editor's Agents and Workspaces keys open each view for the real
    // connection, and the destination heading's back control returns to the terminal.
    private fun verifyNavigationToolbarKeys(scenario: ActivityScenario<MainActivity>) {
        val owned = JSONObject.quote("__lazyshNavigationToolbar_" + UUID.randomUUID().toString().replace("-", ""))
        val key = JSONObject.quote("lazysh.preferences.v1")
        fun replaceToolbar(script: String) = assertEquals("Owned toolbar preferences must apply", "true", evaluate(scenario,
            "(()=>{const key=$key;$script;window.dispatchEvent(new StorageEvent('storage',{key}));return true;})()"))
        replaceToolbar("""window[$owned]=localStorage.getItem(key);const stored=JSON.parse(window[$owned]??'null')??{};
            localStorage.setItem(key,JSON.stringify({...stored,version:1,toolbar:['esc','agents','workspaces']}))""")
        val heading = ".workspace-destination-heading"
        try {
            for (label in listOf("Agents", "Workspaces")) {
                awaitDocument(scenario, "touchable $label toolbar key", workspaceButtonVisible(".terminal-keys", label))
                onWebView().withElement(findElement(Locator.XPATH,
                    "//div[contains(@class,'terminal-keys')]//button[normalize-space(.)='$label']")).perform(webClick())
                awaitDocument(scenario, "$label opened from its toolbar key", workspaceElementVisible(heading) +
                    " && document.querySelector('$heading h2')?.textContent===${JSONObject.quote(label)}")
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$heading button[aria-label='Return to terminal']")).perform(webClick())
                awaitDocument(scenario, "$label returned to the terminal", "!" + workspaceElementVisible(heading) + " && " +
                    workspaceElementVisible(".terminal-canvas .xterm-screen"))
            }
        } finally {
            replaceToolbar("const original=window[$owned];delete window[$owned];if(original===null)localStorage.removeItem(key);else localStorage.setItem(key,original)")
        }
        println("lazysh navigation: Agents and Workspaces toolbar keys opened and returned through the real UI")
    }

    // The target-UID-only synthetic provider exists only in the instrumentation APK.
    // Reads use the normal foreground Attachments action; this never uploads.
    private fun verifyOwnedClipboardImages(scenario: ActivityScenario<MainActivity>, label: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.context
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        fun click(text: String) = onWebView().withElement(findElement(Locator.XPATH,
            "//section[contains(@class,'attachment-panel')]//button[normalize-space(.)='$text']"))
            .perform(webScrollIntoView()).perform(webClick())
        fun view(text: String) = sessionView(scenario, text)
        run {
            view("Attach")
            awaitDocument(scenario, "owned clipboard attachment panel", "Boolean(document.querySelector('.attachment-panel'))")
            for (extension in listOf("png", "jpg")) {
                val uri = Uri.parse("content://app.lazysh.client.test.clipboardfixture/$extension")
                instrumentation.runOnMainSync {
                    clipboard.setPrimaryClip(ClipData.newUri(context.contentResolver, label, uri))
                }
                click("Paste clipboard image")
                awaitDocument(scenario, "native $extension clipboard staged without upload", """
                    (()=>{const panel=document.querySelector('.attachment-panel');
                      const destination=Array.from(panel.querySelectorAll('label')).find(x=>x.firstChild?.textContent==='Destination path')?.querySelector('input');
                      // The default destination is empty: the host saves a private /tmp copy.
                      return destination?.value==='' &&
                        Boolean(panel.querySelector('.attachment-selected > summary')?.textContent.includes('.$extension ·')) &&
                        panel.querySelectorAll('input[type=checkbox]').length===1 &&
                        !panel.querySelector('input[readonly]') &&
                        !Array.from(panel.querySelectorAll('[role=status]')).some(x=>x.textContent==='Uploaded to this host. Copy its path or edit the prompt below.');})()
                """)
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".attachment-options > summary"))
                    .perform(webScrollIntoView()).perform(webClick())
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".attachment-panel input[type=checkbox]"))
                    .perform(webScrollIntoView()).perform(webClick())
                awaitDocument(scenario, "native $extension clipboard image preview", """
                    (()=>{const canvas=document.querySelector('.attachment-editor canvas');
                      return canvas?.width===4 && canvas?.height===3 && !document.querySelector('.attachment-panel input[readonly]');})()
                """)
                click("Cancel attachment")
                awaitDocument(scenario, "owned clipboard preview cancelled", "!document.querySelector('.attachment-editor') && !document.querySelector('.attachment-panel input[type=checkbox]')")
            }
            for ((stage, uri) in listOf("non-content" to "https://clipboard-fixture.invalid/owned.png",
                "oversize" to "content://app.lazysh.client.test.clipboardfixture/oversize")) {
                // A fresh normal panel prevents an earlier error from satisfying the next rejection.
                view("Terminal")
                awaitDocument(scenario, "clipboard panel retired", "!document.querySelector('.attachment-panel')")
                view("Attach")
                awaitDocument(scenario, "fresh clipboard rejection panel", "Boolean(document.querySelector('.attachment-panel')) && !document.querySelector('.attachment-panel [role=alert]')")
                instrumentation.runOnMainSync {
                    clipboard.setPrimaryClip(ClipData(label, arrayOf("image/png"), ClipData.Item(Uri.parse(uri))))
                }
                click("Paste clipboard image")
                awaitDocument(scenario, "$stage clipboard image rejected without upload", """
                    Boolean(document.querySelector('.attachment-panel [role=alert]')) &&
                    !document.querySelector('.attachment-panel input[type=checkbox]') &&
                    !document.querySelector('.attachment-panel input[readonly]')
                """)
            }
            view("Terminal")
            println("lazysh clipboard UI: PNG/JPEG preview without upload and non-content/oversize rejection verified")
        }
    }

    /** One real finger tap at a point of the WebView given as [x, y, innerWidth] in CSS pixels. */
    private fun tapWebViewAt(point: JSONArray) {
        onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE, { view ->
            val location = IntArray(2); view.getLocationOnScreen(location)
            val scale = view.width / point.getDouble(2)
            val x = point.getDouble(0) * scale; val y = point.getDouble(1) * scale
            require(x > 0 && x < view.width && y > 0 && y < view.height) { "Owned tap outside WebView" }
            floatArrayOf((location[0] + x).toFloat(), (location[1] + y).toFloat())
        }, Press.FINGER))
    }

    /**
     * One real finger tap on the one enabled, hit-testable control. A WebView file chooser needs a trusted user activation,
     * which a scripted click does not give.
     */
    private fun tapOwnedControl(scenario: ActivityScenario<MainActivity>, selector: String) {
        // Centered, so a sticky bar or the navigation cannot cover the target.
        evaluate(scenario, "(()=>{document.querySelector(${JSONObject.quote(selector)})?.scrollIntoView({block:'center',behavior:'instant'});return true;})()")
        val css = JSONArray(evaluate(scenario, """
            (()=>{const matches=document.querySelectorAll(${JSONObject.quote(selector)});
              if(matches.length!==1)throw Error('Owned tap target must be unique');
              const element=matches[0],rect=element.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
              if(element.disabled||document.elementFromPoint(x,y)!==element)throw Error('Owned tap target must be enabled and hit-testable');
              return [x,y,innerWidth];})()
        """))
        tapWebViewAt(css)
    }

    /**
     * Installed Wry asks for the declared CAMERA permission before the explicit Photo action opens a camera, and answers the
     * file chooser with null when it is denied. Over a staged draft this denies the real system sheet and proves that no
     * camera opens and the draft is unchanged, then proves the ordinary Choose file input selects an owned PNG through the real
     * system chooser: the draft shows that file (name and size) with no upload and no error, and [restage] puts the case's own
     * draft back because choosing replaces it. The Allow branch is not exercised.
     */
    private fun verifyAttachmentPhotoDenied(scenario: ActivityScenario<MainActivity>, panel: String, destination: String, restage: () -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        val camera = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val cameras = camera.cameraIdList.toSet()
        assertTrue("Owned emulator camera must exist so an unwanted capture is observable", cameras.isNotEmpty())
        assertEquals("Camera permission must start ungranted", PackageManager.PERMISSION_DENIED,
            context.checkSelfPermission(android.Manifest.permission.CAMERA))
        // An earlier denial may have set Don't ask again, which would hide the real sheet.
        device.executeShellCommand("pm clear-permission-flags ${context.packageName} android.permission.CAMERA user-set user-fixed")
        val sources = "$panel .attachment-sources"
        val photo = "$sources input[capture]"
        val chooser = "$sources input[type=file]:not([capture])"
        val draft = """
            (()=>{const panel=document.querySelector(${JSONObject.quote(panel)});
              return {selected:panel.querySelector('.attachment-selected > summary')?.textContent??null,
                destination:document.querySelector(${JSONObject.quote(destination)})?.value??null,
                checkboxes:panel.querySelectorAll('input[type=checkbox]').length,uploaded:panel.querySelectorAll('input[readonly]').length,
                alerts:panel.querySelectorAll('[role=alert]').length,
                files:Array.from(panel.querySelectorAll('.attachment-sources input[type=file]')).map(x=>x.files.length)};})()
        """
        // Staging a draft closes the sources group; open it with an ordinary click.
        if (evaluate(scenario, "document.querySelector(${JSONObject.quote(sources)})?.open===true") != "true")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$sources > summary")).perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "attachment sources open over the staged draft", "document.querySelector(${JSONObject.quote(sources)})?.open===true")
        val before = evaluate(scenario, draft)
        val staged = JSONObject(before)
        assertTrue("A staged draft needs its selection and exact destination", !staged.isNull("selected") && staged.getString("destination").startsWith("./"))
        assertEquals("The draft must start without an upload or an error", 0, staged.getInt("uploaded") + staged.getInt("alerts"))
        assertEquals("The draft must start without a chosen file", "[0,0]", staged.getJSONArray("files").toString())
        val fixtureName = "lazysh-attachment-${UUID.randomUUID()}.png"
        val fixtureBytes = instrumentation.context.assets.open("theme-qr.png").use { it.readBytes().size }
        var fixture: Uri? = null
        val observer = HandlerThread("owned-attachment-camera-observer").apply { start() }
        val observation = QrCameraObservation(cameras)
        camera.registerAvailabilityCallback(observation, Handler(observer.looper))
        try {
            assertTrue("Cameras must be idle before the explicit Photo action", observation.idle.await(5, TimeUnit.SECONDS))
            observation.arm()
            tapOwnedControl(scenario, photo)
            chooseOwnedCameraPermission("permission_deny_button")
            awaitDocument(scenario, "attachment panel after the denied camera sheet", "Boolean(document.querySelector(${JSONObject.quote(photo)}))")
            assertEquals("Denied choice must leave camera permission ungranted", PackageManager.PERMISSION_DENIED,
                context.checkSelfPermission(android.Manifest.permission.CAMERA))
            assertEquals("A denied Photo action must leave the attachment draft unchanged", before, evaluate(scenario, draft))
            // Absence is observed over a bounded window: Wry answers the chooser with null and launches nothing.
            val settled = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            do {
                assertEquals("No other app may take the foreground after a denied Photo action", context.packageName, device.currentPackageName)
                assertTrue("A denied Photo action must not open any camera", !observation.openedAny())
                Thread.sleep(200)
            } while (System.nanoTime() < settled)
            println("lazysh attachment photo: real CAMERA sheet denied; permission still denied; no camera opened; draft unchanged")
            fixture = OwnedFileChooser.stage(instrumentation, "theme-qr.png", fixtureName)
            tapOwnedControl(scenario, chooser)
            OwnedFileChooser.choose(instrumentation, fixtureName)
            awaitDocument(scenario, "chosen file staged in the attachment draft", "document.querySelector(${JSONObject.quote(panel)} + ' .attachment-selected > summary')?.textContent.startsWith(${JSONObject.quote(fixtureName)})")
            val chosen = JSONObject(evaluate(scenario, draft))
            assertEquals("The draft must show the chosen file's name and size", "$fixtureName · $fixtureBytes bytes", chosen.getString("selected"))
            assertEquals("A chosen file starts with no destination, an upload or an error", "", chosen.getString("destination"))
            assertEquals("A chosen file must not be uploaded or raise an error", 0, chosen.getInt("uploaded") + chosen.getInt("alerts"))
            assertEquals("The chosen PNG offers its one editing option", 1, chosen.getInt("checkboxes"))
            println("lazysh attachment chooser: Choose file selected the owned PNG through the real system chooser; draft shows $fixtureBytes bytes, no upload, no error")
            restage()
        } finally {
            camera.unregisterAvailabilityCallback(observation)
            observer.quitSafely(); observer.join(5_000)
            // A picker still open would hide the app from every later case.
            if (OwnedFileChooser.pickerOpen(instrumentation)) OwnedFileChooser.dismiss(instrumentation)
            fixture?.let { OwnedFileChooser.unstage(instrumentation, it) }
        }
    }

    private fun verifyManualAttachmentUpload(scenario: ActivityScenario<MainActivity>, fixture: JSONObject, label: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val nonce = fixture.getString("nonce")
        val expectedName = JSONObject.quote(fixture.getString("name"))
        awaitDocument(scenario, "one selected owned Mosh attachment terminal", """
            (()=>{const selected=document.querySelectorAll('.session-tabs [role=tab][aria-selected=true]');
              return selected.length===1 && selected[0].textContent.trim()===$expectedName &&
                ${workspaceElementVisible("button.session-switcher-trigger", true)} &&
                document.querySelector('.session-switcher-trigger')?.textContent===$expectedName &&
                document.querySelector('.workspace-footer')?.textContent.includes('Mosh') &&
                Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).filter(x=>x.getClientRects().length>0).length===1;})()
        """)
        selectOwnedConnection(scenario, fixture.getString("name"), true)
        val owned = fixture.getJSONObject("attachments")
        require(owned.getString("newName") == "owned-upload-$nonce.png" && owned.getString("collisionName") == "owned-collision-$nonce.png")
        val uri = Uri.parse("content://app.lazysh.client.test.clipboardfixture/large-png")
        val image = checkNotNull(context.contentResolver.openInputStream(uri)).use { input ->
            val output = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(8192)
            while (true) {
                val count = input.read(chunk)
                if (count < 0) break
                require(output.size() + count <= 600 * 1024) { "Owned PNG exceeds its fixture bound" }
                output.write(chunk, 0, count)
            }
            output.toByteArray()
        }
        require(image.size in 400 * 1024..600 * 1024) { "Owned PNG must cross multiple upload chunks" }
        val bitmap = checkNotNull(android.graphics.BitmapFactory.decodeByteArray(image, 0, image.size))
        try { assertEquals(448, bitmap.width); assertEquals(320, bitmap.height) } finally {bitmap.recycle()}
        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it.toInt() and 255) }
        val receipt = JSONObject().put("schemaVersion", 1).put("nonce", nonce).put("bytes", image.size)
            .put("width", 448).put("height", 320).put("sha256", digest)
        java.io.File(context.filesDir, "owned-attachment-$nonce.json").writeText(receipt.toString())
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val panel = ".attachment-panel"
        val destination = "$panel label:has(input:not([type]):not([readonly])) input"
        fun click(text: String) = onWebView().withElement(findElement(Locator.XPATH,
            "//section[contains(@class,'attachment-panel')]//button[normalize-space(.)='$text']"))
            .perform(webScrollIntoView()).perform(webClick())
        fun pasteDraft(name: String) {
            instrumentation.runOnMainSync {clipboard.setPrimaryClip(ClipData.newUri(context.contentResolver, label, uri))}
            click("Paste clipboard image")
            // The summary guard keeps a file chosen earlier in the draft from satisfying this wait before the paste lands.
            awaitDocument(scenario, "large protected clipboard image staged without upload", "document.querySelectorAll('$panel input[type=checkbox]').length===1 && !document.querySelector('$panel input[readonly]') && !document.querySelector('$panel [role=alert]') && !document.querySelector('$panel .attachment-selected > summary')?.textContent.startsWith('lazysh-attachment-')")
            pasteOwnedText(scenario, destination, "./$name", label)
            closeSoftKeyboard()
            assertEquals("Exact owned relative upload path", "true", evaluate(scenario,
                "document.querySelector(${JSONObject.quote(destination)})?.value===${JSONObject.quote("./$name")} && !document.querySelector('$panel [role=alert]')"))
        }
        fun stage(name: String, upload: Boolean = true, beforeUpload: () -> Unit = {}) {
            sessionView(scenario, "Attach")
            awaitDocument(scenario, "fresh owned attachment panel", "document.querySelectorAll('$panel').length===1 && !document.querySelector('$panel [role=alert]') && !document.querySelector('$panel input[readonly]')")
            pasteDraft(name)
            beforeUpload()
            assertEquals("One enabled manual upload action", "true", evaluate(scenario,
                "Array.from(document.querySelectorAll('$panel button')).filter(x=>x.textContent.trim()==='Upload attachment'&&!x.disabled).length===1"))
            if (upload) click("Upload attachment")
        }
        fun uploadedTo(name: String) = """
            (()=>{const fields=document.querySelectorAll('$panel input[readonly]');return fields.length===1 &&
              fields[0].value.endsWith(${JSONObject.quote("/$name'")}) &&
              !document.querySelector('$panel [role=alert]') &&
              document.querySelector('.workspace-footer')?.textContent.includes('Mosh');})()
        """
        // The first staged draft also carries the Photo denial and ordinary chooser checks; the upload below proves it survived them.
        stage(owned.getString("newName")) { verifyAttachmentPhotoDenied(scenario, panel, destination) { pasteDraft(owned.getString("newName")) } }
        awaitDocument(scenario, "manual large image upload completed", uploadedTo(owned.getString("newName")))
        sessionView(scenario, "Terminal")
        awaitDocument(scenario, "successful upload panel retired", "!document.querySelector('$panel')")
        stage(owned.getString("collisionName"))
        awaitDocument(scenario, "fresh existing-path SFTP rejection", """
            (()=>{const alerts=document.querySelectorAll('$panel [role=alert]');return alerts.length===1 &&
              alerts[0].textContent.trim()==='Failure: Failure' && !document.querySelector('$panel input[readonly]') &&
              document.querySelector('.workspace-footer')?.textContent.includes('Mosh');})()
        """)
        sessionView(scenario, "Terminal")
        selectOwnedConnection(scenario, fixture.getString("name"), true)
        verifyClosedControlUploadRecovery(scenario, fixture, label, ::stage, ::uploadedTo, ::click)
        println("lazysh manual attachment: large valid protected PNG uploaded; pre-existing destination rejected with SFTP Failure; closed SSH control recovered by manual reauthentication; original Mosh display selected")
    }

    // #1523: the host closes only this app's relayed SSH stream while the Mosh daemon lives on. The explicit
    // Upload then shows the closed-control recovery action and leaves the draft; manual authentication restores
    // the upload connection without an automatic upload or a second terminal; a separate Upload writes the file.
    private fun verifyClosedControlUploadRecovery(scenario: ActivityScenario<MainActivity>, fixture: JSONObject, label: String,
        stage: (String, Boolean) -> Unit, uploadedTo: (String) -> String, click: (String) -> Unit) {
        val nonce = fixture.getString("nonce")
        val owned = fixture.getJSONObject("attachments")
        val directory = owned.getString("directory")
        val name = owned.getString("recoveryName")
        require(Regex("/tmp/lazysh-android-ssh-[A-Za-z0-9_-]+").matches(directory) && name == "owned-recovery-$nonce.png") { "Owned recovery fixture invalid" }
        val panel = ".attachment-panel"
        val destination = "$panel label:has(input:not([type]):not([readonly])) input"
        val dialog = "[role=dialog][aria-label='Reconnect uploads to ${fixture.getString("name")}']"
        val key = JSONObject.quote("__lazyshOwnedRecovery_$nonce")
        val token = JSONObject.quote(UUID.randomUUID().toString())
        // Send reopens the soft keyboard, which resizes the Mosh screen, and mosh-server drops the bottom rows of a
        // shrink that a shell cannot redraw. Each proof is printed after a pause so it lands once that has settled.
        fun typed(command: String, proof: String) {
            sendOwnedCommand(scenario, command, label)
            awaitDocument(scenario, "owned Mosh terminal printed its recovery proof", terminalScreenContains(proof))
        }
        fun same() = "owned.token===$token && owned.screen.isConnected && owned.screen===document.querySelector('.terminal-canvas .xterm-screen') && document.querySelectorAll('[role=tab]').length===owned.tabs"
        assertEquals("Retain only the original Mosh terminal and tab", "true", evaluate(scenario, """
            (()=>{const screen=document.querySelector('.terminal-canvas .xterm-screen');
              if(!screen || Object.prototype.hasOwnProperty.call(window,$key))return false;
              window[$key]={token:$token,screen,tabs:document.querySelectorAll('[role=tab]').length};return true;})()
        """))
        // The host answers this receipt by closing exactly the app's SSH stream, then releases the shell.
        typed(hostReceipt(directory, "upload-control") + "sleep 5; printf 'CONTROL_%s_CLOSED\\n' '$nonce'", "CONTROL_${nonce}_CLOSED")
        stage(name, false)
        val draft = "document.querySelector(${JSONObject.quote(destination)})?.value===${JSONObject.quote("./$name")} && " +
            "document.querySelectorAll('$panel input[type=checkbox]').length===1 && !document.querySelector('$panel input[readonly]')"
        click("Upload attachment")
        awaitDocument(scenario, "closed SSH control refuses the explicit upload and offers recovery", """
            (()=>{const alerts=document.querySelectorAll('$panel [role=alert]');return alerts.length===1 &&
              alerts[0].textContent.includes('The SSH file-transfer connection is closed') &&
              Array.from(document.querySelectorAll('$panel button')).filter(x=>x.textContent.trim()==='Reconnect uploads'&&!x.disabled).length===1;})() && $draft
        """)
        click("Reconnect uploads")
        awaitDocument(scenario, "manual upload reauthentication dialog", present(dialog))
        assertEquals("Recovery offers no transport choice", "true", evaluate(scenario, "!document.querySelector(${JSONObject.quote("$dialog select")})"))
        clickOwnedButton("Private key")
        pasteOwnedText(scenario, "$dialog textarea", fixture.getString("privateKey"), label)
        assertEquals("Recovery cannot remember credentials", "true", evaluate(scenario, "!document.querySelector(${JSONObject.quote("$dialog input[type=checkbox]")})"))
        closeSoftKeyboard()
        onWebView().withElement(findElement(Locator.XPATH, "//*[@role='dialog']//button[normalize-space(.)='Reconnect uploads']"))
            .perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "manual authentication restored uploads and kept the draft", """
            (()=>{const owned=window[$key];return !document.querySelector(${JSONObject.quote(dialog)}) && !document.querySelector('$panel [role=alert]') &&
              Array.from(document.querySelectorAll('$panel [role=status]')).some(x=>x.textContent==='Uploads reconnected. Select Upload attachment to retry.') &&
              !!owned && owned.token===$token && document.querySelectorAll('[role=tab]').length===owned.tabs;})() && $draft
        """)
        // The host requires the destination to stay absent for this long after the reconnect; wait it out, then upload explicitly.
        Thread.sleep(2_500)
        assertEquals("Reconnecting never uploads by itself", "true", evaluate(scenario, "$draft && !document.querySelector('$panel [role=alert]')"))
        click("Upload attachment")
        awaitDocument(scenario, "separate explicit upload after recovery completed", uploadedTo(name))
        // A completed upload collapses the selected file; reopen it as a user would and repeat the same upload.
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$panel details.attachment-selected > summary"))
            .perform(webScrollIntoView()).perform(webClick())
        click("Upload attachment")
        awaitDocument(scenario, "repeated upload refused by the existing remote file", """
            (()=>{const alerts=document.querySelectorAll('$panel [role=alert]');return alerts.length===1 && alerts[0].textContent.startsWith('Failure: ') &&
              !Array.from(document.querySelectorAll('$panel button')).some(x=>x.textContent.trim()==='Reconnect uploads');})()
        """)
        sessionView(scenario, "Terminal")
        awaitDocument(scenario, "original Mosh terminal and tab retained", "(()=>{const owned=window[$key];return !!owned && ${same()};})()")
        typed("sleep 5; printf 'CONTROL_%s_RECOVERED\\n' '$nonce'", "CONTROL_${nonce}_RECOVERED")
    }

    private enum class SshUiCleanupStage { DISMISS, SESSION_SELECT, DISCONNECT, HOST_DELETE }

    private fun ownedWakeLockHeld(power: String, uid: Int, pid: Int): Boolean {
        val start = Regex("(?m)^Wake Locks: size=[0-9]+\\r?$").find(power)
        val end = power.indexOf("\nSuspend Blockers:", start?.range?.last ?: 0)
        require(start != null && end > start.range.last) { "Owned power observation unavailable" }
        val locks = power.substring(start.range.last + 1, end).lineSequence()
            .filter { it.contains("'lazysh:terminal-connections'") }.toList()
        require(locks.size <= 1) { "Owned wake-lock observation ambiguous" }
        val held = locks.singleOrNull()?.let {
            it.contains("PARTIAL_WAKE_LOCK") && it.contains("ACQ=") && !it.contains("DISABLED") &&
                Regex("\\(uid=$uid(?: [^\\r\\n()]*)? pid=$pid\\)").containsMatchIn(it)
        } ?: false
        require(locks.isEmpty() || held) { "Owned wake-lock identity or state unverified" }
        return held
    }

    @Test fun wakeLockObservationRequiresExactOwnedAcquiredPartialLock() {
        val row = "  PARTIAL_WAKE_LOCK 'lazysh:terminal-connections' ACQ=-1s (uid=10123 isFrozen=false pid=456)"
        fun dump(vararg rows: String) = "Wake Locks: size=${rows.size}\n${rows.joinToString("\n")}\nSuspend Blockers:\n"
        assertTrue("AOSP single-quoted acquired owned lock must be observed", ownedWakeLockHeld(dump(row), 10123, 456))
        assertFalse(ownedWakeLockHeld(dump(), 10123, 456))
        assertFalse(ownedWakeLockHeld(dump(row.replace("terminal-connections'", "terminal-connections-other'")), 10123, 456))
        for (invalid in listOf(
            dump(row.replace("uid=10123", "uid=10124")),
            dump(row.replace("pid=456", "pid=457")),
            dump(row.replace(" ACQ=", " DISABLED ACQ=")),
            dump(row.replace(" ACQ=-1s", "")),
            dump(row.replace("PARTIAL_WAKE_LOCK", "FULL_WAKE_LOCK")),
            dump(row, row),
        )) {
            assertTrue("Unowned, inactive or ambiguous locks must fail closed", runCatching { ownedWakeLockHeld(invalid, 10123, 456) }.isFailure)
        }
    }

    @Suppress("DEPRECATION")
    private fun connectionExecutionObservation(): JSONObject {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val pid = android.os.Process.myPid()
        val uid = android.os.Process.myUid()
        val manager = context.getSystemService(android.app.ActivityManager::class.java)
        val services = manager.getRunningServices(64).filter {
            it.service.packageName == context.packageName &&
                it.service.className == "app.lazysh.client.SessionForegroundService"
        }
        val notifications = context.getSystemService(android.app.NotificationManager::class.java)
            .activeNotifications.filter { it.id == 8461 && it.notification.channelId == "terminal-connections" }
        val bytes = instrumentation.uiAutomation.executeShellCommand("timeout 2 dumpsys power").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readNBytes(262145) }
        }
        require(bytes.size <= 262144) { "Owned power observation exceeds bound" }
        val power = String(bytes, Charsets.UTF_8)
        val held = ownedWakeLockHeld(power, uid, pid)
        return JSONObject().put("serviceCount", services.size)
            .put("foreground", services.singleOrNull()?.let { it.pid == pid && it.uid == uid && it.foreground } == true)
            .put("notificationCount", notifications.size)
            .put("notificationForeground", notifications.singleOrNull()?.let {
                it.packageName == context.packageName &&
                    it.notification.flags and android.app.Notification.FLAG_FOREGROUND_SERVICE != 0
            } == true).put("notificationRunning", notifications.singleOrNull()?.let {
                // Ongoing "lazysh is running" with the one owned session; no other text is retained.
                val extras = it.notification.extras
                it.isOngoing && it.notification.contentIntent != null &&
                    extras.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString() ==
                        context.getString(R.string.session_notification_title) &&
                    extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString() ==
                        context.resources.getQuantityString(R.plurals.session_notification_sessions, 1, 1)
            } == true).put("wakeLock", held)
    }

    private fun initialNotificationReady(sample: JSONObject, observedAt: Long, deadline: Long): Boolean {
        require(observedAt < deadline) { "Owned initial notification observation exceeded deadline" }
        require(sample.get("serviceCount") == 1 && sample.get("foreground") == true && sample.get("wakeLock") == true) {
            "Owned initial notification requires exact active kernel resources"
        }
        val count = sample.get("notificationCount")
        require((count == 0 && sample.get("notificationForeground") == false) ||
            (count == 1 && sample.get("notificationForeground") == true)) {
            "Owned initial notification identity or flags unverified"
        }
        return count == 1
    }

    @Test fun initialNotificationReadinessAllowsOnlyTimelyPublicationWithOwnedKernelResources() {
        val deadline = 100L
        fun sample() = JSONObject().put("serviceCount", 1).put("foreground", true).put("wakeLock", true)
            .put("notificationCount", 0).put("notificationForeground", false)
        val pending = sample()
        assertFalse(initialNotificationReady(pending, deadline - 1, deadline))
        val ready = sample().put("notificationCount", 1).put("notificationForeground", true)
        assertTrue(initialNotificationReady(ready, deadline - 1, deadline))
        for (invalid in listOf(
            sample().put("serviceCount", 0), sample().put("serviceCount", 2),
            sample().put("foreground", false), sample().put("wakeLock", false),
            sample().put("notificationCount", 2), sample().put("notificationForeground", true),
            sample().put("notificationCount", 1), sample().put("notificationCount", "0"),
            sample().apply { remove("wakeLock") },
        )) assertTrue("Kernel, ownership and malformed notification observations must fail immediately",
            runCatching { initialNotificationReady(invalid, deadline - 1, deadline) }.isFailure)
        for (late in listOf(deadline, deadline + 1)) {
            for (observation in listOf(pending, ready)) assertTrue("Late pending and ready observations must fail",
                runCatching { initialNotificationReady(observation, late, deadline) }.isFailure)
        }
    }

    // Publishes this shell's PID and start time as `<directory>/<name>`, then waits for the host's `<name>-ack`.
    private fun hostReceipt(directory: String, name: String) =
        "printf '%s %s\\n' \"${'$'}${'$'}\" \"${'$'}(awk '{print ${'$'}22}' /proc/${'$'}${'$'}/stat)\" >$directory/$name.tmp; " +
            "mv $directory/$name.tmp $directory/$name; while ! test -f $directory/$name-ack; do sleep .1; done; "

    private fun verifyMoshBackground(scenario: ActivityScenario<MainActivity>, fixture: JSONObject, name: String, label: String) {
        val owned = fixture.getJSONObject("moshBackground")
        val directory = owned.getString("directory")
        val nonce = fixture.getString("nonce")
        val key = JSONObject.quote("__lazyshOwnedBackground_$nonce")
        val token = JSONObject.quote(UUID.randomUUID().toString())
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val process = android.os.Process.myPid()
        fun foreground() {
            val launch = requireNotNull(context.packageManager.getLaunchIntentForPackage(context.packageName))
            context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (scenario.state != androidx.lifecycle.Lifecycle.State.RESUMED && System.nanoTime() < deadline) Thread.sleep(50)
            assertEquals("Owned Mosh Activity must resume", androidx.lifecycle.Lifecycle.State.RESUMED, scenario.state)
        }
        fun home() {
            closeSoftKeyboard()
            assertTrue("Owned background action must reach Home", UiDevice.getInstance(instrumentation).pressHome())
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
            while (scenario.state != androidx.lifecycle.Lifecycle.State.CREATED && System.nanoTime() < deadline) Thread.sleep(50)
            assertEquals("Owned Mosh Activity must actually stop", androidx.lifecycle.Lifecycle.State.CREATED, scenario.state)
        }
        fun openFromNotification() {
            // The real shade row, as a user taps it; SystemUI sends the notification's own PendingIntent.
            val device = UiDevice.getInstance(instrumentation)
            assertTrue("Owned notification shade must open", device.openNotification())
            val row = device.wait(Until.findObject(By.text(context.getString(R.string.session_notification_title))), 5000)
            assertTrue("Owned ongoing notification must be visible in the shade", row != null)
            row!!.click()
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (scenario.state != androidx.lifecycle.Lifecycle.State.RESUMED && System.nanoTime() < deadline) Thread.sleep(50)
            assertEquals("Notification tap must resume the workspace Activity", androidx.lifecycle.Lifecycle.State.RESUMED, scenario.state)
        }
        fun send(command: String) = sendOwnedCommand(scenario, command, label)
        fun proof(text: String) = "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.includes(${JSONObject.quote(text)}))"
        fun record(part: String) = hostReceipt(directory, "background-$part")
        fun execution(active: Boolean) {
            val sample = connectionExecutionObservation()
            val valid = if (active) sample.getInt("serviceCount") == 1 && sample.getBoolean("foreground") &&
                sample.getInt("notificationCount") == 1 && sample.getBoolean("notificationForeground") &&
                sample.getBoolean("notificationRunning") && sample.getBoolean("wakeLock")
            else sample.getInt("serviceCount") == 0 && sample.getInt("notificationCount") == 0 && !sample.getBoolean("wakeLock")
            assertTrue("Owned connection execution active=$active observation=$sample", valid)
        }
        var primary: Throwable? = null
        try {
            awaitDocument(scenario, "owned Mosh terminal ready", "document.querySelectorAll('.terminal-canvas .xterm-screen').length===1")
            assertEquals("Owned Mosh observation must retain one exact terminal", "true", evaluate(scenario, """
                (()=>{if(Object.prototype.hasOwnProperty.call(window,$key))return false;
                  const terminal=document.querySelector('.terminal-canvas');if(!terminal)return false;
                  Object.defineProperty(window,$key,{value:{token:$token,terminal},configurable:true});return true;})()
            """))
            val ready = "BG_${nonce}_READY"
            // The finite writer stops only on the fresh post-foreground shell
            // command. Its private receipt rejects expiry and counts real output.
            send(record("before") + "(i=0; while ! test -f $directory/background-stop && test ${'$'}i -lt 900; do " +
                "case ${'$'}((i%4)) in 0)c=A;;1)c=B;;2)c=C;;3)c=D;;esac; " +
                "printf '\\033[2J\\033[H'; printf '%01000d\\n' 0 | tr '0' \"${'$'}c\"; " +
                "printf 'BG_%s_READY\\n' '$nonce'; i=${'$'}((i+1)); sleep .1; done; " +
                "printf '%s\\n' \"${'$'}i\" >$directory/background-samples; " +
                "if ! test -f $directory/background-stop; then touch $directory/background-expired; fi) & BG_JOB=${'$'}!")
            awaitDocument(scenario, "owned Mosh busy output started", proof(ready))
            // Android may defer the first FGS notification publication for 10s.
            // Keep kernel resources mandatory throughout this initial-only wait.
            val notificationUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (true) {
                assertTrue("Owned initial notification publication exceeded deadline", System.nanoTime() < notificationUntil)
                val sample = connectionExecutionObservation()
                if (initialNotificationReady(sample, System.nanoTime(), notificationUntil)) break
                Thread.sleep(100)
            }
            execution(true)
            home()
            val backgroundUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(36)
            while (System.nanoTime() < backgroundUntil) {
                assertEquals("Owned Mosh must stay stopped during busy output", androidx.lifecycle.Lifecycle.State.CREATED, scenario.state)
                execution(true)
                Thread.sleep(1000)
            }
            openFromNotification()
            assertEquals("Owned Mosh must retain the native app process", process, android.os.Process.myPid())
            assertEquals("Owned Mosh must retain its exact terminal DOM", "true", evaluate(scenario,
                "window[$key]?.token===$token && window[$key].terminal===document.querySelector('.terminal-canvas') && window[$key].terminal.isConnected && document.querySelectorAll('.terminal-canvas').length===1 && Boolean(document.querySelector(${JSONObject.quote("button[aria-label='Disconnect $name']")}))"))
            val fresh = UUID.randomUUID().toString().replace("-", "")
            val response = "BG_${fresh}_RESUMED"
            // Dash reports the waited writer as "[1] + Done (<its whole command>)"
            // before its next prompt; `jobs` consumes that notice first. Send reopens the soft
            // keyboard, which resizes the Mosh screen, and mosh-server drops the bottom rows of a
            // shrink that a shell cannot redraw. Print the response only after that has settled.
            val challenge = "touch $directory/background-stop; wait \"${'$'}BG_JOB\"; jobs >/dev/null 2>&1; if ! test -f $directory/background-expired; then " +
                record("after") + "sleep 5; printf 'BG_%s_RESUMED\\n' '$fresh'; fi"
            require(!challenge.contains(response)) { "Owned Mosh challenge must not echo its response" }
            send(challenge)
            awaitDocument(scenario, "owned Mosh fresh response after background", proof(response), observe = { remaining ->
                runCatching { MoshBackgroundObservation.parse(evaluate(scenario,
                    MoshBackgroundObservation.expression(key, token, name), remaining)).toString() }.getOrDefault("unavailable")
            })
            execution(true)
            send("sleep 3; exit")
            home()
            val cleanupUntil = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            var released = false
            while (System.nanoTime() < cleanupUntil) {
                assertEquals("Last-worker release must occur before Activity foreground", androidx.lifecycle.Lifecycle.State.CREATED, scenario.state)
                val sample = connectionExecutionObservation()
                released = sample.getInt("serviceCount") == 0 && sample.getInt("notificationCount") == 0 && !sample.getBoolean("wakeLock")
                if (released) break
                Thread.sleep(100)
            }
            assertTrue("Owned last Mosh worker must release execution while Activity is stopped", released)
            println("lazysh Mosh background: >35s busy Home interval with the ongoing session notification, notification tap back to the same app/terminal, fresh remote challenge and last-worker foreground service/notification/wake-lock cleanup before foreground")
        } catch (failure: Throwable) { primary = failure; throw failure }
        finally {
            // The Activity has only just been brought back, so its WebView may not answer for a moment; retry briefly.
            val cleanupDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
            var cleanupFailure: Throwable? = null
            while (true) {
                cleanupFailure = try {
                    foreground()
                    assertEquals("Owned terminal observation must be removed", "true", evaluate(scenario,
                        "(()=>{const x=window[$key];if(!x)return true;if(x.token!==$token)return false;delete window[$key];return !Object.prototype.hasOwnProperty.call(window,$key);})()"))
                    null
                } catch (failure: Throwable) { failure }
                if (cleanupFailure == null || System.nanoTime() >= cleanupDeadline) break
                Thread.sleep(250)
            }
            cleanupFailure?.let { failure ->
                val closed = AssertionError("Owned Mosh background cleanup unavailable: ${failure.javaClass.simpleName} at ${failure.stackTrace.firstOrNull { it.className.startsWith("app.lazysh") }}")
                if (primary != null) primary!!.addSuppressed(closed) else throw closed
            }
        }
    }

    @Test fun moshBackgroundObservationNeverRetainsTerminalContentOrInterpretsTransportState() {
        val sample = JSONObject().put("retained", true).put("helperCount", "one").put("documentFocused", true)
            .put("activeKind", "terminal").put("readOnly", false).put("disabled", false).put("composerPresent", true)
            .put("composerEmpty", true).put("rendererConnected", false).put("globalError", true).put("unappliedEdit", false)
        assertEquals(sample.toString(), MoshBackgroundObservation.parse(sample.toString()).toString())
        val absent = JSONObject(sample.toString()).put("helperCount", "zero").put("readOnly", JSONObject.NULL)
            .put("disabled", JSONObject.NULL).put("composerPresent", false).put("composerEmpty", JSONObject.NULL)
            .put("rendererConnected", JSONObject.NULL).put("activeKind", "other")
        assertEquals(absent.toString(), MoshBackgroundObservation.parse(absent.toString()).toString())
        for (invalid in listOf("{", " ".repeat(769), JSONObject(sample.toString()).put("activeKind", "private text").toString(),
            JSONObject(sample.toString()).put("readOnly", "false").toString(), JSONObject(sample.toString()).put("rawDOM", "private text").toString(),
            JSONObject(sample.toString()).put("helperCount", "many").toString(), JSONObject(sample.toString()).put("composerEmpty", JSONObject.NULL).toString(),
            JSONObject(sample.toString()).apply { remove("retained") }.toString())) {
            assertTrue("Unexpected Mosh observation must be unavailable", runCatching { MoshBackgroundObservation.parse(invalid) }.isFailure)
        }
    }

    private fun moshTransportLabel(labels: List<String>): String {
        require(labels.size == 1 && labels.single() in setOf("Mosh", "Mosh (forced)")) {
            "Owned Mosh transport option is unavailable or ambiguous"
        }
        return labels.single()
    }

    @Test fun moshTransportChooserUsesItsOwnOptionLabelWithAutomaticTransportPresent() {
        for (label in listOf("Mosh", "Mosh (forced)")) {
            val options = listOf("auto" to "Auto", "ssh" to "SSH", "mosh" to label)
            assertEquals(label, moshTransportLabel(options.filter { it.first == "mosh" }.map { it.second }))
        }
        for (labels in listOf(emptyList(), listOf("Unknown"), listOf("Mosh", "Mosh (forced)"))) {
            assertTrue("Missing, unknown or ambiguous Mosh options must fail closed", runCatching { moshTransportLabel(labels) }.isFailure)
        }
    }

    /** Chooses one option through Chromium's native select popup, as a finger tap would. */
    private fun selectNativeOption(scenario: ActivityScenario<MainActivity>, nonce: String, selector: String, value: String, recordedSourceIndex: Int? = null) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        closeSoftKeyboard()
        assertEquals("Owned select control must be unique", "1", evaluate(scenario,
            "document.querySelectorAll(${JSONObject.quote(selector)}).length"))
        // Espresso's scroll atom leaves any partly visible control in place, so a select clipped
        // by the top of its scroll panel keeps its center under the navigation above it.
        // Reveal the whole control in its own scrollport before the unchanged hit-test guard.
        assertEquals("Owned select control must be revealed", "true", evaluate(scenario, """(() => {
          document.querySelector(${JSONObject.quote(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});
          return true;
        })()"""))
        // A DOM click atom does not activate Chromium's native select popup.
        // Read only this control's viewport geometry, then inject one native tap.
        val geometry = JSONArray(evaluate(scenario, """(() => {
          const target=document.querySelector(${JSONObject.quote(selector)});
          const r=target.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
          const hit=document.elementFromPoint(x,y), tag=hit?.tagName;
          const name=typeof tag==='string'?tag.toUpperCase():'';
          const allowed=new Set(['SELECT','OPTION','DIV','BUTTON','INPUT','TEXTAREA','LABEL','SPAN','HEADER','NAV','SECTION','P','FORM','HTML','BODY','SVG','PATH']);
          return [x,y,innerWidth,innerHeight,r.width,r.height,hit===target,hit?(allowed.has(name)?name:'OTHER'):'NONE'];
        })()"""))
        val values = (0..5).map { geometry.getDouble(it) }
        try {
            assertTrue("Transport control geometry must be finite and visible", values.all { it.isFinite() } &&
                values[2] > 0 && values[3] > 0 && values[4] > 0 && values[5] > 0 &&
                values[0] >= 0 && values[0] < values[2] && values[1] >= 0 && values[1] < values[3] && geometry.getBoolean(6))
        } catch (failure: Throwable) {
            runCatching {
                val cached = JSONObject().put("finite", values.all { it.isFinite() })
                    .put("positiveViewport", values[2] > 0 && values[3] > 0)
                    .put("nonzeroControl", values[4] > 0 && values[5] > 0)
                    .put("centerInside", values[0] >= 0 && values[0] < values[2] && values[1] >= 0 && values[1] < values[3])
                    .put("hitOwned", geometry.getBoolean(6))
                    .put("recordedSourceIndex", recordedSourceIndex?.takeIf { it in 0..2 } ?: "unavailable")
                if (recordedSourceIndex != null && recordedSourceIndex in 0..2) {
                    cached.put("hitTag", geometry.getString(7))
                        .put("bounds", JSONArray(values.map { it.toInt().coerceIn(-8192, 8192) }))
                }
                failure.addSuppressed(AssertionError("Owned select cached geometry: $cached"))
            }
            throw failure
        }
        val tapScript = instrumentation.context.assets.open("owned-native-tap.js")
            .use { it.readNBytes(4097) }.also { require(it.size <= 4096) { "Native tap script bound" } }.toString(Charsets.UTF_8)
        val tapKey = JSONObject.quote("__lazyshOwnedTransportTap_$nonce")
        val tapToken = JSONObject.quote(java.util.UUID.randomUUID().toString())
        val nativeTap = AtomicReference(JSONObject())
        var tapFailure: Throwable? = null
        try {
            assertEquals("Only a fresh case-owned passive tap observer may be installed", "true", evaluate(scenario, """
                (()=>{
                  if(Object.prototype.hasOwnProperty.call(window,$tapKey)) return false;
                  $tapScript
                  const tracker=ownedNativeTapObservation(document.querySelector(${JSONObject.quote(selector)}));
                  try {Object.defineProperty(window,$tapKey,{value:{token:$tapToken,tracker},configurable:true});}
                  catch(_){tracker.close();return false;}
                  return true;
                })()
            """))
            lateinit var point: FloatArray
            scenario.onActivity { activity ->
                val view = checkNotNull(webView(activity.window.decorView))
                val origin = IntArray(2)
                view.getLocationOnScreen(origin)
                nativeTap.set(JSONObject().put("origin", JSONArray(origin.map { it.coerceIn(-65535, 65535) }))
                    .put("width", view.width.coerceIn(0, 65535)).put("height", view.height.coerceIn(0, 65535))
                    .put("density", view.resources.displayMetrics.density.toDouble().coerceIn(0.0, 100.0))
                    .put("layoutRequested", view.isLayoutRequested).put("windowFocused", view.hasWindowFocus())
                    .put("attached", view.isAttachedToWindow).put("shown", view.isShown)
                    .put("imeVisible", ViewCompat.getRootWindowInsets(view.rootView)?.isVisible(WindowInsetsCompat.Type.ime()) ?: JSONObject.NULL))
                val scale = view.width.toDouble() / values[2]
                val x = values[0] * scale
                val y = values[1] * scale
                assertTrue("Transport control must remain inside the native WebView", x > 0 && x < view.width && y > 0 && y < view.height)
                point = floatArrayOf((origin[0] + x).toFloat(), (origin[1] + y).toFloat())
            }

            // Espresso's single tap can oversleep between events and turn the select into a long press.
            // Queue both native finger events without waiting for dispatch between DOWN and UP.
            val time = android.os.SystemClock.uptimeMillis()
            val finger = android.view.MotionEvent.PointerProperties().apply {
                id = 0
                toolType = android.view.MotionEvent.TOOL_TYPE_FINGER
            }
            val coordinates = android.view.MotionEvent.PointerCoords().apply { x = point[0]; y = point[1]; pressure = 1f; size = 1f }
            for (action in listOf(android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP)) {
                val event = android.view.MotionEvent.obtain(time, time, action, 1, arrayOf(finger), arrayOf(coordinates),
                    0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
                try {
                    assertTrue("Android accepted the owned transport tap", instrumentation.uiAutomation.injectInputEvent(event, false))
                } finally {
                    event.recycle()
                }
            }
            instrumentation.waitForIdleSync()
            val transportLabel = if (value == "mosh") {
                val labels = JSONArray(evaluate(scenario,
                    "Array.from(document.querySelectorAll(${JSONObject.quote("$selector option[value=mosh]")})).map(x=>x.label)"))
                moshTransportLabel((0 until labels.length()).map { labels.getString(it) })
            } else if (value == "herdr") "Herdr" else if (value == "ssh") "SSH" else {
                val labels = JSONArray(evaluate(scenario, "Array.from(document.querySelectorAll(${JSONObject.quote("$selector option[value='$value']")})).map(x=>x.label)"))
                require(labels.length() == 1 && labels.getString(0).length in 1..128)
                labels.getString(0)
            }
            // The popup opens scrolled to the current choice, so an option further down has no row
            // view yet. Scroll its row on screen by the select's option index before matching it.
            val position = evaluate(scenario, "Array.from(document.querySelector(${JSONObject.quote(selector)}).options).findIndex(x=>x.value===${JSONObject.quote(value)})").toInt()
            require(position >= 0) { "Owned select option must exist" }
            val chooser = anyOf(isDialog(), isPlatformPopup())
            onData(anything()).inAdapterView(isAssignableFrom(ListView::class.java)).inRoot(chooser).atPosition(position).check(matches(isDisplayed()))
            val option = onView(withText(transportLabel)).inRoot(chooser)
            option.check(matches(isDisplayed()))
            println("lazysh SSH UI: native transport chooser ready")
            option.perform(click())
            assertEquals("SSH must be selected through the actual chooser", "true", evaluate(scenario,
                "document.querySelector(${JSONObject.quote(selector)})?.value===${JSONObject.quote(value)}"))
            println("lazysh SSH UI: native transport selected")
        } catch (failure: Throwable) {
            tapFailure = failure
            val observation = runCatching {
                val events = JSONObject(evaluate(scenario,
                    "(()=>{const owned=window[$tapKey];return owned?.token===$tapToken?owned.tracker.read():null;})()", 1000))
                JSONObject().put("geometry", geometry).put("native", nativeTap.get()).put("events", events)
                    .toString().also { require(it.length <= 4096) { "Native tap observation bound" } }
            }.getOrDefault("unavailable")
            failure.addSuppressed(AssertionError("Owned native transport tap: $observation"))
            throw failure
        } finally {
            val removed = runCatching { evaluate(scenario, """
                (()=>{const owned=window[$tapKey];if(!owned)return true;if(owned.token!==$tapToken)return false;
                  owned.tracker.close();delete window[$tapKey];return !Object.prototype.hasOwnProperty.call(window,$tapKey);})()
            """, 1000) == "true" }.getOrDefault(false)
            if (!removed) {
                val cleanupFailure = AssertionError("Owned native tap observer cleanup unavailable")
                if (tapFailure != null) tapFailure!!.addSuppressed(cleanupFailure) else throw cleanupFailure
            }
        }
    }
    private fun grantOwnedNotifications() {
        // lazysh asks for POST_NOTIFICATIONS on a first connection; granting it first keeps any
        // system prompt off the WebView.
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        if (Build.VERSION.SDK_INT >= 33) {
            if (context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
            assertEquals("Owned background notification permission must precede connection", PackageManager.PERMISSION_GRANTED,
                context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS))
        }
    }
    /** A first install that has never answered the prompt: no grant, no remembered request, no user flags. */
    private fun denyOwnedNotifications() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        if (context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            instrumentation.uiAutomation.revokeRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        instrumentation.uiAutomation.executeShellCommand("pm clear-permission-flags ${context.packageName} android.permission.POST_NOTIFICATIONS user-set user-fixed")
            .use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
        context.getSharedPreferences("lazysh-session-notification", Context.MODE_PRIVATE).edit().clear().commit()
    }

    /** The prompt appears once the first session is adopted; denying it must leave the session running. */
    private fun denyFirstNotificationPrompt() {
        val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        val denyButton = By.res("com.android.permissioncontroller", "permission_deny_button")
        assertNotNull("First connection must show notification permission", device.wait(Until.findObject(denyButton), 60_000))
        // A click sent while the dialog's window is still starting is dropped by the input dispatcher; click again until it closes.
        val closeBy = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
        while (true) {
            device.findObject(denyButton)?.click()
            if (device.wait(Until.gone(denyButton), 3_000)) break
            assertTrue("Notification permission prompt must close after Deny", System.nanoTime() < closeBy)
        }
        assertEquals(PackageManager.PERMISSION_DENIED,
            InstrumentationRegistry.getInstrumentation().targetContext.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS))
    }

    /** Denied: no notification reaches the shade, and the app's own Settings row opens the system page and returns. */
    private fun openNotificationSettingsAfterDenial(scenario: ActivityScenario<MainActivity>) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val device = UiDevice.getInstance(instrumentation)
        assertFalse("Denied notifications must not be visible", context.getSystemService(android.app.NotificationManager::class.java).areNotificationsEnabled())
        assertTrue("Notification shade must open", device.openNotification())
        assertFalse("Denied connection notification must stay out of the shade", device.hasObject(By.text(context.getString(R.string.session_notification_title))))
        // Back sent while the shade is still expanding is ignored and the shade then holds the focus: collapse it explicitly.
        NativeActivityFixture.clearSystemOverlays()
        awaitDocument(scenario, "shade closed after the denied-notification check", "true")
        openPreferences(scenario)
        preferencesCategory(scenario, "android-notifications")
        webButton("Open Android notification settings")
        val settings = By.pkg("com.android.settings")
        assertTrue("Android notification settings must open", device.wait(Until.hasObject(settings), 10_000))
        // UiDevice.pressBack waits for a generic accessibility event that can be absent after a successful return.
        assertTrue("Back key must dispatch from notification settings", device.pressKeyCode(KeyEvent.KEYCODE_BACK))
        assertTrue("Android notification settings must close after Back", device.wait(Until.gone(settings), 10_000))
        awaitDocument(scenario, "returned to application preferences", "Boolean(document.querySelector(\"button[aria-label='Close Preferences']\"))")
        closePreferences()
    }

    /** Cancels an open connection or trust dialog; an already-visible error does not abort the wait. */
    private fun dismissOwnedAuthentication(scenario: ActivityScenario<MainActivity>) {
        val authentication = "[role=dialog] textarea, [role=dialog] .fingerprint code, [role=dialog] .destination"
        if (evaluate(scenario, present(authentication)) != "true") return
        clickOwnedButton("Cancel")
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (true) {
            assertTrue("Owned SSH authentication dialog did not dismiss", System.nanoTime() < deadline)
            val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime()).coerceAtLeast(1)
            if (evaluate(scenario, "!" + present(authentication), remaining) == "true") break
            Thread.sleep(50)
        }
    }

    /** Opens the hosts drawer only when it is closed, so a second host action never meets an inert workspace. */
    private fun revealOwnedHosts(scenario: ActivityScenario<MainActivity>) {
        val add = "button[aria-label='Add host']"
        if (evaluate(scenario, workspaceElementVisible(add, true)) == "true") return
        keepTopBar(scenario)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
        // A live remote connection opens the drawer on Agents; the host list is the Connections tab.
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[data-workspace-mode='connections']")).perform(webClick())
        awaitDocument(scenario, "hosts drawer open", workspaceElementVisible(add, true),
            observe = { remaining -> evaluate(scenario, """JSON.stringify({dialogs:Array.from(document.querySelectorAll('[role=dialog]')).map(d=>d.getAttribute('aria-label')),
                inert:document.querySelector('main.workspace')?.inert,add:Boolean(document.querySelector(${JSONObject.quote(add)})),
                mode:Array.from(document.querySelectorAll('[data-workspace-mode]')).filter(x=>x.getAttribute('aria-pressed')==='true'||x.getAttribute('aria-current')).map(x=>x.getAttribute('data-workspace-mode')),
                text:document.body.innerText.slice(0,160)})""", remaining) })
    }

    private fun deleteOwnedHost(scenario: ActivityScenario<MainActivity>, name: String) {
        revealOwnedHosts(scenario)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Delete $name']")).perform(webClick())
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "[role='dialog'][aria-label='Delete host'] button.danger-button")).perform(webClick())
        awaitDocument(scenario, "owned SSH host deleted", "!" + present("button[aria-label='Connect to $name']"))
    }

    /** Reviews the exact first-use fingerprint for `endpoint` and trusts it; no terminal may exist before. */
    private fun trustOwnedHostKey(scenario: ActivityScenario<MainActivity>, fingerprint: String, endpoint: String) {
        awaitDocument(scenario, "explicit SSH fingerprint review for $endpoint",
            "document.querySelector('.fingerprint code')?.textContent===${JSONObject.quote(fingerprint)}")
        assertEquals("Owned trust dialog must name its endpoint", "true", evaluate(scenario,
            "Boolean(document.querySelector('[role=dialog]')?.textContent.includes(${JSONObject.quote(endpoint)}))"))
        assertEquals("No terminal before explicit trust", "false", evaluate(scenario, present(".terminal-canvas .xterm-screen")))
        clickOwnedButton("Trust key and connect")
    }

    private fun clickOwnedButton(text: String) {
        onWebView().withElement(findElement(Locator.XPATH,
            "//button[@aria-label='$text' or (not(@aria-label) and normalize-space(text())='$text')]")).perform(webClick())
    }

    private fun terminalScreenContains(text: String) =
        "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.includes(${JSONObject.quote(text)}))"

    /** Adds a host through the real editor; `configure` sets anything beyond the address before Save. */
    private fun addOwnedHost(scenario: ActivityScenario<MainActivity>, name: String, hostname: String, username: String, port: Int,
        configure: () -> Unit = {}) {
        awaitDocument(scenario, "SSH workspace ready", present("button[aria-label='Add host']"))
        revealOwnedHosts(scenario)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Add host']")).perform(webClick())
        typeInto(scenario, "input[placeholder='Home workstation']", name)
        typeInto(scenario, "input[placeholder='workstation.local']", hostname)
        typeInto(scenario, "input[placeholder='Your SSH username']", username)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".port-field input")).perform(webClick())
        onView(isAssignableFrom(WebView::class.java)).perform(
            pressKey(EspressoKey.Builder().withKeyCode(KeyEvent.KEYCODE_A).withCtrlPressed(true).build()),
            pressKey(KeyEvent.KEYCODE_DEL))
        typeInto(scenario, ".port-field input", port.toString())
        configure()
        clickOwnedButton("Save host")
        awaitDocument(scenario, "SSH fixture host saved", present("button[aria-label='Connect to $name']"))
    }

    /** Composes one shell line and submits it with the composer's own Send. */
    private fun sendOwnedCommand(scenario: ActivityScenario<MainActivity>, command: String, label: String) {
        if (evaluate(scenario, "Boolean(document.querySelector('.terminal-compose textarea'))") != "true")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Compose']")).perform(webClick())
        pasteOwnedText(scenario, ".terminal-compose textarea", command, label)
        closeSoftKeyboard()
        // Send pastes the draft and submits it with its own Enter.
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Send']")).perform(webClick())
        closeSoftKeyboard()
    }

    private fun ownedSshUi(requireHerdr: Boolean, requireCompanion: Boolean = false, requireMoshBackground: Boolean = false, requireHerdrMosh: Boolean = false, requireSharedHerdr: Boolean = false, requireAttachments: Boolean = false, requireIme: Boolean = false, requireDpad: Boolean = false, requireRecorded: Boolean = false, requireTmux: Boolean = false, requireDeniedNotification: Boolean = false, requireZellij: Boolean = false, nativeTmux: Boolean = false, nativeZellij: Boolean = false, requireTmuxAgent: Boolean = false) {
        require(!requireTmuxAgent || (requireTmux && !nativeTmux)) { "Owned tmux agent mode requires the packaged tmux fixture" }
        require(!requireZellij || (!requireHerdr && !requireCompanion && !requireMoshBackground && !requireHerdrMosh && !requireSharedHerdr && !requireAttachments && !requireIme && !requireDpad && !requireRecorded && !requireTmux)) { "Owned Zellij mode must be isolated" }
        require(!requireTmux || (!requireHerdr && !requireCompanion && !requireMoshBackground && !requireHerdrMosh && !requireSharedHerdr && !requireAttachments && !requireIme && !requireDpad && !requireRecorded)) { "Owned tmux mode must be isolated" }
        require(!requireRecorded || (!requireHerdr && !requireCompanion && !requireMoshBackground && !requireHerdrMosh && !requireSharedHerdr && !requireAttachments && !requireIme && !requireDpad)) { "Recorded conversation mode must be isolated" }
        require(!requireDpad || (!requireHerdr && !requireCompanion && !requireMoshBackground && !requireHerdrMosh && !requireSharedHerdr && !requireAttachments && !requireIme)) { "Owned D-pad mode must be isolated" }
        require(!requireIme || (!requireHerdr && !requireCompanion && !requireMoshBackground && !requireHerdrMosh && !requireSharedHerdr && !requireAttachments)) { "Owned IME mode must be isolated" }
        require(!requireAttachments || (!requireHerdr && !requireCompanion && !requireMoshBackground)) { "Owned attachment mode must be isolated" }
        require(!requireSharedHerdr || (requireHerdr && !requireHerdrMosh)) { "Shared Herdr navigation requires its SSH fixture" }
        require(!requireHerdrMosh || requireHerdr) { "Owned Mosh Herdr mode requires Herdr" }
        val useMosh = requireMoshBackground || requireHerdrMosh || requireAttachments
        require(listOf(requireHerdr, requireCompanion, requireMoshBackground).count { it } <= 1) { "Owned SSH fixture mode is ambiguous" }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val fixture = ownedSshFixture()
        if (requireHerdr) require(fixture.getJSONObject("herdr").getString("name") == "owned-guard") { "Owned Herdr fixture required" }
        require(requireHerdrMosh == fixture.optBoolean("herdrMosh", false)) { "Owned Herdr transport fixture mismatch" }
        require(requireRecorded == fixture.has("recorded")) { "Recorded fixture mode mismatch" }
        require(requireDpad == fixture.has("dpad")) { "Owned D-pad fixture mode mismatch" }
        require(requireIme == fixture.has("ime")) { "Owned IME fixture mode mismatch" }
        require(requireAttachments == fixture.has("attachments")) { "Owned attachment fixture mode mismatch" }
        require(requireTmux == fixture.has("tmux")) { "Owned tmux fixture mode mismatch" }
        require(requireZellij == fixture.has("zellij")) { "Owned Zellij fixture mode mismatch" }
        val nonce = fixture.getString("nonce")
        require(Regex("[a-f0-9]{32}").matches(nonce)) { "Invalid owned SSH nonce" }
        val name = "Android SSH $nonce"
        val connectedName = if (requireHerdrMosh) "$name / ${fixture.getJSONObject("herdr").getString("name")}" else name
        require(fixture.getString("name") == name && fixture.getInt("port") in 1..65535)
        val privateKey = fixture.getString("privateKey")
        require(privateKey.length in 1..8192) { "Invalid owned identity size" }
        if (requireMoshBackground) {
            val owned = fixture.getJSONObject("moshBackground")
            require(owned.getString("host") == "10.0.2.2") { "Owned Mosh requires the emulator host route" }
            require(Regex("/tmp/lazysh-android-ssh-[A-Za-z0-9_-]+").matches(owned.getString("directory"))) {
                "Owned Mosh directory invalid"
            }
        }
        // lazysh asks for POST_NOTIFICATIONS on a first connection; every owned connection case
        // grants it first, so no system prompt covers the WebView. The Mosh background case
        // proves the granted-permission notification record.
        val context = instrumentation.targetContext
        if (requireDeniedNotification) denyOwnedNotifications() else grantOwnedNotifications()
        val scenario = NativeActivityFixture.scenario
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val label = "lazysh-ui-ssh-$nonce"
        fun clickButton(text: String) = clickOwnedButton(text)
        fun screenContains(text: String) = terminalScreenContains(text)
        fun selectOwnedOption(selector: String, value: String, recordedSourceIndex: Int? = null) =
            selectNativeOption(scenario, nonce, selector, value, recordedSourceIndex)
        fun selectTransport() = selectOwnedOption("[role=dialog] select:has(option[value='ssh'])", if (useMosh) "mosh" else "ssh")
        fun sendShell(command: String) {
            if (evaluate(scenario, present(".terminal-compose textarea")) != "true") clickButton("Compose")
            typeInto(scenario, ".terminal-compose textarea", command)
            closeSoftKeyboard()
            clickButton("Send")
            closeSoftKeyboard()
        }
        fun terminalProof(after: Boolean) {
            val part = if (after) "after" else "before"
            val proof = "COMPANION_${nonce}_${part}_END"
            val command = (if (after) "" else "LI='$nonce';") + "printf 'COMPANION_%s_${part}_END\\n' \"${'$'}LI\""
            assertTrue("Owned shell proof must not appear literally in its input", !command.contains(proof))
            sendShell(command)
            awaitDocument(scenario, "owned companion terminal continuity $part", screenContains(proof) +
                " && Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.lastIndexOf(${JSONObject.quote(fixture.getString("prompt"))})>x.textContent.indexOf(${JSONObject.quote(proof)}))")
            assertEquals("Owned companion must keep exactly one session tab", "true", evaluate(scenario,
                "document.querySelectorAll('[role=tab]').length===1 && Boolean(document.querySelector(${JSONObject.quote("button[aria-label='Disconnect $name']")}))"))
        }
        fun verifyRecordedConversations() {
            val recorded = fixture.getJSONObject("recorded")
            require(recorded.getString("provenance") == "synthetic")
            val sources = recorded.getJSONArray("sources")
            require(sources.length() == 3)
            var messages = sources.getJSONObject(0).getJSONArray("messages")
            require(messages.length() == 2)
            val key = JSONObject.quote("__ownedRecorded_$nonce")
            val token = JSONObject.quote(java.util.UUID.randomUUID().toString())
            val originalProcess = android.os.Process.myPid()
            lateinit var originalWeb: WebView
            scenario.onActivity { current -> originalWeb = requireNotNull(webView(current.window.decorView)) }
            assertEquals("Retain only the original owned terminal and document", "true", evaluate(scenario, """
                (()=>{const screen=document.querySelector('.terminal-canvas .xterm-screen');
                  if(!screen || Object.prototype.hasOwnProperty.call(window,$key))return false;
                  window[$key]={token:$token,screen,document,tab:document.querySelector('[role=tab]')};return true;})()
            """))
            fun owner() {
                assertEquals(originalProcess, android.os.Process.myPid())
                scenario.onActivity { current ->
                    assertEquals(androidx.lifecycle.Lifecycle.State.RESUMED, current.lifecycle.currentState)
                    assertTrue(current.hasWindowFocus())
                    assertTrue(webView(current.window.decorView) === originalWeb && originalWeb.isAttachedToWindow)
                }
                assertEquals("Recorded reads retain the original document, tab and terminal", "true", evaluate(scenario, """
                    (()=>{const owned=window[$key];return !!owned && owned.token===$token && owned.document===document && owned.screen.isConnected &&
                      owned.screen===document.querySelector('.terminal-canvas .xterm-screen') && owned.tab===document.querySelector('[role=tab]') && document.querySelectorAll('[role=tab]').length===1;})()
                """))
            }
            // The host fixture carries the page functions the Linux case evaluates too (tests/support/recordedCards.ts).
            val page = recorded.getJSONObject("page")
            fun pageCall(name: String, argument: JSONArray, observe: Boolean = false) = "(${page.getString(name)})($argument,$observe)"
            fun exactMessages(): String = pageCall("messages", messages)
            fun awaitPage(stage: String, name: String, argument: JSONArray) {
                try {awaitDocument(scenario, stage, pageCall(name, argument))}
                catch (failure: Throwable) {
                    runCatching {failure.addSuppressed(AssertionError("Recorded page observation: " + evaluate(scenario, pageCall(name, argument, true))))}
                    throw failure
                }
            }
            val cards = recorded.getJSONArray("cards")
            require(cards.length() == 8)
            var primary: Throwable? = null
            try {
                terminalProof(false)
                sessionView(scenario, "Transcript")
                val path = "input[placeholder='Absolute host path to session.jsonl']"
                for (index in 0 until sources.length()) {
                    val source = sources.getJSONObject(index)
                    messages = source.getJSONArray("messages")
                    require(messages.length() == 2)
                    require(source.getString("agent") == if (index == 0) "codex" else "opencode")
                    require(Regex("/tmp/lazysh-android-ssh-[A-Za-z0-9_-]+/recorded-conversations/(recorded[.]jsonl|opencode-v[12][.]db)").matches(source.getString("path")))
                    selectOwnedOption(".chat-panel select:has(option[value='codex'])", source.getString("agent"), recordedSourceIndex = index)
                    selectOwnedOption(".chat-panel select:has(option[value='conversation'])", "conversation", recordedSourceIndex = index)
                    val fields = listOfNotNull(path to source.getString("path"),
                        if (index > 0) ".chat-panel input[required]:not([placeholder])" to source.getString("sessionId") else null)
                    for ((selector, value) in fields) replaceNativeText(scenario, selector, value)
                    closeSoftKeyboard();clickButton("Open transcript")
                    awaitPage("exact synthetic recorded source $index", "messages", messages)
                    owner()
                }
                val draft = "Owned unsent Android recorded Conversation draft"
                pasteOwnedText(scenario, "form.chat-composer textarea", draft, label);closeSoftKeyboard()
                val region = ".chat-conversation-messages"
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, region)).perform(webScrollIntoView()).perform(webClick())
                onView(isAssignableFrom(WebView::class.java)).perform(pressKey(KeyEvent.KEYCODE_MOVE_HOME))
                val home = "(()=>{const r=document.querySelector('$region');return !!r&&document.activeElement===r&&r.scrollHeight>r.clientHeight&&r.scrollTop===0;})()"
                awaitDocument(scenario, "overflowing recorded reader at Home", home)
                val observeRefresh = """
                    (()=>{const owned=window[$key];
                      if(!owned || owned.token!==$token || owned.document!==document || owned.refresh)return false;
                      const panel=document.querySelector('.chat-panel');
                      // Refresh is an icon button named by aria-label; match by the same name clickButton uses.
                      const named=x=>x.hasAttribute('aria-label')?x.getAttribute('aria-label'):x.textContent.trim();
                      const buttons=Array.from(panel?.querySelectorAll('button')??[]).filter(x=>named(x)==='Refresh new messages');
                      if(buttons.length!==1 || buttons[0].disabled!==false)return false;
                      const button=buttons[0],state={button,panel,started:false,settled:false,observer:null};
                      const observer=new MutationObserver(records=>{
                        if(window[$key]!==owned || owned.token!==$token || owned.document!==document){observer.disconnect();return;}
                        const changes=records.filter(record=>record.target===button&&record.attributeName==='disabled');
                        for(let i=0;i<changes.length;i++){
                          const disabled=i+1<changes.length?changes[i+1].oldValue!==null:button.disabled;
                          if(disabled===true)state.started=true;else if(disabled===false&&state.started)state.settled=true;
                        }
                      });
                      state.observer=observer;owned.refresh=state;
                      observer.observe(button,{attributes:true,attributeFilter:['disabled'],attributeOldValue:true});return true;})()
                """
                val refreshCompleted = """
                    (()=>{const owned=window[$key];
                      if(!owned || owned.token!==$token || owned.document!==document)return false;
                      const state=owned.refresh;
                      return owned.screen.isConnected &&
                        owned.screen===document.querySelector('.terminal-canvas .xterm-screen') && owned.tab===document.querySelector('[role=tab]') &&
                        !!state && state.started===true && state.settled===true && state.button.isConnected && state.button.disabled===false &&
                        state.panel===document.querySelector('.chat-panel') && state.panel.contains(state.button) && !state.panel.querySelector('[role=alert]');})()
                """
                assertEquals("Observe only the original enabled Refresh button", "true", evaluate(scenario, observeRefresh))
                clickButton("Refresh new messages")
                awaitDocument(scenario, "recorded Refresh preserves exact messages, reading position and draft", refreshCompleted + " && " + exactMessages() +
                    " && document.querySelector('$region')?.scrollTop===0 && document.querySelector('form.chat-composer textarea')?.value===" + JSONObject.quote(draft))
                sessionView(scenario, "Terminal");owner();sessionView(scenario, "Transcript")
                awaitDocument(scenario, "recorded reader return preserves the unsent draft", exactMessages() +
                    " && document.querySelector('$region')?.scrollTop===0 && document.querySelector('form.chat-composer textarea')?.value===" + JSONObject.quote(draft))
                assertEquals("Recorded history does not grant Send", "false", evaluate(scenario,
                    "Array.from(document.querySelectorAll('button')).some(x=>x.textContent==='Send to terminal'||x.textContent==='Confirm this destination')"))
                clickButton("Stage in terminal")
                awaitDocument(scenario, "recorded draft staged without Send", "document.querySelector('.terminal-compose textarea')?.value===" + JSONObject.quote(draft))
                assertEquals("Stage does not send the draft", "false", evaluate(scenario, screenContains(draft)))
                owner();clickButton("Close composer")
                // Close keeps the unsent staged draft for this terminal; reopening shows it unsent.
                clickButton("Compose")
                awaitDocument(scenario, "closed composer keeps the unsent staged draft", "document.querySelector('.terminal-compose textarea')?.value===" + JSONObject.quote(draft))
                assertEquals("Reopening the kept draft does not send it", "false", evaluate(scenario, screenContains(draft)))
                // Clear it so the fresh proof below types into an empty draft.
                clickButton("Clear draft")
                awaitDocument(scenario, "cleared staged draft", "document.querySelector('.terminal-compose textarea')?.value===''")
                // Plans, questions, turn state, Markdown and thinking from the companion's real pages.
                sessionView(scenario, "Transcript")
                for (index in 0 until cards.length()) {
                    val card = cards.getJSONObject(index)
                    val agent = card.getString("agent")
                    require(agent in setOf("claude", "codex", "opencode") && card.getString("view") in setOf("conversation", "records"))
                    require(Regex("/tmp/lazysh-android-ssh-[A-Za-z0-9_-]+/recorded-conversations/cards/[a-z0-9-]+[.](jsonl|db)").matches(card.getString("path")))
                    selectOwnedOption(".chat-panel select:has(option[value='codex'])", agent)
                    selectOwnedOption(".chat-panel select:has(option[value='conversation'])", card.getString("view"))
                    replaceNativeText(scenario, path, card.getString("path"))
                    if (agent == "opencode") replaceNativeText(scenario, ".chat-panel input[required]:not([placeholder])", card.getString("sessionId"))
                    closeSoftKeyboard();clickButton("Open transcript")
                    awaitPage("recorded cards: ${card.getString("label")}", "cards", card.getJSONArray("checks"))
                    owner()
                }
                sessionView(scenario, "Terminal")
                terminalProof(true);owner()
                println("lazysh recorded Conversation: synthetic Codex and OpenCode V1/V2 exact; overflowing Home/Refresh, reader return, unsent Stage, ${cards.length()} recorded card pages and fresh original SSH proof completed")
            } catch (failure: Throwable) {primary = failure;throw failure}
            finally {
                try {assertEquals("Remove only the owned recorded observation", "true", evaluate(scenario,
                    "(()=>{const owned=window[$key];if(!owned)return true;if(owned.token!==$token)return false;owned.refresh?.observer.disconnect();delete window[$key];return !Object.prototype.hasOwnProperty.call(window,$key);})()"))}
                catch (cleanup: Throwable) {if(primary != null)primary!!.addSuppressed(cleanup) else throw cleanup}
            }
        }
        fun openReportedActivity() {
            sessionView(scenario, "Agents")
            val companionActivity = ".agent-section-jumps:not([hidden]) button[aria-label='Reported agent activity']"
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, companionActivity))
                .perform(webScrollIntoView()).perform(webClick())
        }
        fun returnToTerminal() {
            awaitDocument(scenario, "visible companion Connections navigation", workspaceButtonVisible(".workspace-navigation-modes", "Connections"))
            onWebView().withElement(findElement(Locator.XPATH,
                "//nav[contains(@class,'workspace-navigation-modes')]/button[normalize-space(.)='Connections']"))
                .perform(webScrollIntoView()).perform(webClick())
            awaitDocument(scenario, "visible companion drawer close", workspaceElementVisible(".sidebar-close", true))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".sidebar-close")).perform(webClick())
        }
        // The host prepared `board` and `approvals`: each runs the installed companion exactly
        // as a configured Claude hook does (tests/support/androidAgentBoard.ts).
        fun hostHooks(script: String) {
            val marker = script.uppercase()
            sendShell("sh $script && printf '${marker}_%s_END\\n' \"${'$'}LI\"")
            awaitDocument(scenario, "owned companion $script hooks ran", screenContains("${marker}_${nonce}_END"))
        }
        fun verifyCompanionHookBoard() {
            val board = ".workspace-navigation-agents:not([hidden]) > .agent-panel:not([hidden]) .agent-board"
            val rows = """(state=>Array.from(document.querySelectorAll(${JSONObject.quote(board)}+" .agent-column[data-state='"+state+"'] .agent-card"))
                .map(card=>card.querySelector('.agent-row-summary')?.textContent+'|'+card.querySelector(".row-tag[data-tone='project']")?.textContent).sort().join(','))"""
            val cards = "Array.from(document.querySelectorAll('.approval-panel:not([hidden]) .approval-card'))"
            // A Zellij or Herdr pane is named by its server (the host's session, pane ids and their numbers vary); a tap that answers the hook proves the exact pane, because the companion refuses any other.
            val paneKind = """x=>x.replace(/^zellij:lazysh-approvals:[0-9]+${'$'}/,'zellij').replace(/^herdr:[A-Za-z0-9._-]+:w[0-9A-Z]+:p[0-9A-Z]+${'$'}/,'herdr')"""
            val approvals = """$cards.map(card=>Array.from(card.querySelectorAll('.approval-facts dd')).map(x=>($paneKind)(x.textContent)).join('|')+'|'+JSON.parse(card.querySelector('.approval-input')?.textContent||'null')?.command).sort().join(',')"""
            val observe = { remaining: Long -> evaluate(scenario, "JSON.stringify({needs:$rows('needs_attention'),working:$rows('working'),done:$rows('done'),approvals:$approvals,alert:document.querySelector('.approval-panel [role=alert]')?.textContent??''})", remaining) }
            hostHooks("board")
            openReportedActivity()
            // Six events from four sessions: Working, Needs you and Done, and the three events of
            // board-alpha collapse into its one Done row. The host dated board-aged back eight days
            // after its hook ran, so the companion drops it when the board reads: it is no fourth row.
            awaitDocument(scenario, "real hook events rendered on the board without the aged report",
                "$rows('needs_attention')==='Agent needs attention|beta' && $rows('working')==='Working on your prompt|delta' && $rows('done')==='Turn finished|alpha'" +
                " && document.querySelectorAll(${JSONObject.quote("$board .agent-card")}).length===3", observe = observe)
            assertEquals("Hook prompt and tool input must stay on the host", "false", evaluate(scenario,
                "document.body.textContent.includes('PRIVATE-PROMPT') || document.body.textContent.includes('SECRET-TOKEN')"))
            returnToTerminal()
            hostHooks("approvals")
            openReportedActivity()
            awaitDocument(scenario, "waiting hooks, two in real Zellij and Herdr panes, listed above the board and in Needs you",
                "$approvals==='/work/epsilon|approval-host|%9|git tag --list,/work/eta|approval-zellij|zellij|git push --dry-run origin,/work/gamma|approval-allow|%7|git push --dry-run,/work/theta|approval-herdr|herdr|git push --force-with-lease,/work/zeta|approval-deny|%8|git push --force'" +
                " && $rows('needs_attention')==='Agent needs attention|beta,Bash|epsilon,Bash|eta,Bash|gamma,Bash|theta,Bash|zeta'" +
                " && !!(document.querySelector('.approval-panel:not([hidden])')?.compareDocumentPosition(document.querySelector(${JSONObject.quote(board)}))&Node.DOCUMENT_POSITION_FOLLOWING)", observe = observe)
            for ((session, decision) in listOf("approval-allow" to "allow", "approval-deny" to "deny", "approval-zellij" to "allow", "approval-herdr" to "deny")) {
                val card = "//article[contains(@class,'approval-card')][.//dd[normalize-space(.)='$session']]"
                val state = "(card=>document.querySelector('.approval-panel [role=alert]')?'alert':!card?'gone':card.querySelector('.approval-$decision').disabled?'busy':'ready')($cards.find(card=>card.textContent.includes('$session')))"
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
                // A periodic refresh disables every answer button, so a tap that lands meanwhile is
                // dropped or refused; tap again until the request leaves the list. An accepted tap
                // removes the card in the same render that re-enables the buttons.
                var refused: Throwable? = null
                while (true) {
                    val current = evaluate(scenario, state)
                    if (current == "\"gone\"") break
                    if (current == "\"alert\"" || System.nanoTime() >= deadline) throw AssertionError("remote $decision not accepted: ${observe(1_000)}", refused)
                    if (current == "\"ready\"") refused = runCatching {
                        onWebView().withElement(findElement(Locator.XPATH, "$card//button[contains(@class,'approval-$decision')]"))
                            .perform(webScrollIntoView()).perform(webClick())
                    }.exceptionOrNull() ?: refused
                    Thread.sleep(1_000)
                }
            }
            // The host ends approval-host once the four decisions reached their hooks; the next refresh drops it.
            awaitDocument(scenario, "request answered at the host cleared", "$cards.length===0 && !document.querySelector('.approval-panel [role=alert]')", observe = observe)
            println("lazysh companion board: real hook events rendered by state with one row per session and no aged report; device Allow and Deny accepted for tmux, Zellij and Herdr panes; host-answered request cleared")
        }
        fun verifyCompanionInstallation() {
            val companion = fixture.getJSONObject("companion")
            val version = companion.getString("version")
            val destination = companion.getString("path")
            require(Regex("(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)").matches(version) && version.length <= 64)
            require(Regex("/tmp/lazysh-android-ssh-[A-Za-z0-9_-]+/data/lazysh/companion/lazysh-agent").matches(destination))
            val originalProcess = android.os.Process.myPid()
            terminalProof(false)
            openReportedActivity()
            val panel = ".workspace-navigation-agents:not([hidden]) > .agent-panel:not([hidden]) > .agent-configuration:not([hidden]) > details.companion-install:not([hidden])[data-install-outcome]"
            awaitDocument(scenario, "owned companion installation visible", present(panel))
            val phases = setOf("detecting", "checkingRelease", "downloading", "uploading", "verifying", "selfTesting", "installing", "checkingInstalled", "cleaningUp", "preflight")
            val failures = setOf("none", "companion_install_busy", "companion_install_unsupported", "companion_release_unavailable", "companion_newer_installed", "companion_installer_invalid", "companion_staging", "companion_install_timeout", "companion_host_network", "companion_host_tool_missing", "companion_verification_failed", "companion_self_test_failed", "companion_rolled_back", "companion_host_busy", "companion_unsafe_location", "disconnected", "app_locked", "ssh_error", "remote_command_failed", "invalid_output", "output_too_large", "timeout")
            val recheckPattern = Regex("lazysh-tag-recheck-v1:(transport:(timeout|connect|redirect|body|decode|request|other)|status:([1-5][0-9]{2}|other)|body|json|ref|type|sha)")
            for (reused in listOf(false, true)) {
                if (evaluate(scenario, "document.querySelector('$panel')?.open===true") != "true")
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$panel summary")).perform(webScrollIntoView()).perform(webClick())
                val action = if (reused) "Update companion" else "Install companion"
                val expected = if (reused) "reused" else "installed"
                println("lazysh companion action: iteration=$expected boundary=beforeAction")
                val button = onWebView().withElement(findElement(Locator.CSS_SELECTOR,
                    "$panel > .tool-bar > button"))
                button.perform(webScrollIntoView())
                println("lazysh companion action: iteration=$expected boundary=afterScroll")
                val companionReadinessObservation = """
                    (()=>{const p=document.querySelector(${JSONObject.quote(panel)});
                      const direct=Array.from(document.querySelectorAll(${JSONObject.quote("$panel > .tool-bar > button")}));
                      const button=direct.length===1?direct[0]:null;
                      const closed=(value,allowed)=>allowed.includes(value)?value:'unavailable';
                      const outcome=p?.getAttribute('data-install-outcome');
                      return {
                        expectedActionVisible:(${workspaceButtonVisible(panel, action)}),
                        matchingExpectedActionEnabled:direct.some(x=>x.textContent===${JSONObject.quote(action)}&&!x.disabled),
                        outcomeExpected:outcome===${JSONObject.quote(if(reused) "installed" else "idle")},
                        panelPresent:!!p,panelVisible:!!p&&(${workspaceElementVisible(panel)}),detailsOpen:p?.open===true,
                        directActionPresent:direct.length>0,
                        directActionVisible:direct.length===1&&(${workspaceElementVisible("$panel > .tool-bar > button", true)}),
                        directActionEnabled:!!button&&!button.disabled,
                        labelKind:button?.textContent==='Install companion'?'install':button?.textContent==='Update companion'?'update':button?.textContent==='Installing…'?'busy':'other',
                        outcome:closed(outcome,['idle','pending','failed','uncertain','installed','reused']),
                        phase:closed(p?.getAttribute('data-install-phase'),${JSONArray(phases)}),
                        failure:closed(p?.getAttribute('data-install-failure'),${JSONArray(failures)}),
                        parentAgentErrorPresent:!!p?.closest('.agent-panel')?.querySelector('.agent-setup [role=alert]')
                      };})()
                """
                awaitDocument(scenario, "owned companion $expected action ready", workspaceButtonVisible(panel, action) +
                    " && Array.from(document.querySelectorAll('$panel > .tool-bar > button')).some(x=>x.textContent===${JSONObject.quote(action)}&&!x.disabled)" +
                    " && document.querySelector('$panel')?.getAttribute('data-install-outcome')===${JSONObject.quote(if(reused) "installed" else "idle")}",
                    observe = { remaining -> evaluate(scenario, companionReadinessObservation, remaining) })
                println("lazysh companion action: iteration=$expected boundary=afterReady")
                button.perform(webClick())
                println("lazysh companion action: iteration=$expected boundary=afterClick")
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(245)
                var phase = "unavailable"; var failure = "unavailable"; var outcome = "unavailable"; var reason = "unavailable"
                var recheck = "none"
                var completedWithinBudget = false
                while (true) {
                    val remaining = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
                    if (remaining <= 0) break
                    val sample = runCatching { JSONObject(evaluate(scenario, """
                        (()=>{const p=document.querySelector('$panel');return {
                          phase:p?.getAttribute('data-install-phase'),failure:p?.getAttribute('data-install-failure'),
                          state:p?.getAttribute('data-install-outcome'),reason:p?.getAttribute('data-install-reason'),
                          recheck:p?.getAttribute('data-install-recheck')};})()
                    """, remaining.coerceAtMost(1_000))) }.getOrNull()
                    if (sample != null) {
                        phase = sample.optString("phase").takeIf { it in phases } ?: "unavailable"
                        failure = sample.optString("failure").takeIf { it in failures } ?: "other"
                        outcome = sample.optString("state").takeIf { it in setOf("idle", "pending", "failed", "uncertain", "installed", "reused") } ?: "unavailable"
                        reason = sample.optString("reason").takeIf { it in setOf("none", "committedDurabilityUnknown", "commitResponseLost", "verificationUnavailable") } ?: "unavailable"
                        recheck = sample.optString("recheck").takeIf { phase == "verifying" && failure == "companion_release_unavailable" && recheckPattern.matches(it) } ?: "none"
                        if (outcome == expected || outcome == "failed" || outcome == "uncertain") {
                            completedWithinBudget = System.nanoTime() < deadline
                            break
                        }
                    }
                    Thread.sleep(200)
                }
                val observation = "Owned companion result phase=$phase kind=$failure outcome=$outcome reason=$reason recheck=$recheck"
                assertTrue(observation, completedWithinBudget)
                assertEquals(observation, expected, outcome)
                val text = if (reused) "Host companion $version is already installed." else "Installed host companion $version."
                val proof = JSONObject(evaluate(scenario, """
                    (()=>{const p=document.querySelector('$panel'), statuses=document.querySelectorAll('$panel [role=status]'), first=document.querySelector('$panel [role=status]');
                      const stage=p?.getAttribute('data-install-cleanup-stage'), reason=p?.getAttribute('data-install-cleanup-reason');return {
                      statusCount:!statuses.length?'zero':statuses.length===1?'one':'many',
                      statusKind:!first?'absent':first.tagName==='P'?'progress':first.tagName==='DIV'?'result':'other',
                      textMatches:first?.textContent.includes(${JSONObject.quote(text)})===true,
                      pathMatches:document.querySelector('$panel code')?.textContent===${JSONObject.quote(destination)},
                      residueAbsent:!p?.textContent.includes('Some temporary installation files remain'),
                      cleanupStage:['none','admission','ownership','closeUpload','directory','verifyFile','removeFile','removeDirectory'].includes(stage)?stage:'unavailable',
                      cleanupReason:['none','disconnected','unowned','missing','identity','hash','request','timeout'].includes(reason)?reason:'unavailable'};})()
                """))
                assertTrue("Owned companion version/path and cleanup must match the public fixture: $observation iteration=$expected proof=$proof",
                    proof.getBoolean("textMatches") && proof.getBoolean("pathMatches") && proof.getBoolean("residueAbsent"))
                assertEquals("Owned companion must keep the packaged native process", originalProcess, android.os.Process.myPid())
            }
            returnToTerminal()
            terminalProof(true)
            println("lazysh packaged companion: actual Install and Update reused results, public version/path, original terminal shell and cleanup completed")
            verifyCompanionHookBoard()
        }
        val enginePreferences = "lazysh.preferences.v1"
        fun setEngine(engine: String) = evaluate(scenario, """(() => {
            const prefs = JSON.parse(localStorage.getItem('$enginePreferences') || '{}');
            localStorage.setItem('$enginePreferences', JSON.stringify({...prefs, terminalEngine: '$engine'}));
            window.dispatchEvent(new StorageEvent('storage', {key: '$enginePreferences'}));
            return true;
        })()""")
        var primaryFailure: Throwable? = null
        android.util.Log.i("LazyshOwnedCase", "start:$nonce:pid:${android.os.Process.myPid()}")
        try {
            if (nativeZellij) setEngine("xterm")
            addOwnedHost(scenario, name, if (useMosh) "10.0.2.2" else "127.0.0.1", fixture.getString("username"), fixture.getInt("port")) {
                if (requireHerdrMosh) {
                    selectOwnedOption("[role=dialog] select:has(option[value='herdr'])", "herdr")
                    typeInto(scenario, "[role=dialog] input[maxlength='200']", fixture.getJSONObject("herdr").getString("name"))
                }
                selectTransport()
            }
            val connect = "button[aria-label='Connect to $name']"
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, connect)).perform(webClick())
            awaitDocument(scenario, "SSH authentication dialog", present("[role=dialog] input[type=password]"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".connection-options > summary"))
                .perform(webScrollIntoView()).perform(webClick())
            if (requireCompanion || requireHerdrMosh) {
                closeSoftKeyboard()
                // The real Add Host chooser saved this preference; do not invoke
                // a redundant second native popup in these saved-preference cases.
                val savedTransport = "[role=dialog] select:has(option[value='ssh'])"
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, savedTransport)).perform(webScrollIntoView())
                assertEquals("Saved transport must reach authentication", "true", evaluate(scenario,
                    workspaceElementVisible(savedTransport, true) + " && (()=>{const choices=document.querySelectorAll(${JSONObject.quote(savedTransport)});return choices.length===1&&!choices[0].disabled&&choices[0].value===${JSONObject.quote(if (useMosh) "mosh" else "ssh")};})()"))
            } else selectTransport()
            clickButton("Private key")
            val keySelector = "[role=dialog] textarea[placeholder='-----BEGIN OPENSSH PRIVATE KEY-----']"
            pasteOwnedText(scenario, keySelector, privateKey, label)
            assertEquals("Remember credentials must remain off", "true", evaluate(scenario,
                "Array.from(document.querySelectorAll('[role=dialog] input[type=checkbox]')).every(x=>!x.checked)"))
            closeSoftKeyboard()
            clickButton("Connect")
            trustOwnedHostKey(scenario, fixture.getString("fingerprint"), (if (useMosh) "10.0.2.2:" else "127.0.0.1:") + fixture.getInt("port"))
            if (requireDeniedNotification) denyFirstNotificationPrompt()
            if (requireMoshBackground) {
                verifyMoshBackground(scenario, fixture, name, label)
            } else if (!requireHerdrMosh && !requireAttachments) {
                awaitDocument(scenario, "authenticated owned SSH prompt", screenContains(fixture.getString("prompt")))
            }
            if (requireDeniedNotification) {
                openNotificationSettingsAfterDenial(scenario)
                awaitDocument(scenario, "returned to the connected workspace", screenContains(fixture.getString("prompt")))
            }
            if (requireRecorded) verifyRecordedConversations() else if (requireCompanion) verifyCompanionInstallation() else if (requireHerdrMosh) {
                awaitDocument(scenario, "saved default Herdr entered through Mosh", """
                    document.querySelectorAll('[role=tab]').length===1 &&
                    document.querySelector('[role=tab]')?.textContent.includes(${JSONObject.quote(connectedName)}) &&
                    document.querySelector('.workspace-footer')?.textContent.includes('Mosh') &&
                    Boolean(document.querySelector('.terminal-canvas .xterm-screen'))
                """)
                verifyMoshResize(scenario, connectedName, nonce)
                verifyBoardKeepAwake(scenario, fixture.getJSONObject("herdr"))
                verifyGuardedHerdrChat(scenario, fixture.getJSONObject("herdr"), name, label, true)
                assertEquals("Private Mosh startup bytes must stay out of terminal output", "true", evaluate(scenario,
                    "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).every(x=>!/(MOSH CONNECT |LAZYSH_ATTACH_|LAZYSH-GUARD-1:)/.test(x.textContent))"))
                println("lazysh Mosh default Herdr: one saved-name display and original guarded input verified")
            } else if (requireTmux) {
                val key = "lazysh.preferences.v1"
                val previous = if (nativeTmux) evaluate(scenario, "localStorage.getItem('$key')") else null
                try {
                    if (nativeTmux) evaluate(scenario, """(() => {
                        const prefs = JSON.parse(localStorage.getItem('$key') || '{}');
                        localStorage.setItem('$key', JSON.stringify({...prefs, terminalEngine: 'native'}));
                        window.dispatchEvent(new StorageEvent('storage', {key: '$key'}));
                        return true;
                    })()""")
                    val tmux = fixture.getJSONObject("tmux")
                    require(requireTmuxAgent == tmux.has("agent")) { "Owned tmux agent fixture mode mismatch" }
                    if (requireTmuxAgent) verifyOwnedTmuxAgentView(scenario, tmux, name, label) else {
                        verifyOwnedTmux(scenario, tmux, name, label, nativeTmux)
                        if (!nativeTmux) verifyOwnedTmuxDefault(scenario, fixture, name, label)
                    }
                } finally {
                    if (nativeTmux) evaluate(scenario, PageDriver.restoreStorageScript(key, previous))
                }
            } else if (requireZellij) {
                try {
                    if (nativeZellij) setEngine("native")
                    verifyOwnedZellij(scenario, fixture.getJSONObject("zellij"), name, nativeZellij)
                } finally {
                    if (nativeZellij) {
                        setEngine("xterm")
                        closeSoftKeyboard()
                    }
                }
            } else if (requireDpad) {
                verifySshDpadPan(scenario, fixture, label)
            } else if (requireIme) {
                verifySshImeTransactions(scenario, fixture, label)
            } else if (requireAttachments) {
                verifyManualAttachmentUpload(scenario, fixture, label)
            } else if (!requireMoshBackground) {
                clickButton("Compose")
                typeInto(scenario, ".terminal-compose textarea", fixture.getString("challenge"))
                val keyboardDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
                var keyboardGeometry = JSONObject()
                while (true) {
                    var fitsAboveKeyboard = false
                    scenario.onActivity { activity ->
                        val decor = activity.window.decorView
                        val insets = requireNotNull(ViewCompat.getRootWindowInsets(decor))
                        val keyboardHeight = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                        val web = requireNotNull(webView(decor))
                        val position = IntArray(2)
                        web.getLocationInWindow(position)
                        val imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime())
                        fitsAboveKeyboard = imeVisible && keyboardHeight > 0 &&
                            position[1] + web.height <= decor.height - keyboardHeight
                        // Closed, bounded geometry only: never DOM content, paths,
                        // input values, view descriptions or exception messages.
                        keyboardGeometry = JSONObject().put("rootImeVisible", imeVisible)
                            .put("rootImeBottom", keyboardHeight.coerceIn(0, 65535))
                            .put("decorHeight", decor.height.coerceIn(0, 65535))
                            .put("webWindowY", position[1].coerceIn(-65535, 65535))
                            .put("webHeight", web.height.coerceIn(0, 65535))
                            .put("keyboard", when (activity.resources.configuration.keyboard) {
                                Configuration.KEYBOARD_NOKEYS -> "none"
                                Configuration.KEYBOARD_QWERTY -> "qwerty"
                                Configuration.KEYBOARD_12KEY -> "12key"
                                Configuration.KEYBOARD_UNDEFINED -> "undefined"
                                else -> "other"
                            })
                            .put("hardKeyboardHidden", when (activity.resources.configuration.hardKeyboardHidden) {
                                Configuration.HARDKEYBOARDHIDDEN_YES -> "hidden"
                                Configuration.HARDKEYBOARDHIDDEN_NO -> "visible"
                                Configuration.HARDKEYBOARDHIDDEN_UNDEFINED -> "undefined"
                                else -> "other"
                            })
                        runCatching {
                            val content = activity.findViewById<View>(android.R.id.content)
                            keyboardGeometry.put("contentHeight", content.height.coerceIn(0, 65535))
                                .put("contentPaddingBottom", content.paddingBottom.coerceIn(0, 65535))
                            web.getLocationOnScreen(position)
                            keyboardGeometry.put("webScreenY", position[1].coerceIn(-65535, 65535))
                            if (Build.VERSION.SDK_INT >= 30) {
                                val metrics = activity.windowManager.currentWindowMetrics
                                keyboardGeometry.put("metricsTop", metrics.bounds.top.coerceIn(-65535, 65535))
                                    .put("metricsBottom", metrics.bounds.bottom.coerceIn(-65535, 65535))
                                    .put("metricsImeBottom", metrics.windowInsets.getInsets(android.view.WindowInsets.Type.ime()).bottom.coerceIn(0, 65535))
                                    .put("metricsImeVisible", metrics.windowInsets.isVisible(android.view.WindowInsets.Type.ime()))
                            }
                        }.onFailure { keyboardGeometry.put("supplementalUnavailable", true) }
                    }
                    if (fitsAboveKeyboard) break
                    assertTrue("Real docked IME must resize the native WebView; geometry=$keyboardGeometry", System.nanoTime() < keyboardDeadline)
                    Thread.sleep(50)
                }
                val viewportOracle = InstrumentationRegistry.getInstrumentation().context.assets
                    .open("owned-keyboard-viewport.js").use { it.readNBytes(2049) }
                    .also { require(it.size <= 2048) { "Keyboard viewport oracle bound" } }.toString(Charsets.UTF_8)
                val canvasHeight = "document.querySelector('.terminal-canvas').getBoundingClientRect().height"
                awaitDocument(scenario, "composer sheet editor and actions inside the keyboard-resized WebView", """
                    (()=>{
                      const sheet=document.querySelector('.terminal-composer-sheet'), editor=sheet?.querySelector('textarea');
                      const send=sheet?.querySelector("button[aria-label='Send']"), close=sheet?.querySelector("button[aria-label='Close composer']");
                      if(!sheet || !editor || !send || !close || editor.getBoundingClientRect().height<=0) return false;
                      $viewportOracle
                      return ownedKeyboardViewportContains(window.visualViewport,
                        [sheet,editor,send,close].map(x=>x.getBoundingClientRect()));
                    })()
                """, observe = { remaining ->
                    val native = JSONObject()
                    scenario.onActivity { activity ->
                        val decor = activity.window.decorView
                        val web = requireNotNull(webView(decor))
                        native.put("webHeight", web.height.coerceIn(0, 65535))
                            .put("webWidth", web.width.coerceIn(0, 65535))
                            .put("density", activity.resources.displayMetrics.density.toDouble().coerceIn(0.0, 100.0))
                            .put("imeBottom", ViewCompat.getRootWindowInsets(decor)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom?.coerceIn(0, 65535) ?: JSONObject.NULL)
                    }
                    val dom = JSONObject(evaluate(scenario, """
                        (()=>{
                          const n=x=>Number.isFinite(x)&&Math.abs(x)<=65535?x:null;
                          const rect=e=>e?['left','top','right','bottom','width','height'].map(k=>n(e.getBoundingClientRect()[k])):null;
                          const canvas=document.querySelector('.terminal-canvas'),keys=document.querySelector('.terminal-keys');
                          const composer=document.querySelector('.terminal-compose'),toggle=document.querySelector('.terminal-toolbar-toggle');
                          const buttons=keys?Array.from(keys.querySelectorAll('button')):[];
                          return {viewport:[n(innerWidth),n(innerHeight),n(document.documentElement.clientHeight),n(devicePixelRatio)],
                            visualViewport:[n(window.visualViewport?.width),n(window.visualViewport?.height),
                              n(window.visualViewport?.offsetLeft),n(window.visualViewport?.offsetTop),n(window.visualViewport?.scale)],
                            canvas:rect(canvas),screenHeight:n(canvas?.querySelector('.xterm-screen')?.getBoundingClientRect().height),
                            keys:rect(keys),esc:rect(buttons.find(x=>x.textContent==='esc')),tab:rect(buttons.find(x=>x.textContent==='tab')),
                            composer:rect(composer),toggle:rect(toggle),header:rect(document.querySelector('.workspace-header')),
                            sessions:rect(document.querySelector('.session-tabs')),navigation:rect(document.querySelector('.view-tabs')),
                            footer:rect(document.querySelector('.workspace-footer')),
                            canvasCount:n(document.querySelectorAll('.terminal-canvas').length),
                            rowFloor:n(parseFloat(canvas?.style.minHeight)),
                            composerFlexible:Boolean(composer&&getComputedStyle(composer).flexGrow==='1'&&getComputedStyle(composer).overflowY==='auto'),
                            toggleFixed:Boolean(toggle&&getComputedStyle(toggle).flexShrink==='0')};
                        })()
                    """, remaining))
                    JSONObject().put("native", native).put("dom", dom).toString().also {
                        require(it.length <= 4096) { "Keyboard geometry observation bound" }
                    }
                })
                val withKeyboard = evaluate(scenario, canvasHeight).toDouble()
                closeSoftKeyboard()
                awaitDocument(scenario, "terminal expands after native keyboard dismissal", "$canvasHeight > $withKeyboard")
                clickButton("Send")
                val terminalFocused = "document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea')"
                awaitDocument(scenario, "Send closes the composer and leaves the terminal input focused",
                    "!" + present(".terminal-compose textarea") + " && " + terminalFocused)
                // Refocusing xterm can reopen the docked IME and reduce the visible screen to one row.
                // Dismiss it ordinarily so the unchanged output-plus-later-prompt oracle can see both rows.
                closeSoftKeyboard()
                assertEquals("Keyboard dismissal must preserve terminal input focus", "true", evaluate(scenario, terminalFocused))
                // Send submitted the draft with its own Enter; no native key press was needed.
                awaitDocument(scenario, "remote expanded SSH challenge and returned prompt",
                    screenContains(fixture.getString("expected")) + " && Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.lastIndexOf(${JSONObject.quote(fixture.getString("prompt"))})>x.textContent.indexOf(${JSONObject.quote(fixture.getString("expected"))}))")
                val prompt = JSONObject.quote(fixture.getString("prompt"))
                val literalClipboard = " # CLIP_${nonce}_\$literal"
                val literal = JSONObject.quote(literalClipboard)
                instrumentation.runOnMainSync { clipboard.setPrimaryClip(ClipData.newPlainText(label, literalClipboard)) }
                val clipSetAt = System.nanoTime()
                clickButton("paste")
                awaitDocument(scenario, "native clipboard client settled and focused", """
                    (()=>{const paste=document.querySelectorAll('.terminal-keys button[aria-busy]');
                      return paste.length===1 && paste[0].getAttribute('aria-busy')==='false' && !paste[0].disabled && $terminalFocused;})()
                """)
                assertEquals("Clipboard paste must preserve terminal input focus", "true", evaluate(scenario, terminalFocused))
                // Native clipboard completion refocuses xterm asynchronously; dismiss
                // after that acknowledgement so Enter/output use the expanded viewport.
                closeSoftKeyboard()
                assertEquals("Keyboard dismissal must preserve clipboard paste input focus", "true", evaluate(scenario, terminalFocused))
                awaitDocument(scenario, "native clipboard text pasted literally without Enter",
                    "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>{const i=x.textContent.lastIndexOf($literal);return i>=0&&x.textContent.lastIndexOf($prompt)<i;})")
                // Normal native Enter submits the real shell input; the comment line returns a prompt.
                onView(isAssignableFrom(WebView::class.java)).perform(pressKey(KeyEvent.KEYCODE_ENTER))
                awaitDocument(scenario, "native Enter submits the literal clipboard line",
                    "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.lastIndexOf($prompt)>x.textContent.lastIndexOf($literal))")
                awaitClipboardPreviewGone(clipSetAt)
                verifyToolbarPages(scenario, fixture.getString("prompt"), nonce)
                if (!requireHerdr) verifyOwnedClipboardImages(scenario, label)
                if (!requireHerdr) verifyNavigationToolbarKeys(scenario)
                if (!requireSharedHerdr) verifyBoardKeepAwake(scenario, if (requireHerdr) fixture.getJSONObject("herdr") else null)
                if (requireSharedHerdr) verifySharedHerdrNavigation(scenario, fixture.getJSONObject("herdr"), name, label)
                else if (requireHerdr) verifyGuardedHerdrChat(scenario, fixture.getJSONObject("herdr"), name, label)
            }
            endOwnedConnection(scenario, connectedName, requireHerdrMosh)
            awaitDocument(scenario, "owned SSH disconnected", "!" + present(".terminal-canvas"))
            deleteOwnedHost(scenario, name)
        } catch (failure: Throwable) {
            primaryFailure = failure
            throw failure
        } finally {
            android.util.Log.i("LazyshOwnedCase", "end:$nonce:pid:${android.os.Process.myPid()}")
            var cleanupFailure: Throwable? = null
            fun retainCleanup(failure: Throwable, message: String) {
                val first = primaryFailure ?: cleanupFailure
                if (first != null) first.addSuppressed(AssertionError(message, failure))
                else cleanupFailure = failure
            }
            var cleanupStage = SshUiCleanupStage.DISMISS
            fun cleanupUi(action: () -> Unit) {
                try { action() }
                catch (cleanup: Throwable) {
                    retainCleanup(cleanup, "Owned SSH UI cleanup failed: ${cleanupStage.name}:${cleanup.javaClass.simpleName}")
                }
            }
            cleanupUi {
                dismissOwnedAuthentication(scenario)
                val menu = "[role=dialog][aria-label='Workspace tools']"
                if (evaluate(scenario, workspaceElementVisible(menu)) == "true")
                    onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$menu button[aria-label='Close Workspace tools']")).perform(webClick())
            }
            val ownedNames = if (requireHerdr) listOf("$name / ${fixture.getJSONObject("herdr").getString("name")}", name)
                else if (requireTmux) listOf("$name / ${fixture.getJSONObject("tmux").getString("name")}", name)
                else if (requireZellij) listOf("$name / ${fixture.getJSONObject("zellij").getString("name")}", name) else listOf(name)
            for (ownedName in ownedNames) {
                cleanupUi {
                    cleanupStage = SshUiCleanupStage.SESSION_SELECT
                    val disconnect = "button[aria-label='Disconnect $ownedName']"
                    if (evaluate(scenario, present(disconnect)) == "true") endOwnedConnection(scenario, ownedName)
                }
            }
            cleanupStage = SshUiCleanupStage.HOST_DELETE
            cleanupUi {
                if (evaluate(scenario, present("button[aria-label='Connect to $name']")) == "true") deleteOwnedHost(scenario, name)
            }
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

    // Owned SSH parity (#985). tests/support/androidSshParity.ts starts each sshd on the host,
    // reverses its ports and answers this case's bounded control requests; the host never
    // drives the UI. All five cases run in one Gradle invocation with distinct host names.
    private class OwnedParity(val fixture: JSONObject) {
        val nonce: String = fixture.getString("nonce").also { require(Regex("[a-f0-9]{32}").matches(it)) { "Invalid owned parity nonce" } }
        val label = "lazysh-ui-ssh-$nonce"
        val username: String = fixture.getString("username")
        fun port(server: String) = fixture.getJSONObject(server).getInt("port").also { require(it in 1..65535) }
        fun fingerprint(server: String): String = fixture.getJSONObject(server).getString("fingerprint")
        fun prompt(server: String): String = fixture.getJSONObject(server).getString("prompt")
        /** One request and one closed JSON reply over the reversed loopback control port. */
        fun control(action: String, vararg fields: Pair<String, Any>): JSONObject {
            val request = JSONObject().put("nonce", nonce).put("action", action)
            for ((key, value) in fields) request.put(key, value)
            java.net.Socket().use { socket ->
                socket.connect(java.net.InetSocketAddress("127.0.0.1", fixture.getInt("controlPort")), 5_000)
                socket.soTimeout = 30_000
                socket.getOutputStream().apply { write((request.toString() + "\n").toByteArray(Charsets.UTF_8)); flush() }
                val line = socket.getInputStream().bufferedReader(Charsets.UTF_8).readLine()
                assertTrue("Owned parity control $action closed without a reply", line != null && line.length <= 8192)
                val reply = JSONObject(line!!)
                assertTrue("Owned parity control refused $action: ${reply.optString("error")}", reply.optBoolean("ok"))
                return reply
            }
        }
        /** Polls the host's closed `observe` facts until `accept` holds; the host fails the call itself if an original process is gone. */
        fun awaitFact(stage: String, seconds: Long, accept: (JSONObject) -> Boolean): JSONObject {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds)
            while (true) {
                val facts = control("observe")
                if (accept(facts)) return facts
                assertTrue("Owned host fact not reached at $stage: $facts", System.nanoTime() < deadline)
                Thread.sleep(250)
            }
        }
        fun mark(vararg servers: String) { for (server in servers) control("mark", "server" to server) }
        fun observe(server: String) = control("observe", "server" to server)
    }

    private val parityPassword = "[role=dialog] form.form-stack > label > input[type=password]"
    private val parityKey = "[role=dialog] form.form-stack > label > textarea"

    /** The owned tmux fixture's first window marker, checked against the shape the host writes. */
    private fun ownedTmuxAlpha(parity: OwnedParity): String {
        val tmux = parity.fixture.getJSONObject("tmux")
        require(tmux.getString("name") == "owned-tmux") { "Owned tmux fixture required" }
        return tmux.getJSONArray("windows").getJSONObject(0).getString("marker")
            .also { require(Regex("TMUX_ALPHA_[a-f0-9]{32}").matches(it)) { "Owned tmux alpha marker required" } }
    }

    /** The owned stock Herdr fixture's first display marker: its source receiver prints it after clearing the screen. */
    private fun ownedHerdrSource(parity: OwnedParity): String {
        val herdr = parity.fixture.getJSONObject("herdr")
        require(herdr.getString("name") == "owned-guard") { "Owned Herdr fixture required" }
        return herdr.getJSONObject("navigation").getJSONObject("source").getString("marker")
            .also { require(Regex("NAV_SOURCE_[a-f0-9]{32}").matches(it)) { "Owned Herdr source marker required" } }
    }

    /**
     * Adds a host whose default multiplexer is the owned `session` of `multiplexer`, connects with the fixture key over SSH, saves
     * the credentials and trusts the host key. Saved credentials are what lets the app reconnect or restore on its own.
     */
    private fun connectOwnedSaved(scenario: ActivityScenario<MainActivity>, parity: OwnedParity, name: String, multiplexer: String = "tmux", session: String = "owned-tmux") {
        val port = parity.port("primary")
        addOwnedHost(scenario, name, "127.0.0.1", parity.username, port) {
            // The default transport is Auto, which would try Mosh first; these cases are about the SSH route.
            selectNativeOption(scenario, parity.nonce, "[role=dialog] select:has(option[value='ssh'])", "ssh")
            selectNativeOption(scenario, parity.nonce, "[role=dialog] select:has(option[value='herdr'])", multiplexer)
            typeInto(scenario, "[role=dialog] input[maxlength='200']", session)
        }
        openOwnedConnect(scenario, name)
        chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
        onWebView().withElement(findElement(Locator.XPATH,
            "//*[@role='dialog']//label[contains(normalize-space(.),'Save credentials on this device')]/input[@type='checkbox']"))
            .perform(webScrollIntoView()).perform(webClick())
        submitOwnedConnect(scenario)
        trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:$port")
    }

    /**
     * Runs one parity case, then dismisses its dialogs, ends its `sessions` and deletes its hosts. `keepOnSuccess` leaves a
     * passing case's host and open session in place, for a case whose second half runs in a fresh process.
     */
    private fun ownedParityCase(hosts: List<String>, sessions: List<String> = hosts, keepOnSuccess: Boolean = false,
        body: (ActivityScenario<MainActivity>, OwnedParity) -> Unit) {
        val parity = OwnedParity(ownedSshFixture())
        grantOwnedNotifications()
        val scenario = NativeActivityFixture.scenario
        var primary: Throwable? = null
        android.util.Log.i("LazyshOwnedCase", "start:${parity.nonce}:pid:${android.os.Process.myPid()}")
        try { body(scenario, parity) }
        catch (failure: Throwable) { primary = failure; throw failure }
        finally {
            android.util.Log.i("LazyshOwnedCase", "end:${parity.nonce}:pid:${android.os.Process.myPid()}")
            val cleanup = if (keepOnSuccess && primary == null) null else runCatching {
                dismissOwnedAuthentication(scenario)
                for (name in sessions) if (evaluate(scenario, present("button[aria-label='Disconnect $name']")) == "true") endOwnedConnection(scenario, name)
                for (name in hosts) if (evaluate(scenario, present("button[aria-label='Connect to $name']")) == "true") deleteOwnedHost(scenario, name)
            }.exceptionOrNull()
            if (cleanup != null) { if (primary != null) primary.addSuppressed(cleanup) else throw cleanup }
        }
    }

    private fun openOwnedConnect(scenario: ActivityScenario<MainActivity>, name: String) {
        revealOwnedHosts(scenario)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Connect to $name']")).perform(webScrollIntoView()).perform(webClick())
        awaitDocument(scenario, "owned connection dialog for $name", present("[role=dialog] form .destination"))
    }

    /** Submits the connection form; a new attempt clears the previous refusal before anything else waits. */
    private fun submitOwnedConnect(scenario: ActivityScenario<MainActivity>) {
        closeSoftKeyboard()
        // Mark the shown refusal: a fast new refusal is a new node and must not count as the previous one.
        evaluate(scenario, "(()=>{document.querySelector('[role=dialog] [role=alert]')?.setAttribute('data-owned-previous','');return true;})()")
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "[role=dialog] form.form-stack button[type=submit]")).perform(webClick())
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (evaluate(scenario, present("[role=dialog] [role=alert][data-owned-previous]")) == "true") {
            assertTrue("Owned connection attempt did not clear its previous refusal", System.nanoTime() < deadline)
            Thread.sleep(50)
        }
    }

    private fun chooseOwnedPrivateKey(scenario: ActivityScenario<MainActivity>, privateKey: String, label: String) {
        clickOwnedButton("Private key")
        pasteOwnedText(scenario, parityKey, privateKey, label)
    }

    /**
     * A saved host starts on Auto, which tries Mosh first. An owned sshd that runs commands would start a real
     * mosh-server for that attempt, and a Mosh startup that ends early surfaces as a refusal instead of the SSH
     * fallback (CI: "Mosh connection ended before startup completed"). Cases that prove SSH features pick SSH in the
     * Add Host dialog, as the other owned cases do: the saved preference reaches the connect dialog, where the
     * transport select sits in the collapsed Connection options and so is not hit-testable.
     */
    private fun chooseOwnedSshTransport(scenario: ActivityScenario<MainActivity>, parity: OwnedParity) =
        selectNativeOption(scenario, parity.nonce, "[role=dialog] select:has(option[value='ssh'])", "ssh")

    /** Waits for this refusal in the open dialog with no terminal; unlike awaitDocument, an alert is the goal. */
    private fun awaitOwnedRefusal(scenario: ActivityScenario<MainActivity>, stage: String, text: String) {
        val expected = """(()=>{const alert=document.querySelector('[role=dialog] [role=alert]');
            return Boolean(alert?.textContent.includes(${JSONObject.quote(text)})) && !document.querySelector('.terminal-canvas .xterm-screen') &&
              !document.querySelector('[role=dialog] .fingerprint code');})()"""
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(45)
        while (evaluate(scenario, expected) != "true") {
            assertTrue("Owned refusal not shown at $stage: ${evaluate(scenario,
                "document.querySelector('[role=dialog] [role=alert]')?.textContent?.slice(0,200) || ''")}", System.nanoTime() < deadline)
            Thread.sleep(200)
        }
    }

    /** Waits for the server's own prompt, then proves a fresh command ran in that shell. */
    private fun proveOwnedShell(scenario: ActivityScenario<MainActivity>, parity: OwnedParity, prompt: String, tag: String) {
        awaitDocument(scenario, "authenticated owned $tag prompt", terminalScreenContains(prompt))
        val command = "printf 'PARITY_%s_%s\\n' '$tag' '${parity.nonce}'"
        val proof = "PARITY_${tag}_${parity.nonce}"
        require(!command.contains(proof)) { "Owned shell proof must not appear in its input" }
        sendOwnedCommand(scenario, command, parity.label)
        awaitDocument(scenario, "owned $tag shell proof", terminalScreenContains(proof))
    }

    private fun parityCount(facts: JSONObject, key: String) = facts.getInt(key)
    private fun parityList(facts: JSONObject, key: String) = facts.getJSONArray(key).let { list -> (0 until list.length()).map { list.get(it).toString() } }

    @Test fun ownedSshPasswordLoginThroughRealUi() {
        val name = "Parity password"
        ownedParityCase(listOf(name)) { scenario, parity ->
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, parity.port("primary"))
            parity.mark("primary")
            openOwnedConnect(scenario, name)
            val wrong = parity.fixture.getString("password").reversed()
            typeInto(scenario, parityPassword, wrong)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:${parity.port("primary")}")
            awaitOwnedRefusal(scenario, "wrong password", "Authentication rejected by the server")
            var facts = parity.observe("primary")
            assertEquals("A wrong password must reach sshd once and be rejected: $facts", 1, parityCount(facts, "failedPassword"))
            assertEquals("No password may be accepted yet: $facts", 0, parityCount(facts, "acceptedPassword"))
            replaceNativeText(scenario, parityPassword, parity.fixture.getString("password"))
            submitOwnedConnect(scenario)
            proveOwnedShell(scenario, parity, parity.prompt("primary"), "PASSWORD")
            facts = parity.observe("primary")
            assertEquals("The real password must be accepted exactly once: $facts", 1, parityCount(facts, "acceptedPassword"))
            assertEquals("Password login must not offer a key: $facts", emptyList<String>(), parityList(facts, "acceptedPublickey"))
            println("lazysh parity: password login rejected the wrong password and accepted the real one against owned OpenSSH")
        }
    }

    @Test fun ownedSshEncryptedKeyLoginThroughRealUi() {
        val name = "Parity encrypted key"
        ownedParityCase(listOf(name)) { scenario, parity ->
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, parity.port("primary"))
            parity.mark("primary")
            openOwnedConnect(scenario, name)
            chooseOwnedPrivateKey(scenario, parity.fixture.getString("encryptedKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:${parity.port("primary")}")
            awaitOwnedRefusal(scenario, "missing passphrase", "This private key is encrypted. Enter its passphrase.")
            typeInto(scenario, parityPassword, parity.fixture.getString("passphrase").reversed())
            submitOwnedConnect(scenario)
            awaitOwnedRefusal(scenario, "wrong passphrase", "Cannot unlock this private key. Check its format and passphrase.")
            var facts = parity.observe("primary")
            assertEquals("An undecryptable key must never start authentication: $facts", 0, parityCount(facts, "userauthRequests"))
            replaceNativeText(scenario, parityPassword, parity.fixture.getString("passphrase"))
            submitOwnedConnect(scenario)
            proveOwnedShell(scenario, parity, parity.prompt("primary"), "ENCRYPTED")
            facts = parity.observe("primary")
            assertEquals("The decrypted identity must be the authorized key: $facts", listOf(parity.fixture.getString("userFingerprint")),
                parityList(facts, "acceptedPublickey"))
            println("lazysh parity: encrypted key refused without and with a wrong passphrase, then logged in with the real one")
        }
    }

    @Test fun ownedSshRotatedHostKeyRefusedThroughRealUi() {
        val name = "Parity pinned host"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val port = parity.fixture.getJSONObject("rotation").getInt("port")
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, port)
            openOwnedConnect(scenario, name)
            chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:$port")
            proveOwnedShell(scenario, parity, parity.prompt("primary"), "PINNED")
            endOwnedConnection(scenario, name)
            // The host repoints this device port at a second sshd with another host key.
            parity.control("rotate")
            openOwnedConnect(scenario, name)
            chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            awaitOwnedRefusal(scenario, "rotated host key", "The host key changed. Connection blocked.")
            val facts = parity.observe("rotated")
            assertTrue("The rotated server must have been reached: $facts", parityCount(facts, "connections") >= 1)
            assertEquals("No credential may be offered to a changed host key: $facts", 0, parityCount(facts, "userauthRequests"))
            println("lazysh parity: a rotated host key was refused with no trust shortcut and no authentication request")
        }
    }

    @Test fun ownedSshBastionRouteThroughRealUi() {
        val bastion = "Parity bastion"
        val target = "Parity routed target"
        ownedParityCase(listOf(target, bastion)) { scenario, parity ->
            addOwnedHost(scenario, bastion, "127.0.0.1", parity.username, parity.port("bastion"))
            addOwnedHost(scenario, target, "127.0.0.1", parity.username, parity.port("primary")) {
                val id = JSONObject.quote(bastion + " (")
                val value = evaluate(scenario, "Array.from(document.querySelectorAll('[role=dialog] option')).filter(x=>x.label.startsWith($id)).map(x=>x.value)")
                val ids = JSONArray(value)
                require(ids.length() == 1) { "Owned bastion option must be unique" }
                selectNativeOption(scenario, parity.nonce, "[role=dialog] select:has(option[value='${ids.getString(0)}'])", ids.getString(0))
            }
            parity.mark("primary", "bastion")
            openOwnedConnect(scenario, target)
            assertEquals("A bastion route must offer only SSH", "true", evaluate(scenario, """
                (()=>{const options=document.querySelectorAll('[role=dialog] .connection-options select option');
                  const value=x=>Array.from(options).find(o=>o.value===x);
                  return value('mosh')?.disabled===true && value('et')?.disabled===true && value('ssh')?.disabled===false &&
                    Array.from(document.querySelectorAll('[role=dialog] fieldset legend')).some(x=>x.textContent.includes(${JSONObject.quote(bastion)}));})()
            """))
            // The bastion's saved credentials are the default; this route proves its own typed password instead.
            onWebView().withElement(findElement(Locator.XPATH,
                "//*[@role='dialog']//fieldset[legend[contains(.,'$bastion')]]//label[contains(normalize-space(.),'saved credentials')]/input[@type='checkbox']"))
                .perform(webScrollIntoView()).perform(webClick())
            typeInto(scenario, "[role=dialog] fieldset input[type=password]", parity.fixture.getString("password"))
            chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("bastion"), "127.0.0.1:${parity.port("bastion")}")
            trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:${parity.port("primary")}")
            proveOwnedShell(scenario, parity, parity.prompt("primary"), "ROUTED")
            // Each attempt after the bastion's trust signs in to it again; the target's own trust adds one.
            val jump = parity.observe("bastion")
            assertTrue("The bastion must accept its own password: $jump", parityCount(jump, "acceptedPassword") >= 1)
            assertEquals("The bastion must not receive the target key: $jump", emptyList<String>(), parityList(jump, "acceptedPublickey"))
            val forwarded = parityList(jump, "directTcpipTargets")
            assertTrue("The bastion must forward only to the target: $jump", forwarded.isNotEmpty() && forwarded.all { it == parity.port("primary").toString() })
            val routed = parity.observe("primary")
            assertEquals("The target must accept only its own key: $routed", listOf(parity.fixture.getString("userFingerprint")), parityList(routed, "acceptedPublickey"))
            assertEquals("The target must not receive the bastion password: $routed", 0, parityCount(routed, "acceptedPassword") + parityCount(routed, "failedPassword"))
            println("lazysh parity: one-hop bastion route reached the target shell with separate credentials and SSH only")
        }
    }

    @Test fun ownedSshAgentForwardingThroughRealUi() {
        val plain = "Parity plain agent"
        val forwarding = "Parity forwarded agent"
        ownedParityCase(listOf(plain, forwarding)) { scenario, parity ->
            addOwnedHost(scenario, plain, "127.0.0.1", parity.username, parity.port("primary"))
            addOwnedHost(scenario, forwarding, "127.0.0.1", parity.username, parity.port("primary")) {
                val checkbox = onWebView().withElement(findElement(Locator.XPATH,
                    "//*[@role='dialog']//label[contains(normalize-space(.),'Forward this connection')]/input[@type='checkbox']"))
                checkbox.perform(webScrollIntoView()).perform(webClick())
                assertEquals("Agent forwarding must be opted in for this host only", "true", evaluate(scenario,
                    "Array.from(document.querySelectorAll('[role=dialog] label')).find(x=>x.textContent.includes('Forward this connection'))?.querySelector('input')?.checked===true"))
            }
            val selected = parity.fixture.getString("userFingerprint")
            val dollar = "$"
            fun probe(tag: String) = "printf 'AGENT_%s_%s_%s_%s\\n' \"${dollar}{SSH_AUTH_SOCK:+set}\" \"${dollar}(ssh-add -l 2>/dev/null | grep -c SHA256:)\" " +
                "\"${dollar}(ssh-add -l 2>/dev/null | grep -cF '$selected')\" '$tag${parity.nonce}'"
            for ((name, expected) in listOf(plain to "AGENT__0_0_", forwarding to "AGENT_set_1_1_")) {
                openOwnedConnect(scenario, name)
                if (name == forwarding) {
                    // The plain host's trust already pinned this address and port, so no fingerprint review appears.
                    parity.mark("primary")
                    typeInto(scenario, parityPassword, parity.fixture.getString("password"))
                    submitOwnedConnect(scenario)
                    awaitOwnedRefusal(scenario, "forwarding without a key", "Agent forwarding requires the private key selected for this connection")
                    val facts = parity.observe("primary")
                    assertEquals("Forwarding without a key must be refused before authentication: $facts", 0, parityCount(facts, "userauthRequests"))
                }
                chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
                submitOwnedConnect(scenario)
                if (name == plain) trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:${parity.port("primary")}")
                awaitDocument(scenario, "authenticated $name prompt", terminalScreenContains(parity.prompt("primary")))
                val tag = if (name == plain) "P" else "F"
                val command = probe(tag)
                require(!command.contains(expected + tag)) { "Owned agent proof must not appear in its input" }
                sendOwnedCommand(scenario, command, parity.label)
                awaitDocument(scenario, "$name agent identities", terminalScreenContains(expected + tag + parity.nonce))
                endOwnedConnection(scenario, name)
            }
            println("lazysh parity: only the opted-in host saw a forwarded agent, listing exactly the selected identity")
        }
    }

    /** One raw HTTP/1.0 GET to this device's loopback, or null when the connection is refused (cleartext policy does not apply to a socket). */
    private fun deviceLoopbackGet(port: Int): String? = try {
        java.net.Socket().use { socket ->
            socket.connect(java.net.InetSocketAddress("127.0.0.1", port), 3_000)
            socket.soTimeout = 10_000
            socket.getOutputStream().apply { write("GET / HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n".toByteArray(Charsets.US_ASCII)); flush() }
            socket.getInputStream().bufferedReader(Charsets.UTF_8).readText()
        }
    } catch (_: java.net.ConnectException) { null }

    private fun awaitLoopbackRefused(port: Int, stage: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (deviceLoopbackGet(port) != null) {
            assertTrue("Device loopback port still forwards after $stage", System.nanoTime() < deadline)
            Thread.sleep(200)
        }
    }

    @Test fun ownedSshPreviewForwardsAndTearsDownThroughRealUi() {
        val name = "Parity preview"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val preview = parity.fixture.getJSONObject("preview")
            val remote = preview.getInt("listener")
            val proof = preview.getString("proof")
            val panel = ".preview-panel"
            fun clickPreviewButton(label: String) = onWebView().withElement(findElement(Locator.XPATH,
                "//section[contains(@class,'preview-panel')]//button[@aria-label='$label' or (not(@aria-label) and normalize-space(text())='$label')]"))
                .perform(webScrollIntoView()).perform(webClick())
            /** Opens the discovered listener and returns the device loopback port its forward serves. */
            // Discover and Open are disabled while the panel is busy, and a click on a disabled button does nothing.
            fun awaitIdle(stage: String) = awaitDocument(scenario, "$stage: preview panel idle", "!document.querySelector('$panel [role=status]')")
            fun openDiscovered(stage: String): Int {
                awaitIdle(stage)
                clickPreviewButton("Discover listeners")
                awaitDocument(scenario, "$stage: exactly the allowed listener discovered", """
                    (()=>{const rows=Array.from(document.querySelectorAll('$panel .preview-listeners button'));
                      return rows.length===1 && rows[0].textContent.includes('127.0.0.1:$remote') && !document.querySelector('$panel [role=status]');})()
                """)
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$panel .preview-listeners button")).perform(webScrollIntoView()).perform(webClick())
                clickPreviewButton("Open preview")
                val address = "document.querySelector('$panel .tool-bar code')?.textContent"
                awaitDocument(scenario, "$stage: forward address shown", "/^http:\\/\\/127\\.0\\.0\\.1:[0-9]+\\/$/.test($address||'')")
                assertEquals("$stage: the tab names the host port", "true", evaluate(scenario,
                    "document.querySelector('$panel .preview-tabs button[aria-pressed=true]')?.textContent==='Host :$remote'"))
                val local = evaluate(scenario, "Number(($address).match(/:([0-9]+)\\//)[1])").toInt()
                assertTrue("$stage: the forward must listen on a valid device port", local in 1..65535)
                return local
            }
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, parity.port("preview")) { chooseOwnedSshTransport(scenario, parity) }
            parity.mark("preview")
            openOwnedConnect(scenario, name)
            chooseOwnedPrivateKey(scenario, preview.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("preview"), "127.0.0.1:${parity.port("preview")}")
            proveOwnedShell(scenario, parity, parity.prompt("preview"), "PREVIEW")
            sessionView(scenario, "Preview")
            awaitDocument(scenario, "preview panel", present(panel))
            replaceNativeText(scenario, "$panel .preview-filter input:not([type=checkbox])", remote.toString())
            closeSoftKeyboard()
            val first = openDiscovered("first open")
            // The page is loaded by the WebView's iframe through the forward; the host listener and sshd both see it.
            val loaded = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
            while (parity.control("preview").getInt("iframeLoads") < 1) {
                assertTrue("The iframe never reached the host listener through the forward", System.nanoTime() < loaded)
                Thread.sleep(200)
            }
            val body = deviceLoopbackGet(first)
            assertTrue("The device loopback forward must serve the host listener's page", body != null && body.contains(proof))
            val facts = parity.observe("preview")
            assertTrue("sshd must have opened a direct-tcpip channel to the listener: $facts", parityList(facts, "directTcpipTargets").contains(remote.toString()))
            clickPreviewButton("Close preview $remote")
            awaitDocument(scenario, "closed preview leaves no tab", "document.querySelectorAll('$panel .preview-tabs button').length===0")
            awaitLoopbackRefused(first, "closing the preview")
            val second = openDiscovered("second open")
            assertTrue("A new forward must serve the page again", deviceLoopbackGet(second)?.contains(proof) == true)
            sessionView(scenario, "Terminal")
            endOwnedConnection(scenario, name)
            awaitLoopbackRefused(second, "ending the session")
            println("lazysh parity: a preview was discovered, forwarded to device loopback and loaded, then closed and ended with the session, leaving no forward")
        }
    }

    /** A JS array literal for `values`, so a DOM list compares exactly without Android's JSON escaping of "/". */
    private fun jsArray(values: List<String>) = values.joinToString(",", "[", "]") { JSONObject.quote(it) }

    @Test fun ownedSshFilesAndRepositoryReviewThroughRealUi() {
        val name = "Parity files"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val files = parity.fixture.getJSONObject("files")
            val directory = files.getString("directory")
            val repository = files.getString("repository")
            val firstCommit = files.getString("firstCommit")
            // Double quotes keep the selector usable inside the single-quoted JS strings below.
            val filesPanel = "section[aria-label=\"Remote files\"]"
            val reviewPanel = "section.repository-panel"
            var shown = filesPanel
            // A failed wait reports the visible text of the panel it was waiting on.
            fun awaitPanel(stage: String, expression: String) = awaitDocument(scenario, stage, expression,
                observe = { evaluate(scenario, "(document.querySelector(${JSONObject.quote(shown)})?.innerText||'').slice(0,400)") })
            fun click(xpath: String) = onWebView().withElement(findElement(Locator.XPATH, xpath)).perform(webScrollIntoView()).perform(webClick())
            fun clickEntry(entry: String) = click("//section[@aria-label='Remote files']//div[contains(@class,'file-list')]//button[span[normalize-space(text())='$entry']]")
            fun clickChange(file: String, label: String) = click("//section[contains(@class,'repository-panel')]//article[contains(@class,'repository-change')]" +
                "[code[substring(., string-length(.) - ${file.length - 1}) = '$file']]//button[normalize-space(text())='$label']")
            // Controls are disabled while the panel reads, and a click on a disabled button does nothing.
            fun awaitIdle(stage: String, panel: String) = awaitPanel("$stage: $panel idle", "!document.querySelector('$panel [role=status]')")
            fun awaitAlert(stage: String, panel: String, text: String) = awaitPanel(stage,
                "document.querySelector('$panel .inline-error[role=alert]')?.textContent.includes(${JSONObject.quote(text)})===true")
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, parity.port("files")) { chooseOwnedSshTransport(scenario, parity) }
            parity.mark("files")
            openOwnedConnect(scenario, name)
            chooseOwnedPrivateKey(scenario, files.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("files"), "127.0.0.1:${parity.port("files")}")
            proveOwnedShell(scenario, parity, parity.prompt("files"), "FILES")

            // Files: browse the home directory over SFTP, read a text file, and meet both refusals.
            sessionView(scenario, "Files")
            awaitPanel("Files lists the home directory", """
                (()=>{const names=Array.from(document.querySelectorAll('$filesPanel .file-entry span')).map(x=>x.textContent);
                  return names.includes(${JSONObject.quote(directory)}) && !document.querySelector('$filesPanel [role=status]');})()
            """)
            clickEntry(directory)
            awaitPanel("Files lists the fixture directory", """
                (()=>{const names=Array.from(document.querySelectorAll('$filesPanel .file-entry span')).map(x=>x.textContent).sort();
                  return JSON.stringify(names)===JSON.stringify(${jsArray(listOf("blob.bin", "huge.txt", "notes.txt", "review"))}) && !document.querySelector('$filesPanel [role=status]');})()
            """)
            clickEntry("notes.txt")
            awaitPanel("Files shows the text file", """
                (()=>document.querySelector('$filesPanel .file-preview .preview-heading')?.textContent.endsWith('/$directory/notes.txt') &&
                  document.querySelector('$filesPanel .file-preview .repository-code')?.textContent===${JSONObject.quote(files.getString("note") + "\nsecond line\n")})()
            """)
            clickEntry("blob.bin")
            awaitAlert("Files refuses a file that is not UTF-8", filesPanel, "This file is not UTF-8 text")
            awaitIdle("after the binary refusal", filesPanel)
            clickEntry("huge.txt")
            awaitAlert("Files refuses a file over the preview limit", filesPanel, "Text preview is limited to 1 MiB")

            // Repository review: the working tree through Git over exec channels.
            shown = reviewPanel
            sessionView(scenario, "Diff")
            awaitPanel("repository panel", present(reviewPanel))
            replaceNativeText(scenario, "$reviewPanel form.tool-bar input", repository)
            closeSoftKeyboard()
            click("//section[contains(@class,'repository-panel')]//button[normalize-space(text())='Open repository']")
            awaitPanel("status lists every kind of change", """
                (()=>{const rows=Array.from(document.querySelectorAll('$reviewPanel .repository-change code')).map(x=>x.textContent);
                  return JSON.stringify(rows)===JSON.stringify(${jsArray(listOf(" M data.bin", " M file.txt", "A  staged-new.txt", "?? notes/untracked.txt"))}) &&
                    !document.querySelector('$reviewPanel [role=status]');})()
            """)
            fun awaitDiff(stage: String, rows: List<String>) = awaitPanel(stage, """
                (()=>JSON.stringify(Array.from(document.querySelectorAll('$reviewPanel .repository-diff tr.change')).map(row =>
                  Array.from(row.querySelectorAll('pre')).map(x=>x.textContent).join('|')))===JSON.stringify(${jsArray(rows)}) &&
                  !document.querySelector('$reviewPanel [role=status]'))()
            """)
            clickChange("file.txt", "Unstaged diff")
            awaitDiff("unstaged diff of the modified file", listOf("before|after"))
            clickChange("staged-new.txt", "Staged diff")
            awaitDiff("staged diff of the added file", listOf("|staged addition"))
            clickChange("notes/untracked.txt", "Read file")
            awaitPanel("the untracked file's content", """
                (()=>document.querySelector('$reviewPanel .repository-code')?.textContent===${JSONObject.quote(files.getString("untracked") + "\n")} &&
                  !document.querySelector('$reviewPanel [role=status]'))()
            """)
            clickChange("data.bin", "Unstaged diff")
            awaitPanel("the binary diff is refused", """
                (()=>document.querySelector('$reviewPanel .repository-content')?.textContent.includes('Binary file changed. Text diff unavailable.') &&
                  !document.querySelector('$reviewPanel [role=status]'))()
            """)

            // History: the older commit's tree and its own version of a file, not the working copy.
            awaitPanel("the first commit is in the history list", present("$reviewPanel select option[value='$firstCommit']"))
            evaluate(scenario, """(()=>{const select=document.querySelector('$reviewPanel select');
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'$firstCommit');
                select.dispatchEvent(new Event('change',{bubbles:true}));return select.value==='$firstCommit';})()""")
            awaitPanel("the first commit's tree", """
                (()=>JSON.stringify(Array.from(document.querySelectorAll('$reviewPanel .repository-file code')).map(x=>x.textContent).sort())===
                  JSON.stringify(${jsArray(listOf("data.bin", "docs", "file.txt"))}) && !document.querySelector('$reviewPanel [role=status]'))()
            """)
            click("//section[contains(@class,'repository-panel')]//button[contains(@class,'repository-file')][code[normalize-space(text())='docs']]")
            awaitPanel("the first commit's docs directory", """
                (()=>JSON.stringify(Array.from(document.querySelectorAll('$reviewPanel .repository-file code')).map(x=>x.textContent))===
                  JSON.stringify(${jsArray(listOf("docs/readme.md"))}) && !document.querySelector('$reviewPanel [role=status]'))()
            """)
            click("//section[contains(@class,'repository-panel')]//button[contains(@class,'repository-file')][code[normalize-space(text())='docs/readme.md']]")
            val historical = """
                (()=>document.querySelector('$reviewPanel select').value==='$firstCommit' &&
                  document.querySelector('$reviewPanel .repository-code')?.textContent.startsWith(${JSONObject.quote(files.getString("firstReadme") + "\n")}) &&
                  !document.querySelector('$reviewPanel .repository-code').textContent.includes(${JSONObject.quote(files.getString("secondReadme"))}) &&
                  !document.querySelector('$reviewPanel [role=status]'))()
            """
            awaitPanel("the historical file at the first commit", historical)

            // The remembered file: leaving the review and coming back reopens the same revision and file.
            sessionView(scenario, "Terminal")
            awaitPanel("the review panel is gone", "!document.querySelector('$reviewPanel')")
            sessionView(scenario, "Diff")
            awaitPanel("the remembered revision and file are reopened", historical)

            val facts = parity.observe("files")
            assertTrue("Files must have used the SFTP subsystem: $facts", parityCount(facts, "sftpSubsystems") >= 1)
            assertTrue("The repository's Git commands must have run over exec channels: $facts", parityCount(facts, "execRequests") >= 4)
            sessionView(scenario, "Terminal")
            endOwnedConnection(scenario, name)
            println("lazysh parity: Files browsed and read over SFTP with both refusals, and the repository's status, diffs, history, tree and remembered file reviewed over exec")
        }
    }

    /** The text the system clipboard holds, read where the app itself reads it. */
    private fun systemClipboardText(): String? {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        var text: String? = null
        instrumentation.runOnMainSync {
            text = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(instrumentation.targetContext)?.toString()
        }
        return text
    }

    /** A real finger tap (or long press) at the point `point` reports in WebView CSS pixels as [x, y, innerWidth], measured once the keyboard is closed. */
    private fun tapCss(tap: Tap = Tap.SINGLE, point: () -> JSONArray) {
        closeSoftKeyboard()
        val css = point()
        onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(tap, { view ->
            val location = IntArray(2); view.getLocationOnScreen(location)
            val scale = view.width / css.getDouble(2)
            floatArrayOf((location[0] + css.getDouble(0) * scale).toFloat(), (location[1] + css.getDouble(1) * scale).toFloat())
        }, Press.FINGER))
    }

    /** The one visible button with this label or text inside `within` (the whole page by default), hit-tested, as [x, y, innerWidth]. */
    private fun buttonCenter(scenario: ActivityScenario<MainActivity>, label: String, within: String = "") = JSONArray(evaluate(scenario, """
        (()=>{const matches=Array.from(document.querySelectorAll(${JSONObject.quote("$within button".trim())})).filter(x=>(x.getAttribute('aria-label')||x.textContent.trim())===${JSONObject.quote(label)});
          if(matches.length!==1||matches[0].disabled)throw Error('Owned enabled button required');
          const rect=matches[0].getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
          if(document.elementFromPoint(x,y)?.closest('button')!==matches[0])throw Error('Owned button hit target required');
          return [x,y,innerWidth];})()
    """))

    /** The middle of `text` inside the terminal row that reads exactly `row`, as [x, y, innerWidth]. */
    private fun terminalTextCenter(scenario: ActivityScenario<MainActivity>, row: String, text: String) = JSONArray(evaluate(scenario, """
        (()=>{const lines=Array.from(document.querySelectorAll('.terminal-canvas .xterm-rows > div')).filter(x=>x.textContent.replace(/\u00a0/g,' ').trim()===${JSONObject.quote(row)});
          if(lines.length<1)throw Error('Owned terminal row required');
          let offset=lines[0].textContent.indexOf(${JSONObject.quote(text)})+${text.length / 2};
          const nodes=document.createTreeWalker(lines[0],NodeFilter.SHOW_TEXT);
          for(let node=nodes.nextNode();node;node=nodes.nextNode()){
            if(offset<node.textContent.length){const range=document.createRange();range.setStart(node,offset);range.setEnd(node,offset+1);
              const box=range.getBoundingClientRect();return [box.left+box.width/2,box.top+box.height/2,innerWidth];}
            offset-=node.textContent.length;}
          throw Error('Owned terminal text was not drawn');})()
    """))

    /** True once a terminal row reads exactly `row` (blank cells may be drawn as no-break spaces). */
    private fun rowShows(row: String) =
        "Array.from(document.querySelectorAll('.terminal-canvas .xterm-rows > div')).some(x=>x.textContent.replace(/\\u00a0/g,' ').trim()===${JSONObject.quote(row)})"

    private fun regionShows(label: String, text: String) =
        "Array.from(document.querySelectorAll('[role=region]')).some(x=>x.getAttribute('aria-label')===${JSONObject.quote(label)} && x.textContent.includes(${JSONObject.quote(text)}))"

    /** Adds the host, connects it to the primary sshd with the owned private key, trusts the host key and waits for the owned prompt. */
    private fun connectOwnedPrimaryWithKey(scenario: ActivityScenario<MainActivity>, parity: OwnedParity, name: String) {
        addOwnedHost(scenario, name, "127.0.0.1", parity.username, parity.port("primary"))
        openOwnedConnect(scenario, name)
        chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
        submitOwnedConnect(scenario)
        trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:${parity.port("primary")}")
        awaitDocument(scenario, "authenticated owned primary prompt", terminalScreenContains(parity.prompt("primary")))
    }

    /**
     * What a remote shell can ask of the device, observed at the operating system: an OSC 52 write reaches the system
     * clipboard only after the Allow tap, and Open on a terminal link starts an ACTION_VIEW intent for exactly that URL.
     */
    @Test fun ownedSshClipboardAndLinksReachTheSystemThroughRealUi() {
        val name = "Parity clipboard links"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            connectOwnedPrimaryWithKey(scenario, parity, name)

            val copied = "OSC52_${parity.nonce}"
            val osc = "printf '\\033]52;c;%s\\007' \"\$(printf %s $copied | base64)\""
            require(!osc.contains("]52;c;$copied")) { "Owned OSC 52 text must not appear in its input" }
            sendOwnedCommand(scenario, osc, parity.label)
            awaitDocument(scenario, "owned OSC 52 consent", regionShows("Remote clipboard request", copied))
            // The composer's own paste left the command on the clipboard; the remote text must not replace it before consent.
            assertTrue("The OSC 52 text must not reach the clipboard before Allow", systemClipboardText() != copied)
            tapCss { buttonCenter(scenario, "Allow this copy") }
            val copyDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
            while (systemClipboardText() != copied) {
                assertTrue("Allow did not write the OSC 52 text to the system clipboard", System.nanoTime() < copyDeadline)
                Thread.sleep(100)
            }
            // SystemUI previews the copied clip over the bottom-left for a few seconds; wait it out before the next tap.
            awaitClipboardPreviewGone(System.nanoTime())

            val url = "https://example.invalid/l/${parity.nonce.take(8)}"
            sendOwnedCommand(scenario, "printf '%s\\n' $url", parity.label)
            awaitDocument(scenario, "owned terminal link row", rowShows(url))
            var offered = false
            for (attempt in 1..4) {
                if (offered) break
                tapCss { terminalTextCenter(scenario, url, url) }
                // A second tap could dismiss the prompt the first one is still opening, so give each tap time.
                val offerDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
                while (!offered && System.nanoTime() < offerDeadline) {
                    offered = evaluate(scenario, regionShows("Terminal link", url)) == "true"
                    if (!offered) Thread.sleep(100)
                }
            }
            assertTrue("Tapping the terminal link did not offer it", offered)
            val view = IntentFilter(Intent.ACTION_VIEW).apply {
                addDataScheme("https"); addDataAuthority("example.invalid", null); addDataPath("/l/${parity.nonce.take(8)}", PatternMatcher.PATTERN_LITERAL)
            }
            // A blocking monitor stands in for the browser, so the intent is observed without any handler installed.
            val monitor = instrumentation.addMonitor(view, Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true)
            try {
                tapCss { buttonCenter(scenario, "Open in browser") }
                val openDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (monitor.hits < 1) {
                    assertTrue("Open in browser did not start an ACTION_VIEW intent for $url", System.nanoTime() < openDeadline)
                    Thread.sleep(50)
                }
                assertEquals("Open in browser must start exactly one ACTION_VIEW intent", 1, monitor.hits)
            } finally { instrumentation.removeMonitor(monitor) }
            println("lazysh parity: OSC 52 Allow wrote the system clipboard and Open in browser started an ACTION_VIEW intent for the terminal link")
        }
    }

    private val parityOptions = "[role=dialog] .connection-options"

    /** Opens the connection options and chooses the transport through the real native popup. */
    private fun chooseOwnedTransport(scenario: ActivityScenario<MainActivity>, parity: OwnedParity, transport: String) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "$parityOptions > summary")).perform(webScrollIntoView()).perform(webClick())
        selectNativeOption(scenario, parity.nonce, "$parityOptions select", transport)
    }

    /** Waits for the transport the workspace footer names, which is the one the session really uses. */
    private fun awaitOwnedTransport(scenario: ActivityScenario<MainActivity>, shown: String) =
        awaitDocument(scenario, "owned session over $shown", """
            document.querySelector('.workspace-footer > span:last-of-type')?.textContent.startsWith(${JSONObject.quote(shown)}) &&
              Boolean(document.querySelector('.terminal-canvas .xterm-screen'))
        """)

    /**
     * Sets a number option the way React reads it. These fields are controlled: clearing one shows 0 again,
     * so typing after a clear could never produce exactly the intended digits.
     */
    private fun setOwnedNumber(scenario: ActivityScenario<MainActivity>, selector: String, value: Int) =
        assertEquals("Owned number option must take $value", "true", evaluate(scenario, """(()=>{
            const input=document.querySelector(${JSONObject.quote(selector)});
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSONObject.quote(value.toString())});
            input.dispatchEvent(new Event('input',{bubbles:true}));
            return input.value===${JSONObject.quote(value.toString())};})()"""))

    /** Proves a shell whose prompt is not known (ET and Mosh start the account's own login shell) by a fresh command's output. */
    private fun proveOwnedCommand(scenario: ActivityScenario<MainActivity>, parity: OwnedParity, tag: String) {
        val proof = "PARITY_${tag}_${parity.nonce}"
        val command = "printf 'PARITY_%s_%s\\n' '$tag' '${parity.nonce}'"
        require(!command.contains(proof)) { "Owned $tag proof must not appear in its input" }
        sendOwnedCommand(scenario, command, parity.label)
        awaitDocument(scenario, "owned $tag shell proof", terminalScreenContains(proof))
    }

    @Test fun ownedSshAutoFallsBackToSshThroughRealUi() {
        val name = "Parity auto fallback"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val port = parity.port("transport")
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, port)
            openOwnedConnect(scenario, name)
            chooseOwnedTransport(scenario, parity, "auto")
            // Neither helper exists on the host: both bootstraps exit at once instead of hanging on a shell.
            replaceNativeText(scenario, "$parityOptions > fieldset:nth-of-type(1) input[maxlength='4096']", "/nonexistent/lazysh-mosh-server")
            replaceNativeText(scenario, "$parityOptions > fieldset:nth-of-type(2) input[maxlength='4096']", "/nonexistent/lazysh-etterminal")
            chooseOwnedPrivateKey(scenario, parity.fixture.getJSONObject("transport").getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("transport"), "127.0.0.1:$port")
            proveOwnedShell(scenario, parity, parity.prompt("transport"), "AUTO")
            awaitOwnedTransport(scenario, "SSH")
            val notice = evaluate(scenario, "document.querySelector('.browser-banner[role=status]')?.textContent||''")
            assertTrue("Auto must say it selected SSH: $notice", notice.contains("Auto selected SSH."))
            val mosh = notice.indexOf("Mosh: Mosh server failed to start.")
            val et = notice.indexOf("Eternal Terminal: ET helper did not start.")
            assertTrue("Auto must report Mosh, then Eternal Terminal, as skipped: $notice", mosh in 0 until et)
            println("lazysh parity: Auto tried Mosh then ET, kept the trusted SSH terminal and said why")
        }
    }

    @Test fun ownedSshForcedEternalTerminalThroughRealUi() {
        val name = "Parity forced ET"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val port = parity.port("transport")
            val et = parity.fixture.getJSONObject("et")
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, port)
            openOwnedConnect(scenario, name)
            chooseOwnedTransport(scenario, parity, "et")
            replaceNativeText(scenario, "$parityOptions input[maxlength='4096']", et.getString("terminal"))
            setOwnedNumber(scenario, "$parityOptions input[type=number]", et.getInt("port"))
            chooseOwnedPrivateKey(scenario, parity.fixture.getJSONObject("transport").getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("transport"), "127.0.0.1:$port")
            awaitOwnedTransport(scenario, "ET")
            proveOwnedCommand(scenario, parity, "ET")
            val facts = parity.control("et")
            assertTrue("etserver must have started a terminal for this client: $facts", facts.getInt("sessions") >= 1)
            println("lazysh parity: forced Eternal Terminal reached the owned etserver and ran a shell command")
        }
    }

    @Test fun ownedSshMoshCustomServerPathAndPortRangeThroughRealUi() {
        val name = "Parity Mosh options"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val mosh = parity.fixture.getJSONObject("mosh")
            val host = mosh.getString("host")
            val udpPort = mosh.getInt("udpPort")
            addOwnedHost(scenario, name, host, parity.username, mosh.getInt("port"))
            openOwnedConnect(scenario, name)
            chooseOwnedTransport(scenario, parity, "mosh")
            // The host's real mosh-server sits behind this wrapper; the default path would never reach it.
            replaceNativeText(scenario, "$parityOptions input[maxlength='4096']", mosh.getString("serverPath"))
            setOwnedNumber(scenario, "$parityOptions > fieldset label:nth-of-type(2) input", udpPort)
            setOwnedNumber(scenario, "$parityOptions > fieldset label:nth-of-type(3) input", udpPort)
            chooseOwnedPrivateKey(scenario, mosh.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("mosh"), "$host:${mosh.getInt("port")}")
            awaitOwnedTransport(scenario, "Mosh")
            proveOwnedCommand(scenario, parity, "MOSH")
            val facts = parity.control("mosh")
            val range = "$udpPort:$udpPort"
            assertEquals("The custom server path must be bootstrapped once with the single-port range: $facts", listOf(range), parityList(facts, "ranges"))
            assertEquals("The server must hold exactly the configured UDP port: $facts", listOf(udpPort.toString()), parityList(facts, "udpPorts"))
            println("lazysh parity: Mosh ran the custom server path on the one configured UDP port")
        }
    }

    /** Whether the open host editor's client-environment checkbox is ticked ("true" or "false"). */
    private fun ownedClientEnvironmentChecked(scenario: ActivityScenario<MainActivity>) = evaluate(scenario,
        "Array.from(document.querySelectorAll('[role=dialog] label')).find(x=>x.textContent.includes('Identify lazysh to this host'))?.querySelector('input')?.checked===true")

    /** Opens a saved host's editor, reads its client-environment checkbox, and leaves without saving. */
    private fun ownedSavedClientEnvironment(scenario: ActivityScenario<MainActivity>, name: String): String {
        revealOwnedHosts(scenario)
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Edit $name']")).perform(webClick())
        awaitDocument(scenario, "host editor for $name", present(".port-field input"))
        val checked = ownedClientEnvironmentChecked(scenario)
        clickOwnedButton("Cancel")
        awaitDocument(scenario, "host editor for $name closed", "!" + present(".port-field input"))
        return checked
    }

    @Test fun ownedSshClientEnvironmentThroughRealUi() {
        val off = "Parity env off"
        val on = "Parity env on"
        ownedParityCase(listOf(off, on)) { scenario, parity ->
            addOwnedHost(scenario, off, "127.0.0.1", parity.username, parity.port("primary"))
            addOwnedHost(scenario, on, "127.0.0.1", parity.username, parity.port("primary")) {
                onWebView().withElement(findElement(Locator.XPATH,
                    "//*[@role='dialog']//label[contains(normalize-space(.),'Identify lazysh to this host')]/input[@type='checkbox']"))
                    .perform(webScrollIntoView()).perform(webClick())
                assertEquals("The client environment must be opted in for this host only", "true", ownedClientEnvironmentChecked(scenario))
            }
            assertEquals("A new host must not identify lazysh by default", "false", ownedSavedClientEnvironment(scenario, off))
            assertEquals("The opt-in must persist across reopening the host editor", "true", ownedSavedClientEnvironment(scenario, on))
            val dollar = "$"
            // The sshd admits `LANG LC_*`, so only the client's own choice decides what the remote shell sees.
            for ((name, value) in listOf(off to "", on to "lazysh")) {
                openOwnedConnect(scenario, name)
                chooseOwnedPrivateKey(scenario, parity.fixture.getString("privateKey"), parity.label)
                submitOwnedConnect(scenario)
                // The first host pins this address and port, so the second shows no fingerprint review.
                if (name == off) trustOwnedHostKey(scenario, parity.fingerprint("primary"), "127.0.0.1:${parity.port("primary")}")
                awaitDocument(scenario, "authenticated $name prompt", terminalScreenContains(parity.prompt("primary")))
                val proof = "ENV_${value}_${parity.nonce}"
                val command = "printf 'ENV_%s_%s\\n' \"${dollar}LC_TERMINAL\" '${parity.nonce}'"
                require(!command.contains(proof)) { "Owned environment proof must not appear in its input" }
                sendOwnedCommand(scenario, command, parity.label)
                awaitDocument(scenario, "$name remote LC_TERMINAL", terminalScreenContains(proof))
                if (value.isEmpty()) assertEquals("A host without the opt-in must not receive LC_TERMINAL", "false",
                    evaluate(scenario, terminalScreenContains("ENV_lazysh_${parity.nonce}")))
                endOwnedConnection(scenario, name)
            }
            println("lazysh parity: LC_TERMINAL=lazysh reached the remote shell only for the host that opted in")
        }
    }

    /** This device's own display in pixels: the shape a host screenshot of this same device must have. */
    @Suppress("DEPRECATION")
    private fun realDisplaySize(): Point = Point().also {
        InstrumentationRegistry.getInstrumentation().targetContext.getSystemService(android.hardware.display.DisplayManager::class.java)
            .getDisplay(Display.DEFAULT_DISPLAY).getRealSize(it)
    }

    // The host's adb server lists this very emulator, so the panel's Reboot, Shutdown and Boot controls (which would end the
    // app under test) are checked for presence only and never pressed; input stays off. Lifecycle commands need a second
    // owned AVD and stay with the host Cargo cases (docs/reference/devices-acceptance.md).
    @Test fun ownedSshDevicePanelCapturesTheOwnedEmulatorThroughRealUi() {
        val name = "Parity devices"
        ownedParityCase(listOf(name)) { scenario, parity ->
            val devices = parity.fixture.getJSONObject("devices")
            val serial = devices.getString("serial")
            require(Regex("emulator-[0-9]{4,5}").matches(serial)) { "The owned device case needs an emulator serial" }
            val panel = "section[aria-label='Host devices']"
            val owned = "$panel select option[value='$serial']"
            fun clickDeviceButton(label: String) = onWebView().withElement(findElement(Locator.XPATH,
                "//section[@aria-label='Host devices']//button[normalize-space(text())='$label']")).perform(webScrollIntoView()).perform(webClick())
            addOwnedHost(scenario, name, "127.0.0.1", parity.username, parity.port("devices"))
            openOwnedConnect(scenario, name)
            // A new host connects with Auto, which tries Mosh first, and the runner has mosh-server; this case drives SSH exec channels.
            chooseOwnedTransport(scenario, parity, "ssh")
            chooseOwnedPrivateKey(scenario, devices.getString("privateKey"), parity.label)
            submitOwnedConnect(scenario)
            trustOwnedHostKey(scenario, parity.fingerprint("devices"), "127.0.0.1:${parity.port("devices")}")
            proveOwnedShell(scenario, parity, parity.prompt("devices"), "DEVICES")
            sessionView(scenario, "Devices")
            awaitDocument(scenario, "device panel", present(panel))
            clickDeviceButton("Find devices")
            awaitDocument(scenario, "the owned emulator is listed as running", "document.querySelector(${JSONObject.quote(owned)})?.textContent.endsWith(' · running')===true")
            assertEquals("The inventory must list the owned emulator once", "1", evaluate(scenario, "document.querySelectorAll(${JSONObject.quote(owned)}).length"))
            selectNativeOption(scenario, parity.nonce, "$panel select:has(option[value='$serial'])", serial)
            // An emulator offers capture, input, reboot and shutdown but not boot, which belongs to a stopped AVD.
            val offered = JSONObject(evaluate(scenario, """(()=>{
                const buttons=Array.from(document.querySelectorAll(${JSONObject.quote("$panel button")})),named=text=>buttons.find(item=>item.textContent.trim()===text);
                return {capture:named('Capture screen')?.disabled===false,input:document.querySelector(${JSONObject.quote("$panel input[type=checkbox]")})?.disabled===false,
                  reboot:Boolean(named('reboot')),shutdown:Boolean(named('shutdown')),boot:Boolean(named('boot'))};})()"""))
            for ((control, expected) in listOf("capture" to true, "input" to true, "reboot" to true, "shutdown" to true, "boot" to false))
                assertEquals("Offered $control for $serial: $offered", expected, offered.getBoolean(control))
            clickDeviceButton("Capture screen")
            awaitDocument(scenario, "captured frame decoded by the WebView", """(()=>{const image=document.querySelector(${JSONObject.quote("$panel img.device-frame")});
                return Boolean(image) && image.complete && image.naturalWidth>0 && image.src.startsWith('data:image/jpeg;base64,');})()""")
            val frame = JSONObject(evaluate(scenario, """(()=>{
                const image=document.querySelector(${JSONObject.quote("$panel img.device-frame")}),canvas=document.createElement('canvas');
                canvas.width=32;canvas.height=32;const context=canvas.getContext('2d');context.drawImage(image,0,0,32,32);
                const pixels=context.getImageData(0,0,32,32).data,colors=new Set();
                for(let index=0;index<pixels.length;index+=4)colors.add((pixels[index]>>4)<<8|(pixels[index+1]>>4)<<4|pixels[index+2]>>4);
                return {width:image.naturalWidth,height:image.naturalHeight,colors:colors.size};})()"""))
            val real = realDisplaySize()
            assertTrue("The frame must have the shape of this emulator's own ${real.x}x${real.y} screen: $frame",
                Math.abs(frame.getInt("width").toDouble() / frame.getInt("height") - real.x.toDouble() / real.y) < 0.02)
            assertTrue("The frame must show a screen, not one flat colour: $frame", frame.getInt("colors") >= 4)
            assertEquals("The panel must show no error", "false", evaluate(scenario, present("$panel [role=alert]")))
            println("lazysh parity: the Device panel listed $serial as running and showed a ${frame.getInt("width")}x${frame.getInt("height")} frame of the ${real.x}x${real.y} screen")
            sessionView(scenario, "Terminal")
            endOwnedConnection(scenario, name)
        }
    }

    /**
     * Copy on a touch selection, observed at the operating system: a long press selects only the word under the finger,
     * selecting alone leaves the system clipboard untouched, and Copy in the selection actions writes exactly that word.
     */
    @Test fun ownedSshTerminalSelectionCopyReachesTheSystemClipboardThroughRealUi() {
        val name = "Parity selection copy"
        ownedParityCase(listOf(name)) { scenario, parity ->
            connectOwnedPrimaryWithKey(scenario, parity, name)

            val marker = "COPY_${parity.nonce.take(8)}"
            val row = "before $marker after"
            // The marker is printed from two arguments, so the typed command never holds it as one word.
            sendOwnedCommand(scenario, "printf 'before %s%s after\\n' COPY_ ${parity.nonce.take(8)}", parity.label)
            awaitDocument(scenario, "owned selection row", rowShows(row))
            assertTrue("The marker must not be on the system clipboard before the selection", systemClipboardText() != marker)

            val actions = "[role=toolbar][aria-label='Selection actions']"
            tapCss(Tap.LONG) { terminalTextCenter(scenario, row, marker) }
            awaitDocument(scenario, "touch selection actions", present("$actions button"))
            assertTrue("Selecting must not write the system clipboard", systemClipboardText() != marker)

            tapCss { buttonCenter(scenario, "Copy", actions) }
            val copiedAt = System.nanoTime()
            val deadline = copiedAt + TimeUnit.SECONDS.toNanos(10)
            while (systemClipboardText() != marker) {
                assertTrue("Copy did not write exactly the selected word to the system clipboard (it holds ${systemClipboardText()?.take(80)})", System.nanoTime() < deadline)
                Thread.sleep(100)
            }
            awaitDocument(scenario, "selection actions closed after Copy", "!(${present("$actions button")})")
            awaitClipboardPreviewGone(copiedAt)
            println("lazysh parity: a long press selected one terminal word and Copy wrote exactly that word to the system clipboard")
        }
    }

    // The optional sharing service (#1738): the repository's own `lazysh-share` binary, served by the host over TLS
    // with a throwaway certificate. The debug app trusts that one root through its process environment (see
    // `share.rs` `test_root`); every other check is the real Share dialog, and the host reads the service's own state.
    @Test fun ownedShareServiceThroughRealUi() {
        ownedParityCase(emptyList()) { scenario, parity ->
            val share = parity.fixture.getJSONObject("share")
            val origin = share.getString("origin")
            val name = "share-${parity.nonce}.png"
            val color = 0xFF145090.toInt()
            // One exact colour survives the service and the thumbnail decoder bit for bit, so a pixel proves the bytes.
            val image = java.io.ByteArrayOutputStream().also { output ->
                val bitmap = android.graphics.Bitmap.createBitmap(64, 32, android.graphics.Bitmap.Config.ARGB_8888)
                try { bitmap.eraseColor(color); assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output)) } finally { bitmap.recycle() }
            }.toByteArray()
            val digest = java.security.MessageDigest.getInstance("SHA-256").digest(image).joinToString("") { "%02x".format(it.toInt() and 255) }
            val panel = "section[aria-label=\"Shareable uploads\"]"
            fun status(text: String) = "Array.from(document.querySelectorAll('$panel [role=status]')).some(x=>x.textContent===${JSONObject.quote(text)})"
            fun awaitPanel(stage: String, expression: String) = awaitDocument(scenario, stage, expression,
                observe = { evaluate(scenario, "(document.querySelector(${JSONObject.quote(panel)})?.innerText||'').slice(0,400)") })
            fun button(text: String) = "//section[@aria-label='Shareable uploads']//button[normalize-space(.)=${JSONObject.quote(text)}]"
            fun click(text: String) {
                awaitPanel("$text is enabled", "Array.from(document.querySelectorAll('$panel button')).some(x=>x.textContent.trim()===${JSONObject.quote(text)}&&!x.disabled)")
                onWebView().withElement(findElement(Locator.XPATH, button(text))).perform(webScrollIntoView()).perform(webClick())
            }
            fun state(stage: String, uploads: Int, history: Int, downloads: Int, deletes: Int): JSONObject {
                val facts = parity.control("share")
                val requests = facts.getJSONObject("requests")
                assertEquals("$stage: uploads the service received: $facts", uploads, requests.getInt("upload"))
                assertEquals("$stage: history reads the service received: $facts", history, requests.getInt("history"))
                assertEquals("$stage: downloads the service received: $facts", downloads, requests.getInt("download"))
                assertEquals("$stage: deletes the service received: $facts", deletes, requests.getInt("delete"))
                return facts
            }
            Os.setenv("LAZYSH_TEST_SHARE_ROOT_PEM", share.getString("certificate"), true)
            var passed = false
            try {
                // Configure: the origin and the management token go through the real fields.
                awaitUnlockedWorkspace(scenario, "Share dialog")
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Preferences']")).perform(webClick())
                preferencesCategory(scenario, "sharing", panel)
                replaceNativeText(scenario, "$panel input[type=url]", origin)
                pasteOwnedText(scenario, "$panel input[type=password]", share.getString("token"), parity.label)
                closeSoftKeyboard()
                click("Save sharing service")
                awaitPanel("the sharing service is saved", status("Sharing service saved on this device."))
                assertEquals("The saved service is empty", 0, state("after configure", 0, 0, 0, 0).getJSONArray("shares").length())

                // Upload: a PNG chosen through the file input (the system picker is not exercised), sent in chunks to the real service.
                assertEquals("The file input accepted the image", "true", evaluate(scenario, """(()=>{
                    const input=document.querySelector('$panel input[type=file]');
                    const bytes=Uint8Array.from(atob(${JSONObject.quote(Base64.encodeToString(image, Base64.NO_WRAP))}),c=>c.charCodeAt(0));
                    const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSONObject.quote(name)},{type:'image/png'}));
                    input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
                    return input.files.length===1&&input.files[0].size===bytes.length;})()"""))
                awaitPanel("the chosen file is described", "(document.querySelector('$panel fieldset:not(:first-of-type) p')?.textContent||'').startsWith(${JSONObject.quote("$name · ")})")
                click("Upload and create link")
                awaitPanel("the upload completed", status("Upload complete. Copy its expiring link below."))
                val stored = state("after upload", 1, 0, 0, 0).getJSONArray("shares")
                assertEquals("One stored share", 1, stored.length())
                val first = stored.getJSONObject(0)
                assertEquals(name, first.getString("name"))
                assertEquals("image/png", first.getString("mime"))
                assertEquals(image.size, first.getInt("size"))
                assertEquals("The service stored exactly the chosen bytes", digest, first.getString("sha256"))
                assertEquals("The link expires after the default hour", 3600, first.getInt("ttl"))
                val url = first.getString("url")
                assertTrue("The link belongs to the owned service: $url", url.startsWith("$origin/s/"))

                // History: a real round trip to the service lists the upload; its thumbnail is fetched and decoded natively.
                click("Refresh upload history")
                awaitPanel("the history lists the upload", "Array.from(document.querySelectorAll('$panel ul li strong')).map(x=>x.textContent).join()===${JSONObject.quote(name)}")
                assertTrue("History read the service", state("after history", 1, 1, 0, 0).getJSONArray("shares").length() == 1)
                click("Load thumbnail for $name")
                awaitPanel("the thumbnail shows the uploaded pixels", """(()=>{
                    const image=document.querySelector('$panel figure.share-thumbnail img');
                    if(!image||!image.complete||image.naturalWidth!==64||image.naturalHeight!==32)return false;
                    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=32;
                    const context=canvas.getContext('2d');context.drawImage(image,0,0);
                    const pixel=context.getImageData(10,10,1,1).data;
                    return pixel[0]===20&&pixel[1]===80&&pixel[2]===144&&pixel[3]===255;})()""")
                state("after thumbnail", 1, 1, 1, 0)

                // Link: the copied link is the stored share's, and its recipient receives the same bytes over TLS.
                click("Copy link for $name")
                awaitPanel("the link is copied", status("Expiring link copied."))
                val instrumentation = InstrumentationRegistry.getInstrumentation()
                val clipboard = instrumentation.targetContext.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                var copied: String? = null
                instrumentation.runOnMainSync { copied = clipboard.primaryClip?.getItemAt(0)?.text?.toString() }
                assertEquals("The copied link is the stored share's", url, copied)
                val opened = parity.control("open", "url" to url)
                assertEquals("The link serves the share", 200, opened.getInt("status"))
                assertEquals(digest, opened.getString("sha256"))
                assertEquals(image.size, opened.getInt("size"))

                // Delete: the native confirmation names the file; confirming revokes the link on the service.
                // window.confirm blocks the page until the native dialog is answered, so the click must not wait for its own result.
                awaitPanel("Delete is enabled", "Array.from(document.querySelectorAll('$panel button')).some(x=>x.textContent.trim()===${JSONObject.quote("Delete $name")}&&!x.disabled)")
                evaluate(scenario, "(()=>{const target=Array.from(document.querySelectorAll('$panel button')).find(x=>x.textContent.trim()===${JSONObject.quote("Delete $name")});setTimeout(()=>target.click(),0);return true;})()")
                val device = UiDevice.getInstance(instrumentation)
                val message = device.wait(Until.findObject(By.res("android:id/message")), 10_000)
                assertNotNull("The delete confirmation must show", message)
                assertTrue("The confirmation names the file: ${message.text}", message.text.contains(name))
                val closeBy = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (true) {
                    device.findObject(By.res("android:id/button1"))?.click()
                    if (device.wait(Until.gone(By.res("android:id/message")), 3_000)) break
                    assertTrue("The delete confirmation must close after OK", System.nanoTime() < closeBy)
                }
                awaitPanel("the deleted share leaves the list", "document.querySelectorAll('$panel ul li').length===0")
                val gone = state("after delete", 1, 1, 1, 1)
                assertEquals("The service holds no share", 0, gone.getJSONArray("shares").length())
                assertEquals("The deleted link answers not found: $gone", listOf("404"), parityList(gone, "gone"))
                assertEquals("The copied link no longer serves anything", 404, parity.control("open", "url" to url).getInt("status"))
                println("lazysh parity: the share service configured, uploaded to, listed, thumbnailed, linked and deleted through the Share dialog over TLS")
                passed = true
            } finally {
                Os.unsetenv("LAZYSH_TEST_SHARE_ROOT_PEM")
                // Later cases open the hosts drawer, which the open Share dialog covers: close it, and fail here, not in the next case, when it stays.
                val left = runCatching { closeShareDialog(scenario) }.exceptionOrNull()
                if (left != null) { if (passed) throw left else println("lazysh parity: the Share dialog could not be closed after a failed share case: ${left.message}") }
            }
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

    @Test fun ownedNtfyFirstLaunchBudgetAndOneTimePermissionPolicy() {
        val policy=NtfyFirstLaunch(0)
        assertTrue("Unowned permission cannot be admitted",!policy.allow(TimeUnit.SECONDS.toNanos(1),false))
        assertTrue("Delayed owned prompt fits original combined budget",policy.allow(TimeUnit.SECONDS.toNanos(5),true))
        assertTrue("A tap that left the owned prompt visible is not repeated before the retry interval",!policy.allow(TimeUnit.SECONDS.toNanos(5)+TimeUnit.MILLISECONDS.toNanos(499),true))
        assertTrue("An unowned prompt is never tapped again",!policy.allow(TimeUnit.SECONDS.toNanos(5)+TimeUnit.MILLISECONDS.toNanos(500),false))
        assertTrue("The same owned prompt still visible after the retry interval is tapped again",policy.allow(TimeUnit.SECONDS.toNanos(5)+TimeUnit.MILLISECONDS.toNanos(500),true))
        assertTrue("Retries are paced from the latest tap",!policy.allow(TimeUnit.SECONDS.toNanos(5)+TimeUnit.MILLISECONDS.toNanos(900),true))
        assertTrue("Retries stop at the original deadline",!policy.allow(TimeUnit.SECONDS.toNanos(6),true))
        assertTrue("Menu must settle before original total deadline",!policy.active(TimeUnit.SECONDS.toNanos(6)))
        assertTrue("Expired policy cannot dispatch",!NtfyFirstLaunch(0).allow(TimeUnit.SECONDS.toNanos(6),true))
        val trace=NtfyFirstLaunch(0)
        assertEquals("Ntfy first-launch action[stage=none before=unavailable after=unavailable action=none snapshot=unavailable permission=unavailable clickBefore=unavailable clickAfter=unavailable firstExpiry=none]",trace.observation("unavailable"))
        trace.start("menu",TimeUnit.SECONDS.toNanos(4));trace.finish(TimeUnit.SECONDS.toNanos(5));trace.sampled()
        assertTrue("A sampled prompt before the one action is not a post-action observation",trace.observation("denied").contains("snapshot=beforeAction"))
        assertTrue("Observation does not consume admission",trace.allow(TimeUnit.SECONDS.toNanos(5),true))
        trace.start("click",TimeUnit.SECONDS.toNanos(5));trace.finish(TimeUnit.SECONDS.toNanos(6))
        assertEquals("Ntfy first-launch action[stage=click before=positive after=expired action=returned snapshot=beforeAction permission=granted clickBefore=positive clickAfter=expired firstExpiry=click]",trace.observation("granted"))
        assertTrue("A returned action does not extend the original deadline or allowance",!trace.active(TimeUnit.SECONDS.toNanos(6)) && !trace.allow(TimeUnit.SECONDS.toNanos(6),true))
        trace.start("menu",TimeUnit.SECONDS.toNanos(6));trace.finish(TimeUnit.SECONDS.toNanos(7));trace.sampled()
        assertEquals("Ntfy first-launch action[stage=menu before=expired after=expired action=returned snapshot=afterAction permission=denied clickBefore=positive clickAfter=expired firstExpiry=click]",trace.observation("denied"))
        val postClick=NtfyFirstLaunch(0)
        assertTrue(postClick.allow(TimeUnit.SECONDS.toNanos(1),true))
        postClick.start("click",TimeUnit.SECONDS.toNanos(1));postClick.finish(TimeUnit.SECONDS.toNanos(2))
        postClick.start("prompt",TimeUnit.SECONDS.toNanos(5));postClick.finish(TimeUnit.SECONDS.toNanos(6))
        postClick.start("menu",TimeUnit.SECONDS.toNanos(6));postClick.finish(TimeUnit.SECONDS.toNanos(7));postClick.sampled()
        assertEquals("Later menu expiry must not replace the positive click samples or the first crossing operation",
            "Ntfy first-launch action[stage=menu before=expired after=expired action=returned snapshot=afterAction permission=denied clickBefore=positive clickAfter=positive firstExpiry=prompt]",postClick.observation("denied"))
        val between=NtfyFirstLaunch(0)
        between.start("menu",TimeUnit.SECONDS.toNanos(6));between.finish(TimeUnit.SECONDS.toNanos(7))
        assertTrue("Expiry outside a measured operation must remain unattributed",between.observation("denied").contains("firstExpiry=between"))
        val thrown=NtfyFirstLaunch(0)
        assertTrue(thrown.allow(1,true));thrown.start("click",1);thrown.failed()
        assertTrue("Original action exceptions retain an incomplete stage",thrown.observation("unavailable").contains("after=unavailable action=threw"))
        for(invalid in listOf("private","1000")) {
            try {trace.start(invalid,0);throw AssertionError("Unknown operation rejected")}
            catch(_:IllegalArgumentException) { }
            try {trace.observation(invalid);throw AssertionError("Unknown permission rejected")}
            catch(_:IllegalArgumentException) { }
        }
        val settings=NtfySettingsScroll(0)
        assertTrue("Unowned settings cannot scroll",!settings.scroll(0,false))
        repeat(2) { assertTrue("Only two owned preference scrolls allowed",settings.scroll(TimeUnit.SECONDS.toNanos(4),true)) }
        assertTrue("Scroll allowance cannot be reused",!settings.scroll(TimeUnit.SECONDS.toNanos(4),true))
        assertTrue("Expired settings cannot scroll",!NtfySettingsScroll(0).scroll(TimeUnit.SECONDS.toNanos(5),true))
        for((at,category) in listOf(-1L to "negative",999L to "rollback",1000L to "beforeIssued",
            1100L to "withinWindow",1299L to "withinWindow",1300L to "expired")) {
            val observed=NtfyEventRead();var calls=0
            observed.increment(observed.reads);observed.increment(observed.returnedReads);observed.highWater.set(1000)
            assertEquals(at,observed.clock {calls++;at});assertEquals(1,calls)
            assertEquals(category,observed.clockCategory(1100L to 1300L))
            assertEquals("unavailable",NtfyEventRead().clockCategory(1100L to 1300L))
            observed.increment(observed.reads)
            assertEquals("unavailable",observed.clockCategory(1100L to 1300L))
            repeat(5) {observed.increment(observed.reads)}
            assertEquals("many",observed.count(observed.reads))
        }
        val failedClock=NtfyEventRead();val originalFailure=IllegalStateException("Owned clock failure")
        try {failedClock.clock {throw originalFailure};throw AssertionError("Original clock failure required")}
        catch(failure:IllegalStateException) {assertSame(originalFailure,failure)}
        for(offset in listOf(-600L,0L,600L)) {
            val before=NtfyClockPoint(1000+offset,0,0)
            assertEquals("consistentWithinSecond",before.progress(NtfyClockPoint(1002+offset,2_000_000_000,2_000_000_000)))
            assertEquals("wallAhead",before.progress(NtfyClockPoint(1005+offset,2_000_000_000,2_000_000_000)))
            assertEquals("wallBehind",before.progress(NtfyClockPoint(999+offset,2_000_000_000,2_000_000_000)))
            assertEquals("consistentWithinSecond",before.progress(NtfyClockPoint(1060+offset,60_000_000_000,60_000_000_000)))
        }
        val before=NtfyClockPoint(1000,0,0)
        assertEquals("consistentWithinSecond",before.progress(NtfyClockPoint(1001,999_999_999,1_000_000_001)))
        assertEquals("unavailable",before.progress(NtfyClockPoint(-1,2,2)))
        assertEquals("unavailable",NtfyClockPoint(1000,3,4).progress(NtfyClockPoint(1001,2,2)))
        assertEquals("beforeIssued",before.window(1001L to 1301L))
    }

    private data class NtfyClockPoint(val wall:Long,val before:Long,val after:Long) {
        companion object {
            fun sample():NtfyClockPoint {
                val before=android.os.SystemClock.elapsedRealtimeNanos()
                val wall=System.currentTimeMillis()/1000
                return NtfyClockPoint(wall,before,android.os.SystemClock.elapsedRealtimeNanos())
            }
        }
        fun progress(later:NtfyClockPoint):String {
            if(wall<0 || later.wall<0 || before<0 || after<before || later.before<after || later.after<later.before)return "unavailable"
            val second=java.math.BigInteger.valueOf(1_000_000_000)
            val delta=(java.math.BigInteger.valueOf(later.wall)-java.math.BigInteger.valueOf(wall))*second
            // Floor-second wall samples have less than one second of difference uncertainty.
            return when {
                delta<java.math.BigInteger.valueOf(later.before-after)-second->"wallBehind"
                delta>java.math.BigInteger.valueOf(later.after-before)+second->"wallAhead"
                else->"consistentWithinSecond"
            }
        }
        fun window(bounds:Pair<Long,Long>?)=when {
            bounds==null || wall<0->"unavailable"
            wall<bounds.first->"beforeIssued"
            wall>=bounds.second->"expired"
            else->"withinWindow"
        }
    }
    private data class NtfyPostClock(val before:NtfyClockPoint,val after:NtfyClockPoint,
        val hostProgress:String,val issuedInHandler:String)

    private class NtfyEventRead {
        val entered=CountDownLatch(1)
        val returned=CountDownLatch(1)
        val receipts=AtomicReference("unavailable")
        val reads=java.util.concurrent.atomic.AtomicInteger()
        val returnedReads=java.util.concurrent.atomic.AtomicInteger()
        val writes=java.util.concurrent.atomic.AtomicInteger()
        val returnedWrites=java.util.concurrent.atomic.AtomicInteger()
        val storedEnabled=AtomicReference("unavailable")
        val highWater=AtomicReference<Long?>(null)
        private val at=AtomicReference<NtfyClockPoint?>(null)
        private val clocks=java.util.concurrent.atomic.AtomicInteger()
        @Synchronized fun increment(counter:java.util.concurrent.atomic.AtomicInteger) {counter.updateAndGet {minOf(it+1,2)}}
        fun count(counter:java.util.concurrent.atomic.AtomicInteger)=when(counter.get()) {0->"zero";1->"one";else->"many"}
        fun clock(original:()->Long):Long {
            val before=android.os.SystemClock.elapsedRealtimeNanos()
            val value=original()
            val after=android.os.SystemClock.elapsedRealtimeNanos()
            synchronized(this) {increment(clocks);at.set(NtfyClockPoint(value,before,after))}
            return value
        }
        private fun singleClock():NtfyClockPoint?=
            if(reads.get()==1 && returnedReads.get()==1 && clocks.get()==1)at.get() else null
        @Synchronized fun progress(before:NtfyClockPoint?):String {
            val current=singleClock() ?: return "unavailable"
            return before?.progress(current) ?: "unavailable"
        }
        @Synchronized fun clockCategory(window:Pair<Long,Long>?):String {
            // Multiple callbacks cannot be collapsed into one clock decision.
            val point=singleClock() ?: return "unavailable"
            val value=point.wall
            val high=highWater.get() ?: return "unavailable"
            if(value<0)return "negative"
            if(value<high)return "rollback"
            return point.window(window)
        }
    }

    private fun <T> withOwnedRestoration(label:String, restore:()->Unit, action:()->T):T {
        var primary:Throwable?=null
        try {return action()} catch(failure:Throwable) {primary=failure;throw failure}
        finally {
            try {restore()} catch (_:Throwable) {
                val finite=AssertionError(label)
                val first=primary
                if(first==null)throw finite else first.addSuppressed(finite)
            }
        }
    }

    @Test fun ownedUnifiedPushEventParserAndKeystoreReplayStateFailClosed() {
        val trafficPrimary=AssertionError("original")
        ntfyChallengeTrafficFailure(trafficPrimary) {throw IllegalStateException("private")}
        assertEquals("original",trafficPrimary.message);assertEquals(0,trafficPrimary.suppressed.size)
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        org.junit.Assume.assumeTrue("Owned ntfy acceptance only",InstrumentationRegistry.getArguments().getString("lazyshNtfyAcceptance")=="true")
        val context=instrumentation.targetContext
        val primary=AssertionError("Owned primary failure")
        val restorations=mutableListOf<String>()
        var observed:Throwable?=null
        try {
            withOwnedRestoration("Owned store restoration failed",{restorations.add("store");error("private store details")}) {
                withOwnedRestoration("Owned clock restoration failed",{restorations.add("clock");error("private clock details")}) {throw primary}
            }
        } catch(failure:Throwable) {observed=failure}
        assertTrue("Restoration preserves primary failure and finite metadata",observed===primary &&
            primary.suppressed.map {it.message}==listOf("Owned clock restoration failed","Owned store restoration failed") &&
            primary.suppressed.all {it.cause==null})
        assertEquals("Both original dependencies are restored",listOf("clock","store"),restorations)
        fun native(name:String)=Class.forName("app.lazysh.unifiedpush.$name",true,context.classLoader)
        val parser=native("EventDisplayKt").getDeclaredMethod("parseDisplayEvent",ByteArray::class.java,Boolean::class.javaPrimitiveType)
        val device=java.util.UUID.randomUUID().toString()
        val receipt=java.util.UUID.randomUUID().toString()
        val event=java.util.UUID.randomUUID().toString()
        val valid=org.json.JSONObject().put("schemaVersion",2).put("deviceId",device).put("generation",7)
            .put("receiptId",receipt).put("eventId",event).put("kind","done").put("alias","public alias")
            .put("issuedAt",1000).put("expiresAt",1300).toString()
        fun parse(text:String,decrypted:Boolean=true)=parser.invoke(null,text.toByteArray(Charsets.UTF_8),decrypted)
        assertTrue("Exact decrypted bounded v2 event accepted",parse(valid)!=null)
        val nil=java.util.UUID(0,0).toString()
        assertTrue("Service-valid nil event UUID accepted",parse(valid.replace(event,nil))!=null)
        assertTrue("Nil device identifier remains rejected",parse(valid.replace(device,nil))==null)
        assertTrue("Nil receipt identifier remains rejected",parse(valid.replace(receipt,nil))==null)
        assertTrue("Exact 2KiB envelope accepted",parse(valid+" ".repeat(2048-valid.toByteArray(Charsets.UTF_8).size))!=null)
        val invalid=listOf(valid.replace("\"schemaVersion\":2","\"schemaVersion\":1"),
            valid.replace("\"generation\":7","\"generation\":7.0"),valid.replace("\"generation\":7","\"generation\":-1"),
            valid.replace("\"kind\":\"done\"","\"kind\":\"command\""),valid.replace("1300","1301"),
            valid.replace("1300","1000"),valid.replace("public alias","invalid\\nmessage"),
            valid.replace(receipt,"invalid"),valid.dropLast(1)+",\"extra\":true}",
            valid.dropLast(1)+",\"generation\":7}",valid+" trailing"," ".repeat(2049),
            valid.replace("public alias","a".repeat(65)),valid+" ".repeat(2049-valid.toByteArray(Charsets.UTF_8).size))
        for (text in invalid) assertTrue("Invalid bound envelope rejected without content output",parse(text)==null)
        assertTrue("Undecrypted event is inert",parse(valid,false)==null)
        assertTrue("Invalid UTF8 event is inert",parser.invoke(null,byteArrayOf(0xc0.toByte(),0xaf.toByte()),true)==null)
        val local=java.util.UUID.randomUUID().toString()
        val instance=java.util.UUID.randomUUID().toString()
        val subscription=java.util.UUID.randomUUID().toString()
        val stateJson=org.json.JSONObject().put("schemaVersion",1).put("localId",local).put("epoch",1)
            .put("instance",instance).put("deviceId",device).put("generation",7).put("subscriptionId",subscription)
            .put("enabled",false).put("highWater",1000).put("receipts",org.json.JSONArray().put(
                org.json.JSONObject().put("receiptId",receipt).put("expiresAt",1300)))
        val state=native("EventDisplayStoreKt").getDeclaredMethod("decodeDisplayState",org.json.JSONObject::class.java).invoke(null,stateJson)
        val storeType=native("PrivateDisplayStore")
        val preferences=context.getSharedPreferences("lazysh-unifiedpush-display-v1",android.content.Context.MODE_PRIVATE)
        val prior=preferences.getString("ciphertext",null)
        withOwnedRestoration("Original owned replay fixture restoration failed",{
            val edit=preferences.edit()
            if(prior==null)edit.remove("ciphertext") else edit.putString("ciphertext",prior)
            check(edit.commit())
        }) {
            val store=storeType.getDeclaredConstructor(android.content.Context::class.java).newInstance(context)
            storeType.getDeclaredMethod("setValue",native("DisplayState")).invoke(store,state)
            val encoded=checkNotNull(preferences.getString("ciphertext",null))
            assertTrue("Replay state is ciphertext only",!encoded.contains(receipt) && !encoded.contains(device) && preferences.all.keys==setOf("ciphertext"))
            val restarted=storeType.getDeclaredConstructor(android.content.Context::class.java).newInstance(context)
            assertTrue("Keystore replay state survives recreation",storeType.getDeclaredMethod("getValue").invoke(restarted)==state)
            assertTrue("Owned corruption committed",preferences.edit().putString("ciphertext","invalid-owned-ciphertext").commit())
            var closed=false
            try {storeType.getDeclaredMethod("getValue").invoke(restarted)} catch (error:java.lang.reflect.InvocationTargetException) {
                val failure=error.targetException
                closed=failure is IllegalStateException && failure.message=="Private notification state unavailable" && failure.cause==null
            }
            assertTrue("Unreadable replay state never becomes an empty cache",closed)
            assertTrue("Unreadable ciphertext retained",preferences.getString("ciphertext",null)=="invalid-owned-ciphertext")
        }
        println("lazysh bound event policy: closedParser=true undecryptedInert=true keystoreRoundtrip=true unreadableFailClosed=true privateContentsLogged=false")
    }

    @Test fun ntfyReturnObservationIsClosedAndCannotReplaceThePrimaryFailure() {
        val roles=NtfyReturnRole.entries
        for((input,expected) in listOf(null to "unavailable","io.heckel.ntfy" to "ntfy",
            "com.android.permissioncontroller" to "permission","app.lazysh.client" to "lazysh",
            "com.android.inputmethod.latin" to "aospIme","private-origin/path" to "other")) {
            var calls=0
            val sample=NtfyReturnSnapshot.observe({input}) { calls++;it==NtfyReturnRole.ime }
            assertEquals(expected,sample.foreground);assertEquals(roles.size,calls)
            assertTrue("No raw foreground values retained",!sample.closed().contains("private-origin"))
        }
        for(failed in roles) {
            val sample=NtfyReturnSnapshot.observe({throw IllegalStateException("private")}) {
                if(it==failed)throw IllegalStateException("private") else true
            }
            assertEquals("unavailable",sample.foreground)
            assertEquals(null,sample.roles[failed]);assertEquals(roles.size-1,sample.roles.values.count {it==true})
            assertTrue(!sample.closed().contains("private"))
        }
        val sample=NtfyReturnSnapshot.observe({"io.heckel.ntfy"}) {false}
        val primary=AssertionError("Owned TLS trust topic")
        ntfyReturnFailure(primary) {sample}
        assertEquals(1,primary.suppressed.size)
        assertEquals("Ntfy return state[${sample.closed()}]",primary.suppressed.single().message)
        val original=AssertionError("original")
        var calls=0
        ntfyReturnFailure(original) {calls++;error("private")}
        assertEquals("original",original.message);assertEquals(1,original.suppressed.size)
        assertEquals(1,calls)
        assertTrue(original.suppressed.single().message.orEmpty().contains("foreground=unavailable"))
        assertTrue(!original.suppressed.single().message.orEmpty().contains("private"))
    }

    @Test(timeout = 120_000) fun ownedNtfyEncryptedChallengeUsesNativeDialogAndBackgroundCallback() {
        val arguments=InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue("Owned ntfy acceptance only",arguments.getString("lazyshNtfyAcceptance")=="true")
        val nonce=arguments.getString("lazyshNtfyNonce") ?: error("Owned ntfy nonce required")
        assertTrue("Invalid owned nonce",nonce.matches(Regex("[a-f0-9]{32}")))
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue("Explicit fixture-only debug trust required before private input",
            (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE)!=0 &&
                context.resources.getIdentifier("lazysh_unifiedpush_test_ca","raw",context.packageName)!=0)
        val input=File(context.filesDir,".lazysh-ntfy-$nonce.json")
        val descriptor=Os.open(input.path,OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK,0)
        val bytes=java.io.FileInputStream(descriptor).use { stream ->
            val stat=Os.fstat(descriptor)
            assertTrue("Private bounded native fixture required",OsConstants.S_ISREG(stat.st_mode) && stat.st_uid==android.os.Process.myUid()
                && (stat.st_mode and 0x1ff)==0x180 && stat.st_size in 1L..4096L)
            stream.readNBytes(4097).also { assertTrue("Native fixture bound",it.size==stat.st_size.toInt()) }
        }
        assertTrue("Owned input cleanup",input.delete())
        val data=try { JSONObject(Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes)).toString()) } finally { bytes.fill(0) }
        assertTrue("Owned fixture nonce binding",data.getString("nonce")==nonce)
        for(name in listOf("relayOrigin","ntfyOrigin","untrustedOrigin")) {
            val value=data.getString(name)
            assertTrue("Only owned loopback TLS fixture origins",value.matches(Regex("https://localhost:[1-9][0-9]{0,4}"))
                && java.net.URI(value).port in 1..65535)
        }
        assertTrue("Bounded fixture enrollment",data.getString("enrollment").matches(Regex("[a-f0-9]{64}")))
        val device=UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        fun node(selector:androidx.test.uiautomator.BySelector,stage:String):androidx.test.uiautomator.UiObject2 {
            val result=device.wait(Until.findObject(selector),5000)
            assertTrue(stage,result!=null);return checkNotNull(result)
        }
        fun ntfyResource(name:String)=By.res("io.heckel.ntfy",name)
        assertTrue("Permission controller must be a system application",
            context.packageManager.getApplicationInfo("com.android.permissioncontroller",0).flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM!=0)
        val launch=context.packageManager.getLaunchIntentForPackage("io.heckel.ntfy") ?: error("Owned distributor not installed")
        context.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        val firstLaunch=NtfyFirstLaunch(System.nanoTime())
        val menuSelector=By.pkg("io.heckel.ntfy").desc("More options")
        var menu:androidx.test.uiautomator.UiObject2?=null
        var foreground="other";var allow=false;var deny=false;var toolbar=false;var ownedPrompt=false
        try {
            while(firstLaunch.active(System.nanoTime())) {
                firstLaunch.start("foreground",System.nanoTime())
                foreground=when(device.currentPackageName) {"io.heckel.ntfy"->"ntfy";"com.android.permissioncontroller"->"permission";"app.lazysh.client"->"lazysh";else->"other"}
                firstLaunch.finish(System.nanoTime())
                firstLaunch.start("allow",System.nanoTime())
                val choice=device.findObject(By.res("com.android.permissioncontroller","permission_allow_button"))
                firstLaunch.finish(System.nanoTime())
                allow=choice!=null
                firstLaunch.start("deny",System.nanoTime())
                deny=device.hasObject(By.res("com.android.permissioncontroller","permission_deny_button"))
                firstLaunch.finish(System.nanoTime())
                firstLaunch.start("toolbar",System.nanoTime())
                toolbar=device.hasObject(ntfyResource("toolbar"))
                firstLaunch.finish(System.nanoTime())
                firstLaunch.start("prompt",System.nanoTime())
                val prompt=device.findObject(By.res("com.android.permissioncontroller","permission_message"))?.text
                firstLaunch.finish(System.nanoTime())
                ownedPrompt=foreground=="permission" && prompt?.contains(Regex("\\bntfy\\b"))==true && prompt?.contains("notifications",ignoreCase=true)==true
                firstLaunch.start("menu",System.nanoTime())
                menu=device.findObject(menuSelector)
                firstLaunch.finish(System.nanoTime())
                firstLaunch.sampled()
                if(foreground=="ntfy" && menu!=null && firstLaunch.active(System.nanoTime())) break
                val retry=firstLaunch.attempted
                if(firstLaunch.allow(System.nanoTime(),ownedPrompt && allow)) {
                    firstLaunch.start("click",System.nanoTime())
                    // A re-tap can race the dialog finally dismissing; only the first tap must resolve.
                    try {checkNotNull(choice).click()} catch(stale:androidx.test.uiautomator.StaleObjectException) {if(!retry)throw stale}
                    firstLaunch.finish(System.nanoTime())
                }
                val remaining=firstLaunch.deadline-System.nanoTime()
                if(remaining>0)Thread.sleep(TimeUnit.NANOSECONDS.toMillis(remaining).coerceIn(1,20))
            }
            assertTrue("Distributor menu; foreground=$foreground allow=$allow deny=$deny toolbar=$toolbar ownedPrompt=$ownedPrompt attempted=${firstLaunch.attempted}",
                foreground=="ntfy" && menu!=null && firstLaunch.active(System.nanoTime()))
        } catch(failure:Throwable) {
            firstLaunch.failed()
            val permission=runCatching {
                if(context.packageManager.checkPermission(android.Manifest.permission.POST_NOTIFICATIONS,"io.heckel.ntfy")==PackageManager.PERMISSION_GRANTED)"granted" else "denied"
            }.getOrDefault("unavailable")
            failure.addSuppressed(AssertionError(firstLaunch.observation(permission)))
            throw failure
        }
        checkNotNull(menu).click()
        node(By.pkg("io.heckel.ntfy").text("Settings"),"Distributor settings").click()
        val settings=NtfySettingsScroll(System.nanoTime())
        var preference:androidx.test.uiautomator.UiObject2?=null
        var settingsForeground=false;var settingsToolbar=false;var preferenceList=false
        while(settings.active(System.nanoTime())) {
            settingsForeground=device.currentPackageName=="io.heckel.ntfy"
            settingsToolbar=device.hasObject(ntfyResource("toolbar").hasDescendant(By.text("Settings")))
            val lists=device.findObjects(By.pkg("io.heckel.ntfy").clazz("androidx.recyclerview.widget.RecyclerView"))
            preferenceList=lists.size==1
            val ownedSettings=settingsForeground && settingsToolbar && preferenceList
            preference=device.findObject(By.pkg("io.heckel.ntfy").text("Default server"))
            if(ownedSettings && preference!=null && settings.active(System.nanoTime()))break
            if(settings.scroll(System.nanoTime(),ownedSettings))lists.single().scroll(androidx.test.uiautomator.Direction.DOWN,0.75f)
            val remaining=settings.deadline-System.nanoTime()
            if(remaining>0)Thread.sleep(TimeUnit.NANOSECONDS.toMillis(remaining).coerceIn(1,20))
        }
        assertTrue("Owned default server; settingsForeground=$settingsForeground settingsToolbar=$settingsToolbar preferenceList=$preferenceList preferenceTarget=${preference!=null} scrollAttempts=${settings.attempts}",
            settingsForeground && settingsToolbar && preferenceList && preference!=null && settings.active(System.nanoTime()))
        checkNotNull(preference).click()
        node(ntfyResource("default_server_dialog_url"),"Default server field").text=data.getString("ntfyOrigin")
        fun returnSnapshot()=NtfyReturnSnapshot.observe({device.currentPackageName}) { role ->
            device.hasObject(when(role) {
                NtfyReturnRole.settings -> ntfyResource("toolbar").hasDescendant(By.text("Settings"))
                NtfyReturnRole.defaultDialog -> ntfyResource("default_server_dialog_url")
                NtfyReturnRole.add -> By.pkg("io.heckel.ntfy").desc("Add subscription")
                NtfyReturnRole.certificate -> ntfyResource("trusted_certificate_fingerprint")
                NtfyReturnRole.allow -> By.res("com.android.permissioncontroller","permission_allow_button")
                NtfyReturnRole.deny -> By.res("com.android.permissioncontroller","permission_deny_button")
                NtfyReturnRole.ime -> By.pkg("com.android.inputmethod.latin")
            })
        }
        // Observe only after failure; preserve the original navigation timing.
        try {
            node(ntfyResource("default_server_dialog_action_save"),"Save owned default server").click()
            device.pressBack()
            node(By.pkg("io.heckel.ntfy").desc("Add subscription"),"Owned TLS trust topic").click()
        } catch(primary:Throwable) {
            ntfyReturnFailure(primary) {returnSnapshot()}
            throw primary
        }
        node(ntfyResource("add_dialog_subscribe_topic_text"),"Owned trust topic field").text="lazysh-$nonce"
        node(ntfyResource("add_dialog_action_button").enabled(true),"Review owned TLS certificate").click()
        val fingerprint=node(ntfyResource("trusted_certificate_fingerprint"),"Certificate fingerprint review")
            .text.replace(Regex("[^a-fA-F0-9]"),"").lowercase()
        assertTrue("Exact owned server certificate required",fingerprint==data.getString("ntfyFingerprint"))
        node(ntfyResource("trusted_certificate_action_trust"),"Trust only the owned server certificate").click()
        device.pressBack()
        val scenario=NativeActivityFixture.scenario
        awaitUnlockedWorkspace(scenario,"Owned ntfy native workspace")
        assertTrue("No pre-existing private enrollment",!context.getSharedPreferences("lazysh-unifiedpush-enrollment-v1",Context.MODE_PRIVATE).contains("ciphertext"))
        val loader=context.classLoader
        fun native(name:String)=Class.forName("app.lazysh.unifiedpush.$name",true,loader)
        fun singleton(name:String)=native(name).getDeclaredField("INSTANCE").get(null)
        val controller=native("PushEnrollment").getDeclaredMethod("controller",Context::class.java).invoke(singleton("PushEnrollment"),context)
        val stateMethod=native("EnrollmentController").getDeclaredMethod("state")
        fun state()=stateMethod.invoke(controller)
        fun phase(value:Any?)=value?.javaClass?.getDeclaredMethod("getPhase")?.invoke(value)?.toString()
        // Use the unmodified production TLS constructor; no client or CA is injected.
        val stateType=native("EnrollmentState")
        val enumType=native("EnrollmentPhase")
        val initial=checkNotNull(enumType.enumConstants).single {it.toString()=="BOOTSTRAP"}
        val rejected=stateType.declaredConstructors.single {it.parameterTypes.size==14}.newInstance(
            UUID.randomUUID().toString(),1L,data.getString("untrustedOrigin"),"e".repeat(64),UUID.randomUUID().toString(),
            data.getString("enrollment"),initial,null,null,null,null,null,null,null)
        val call=native("EnrollmentCall").getDeclaredConstructor().newInstance()
        val transport=native("EnrollmentHttp").getDeclaredConstructor().newInstance()
        var tlsRejected=false
        try { native("EnrollmentHttp").getDeclaredMethod("bootstrap",stateType,native("EnrollmentCall")).invoke(transport,rejected,call) }
        catch(error:java.lang.reflect.InvocationTargetException) {
            val failure=error.targetException
            tlsRejected=failure is IllegalStateException && failure.message=="Cannot complete private relay request" && failure.cause==null
        } finally {native("EnrollmentCall").getDeclaredMethod("cancel").invoke(call)}
        assertTrue("Unknown CA must preserve the exact redacted production failure",tlsRejected)
        evaluate(scenario,"""(() => {
          window.__lazyshNtfyPermission=undefined;
          window.__TAURI_INTERNALS__.invoke('plugin:notification|request_permission',{}).then(
            value=>{window.__lazyshNtfyPermission=value;},()=>{window.__lazyshNtfyPermission='failed';});return true;
        })()""")
        node(By.res("com.android.permissioncontroller","permission_allow_button"),"Explicit notification permission").click()
        awaitDocument(scenario,"Native notification permission","window.__lazyshNtfyPermission==='granted'")
        fun command(name:String) {
            assertTrue("Fixed native fixture command",name in listOf("push_registration_enroll","push_registration_disable","push_registration_display"))
            evaluate(scenario,"""(() => {
              window.__lazyshNtfyControl=undefined;
              (async()=>{
                const access=await window.__TAURI_INTERNALS__.invoke('app_lock_status',{});
                await window.__TAURI_INTERNALS__.invoke('$name',{},
                  {headers:access.nonce?{'X-Lazysh-Access':access.nonce}:{}});
                window.__lazyshNtfyControl=true;
              })().catch(()=>{window.__lazyshNtfyControl=false;});return true;
            })()""")
        }
        command("push_registration_enroll")
        fun ownedDialog(name:String,label:String):android.app.AlertDialog {
            val field=native(name).getDeclaredField("current").apply {isAccessible=true}
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            var dialog:android.app.AlertDialog?=null
            while(dialog==null && System.nanoTime()<deadline) {
                scenario.onActivity {dialog=field.get(null) as? android.app.AlertDialog}
                if(dialog==null)Thread.sleep(10)
            }
            assertTrue(label,dialog!=null)
            return checkNotNull(dialog)
        }
        val dialog=ownedDialog("EnrollmentDialog","Actual native credential dialog required")
        scenario.onActivity {
            val current=checkNotNull(dialog)
            assertTrue("Native credential secure window",checkNotNull(current.window).attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE!=0)
            fun fields(view:View):List<android.widget.EditText> = when(view) {
                is android.widget.EditText -> listOf(view)
                is ViewGroup -> (0 until view.childCount).flatMap {fields(view.getChildAt(it))}
                else -> emptyList()
            }
            val entries=fields(checkNotNull(current.window).decorView)
            assertTrue("Exact native credential fields",entries.size==2)
            // Native fields only; no value is typed into the renderer or assertion output.
            entries.single {it.hint=="HTTPS relay origin"}.setText(data.getString("relayOrigin"))
            entries.single {it.hint=="One-time enrollment code"}.setText(data.getString("enrollment"))
            current.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick()
            assertTrue("Native credential fields cleared after admission",entries.all {it.text.isEmpty()})
        }
        awaitDocument(scenario,"Actual distributor registration","window.__lazyshNtfyControl===true")
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
        var eventPost:NtfyPostClock?=null
        fun signal(name:String):Pair<Long,Long>? {
            assertTrue("Fixed fixture control",name in listOf("background","replay","complete","event","event-replay"))
            val connection=java.net.URL(data.getString("relayOrigin")+"/__fixture/"+name).openConnection(java.net.Proxy.NO_PROXY) as javax.net.ssl.HttpsURLConnection
            try {
                connection.connectTimeout=2000
                // New event stage waits for the existing worker's bounded 8s
                // receipt; all original challenge/control deadlines remain 2s.
                connection.readTimeout=if(name=="event")10000 else 2000
                connection.instanceFollowRedirects=false
                connection.requestMethod="POST";connection.setRequestProperty("X-Lazysh-Fixture",nonce)
                val clockBefore=if(name=="event")NtfyClockPoint.sample() else null
                assertTrue("Owned fixture control acknowledged",connection.responseCode==204)
                if(name!="event")return null
                fun header(name:String):Long {
                    val values=connection.headerFields.filterKeys {it?.equals(name,true)==true}.values.flatten()
                    check(values.size==1 && Regex("0|[1-9][0-9]{0,18}").matches(values.single())) {"Exact owned event window required"}
                    return checkNotNull(values.single().toLongOrNull()) {"Exact owned event window required"}
                }
                val issued=header("x-lazysh-fixture-issued-at")
                val expires=header("x-lazysh-fixture-expires-at")
                check(expires>issued && expires-issued<=300) {"Exact owned event window required"}
                fun category(name:String,allowed:List<String>):String {
                    val values=connection.headerFields.filterKeys {it?.equals(name,true)==true}.values.flatten()
                    check(values.size==1 && values.single() in allowed) {"Exact owned event clock required"}
                    return values.single()
                }
                val hostProgress=category("x-lazysh-fixture-clock-progress",listOf("consistentWithinSecond","wallAhead","wallBehind","unavailable"))
                val issuedInHandler=category("x-lazysh-fixture-issued-in-handler",listOf("within","outside","unavailable"))
                eventPost=NtfyPostClock(checkNotNull(clockBefore),NtfyClockPoint.sample(),hostProgress,issuedInHandler)
                return issued to expires
            } finally {connection.disconnect()}
        }
        signal("background")
        val confirmedDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15)
        while(phase(state())!="CONFIRMED" && System.nanoTime()<confirmedDeadline)Thread.sleep(20)
        val confirmed=state()
        try {
            assertTrue("Real SDK challenge must confirm native state",phase(confirmed)=="CONFIRMED")
        } catch(primary:AssertionError) {
            // Sample only after the original wait fails; never retain private state or error text.
            fun observedPhase(allowed:Set<String>,read:()->Any?):String = try {
                when(val value=read()) {
                    null -> "absent"
                    is Enum<*> -> value.name.let {if(it in allowed)it else "unknown"}
                    else -> "unknown"
                }
            } catch(_:Exception) {"unavailable"}
            val enrollment=observedPhase(setOf("BOOTSTRAP","REGISTER","SUBSCRIBE","VERIFY","CONFIRMED","REVOKE_PENDING","FAILED")) {
                if(confirmed==null)null else stateType.getDeclaredMethod("getPhase").invoke(confirmed)
            }
            val registration=observedPhase(setOf("OFF","SELECTING","REQUESTED","READY","FAILED","UNAVAILABLE","REVOKE_PENDING")) {
                val owner=native("PushRegistration").getDeclaredMethod("controller",Context::class.java).invoke(singleton("PushRegistration"),context)
                val value=native("RegistrationController").getDeclaredMethod("getRegistration").invoke(owner)
                native("Registration").getDeclaredMethod("getPhase").invoke(value)
            }
            val busy=try {
                when(native("EnrollmentController").getDeclaredMethod("busy").invoke(controller)) {
                    true -> "true"
                    false -> "false"
                    else -> "unavailable"
                }
            } catch(_:Exception) {"unavailable"}
            primary.addSuppressed(AssertionError("Ntfy challenge state[enrollment=$enrollment registration=$registration busy=$busy]"))
            // What the app did with each pushed message: all zero means the distributor never delivered one.
            primary.addSuppressed(AssertionError(try {
                val counts=native("EnrollmentController").getDeclaredMethod("deliveries").invoke(controller) as Map<*,*>
                "Ntfy app deliveries["+checkNotNull(native("MessageOutcome").enumConstants).joinToString(" ") {
                    "${it.toString().lowercase()}=${when(counts[it] as? Int ?: 0) {0 -> "zero";1 -> "one";else -> "many"}}"
                }+"]"
            } catch(_:Exception) {"Ntfy app deliveries[unavailable]"}))
            ntfyChallengeTrafficFailure(primary) {
                val connection=java.net.URL(data.getString("relayOrigin")+"/__fixture/challenge-observation").openConnection(java.net.Proxy.NO_PROXY) as javax.net.ssl.HttpsURLConnection
                try {
                    connection.connectTimeout=2000;connection.readTimeout=2000;connection.instanceFollowRedirects=false
                    connection.requestMethod="POST";connection.setRequestProperty("X-Lazysh-Fixture",nonce)
                    check(connection.responseCode==200)
                    val bytes=connection.inputStream.use {it.readNBytes(257)}
                    check(bytes.size<=256)
                    val value=JSONObject(bytes.toString(Charsets.UTF_8))
                    val names=listOf("subscribeSeen","subscribeOk","confirmSeen","confirmOk")
                    check(value.keys().asSequence().toSet()==names.toSet()+"pushServiceAccepted" && names.all {value.get(it) is Boolean})
                    val accepted=value.getString("pushServiceAccepted")
                    check(accepted in setOf("accepted","notAccepted","unknown"))
                    "Ntfy relay after-failure["+names.joinToString(" ") {"$it=${value.getBoolean(it)}"}+" pushServiceAccepted=$accepted]"
                } finally {connection.disconnect()}
            }
            throw primary
        }
        assertTrue("Exact server device binding",stateType.getDeclaredMethod("getDeviceId").invoke(confirmed)==data.getString("deviceId"))
        assertTrue("Exact server generation binding",(stateType.getDeclaredMethod("getGeneration").invoke(confirmed) as Number).toLong()==data.getLong("generation"))
        assertTrue("Challenge arrived while Activity backgrounded",scenario.state==androidx.lifecycle.Lifecycle.State.CREATED)
        signal("replay")
        assertTrue("Confirmed state survives an owned encrypted replay",phase(state())=="CONFIRMED")
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        awaitUnlockedWorkspace(scenario,"Original native workspace after remote challenge")
        command("push_registration_display")
        val displayDialog=ownedDialog("DisplayConsentDialog","Actual native display consent dialog required")
        scenario.onActivity {
            assertTrue("Separate display consent secure window",checkNotNull(displayDialog.window).attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE!=0)
            displayDialog.getButton(android.app.AlertDialog.BUTTON_POSITIVE).performClick()
        }
        awaitDocument(scenario,"Original lease commits native display consent","window.__lazyshNtfyControl===true")
        val displayRuntime=native("PushDisplay")
        val displayObject=displayRuntime.getDeclaredField("INSTANCE").get(null)
        val display=displayRuntime.getDeclaredMethod("controller",android.content.Context::class.java).invoke(displayObject,context)
        val displayType=native("EventDisplayController")
        val storeField=displayType.getDeclaredField("store").apply {isAccessible=true}
        val originalStore=storeField.get(display)
        val clockField=displayType.getDeclaredField("now").apply {isAccessible=true}
        @Suppress("UNCHECKED_CAST")
        val originalNow=clockField.get(display) as ()->Long
        val storeType=native("DisplayStore")
        val getValue=storeType.getDeclaredMethod("getValue")
        fun displayState()=checkNotNull(getValue.invoke(originalStore))
        val beforeEvent=displayState()
        val displayStateType=native("DisplayState")
        val binding=displayStateType.getDeclaredMethod("getBinding").invoke(beforeEvent)
        assertTrue("Separate native display consent persisted",displayStateType.getDeclaredMethod("getEnabled").invoke(beforeEvent)==true)
        val notifications=context.getSystemService(android.app.NotificationManager::class.java)
        fun ownedNotification()=notifications.activeNotifications.singleOrNull {it.tag=="lazysh-unifiedpush-event" && it.id==4201}
        assertTrue("Consent alone cannot post a remote notification",ownedNotification()==null)
        fun receipts(read:()->Any?)=runCatching {
            when((displayStateType.getDeclaredMethod("getReceipts").invoke(read()) as List<*>).size) {
                0->"zero";1->"one";else->"many"
            }
        }.getOrDefault("unavailable")
        fun flag(read:()->Boolean)=runCatching {read().toString()}.getOrDefault("unavailable")
        val initialReceipts=receipts {beforeEvent}
        val eventRead=NtfyEventRead()
        val readPhase=AtomicReference(eventRead)
        fun messageRead()=Thread.currentThread().stackTrace.any {
            it.className=="app.lazysh.unifiedpush.EventDisplayController" && it.methodName=="message"
        }
        val observedNow:()->Long={if(messageRead())readPhase.get().clock(originalNow) else originalNow()}
        val observer=java.lang.reflect.Proxy.newProxyInstance(context.classLoader,arrayOf(storeType)) { _,method,args ->
            val observation=if(messageRead())readPhase.get() else null
            val reading=method.name=="getValue"
            val writing=method.name=="setValue"
            if(reading)observation?.let {synchronized(it) {
                it.increment(it.reads);it.entered.countDown();it.highWater.set(null);it.storedEnabled.set("unavailable")
            }}
            if(writing)observation?.let {it.increment(it.writes)}
            if(reading || writing)observation?.receipts?.set("unavailable")
            val result=try {method.invoke(originalStore,*(args?:emptyArray()))}
                catch(error:java.lang.reflect.InvocationTargetException) {throw error.targetException}
            // Categorize completed original operations, never add a diagnostic Keystore read.
            if(reading || writing)observation?.receipts?.set(receipts {if(reading)result else args?.firstOrNull()})
            if(reading)observation?.let {synchronized(it) {
                it.highWater.set(runCatching {(displayStateType.getDeclaredMethod("getHighWater").invoke(result) as Number).toLong()}.getOrNull())
                it.storedEnabled.set(flag {displayStateType.getDeclaredMethod("getEnabled").invoke(result) as Boolean})
                it.increment(it.returnedReads);it.returned.countDown()
            }}
            if(writing)observation?.let {it.increment(it.returnedWrites)}
            result
        }
        withOwnedRestoration("Original owned store observer restoration failed",{storeField.set(display,originalStore)}) {
          withOwnedRestoration("Original owned clock observer restoration failed",{clockField.set(display,originalNow)}) {
            // Test-only read observer; every operation delegates unchanged to the
            // original real Keystore store/controller/notification implementation.
            storeField.set(display,observer)
            clockField.set(display,observedNow)
            scenario.moveToState(androidx.lifecycle.Lifecycle.State.CREATED)
            val eventWindow=checkNotNull(signal("event")) {"Exact owned event window required"}
            val notificationDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15)
            while(ownedNotification()==null && System.nanoTime()<notificationDeadline)Thread.sleep(20)
            val delivered=checkNotNull(ownedNotification()) {
                val readReturned=eventRead.returned.count==0L
                val entered=eventRead.entered.count==0L
                "Actual bound-event notification required; eventObservation[entered=$entered readReturned=$readReturned"+
                    " initialReceipts=$initialReceipts finalReceipts=${eventRead.receipts.get()}"+
                    " appNotifications=${flag {notifications.areNotificationsEnabled()}}"+
                    " postPermission=${flag {Build.VERSION.SDK_INT<33 || context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED}}"+
                    " channelEnabled=${flag {Build.VERSION.SDK_INT<26 || (notifications.getNotificationChannel("lazysh-remote-events-v1")?.importance ?: android.app.NotificationManager.IMPORTANCE_NONE)!=android.app.NotificationManager.IMPORTANCE_NONE}}"+
                    " ownedNotification=${flag {ownedNotification()!=null}}"+
                    " reads=${eventRead.count(eventRead.reads)} returnedReads=${eventRead.count(eventRead.returnedReads)}"+
                    " writes=${eventRead.count(eventRead.writes)} returnedWrites=${eventRead.count(eventRead.returnedWrites)}"+
                    " storedEnabled=${eventRead.storedEnabled.get()} clock=${eventRead.clockCategory(eventWindow)}"+
                    " hostProgress=${eventPost?.hostProgress ?: "unavailable"} issuedInHandler=${eventPost?.issuedInHandler ?: "unavailable"}"+
                    " postProgress=${eventPost?.let {it.before.progress(it.after)} ?: "unavailable"}"+
                    " callbackProgress=${eventRead.progress(eventPost?.before)} postClock=${eventPost?.after?.window(eventWindow) ?: "unavailable"}]"
            }
            val notification=delivered.notification
            assertTrue("Actual private generic notification",notification.visibility==android.app.Notification.VISIBILITY_PRIVATE &&
                notification.channelId=="lazysh-remote-events-v1" && notification.extras.getCharSequence(android.app.Notification.EXTRA_TITLE)?.toString()=="lazysh" &&
                notification.extras.getCharSequence(android.app.Notification.EXTRA_TEXT)?.toString()=="A remote agent event is available. Open lazysh to inspect your sessions.")
            assertTrue("Actual immutable own-app intent without remote actions",notification.contentIntent?.isImmutable==true &&
                notification.contentIntent?.creatorPackage==context.packageName && notification.actions.isNullOrEmpty())
            assertTrue("Event arrived while Activity backgrounded",scenario.state==androidx.lifecycle.Lifecycle.State.CREATED)
            val admitted=displayState()
            assertTrue("One durable receipt admitted",(displayStateType.getDeclaredMethod("getReceipts").invoke(admitted) as List<*>).size==1)
            val replayRead=NtfyEventRead()
            readPhase.set(replayRead)
            signal("event-replay")
            assertTrue("Actual replay callback reached bound admission",replayRead.returned.await(15,TimeUnit.SECONDS))
            // enabled() takes the same monitor as message(): this is a completion
            // barrier after arrival, not a sleep that could precede a late post.
            assertTrue("Replay callback completed with original consent",displayType.getDeclaredMethod("enabled",native("DisplayBinding")).invoke(display,binding)==true)
            assertTrue("Replay retains exact durable receipt state",displayState()==admitted)
            assertTrue("Replay cannot replace actual notification",ownedNotification()?.postTime==delivered.postTime)
          }
        }
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
        awaitUnlockedWorkspace(scenario,"Original workspace after actual event display")
        command("push_registration_disable")
        awaitDocument(scenario,"Explicit authenticated native pause","window.__lazyshNtfyControl===true")
        val pauseDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(12)
        while(state()!=null && System.nanoTime()<pauseDeadline)Thread.sleep(20)
        assertTrue("Authenticated relay cleanup must remove private enrollment",state()==null)
        assertTrue("Explicit pause removes only owned remote notification",ownedNotification()==null)
        val paused=displayState()
        assertTrue("Explicit pause durably retires display consent",displayStateType.getDeclaredMethod("getEnabled").invoke(paused)==false)
        signal("replay")
        signal("event-replay")
        assertTrue("Paused state cannot regain enrollment from the old encrypted message",state()==null)
        assertTrue("Paused replay cannot immediately restore owned notification",ownedNotification()==null)
        signal("complete")
        println("lazysh real ntfy native: nativeDialog=true unknownCaRejected=true sdkEncryptedChallengeConfirmed=true exactDeviceGeneration=true activityBackground=true authenticatedPause=true notificationDelivery=true immutableAppIntent=true replayCallbackObserved=true replayPostUnchanged=true pausedDisplayOff=true")
    }

    @Test fun pushRegistrationMatchesPackagedNativeProvider() {
        val scenario = NativeActivityFixture.scenario
        val google = try {
            Class.forName("app.lazysh.push.PushPlugin", false, InstrumentationRegistry.getInstrumentation().targetContext.classLoader)
            true
        } catch (_: ClassNotFoundException) { false }
        val unified = try {
            Class.forName("app.lazysh.unifiedpush.RegistrationService", false, InstrumentationRegistry.getInstrumentation().targetContext.classLoader)
            true
        } catch (_: ClassNotFoundException) { false }
        assertTrue("Every Android build must package its authenticated UnifiedPush transport", unified)
        awaitUnlockedWorkspace(scenario, "Push unlocked workspace")
        evaluate(scenario, """(() => {
          window.__lazyshPushProbe=undefined;
          (async()=>{
            const access=await window.__TAURI_INTERNALS__.invoke('app_lock_status',{});
            if(access.initialized!==true || access.locked!==false)throw new Error('Native access changed before push probe');
            const invoke=command=>window.__TAURI_INTERNALS__.invoke(command,{},
              {headers:access.nonce?{'X-Lazysh-Access':access.nonce}:{}});
            const status=await invoke('push_registration_status');
            if(status.provider==='none')throw new Error('Packaged provider missing');
            window.__lazyshPushProbe={ok:true,status};
          })().catch(()=>{window.__lazyshPushProbe={ok:false};});
          return true;
        })()""")
        awaitDocument(scenario, "Push IPC result", "window.__lazyshPushProbe!==undefined")
        assertEquals("Packaged native push status must match its actual plugin", "true", evaluate(scenario, """(() => {
          const result=window.__lazyshPushProbe, status=result.status;
          return result.ok===true && status?.provider==='unifiedpush' &&
            Array.isArray(status.availableProviders) && status.availableProviders.slice().sort().join(',')===${JSONObject.quote(if (google) "fcm,unifiedpush" else "unifiedpush")} &&
            status.supported===true && status.configured===false && status.enabled===false &&
              status.tokenPresent===false && status.busy===false && status.reason.includes('distributor') &&
              status.reason.includes('No delivery service');
        })()"""))
        println("lazysh native push: googlePlugin=$google unifiedPlugin=$unified protectedStatusVerified=true registrationOnly=true")
    }

    @Test fun cloudCommandsReachNativeValidationThroughTheBundledWebView() {
        val scenario = NativeActivityFixture.scenario
        awaitUnlockedWorkspace(scenario, "Cloud IPC bridge")
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

    /** Awaits one promise-returning script in the bundled WebView and returns its JSON reply as a String, JSONArray or number. */
    private fun voiceReply(scenario: ActivityScenario<MainActivity>, stage: String, call: String, seconds: Long = 120): Any {
        evaluate(scenario, """(() => {
          window.__lazyshVoiceResult = undefined;
          $call.then(
            value => { window.__lazyshVoiceResult = {ok:true,value:JSON.stringify(value === undefined ? null : value)}; },
            error => { window.__lazyshVoiceResult = {ok:false,error:String(error)}; }
          );
          return true;
        })()""")
        awaitDocument(scenario, stage, "window.__lazyshVoiceResult !== undefined", System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds))
        assertEquals("$stage was rejected", "\"\"", evaluate(scenario, "window.__lazyshVoiceResult.ok ? '' : window.__lazyshVoiceResult.error"))
        // evaluateJavascript returns a JSON string literal; its content is the reply's own JSON.
        return org.json.JSONTokener(JSONArray("[" + evaluate(scenario, "window.__lazyshVoiceResult.value") + "]").getString(0)).nextValue()
    }

    /** Runs a shell command as the shell user, like the SSH fixture read, and hands its output to `read`. */
    private fun <T> shellOutput(command: String, read: (java.io.InputStream) -> T): T =
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command).use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use(read)
        }

    /** The samples of a 16 kHz mono 16-bit PCM RIFF/WAVE file, scaled as the product's recorder sends them. */
    private fun pcmSamples(wav: ByteArray): FloatArray {
        val buffer = java.nio.ByteBuffer.wrap(wav).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        require(wav.size > 12 && String(wav, 0, 4, Charsets.US_ASCII) == "RIFF" && String(wav, 8, 4, Charsets.US_ASCII) == "WAVE") { "Sample is not a WAVE file" }
        var offset = 12
        var supported = false
        while (offset + 8 <= wav.size) {
            val length = buffer.getInt(offset + 4)
            require(length >= 0 && offset + 8 + length <= wav.size) { "Sample chunk exceeds its file" }
            when (String(wav, offset, 4, Charsets.US_ASCII)) {
                "fmt " -> supported = length >= 16 && buffer.getShort(offset + 8).toInt() == 1 && buffer.getShort(offset + 10).toInt() == 1 &&
                    buffer.getInt(offset + 12) == 16_000 && buffer.getShort(offset + 22).toInt() == 16
                "data" -> {
                    require(supported) { "Sample must be 16 kHz mono 16-bit PCM" }
                    return FloatArray(length / 2) { buffer.getShort(offset + 8 + it * 2) / 32768f }
                }
            }
            offset += 8 + length + (length and 1)
        }
        throw AssertionError("Sample has no data chunk")
    }

    /**
     * Local Whisper on the device (#1604): imports the pinned English model through the product's chunked IPC, transcribes the
     * public JFK sample with the bundled whisper.cpp, then removes the model. The owned acceptance run stages both files.
     */
    @Test fun ownedWhisperTranscribesAndRemovesModelThroughTheBundledWebView() {
        val directory = InstrumentationRegistry.getArguments().getString("lazyshVoiceFixtures")
        require(directory != null && Regex("/data/local/tmp/lazysh-voice-[a-f0-9]{32}").matches(directory)) {
            "An owned Whisper fixture directory is required"
        }
        val model = "ggml-tiny.en.bin"
        val name = JSONObject.quote(model)
        val scenario = NativeActivityFixture.scenario
        awaitUnlockedWorkspace(scenario, "Local Whisper IPC")
        evaluate(scenario, """(() => {
          const call = async (command, args) => {
            const access = await window.__TAURI_INTERNALS__.invoke('app_lock_status', {});
            return window.__TAURI_INTERNALS__.invoke(command, args, {headers: access.nonce ? {'X-Lazysh-Access':access.nonce} : {}});
          };
          // The panel sends each megabyte as a plain number array.
          window.__lazyshVoice = {call, chunk: (id, offset, base64) =>
            call('voice_import_chunk', {id, offset, bytes: Array.from(Uint8Array.from(atob(base64), c => c.charCodeAt(0)))})};
          return true;
        })()""")
        fun call(stage: String, command: String, args: String, seconds: Long = 120) =
            voiceReply(scenario, stage, "window.__lazyshVoice.call('$command', $args)", seconds)
        fun models() = call("Whisper model list", "voice_models", "{}") as JSONArray
        val size = shellOutput("stat -c %s $directory/$model") { String(it.readBytes(), Charsets.UTF_8).trim().toLong() }
        assertTrue("The staged model is the pinned tiny.en weights", size in 1024..(160L * 1024 * 1024))
        val samples = pcmSamples(shellOutput("cat $directory/jfk.wav") { it.readBytes() })
        assertEquals("The JFK sample is eleven seconds of speech", 11, samples.size / 16_000)
        assertEquals("A fresh emulator holds no Whisper model; remove it before this case", 0, models().length())
        var openImport: String? = null
        try {
            val id = call("Whisper import begin", "voice_import_begin", "{name:$name, bytes:$size}") as String
            openImport = id
            shellOutput("cat $directory/$model") { stream ->
                val buffer = ByteArray(1024 * 1024)
                var offset = 0L
                while (offset < size) {
                    var count = 0
                    while (count < buffer.size) {
                        val read = stream.read(buffer, count, buffer.size - count)
                        if (read < 0) break
                        count += read
                    }
                    require(count > 0) { "Staged model ended at $offset of $size bytes" }
                    voiceReply(scenario, "Whisper import chunk at $offset", "window.__lazyshVoice.chunk(${JSONObject.quote(id)}, $offset, " +
                        "${JSONObject.quote(Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP))})")
                    offset += count
                }
            }
            call("Whisper import finish", "voice_import_finish", "{id:${JSONObject.quote(id)}, cancel:false}")
            openImport = null
            val installed = models()
            assertEquals("Exactly the imported model is installed", 1, installed.length())
            assertEquals(model, installed.getJSONObject(0).getString("id"))
            assertEquals(size, installed.getJSONObject(0).getLong("bytes"))
            val transcript = call("Whisper transcription", "voice_transcribe",
                "{id:$name, language:'en', samples:[${samples.joinToString(",")}]}", 240) as String
            val spoken = transcript.lowercase().replace(Regex("[^a-z0-9]+"), " ").trim()
            assertTrue("Unexpected on-device transcription: $transcript", spoken.contains("ask not what your country can do for you"))
            call("Whisper model removal", "voice_remove_model", "{id:$name}")
            assertEquals("Removing the model frees its slot", 0, models().length())
            println("lazysh native voice: model=$model bytes=$size samples=${samples.size} transcript=${JSONObject.quote(transcript)} removed=true")
        } finally {
            // Leave the emulator as found, whichever stage failed; a cleanup rejection never replaces the first failure.
            runCatching { openImport?.let { call("Whisper import cancel", "voice_import_finish", "{id:${JSONObject.quote(it)}, cancel:true}") } }
            runCatching { call("Whisper model cleanup", "voice_remove_model", "{id:$name}") }
            runCatching { evaluate(scenario, "delete window.__lazyshVoice; delete window.__lazyshVoiceResult; true") }
        }
    }

    // `opened` is the selector a row that opens its own dialog, instead of a page, leaves shown.
    private fun preferencesCategory(scenario: ActivityScenario<MainActivity>, id: String, opened: String? = null) {
        val active = opened ?: ".settings-navigation [data-settings-page='$id']:not([hidden])"
        val target = ".settings-navigation button[data-settings-target='$id']"
        repeat(3) {
            if (evaluate(scenario, "Boolean(document.querySelector(${JSONObject.quote(active)}))") == "true") return
            // The grouped list can be taller than the phone; scroll a shown row into view as a reader would.
            evaluate(scenario, "(document.querySelector(${JSONObject.quote(target)})?.scrollIntoView({block:'center'}), true)")
            if (evaluate(scenario, workspaceElementVisible(target)) == "true") {
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, target)).perform(webScrollIntoView()).perform(webClick())
                awaitDocument(scenario, "selected preferences category", "Boolean(document.querySelector(${JSONObject.quote(active)}))")
                return
            }
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".settings-detail-header button")).perform(webScrollIntoView()).perform(webClick())
        }
        throw AssertionError("Preferences category was not reachable through its visible navigation")
    }

    @Test fun dpadViewportProjectionRejectsIncompleteOrInvalidGeometry() {
        val web=listOf(0,10,400,600);val root=listOf(0,0,400,800);val frame=listOf(0,10,400,610)
        fun row(ime:Boolean?=true,bottom:Int?=190,point:List<Int>?=web)=OwnedDpadViewportObservation.project("down-before",7,ime,bottom,point,root,frame)
        assertEquals("visible",row().getString("ime"));assertEquals("hidden",row(false,0).getString("ime"))
        for(value in listOf(row(null),row(bottom=null),row(bottom=-1),row(bottom=65536),row(point=listOf(0,0,0,1)),row(point=listOf(0,0,1)),row(point=listOf(Int.MAX_VALUE,0,1,1)))) {
            assertEquals("unavailable",value.getString("state"));assertFalse(value.has("imeBottom"));assertFalse(value.has("web"))
        }
        for(phase in listOf("private","down-before\n")) assertTrue(runCatching { OwnedDpadViewportObservation.project(phase,0,true,0,web,root,frame) }.isFailure)
        for(at in listOf(-1L,65536L)) assertTrue(runCatching { OwnedDpadViewportObservation.project("layout",at,true,0,web,root,frame) }.isFailure)
    }

    private class DpadRead(private val until: Long, private val post: (Runnable) -> Boolean,
        private val now: () -> Long = System::nanoTime) {
        fun value(dispatch: ((Result<String>) -> Unit) -> Unit): String {
            val active = java.util.concurrent.atomic.AtomicBoolean(true)
            val result = AtomicReference<Result<String>?>(null)
            val completed = CountDownLatch(1)
            fun receive(value: Result<String>) {
                if (active.get() && now() < until && result.compareAndSet(null, value)) completed.countDown()
            }
            try {
                check(now() < until) { "Owned D-pad read has no remaining budget" }
                check(post(Runnable {
                    if (!active.get() || now() >= until) return@Runnable
                    try { dispatch(::receive) } catch (error: Throwable) { receive(Result.failure(error)) }
                })) { "Owned D-pad read dispatch rejected" }
                check(completed.await((until-now()).coerceAtLeast(0), TimeUnit.NANOSECONDS) && now() < until) {
                    "Owned D-pad queue/callback exceeded its original read budget"
                }
                return checkNotNull(result.get()).getOrThrow()
            } finally { active.set(false) }
        }
    }

    @Test fun dpadReadBoundsQueuedMissingLateAndStaleCallbacks() {
        var clock = 0L
        fun immediate() = DpadRead(100, { it.run(); true }, { clock })
        assertEquals("owned", immediate().value { it(Result.success("owned")) })
        assertTrue(runCatching { immediate().value { clock=100;it(Result.success("late")) } }.isFailure)
        clock=0
        assertEquals("stale owner", runCatching { immediate().value { error("stale owner") } }.exceptionOrNull()?.message)
        assertTrue(runCatching { DpadRead(100, { false }, { clock }).value { error("must not run") } }.isFailure)
        var queued: Runnable? = null; var dispatched = false
        assertTrue(runCatching {
            DpadRead(System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(100), { queued=it;true })
                .value { dispatched=true }
        }.isFailure)
        checkNotNull(queued).run();assertFalse("Expired queued work must not run", dispatched)
        var callback: ((Result<String>) -> Unit)? = null
        assertTrue(runCatching {
            DpadRead(System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(100), { it.run();true })
                .value { callback=it }
        }.isFailure)
        checkNotNull(callback)(Result.success("late"))
    }

    private fun sendOwnedFinger(pointer: android.view.MotionEvent.PointerProperties, epoch: Long, action: Int, point: FloatArray) =
        sendOwnedFingers(listOf(pointer), epoch, action, listOf(point))

    /** One MotionEvent of a touch stream with these pointers (ids 0, 1, ...) at these screen points. */
    private fun sendOwnedFingers(pointers: List<android.view.MotionEvent.PointerProperties>, epoch: Long, action: Int, points: List<FloatArray>) {
        val coordinates = points.map { android.view.MotionEvent.PointerCoords().apply { x=it[0];y=it[1];pressure=1f;size=1f } }
        val event = android.view.MotionEvent.obtain(epoch,android.os.SystemClock.uptimeMillis(),action,pointers.size,
            pointers.toTypedArray(),coordinates.toTypedArray(),0,0,1f,1f,0,0,android.view.InputDevice.SOURCE_TOUCHSCREEN,0)
        try {
            assertEquals("Owned native pointer identities",pointers.indices.toList(),pointers.indices.map { event.getPointerId(it) })
            assertEquals("One owned native DOWN epoch",epoch,event.downTime)
            InstrumentationRegistry.getInstrumentation().sendPointerSync(event)
        } finally {event.recycle()}
    }

    /** The centre of the element a JavaScript expression returns, in screen pixels, and the WebView's pixels per CSS pixel. */
    private fun elementOnScreen(scenario: ActivityScenario<MainActivity>, element: String): Pair<FloatArray, Double> {
        val geometry = JSONArray(evaluate(scenario, "(()=>{const r=($element).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,innerWidth];})()"))
        val origin = IntArray(2); var scale = 0.0
        scenario.onActivity { activity ->
            val web = requireNotNull(webView(activity.window.decorView))
            web.getLocationOnScreen(origin); scale = web.width / geometry.getDouble(2)
        }
        return floatArrayOf((origin[0] + geometry.getDouble(0) * scale).toFloat(), (origin[1] + geometry.getDouble(1) * scale).toFloat()) to scale
    }

    /**
     * Two real fingers on the element, as one touch stream (DOWN, POINTER_DOWN, paced MOVEs, POINTER_UP, UP): finger 0 and 1 start at `from`
     * and end at `to`, in CSS pixels from the element's centre. A pinch changes their distance; a swipe moves both the same way.
     */
    private fun twoFingerGesture(scenario: ActivityScenario<MainActivity>, element: String, from: List<DoubleArray>, to: List<DoubleArray>) {
        val (centre, scale) = elementOnScreen(scenario, element)
        val fingers = (0..1).map { android.view.MotionEvent.PointerProperties().apply { id = it; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER } }
        val shift = android.view.MotionEvent.ACTION_POINTER_INDEX_SHIFT
        fun screen(progress: Double) = from.indices.map { finger ->
            floatArrayOf((centre[0] + (from[finger][0] + (to[finger][0] - from[finger][0]) * progress) * scale).toFloat(),
                (centre[1] + (from[finger][1] + (to[finger][1] - from[finger][1]) * progress) * scale).toFloat())
        }
        val epoch = android.os.SystemClock.uptimeMillis()
        var held = 0; var last = screen(0.0)
        fun send(action: Int, points: List<FloatArray>, count: Int = 2) { last = points; sendOwnedFingers(fingers.take(count), epoch, action, points.take(count)) }
        try {
            send(android.view.MotionEvent.ACTION_DOWN, screen(0.0), 1); held = 1
            send(android.view.MotionEvent.ACTION_POINTER_DOWN or (1 shl shift), screen(0.0)); held = 2
            for (step in 1..8) { Thread.sleep(16); send(android.view.MotionEvent.ACTION_MOVE, screen(step / 8.0)) }
            send(android.view.MotionEvent.ACTION_POINTER_UP or (1 shl shift), screen(1.0)); held = 1
            send(android.view.MotionEvent.ACTION_UP, screen(1.0), 1); held = 0
        } finally {
            // Never leave a touch stream open: the next real gesture would start inside it.
            if (held > 0) runCatching { send(android.view.MotionEvent.ACTION_CANCEL, last, held) }
        }
    }

    /** One real finger held on the element's centre: its DOM geometry mapped to the screen, DOWN, the hold, then UP. */
    private fun holdFinger(scenario: ActivityScenario<MainActivity>, selector: String, holdMillis: Long) {
        val point = elementOnScreen(scenario, "document.querySelector(${JSONObject.quote(selector)})").first
        val pointer = android.view.MotionEvent.PointerProperties().apply { id = 0; toolType = android.view.MotionEvent.TOOL_TYPE_FINGER }
        val epoch = android.os.SystemClock.uptimeMillis()
        sendOwnedFinger(pointer, epoch, android.view.MotionEvent.ACTION_DOWN, point)
        try { Thread.sleep(holdMillis) } finally { sendOwnedFinger(pointer, epoch, android.view.MotionEvent.ACTION_UP, point) }
    }

    private fun openOwnedInputPreferences(scenario: ActivityScenario<MainActivity>, raw: OwnedRawSshInput, sections: List<String>) {
        if (evaluate(scenario, "Boolean(document.querySelector('[role=dialog][aria-label=Preferences]'))") != "true") {
            if (evaluate(scenario,workspaceElementVisible("button[aria-label='Preferences']")) == "true") raw.clickIcon("Preferences")
            else workspaceMenuAction(scenario,"Preferences")
        }
        for (id in sections) preferencesCategory(scenario,id)
    }

    private fun verifyPastBottomKeyboardDismiss(scenario: ActivityScenario<MainActivity>, raw: OwnedRawSshInput) {
        println("lazysh overscroll keyboard: checkpoint=reached")
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val ime=android.provider.Settings.Secure.getString(context.contentResolver,android.provider.Settings.Secure.DEFAULT_INPUT_METHOD)
        require(ime!=null && ime.startsWith("com.android.inputmethod.latin/")) { "Ordinary admitted AOSP keyboard required" }
        val web=raw.originalWeb.get()
        val option="Hide keyboard when scrolling past local history bottom"
        val checkboxState = """
            (()=>{const inputs=Array.from(document.querySelectorAll('[role=dialog] label'))
              .filter(x=>x.textContent.trim()==='Hide keyboard when scrolling past local history bottom')
              .flatMap(x=>Array.from(x.querySelectorAll('input[type=checkbox]')));
              return inputs.length===1&&typeof inputs[0].checked==='boolean'?inputs[0].checked:null;})()
        """.trimIndent()
        val receiptSource = """
            // Monotonic upward motion is read in screen coordinates: clientY shifts with the visual viewport (keyboard insets), screenY is the contact itself.
            function ownedPastBottomTouchReceipt(owner) {
              const root=owner.ownerDocument,area=owner.querySelector('.xterm-helper-textarea');
              let starts=0,moves=0,ends=0,cancels=0,unavailable=!area,overflow=false;
              let trusted=true,sameContact=true,insideOwner=true,monotonicUp=true,distance48=false,id=null,startY=0,lastScreenY=0,lastClientY=0,screenBack=-Infinity,clientBack=-Infinity,trace=[];
              const record=(kind,event)=>{try{
                trusted=trusted&&event.isTrusted===true;
                insideOwner=insideOwner&&event.currentTarget===owner&&event.composedPath().includes(owner);
                if(kind==='touchcancel'){cancels++;overflow=overflow||cancels>8;return;}
                const touches=Array.from(kind==='touchend'?event.changedTouches:event.touches),touch=touches[0];
                sameContact=sameContact&&touches.length===1&&(kind!=='touchend'||event.touches.length===0);
                if(!touch||!Number.isInteger(touch.identifier)||!Number.isFinite(touch.clientY)){unavailable=true;return;}
                if(trace.length<8)trace.push([kind.slice(5),touch.screenY,touch.clientY,Math.round(event.timeStamp)]);
                if(kind==='touchstart'){starts++;id=touch.identifier;startY=touch.clientY;lastScreenY=touch.screenY;lastClientY=startY;}
                else {
                  sameContact=sameContact&&touch.identifier===id&&starts===1;
                  screenBack=Math.max(screenBack,touch.screenY-lastScreenY);clientBack=Math.max(clientBack,touch.clientY-lastClientY);monotonicUp=monotonicUp&&touch.screenY<=lastScreenY;lastScreenY=touch.screenY;lastClientY=touch.clientY;
                  if(kind==='touchmove'){moves++;distance48=distance48||startY-touch.clientY>=48;}else ends++;
                }
                overflow=overflow||starts>8||moves>8||ends>8||cancels>8;
              }catch(_){unavailable=true;}};
              const hooks=['touchstart','touchmove','touchend','touchcancel'].map(kind=>[kind,event=>record(kind,event)]);
              for(const [kind,handler] of hooks)owner.addEventListener(kind,handler,{capture:true,passive:true});
              return {read:()=>({available:!unavailable,retained:owner.isConnected&&owner.ownerDocument===root&&root===document&&document.querySelector('.terminal-canvas')===owner,
                starts:Math.min(starts,8),moves:Math.min(moves,8),ends:Math.min(ends,8),cancels:Math.min(cancels,8),overflow,trusted,sameContact,insideOwner,monotonicUp,distance48,screenBack:Number.isFinite(screenBack)?screenBack:null,clientBack:Number.isFinite(clientBack)?clientBack:null,trace,
                focused:!!area&&document.activeElement===area&&!area.readOnly}),
                dispose:()=>{for(const [kind,handler] of hooks)owner.removeEventListener(kind,handler,true);}};
            }
        """.trimIndent()
        val geometryExpression = """
            (()=>{const screen=document.querySelector('.terminal-canvas .xterm-screen');if(!screen)return null;
              const r=screen.getBoundingClientRect(),v=window.visualViewport||{offsetLeft:0,offsetTop:0,width:window.innerWidth,height:window.innerHeight,scale:1};
              const values=[r.left,r.top,r.right,r.bottom,v.offsetLeft,v.offsetTop,v.width,v.height,v.scale,window.innerWidth,window.innerHeight];
              if(!values.every(Number.isFinite)||v.scale!==1||v.width<=0||v.height<=0||window.innerWidth<=0||window.innerHeight<=0)return null;
              const left=Math.max(0,r.left,v.offsetLeft),right=Math.min(window.innerWidth,r.right,v.offsetLeft+v.width);
              const top=Math.max(0,r.top,v.offsetTop),bottom=Math.min(window.innerHeight,r.bottom,v.offsetTop+v.height);
              const start=bottom-12,end=start-56;
              return right-left>=24&&end>=top+12?[(left+right)/2,start,end,window.innerWidth]:null;})()
        """.trimIndent()
        fun finishCleanup(primary: Throwable?, actions: List<()->Unit>) {
            var cleanup: Throwable?=null
            for(action in actions)try{action()}catch(error:Throwable){if(cleanup==null)cleanup=error else if(cleanup!==error)cleanup!!.addSuppressed(error)}
            if(cleanup!=null){if(primary==null)throw cleanup!! else if(primary!==cleanup)primary.addSuppressed(cleanup!!)}
        }
        var changed=false
        fun preference(value: Boolean?) {
            openOwnedInputPreferences(scenario,raw,listOf("input","preferencesTerminalTouchGestures"))
            val before=evaluate(scenario,checkboxState)
            require(before=="true"||before=="false") { "Owned overscroll preference must be a single boolean" }
            if(value==null)assertEquals("Overscroll dismissal must start disabled","false",before)
            else if(before!=value.toString()) {
                changed=true
                onWebView().withElement(findElement(Locator.XPATH,"//*[@role='dialog']//label[normalize-space(.)='$option']/input[@type='checkbox']"))
                    .perform(webScrollIntoView()).perform(webClick())
                awaitDocument(scenario,"explicit overscroll preference updated","($checkboxState)===${value}")
            }
            raw.clickIcon("Close Preferences")
            awaitDocument(scenario,"overscroll preference dialog closed","!document.querySelector('[role=dialog][aria-label=Preferences]')")
        }
        fun keyboard(visible: Boolean) {
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            while(true) {
                assertEquals("Original Activity remains resumed",androidx.lifecycle.Lifecycle.State.RESUMED,scenario.state)
                raw.original()
                var matched=false
                scenario.onActivity {activity->
                    val decor=activity.window.decorView
                    val insets=ViewCompat.getRootWindowInsets(decor)
                    val shown=insets?.isVisible(WindowInsetsCompat.Type.ime())
                    val bottom=insets?.getInsets(WindowInsetsCompat.Type.ime())?.bottom
                    val position=IntArray(2);web.getLocationInWindow(position)
                    matched=if(visible)shown==true&&bottom!=null&&bottom>0&&position[1]+web.height<=decor.height-bottom
                        else shown==false&&bottom==0
                }
                if(matched)return
                assertTrue("Ordinary AOSP keyboard visible=$visible must reach real native insets within original five seconds",System.nanoTime()<deadline)
                Thread.sleep(50)
            }
        }
        fun showKeyboard() {
            val initial=JSONArray(evaluate(scenario,geometryExpression))
            val position=IntArray(2);var scale=0.0
            instrumentation.runOnMainSync {web.getLocationOnScreen(position);scale=web.width/initial.getDouble(3)}
            val point=floatArrayOf((position[0]+initial.getDouble(0)*scale).toFloat(),(position[1]+initial.getDouble(1)*scale).toFloat())
            onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE,{point},Press.FINGER))
            awaitDocument(scenario,"real terminal editor owns normal empty focus before ordinary keyboard","""
                (()=>{const fields=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea'),area=fields[0];
                  return fields.length===1&&document.activeElement===area&&!area.readOnly&&!area.disabled&&area.value==='';})()
            """)
            scenario.onActivity {activity->activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                .showSoftInput(web,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)}
            keyboard(true)
        }
        fun stroke(focusedAfter: Boolean) {
            keyboard(true)
            val geometry=JSONArray(evaluate(scenario,geometryExpression))
            require(geometry.length()==4 && geometry.getDouble(1)-geometry.getDouble(2)>=48) { "Owned past-bottom stroke requires visible 48 CSS pixels" }
            val position=IntArray(2);var scale=0.0
            instrumentation.runOnMainSync {web.getLocationOnScreen(position);scale=web.width/geometry.getDouble(3)}
            val x=(position[0]+geometry.getDouble(0)*scale).toFloat()
            val start=(position[1]+geometry.getDouble(1)*scale).toFloat()
            val end=(position[1]+geometry.getDouble(2)*scale).toFloat()
            val epoch=android.os.SystemClock.uptimeMillis()
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            val pointer=android.view.MotionEvent.PointerProperties().apply {id=0;toolType=android.view.MotionEvent.TOOL_TYPE_FINGER}
            var observer:OwnedFingerWindowObserver?=null
            var viewportObserver:OwnedDpadViewportObservation?=null
            var held=false
            var point=floatArrayOf(x,start)
            var primary:Throwable?=null
            val key=JSONObject.quote("__ownedPastBottom_${raw.nonce}_${UUID.randomUUID().toString().replace("-", "")}")
            val token=JSONObject.quote(UUID.randomUUID().toString())
            var receiptAttempted=false
            fun remaining(): Long {
                val value=TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime())
                assertTrue("Actual touch receipt requires original five-second stroke budget",value>0)
                return value.coerceAtMost(1000)
            }
            fun received(expectedMoves: Int, ended: Boolean) {
                while(true) {
                    val sample=JSONObject(evaluate(scenario,"(()=>{const owned=window[$key];return owned?.token===$token?owned.read():null;})()",remaining()))
                    assertTrue("Original trusted contact must reach the actual scroll owner: receipt=$sample",sample.getBoolean("available")&&sample.getBoolean("retained")&&sample.getBoolean("trusted")&&sample.getBoolean("sameContact")&&sample.getBoolean("insideOwner")&&sample.getBoolean("monotonicUp")&&!sample.getBoolean("overflow"))
                    assertEquals("No cancel may qualify an upward stroke",0,sample.getInt("cancels"))
                    assertTrue("Touch counts remain one start/two moves/one end",sample.getInt("starts")<=1&&sample.getInt("moves")<=2&&sample.getInt("ends")<=1)
                    if(sample.getInt("starts")==1&&sample.getInt("moves")==expectedMoves&&sample.getInt("ends")== (if(ended)1 else 0)) {
                        if(ended) {
                            assertTrue("Actual DOM stroke reaches at least 48 CSS pixels upward",sample.getBoolean("distance48"))
                            assertEquals("Keyboard outcome belongs to the actual editor focus transition",focusedAfter,sample.getBoolean("focused"))
                        }
                        return
                    }
                    Thread.sleep(10)
                }
            }
            try {
                receiptAttempted=true
                assertEquals("Passive original-scroll-owner touch receipt installed","true",evaluate(scenario,"""
                    (()=>{$receiptSource
                      if(Object.prototype.hasOwnProperty.call(window,$key))return false;
                      const owners=document.querySelectorAll('.terminal-canvas');if(owners.length!==1)return false;
                      const owner=owners[0],receipt=ownedPastBottomTouchReceipt(owner);
                      Object.defineProperty(window,$key,{value:{token:$token,read:receipt.read,dispose:receipt.dispose},configurable:true});return true;})()
                """,remaining()))
                scenario.onActivity {activity->
                    assertSame("Original keyboard-checkpoint WebView",web,webView(activity.window.decorView))
                    val target=activity.window
                    val own=OwnedFingerWindowObserver(checkNotNull(target.callback),epoch)
                    target.callback=own;observer=own
                    viewportObserver=OwnedDpadViewportObservation(target,web,epoch).also { it.install() }
                }
                fun dispatch(action:Int,y:Float) {
                    assertTrue("Past-bottom pointer stays within original five-second gesture budget",System.nanoTime()<deadline)
                    point=floatArrayOf(x,y);sendOwnedFinger(pointer,epoch,action,point)
                }
                held=true;dispatch(android.view.MotionEvent.ACTION_DOWN,start);received(0,false)
                dispatch(android.view.MotionEvent.ACTION_MOVE,start+(end-start)/2);received(1,false)
                // Android extrapolates closely spaced MOVE samples past the fixed UP endpoint.
                android.os.SystemClock.sleep(25)
                dispatch(android.view.MotionEvent.ACTION_MOVE,end);received(2,false)
                dispatch(android.view.MotionEvent.ACTION_UP,end);held=false;received(2,true)
                val sample=JSONObject(checkNotNull(observer).snapshot())
                assertFalse("Past-bottom native trace remains bounded",sample.getBoolean("overflow"))
                val events=sample.getJSONArray("events")
                assertEquals("One real upward stroke has four native events",4,events.length())
                val actions=listOf("down","move","move","up")
                for(index in 0..3) {
                    val row=events.getJSONObject(index)
                    assertEquals("One DOWN/two monotonic MOVE/one UP",actions[index],row.getString("action"))
                    assertTrue("Original trusted touch pointer/source",row.getBoolean("pointerMatches")&&row.getBoolean("finger")&&row.getBoolean("touchscreen"))
                    assertEquals("Actual WebView handled native touch","handled",row.getString("outcome"))
                }
            }catch(failure:Throwable){
                primary=failure
                runCatching { failure.addSuppressed(AssertionError("Past-bottom native input[${observer?.verticalFailureSummary() ?: "unavailable"}]")) }
                runCatching { failure.addSuppressed(AssertionError("Past-bottom native viewport[${viewportObserver?.failureSummary() ?: "unavailable"}]")) }
                throw failure
            }
            finally {
                finishCleanup(primary,listOf<()->Unit>(
                    {if(held)sendOwnedFinger(pointer,epoch,android.view.MotionEvent.ACTION_CANCEL,point)},
                    {scenario.onActivity {viewportObserver?.close()}},
                    {scenario.onActivity {activity->observer?.restore(activity.window)}},
                    {if(receiptAttempted)assertEquals("Passive touch receipt removed only by its owner","true",evaluate(scenario,
                        "(()=>{const own=window[$key];if(own?.token!==$token)return false;own.dispose();delete window[$key];return !Object.prototype.hasOwnProperty.call(window,$key);})()",1000))}
                ))
            }
        }
        var primary:Throwable?=null
        try {
            preference(null)
            showKeyboard();stroke(true);keyboard(true)
            println("lazysh overscroll keyboard: defaultOffVisible=true")
            preference(true)
            // Preferences itself changes focus: reopen and positively read fresh ordinary IME visibility.
            showKeyboard();stroke(false);keyboard(false)
            raw.original()
            assertEquals("Ordinary keyboard selection unchanged",ime,android.provider.Settings.Secure.getString(context.contentResolver,android.provider.Settings.Secure.DEFAULT_INPUT_METHOD))
            println("lazysh overscroll keyboard: nativeVerified=true hostByteOracle=pending")
        }catch(failure:Throwable){primary=failure;throw failure}
        finally {
            finishCleanup(primary,listOf<()->Unit>(
                {if(changed)preference(false)},
                {if(evaluate(scenario,"Boolean(document.querySelector('[role=dialog][aria-label=Preferences]'))")=="true")raw.clickIcon("Close Preferences")}
            ))
        }
    }

    /**
     * SystemUI shows a preview of a copied clip over the bottom-left of the screen for about six seconds, which is
     * where the first toolbar chord sits; a native tap meanwhile lands on the preview (opening its editor) instead
     * of the toolbar. The preview's window has no stable name to wait on, so wait out its timeout with margin.
     */
    private fun awaitClipboardPreviewGone(clipSetAt: Long) {
        val remaining = TimeUnit.SECONDS.toMillis(8) - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - clipSetAt)
        if (remaining > 0) Thread.sleep(remaining)
    }

    /** Native taps send one key from the keys page and one saved chord from the snippets page, which the page indicator selects without a swipe. */
    private fun verifyToolbarPages(scenario: ActivityScenario<MainActivity>, prompt: String, nonce: String) {
        val marker = "# PAGES_${nonce}_"
        /** The center of the one matching visible control, in WebView CSS pixels, after a hit test. */
        fun cssCenter(selector: String, text: String?) = JSONArray(evaluate(scenario, """
            (()=>{const matches=Array.from(document.querySelectorAll(${JSONObject.quote(selector)})).filter(x=>${if (text == null) "true" else "x.textContent.trim()===${JSONObject.quote(text)}"});
              if(matches.length!==1||matches[0].disabled)throw Error('Owned enabled toolbar control required');
              const rect=matches[0].getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
              if(document.elementFromPoint(x,y)?.closest(${JSONObject.quote(selector)})!==matches[0])throw Error('Owned toolbar hit target required');
              return [x,y,rect.width,innerWidth];})()
        """))
        fun screen(view: View, css: JSONArray, dx: Double = 0.0): FloatArray {
            val location = IntArray(2); view.getLocationOnScreen(location)
            val scale = view.width / css.getDouble(3)
            val x = (css.getDouble(0) + dx) * scale; val y = css.getDouble(1) * scale
            require(x > 0 && x < view.width && y > 0 && y < view.height) { "Owned gesture outside WebView" }
            return floatArrayOf((location[0] + x).toFloat(), (location[1] + y).toFloat())
        }
        fun tap(selector: String, text: String? = null) {
            closeSoftKeyboard()
            if (text != null) onWebView().withElement(findElement(Locator.XPATH,
                "//*[contains(concat(' ',normalize-space(@class),' '),' terminal-keys ')]//button[normalize-space(.)='$text']")).perform(webScrollIntoView())
            val css = cssCenter(selector, text)
            onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE, { view -> screen(view, css) }, Press.FINGER))
        }
        val focused = "document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea')"
        val store = "lazysh.preferences.v1"
        val snippetsTab = ".terminal-keys-pager button[aria-label='Snippets page']"
        val keysTab = ".terminal-keys-pager button[aria-label='Keys page']"
        evaluate(scenario, """
            (()=>{const key=${JSONObject.quote(store)},original=localStorage.getItem(key),value=JSON.parse(original||'{"version":1}');
              window.__lazyshOwnedToolbarPages={original};
              localStorage.setItem(key,JSON.stringify({...value,chords:[{label:'Page mark',keys:${JSONObject.quote("text:$marker")}}]}));
              window.dispatchEvent(new StorageEvent('storage',{key}));return true;})()
        """)
        try {
            awaitDocument(scenario, "owned toolbar is a key grid with a page indicator whose Snippets page holds the saved chord",
                "document.querySelectorAll('.terminal-keys .terminal-keys-row').length>=1 && !!document.querySelector(${JSONObject.quote(snippetsTab)})")
            assertEquals("Terminal keeps input focus before the Snippets page opens", "true", evaluate(scenario, focused))
            // The page indicator is a few CSS pixels tall, so the page is selected through its own click handler; the chord is then a native tap.
            evaluate(scenario, "document.querySelector(${JSONObject.quote(snippetsTab)}).click()")
            awaitDocument(scenario, "the Snippets page is selected and scrolled into view",
                "document.querySelector(${JSONObject.quote(snippetsTab)}).getAttribute('aria-current')==='true' && Math.abs(document.querySelector('.terminal-keys-page[data-toolbar-page=snippets]').getBoundingClientRect().left-document.querySelector('.terminal-keys-pages').getBoundingClientRect().left)<2")
            assertEquals("Opening the Snippets page leaves terminal input focus in place", "true", evaluate(scenario, focused))
            tap(".terminal-keys-page[data-toolbar-page=snippets] button", "Page mark")
            awaitDocument(scenario, "snippets-page chord typed its literal text",
                "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>x.textContent.includes(${JSONObject.quote(marker)}))")
            evaluate(scenario, "document.querySelector(${JSONObject.quote(keysTab)}).click()")
            awaitDocument(scenario, "the Keys page is selected and scrolled back into view",
                "document.querySelector(${JSONObject.quote(keysTab)}).getAttribute('aria-current')==='true' && Math.abs(document.querySelector('.terminal-keys-page[data-toolbar-page=keys]').getBoundingClientRect().left-document.querySelector('.terminal-keys-pages').getBoundingClientRect().left)<2")
            closeSoftKeyboard()
            tap(".terminal-keys .terminal-keys-row button", "c")
            onView(isAssignableFrom(WebView::class.java)).perform(pressKey(KeyEvent.KEYCODE_ENTER))
            val line = JSONObject.quote("${marker}c")
            awaitDocument(scenario, "keys from the grid and the Snippets page reached the remote shell in order",
                "Array.from(document.querySelectorAll('.terminal-canvas .xterm-screen')).some(x=>{const i=x.textContent.lastIndexOf($line);return i>=0&&x.textContent.lastIndexOf(${JSONObject.quote(prompt)})>i;})")
            closeSoftKeyboard()
        } finally {
            evaluate(scenario, """
                (()=>{const key=${JSONObject.quote(store)},original=window.__lazyshOwnedToolbarPages?.original;
                  if(original===undefined)return false;
                  if(original===null)localStorage.removeItem(key);else localStorage.setItem(key,original);
                  delete window.__lazyshOwnedToolbarPages;
                  window.dispatchEvent(new StorageEvent('storage',{key}));return true;})()
            """)
        }
    }

    private fun verifySshDpadPan(scenario: ActivityScenario<MainActivity>, fixture: JSONObject, label: String) {
        val raw = OwnedRawSshInput(scenario, fixture, label, "dpad")
        val nonce = raw.nonce
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        raw.start()
        var added = false
        fun preferences(action: String) {
            openOwnedInputPreferences(scenario,raw,listOf("input","preferencesToolbarKeysAndOrder"))
            val selector = if (action == "Add") "//*[@role='dialog']//button[normalize-space(.)='Add dpad']" else "//*[@role='dialog']//button[@aria-label='Remove dpad']"
            if (action == "Add") {
                awaitDocument(scenario,"known original toolbar has no D-pad","!document.querySelector('[role=dialog] button[aria-label=\"Remove dpad\"]')")
                added = true
            }
            onWebView().withElement(findElement(Locator.XPATH, selector)).perform(webScrollIntoView()).perform(webClick())
            // The exact D-pad receiver bytes exclude the composer's separate Enter: the receiver text goes through Insert, which never presses it.
            preferencesCategory(scenario, "input")
            raw.clickIcon("Close Preferences")
            awaitDocument(scenario, "owned D-pad preference dialog closed", "!document.querySelector('[role=dialog][aria-label=Preferences]')")
        }
        val countExpression = """
            (()=>{const pads=document.querySelectorAll('.terminal-dpad');
              if(pads.length!==1||pads[0].querySelectorAll('button[data-dpad-direction]').length!==4)return null;
              const text=document.querySelector('.terminal-canvas .xterm-screen')?.textContent||'';
              const rows=Array.from(text.matchAll(/D_${nonce}_([0-9]{1,2})_([0-9]{1,2})_([0-9]{1,2})_([0-9]{1,2})/g));
              if(!rows.length)return null;const counts=rows[rows.length-1].slice(1).map(Number);
              return counts.every(x=>Number.isInteger(x)&&x>=0&&x<=32)?counts:null;})()
        """.trimIndent()
        var primary: Throwable? = null
        try {
            preferences("Add")
            onWebView().withElement(findElement(Locator.XPATH, "//div[contains(@class,'terminal-keys')]//button[normalize-space(.)='dpad']")).perform(webScrollIntoView()).perform(webClick())
            val up = ".terminal-dpad button[aria-label='D-pad up']"
            awaitDocument(scenario, "owned expanded D-pad ready", "document.querySelectorAll(${JSONObject.quote(up)}).length===1")
            assertEquals("D-pad directions are momentary controls", "true", evaluate(scenario,
                "Array.from(document.querySelectorAll('.terminal-dpad button[data-dpad-direction]')).every(x=>!x.hasAttribute('aria-pressed'))"))
            // One actual tap must send once before the separate held-pointer epoch.
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, up)).perform(webScrollIntoView())
            val bounds = JSONArray(evaluate(scenario, """
                (()=>{const r=document.querySelector(${JSONObject.quote(up)}).getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,innerWidth];})()
            """))
            val web = raw.originalWeb.get()
            val origin = IntArray(2)
            var scale = 0.0
            instrumentation.runOnMainSync { web.getLocationOnScreen(origin); scale = web.width / bounds.getDouble(2) }
            val tapStart = floatArrayOf((origin[0]+bounds.getDouble(0)*scale).toFloat(), (origin[1]+bounds.getDouble(1)*scale).toFloat())
            onView(isAssignableFrom(WebView::class.java)).perform(GeneralClickAction(Tap.SINGLE,
                { tapStart }, Press.FINGER))
            awaitDocument(scenario, "one native D-pad tap delivered once", "JSON.stringify($countExpression)==='[1,0,0,0]'")
            raw.original()
            val epoch = android.os.SystemClock.uptimeMillis()
            val deadline = System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            val pointer = android.view.MotionEvent.PointerProperties().apply { id=0;toolType=android.view.MotionEvent.TOOL_TYPE_FINGER }
            fun remaining(): Long {
                val value=TimeUnit.NANOSECONDS.toMillis(deadline-System.nanoTime())
                assertTrue("Owned D-pad gesture exceeded original five-second budget", value>0)
                return value.coerceAtMost(1000)
            }
            // The tap can open the keyboard and move the pad. Never reuse its old screen point.
            val heldBoundsExpression = """
                (()=>{const buttons=document.querySelectorAll('.terminal-dpad button[aria-label="D-pad up"]');
                  if(buttons.length!==1)return null;const button=buttons[0],r=button.getBoundingClientRect();
                  const values=[r.left,r.top,r.right,r.bottom,innerWidth,innerHeight];
                  if(!values.every(Number.isFinite)||!button.getClientRects().length||r.width<=0||r.height<=0||
                    r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)return null;
                  const hit=document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2);
                  return hit&&button.contains(hit)?values:null;})()
            """.trimIndent()
            val heldBounds = JSONArray(evaluate(scenario,heldBoundsExpression,remaining()))
            val start = FloatArray(2)
            val readActivity = AtomicReference<MainActivity>()
            val readWindow = AtomicReference<android.view.Window>()
            val readUrl = AtomicReference<String>()
            scenario.onActivity { activity ->
                assertSame("Current D-pad WebView must remain original",web,webView(activity.window.decorView))
                assertTrue("Current D-pad WebView must be focused and laid out",web.isAttachedToWindow && web.isShown &&
                    web.hasFocus() && web.hasWindowFocus() && !web.isLayoutRequested && web.width>0 && web.height>0)
                web.getLocationOnScreen(origin);scale=web.width/heldBounds.getDouble(4)
                assertTrue("Current D-pad scale must be finite and positive",scale.isFinite() && scale>0)
                val target=android.graphics.RectF((origin[0]+heldBounds.getDouble(0)*scale).toFloat(),
                    (origin[1]+heldBounds.getDouble(1)*scale).toFloat(),(origin[0]+heldBounds.getDouble(2)*scale).toFloat(),
                    (origin[1]+heldBounds.getDouble(3)*scale).toFloat())
                val visible=android.graphics.Rect();val window=android.graphics.Rect()
                assertTrue("Current D-pad WebView must have visible app bounds",web.getLocalVisibleRect(visible))
                visible.offset(origin[0],origin[1])
                web.getWindowVisibleDisplayFrame(window)
                assertTrue("Current D-pad target must remain inside visible app bounds",target.left>=visible.left && target.top>=visible.top &&
                    target.right<=visible.right && target.bottom<=visible.bottom && target.left>=window.left && target.top>=window.top &&
                    target.right<=window.right && target.bottom<=window.bottom)
                // Target, local-visible translation, window frame and keyboard top all use device-screen coordinates.
                val root=activity.window.decorView;assertSame("D-pad decor must be the measured WebView root",root,web.rootView)
                val rootOrigin=IntArray(2);root.getLocationOnScreen(rootOrigin)
                val insets=checkNotNull(ViewCompat.getRootWindowInsets(root))
                val imeVisible=insets.isVisible(WindowInsetsCompat.Type.ime());val imeBottom=insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                assertTrue("Owned D-pad target must stay above the current keyboard",!imeVisible ||
                    (imeBottom>0 && target.bottom<=rootOrigin[1]+root.height-imeBottom))
                start[0]=target.centerX();start[1]=target.centerY()
                readActivity.set(activity);readWindow.set(activity.window);readUrl.set(raw.originalDocumentUrl())
            }
            remaining()
            var point = start
            var held = false
            var observer: OwnedFingerWindowObserver? = null
            var viewportObserver: OwnedDpadViewportObservation? = null
            var fingerFailure: Throwable? = null
            var currentPhase = "up"
            var lastCounts: IntArray? = null
            val dom=OwnedDpadDomObservation(nonce) { expression,timeout -> evaluate(scenario,expression,timeout) }
            val readOwner = UUID.randomUUID().toString()
            val bindingExpression = """
                (()=>{const key='__lazyshDpadRead_${nonce}';if(Object.hasOwn(window,key))return false;
                  const pads=document.querySelectorAll('.terminal-dpad'),screen=document.querySelector('.terminal-canvas .xterm-screen');
                  if(pads.length!==1||pads[0].querySelectorAll('button[data-dpad-direction]').length!==4||!screen)return false;
                  window[key]={owner:'${readOwner}',document,pad:pads[0],screen};return true;})()
            """.trimIndent()
            val guardExpression = """
                (()=>{const owned=window['__lazyshDpadRead_${nonce}'],pads=document.querySelectorAll('.terminal-dpad');
                  return owned?.owner==='${readOwner}'&&owned.document===document&&pads.length===1&&owned.pad===pads[0]&&
                    owned.pad.isConnected&&owned.screen===document.querySelector('.terminal-canvas .xterm-screen')&&owned.screen.isConnected;})()
            """.trimIndent()
            fun heldRead(expression: String, until: Long = minOf(deadline,System.nanoTime()+TimeUnit.MILLISECONDS.toNanos(remaining())), bound: Boolean = true): String {
                fun owner() {
                    val activity=readActivity.get()
                    check(!activity.isFinishing&&!activity.isDestroyed&&activity.window===readWindow.get()&&
                        webView(activity.window.decorView)===web&&web.rootView===activity.window.decorView&&
                        web.isAttachedToWindow&&web.isShown&&web.hasFocus()&&web.hasWindowFocus()&&web.url==readUrl.get()) {
                        "Owned D-pad read lost its original native owner"
                    }
                }
                return DpadRead(until,{ web.post(it) }).value { receive ->
                    owner()
                    val source=if(bound) "(()=>{if(!($guardExpression))return null;return ($expression);})()" else expression
                    web.evaluateJavascript(source) { value -> receive(runCatching { owner();value }) }
                }
            }
            var bindingAttempted = false
            fun dispatch(action: Int, dx: Int = 0, dy: Int = 0) {
                if (action!=android.view.MotionEvent.ACTION_CANCEL) remaining()
                point=floatArrayOf(start[0]+(dx*scale).toFloat(),start[1]+(dy*scale).toFloat())
                val coordinate=android.view.MotionEvent.PointerCoords().apply {x=point[0];y=point[1];pressure=1f;size=1f}
                val event=android.view.MotionEvent.obtain(epoch,android.os.SystemClock.uptimeMillis(),action,1,
                    arrayOf(pointer),arrayOf(coordinate),0,0,1f,1f,0,0,android.view.InputDevice.SOURCE_TOUCHSCREEN,0)
                try {
                    assertEquals("One owned D-pad pointer",0,event.getPointerId(0));assertEquals("One owned D-pad DOWN epoch",epoch,event.downTime)
                    instrumentation.sendPointerSync(event)
                } finally {event.recycle()}
            }
            fun counts(): IntArray {
                val rows=JSONArray(heldRead(countExpression))
                require(rows.length()==4) { "Owned D-pad count observation invalid" }
                return IntArray(4) { rows.getInt(it).also { value->require(value in 0..32) } }
                    .also { lastCounts=it.copyOf() }
            }
            fun phase(index: Int) {
                while (true) {
                    val values=counts()
                    if(values[index]>=(if(index==0)3 else 2) && (index+1..3).all {values[it]==0})return
                    Thread.sleep(10)
                }
            }
            fun pause() { assertTrue("Owned D-pad pause requires original budget",remaining()>=240);Thread.sleep(240);remaining() }
            var stopped = IntArray(0)
            try {
                bindingAttempted=true
                assertEquals("Original D-pad read binding required","true",heldRead(bindingExpression,bound=false))
                dom.install(remaining())
                scenario.onActivity { activity ->
                    assertSame("Original D-pad WebView before DOWN",web,webView(activity.window.decorView))
                    val target=activity.window
                    val owned=OwnedFingerWindowObserver(checkNotNull(target.callback),epoch)
                    target.callback=owned;observer=owned
                    viewportObserver=OwnedDpadViewportObservation(target,web,epoch)
                    viewportObserver?.install()
                }
                held=true;dispatch(android.view.MotionEvent.ACTION_DOWN);phase(0)
                for ((index,offset) in listOf(-24 to 0,0 to 24,24 to 0).withIndex()) {
                    currentPhase=listOf("left","down","right")[index]
                    dispatch(android.view.MotionEvent.ACTION_MOVE,offset.first,offset.second);phase(index+1)
                }
                currentPhase="neutral"
                dispatch(android.view.MotionEvent.ACTION_MOVE)
                while(heldRead("(()=>{const buttons=document.querySelectorAll('.terminal-dpad button[data-dpad-direction]');return buttons.length===4&&Array.from(buttons).every(x=>!x.style.outline);})()")!="true")Thread.sleep(10)
                pause();stopped=counts();pause();assertArrayEquals("Dead-zone output must stop",stopped,counts())
                val before=JSONObject(checkNotNull(observer).snapshot()).getJSONArray("events")
                assertEquals("Held D-pad has exactly DOWN plus four MOVE events",5,before.length())
                assertTrue("No UP before all ordered receiver phases",(0 until before.length()).none {before.getJSONObject(it).getString("action")=="up"})
                currentPhase="release"
                dispatch(android.view.MotionEvent.ACTION_UP);held=false
                currentPhase="post-release"
                pause();assertArrayEquals("Final UP must not repeat or click the original arrow",stopped,counts())
                currentPhase="trace"
                val trace=JSONObject(checkNotNull(observer).snapshot())
                assertFalse("Native pointer trace remains bounded",trace.getBoolean("overflow"))
                val events=trace.getJSONArray("events")
                assertEquals("One held native gesture has exactly six events",6,events.length())
                assertEquals("Native D-pad starts once","down",events.getJSONObject(0).getString("action"))
                assertEquals("Native D-pad releases once","up",events.getJSONObject(5).getString("action"))
                for(index in 0 until events.length()) {
                    val row=events.getJSONObject(index)
                    assertTrue("Original native touch pointer delivered",row.getBoolean("pointerMatches")&&row.getBoolean("finger")&&row.getBoolean("touchscreen"))
                    assertEquals("Native D-pad dispatch handled","handled",row.getString("outcome"))
                    if(index in 1..4)assertEquals("Four MOVE phases before UP","move",row.getString("action"))
                }
            } catch(failure: Throwable) {
                fingerFailure=failure
                // Local last-valid observation only; no new query, input or wait on failure.
                runCatching {
                    require(currentPhase in listOf("up","left","down","right","neutral","release","post-release","trace"))
                    val counts=lastCounts
                    require(counts==null || (counts.size==4 && counts.all { it in 0..32 }))
                    failure.addSuppressed(AssertionError("D-pad gesture state[phase=$currentPhase lastCounts=${counts?.joinToString(",") ?: "unavailable"}]"))
                }.onFailure { runCatching { failure.addSuppressed(AssertionError("D-pad gesture state[unavailable]")) } }
                runCatching {
                    val summary=observer?.failureSummary() ?: "{\"state\":\"unavailable\"}"
                    failure.addSuppressed(AssertionError("D-pad completed Window dispatch[$summary]"))
                }.onFailure { runCatching { failure.addSuppressed(AssertionError("D-pad completed Window dispatch[unavailable]")) } }
                runCatching { failure.addSuppressed(AssertionError("D-pad native viewport[${viewportObserver?.failureSummary() ?: "unavailable"}]")) }
                    .onFailure { runCatching { failure.addSuppressed(AssertionError("D-pad native viewport[unavailable]")) } }
                runCatching { failure.addSuppressed(AssertionError("D-pad passive DOM[${dom.failureSummary()}]")) }
                    .onFailure { runCatching { failure.addSuppressed(AssertionError("D-pad passive DOM[unavailable]")) } }
                throw failure
            }
            finally {
                var cleanup: Throwable?=null
                try {if(held)dispatch(android.view.MotionEvent.ACTION_CANCEL)}catch(error: Throwable){cleanup=error}
                try {scenario.onActivity {viewportObserver?.close()}}catch(error: Throwable){if(cleanup==null)cleanup=error else cleanup!!.addSuppressed(error)}
                try {scenario.onActivity {activity->observer?.restore(activity.window)}}catch(error: Throwable){if(cleanup==null)cleanup=error else cleanup!!.addSuppressed(error)}
                try {dom.close()}catch(error: Throwable){if(cleanup==null)cleanup=error else cleanup!!.addSuppressed(error)}
                try {if(bindingAttempted)assertEquals("Owned D-pad read binding must retire","true",heldRead(
                    "(()=>{const key='__lazyshDpadRead_${nonce}',owned=window[key];if(owned===undefined)return true;if(owned.owner!=='${readOwner}')return false;delete window[key];return !Object.hasOwn(window,key);})()",
                    System.nanoTime()+TimeUnit.SECONDS.toNanos(1),false))
                }catch(error: Throwable){if(cleanup==null)cleanup=error else cleanup!!.addSuppressed(error)}
                if(cleanup!=null){if(fingerFailure!=null)fingerFailure!!.addSuppressed(cleanup!!)else throw cleanup!!}
            }
            onWebView().withElement(findElement(Locator.XPATH, "//div[contains(@class,'terminal-keys')]//button[normalize-space(.)='dpad']")).perform(webScrollIntoView()).perform(webClick())
            awaitDocument(scenario,"D-pad closed before independent keyboard checkpoint","!document.querySelector('.terminal-dpad')")
            verifyPastBottomKeyboardDismiss(scenario, raw)
            raw.send("owned-dpad-$nonce", false)
            awaitDocument(scenario,"actual D-pad receiver delivered ordered stopped runs and final marker",raw.proof("DPAD_${nonce}_DELIVERED"))
            raw.original()
            val receipt=JSONObject().put("schemaVersion",1).put("nonce",nonce)
            for((index,name) in listOf("up","left","down","right").withIndex())receipt.put(name,stopped[index])
            val file=java.io.File(instrumentation.targetContext.filesDir,"owned-dpad-$nonce.json")
            require(!java.nio.file.Files.isSymbolicLink(file.toPath()) && file.createNewFile()) { "Owned D-pad receipt must be fresh" }
            val text=receipt.toString();require(text.length<=512);file.writeText(text)
            android.util.Log.i("lazysh-dpad-owned","nativePointer=true ordered=true deadZoneStopped=true afterUpStopped=true receiverDelivered=true")
        } catch(failure: Throwable){primary=failure;throw failure}
        finally {
            if(added)try {preferences("Remove")}catch(cleanup: Throwable){if(primary!=null)primary!!.addSuppressed(cleanup)else throw cleanup}
        }
    }

    private inner class OwnedRawSshInput(
        private val scenario: ActivityScenario<MainActivity>, private val fixture: JSONObject,
        private val label: String, private val mode: String,
    ) {
        val nonce = fixture.getString("nonce")
        private val directory = fixture.getJSONObject(mode).getString("directory")
        val originalWeb = AtomicReference<WebView>()
        private val packagedUrl = AtomicReference<String>()
        val tag = mode.uppercase()
        init {
            require(mode in setOf("ime", "dpad"))
            require(Regex("/tmp/lazysh-android-ssh-[A-Za-z0-9_-]+/$mode").matches(directory))
            scenario.onActivity {
                val web = requireNotNull(webView(it.window.decorView))
                originalWeb.set(web); packagedUrl.set(web.url)
            }
            require(packagedUrl.get() == "http://tauri.localhost/" || packagedUrl.get() == "https://tauri.localhost/")
        }
        fun originalDocumentUrl(): String = packagedUrl.get()
        fun clickIcon(name: String) = onWebView().withElement(findElement(Locator.CSS_SELECTOR,
            "button[aria-label='$name']")).perform(webScrollIntoView()).perform(webClick())
        fun proof(marker: String) = "document.querySelector('.terminal-canvas .xterm-screen').textContent.includes(${JSONObject.quote(marker)})"
        /** Send adds a separate Enter; Insert puts the text on the input line without it. */
        fun send(command: String, enter: Boolean = true) {
            if (evaluate(scenario, "Boolean(document.querySelector('.terminal-compose textarea'))") != "true") clickIcon("Compose")
            pasteOwnedText(scenario, ".terminal-compose textarea", command, label)
            closeSoftKeyboard(); clickIcon(if (enter) "Send" else "Insert"); closeSoftKeyboard()
            awaitDocument(scenario, "owned IME command terminal focused", "!Boolean(document.querySelector('.terminal-compose textarea')) && document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea')")
        }
        fun start() {
            send(fixture.getString("challenge"))
            awaitDocument(scenario, "owned IME SSH challenge and returned prompt", """
                (()=>{const text=document.querySelector('.terminal-canvas .xterm-screen')?.textContent||'';
                  return text.includes(${JSONObject.quote(fixture.getString("expected"))}) &&
                    text.lastIndexOf(${JSONObject.quote(fixture.getString("prompt"))})>text.indexOf(${JSONObject.quote(fixture.getString("expected"))});})()
            """)
            assertEquals("Receiver banner must be fresh", "false", evaluate(scenario, proof("${tag}_${nonce}_READY")))
            val option = if (mode == "ime") "--ime-transactions" else "--dpad-pan"
            val command = "exec './$mode-receiver' '$directory' $option '$nonce'"
            require(!command.contains("${tag}_${nonce}_READY") && !command.contains("${tag}_${nonce}_DELIVERED"))
            send(command)
            awaitDocument(scenario, "owned raw receiver actually ready", proof("${tag}_${nonce}_READY"))
        }
        fun original() {
            scenario.onActivity {
                val web = requireNotNull(webView(it.window.decorView))
                assertSame("Packaged WebView must remain original", originalWeb.get(), web)
                assertEquals("Packaged document must not navigate", packagedUrl.get(), web.url)
                assertTrue("Native terminal window must stay focused", web.hasWindowFocus() && web.hasFocus())
            }
            assertEquals("Original one-session SSH identity required", "true", evaluate(scenario,
                "document.querySelectorAll('.terminal-canvas').length===1 && Boolean(document.querySelector(${JSONObject.quote("button[aria-label='Disconnect ${fixture.getString("name")}']")}))"))
        }
    }

    private fun verifySshImeTransactions(scenario: ActivityScenario<MainActivity>, fixture: JSONObject, label: String) {
        val raw = OwnedRawSshInput(scenario, fixture, label, "ime")
        val nonce = raw.nonce
        assertEquals("Owned emulator API required", 36, Build.VERSION.SDK_INT)
        raw.start()
        fun clickIcon(name: String) = raw.clickIcon(name)
        val ime = OwnedImeControl(nonce)
        var imeOrderInstalled = false
        var imeOrderFinished = false
        var imeOrderUnavailable = false
        val imeOrderInstall = """
            (()=>{const key='__lazyshOwnedImeOrder',owner=${JSONObject.quote(nonce)};if(Object.hasOwn(window,key))return false;
              const areas=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea');
              if(areas.length!==1)return false;const area=areas[0],surface=area.closest('.terminal-canvas');
              if(!surface)return false;
              let closed=false,overflow=false,unavailable=false,phase='beforeSelect';
              const events=[],timers=new Set(),listeners=[];let owned;
              const flag=value=>typeof value==='boolean'?value:null;
              const initialReadOnly=flag(area.readOnly);
              const sample=(event,edge,owner)=>{
                if(closed)return;if(events.length>=24){overflow=true;return;}
                try {const current=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea');
                  events.push({event,edge,owner,phase,originalPresent:current.length===1&&current[0]===area,
                    connected:flag(area.isConnected),focused:document.activeElement===area,
                    documentFocus:flag(document.hasFocus()),visible:typeof document.hidden==='boolean'?!document.hidden:null,
                    readOnly:flag(area.readOnly),enabled:typeof area.disabled==='boolean'?!area.disabled:null,
                    reviewPresent:Boolean(surface.closest('.terminal-pane')?.querySelector('.terminal-edit-review'))});
                }catch{unavailable=true;}
              };
              const cleanup=()=>{closed=true;
                for(const timer of timers)try{clearTimeout(timer);}catch{unavailable=true;}
                try{timers.clear();}catch{unavailable=true;}
                for(const [target,name,callback]of listeners)try{target.removeEventListener(name,callback,true);}catch{unavailable=true;}
                try{if(window[key]===owned)delete window[key];}catch{unavailable=true;}
              };
              const listen=(target,name,owner)=>{const callback=event=>{
                if(owner==='window'&&event.target!==window)return;
                sample(name,'capture',owner);if(closed)return;
                if(events.length+timers.size>=24){overflow=true;return;}
                try {const timer=setTimeout(()=>{timers.delete(timer);sample(name,'deferred',owner);},0);timers.add(timer);}
                catch{unavailable=true;}
              };target.addEventListener(name,callback,true);listeners.push([target,name,callback]);};
              try {
                for(const name of ['pointerdown','pointerup','pointercancel','click'])listen(surface,name,'surface');
                for(const name of ['focus','blur']){listen(area,name,'editor');listen(window,name,'window');}
                listen(document,'visibilitychange','document');
                window[key]=owned={owner,mark(next){if(['beforeSelect','afterSelect','beforeTap','afterTap'].includes(next)){phase=next;sample('boundary','boundary','observer');}},
                  stop(){cleanup();return {state:unavailable?'unavailable':'observed',initialReadOnly,overflow,events};}};
                sample('installed','boundary','observer');return true;
              }catch{cleanup();return false;}
            })()
        """.trimIndent()
        fun imeOrderMark(phase: String) {
            if(imeOrderInstalled)runCatching {
                require(evaluate(scenario,"(()=>{const observer=window.__lazyshOwnedImeOrder;if(observer?.owner!==${JSONObject.quote(nonce)})return false;observer.mark(${JSONObject.quote(phase)});return true;})()",1_000)=="true")
            }.onFailure {imeOrderUnavailable=true}
        }
        fun retainImeOrder(result: JSONObject?, failure: Throwable?) {
            runCatching {
                val observed=requireNotNull(result)
                if(imeOrderUnavailable)observed.put("state","unavailable")
                require(observed.keys().asSequence().toSet()==setOf("state","initialReadOnly","overflow","events"))
                require(observed.getString("state") in listOf("observed","unavailable"))
                require(observed.get("initialReadOnly") is Boolean || observed.isNull("initialReadOnly"))
                require(observed.get("overflow") is Boolean)
                val events=observed.getJSONArray("events");require(events.length()<=24)
                val flags=setOf("originalPresent","connected","focused","documentFocus","visible","readOnly","enabled","reviewPresent")
                for(index in 0 until events.length()) {
                    val event=events.getJSONObject(index)
                    require(event.keys().asSequence().toSet()==flags+setOf("event","edge","owner","phase"))
                    require(event.getString("event") in listOf("installed","boundary","pointerdown","pointerup","pointercancel","click","focus","blur","visibilitychange"))
                    require(event.getString("edge") in listOf("capture","deferred","boundary"))
                    require(event.getString("owner") in listOf("observer","surface","editor","window","document"))
                    require(event.getString("phase") in listOf("beforeSelect","afterSelect","beforeTap","afterTap"))
                    for(name in flags)require(event.get(name) is Boolean || event.isNull(name))
                }
                if(failure!=null)failure.addSuppressed(AssertionError("IME passive order[$observed]"))
            }.onFailure {if(failure!=null)runCatching {failure.addSuppressed(AssertionError("IME passive order[unavailable]"))}}
        }
        fun finishImeOrder(failure: Throwable? = null) {
            if(imeOrderFinished)return
            imeOrderFinished=true
            val result=if(imeOrderInstalled)runCatching {
                JSONObject(evaluate(scenario,"window.__lazyshOwnedImeOrder?.owner===${JSONObject.quote(nonce)} ? window.__lazyshOwnedImeOrder.stop() : {state:'unavailable'}",1_000))
            }.getOrNull() else null
            imeOrderInstalled=false
            retainImeOrder(result,failure)
        }
        fun terminalEditor() {
            try {
            awaitDocument(scenario, "packaged terminal current normal editable helper", """
                (()=>{const areas=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea'),area=areas[0];
                  return areas.length===1 && document.hasFocus() && !document.hidden && document.activeElement===area &&
                    !area.readOnly && !area.disabled && area.type!=='password' && area.autocomplete==='off' &&
                    area.getAttribute('autocorrect')==='off' && area.spellcheck===false &&
                    Boolean(document.querySelector(${JSONObject.quote("button[aria-label='Disconnect ${fixture.getString("name")}']")}));})()
            """)
            } catch(primary:Throwable) {
                // One existing 1000ms callback timeout; diagnostic dispatch is not a new wall-clock bound.
                val collectOrder=!imeOrderFinished
                imeOrderFinished=true; imeOrderInstalled=false
                var order:JSONObject?=null
                runCatching {
                    val envelope=JSONObject(evaluate(scenario,"""
                        (()=>{let editor=null,order=null;
                          try {editor=
                        (()=>{const areas=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea');
                          const area=areas.length===1?areas[0]:null,pane=area?.closest('.terminal-pane');
                          const rects=pane?.getClientRects?.(),visibility=pane?getComputedStyle(pane).visibility:null;
                          return {count:areas.length===0?'zero':areas.length===1?'one':'many',
                            focus:document.hasFocus(),visible:!document.hidden,active:area?document.activeElement===area:null,
                            writable:area?!area.readOnly:null,enabled:area?!area.disabled:null,normalType:area?area.type!=='password':null,
                            autocompleteOff:area?area.autocomplete==='off':null,autocorrectOff:area?area.getAttribute('autocorrect')==='off':null,
                            spellcheckOff:area?area.spellcheck===false:null,
                            unappliedReviewPresent:pane?Boolean(pane.querySelector('.terminal-edit-review')):null,
                            endedNoticePresent:pane?Boolean(pane.querySelector(':scope > .session-notice[role=status]')):null,
                            modalPresent:pane?Boolean(document.querySelector('[role=dialog][aria-modal=true]')):null,
                            paneDisplayed:rects&&Number.isInteger(rects.length)&&rects.length>=0&&['visible','hidden','collapse'].includes(visibility)?rects.length>0&&visibility==='visible':null,
                            sessionPresent:Boolean(document.querySelector(${JSONObject.quote("button[aria-label='Disconnect ${fixture.getString("name")}']")}))};})();
                          }catch{}finally{if($collectOrder)try{
                            const observer=window.__lazyshOwnedImeOrder;
                            if(observer?.owner===${JSONObject.quote(nonce)})order=observer.stop();
                          }catch{}}
                          return {editor,order};})()
                    """,1_000))
                    order=envelope.optJSONObject("order")
                    require(envelope.keys().asSequence().toSet()==setOf("editor","order"))
                    val state=envelope.getJSONObject("editor")
                    val fields=listOf("focus","visible","active","writable","enabled","normalType","autocompleteOff","autocorrectOff","spellcheckOff","sessionPresent","unappliedReviewPresent","endedNoticePresent","modalPresent","paneDisplayed")
                    require(state.keys().asSequence().toSet()==fields.toSet()+"count")
                    val count=state.get("count");require(count in listOf("zero","one","many"))
                    val flags=fields.joinToString(" ") { name ->
                        val value=state.get(name);require(value is Boolean || value===JSONObject.NULL)
                        "$name=${if(value===JSONObject.NULL)"unavailable" else value}"
                    }
                    primary.addSuppressed(AssertionError("IME editor state[count=$count $flags]"))
                }.onFailure {runCatching {primary.addSuppressed(AssertionError("IME editor state[unavailable]"))}}
                if(collectOrder)retainImeOrder(order,primary)
                throw primary
            }
            raw.original()
        }

        val toolbarOrder = """
            JSON.stringify(Array.from(document.querySelectorAll('[data-settings-page="preferencesToolbarKeysAndOrder"] button[aria-label^="Remove "]'),button=>button.getAttribute('aria-label')))
        """
        val toolbarState = """
            name=>{const matches=Array.from(document.querySelectorAll('.terminal-keys button')).filter(button=>button.textContent.trim()===name);
              if(matches.length!==1)throw Error('Owned toolbar button must be unique');
              const button=matches[0],style=getComputedStyle(button);
              return {pressed:button.getAttribute('aria-pressed'),active:button.matches(':active'),disabled:button.disabled,
                paint:[style.backgroundColor,style.color,style.borderTopColor,style.boxShadow]};}
        """
        fun toolbarSnapshot(name:String)=JSONObject(evaluate(scenario,"($toolbarState)(${JSONObject.quote(name)})"))
        fun inputPreferences() {
            if (evaluate(scenario,workspaceElementVisible("button[aria-label='Preferences']")) == "true") raw.clickIcon("Preferences")
            else workspaceMenuAction(scenario,"Preferences")
            preferencesCategory(scenario,"input")
        }
        fun toolbarPreferences() {
            inputPreferences()
            preferencesCategory(scenario,"preferencesToolbarKeysAndOrder")
        }
        val privateKeyboardSwitch = """Array.from(document.querySelectorAll('[data-settings-page="input"] > label')).find(item=>item.textContent.trim()==='Private keyboard in the terminal')?.querySelector('input')"""
        var privateKeyboardOn = false
        /** The real Preferences switch. The focused terminal editor then reports itself, and the shell restarts the keyboard's input with the private setup. */
        fun privateKeyboard(on: Boolean) {
            inputPreferences()
            onWebView().withElement(findElement(Locator.XPATH,"//section[@data-settings-page='input']/label[normalize-space(.)='Private keyboard in the terminal']")).perform(webScrollIntoView()).perform(webClick())
            awaitDocument(scenario,"private keyboard switch ${if (on) "on" else "off"}","($privateKeyboardSwitch)?.checked===$on")
            privateKeyboardOn = on
            raw.clickIcon("Close Preferences")
        }
        val addedToolbarKeys=mutableListOf<String>()
        var originalToolbarOrder:String?=null
        fun tapAt(bounds:JSONArray)=tapWebViewAt(bounds)
        fun tapToolbar(name:String) {
            raw.original()
            onWebView().withElement(findElement(Locator.XPATH,"//*[contains(concat(' ',normalize-space(@class),' '),' terminal-keys ')]//button[normalize-space(.)='$name']")).perform(webScrollIntoView())
            val bounds=JSONArray(evaluate(scenario,"""
                (()=>{const matches=Array.from(document.querySelectorAll('.terminal-keys button')).filter(button=>button.textContent.trim()===${JSONObject.quote(name)});
                  if(matches.length!==1||matches[0].disabled)throw Error('Owned enabled toolbar button required');
                  const rect=matches[0].getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;
                  if(document.elementFromPoint(x,y)?.closest('button')!==matches[0])throw Error('Owned toolbar hit target required');
                  return [x,y,innerWidth];})()
            """))
            tapAt(bounds)
            raw.original()
        }
        fun assertToolbarReleased(name:String,baseline:JSONObject) {
            awaitDocument(scenario,"released toolbar button", """
                (()=>{const state=($toolbarState)(${JSONObject.quote(name)});
                  return !state.active&&!state.disabled&&state.pressed===${if(name=="Shift")JSONObject.quote("false") else "null"}&&JSON.stringify(state.paint)===${JSONObject.quote(baseline.getJSONArray("paint").toString())};})()
            """,deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(2))
        }
        fun tapTerminal() {
            val bounds = JSONArray(evaluate(scenario, """
                (()=>{const rect=document.querySelector('.terminal-canvas .xterm-screen').getBoundingClientRect();
                  return [rect.left+rect.width/2,rect.top+Math.min(rect.height/2,40),innerWidth];})()
            """))
            imeOrderMark("beforeTap")
            tapAt(bounds)
            imeOrderMark("afterTap")
            terminalEditor()
        }
        fun commitOwnedLineBreak(generation: Long) {
            terminalEditor()
            val state = ime.call("state")
            ime.editor(state)
            assertEquals("Original active native IME generation retained", generation, state.getLong("generation"))
            val key = JSONObject.quote("__lazyshOwnedLineBreak_$nonce")
            val installed = evaluate(scenario, """
                (()=>{const key=$key,areas=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea');
                  if(areas.length!==1||Object.hasOwn(window,key))return false;
                  const area=areas[0],types=['keydown','beforeinput','input','compositionstart','compositionend'];
                  const events=[];let overflow=false,settled=false;
                  const listener=event=>{if(event.target!==area)return;if(events.length>=24){overflow=true;return;}
                    events.push({kind:event.type==='keydown'?(event.key==='Enter'?'enter':'other-key'):
                      event.type==='input'?(event.inputType==='insertLineBreak'?'line-break':'other-input'):
                      event.type==='beforeinput'?'beforeinput':'composition',trusted:event.isTrusted===true,
                      composing:event.isComposing===true});
                    if(events.at(-1).kind==='enter')setTimeout(()=>{settled=true;},0);};
                  for(const type of types)document.addEventListener(type,listener,true);
                  Object.defineProperty(window,key,{configurable:true,value:{get settled(){return settled||overflow;},stop:()=>{
                    for(const type of types)document.removeEventListener(type,listener,true);
                    delete window[key];const current=document.querySelectorAll('.terminal-canvas .xterm-helper-textarea');
                    return {overflow,events,original:current.length===1&&current[0]===area&&area.isConnected&&document.activeElement===area};}}});return true;})()
            """) == "true"
            assertTrue("Owned line-break observer installed", installed)
            var observed: JSONObject? = null
            var primary: Throwable? = null
            try {
                val result = ime.call("lineBreak")
                assertTrue("Fixed native line break accepted", result.getBoolean("accepted"))
                assertTrue("Fixed native line break read barrier returned", result.getBoolean("readReturned"))
                // The synthetic key press is posted after the commit, so the read barrier does not order it.
                runCatching { awaitDocument(scenario, "owned soft Enter key press settled", "window[$key]?.settled===true",
                    deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)) }
            } catch (failure: Throwable) { primary = failure; throw failure }
            finally {
                try { observed = JSONObject(evaluate(scenario, "window[$key]?.stop() ?? {overflow:true,events:[],original:false}")) }
                catch (cleanup: Throwable) { if (primary != null) primary!!.addSuppressed(cleanup) else throw cleanup }
            }
            val result = checkNotNull(observed)
            val events = result.getJSONArray("events")
            val facts = (0 until events.length()).map { events.getJSONObject(it) }
            // Bounded event kinds and flags only; the observer never records editor text.
            val seen = "overflow=${result.getBoolean("overflow")} original=${result.getBoolean("original")} events=" +
                facts.joinToString(",", "[", "]") { "${it.getString("kind")}(trusted=${it.getBoolean("trusted")},composing=${it.getBoolean("composing")})" }
            // Chromium's ThreadedInputConnection commits "" and then sends an exact "\n" commit as a synthetic
            // soft Enter key press (crbug.com/577967); no Android IME commit reaches the editor as input only.
            assertTrue("INCONCLUSIVE: native IME did not deliver one trusted soft Enter key press [$seen]",
                !result.getBoolean("overflow") && result.getBoolean("original") &&
                    facts.count { it.getString("kind") == "enter" && it.getBoolean("trusted") && !it.getBoolean("composing") } == 1 &&
                    facts.none { it.getString("kind") == "composition" || !it.getBoolean("trusted") || it.getBoolean("composing") })
            assertTrue("Soft Enter key press is consumed by the terminal, not inserted into the editor [$seen]",
                facts.none { it.getString("kind") in listOf("line-break", "other-input") })
        }
        /**
         * A CJK input method in the Chat composer: the kana reading grows as a composing region, one commit replaces it with
         * the word, Stage hands the draft to the terminal composer and the terminal's own Send delivers it. The host then
         * compares every byte the original receiver got (OwnedImeService spells the same reading and word in escapes).
         */
        fun chatComposerCjk(previousGeneration: Long) {
            val reading = "\u306b\u307b\u3093\u3054"
            val word = "\u65e5\u672c\u8a9e"
            val area = "document.querySelector('form.chat-composer textarea')"
            val key = JSONObject.quote("__lazyshOwnedChatIme_$nonce")
            sessionView(scenario, "Transcript")
            awaitDocument(scenario, "empty editable Chat composer", "(()=>{const area=$area;return Boolean(area) && area.value==='' && !area.readOnly && !area.disabled;})()")
            // Counts only; the observer never records editor text.
            val observing = evaluate(scenario, """
                (()=>{const key=$key,area=$area;if(!area||Object.hasOwn(window,key))return false;
                  const types=['compositionstart','compositionupdate','compositionend'],counts={compositionstart:0,compositionupdate:0,compositionend:0};
                  const listener=event=>{if(event.target===area)counts[event.type]++;};
                  for(const type of types)area.addEventListener(type,listener,true);
                  Object.defineProperty(window,key,{configurable:true,value:{counts,stop(){
                    for(const type of types)area.removeEventListener(type,listener,true);delete window[key];return counts;}}});
                  return true;})()
            """) == "true"
            assertTrue("Chat composer composition observer installed", observing)
            var observed: JSONObject? = null
            var chatFailure: Throwable? = null
            try {
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, "form.chat-composer textarea")).perform(webScrollIntoView())
                // With the keyboard up the composer's lower part can sit under the key bar: bring it to the middle of its scroller.
                evaluate(scenario, "($area.scrollIntoView({block:'center',inline:'nearest'}), true)")
                val target = JSONObject(evaluate(scenario, """
                    (()=>{const area=$area,rect=area.getBoundingClientRect(),x=rect.left+rect.width/2,
                        y=(Math.max(rect.top,0)+Math.min(rect.bottom,innerHeight))/2;
                      const hit=document.elementFromPoint(x,y), bounded=n=>Math.max(-10000,Math.min(10000,Math.round(n)));
                      return {ok:hit===area,bounds:[x,y,innerWidth],diagnostic:{
                        hit:hit===area?'textarea':hit===null?'none':area.contains(hit)?'descendant':
                          hit.contains(area)?'ancestor':hit.closest('.dialog-backdrop')?'dialog':
                          hit.closest('.sidebar, .sidebar-scrim')?'sidebar':hit.closest('.chat-panel')?'chat':
                          hit.closest('.gesture-handle')?'gesture-handle':hit.closest('.bottom-menu, .bottom-menu-scrim')?'bottom-menu':
                          hit.closest('.terminal-keys, .session-toolbar')?'keys':hit.closest('.workspace-header, .workspace-footer')?'workspace-bar':hit.closest('.terminal-canvas')?'terminal':hit.closest('.session-body')?'session':'other',
                        rect:[rect.left,rect.top,rect.width,rect.height].map(bounded),viewport:[innerWidth,innerHeight].map(bounded)}};})()
                """))
                assertTrue("Owned Chat composer hit target required [${target.getJSONObject("diagnostic")}]", target.getBoolean("ok"))
                tapAt(target.getJSONArray("bounds"))
                awaitDocument(scenario, "Chat composer owns DOM focus", "document.activeElement===$area")
                val editor = ime.awaitIme("Chat composer remote editor required") {
                    it.getBoolean("connected") && it.getBoolean("normalText") && it.getBoolean("remoteProxy") && it.getLong("generation") > previousGeneration
                }
                assertTrue("Actual IME remote proxy required for the Chat composer", editor.getBoolean("remoteProxy"))
                ime.call("capture")
                val preedit = ime.call("cjkPreedit")
                assertTrue("Fixed native CJK preedit accepted", preedit.getBoolean("accepted"))
                assertTrue("Fixed native CJK preedit read barrier returned", preedit.getBoolean("readReturned"))
                awaitDocument(scenario, "CJK preedit is the composing text of the Chat composer", """
                    (()=>{const area=$area,seen=window[$key].counts;return document.activeElement===area && area.value===${JSONObject.quote(reading)} &&
                      seen.compositionstart===1 && seen.compositionupdate>=2 && seen.compositionend===0;})()
                """)
                val commit = ime.call("cjkCommit")
                assertTrue("Fixed native CJK commit accepted", commit.getBoolean("accepted"))
                assertTrue("Fixed native CJK commit readback", commit.getBoolean("readMatched"))
                awaitDocument(scenario, "CJK commit replaces the preedit once", """
                    (()=>{const area=$area,seen=window[$key].counts;return area.value===${JSONObject.quote(word)} && area.selectionStart===${word.length} &&
                      area.selectionEnd===${word.length} && seen.compositionstart===1 && seen.compositionend===1;})()
                """)
            } catch (failure: Throwable) { chatFailure = failure; throw failure }
            finally {
                try { observed = JSONObject(evaluate(scenario, "window[$key]?.stop() ?? {}")) }
                catch (cleanup: Throwable) { if (chatFailure != null) chatFailure!!.addSuppressed(cleanup) else throw cleanup }
            }
            assertEquals("One composition in the Chat composer", 1, checkNotNull(observed).getInt("compositionstart"))
            assertEquals("The composition ended once", 1, observed!!.getInt("compositionend"))
            clickOwnedButton("Stage in terminal")
            awaitDocument(scenario, "Chat composer draft staged", "Array.from(document.querySelectorAll('form.chat-composer [role=status]')).some(x=>x.textContent==='Review this draft in the terminal before pasting it.')")
            sessionView(scenario, "Terminal")
            awaitDocument(scenario, "staged draft is the committed word once in the terminal composer", "document.querySelector('.terminal-compose textarea')?.value===${JSONObject.quote(word)}")
            raw.clickIcon("Send")
            awaitDocument(scenario, "actual receiver received the Chat composer text", raw.proof("IME_${nonce}_CHAT") +
                " && !document.querySelector('.terminal-compose textarea') && document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea')")
            android.util.Log.i("lazysh-ime-ssh-owned", "chatComposer=true preedit=true commitOnce=true staged=true receiverAck=true")
        }
        var primary: Throwable? = null
        try {
            toolbarPreferences()
            originalToolbarOrder=evaluate(scenario,toolbarOrder)
            for ((key,title) in listOf("shift" to "Shift","enter" to "enter")) {
                if (evaluate(scenario,"""document.querySelector('[data-settings-page=preferencesToolbarKeysAndOrder] button[aria-label="Remove $key"]')!==null""")!="true") {
                    addedToolbarKeys.add(key)
                    onWebView().withElement(findElement(Locator.XPATH,"//section[@data-settings-page='preferencesToolbarKeysAndOrder']//button[normalize-space(.)='Add $title']")).perform(webScrollIntoView()).perform(webClick())
                }
            }
            raw.clickIcon("Close Preferences")
            imeOrderInstalled=runCatching {evaluate(scenario,imeOrderInstall,1_000)=="true"}.getOrDefault(false)
            ime.arm(); imeOrderMark("beforeSelect"); ime.select(); imeOrderMark("afterSelect"); tapTerminal()
            finishImeOrder()
            val first = ime.awaitIme("Actual packaged terminal remote editor required") { it.getBoolean("connected") && it.getBoolean("normalText") }
            ime.editor(first); ime.call("capture")
            // The last seven are SwiftKey-shaped (predictive word, gesture word, Backspace inside the composing
            // region, autocorrect by erase-and-commit, Backspace after a toolbar key ended ownership, the
            // letters-as-commits word with a composing-region rewrite that SwiftKey uses for a Chromium editor, and a
            // composing word erased whole, after which Chromium sends no compositionend).
            for (operation in listOf("composeCorrection", "extendTail", "restoreTail", "eraseTail", "repeatWord",
                    "predictWord", "swipeWord", "composingBackspace", "replacePrevious", "eraseOne", "webWord", "dropWord")) {
                if (operation == "eraseOne") tapToolbar("esc")
                terminalEditor()
                val result = ime.call(operation)
                assertTrue("Fixed native IME transaction accepted: $operation", result.getBoolean("accepted"))
                assertTrue("Fixed native IME transaction readback: $operation", result.getBoolean("readMatched"))
                if (operation == "extendTail") {
                    assertTrue("Non-tail native editor retains the full correction", result.getBoolean("suffixMatched"))
                    evaluate(scenario, "setTimeout(()=>{window.__lazyshNonTailImeSettled=true},0);true")
                    awaitDocument(scenario, "settled native non-tail correction stays editable", "window.__lazyshNonTailImeSettled===true && document.querySelector('.terminal-canvas .xterm-helper-textarea')?.selectionStart===0 && document.querySelector('.terminal-canvas .xterm-helper-textarea')?.readOnly===false")
                }
            }
            clickIcon("Compose")
            awaitDocument(scenario, "composer revokes packaged terminal editor", "document.querySelector('.terminal-compose textarea')?.value==='' && document.querySelector('.terminal-canvas .xterm-helper-textarea')?.readOnly===true")
            val old = ime.call("old")
            assertFalse("Retired actual connection cannot read current editor", old.getBoolean("readReturned"))
            assertEquals("Late terminal commit must not type into composer", "true", evaluate(scenario,
                "document.querySelector('.terminal-compose textarea')?.value===''") )
            clickIcon("Close composer"); tapTerminal()
            val second = ime.awaitIme("Remote epoch inconclusive: distinct packaged terminal proxy required") {
                it.getBoolean("connected") && it.getBoolean("normalText") && it.getBoolean("distinct") && it.getLong("generation")>first.getLong("generation")
            }
            ime.editor(second); terminalEditor()
            val shiftBaseline=toolbarSnapshot("Shift")
            val enterBaseline=toolbarSnapshot("enter")
            assertEquals("Shift starts unlatched", "false",shiftBaseline.getString("pressed"))
            assertTrue("Momentary Enter has no toggle state",enterBaseline.isNull("pressed"))
            tapToolbar("Shift")
            assertTrue("Native Shift tap arms one shot",toolbarSnapshot("Shift").getBoolean("pressed"))
            tapToolbar("enter")
            assertToolbarReleased("Shift",shiftBaseline)
            assertToolbarReleased("enter",enterBaseline)
            tapToolbar("enter")
            assertToolbarReleased("enter",enterBaseline)
            terminalEditor()
            onView(isAssignableFrom(WebView::class.java)).perform(pressKey(EspressoKey.Builder().withKeyCode(KeyEvent.KEYCODE_ENTER).withShiftPressed(true).build()))
            tapToolbar("Shift")
            assertTrue("Shift can be armed again",toolbarSnapshot("Shift").getBoolean("pressed"))
            val preedit=ime.call("preedit")
            assertTrue("Actual native pending composition accepted",preedit.getBoolean("accepted"))
            tapToolbar("Shift")
            assertToolbarReleased("Shift",shiftBaseline)
            assertEquals("Turning Shift off preserves pending native composition", "true",evaluate(scenario,
                "document.querySelector('.terminal-canvas .xterm-helper-textarea')?.value===${JSONObject.quote("owned-preedit-$nonce")}"))
            val current = ime.call("current")
            assertTrue("Current actual connection accepts fixed marker", current.getBoolean("accepted"))
            assertTrue("Current actual connection readback confirms fixed marker", current.getBoolean("readMatched"))
            terminalEditor()
            awaitDocument(scenario, "actual receiver wrote the exact transaction stream before disconnect", "document.querySelector('.terminal-canvas .xterm-screen').textContent.includes('IME_${nonce}_DELIVERED')")
            commitOwnedLineBreak(second.getLong("generation"))
            tapToolbar("Shift")
            assertTrue("Native Shift tap arms line break",toolbarSnapshot("Shift").getBoolean("pressed"))
            commitOwnedLineBreak(second.getLong("generation"))
            assertToolbarReleased("Shift",shiftBaseline)
            android.util.Log.i("lazysh-ime-ssh-owned", "packaged=true remoteEpoch=true privateLearning=false oldRead=false currentRead=true")
            // Private keyboard mode: the same packaged terminal, with the real setting on, is given the private editor
            // setup, and the host receiver must get the typed text byte for byte after the transactions above.
            privateKeyboard(true)
            tapTerminal()
            val privateSetup = ime.awaitIme("Private keyboard editor setup required") {
                it.getBoolean("connected") && it.getBoolean("privateLearning") && it.getBoolean("visiblePassword")
            }
            ime.privateEditor(privateSetup,first); terminalEditor()
            val typed = ime.call("private")
            assertTrue("Fixed private keyboard commit accepted", typed.getBoolean("accepted"))
            assertTrue("Fixed private keyboard commit read barrier returned", typed.getBoolean("readReturned"))
            // The receiver reports the typed text once it has arrived; the host then compares every byte.
            awaitDocument(scenario, "actual receiver received the private keyboard text", raw.proof("IME_${nonce}_PRIVATE"))
            // Back off: the next editor setup is the ordinary one again, without reconnecting.
            privateKeyboard(false)
            tapTerminal()
            val restored = ime.awaitIme("Ordinary keyboard editor setup restored") {
                it.getBoolean("connected") && it.getBoolean("normalText") && !it.getBoolean("privateLearning")
            }
            ime.editor(restored); terminalEditor()
            android.util.Log.i("lazysh-ime-ssh-owned", "privateKeyboard=true setupOn=true setupOff=true receiverAck=true")
            chatComposerCjk(restored.getLong("generation"))
        } catch (failure: Throwable) { primary=failure; finishImeOrder(failure); throw failure }
        finally {
            finishImeOrder(primary)
            var cleanupFailure:Throwable?=null
            try { ime.restore() } catch (cleanup: Throwable) {cleanupFailure=cleanup}
            try { if (privateKeyboardOn) privateKeyboard(false) } catch (cleanup: Throwable) {if(cleanupFailure!=null)cleanupFailure!!.addSuppressed(cleanup) else cleanupFailure=cleanup}
            try {
                if (originalToolbarOrder!=null) {
                    toolbarPreferences()
                    for(key in addedToolbarKeys) raw.clickIcon("Remove $key")
                    assertEquals("Original toolbar order restored exactly",originalToolbarOrder,evaluate(scenario,toolbarOrder))
                    raw.clickIcon("Close Preferences")
                }
            } catch(cleanup:Throwable) {if(cleanupFailure!=null)cleanupFailure!!.addSuppressed(cleanup) else cleanupFailure=cleanup}
            cleanupFailure?.let {if(primary!=null)primary!!.addSuppressed(it) else throw it}
        }
    }

    private class OwnedImeControl(private val nonce: String) {
        private val instrumentation = InstrumentationRegistry.getInstrumentation()
        private var armed = false
        init {
            require(Regex("[0-9a-f]{32}").matches(nonce)) { "Owned IME nonce required" }
            assertEquals("Owned IME APK signer must match target", android.content.pm.PackageManager.SIGNATURE_MATCH,
                instrumentation.context.packageManager.checkSignatures(instrumentation.context.packageName, instrumentation.targetContext.packageName))
        }
        fun shell(command:String):String {
            val descriptor=instrumentation.uiAutomation.executeShellCommand(command)
            return android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use {
                val bytes=it.readNBytes(4097)
                check(bytes.size<=4096) {"Owned IME shell response exceeded bound"}
                String(bytes,Charsets.UTF_8).trim()
            }
        }
        private val component="${instrumentation.context.packageName}/app.lazysh.client.OwnedImeService"
        private val original=shell("settings get secure default_input_method")
        init { assertTrue("Original IME must be restorable",Regex("[A-Za-z0-9_.]+/[A-Za-z0-9_.$]+").matches(original) && original!=component) }
        private val enabled=shell("settings get secure enabled_input_methods")
        init { assertTrue("Fixture IME must start disabled",enabled.split(':').none {it.substringBefore(';')==component}) }
        val resolver=instrumentation.targetContext.contentResolver
        val control=Uri.parse("content://app.lazysh.client.test.imefixture")
        fun call(method:String)=checkNotNull(resolver.call(control,method,nonce,null))
        fun awaitIme(label:String,predicate:(android.os.Bundle)->Boolean):android.os.Bundle {
            val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(120)
            do {
                val state=call("state")
                if(predicate(state))return state
                Thread.sleep(50)
            }while(System.nanoTime()<deadline)
            throw AssertionError(label)
        }
        /** Bounded numeric flags only; the editor text never leaves the IME process. */
        private fun logEditor(setting:String,state:android.os.Bundle) =
            android.util.Log.i("lazysh-ime-editor","privateKeyboard=$setting inputType=0x${Integer.toHexString(state.getInt("inputType"))} imeOptions=0x${Integer.toHexString(state.getInt("imeOptions"))}")
        fun editor(state:android.os.Bundle) {
            logEditor("off",state)
            assertTrue("Actual IME remote proxy required",state.getBoolean("remoteProxy"))
            assertTrue("Normal text editor required",state.getBoolean("normalText"))
            assertTrue("Autocomplete hint must reach native NO_SUGGESTIONS",state.getBoolean("noSuggestions"))
            assertFalse("Native AUTO_CORRECT must stay off",state.getBoolean("autoCorrect"))
            assertFalse("Private learning flag must remain absent",state.getBoolean("privateLearning"))
            assertFalse("Visible-password setup must remain absent",state.getBoolean("visiblePassword"))
        }
        /** The terminal editor with Private keyboard on: plain text asked to behave as a visible password, with no suggestions and no learning. */
        fun privateEditor(state:android.os.Bundle,baseline:android.os.Bundle) {
            logEditor("on",state)
            assertTrue("Actual IME remote proxy required",state.getBoolean("remoteProxy"))
            assertEquals("Private keyboard stays a text editor",android.text.InputType.TYPE_CLASS_TEXT,state.getInt("inputType") and android.text.InputType.TYPE_MASK_CLASS)
            assertTrue("Private keyboard asks for visible-password input",state.getBoolean("visiblePassword"))
            assertTrue("Private keyboard asks for no suggestions",state.getBoolean("noSuggestions"))
            assertFalse("Private keyboard turns autocorrect off",state.getBoolean("autoCorrect"))
            assertTrue("Private keyboard asks for no personalised learning",state.getBoolean("privateLearning"))
            // The learning flag is added to what Chromium set (no fullscreen, no extract UI, the Enter action), never replacing it.
            val ordinary=baseline.getInt("imeOptions")
            assertEquals("Private keyboard keeps every IME option of the ordinary editor",ordinary,state.getInt("imeOptions") and ordinary)
        }
        fun arm() { call("arm"); armed = true }
        fun select() {
            shell("ime enable $component"); shell("ime set $component")
            assertEquals("Fixture IME selected", component, shell("settings get secure default_input_method"))
        }
        fun restore() {
            var failure: Throwable? = null
            for (action in listOf<()->Unit>(
                { if (armed) call("release") },
                { shell("ime set $original"); assertEquals("Original IME restored", original, shell("settings get secure default_input_method")) },
                { shell("ime disable $component"); assertEquals("Original enabled IMEs preserved", enabled, shell("settings get secure enabled_input_methods")) }
            )) try { action() } catch (error: Throwable) {
                if (failure == null) failure = error else failure!!.addSuppressed(error)
            }
            if (failure != null) throw failure!!
        }
    }

    @Test fun ownedImeInputViewHonorsBoundedFrameworkMeasurement() {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val context=instrumentation.context
            for ((legacy,available,expected) in listOf(Triple(true,800,800),Triple(false,800,1),Triple(false,0,0))) {
                val frame=android.widget.FrameLayout(context)
                val view=if(legacy) View(context).apply { minimumHeight=1 } else OwnedImeService.inputView(context)
                // InputMethodService.setInputView replaces child parameters with this exact pair.
                frame.addView(view,android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
                frame.measure(View.MeasureSpec.makeMeasureSpec(320,View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(available,View.MeasureSpec.AT_MOST))
                assertEquals("Fixture input child respects bounded height",expected,view.measuredHeight)
                assertEquals("Fixture input frame respects bounded height",expected,frame.measuredHeight)
                assertEquals("Fixture input child keeps full width",320,view.measuredWidth)
            }
        }
    }

    @Test fun ownedImeRetiresActualRemoteConnectionWithoutPrivateKeyboardFlags() {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val arguments=InstrumentationRegistry.getArguments()
        org.junit.Assume.assumeTrue("Owned IME acceptance only",arguments.getString("lazyshImeAcceptance")=="true")
        assertTrue("Dedicated cached emulator required",Build.VERSION.SDK_INT==36 && Build.MODEL=="sdk_gphone64_x86_64")
        val nonce=checkNotNull(arguments.getString("lazyshImeNonce"))
        assertTrue("Exact owned IME nonce required",Regex("[0-9a-f]{32}").matches(nonce))
        val port=checkNotNull(arguments.getString("lazyshImePort")).toInt()
        assertTrue("Owned loopback fixture port required",port in 1024..65535)
        val ime=OwnedImeControl(nonce)
        val call=ime::call
        val awaitIme=ime::awaitIme
        val editor=ime::editor
        val scenario=NativeActivityFixture.scenario
        val clientBefore=AtomicReference<android.webkit.WebViewClient>()
        val documentBefore=AtomicReference<String>()
        val documentDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(30)
        do {
            scenario.onActivity {activity->
                val web=webView(activity.window.decorView)
                val location=web?.url
                if(web!=null && location!=null) {clientBefore.set(web.webViewClient);documentBefore.set(location)}
            }
            if(documentBefore.get()!=null)break
            Thread.sleep(50)
        }while(System.nanoTime()<documentDeadline)
        val originalClient=checkNotNull(clientBefore.get()) {"Original native WebView client unavailable"}
        val originalDocument=checkNotNull(documentBefore.get()) {"Original document not observed within native readiness bound"}
        val location=Uri.parse(originalDocument)
        assertTrue("Owned packaged root document required",location.scheme in listOf("http","https") &&
            location.host=="tauri.localhost" && location.port== -1 && location.userInfo==null &&
            location.path in listOf("","/") && location.query==null && location.fragment==null)
        var navigated=false
        fun navigate(phase:String,url:String,html:String?=null) {
            val finished=CountDownLatch(1)
            scenario.onActivity {activity->
                val web=checkNotNull(webView(activity.window.decorView))
                val previous=web.webViewClient
                web.webViewClient=object:android.webkit.WebViewClient() {
                    override fun shouldInterceptRequest(view:WebView,request:android.webkit.WebResourceRequest)=
                        previous.shouldInterceptRequest(view,request)
                    override fun onPageStarted(view:WebView,url:String?,icon:android.graphics.Bitmap?) {
                        previous.onPageStarted(view,url,icon)
                    }
                    override fun onPageFinished(view:WebView,completedUrl:String?) {
                        previous.onPageFinished(view,completedUrl)
                        if(completedUrl==url) {
                            android.util.Log.i("lazysh-ime-owned","phase=$phase finished=true expectedUrl=true progress=${view.progress}")
                            finished.countDown()
                        }
                    }
                }
                android.util.Log.i("lazysh-ime-owned","phase=$phase navigation=true progress=${web.progress}")
                navigated=true
                if(html==null)web.loadUrl(url)else web.loadDataWithBaseURL(url,html,"text/html","UTF-8",null)
            }
            assertTrue("Owned $phase native page completion required",finished.await(30,TimeUnit.SECONDS))
        }
        var primary:Throwable?=null
        try {
            ime.arm()
            navigate("blank","about:blank")
            assertEquals("Owned trivial JavaScript callback required","4",evaluate(scenario,"2+2"))
            android.util.Log.i("lazysh-ime-owned","phase=blank callback=true")
            val html="""<!doctype html><meta charset="utf-8"><script type="module">
              import {mountTerminalImeHarness} from '/e2e/fixtures/TerminalImeHarness.ts';
              window.ownedIme=mountTerminalImeHarness();window.__lazyshImeOwner='$nonce';
            </script>"""
            navigate("harness","http://127.0.0.1:$port/owned-ime-harness/",html)
            awaitDocument(scenario,"current-source owned IME fixture","window.__lazyshImeOwner==='$nonce' && !!window.ownedIme?.textarea")
            ime.select()
            // Native focus must precede DOM focus, as in typeInto: refocusing afterward can blur the editor.
            scenario.onActivity {activity->
                val web=checkNotNull(webView(activity.window.decorView))
                if(!web.hasFocus())assertTrue("Owned IME native focus was denied",web.requestFocus())
                assertTrue("Owned IME native focus required",web.hasFocus())
            }
            evaluate(scenario,"window.ownedIme.observation.resume();window.ownedIme.terminal.focus();true")
            val focused=JSONObject(evaluate(scenario,"""(()=>{const area=window.ownedIme.textarea;return {
                connected:area.isConnected, editable:!area.readOnly&&!area.disabled,
                targetFocused:document.activeElement===area, documentFocused:document.hasFocus()};})()"""))
            assertTrue("Owned IME editor admission: $focused",listOf("connected","editable","targetFocused","documentFocused").all {focused.getBoolean(it)})
            scenario.onActivity {activity->
                val web=checkNotNull(webView(activity.window.decorView))
                assertTrue("Owned IME DOM selection lost native focus",web.hasFocus())
                activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)
                    .showSoftInput(web,android.view.inputmethod.InputMethodManager.SHOW_IMPLICIT)
            }
            val first=awaitIme("Actual first IME editor required") {it.getBoolean("connected") && it.getBoolean("normalText")}
            editor(first);call("capture")
            assertTrue("Real IME preedit queued",call("preedit").getBoolean("accepted"))
            awaitDocument(scenario,"real IME preedit in current xterm","window.ownedIme.textarea.value==='owned-preedit-$nonce'")
            assertEquals("Preedit has not committed", "true",evaluate(scenario,"window.ownedIme.writes.length===0"))
            evaluate(scenario,"window.ownedIme.observation.reset();true")
            assertEquals("Renderer editor revoked", "true",evaluate(scenario,"window.ownedIme.textarea.readOnly"))
            evaluate(scenario,"window.ownedIme.observation.resume();window.ownedIme.terminal.focus();true")
            val second=awaitIme("Remote epoch inconclusive: distinct later framework proxy was not observed") {
                it.getBoolean("connected") && it.getBoolean("normalText") && it.getBoolean("distinct") && it.getLong("generation")>first.getLong("generation")
            }
            editor(second)
            val old=call("old")
            assertFalse("Retired remote connection cannot read new editor",old.getBoolean("readReturned"))
            val current=call("current")
            assertTrue("Current remote connection accepted fixed text",current.getBoolean("accepted"))
            assertTrue("Current remote read confirms fixed text",current.getBoolean("readMatched"))
            awaitDocument(scenario,"current generation commits once without old preedit or old command",
                "JSON.stringify(window.ownedIme.writes)===JSON.stringify(['owned-current-$nonce'])")
            android.util.Log.i("lazysh-ime-owned","remoteEpoch=true noSuggestions=true privateLearning=false oldRead=false currentRead=true exactWrites=true")
        } catch(failure:Throwable) {primary=failure;throw failure}
        finally {
            var cleanup:Throwable?=null
            for(action in listOf<()->Unit>(
                {ime.restore()},
                {
                    try {if(navigated)navigate("restore",originalDocument)}
                    finally {
                        scenario.onActivity {activity->
                            val web=checkNotNull(webView(activity.window.decorView))
                            web.webViewClient=originalClient
                            assertSame("Original native WebView client restored",originalClient,web.webViewClient)
                        }
                    }
                    assertEquals("Original document restored","true",evaluate(scenario,"location.href===${JSONObject.quote(originalDocument)}"))
                    android.util.Log.i("lazysh-ime-owned","originalClientRestored=true originalDocumentRestored=true")
                }
            ))try {action()}catch(failure:Throwable){if(cleanup==null)cleanup=failure else cleanup!!.addSuppressed(failure)}
            if(cleanup!=null){if(primary!=null)primary!!.addSuppressed(cleanup!!)else throw cleanup!!}
        }
    }
}
