package app.lazysh.vault

import android.app.Activity
import android.content.Context
import android.os.Build
import android.webkit.WebView
import android.view.View
import android.view.WindowManager
import java.lang.ref.WeakReference
import app.tauri.plugin.Channel
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginManager
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg class VaultItem { lateinit var key: String; var value: String? = null; var biometric: Boolean = false; var authEpoch: Long = 0 }
@InvokeArg class VaultCancellation { var authEpoch: Long = 0 }
@InvokeArg class VaultResumeRegistration { lateinit var events: Channel }
@InvokeArg class VaultResumeView { var covered: Boolean = true; var enabled: Boolean = true; var generation: Long = -1; var nativeGeneration: Long = -1 }
@TauriPlugin
class VaultPlugin(initialActivity: Activity) : Plugin(initialActivity) {
    private var activity: Activity = initialActivity
    companion object {
        private var current = WeakReference<VaultPlugin>(null)
        // Wry calls this canonical Activity hook before loading the new document.
        @JvmStatic fun onWebViewCreated(activity: Activity, webView: WebView) {
            webView.visibility = View.INVISIBLE
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            val previous = current.get() ?: return
            val handle = previous.handle
            if (previous.activity !== activity && handle != null) {
                previous.epochs.background(); previous.cancelPending?.invoke()
                val replacement = VaultPlugin(activity)
                replacement.epochs = previous.epochs
                replacement.resumeCover = previous.resumeCover
                if ((activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true) replacement.epochs.resume()
                // Replace the SDK base object too: its private constructor Activity cannot be rebound.
                PluginManager.load(webView, handle.name, replacement, handle.config)
                replacement.handle?.loaded = true
            } else previous.bind(activity, webView)
        }
    }
    private val alias get() = "${activity.packageName}.credentials"
    private val prefs get() = activity.getSharedPreferences("lazysh-credentials", Context.MODE_PRIVATE)
    private var cancelPending: (() -> Unit)? = null
    private var pendingAuthEpoch: Long? = null
    private var epochs = CredentialEpoch()
    private var resumeCover = ResumeCover(activity)
    private fun bind(owner: Activity, webView: WebView) {
        if (activity !== owner) {
            epochs.background(); cancelPending?.invoke(); activity = owner
            if ((owner as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true) epochs.resume()
        }
        resumeCover.load(webView, owner)
    }
    override fun load(webView: WebView) {
        if (handle != null) current = WeakReference(this)
        bind(activity, webView)
    }
    override fun onPause(activity: AppCompatActivity) { if (activity === this.activity) resumeCover.pause() }
    @Command fun resumeFailure(invoke: Invoke) = activity.runOnUiThread { resumeCover.failure(); invoke.resolve() }
    @Command fun resumeCapability(invoke: Invoke) = activity.runOnUiThread {
        val result = JSObject(); val supported = available() && resumeCover.ready
        result.put("available", supported); result.put("reason", if (supported) "Native biometric privacy cover is ready" else "Strong enrolled biometrics and a native privacy cover are required")
        invoke.resolve(result)
    }
    @Command fun registerResume(invoke: Invoke) = activity.runOnUiThread {
        try { resumeCover.register(invoke.parseArgs(VaultResumeRegistration::class.java).events); invoke.resolve() }
        catch (_: Exception) { invoke.reject("Cannot register native privacy cover") }
    }
    @Command fun resumeView(invoke: Invoke) = activity.runOnUiThread {
        try { val args = invoke.parseArgs(VaultResumeView::class.java)
            if (resumeCover.apply(args.covered, args.enabled, args.generation, args.nativeGeneration)) invoke.resolve()
            else invoke.reject("Native privacy cover generation changed")
        } catch (_: Exception) { invoke.reject("Cannot update native privacy cover") }
    }
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    @Synchronized private fun key(name: String, create: Boolean, biometric: Boolean): SecretKey? {
        (store().getKey(name, null) as? SecretKey)?.let { return it }
        if (!create) return null
        val spec = KeyGenParameterSpec.Builder(name, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        if (biometric) {
            spec.setUserAuthenticationRequired(true).setInvalidatedByBiometricEnrollment(true)
            if (Build.VERSION.SDK_INT >= 30) spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            else @Suppress("DEPRECATION") spec.setUserAuthenticationValidityDurationSeconds(-1)
        }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec.build()) }.generateKey()
    }
    private fun parse(invoke: Invoke): VaultItem = invoke.parseArgs(VaultItem::class.java).also {
        require(it.key.isNotEmpty() && it.key.length <= 1024 && (it.value?.toByteArray()?.size ?: 0) <= 131072)
    }
    private fun available() = activity is FragmentActivity && BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS
    private fun removeAlias(blob: String?) {
        val parts = blob?.split(":") ?: return
        if (parts.size == 4 && parts[0] == "v2b" && parts[1].startsWith("$alias.biometric.")) try { store().deleteEntry(parts[1]) } catch (_: Exception) {}
    }
    private fun authenticate(invoke: Invoke, cipher: Cipher, authEpoch: Long, cleanup: () -> Unit = {}, action: (Cipher) -> Unit) {
        val started = epochs.lifecycle
        if (!epochs.permits(authEpoch, started) || !available() || cancelPending != null) { cleanup(); invoke.reject("Strong biometrics unavailable, cancelled or another authentication is active"); return }
        var complete = false
        lateinit var prompt: BiometricPrompt
        fun reject() { if (!complete) { complete = true; cancelPending = null; pendingAuthEpoch = null; cleanup(); invoke.reject("Credential authentication cancelled or unavailable") } }
        prompt = BiometricPrompt(activity as FragmentActivity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationError(code: Int, message: CharSequence) { reject() }
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                if (complete) return
                if (!epochs.permits(authEpoch, started)) { reject(); return }
                complete = true; cancelPending = null; pendingAuthEpoch = null
                try { action(requireNotNull(result.cryptoObject?.cipher)) }
                catch (_: Exception) { cleanup(); invoke.reject("Cannot use authenticated credentials") }
            }
        })
        cancelPending = { reject(); prompt.cancelAuthentication() }
        pendingAuthEpoch = authEpoch
        try { prompt.authenticate(BiometricPrompt.PromptInfo.Builder().setTitle("Unlock lazysh credentials").setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG).setNegativeButtonText("Cancel").build(), BiometricPrompt.CryptoObject(cipher)) }
        catch (_: Exception) { reject() }
    }
    @Command fun capability(invoke: Invoke) = activity.runOnUiThread {
        val result = JSObject(); result.put("available", available()); result.put("reason", if (available()) "Strong biometrics protect each credential operation" else "Enroll supported strong biometrics to enable this option"); invoke.resolve(result)
    }
    @Command fun exists(invoke: Invoke) { try { val result = JSObject(); result.put("exists", prefs.contains(parse(invoke).key)); invoke.resolve(result) } catch (_: Exception) { invoke.reject("Cannot inspect credentials") } }
    @Command fun cancel(invoke: Invoke) = activity.runOnUiThread {
        try {
            epochs.cancel(invoke.parseArgs(VaultCancellation::class.java).authEpoch)
            if (pendingAuthEpoch?.let { !epochs.permits(it) } == true) cancelPending?.invoke()
            invoke.resolve()
        }
        catch (_: Exception) { invoke.reject("Cannot cancel credential authentication") }
    }
    override fun onResume(activity: AppCompatActivity) { activity.runOnUiThread { if (activity === this.activity) { epochs.resume(); resumeCover.resume() } } }
    override fun onStop(activity: AppCompatActivity) { activity.runOnUiThread { if (activity === this.activity) { epochs.background(); cancelPending?.invoke(); resumeCover.background() } } }
    override fun onDestroy(activity: AppCompatActivity) { activity.runOnUiThread { if (activity === this.activity) { epochs.background(); cancelPending?.invoke(); resumeCover.background() } } }
    @Command fun read(invoke: Invoke) = activity.runOnUiThread {
        try {
            val item = parse(invoke); val blob = prefs.getString(item.key, null)
            if (!epochs.permits(item.authEpoch)) { invoke.reject("Credential authentication cancelled"); return@runOnUiThread }
            if (blob == null) { invoke.resolve(JSObject()); return@runOnUiThread }
            val envelope = CredentialEnvelope.parse(blob, "$alias.biometric."); val biometric = envelope.biometric
            if (item.biometric && !biometric) { invoke.reject("Credentials require re-entry to enable biometric protection"); return@runOnUiThread }
            val name = envelope.alias ?: alias
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, requireNotNull(key(name, false, biometric)), GCMParameterSpec(128, Base64.decode(envelope.iv, Base64.NO_WRAP)))
            cipher.updateAAD(item.key.toByteArray(Charsets.UTF_8))
            val encrypted = Base64.decode(envelope.ciphertext, Base64.NO_WRAP)
            val decrypt = { unlocked: Cipher ->
                val bytes = unlocked.doFinal(encrypted)
                try { val result = JSObject(); result.put("value", String(bytes, Charsets.UTF_8)); invoke.resolve(result) } finally { bytes.fill(0) }
            }
            if (biometric) authenticate(invoke, cipher, item.authEpoch, action = decrypt) else decrypt(cipher)
        } catch (_: KeyPermanentlyInvalidatedException) { invoke.reject("Biometric enrollment changed. Forget saved credentials and enter them again.") }
        catch (_: Exception) { invoke.reject("Cannot read device credentials") }
    }
    @Command fun write(invoke: Invoke) = activity.runOnUiThread {
        var newAlias: String? = null; var plaintext: ByteArray? = null
        try {
            val item = parse(invoke); val previous = prefs.getString(item.key, null)
            if (!epochs.permits(item.authEpoch)) { invoke.reject("Credential authentication cancelled"); return@runOnUiThread }
            if (!item.biometric && previous?.startsWith("v2b:") == true) { invoke.reject("Forget protected credentials before disabling biometrics"); return@runOnUiThread }
            val bytes = requireNotNull(item.value).toByteArray(Charsets.UTF_8); item.value = null; plaintext = bytes
            val name = if (item.biometric) "$alias.biometric.${UUID.randomUUID()}" else alias
            if (item.biometric) newAlias = name
            val cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, requireNotNull(key(name, true, item.biometric))); cipher.updateAAD(item.key.toByteArray(Charsets.UTF_8))
            val cleanup = { bytes.fill(0); newAlias?.let { try { store().deleteEntry(it) } catch (_: Exception) {} }; Unit }
            val encrypt = { unlocked: Cipher ->
                val encrypted = try { unlocked.doFinal(bytes) } finally { bytes.fill(0) }
                val encoded = Base64.encodeToString(unlocked.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(encrypted, Base64.NO_WRAP)
                check(prefs.edit().putString(item.key, if (item.biometric) "v2b:$name:$encoded" else encoded).commit()); removeAlias(previous); invoke.resolve()
            }
            if (item.biometric) authenticate(invoke, cipher, item.authEpoch, cleanup, encrypt) else encrypt(cipher)
        } catch (_: Exception) { plaintext?.fill(0); newAlias?.let { try { store().deleteEntry(it) } catch (_: Exception) {} }; invoke.reject("Cannot save device credentials") }
    }
    @Command fun remove(invoke: Invoke) = activity.runOnUiThread {
        try { val item = parse(invoke); val previous = prefs.getString(item.key, null); check(prefs.edit().remove(item.key).commit()); removeAlias(previous); invoke.resolve() }
        catch (_: Exception) { invoke.reject("Cannot delete device credentials") }
    }
}
