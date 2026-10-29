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
import androidx.test.uiautomator.Configurator
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

private class NtfyFirstLaunch(started: Long) {
    val deadline = started + TimeUnit.SECONDS.toNanos(6)
    var attempted = false
        private set
    fun active(now: Long) = now < deadline
    fun allow(now: Long, ownedPrompt: Boolean): Boolean {
        if (!active(now) || !ownedPrompt || attempted) return false
        attempted = true
        return true
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

    private fun awaitUnlockedWorkspace(scenario: ActivityScenario<MainActivity>, stage: String) =
        awaitDocument(scenario, stage, """Boolean(window.__TAURI_INTERNALS__?.invoke) && Boolean(document.querySelector("button[aria-label='Add host']"))""")

    private fun awaitDocument(scenario: ActivityScenario<MainActivity>, stage: String, expression: String,
        observe: ((Long) -> String)? = null) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        var firstObservation: String? = null
        var lastObservation: String? = null
        while (true) {
            val native = NativeActivityFixture.readiness(scenario)
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
                // A late renderer callback cannot establish a match within the shared budget.
                if (timing.settledBeforeDeadline()) break
                Thread.sleep(50)
            }
        } catch (failure: Throwable) {
            // Metadata must never replace the original assertion/type/cause.
            runCatching { failure.addSuppressed(AssertionError("Native typing timing: ${timing.report(System.nanoTime())}")) }
            throw failure
        }
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
        val draftSelector = "[aria-label='Theme JSON or share code']"
        val draft = "manual owned QR draft stays literal"
        var permissionController: String? = null
        fun permission(id: String) {
            val expected = when (id) {
                "permission_deny_button" -> PackageManager.PERMISSION_DENIED
                "permission_allow_foreground_only_button" -> PackageManager.PERMISSION_GRANTED
                else -> throw AssertionError("Unsupported owned camera permission choice")
            }
            val progress = QrPermissionProgress(System.nanoTime(), expected)
            val selector = permissionController?.let { By.res(it, id) }
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
                if (permissionController == null) permissionController = owner
                assertEquals("Permission choices must retain the same system owner", permissionController, owner)
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
                try { println("lazysh QR permission: ${progress.report(System.nanoTime())}") } catch (_: Throwable) { }
            }
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
            awaitDocument(scenario, "actual Rust-decoded QR preview", "document.querySelector('.theme-preview h3')?.textContent==='QR fixture'", qrVideoObservation(scenario, frame))
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

