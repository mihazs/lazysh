package app.lazysh.client

import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.provider.Settings
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.hardware.biometrics.BiometricManager
import androidx.annotation.RequiresApi
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import app.lazysh.vault.VaultPlugin
import java.io.File
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import java.util.regex.Pattern
import javax.crypto.Cipher
import javax.crypto.IllegalBlockSizeException
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Owned enrolled-fingerprint acceptance. Only tests/support/androidBiometric.ts runs this class:
 * it sets a disposable PIN, passes its nonce and PIN, and answers each touch request with
 * `adb emu finger touch`, then clears the PIN (which also removes the enrolled fingerprint).
 */
@RunWith(AndroidJUnit4::class)
@RequiresApi(30)
class NativeBiometricVaultTest {
    companion object {
        private const val ENROLLED = 1
        private const val UNENROLLED = 2
        private const val PROMPT_TITLE = "Unlock lazysh credentials"
        // The cover's platform Button inherits the theme's all-caps button text appearance, and
        // accessibility exposes the displayed (transformed) text, so match the label case-insensitively.
        private val COVER_UNLOCK: Pattern = Pattern.compile(Pattern.quote("Unlock lazysh"), Pattern.CASE_INSENSITIVE)
        private const val COVER_FAILURE = "Unlock failed or was cancelled. lazysh remains locked. Check device biometrics and retry."
        private const val PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nbiometric-export-fixture\n-----END OPENSSH PRIVATE KEY-----"
        private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
        private val context: Context get() = instrumentation.targetContext
        private val device: UiDevice by lazy { UiDevice.getInstance(instrumentation) }
        private val arguments get() = InstrumentationRegistry.getArguments()
        private val nonce: String by lazy {
            requireNotNull(arguments.getString("lazyshBiometricNonce")?.takeIf { Regex("[0-9a-f]{32}").matches(it) }) {
                "Owned biometric acceptance requires its host driver"
            }
        }
        private val pin: String by lazy {
            requireNotNull(arguments.getString("lazyshBiometricPin")?.takeIf { Regex("[0-9]{6}").matches(it) }) {
                "Owned biometric acceptance requires the driver's disposable PIN"
            }
        }
        private var touches = 0
        private val hostId get() = "biometric-$nonce"
        private val hostName get() = "Biometric fixture ${nonce.take(8)}"
        private val fingerprint get() = "SHA256:biometric-fixture-$nonce"
        private val vaultKey get() = "host-" + hostId.toByteArray().joinToString("") { "%02x".format(it) }

        private fun shell(command: String): String =
            ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use {
                it.readBytes().toString(Charsets.UTF_8).trim()
            }

        /** Asks the host driver for one emulator touch and waits until it was delivered. */
        fun touch(finger: Int) {
            val sequence = ++touches
            shell("setprop debug.lazysh.biometric.request $nonce:$sequence:$finger")
            val deadline = SystemClock.uptimeMillis() + 30_000
            while (shell("getprop debug.lazysh.biometric.ack") != "$nonce:$sequence") {
                check(SystemClock.uptimeMillis() < deadline) { "Host driver did not deliver fingerprint touch $sequence" }
                Thread.sleep(100)
            }
        }

        @RequiresApi(30) fun strongBiometrics() = context.getSystemService(BiometricManager::class.java)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS

        @BeforeClass @JvmStatic fun enrollFingerprintAndSeedHost() {
            check(Build.VERSION.SDK_INT >= 30) { "Owned biometric acceptance requires the API 30+ authenticator contract" }
            assertTrue("The host driver must set a disposable PIN first",
                context.getSystemService(KeyguardManager::class.java).isDeviceSecure)
            enroll()
            // Rust reads the host catalog when the first Activity starts; seed it before launch.
            val catalog = File(context.dataDir, "hosts.json")
            val hosts = if (catalog.exists()) JSONArray(catalog.readText()) else JSONArray()
            hosts.put(JSONObject().put("id", hostId).put("name", hostName).put("hostname", "biometric.invalid")
                .put("port", 22).put("username", "fixture").put("fingerprint", fingerprint)
                .put("credentialsStored", true).put("biometricUnlock", true))
            catalog.writeText(hosts.toString())
        }

        /** Drives the stock Settings enrollment flow; only advancing labels are pressed. */
        @RequiresApi(30) private fun enroll() {
            if (strongBiometrics()) return
            val intent = Intent(Settings.ACTION_BIOMETRIC_ENROLL)
                .putExtra(Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED, BiometricManager.Authenticators.BIOMETRIC_STRONG)
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            val advance = Pattern.compile("(?i)^(i agree|agree|more|next|start|continue|ok|got it)$")
            val deadline = SystemClock.uptimeMillis() + 240_000
            var pinEntered = false
            while (!strongBiometrics()) {
                check(SystemClock.uptimeMillis() < deadline) { "Fingerprint enrollment did not complete after $touches touches" }
                device.waitForIdle(2_000)
                val pinField = if (pinEntered) null else device.findObject(By.clazz("android.widget.EditText").pkg("com.android.settings"))
                val button = device.findObject(By.text(advance).enabled(true))
                when {
                    pinField != null -> { pinField.text = pin; device.pressEnter(); pinEntered = true }
                    button != null -> button.click()
                    else -> touch(ENROLLED)
                }
                Thread.sleep(500)
            }
            device.wait(Until.findObject(By.text(Pattern.compile("(?i)^done$"))), 5_000)?.click()
            device.pressHome()
        }
    }

