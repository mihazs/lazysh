package app.lazysh.client

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import android.app.KeyguardManager
import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import androidx.lifecycle.Lifecycle
import android.accessibilityservice.AccessibilityServiceInfo
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue

/**
 * Keep the native event loop alive until instrumentation itself terminates.
 * Closing the last Tauri activity intentionally exits the Android process,
 * which also hosts AndroidJUnitRunner and would discard its test results.
 * Activity recreation remains covered separately, through configuration change.
 */
internal object NativeActivityFixture {
    val scenario: ActivityScenario<MainActivity> by lazy {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        Log.i("lazysh-instrumentation", "Before launch: interactive=${power.isInteractive}, keyguardLocked=${keyguard.isKeyguardLocked}, deviceSecure=${keyguard.isDeviceSecure}")
        // Standard isolated-device setup; does not disable or bypass a secure lock.
        if (!power.isInteractive) {
            val down = SystemClock.uptimeMillis()
            for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
                val event = KeyEvent(down, SystemClock.uptimeMillis(), action, KeyEvent.KEYCODE_WAKEUP,
                    0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
                assertTrue("Test device rejected the wake event", instrumentation.uiAutomation.injectInputEvent(event, true))
            }
        }
        ActivityScenario.launch(MainActivity::class.java).also { scenario ->
            scenario.onActivity { activity ->
                if (keyguard.isKeyguardLocked) {
                    assertFalse("Unlock the dedicated test device before instrumentation", keyguard.isDeviceSecure)
                    check(Build.VERSION.SDK_INT >= 26) { "Unlock this test device before instrumentation on Android below API26" }
                    keyguard.requestDismissKeyguard(activity, null)
                }
            }
            Log.i("lazysh-instrumentation", "After launch: ${readiness(scenario)}")
        }
    }

    data class Readiness(val activityState: Lifecycle.State, val interactive: Boolean, val keyguardLocked: Boolean, val deviceSecure: Boolean,
                         val windowFocused: Boolean, val attached: Boolean, val finishing: Boolean) {
        val ready get() = activityState == Lifecycle.State.RESUMED && interactive && !keyguardLocked && windowFocused && attached && !finishing
    }
    fun readiness(scenario: ActivityScenario<MainActivity>): Readiness {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        val activityState = scenario.state
        lateinit var result: Readiness
        scenario.onActivity { activity ->
            result = Readiness(activityState, power.isInteractive, keyguard.isKeyguardLocked, keyguard.isDeviceSecure,
                activity.hasWindowFocus(), activity.window.decorView.isAttachedToWindow, activity.isFinishing)
        }
        return result
    }
    private fun windowField(value: CharSequence?): String = value?.take(128)?.toString() ?: "unavailable"

    private fun rootIdentity(root: AccessibilityNodeInfo?): JSONObject {
        val result = JSONObject()
        if (root == null) return result.put("unavailable", true)
        try {
            result.put("package", windowField(root.packageName)).put("class", windowField(root.className))
        } catch (_: Exception) { result.put("unavailable", true) }
        finally {
            try { root.recycle() } catch (_: Exception) { result.put("recycleUnavailable", true) }
        }
        return result
    }

    // Failure-only window metadata: no node text, descendants, DOM or input actions.
    fun windowDiagnostics(): String {
        return try {
            val result = JSONObject()
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            val info = automation.serviceInfo ?: return "unavailable"
            val originalFlags = info.flags
            val inspectionFlag = AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
            val restore = originalFlags and inspectionFlag == 0
            try {
                if (restore) {
                    info.flags = originalFlags or inspectionFlag
                    automation.serviceInfo = info
                }
                try { result.put("activeRoot", rootIdentity(automation.rootInActiveWindow)) }
                catch (_: Exception) { result.put("activeRootUnavailable", true) }
                val windows = automation.windows
                try {
                    val identities = JSONArray()
                    for (window in windows.take(8)) {
                        val identity = JSONObject()
                        try {
                            identity.put("type", window.type).put("title", windowField(window.title))
                                .put("focused", window.isFocused).put("active", window.isActive)
                                .put("root", rootIdentity(window.root))
                        } catch (_: Exception) { identity.put("unavailable", true) }
                        identities.put(identity)
                    }
                    result.put("windows", identities).put("truncated", windows.size > 8)
                } finally {
                    for (window in windows) {
                        try { window.recycle() } catch (_: Exception) { result.put("recycleUnavailable", true) }
                    }
                }
            } catch (_: Exception) { result.put("unavailable", true) }
            finally {
                if (restore) {
                    try { info.flags = originalFlags; automation.serviceInfo = info }
                    catch (_: Exception) { result.put("restorationUnavailable", true) }
                }
            }
            result.toString()
        } catch (_: Exception) { "unavailable" }
    }
}
