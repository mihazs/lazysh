package app.lazysh.acceptance

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/** External accessibility actions only: the release application is never instrumented. */
@RunWith(AndroidJUnit4::class)
class PublishedApkTest {
    private enum class Stage {
        ARGUMENTS, DEVICE_ADMISSION, LAUNCH, LAUNCH_WINDOW, WORKSPACE, WORKSPACE_READINESS, WORKSPACE_ADD_HOST,
        DRAWER, ADD_HOST, NAME, HOSTNAME, USERNAME,
        KEYBOARD, SCROLL_OWNER, FORM_SCROLL, SAVE_HOST, SAVED_HOST, EDIT_HOST, READBACK, COMPLETE,
    }
    private enum class InputOperation { NONE, LOOKUP, CLICK, SET, READBACK }
    private enum class InputField { NONE, NAME, HOSTNAME, USERNAME }
    private var inputOperation = InputOperation.NONE
    private var inputField = InputField.NONE
    private var readbackMatched: Boolean? = null
    private var readinessOutcome = "unavailable"
    private var readinessElapsedMs: Long? = null
    private var readinessPolls = 0
    private var readinessOverflow = false
    private var readinessAdd = "unavailable"
    private var readinessOpen = "unavailable"
    private var saveOperation = "unavailable"
    private var saveRaw = "unavailable"
    private var saveVisible = "unavailable"
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val target = "app.lazysh.client"
    // Actual admitted guests expose the implicit labels as exact Android hints.
    private val nameHint = "Name"
    private val hostnameHint = "Hostname or IP"
    private val usernameHint = "Username"
    private val deadline = System.nanoTime() + 45_000_000_000L

    private fun <T> stage(name: Stage, action: () -> T): T = try {
        check(System.nanoTime() < deadline)
        action()
    } catch (failure: Throwable) {
        // Retain a nested owned stage; discard every arbitrary framework detail.
        val closed = Stage.entries.firstOrNull {
            failure is AssertionError && failure.message == "Published APK UI: ${it.name}"
        } ?: name
        throw AssertionError("Published APK UI: ${closed.name}")
    }

    private fun waitMillis(): Long = ((deadline - System.nanoTime()) / 1_000_000L).coerceIn(1, 5_000)
    private fun captions(caption: String, current: UiDevice = device): List<UiObject2> {
        val traceSave = caption == "Save host" && saveOperation == "lookup"
        if (traceSave) { saveRaw = "unavailable"; saveVisible = "unavailable" }
        val found = (current.findObjects(By.pkg(target).text(caption)) + current.findObjects(By.pkg(target).desc(caption))).distinct()
        if (traceSave) saveRaw = matchCount(found.size)
        val visible = found.filter { !it.visibleBounds.isEmpty }
        if (traceSave) saveVisible = matchCount(visible.size)
        return visible
    }

    private fun matchCount(count: Int) = when (count) {
        0 -> "zero"
        1 -> "one"
        else -> "multiple"
    }

    private fun named(caption: String, at: Stage): UiObject2 = stage(at) {
        checkNotNull(device.wait(Condition<UiDevice, UiObject2?> { current ->
            val found = captions(caption, current)
            check(found.size <= 1)
            found.singleOrNull()
        }, waitMillis()))
    }

    private fun input(hint: String, at: Stage): UiObject2 = stage(at) {
        checkNotNull(device.wait(Condition<UiDevice, UiObject2?> { current ->
            val found = current.findObjects(By.pkg(target).clazz("android.widget.EditText").hint(hint))
            check(found.size <= 1)
            found.singleOrNull()
        }, waitMillis()))
    }

    private fun fieldFor(hint: String) = when (hint) {
        nameHint -> InputField.NAME
        hostnameHint -> InputField.HOSTNAME
        usernameHint -> InputField.USERNAME
        else -> InputField.NONE
    }

    private fun verifyInput(hint: String, value: String, at: Stage) {
        inputField = fieldFor(hint); inputOperation = InputOperation.READBACK; readbackMatched = null
        val matched = input(hint, at).text == value
        readbackMatched = matched
        check(matched)
    }

    private fun clearInputObservation() {
        inputOperation = InputOperation.NONE; inputField = InputField.NONE; readbackMatched = null
    }

    private fun setInput(hint: String, value: String, at: Stage) = stage(at) {
        inputField = fieldFor(hint); inputOperation = InputOperation.LOOKUP; readbackMatched = null
        val field = input(hint, at)
        inputOperation = InputOperation.CLICK; field.click()
        inputOperation = InputOperation.SET; field.text = value
        verifyInput(hint, value, at)
        clearInputObservation()
    }