    // Called only from the real, authenticated owned-SSH UI flow below. Native
    // Window reads observe the shipping plugin; no test fixture changes its flag.
    private fun verifyBoardKeepAwake(scenario: ActivityScenario<MainActivity>) {
        val checkbox = ".keep-awake-control input[type=checkbox]"
        val active = "This board owns an acknowledged idle-inhibition request."
        val off = "Keep awake is off."
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
        fun view(name: String) {
            onWebView().withElement(findElement(Locator.XPATH,
                "//nav[contains(@class,'view-tabs')]/button[span[normalize-space(text())='$name']]"))
                .perform(webScrollIntoView()).perform(webClick())
        }
        fun toggle() {
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, checkbox))
                .perform(webScrollIntoView()).perform(webClick())
        }
        fun status(text: String) = "Array.from(document.querySelectorAll('.keep-awake-control [role=status]')).some(x=>x.textContent===${JSONObject.quote(text)})"
        fun awaitActive(stage: String) {
            awaitDocument(scenario, stage, "document.querySelector('$checkbox')?.checked===true && ${status(active)}")
            awaitFlag(true, stage)
        }
        var primaryFailure: Throwable? = null
        try {
            awaitFlag(false, "connected terminal before opt-in")
            view("Agents")
            awaitDocument(scenario, "board keep-awake available and off",
                "Boolean(document.querySelector('$checkbox:not(:disabled)')) && document.querySelector('$checkbox').checked===false && ${status(off)}")
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
            view("Terminal")
            awaitDocument(scenario, "board unmounted", "!document.querySelector('.keep-awake-control')")
            awaitFlag(false, "leaving board")
            view("Agents")
            awaitActive("persisted opt-in on new board mount")
            toggle()
            awaitDocument(scenario, "final explicit board off", status(off))
            awaitFlag(false, "final explicit board off")
            assertEquals("Owned board preference must finish off", "true", evaluate(scenario,
                "localStorage.getItem('lazysh.agent-board.keep-awake.v1')==='false'"))
            println("lazysh board keep-awake: packaged opt-in/off, background/foreground and board unmount/remount verified against actual Window flag")
        } catch (failure: Throwable) {
            primaryFailure = failure
            runCatching { failure.addSuppressed(AssertionError("Board readiness after failure: ${BoardReadinessObservation.collect(observedActivity, ::webView)}")) }
            throw failure
        } finally {
            try {
                if (scenario.state != androidx.lifecycle.Lifecycle.State.RESUMED)
                    scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED)
                if (evaluate(scenario, "document.querySelector('$checkbox')?.checked===true") == "true") toggle()
                view("Terminal")
                awaitFlag(false, "owned board cleanup")
            } catch (cleanup: Throwable) {
                if (primaryFailure != null) primaryFailure.addSuppressed(AssertionError("Owned board keep-awake cleanup also failed"))
                else throw cleanup
            }
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
            verifyBoardKeepAwake(scenario)
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

    @Test fun ownedNtfyFirstLaunchBudgetAndOneTimePermissionPolicy() {
        val policy=NtfyFirstLaunch(0)
        assertTrue("Unowned permission cannot be admitted",!policy.allow(TimeUnit.SECONDS.toNanos(1),false))
        assertTrue("Delayed owned prompt fits original combined budget",policy.allow(TimeUnit.SECONDS.toNanos(5),true))
        assertTrue("Permission action is consumed before dispatch",!policy.allow(TimeUnit.SECONDS.toNanos(5),true))
        assertTrue("Menu must settle before original total deadline",!policy.active(TimeUnit.SECONDS.toNanos(6)))
        assertTrue("Expired policy cannot dispatch",!NtfyFirstLaunch(0).allow(TimeUnit.SECONDS.toNanos(6),true))
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
    }

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
        private val at=AtomicReference<Long?>(null)
        private val clocks=java.util.concurrent.atomic.AtomicInteger()
        @Synchronized fun increment(counter:java.util.concurrent.atomic.AtomicInteger) {counter.updateAndGet {minOf(it+1,2)}}
        fun count(counter:java.util.concurrent.atomic.AtomicInteger)=when(counter.get()) {0->"zero";1->"one";else->"many"}
        fun clock(original:()->Long):Long {
            val value=original()
            synchronized(this) {increment(clocks);at.set(value)}
            return value
        }
        @Synchronized fun clockCategory(window:Pair<Long,Long>?):String {
            // Multiple callbacks cannot be collapsed into one clock decision.
            if(reads.get()!=1 || returnedReads.get()!=1 || clocks.get()!=1)return "unavailable"
            val value=at.get() ?: return "unavailable"
            val high=highWater.get() ?: return "unavailable"
            if(value<0)return "negative"
            if(value<high)return "rollback"
            val bounds=window ?: return "unavailable"
            return when {value<bounds.first->"beforeIssued";value>=bounds.second->"expired";else->"withinWindow"}
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
        while(firstLaunch.active(System.nanoTime())) {
            foreground=when(device.currentPackageName) {"io.heckel.ntfy"->"ntfy";"com.android.permissioncontroller"->"permission";"app.lazysh.client"->"lazysh";else->"other"}
            val choice=device.findObject(By.res("com.android.permissioncontroller","permission_allow_button"))
            allow=choice!=null
            deny=device.hasObject(By.res("com.android.permissioncontroller","permission_deny_button"))
            toolbar=device.hasObject(ntfyResource("toolbar"))
            val prompt=device.findObject(By.res("com.android.permissioncontroller","permission_message"))?.text
            ownedPrompt=foreground=="permission" && prompt?.contains(Regex("\\bntfy\\b"))==true && prompt?.contains("notifications",ignoreCase=true)==true
            menu=device.findObject(menuSelector)
            if(foreground=="ntfy" && menu!=null && firstLaunch.active(System.nanoTime())) break
            if(firstLaunch.allow(System.nanoTime(),ownedPrompt && allow))checkNotNull(choice).click()
            val remaining=firstLaunch.deadline-System.nanoTime()
            if(remaining>0)Thread.sleep(TimeUnit.NANOSECONDS.toMillis(remaining).coerceIn(1,20))
        }
        assertTrue("Distributor menu; foreground=$foreground allow=$allow deny=$deny toolbar=$toolbar ownedPrompt=$ownedPrompt attempted=${firstLaunch.attempted}",
            foreground=="ntfy" && menu!=null && firstLaunch.active(System.nanoTime()))
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
        node(ntfyResource("default_server_dialog_action_save"),"Save owned default server").click()
        device.pressBack()
        node(By.pkg("io.heckel.ntfy").desc("Add subscription"),"Owned TLS trust topic").click()
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
                return issued to expires
            } finally {connection.disconnect()}
        }
        signal("background")
        val confirmedDeadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(15)
        while(phase(state())!="CONFIRMED" && System.nanoTime()<confirmedDeadline)Thread.sleep(20)
        val confirmed=state()
        assertTrue("Real SDK challenge must confirm native state",phase(confirmed)=="CONFIRMED")
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
                    " storedEnabled=${eventRead.storedEnabled.get()} clock=${eventRead.clockCategory(eventWindow)}]"
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
        assertTrue("Exactly one native registration transport must be packaged", google != unified)
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
          return result.ok===true && status?.provider===${JSONObject.quote(if (google) "fcm" else "unifiedpush")} &&
            status.supported===true && (${google} || (status.configured===false && status.enabled===false &&
              status.tokenPresent===false && status.busy===false && status.reason.includes('distributor') &&
              status.reason.includes('No delivery service')));
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

}
