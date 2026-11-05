package app.lazysh.client

import androidx.test.core.app.ActivityScenario
import app.lazysh.vault.VaultPlugin
import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.assertTrue

/** One native vault command result; Tauri resolves through callback 1 and rejects through callback 2. */
internal data class VaultResponse(val callback: Long, val json: String) {
    val resolved get() = callback == 1L
}

/** Records the single completion of one plugin command invoked outside Tauri's IPC router. */
internal class VaultReply {
    private val completed = CountDownLatch(1)
    private val response = AtomicReference<VaultResponse>()
    val pending get() = completed.count > 0
    fun invoke(command: String, args: JSONObject) = Invoke(1, command, 1, 2, { callback, json ->
        response.set(VaultResponse(callback, json)); completed.countDown()
    }, args.toString(), ObjectMapper())
    fun await(seconds: Long = 30): VaultResponse {
        assertTrue("Native vault response timed out", completed.await(seconds, TimeUnit.SECONDS))
        return response.get()
    }
}

internal fun VaultPlugin.dispatch(command: String, invoke: Invoke) = when (command) {
    "read" -> read(invoke)
    "write" -> write(invoke)
    "remove" -> remove(invoke)
    "exists" -> exists(invoke)
    "capability" -> capability(invoke)
    "cancel" -> cancel(invoke)
    else -> error("Unknown fixture command")
}

/** Starts a command on the Activity thread and returns before any OS prompt completes. */
internal fun ActivityScenario<MainActivity>.startVault(plugin: VaultPlugin, command: String, args: JSONObject): VaultReply {
    val reply = VaultReply()
    onActivity { plugin.dispatch(command, reply.invoke(command, args)) }
    return reply
}

internal fun ActivityScenario<MainActivity>.vault(plugin: VaultPlugin, command: String, args: JSONObject) =
    startVault(plugin, command, args).await()
