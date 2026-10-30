package app.lazysh.client

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.res.AssetFileDescriptor
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.view.View.OnAttachStateChangeListener
import android.view.ViewTreeObserver.OnGlobalLayoutListener
import android.view.ViewTreeObserver.OnWindowFocusChangeListener
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle.State.RESUMED
import androidx.lifecycle.LifecycleOwner
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin as MobilePlugin
import app.tauri.plugin.PluginManager
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Process-wide admission survives Activity replacement; cancelling never frees a running worker. */
internal class ClipboardReadState(private val clock: () -> Long = System::nanoTime) {
    class Operation(val token: String, val epoch: Long, val deadline: Long) {
        @Volatile var cancelled = false
    }
    private var epoch = 0L
    private var document = 0L
    private var active: Operation? = null
    @Synchronized fun advanceDocument(next: Long): Operation? {
        require(next in 0..9_007_199_254_740_991L) { "clipboard_unavailable" }
        check(next >= document) { "clipboard_cancelled" }
        if (next == document) return null
        document = next
        return invalidate()
    }
    @Synchronized fun begin(token: String, ready: Boolean, expectedDocument: Long): Operation {
        require(token.length == 36 && UUID.fromString(token).toString() == token) { "clipboard_unavailable" }
        check(ready) { "clipboard_unavailable" }
        check(expectedDocument == document) { "clipboard_cancelled" }
        check(active == null) { "clipboard_busy" }
        return Operation(token, epoch, clock() + TimeUnit.SECONDS.toNanos(5)).also { active = it }
    }
    @Synchronized fun current(operation: Operation, ready: Boolean): Boolean =
        active === operation && !operation.cancelled && operation.epoch == epoch && ready && clock() < operation.deadline
    @Synchronized fun cancel(token: String): Operation? = active?.takeIf { it.token == token }?.also { it.cancelled = true }
    @Synchronized fun owns(token: String): Boolean = active?.token == token
    @Synchronized fun invalidate(): Operation? {
        epoch++
        return active?.also { it.cancelled = true }
    }
    @Synchronized fun finish(operation: Operation) { if (active === operation) active = null }
}

/** Byte/header validation precedes browser decoding, and never includes provider data in errors. */
internal object ClipboardPayload {
    const val TEXT_LIMIT = 65536
    const val IMAGE_LIMIT = 10 * 1024 * 1024
    fun failure(error: Exception): String = error.message?.takeIf {
        it in setOf("clipboard_unavailable", "clipboard_busy", "clipboard_empty", "clipboard_unsupported", "clipboard_limit", "clipboard_cancelled")
    } ?: "clipboard_unavailable"
    fun text(value: CharSequence?): String {
        check(value != null) { "clipboard_empty" }
        check(value.length <= TEXT_LIMIT) { "clipboard_limit" }
        return value.toString().also { check(it.toByteArray(Charsets.UTF_8).size <= TEXT_LIMIT) { "clipboard_limit" } }
    }
    fun contentUri(scheme: String?) { check(scheme == "content") { "clipboard_unsupported" } }
    fun bytes(input: InputStream, current: () -> Boolean): ByteArray {
        val output = ByteArrayOutputStream()
        val chunk = ByteArray(8192)
        while (true) {
            check(current()) { "clipboard_cancelled" }
            val count = input.read(chunk, 0, minOf(chunk.size, IMAGE_LIMIT + 1 - output.size()))
            if (count < 0) break
            if (count == 0) continue
            output.write(chunk, 0, count)
            check(output.size() <= IMAGE_LIMIT) { "clipboard_limit" }
        }
        check(current()) { "clipboard_cancelled" }
        return output.toByteArray()
    }
    fun image(bytes: ByteArray, mime: String) {
        check(bytes.isNotEmpty() && bytes.size <= IMAGE_LIMIT) { "clipboard_limit" }
        fun byte(index: Int) = bytes[index].toInt() and 255
        fun short(index: Int) = byte(index) * 256 + byte(index + 1)
        fun dimension(width: Long, height: Long) {
            check(width in 1..8192 && height in 1..8192 && width * height <= 8L * 1024 * 1024) { "clipboard_limit" }
        }
        if (mime == "image/png" && bytes.size >= 24 &&
            bytes.take(8) == listOf(137, 80, 78, 71, 13, 10, 26, 10).map(Int::toByte)) {
            check(bytes.sliceArray(8..15).contentEquals(byteArrayOf(0, 0, 0, 13, 73, 72, 68, 82))) { "clipboard_unsupported" }
            fun uint(index: Int) = (0..3).fold(0L) { value, offset -> value * 256 + byte(index + offset) }
            dimension(uint(16), uint(20)); return
        }
        if (mime == "image/jpeg" && bytes.size >= 4 && byte(0) == 255 && byte(1) == 216) {
            var offset = 2
            while (offset + 3 < bytes.size) {
                check(byte(offset++) == 255) { "clipboard_unsupported" }
                while (offset < bytes.size && byte(offset) == 255) offset++
                check(offset < bytes.size) { "clipboard_unsupported" }
                val marker = byte(offset++)
                if (marker == 218 || marker == 217) break
                if (marker == 1 || marker in 208..215) continue
                check(offset + 2 <= bytes.size) { "clipboard_unsupported" }
                val length = short(offset)
                check(length >= 2 && offset + length <= bytes.size) { "clipboard_unsupported" }
                if (marker in setOf(192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207)) {
                    check(length >= 8) { "clipboard_unsupported" }
                    dimension(short(offset + 5).toLong(), short(offset + 3).toLong()); return
                }
                offset += length
            }
        }
        error("clipboard_unsupported")
    }
}