    private fun hintShape(hint: String?) = when (hint) {
        null, "" -> "empty"
        "Name" -> "name-label"
        "Home workstation" -> "name-placeholder"
        "Name Home workstation" -> "name-label-placeholder"
        "Hostname or IP" -> "hostname-label"
        "workstation.local" -> "hostname-placeholder"
        "Hostname or IP workstation.local" -> "hostname-label-placeholder"
        "Username" -> "username-label"
        "Your SSH username" -> "username-placeholder"
        "Username Your SSH username" -> "username-label-placeholder"
        else -> "other"
    }

    private fun failureObservation(): String {
        fun captionMatches(caption: String): String {
            if (System.nanoTime() >= deadline) return "unavailable"
            return runCatching { matchCount(captions(caption).size) }.getOrDefault("unavailable")
        }
        val foreground = runCatching { when (device.currentPackageName) {
            target -> "target"
            instrumentation.context.packageName -> "driver"
            else -> "other"
        } }.getOrDefault("unavailable")
        val fields = if (System.nanoTime() < deadline) runCatching {
            device.findObjects(By.pkg(target).clazz("android.widget.EditText"))
        }.getOrNull() else null
        val shapes = JSONArray()
        fields?.take(8)?.forEach { field -> shapes.put(runCatching { hintShape(field.hint) }.getOrDefault("unavailable")) }
        val addHostMatches = captionMatches("Add host")
        val openHostsMatches = captionMatches("Open hosts")
        val webView = if (System.nanoTime() < deadline) runCatching {
            device.hasObject(By.pkg(target).clazz("android.webkit.WebView"))
        }.getOrNull() else null
        return JSONObject().put("inputOperation", inputOperation.name).put("inputField", inputField.name)
            .put("readbackMatched", readbackMatched ?: JSONObject.NULL).put("foreground", foreground)
            .put("screenOn", runCatching { device.isScreenOn }.getOrNull() ?: JSONObject.NULL)
            .put("keyguardLocked", runCatching { instrumentation.context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked }.getOrNull() ?: JSONObject.NULL)
            .put("editableCount", fields?.size?.coerceAtMost(8) ?: JSONObject.NULL)
            .put("editableOverflow", fields?.let { it.size > 8 } ?: JSONObject.NULL).put("hintShapes", shapes)
            .put("addHostMatches", addHostMatches).put("openHostsMatches", openHostsMatches)
            .put("webView", webView ?: JSONObject.NULL)
            .put("readiness", JSONObject().put("outcome", readinessOutcome)
                .put("elapsedMs", readinessElapsedMs ?: JSONObject.NULL).put("polls", readinessPolls)
                .put("overflow", readinessOverflow).put("lastAdd", readinessAdd).put("lastOpen", readinessOpen))
            .put("save", JSONObject().put("operation", saveOperation).put("raw", saveRaw).put("visible", saveVisible))
            .toString().also { check(it.length <= 2048) }
    }

    private fun hideKeyboard() = stage(Stage.KEYBOARD) {
        val selector = By.Window.type(AccessibilityWindowInfo.TYPE_INPUT_METHOD)
        if (device.hasWindow(selector)) {
            device.pressBack()
            check(device.wait(Condition<UiDevice, Boolean> { !it.hasWindow(selector) }, waitMillis()))
        }
    }

    private fun workspace() = stage(Stage.WORKSPACE) {
        stage(Stage.WORKSPACE_READINESS) {
            readinessOutcome = "unavailable"; readinessElapsedMs = null
            readinessPolls = 0; readinessOverflow = false
            readinessAdd = "unavailable"; readinessOpen = "unavailable"
            val started = System.nanoTime()
            try {
                val ready = device.wait(Condition<UiDevice, Boolean> { current ->
                    if (readinessPolls < 64) readinessPolls++ else readinessOverflow = true
                    readinessAdd = "unavailable"; readinessOpen = "unavailable"
                    captions("Add host", current).also { readinessAdd = matchCount(it.size) }.isNotEmpty() ||
                        captions("Open hosts", current).also { readinessOpen = matchCount(it.size) }.isNotEmpty()
                }, waitMillis())
                readinessOutcome = if (ready) "true" else "false"
                check(ready)
            } catch (failure: Throwable) {
                if (readinessOutcome == "unavailable") readinessOutcome = "exception"
                throw failure
            } finally {
                readinessElapsedMs = ((System.nanoTime() - started) / 1_000_000L).coerceIn(0, 60_000)
            }
        }
        if (captions("Add host").isEmpty()) stage(Stage.DRAWER) { named("Open hosts", Stage.DRAWER).click() }
        named("Add host", Stage.WORKSPACE_ADD_HOST)
    }