    private fun coverUnlock() = By.text(COVER_UNLOCK).pkg(context.packageName)
    /** Visible app labels, so a missing cover control reports what the native window shows instead. */
    private fun appLabels() = runCatching { device.findObjects(By.pkg(context.packageName)).mapNotNull { it.text } }
        .getOrElse { listOf("unavailable: ${it.javaClass.simpleName}") }

    private fun prompt(): UiObject2 =
        requireNotNull(device.wait(Until.findObject(By.text(PROMPT_TITLE)), 20_000)) { "Biometric prompt was not shown" }

    // A dismissed prompt's node goes stale; a following prompt with the same title is a new node.
    private fun closed(shown: UiObject2) = until("biometric prompt closed", 20) {
        runCatching { shown.text; false }.getOrDefault(true)
    }

    /** An unrecognised finger keeps the prompt and the operation open; only its Cancel ends it. */
    private fun rejectThenCancel(pending: () -> Boolean) {
        val shown = prompt()
        touch(UNENROLLED)
        Thread.sleep(1_500)
        assertTrue("An unenrolled finger must not complete authentication", pending())
        assertNotNull("Prompt must remain after an unrecognised finger", device.findObject(By.text(PROMPT_TITLE)))
        requireNotNull(device.findObject(By.text("Cancel").pkg(shown.applicationPackage))) { "Prompt Cancel unavailable" }.click()
        closed(shown)
    }

    private fun authenticate() { val shown = prompt(); touch(ENROLLED); closed(shown) }

    private fun preferences() = context.getSharedPreferences("lazysh-credentials", Context.MODE_PRIVATE)
    private fun keystore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun item(key: String, value: String? = null) =
        JSONObject().put("key", key).put("biometric", true).also { if (value != null) it.put("value", value) }

    private fun plugin(scenario: ActivityScenario<MainActivity>): VaultPlugin {
        lateinit var plugin: VaultPlugin
        scenario.onActivity { plugin = VaultPlugin(it) }
        return plugin
    }

    private fun protectedWrite(scenario: ActivityScenario<MainActivity>, plugin: VaultPlugin, key: String, value: String): String {
        val reply = scenario.startVault(plugin, "write", item(key, value))
        authenticate()
        val written = reply.await()
        assertTrue("Enrolled fingerprint must complete the protected write: ${written.json}", written.resolved)
        return requireNotNull(preferences().getString(key, null))
    }

