package app.lazysh.client

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The real terminal core (`lazysh-terminal-runtime`, libghostty-vt) running inside the app on Android (#2145), the
 * S1 blocker "the core has never run on Android". The page of the real [MainActivity] makes the renderer's own IPC
 * calls: `terminal_core_open`, an SSH `connect` to an owned OpenSSH on the host (the local process whose shell
 * output is fed to the core, over `adb reverse`), `terminal_core_text` and `terminal_core_input`. The WebView
 * never receives the output: only the Rust core, built with the `native-terminal` feature, holds the rows read
 * back, so a library built without it fails here at `terminal_core_open`. No renderer, surface or keyboard is
 * involved; the host harness is tests/support/androidTerminalCore.ts.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalCoreTest {
    private val fixture by lazy { ownedSshFixture() }
    private val hostId by lazy { "core-${fixture.getString("nonce")}" }
    private var sessionId: String? = null

    @Before fun unlockedPage() { PageDriver.awaitStartPage() }

    @After fun closeWhatTheTestOpened() {
        sessionId?.let { id ->
            runCatching { PageDriver.invoke("terminal_core_close", "{sessionId:${JSONObject.quote(id)}}") }
            runCatching { PageDriver.invoke("disconnect", "{sessionId:${JSONObject.quote(id)}}") }
        }
        runCatching { PageDriver.invoke("delete_host", "{hostId:${JSONObject.quote(hostId)}}") }
    }

    /** What the page would pass for a `Channel`: the id of a registered callback, in the string form the IPC accepts. */
    private fun channel() = PageDriver.js("'__CHANNEL__:' + window.__TAURI_INTERNALS__.transformCallback(() => {})").trim('"')

    private fun text() = JSONArray("[" + PageDriver.invoke("terminal_core_text", "{sessionId:${JSONObject.quote(sessionId)}}") + "]").getString(0)

    /** The screen once a row of it is exactly `row`, so an echo of the command typed to produce it never counts. */
    private fun awaitRow(row: String) = PageDriver.poll("the row $row on the core's screen", 60) {
        text().takeIf { screen -> screen.lines().any { it.trim() == row } }
    }

    private fun probe(): JSONObject {
        val started = System.nanoTime()
        val answer = JSONObject(PageDriver.invoke("native_terminal_probe"))
        // What the page waited for, the IPC round trip and the blocking task's start included, beside the probe's own `elapsedMs`.
        return answer.put("waitedMs", (System.nanoTime() - started) / 1_000_000)
    }

    /**
     * What the probe says about this device (#2093, #2094): under the shipping policy, which refuses a CPU rasterizer, and under the debug
     * build's instrumentation switch (the CI emulator has no other adapter). The first
     * call is the cold one, the cost a launch pays; both answers, every adapter seen and the costs are the evidence the job keeps.
     */
    @Test fun theProbeRefusesASoftwareRasterizerUnlessTheDebugSwitchAllowsOne() {
        val previous = NativeSoftwareGpu.swap(false)
        val (shipping, withSwitch) = try {
            val shipping = probe()
            NativeSoftwareGpu.swap(true)
            shipping to probe()
        } finally {
            NativeSoftwareGpu.swap(previous)
        }
        Evidence.record("native-probe", JSONObject()
            .put("device", JSONObject().put("model", Build.MODEL).put("hardware", Build.HARDWARE).put("abi", Build.SUPPORTED_ABIS[0])
                .put("sdk", Build.VERSION.SDK_INT).put("fingerprint", Build.FINGERPRINT))
            .put("shippingPolicy", shipping).put("debugSoftwareSwitch", withSwitch))

        assertTrue("the debug switch finds an adapter that can create a device: $withSwitch", withSwitch.getBoolean("available"))
        val chosen = withSwitch.getJSONObject("adapter")
        if (shipping.getBoolean("available")) {
            assertFalse("the shipping policy never chooses a CPU rasterizer: $shipping", shipping.getJSONObject("adapter").getString("deviceType") == "Cpu")
        } else {
            // A device whose only adapter is a rasterizer is refused for that, and the switch is what lets it draw.
            assertTrue("the refusal names a device with no hardware GPU: $shipping", shipping.getString("reason").contains("no hardware GPU"))
            assertTrue("the switch's adapter is a rasterizer: $withSwitch", chosen.getString("deviceType") == "Cpu")
        }
        assertTrue("the answer lists the adapters it saw: $withSwitch", withSwitch.getJSONArray("seen").length() > 0)
    }

    @Test fun theCoreInsideTheAppParsesTheOutputOfARealShellAndReadsItBack() {
        val events = channel()
        val connect = """{hostId:${JSONObject.quote(hostId)},privateKey:${JSONObject.quote(fixture.getString("privateKey"))},cols:80,rows:24,events:'$events'}"""
        val saved = JSONObject(PageDriver.invoke("save_host", """{host:{id:${JSONObject.quote(hostId)},name:'Terminal core',hostname:'127.0.0.1',port:${fixture.getInt("port")},username:${JSONObject.quote(fixture.getString("username"))}}}"""))
        assertEquals(hostId, saved.getString("id"))
        // The first connect refuses an unknown host key and remembers the one it saw; trusting it is what the user's tap does.
        val refused = PageDriver.invoke("connect", connect)
        assertTrue("an unknown host key is refused: $refused", refused.startsWith("error ") && refused.contains(fixture.getString("fingerprint")))
        assertEquals("null", PageDriver.invoke("trust_host_key", "{hostId:${JSONObject.quote(hostId)},fingerprint:${JSONObject.quote(fixture.getString("fingerprint"))}}"))

        assertEquals("the real core is built into this library", "null", PageDriver.invoke("terminal_core_open", "{events:'$events',cols:80,rows:24}"))
        sessionId = JSONObject(PageDriver.invoke("connect", connect)).getString("sessionId")
        awaitRow(fixture.getString("prompt").trim())

        // The program prints the marker only when it runs the typed command; the typed line itself never equals it.
        val typed = PageDriver.invoke("terminal_core_input", """{sessionId:${JSONObject.quote(sessionId)},input:{type:'text',text:${JSONObject.quote(fixture.getString("challenge") + "\r")}}}""")
        assertEquals("the typed command reaches the shell through the core", (fixture.getString("challenge").length + 1).toString(), typed)
        val screen = awaitRow(fixture.getString("expected"))
        assertTrue("the prompt is still on the screen: $screen", screen.contains(fixture.getString("prompt").trim()))
    }
}