    private fun revealSave(name: String) = stage(Stage.FORM_SCROLL) {
        check(device.currentPackageName == target)
        fun visible(): Boolean {
            val matches = captions("Save host")
            check(matches.size <= 1)
            return matches.size == 1
        }
        if (visible()) return@stage
        val owner = stage(Stage.SCROLL_OWNER) {
            val anchor = input(nameHint, Stage.SCROLL_OWNER)
            check(anchor.text == name)
            var cursor = anchor
            var reachedWebView = false
            val candidates = mutableListOf<UiObject2>()
            for (depth in 1..16) {
                val parent = checkNotNull(cursor.parent)
                check(parent.applicationPackage == target)
                if (parent.className == "android.webkit.WebView") {
                    reachedWebView = true
                    break
                }
                if (parent.isScrollable) candidates.add(parent)
                cursor = parent
            }
            check(reachedWebView && candidates.size == 1)
            candidates.single()
        }
        repeat(4) {
            check(System.nanoTime() < deadline)
            check(device.currentPackageName == target && owner.applicationPackage == target && owner.isScrollable)
            check(!owner.visibleBounds.isEmpty)
            check(System.nanoTime() < deadline)
            owner.scroll(Direction.DOWN, 0.8f)
            if (visible()) return@stage
        }
    }

    @Test(timeout = 60_000)
    fun publishedHost() {
        try { runPublishedHost() } catch (failure: Throwable) {
            // Observation failure must never replace the original closed UI failure.
            runCatching { instrumentation.sendStatus(0, Bundle().apply {
                putString("lazyshPublishedObservation", failureObservation())
            }) }
            throw failure
        }
    }

    private fun runPublishedHost() {
        val arguments = InstrumentationRegistry.getArguments()
        val phase = stage(Stage.ARGUMENTS) {
            arguments.getString("phase").also { check(it == "create" || it == "verify") }!!
        }
        val name = stage(Stage.ARGUMENTS) {
            val nonce = arguments.getString("nonce")
            check(nonce != null && nonce.matches(Regex("[a-f0-9]{32}")))
            "owned-$nonce"
        }
        stage(Stage.DEVICE_ADMISSION) {
            check(device.isScreenOn)
            val keyguard = instrumentation.context.getSystemService(KeyguardManager::class.java)
            check(keyguard != null && !keyguard.isKeyguardLocked)
        }
        stage(Stage.LAUNCH) {
            val intent = instrumentation.context.packageManager.getLaunchIntentForPackage(target)
            check(intent?.component?.packageName == target)
            instrumentation.context.startActivity(checkNotNull(intent).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        stage(Stage.LAUNCH_WINDOW) {
            val remaining = (deadline - System.nanoTime()) / 1_000_000L
            check(remaining > 0)
            check(device.wait(Condition<UiDevice, Boolean> { current ->
                current.currentPackageName == target && current.hasObject(By.pkg(target).depth(0))
            }, remaining))
        }
        workspace()
        if (phase == "create") {
            stage(Stage.ADD_HOST) {
                check(captions("Edit $name").isEmpty())
                named("Add host", Stage.ADD_HOST).click()
            }
            setInput(nameHint, name, Stage.NAME)
            setInput(hostnameHint, "$name.invalid", Stage.HOSTNAME)
            setInput(usernameHint, "owned", Stage.USERNAME)
            hideKeyboard()
            revealSave(name)
            stage(Stage.SAVE_HOST) {
                saveOperation = "lookup"
                val button = named("Save host", Stage.SAVE_HOST)
                saveOperation = "click"
                button.click()
                saveOperation = "complete"
            }
        }
        named("Edit $name", Stage.SAVED_HOST)
        stage(Stage.EDIT_HOST) { named("Edit $name", Stage.EDIT_HOST).click() }
        stage(Stage.READBACK) {
            verifyInput(nameHint, name, Stage.READBACK)
            verifyInput(hostnameHint, "$name.invalid", Stage.READBACK)
            verifyInput(usernameHint, "owned", Stage.READBACK)
            clearInputObservation()
        }
        stage(Stage.COMPLETE) {
            instrumentation.sendStatus(0, Bundle().apply {
                putString("lazyshPublishedPhase", phase)
                putString("lazyshPublishedPassed", "true")
            })
        }
    }
}
