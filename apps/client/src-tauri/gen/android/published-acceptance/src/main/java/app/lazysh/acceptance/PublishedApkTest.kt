package app.lazysh.acceptance

import android.app.KeyguardManager
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Condition
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
        ARGUMENTS, DEVICE_ADMISSION, LAUNCH, WORKSPACE, DRAWER, ADD_HOST, NAME, HOSTNAME, USERNAME,
        KEYBOARD, SAVE_HOST, SAVED_HOST, EDIT_HOST, READBACK, COMPLETE,
    }
    private enum class InputOperation { NONE, LOOKUP, CLICK, SET, READBACK }
    private enum class InputField { NONE, NAME, HOSTNAME, USERNAME }
    private var inputOperation = InputOperation.NONE
    private var inputField = InputField.NONE
    private var readbackMatched: Boolean? = null
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
    private fun captions(caption: String, current: UiDevice = device): List<UiObject2> =
        (current.findObjects(By.pkg(target).text(caption)) + current.findObjects(By.pkg(target).desc(caption)))
            .distinct().filter { !it.visibleBounds.isEmpty }

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
        return JSONObject().put("inputOperation", inputOperation.name).put("inputField", inputField.name)
            .put("readbackMatched", readbackMatched ?: JSONObject.NULL).put("foreground", foreground)
            .put("screenOn", runCatching { device.isScreenOn }.getOrNull() ?: JSONObject.NULL)
            .put("keyguardLocked", runCatching { instrumentation.context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked }.getOrNull() ?: JSONObject.NULL)
            .put("editableCount", fields?.size?.coerceAtMost(8) ?: JSONObject.NULL)
            .put("editableOverflow", fields?.let { it.size > 8 } ?: JSONObject.NULL).put("hintShapes", shapes)
            .toString().also { check(it.length <= 2048) }
    }

    private fun hideKeyboard() = stage(Stage.KEYBOARD) {
        val selector = By.Window.type(AccessibilityWindowInfo.TYPE_INPUT_METHOD)
        if (device.hasWindow(selector)) {
            check(device.pressBack())
            check(device.wait(Condition<UiDevice, Boolean> { !it.hasWindow(selector) }, waitMillis()))
        }
    }

    private fun workspace() = stage(Stage.WORKSPACE) {
        check(device.wait(Condition<UiDevice, Boolean> {
            captions("Add host", it).isNotEmpty() || captions("Open hosts", it).isNotEmpty()
        }, waitMillis()))
        if (captions("Add host").isEmpty()) stage(Stage.DRAWER) { named("Open hosts", Stage.DRAWER).click() }
        named("Add host", Stage.WORKSPACE)
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
            stage(Stage.SAVE_HOST) { named("Save host", Stage.SAVE_HOST).click() }
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
