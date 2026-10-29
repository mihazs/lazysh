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
import org.junit.Test
import org.junit.runner.RunWith

/** External accessibility actions only: the release application is never instrumented. */
@RunWith(AndroidJUnit4::class)
class PublishedApkTest {
    private enum class Stage {
        ARGUMENTS, DEVICE_ADMISSION, LAUNCH, WORKSPACE, DRAWER, ADD_HOST, NAME, HOSTNAME, USERNAME,
        KEYBOARD, SAVE_HOST, SAVED_HOST, EDIT_HOST, READBACK, COMPLETE,
    }
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instrumentation)
    private val target = "app.lazysh.client"
    // Chromium's Android hint joins the implicit label and placeholder.
    private val nameHint = "Name Home workstation"
    private val hostnameHint = "Hostname or IP workstation.local"
    private val usernameHint = "Username Your SSH username"
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

    private fun setInput(hint: String, value: String, at: Stage) = stage(at) {
        input(hint, at).apply { click(); text = value }
        check(input(hint, at).text == value)
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
            check(input(nameHint, Stage.READBACK).text == name)
            check(input(hostnameHint, Stage.READBACK).text == "$name.invalid")
            check(input(usernameHint, Stage.READBACK).text == "owned")
        }
        stage(Stage.COMPLETE) {
            instrumentation.sendStatus(0, Bundle().apply {
                putString("lazyshPublishedPhase", phase)
                putString("lazyshPublishedPassed", "true")
            })
        }
    }
}
