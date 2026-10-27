package app.lazysh.client

import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject

/** A single post-failure sample, never a reconstruction of state at the deadline.
 * The caller waits at most one second; an already dispatched read-only JS query may finish later.
 */
internal object BoardReadinessObservation {
    private val fields = setOf("board", "checkbox", "checked", "disabled", "alert", "visible", "focused")
    private val statuses = setOf("ACTIVE", "PAUSED", "CHECKING", "OFF", "OWNERSHIP", "NOT_READY", "OTHER", "MISSING")
    val expression = """(() => {
      const board=document.querySelector('.keep-awake-control'), checkbox=board?.querySelector('input[type=checkbox]');
      const text=board?.querySelector('[role=status]')?.textContent;
      const known={
        'This board owns an acknowledged idle-inhibition request.':'ACTIVE',
        'Keep awake is paused until this board is visible and focused.':'PAUSED',
        'Checking native display ownership…':'CHECKING', 'Keep awake is off.':'OFF',
        'Native display ownership could not be confirmed.':'OWNERSHIP',
        'Native display owner is not foreground and focused':'NOT_READY'};
      return {board:!!board,checkbox:!!checkbox,checked:checkbox?.checked===true,disabled:checkbox?.disabled===true,
        alert:!!board?.querySelector('[role=alert]'),visible:document.visibilityState==='visible',focused:document.hasFocus(),
        status:text==null?'MISSING':Object.prototype.hasOwnProperty.call(known,text)?known[text]:'OTHER'};
    })()"""

    fun parse(value: String): JSONObject {
        require(value.length <= 512)
        val sample = JSONObject(value)
        require(sample.keys().asSequence().toSet() == fields + "status")
        require(fields.all { sample.get(it) is Boolean })
        require(sample.opt("status") is String && sample.getString("status") in statuses)
        return sample
    }

    fun collect(activity: MainActivity?, findWebView: (View) -> WebView?): String {
        if (activity == null) return "unavailable"
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(1)
        val live = AtomicBoolean(true)
        val native = AtomicReference<JSONObject>()
        val document = AtomicReference("unavailable")
        val completed = CountDownLatch(1)
        val handler = Handler(Looper.getMainLooper())
        val task = Runnable {
            if (live.get() && System.nanoTime() < deadline) {
                try {
                    val web = findWebView(activity.window.decorView)
                    native.set(JSONObject().put("webPresent", web != null)
                        .put("webAttached", web?.isAttachedToWindow == true).put("webShown", web?.isShown == true)
                        .put("webWindowFocused", web?.hasWindowFocus() == true)
                        .put("keepScreenOn", activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON != 0)
                        .put("destroyed", activity.isDestroyed).put("finishing", activity.isFinishing))
                    if (web == null) completed.countDown()
                    else if (live.get() && System.nanoTime() < deadline) web.evaluateJavascript(expression) { value ->
                        if (live.get() && System.nanoTime() < deadline) {
                            document.set(runCatching { parse(value).toString() }.getOrDefault("invalid"))
                            completed.countDown()
                        }
                    }
                } catch (_: Throwable) { completed.countDown() }
            }
        }
        return try {
            handler.post(task)
            val remaining = (deadline - System.nanoTime()).coerceAtLeast(0)
            val done = completed.await(remaining, TimeUnit.NANOSECONDS)
            "postFailure=true native=${native.get() ?: "unavailable"} document=${if (done) document.get() else "timeout"}"
        } catch (_: Throwable) { "unavailable" }
        finally { live.set(false); handler.removeCallbacks(task) }
    }
}