    @Test fun enrolledFingerprintUnlocksAuthBoundKeystoreCredential() {
        val scenario = NativeActivityFixture.scenario
        val plugin = plugin(scenario)
        assertTrue(JSONObject(scenario.vault(plugin, "capability", JSONObject()).json).getBoolean("available"))
        val account = "instrumentation-biometric-${UUID.randomUUID()}"
        val secret = "enrolled biometric fixture ${UUID.randomUUID()}"
        val blob = protectedWrite(scenario, plugin, account, secret)
        val parts = blob.split(":")
        assertEquals("Protected entries name their own Keystore key", "v2b", parts[0])
        assertFalse(blob.contains(secret))
        val key = keystore().getKey(parts[1], null) as SecretKey
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        assertTrue("Key must require user authentication", info.isUserAuthenticationRequired)
        assertTrue("Key must be invalidated by new enrollment", info.isInvalidatedByBiometricEnrollment)
        @Suppress("DEPRECATION") assertTrue("Every use must authenticate", info.userAuthenticationValidityDurationSeconds <= 0)
        assertEquals(KeyProperties.AUTH_BIOMETRIC_STRONG, info.userAuthenticationType)
        val bypass = runCatching {
            Cipher.getInstance("AES/GCM/NoPadding").run {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(parts[2], Base64.NO_WRAP)))
                updateAAD(account.toByteArray(Charsets.UTF_8))
                doFinal(Base64.decode(parts[3], Base64.NO_WRAP))
            }
        }
        // A per-use key refuses init, or caches the Keystore's refusal of the AAD step for doFinal;
        // any other failure (decoding, parsing) would not prove the missing authentication.
        val refusal = bypass.exceptionOrNull()
        assertTrue("The Keystore must refuse to decrypt without a fingerprint: ${refusal?.javaClass?.name}/${refusal?.cause?.javaClass?.name}",
            refusal is UserNotAuthenticatedException ||
                (refusal is IllegalBlockSizeException && refusal.cause is android.security.KeyStoreException))
        val read = scenario.startVault(plugin, "read", item(account))
        authenticate()
        val unlocked = read.await()
        assertTrue("Enrolled fingerprint must complete the protected read: ${unlocked.json}", unlocked.resolved)
        assertEquals(secret, JSONObject(unlocked.json).getString("value"))
        assertTrue(scenario.vault(plugin, "remove", item(account)).resolved)
        assertFalse("Removal deletes the stored ciphertext", preferences().contains(account))
        assertFalse("Removal deletes the entry's Keystore key", keystore().containsAlias(parts[1]))
    }

    @Test fun unrecognisedFingerprintAndCancellationKeepCredentialLocked() {
        val scenario = NativeActivityFixture.scenario
        val plugin = plugin(scenario)
        val account = "instrumentation-biometric-cancel-${UUID.randomUUID()}"
        val secret = "cancelled biometric fixture ${UUID.randomUUID()}"
        val alias = protectedWrite(scenario, plugin, account, secret).split(":")[1]
        try {
            val userCancelled = scenario.startVault(plugin, "read", item(account))
            rejectThenCancel { userCancelled.pending }
            val refused = userCancelled.await()
            assertEquals(2L, refused.callback)
            assertFalse(refused.json.contains(secret))
            val appCancelled = scenario.startVault(plugin, "read", item(account).put("authEpoch", 0))
            val shown = prompt()
            scenario.vault(plugin, "cancel", JSONObject().put("authEpoch", 1))
            closed(shown)
            val stale = appCancelled.await()
            assertEquals("Native cancellation must refuse the outstanding read", 2L, stale.callback)
            assertFalse(stale.json.contains(secret))
            assertTrue("Cancellation never deletes the protected entry", keystore().containsAlias(alias))
            val retried = scenario.startVault(plugin, "read", item(account).put("authEpoch", 1))
            authenticate()
            assertEquals(secret, JSONObject(retried.await().json).getString("value"))
        } finally {
            assertTrue(scenario.vault(plugin, "remove", item(account).put("authEpoch", 1)).resolved)
        }
    }

    private fun webView(view: View): WebView? = when (view) {
        is WebView -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { webView(view.getChildAt(it)) }
        else -> null
    }

    private fun js(scenario: ActivityScenario<MainActivity>, expression: String): String {
        val result = AtomicReference<String>()
        val done = CountDownLatch(1)
        scenario.onActivity { activity ->
            requireNotNull(webView(activity.window.decorView)) { "Workspace WebView unavailable" }
                .evaluateJavascript("(()=>{try{return String($expression)}catch(e){return 'error'}})()") { result.set(it); done.countDown() }
        }
        assertTrue("WebView evaluation timed out", done.await(30, TimeUnit.SECONDS))
        return JSONObject("{\"v\":${result.get()}}").optString("v")
    }

    private fun until(stage: String, seconds: Long = 60, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + TimeUnit.SECONDS.toMillis(seconds)
        while (!condition()) {
            check(SystemClock.uptimeMillis() < deadline) { "Timed out at $stage" }
            Thread.sleep(200)
        }
    }

    private fun covered(scenario: ActivityScenario<MainActivity>): Boolean {
        var visibility = View.VISIBLE
        scenario.onActivity { visibility = requireNotNull(webView(it.window.decorView)).visibility }
        return visibility != View.VISIBLE
    }

    private fun button(text: String) = "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSONObject.quote(text)})"
    private fun click(scenario: ActivityScenario<MainActivity>, element: String) =
        assertEquals("true", js(scenario, "(()=>{const e=$element;if(!e)return false;e.scrollIntoView();e.click();return true})()"))

    /** Opens the host list once when the requested host control is not rendered yet. */
    private fun reveal(scenario: ActivityScenario<MainActivity>, element: String) {
        if (js(scenario, "Boolean($element)") != "true") click(scenario, "document.querySelector(\"button[aria-label='Open hosts']\")")
        until("host control") { js(scenario, "Boolean($element)") == "true" }
    }

    private fun workspace(scenario: ActivityScenario<MainActivity>) = until("unlocked workspace") {
        !covered(scenario) && js(scenario, "Boolean(window.__TAURI_INTERNALS__?.invoke&&document.querySelector(\"button[aria-label='Add host']\"))") == "true"
    }

    /**
     * One step toward Security preferences through the visible Preferences control and its
     * category list; true once the resume-lock toggle is rendered. Each step is idempotent, so a
     * workspace remount that closes Preferences mid-wait is followed by navigating there again.
     */
    private fun towardSecurity(scenario: ActivityScenario<MainActivity>): Boolean = !covered(scenario) && js(scenario,
        "(()=>{if(document.querySelector('.access-lock-toggle'))return true;" +
            "const e=document.querySelector(\".settings-navigation button[data-settings-target='security']\")||" +
            "document.querySelector('.settings-detail-header button')||document.querySelector(\"button[aria-label='Preferences']\");" +
            "e?.click();return false})()") == "true"

    private fun security(scenario: ActivityScenario<MainActivity>) {
        workspace(scenario)
        until("security preferences") { towardSecurity(scenario) }
    }

    private val lockCheckbox = "document.querySelector('.access-lock-toggle input')"

    private fun lockToggle(scenario: ActivityScenario<MainActivity>, enabled: Boolean) {
        val checkbox = lockCheckbox
        security(scenario)
        until("resume lock setting") { js(scenario, "Boolean($checkbox&&!$checkbox.disabled)") == "true" }
        click(scenario, checkbox)
        // Enabling writes then verifies a new proof; disabling verifies the current proof.
        repeat(if (enabled) 2 else 1) { authenticate() }
        // A committed policy is a new access authority: the workspace remounts by design and closes
        // Preferences, possibly after this point, so every poll first re-opens Security if needed.
        until("resume lock committed") {
            towardSecurity(scenario) && js(scenario, "$checkbox?.checked===$enabled&&!$checkbox.disabled") == "true"
        }
    }

    /** Leaves the shared Activity unlocked and without a resume lock, whatever step failed. */
    private fun disableResumeLock(scenario: ActivityScenario<MainActivity>) {
        if (covered(scenario)) {
            device.wait(Until.findObject(coverUnlock()), 20_000)?.click()
            authenticate()
            until("cleanup unlock") { !covered(scenario) }
        }
        security(scenario)
        until("resume lock state") { js(scenario, "Boolean($lockCheckbox&&!$lockCheckbox.disabled)") == "true" }
        if (js(scenario, "$lockCheckbox.checked") == "true") lockToggle(scenario, false)
    }

    @Test fun resumeLockOpensOnlyForEnrolledFingerprint() {
        val scenario = NativeActivityFixture.scenario
        var failure: Throwable? = null
        try { resumeLockCase(scenario) } catch (error: Throwable) { failure = error; throw error } finally {
            // Report the first failure; a failed cleanup is attached to it instead of hiding it.
            runCatching { disableResumeLock(scenario) }.exceptionOrNull()?.let { cleanup ->
                failure?.addSuppressed(cleanup) ?: throw cleanup
            }
        }
    }

    private fun resumeLockCase(scenario: ActivityScenario<MainActivity>) {
        lockToggle(scenario, true)
        scenario.moveToState(Lifecycle.State.CREATED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        val unlock = requireNotNull(device.wait(Until.findObject(coverUnlock()), 20_000)) {
            "Returning to the app must show the native lock; visible labels: ${appLabels()}"
        }
        assertTrue("Locked content must stay hidden", covered(scenario))
        unlock.click()
        rejectThenCancel { covered(scenario) }
        assertNotNull("A failed unlock reports and keeps the lock",
            device.wait(Until.findObject(By.text(COVER_FAILURE).pkg(context.packageName)), 20_000))
        assertTrue("Cancelled authentication keeps content hidden", covered(scenario))
        device.findObject(coverUnlock()).click()
        authenticate()
        until("enrolled fingerprint unlock") { !covered(scenario) }
        assertTrue(device.wait(Until.gone(coverUnlock()), 20_000))
    }

    @Test fun privateKeyExportNeedsEnrolledFingerprintAndHostDeletionRemovesKeystoreEntry() {
        val scenario = NativeActivityFixture.scenario
        workspace(scenario)
        val stored = JSONObject().put("version", 1).put("hostname", "biometric.invalid").put("port", 22).put("username", "fixture")
            .put("fingerprint", fingerprint).put("jumpHostId", JSONObject.NULL).put("forwardAgent", false).put("biometricUnlock", true)
            .put("credentials", JSONObject().put("password", JSONObject.NULL).put("privateKey", PRIVATE_KEY).put("passphrase", JSONObject.NULL))
        val alias = protectedWrite(scenario, plugin(scenario), vaultKey, stored.toString()).split(":")[1]
        val connect = "document.querySelector(${JSONObject.quote("button[aria-label='Connect to $hostName']")})"
        reveal(scenario, connect)
        click(scenario, connect)
        val export = button("Export private key with biometrics")
        val exported = "document.querySelector('[role=dialog] textarea[readonly]')?.value"
        until("export action") { js(scenario, "Boolean($export&&!$export.disabled)") == "true" }
        click(scenario, export)
        rejectThenCancel { js(scenario, "Boolean($exported)") == "false" }
        until("cancelled export error") { js(scenario, "document.querySelector('[role=dialog] [role=alert]')?.textContent?.length>0") == "true" }
        assertEquals("Cancelled export never reveals the key", "false", js(scenario, "Boolean($exported)"))
        until("export retry") { js(scenario, "Boolean($export&&!$export.disabled)") == "true" }
        click(scenario, export)
        authenticate()
        until("exported key") { js(scenario, "$exported") == PRIVATE_KEY }
        click(scenario, button("Hide exported key"))
        click(scenario, "Array.from(document.querySelectorAll('[role=dialog] button')).find(b=>b.textContent.trim()==='Cancel')")
        val delete = "document.querySelector(${JSONObject.quote("button[aria-label='Delete $hostName']")})"
        reveal(scenario, delete)
        click(scenario, delete)
        val confirm = "document.querySelector(\"[role='dialog'][aria-label='Delete host'] button.danger-button\")"
        until("delete confirmation") { js(scenario, "Boolean($confirm)") == "true" }
        click(scenario, confirm)
        until("host deleted") { js(scenario, "Boolean($connect)") == "false" }
        assertFalse("Deleting the host deletes its saved credentials", preferences().contains(vaultKey))
        assertFalse("Deleting the host deletes its Keystore key", keystore().containsAlias(alias))
        assertFalse("Deleting the host removes its catalog entry", File(context.dataDir, "hosts.json").readText().contains(hostId))
    }
}