internal object NativeClipboardAuthority {
    external fun admit(token: String, kind: String, document: Long, action: ClipboardAdmission): Boolean
    external fun current(token: String): Boolean
    external fun invalidate()
    external fun retire(token: String)
}

/** JNI may invoke only this fixed, synchronous UI admission; it cannot run an arbitrary action. */
internal class ClipboardAdmission(private val plugin: ClipboardPlugin, private val invoke: Invoke,
    private val token: String, private val kind: String, private val document: Long) {
    fun run() { plugin.admit(invoke, token, kind, document) }
}

/** Private mobile handle only: Rust rejects renderer plugin commands before SDK mobile fallback. */
@TauriPlugin
class ClipboardPlugin(private val owner: Activity) : MobilePlugin(owner) {
    companion object {
        private var current = WeakReference<ClipboardPlugin>(null)
        private val state = ClipboardReadState()
        private fun permitted(operation: ClipboardReadState.Operation, ready: Boolean) =
            state.current(operation, ready) && NativeClipboardAuthority.current(operation.token)
        private fun retireIfIdle(token: String) {
            if (!state.owns(token)) NativeClipboardAuthority.retire(token)
        }
        private val worker = ThreadPoolExecutor(1, 1, 30, TimeUnit.SECONDS, SynchronousQueue<Runnable>()).apply {
            allowCoreThreadTimeOut(true)
        }
        @JvmStatic fun onWebViewCreated(activity: Activity, webView: WebView) {
            current.get()?.let { previous -> previous.owner.runOnUiThread {
                previous.invalidateOwner()
                if (activity === previous.owner) previous.load(webView)
                else previous.handle?.let { handle ->
                    previous.detach()
                    val replacement = ClipboardPlugin(activity)
                    PluginManager.load(webView, handle.name, replacement, handle.config)
                    replacement.handle?.loaded = true
                }
            } }
        }
    }
    private class Job(val operation: ClipboardReadState.Operation, var invoke: Invoke?) {
        val signal = CancellationSignal()
        val asset = AtomicReference<AssetFileDescriptor?>(null)
        var timeout: Runnable? = null
        fun close() { try { asset.getAndSet(null)?.close() } catch (_: Exception) {} }
    }
    private val main = Handler(Looper.getMainLooper())
    private var webview: WebView? = null
    private var pending: Job? = null
    private val focus = OnWindowFocusChangeListener { focused -> if (!focused) invalidateOwner() }
    private val layout = OnGlobalLayoutListener { if (!ready()) invalidateOwner() }
    private val attach = object : OnAttachStateChangeListener {
        override fun onViewAttachedToWindow(view: View) { invalidateOwner() }
        override fun onViewDetachedFromWindow(view: View) { invalidateOwner() }
    }
    override fun load(webView: WebView) = owner.runOnUiThread {
        if (current.get() !== this) NativeClipboardAuthority.invalidate()
        invalidateOwner(); detach(); current = WeakReference(this); webview = webView
        webView.addOnAttachStateChangeListener(attach)
        webView.viewTreeObserver.addOnWindowFocusChangeListener(focus)
        webView.viewTreeObserver.addOnGlobalLayoutListener(layout)
    }
    private fun detach() {
        webview?.let { view ->
            view.removeOnAttachStateChangeListener(attach)
            if (view.viewTreeObserver.isAlive) {
                view.viewTreeObserver.removeOnWindowFocusChangeListener(focus)
                view.viewTreeObserver.removeOnGlobalLayoutListener(layout)
            }
        }
        webview = null
    }
    private fun ready() = current.get() === this && !owner.isFinishing && !owner.isDestroyed &&
        (owner as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(RESUMED) == true &&
        webview?.let { it.isAttachedToWindow && it.isShown && it.hasWindowFocus() } == true
    private fun stop(job: Job) {
        job.timeout?.let(main::removeCallbacks); job.timeout = null
        job.close()
        try { job.signal.cancel() } catch (_: Exception) {}
        job.invoke?.reject("clipboard_cancelled"); job.invoke = null
    }
    private fun invalidateOwner() {
        if (current.get() === this) {
            NativeClipboardAuthority.invalidate()
            state.invalidate()
        } else pending?.let { state.cancel(it.operation.token) }
        pending?.let(::stop)
    }
    private fun settle(job: Job, payload: JSObject?, failure: String?) {
        job.timeout?.let(main::removeCallbacks); job.timeout = null
        val admitted = permitted(job.operation, ready())
        val callback = job.invoke; job.invoke = null
        state.finish(job.operation)
        NativeClipboardAuthority.retire(job.operation.token)
        if (pending === job) pending = null
        if (!admitted) callback?.reject("clipboard_cancelled")
        else if (failure == null && payload != null) callback?.resolve(payload)
        else callback?.reject(failure ?: "clipboard_unavailable")
    }
    private fun document(invoke: Invoke): Long {
        val number = invoke.getArgs().get("document")
        check(number is Number) { "clipboard_unavailable" }
        val value = number.toDouble()
        check(value.isFinite() && value >= 0 && value <= 9_007_199_254_740_991.0 && value % 1.0 == 0.0) { "clipboard_unavailable" }
        return value.toLong()
    }
    private fun advanceDocument(next: Long) {
        val cancelled = state.advanceDocument(next)
        pending?.takeIf { it.operation === cancelled }?.let(::stop)
    }
    @Command fun invalidate(invoke: Invoke) = owner.runOnUiThread {
        try { advanceDocument(document(invoke)); invoke.resolve() }
        catch (_: Exception) { invoke.reject("clipboard_unavailable") }
    }
    @Command fun cancel(invoke: Invoke) = owner.runOnUiThread {
        val token = runCatching { invoke.getArgs().getString("token") }.getOrNull()
        pending?.takeIf { it.operation.token == token }?.let { state.cancel(it.operation.token); stop(it) }
        token?.let(::retireIfIdle)
        invoke.resolve()
    }
    @Command fun read(invoke: Invoke) = owner.runOnUiThread {
        val kind: String
        val token = runCatching { invoke.getArgs().getString("token") }.getOrNull()
        val document: Long
        try {
            val args = invoke.getArgs()
            check(args.length() == 3) { "clipboard_unavailable" }
            kind = args.getString("kind")
            check(kind == "text" || kind == "image") { "clipboard_unsupported" }
            document = document(invoke)
            advanceDocument(document)
            check(token != null) { "clipboard_unavailable" }
        } catch (error: Exception) {
            token?.let(::retireIfIdle)
            invoke.reject(ClipboardPayload.failure(error)); return@runOnUiThread
        }
        if (!NativeClipboardAuthority.admit(token, kind, document, ClipboardAdmission(this, invoke, token, kind, document))) {
            retireIfIdle(token)
            invoke.reject("clipboard_cancelled")
        }
    }
    internal fun admit(invoke: Invoke, token: String, kind: String, document: Long) {
        val operation = try { state.begin(token, ready(), document) }
        catch (error: Exception) {
            val failure = ClipboardPayload.failure(error)
            main.post { retireIfIdle(token); invoke.reject(failure) }; return
        }
        val job = Job(operation, invoke); pending = job
        job.timeout = Runnable { state.cancel(operation.token); stop(job) }.also { main.postDelayed(it, 5000) }
        try {
            // Capture the system clip while focused; do not coerce text or open a provider on the UI thread.
            val clip = (owner.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
            check(clip != null && clip.itemCount > 0) { "clipboard_empty" }
            val item = clip.getItemAt(0)
            if (kind == "text") {
                val text = ClipboardPayload.text(item.text)
                // Settlement re-enters Rust's current gate only after admit releases its permit/access monitors.
                main.post { settle(job, JSObject().apply { put("kind", "text"); put("text", text) }, null) }
                return
            }
            val uri = item.uri
            ClipboardPayload.contentUri(uri?.scheme)
            val mime = when {
                clip.description.hasMimeType("image/png") -> "image/png"
                clip.description.hasMimeType("image/jpeg") -> "image/jpeg"
                else -> error("clipboard_unsupported")
            }
            val resolver = owner.applicationContext.contentResolver
            val reply = WeakReference(this)
            val dispatcher = main
            worker.execute {
                var bytes: ByteArray? = null
                var result: JSObject? = null
                var failure: String? = null
                try {
                    check(permitted(operation, true)) { "clipboard_cancelled" }
                    val asset = resolver.openTypedAssetFileDescriptor(requireNotNull(uri), mime, null, job.signal)
                        ?: error("clipboard_unavailable")
                    job.asset.set(asset)
                    check(permitted(operation, true)) { "clipboard_cancelled" }
                    bytes = asset.createInputStream().use { ClipboardPayload.bytes(it) { permitted(operation, true) } }
                    ClipboardPayload.image(requireNotNull(bytes), mime)
                    check(permitted(operation, true)) { "clipboard_cancelled" }
                    result = JSObject().apply {
                        put("kind", "image"); put("mime", mime)
                        put("bytes", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    }
                } catch (error: Exception) { failure = ClipboardPayload.failure(error) }
                finally { bytes?.fill(0); job.close() }
                val payload = result; val error = failure
                dispatcher.post {
                    reply.get()?.settle(job, payload, error) ?: run {
                        state.finish(operation)
                        NativeClipboardAuthority.retire(operation.token)
                    }
                }
            }
        } catch (error: Exception) {
            val failure = ClipboardPayload.failure(error)
            main.post { settle(job, null, failure) }
        }
    }
    override fun onPause(activity: AppCompatActivity) { if (activity === owner) owner.runOnUiThread { invalidateOwner() } }
    override fun onStop(activity: AppCompatActivity) { if (activity === owner) owner.runOnUiThread { invalidateOwner() } }
    override fun onDestroy(activity: AppCompatActivity) { if (activity === owner) owner.runOnUiThread { invalidateOwner(); detach() } }
}
