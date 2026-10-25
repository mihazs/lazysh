package app.lazysh.client

import android.content.Context
import android.util.Base64
import app.lazysh.vault.VaultPlugin
import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeVaultTest {
    private data class Response(val callback: Long, val json: String)
    private class Reply {
        val completed = CountDownLatch(1)
        val response = AtomicReference<Response>()
        fun invoke(command: String, args: JSONObject) = Invoke(1, command, 1, 2, { callback, json ->
            response.set(Response(callback, json)); completed.countDown()
        }, args.toString(), ObjectMapper())
        fun await(): Response {
            assertTrue("Native vault response timed out", completed.await(30, TimeUnit.SECONDS))
            return response.get()
        }
    }
    private fun call(scenario: ActivityScenario<MainActivity>, plugin: VaultPlugin, command: String, args: JSONObject): Response {
        val reply = Reply()
        scenario.onActivity {
            val invoke = reply.invoke(command, args)
            when (command) {
                "read" -> plugin.read(invoke)
                "write" -> plugin.write(invoke)
                "remove" -> plugin.remove(invoke)
                "exists" -> plugin.exists(invoke)
                "capability" -> plugin.capability(invoke)
                "cancel" -> plugin.cancel(invoke)
                else -> error("Unknown fixture command")
            }
        }
        return reply.await()
    }

    @Test fun keystoreRoundtripStoresOnlyCiphertextAndRejectsTampering() {
        run { val scenario = NativeActivityFixture.scenario
            lateinit var plugin: VaultPlugin
            scenario.onActivity { plugin = VaultPlugin(it) }
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val preferences = context.getSharedPreferences("lazysh-credentials", Context.MODE_PRIVATE)
            val account = "instrumentation-${UUID.randomUUID()}"
            val secret = "temporary instrumentation secret ${UUID.randomUUID()}"
            try {
                val stored = call(scenario, plugin, "write", JSONObject().put("key", account).put("value", secret))
                assertEquals(1L, stored.callback)
                val ciphertext = requireNotNull(preferences.getString(account, null))
                assertFalse(ciphertext.contains(secret))
                val presence = call(scenario, plugin, "exists", JSONObject().put("key", account))
                assertTrue(JSONObject(presence.json).getBoolean("exists"))
                val read = call(scenario, plugin, "read", JSONObject().put("key", account))
                assertEquals(1L, read.callback)
                assertEquals(secret, JSONObject(read.json).getString("value"))
                val parts = ciphertext.split(":")
                val bytes = Base64.decode(parts.last(), Base64.NO_WRAP)
                bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
                assertTrue(preferences.edit().putString(account, parts.dropLast(1).joinToString(":") + ":" + Base64.encodeToString(bytes, Base64.NO_WRAP)).commit())
                val rejected = call(scenario, plugin, "read", JSONObject().put("key", account))
                assertEquals(2L, rejected.callback)
                assertFalse(rejected.json.contains(secret))
            } finally {
                assertEquals(1L, call(scenario, plugin, "remove", JSONObject().put("key", account)).callback)
            }
            val absent = call(scenario, plugin, "exists", JSONObject().put("key", account))
            assertFalse(JSONObject(absent.json).getBoolean("exists"))
        }
    }

    @Test fun protectedWriteNeverFallsBackWhenUnavailableOrExplicitlyCancelled() {
        run { val scenario = NativeActivityFixture.scenario
            lateinit var plugin: VaultPlugin
            scenario.onActivity { plugin = VaultPlugin(it) }
            val account = "instrumentation-protected-${UUID.randomUUID()}"
            val capability = call(scenario, plugin, "capability", JSONObject())
            assertEquals(1L, capability.callback)
            val available = JSONObject(capability.json).getBoolean("available")
            android.util.Log.i("lazysh-instrumentation", "Strong biometric enrollment available=$available")
            val reply = Reply()
            scenario.onActivity {
                plugin.write(reply.invoke("write", JSONObject().put("key", account).put("value", "temporary fixture").put("biometric", true)))
                if (available) plugin.cancel(Reply().invoke("cancel", JSONObject().put("authEpoch", 1)))
            }
            assertEquals(2L, reply.await().callback)
            val presence = call(scenario, plugin, "exists", JSONObject().put("key", account))
            assertFalse(JSONObject(presence.json).getBoolean("exists"))
        }
    }

    @Test fun cancelledAndBackgroundOperationsCannotReturnStoredSecrets() {
        run { val scenario = NativeActivityFixture.scenario
            lateinit var plugin: VaultPlugin
            scenario.onActivity { plugin = VaultPlugin(it) }
            val account = "instrumentation-cancel-${UUID.randomUUID()}"
            val secret = "temporary cancellation fixture ${UUID.randomUUID()}"
            try {
                assertEquals(1L, call(scenario, plugin, "write", JSONObject().put("key", account).put("value", secret).put("authEpoch", 0)).callback)
                assertEquals(1L, call(scenario, plugin, "cancel", JSONObject().put("authEpoch", 1)).callback)
                val cancelled = call(scenario, plugin, "read", JSONObject().put("key", account).put("authEpoch", 0))
                assertEquals(2L, cancelled.callback)
                assertFalse(cancelled.json.contains(secret))
                val next = call(scenario, plugin, "read", JSONObject().put("key", account).put("authEpoch", 1))
                assertEquals(1L, next.callback)
                assertEquals(secret, JSONObject(next.json).getString("value"))
                scenario.onActivity { plugin.onStop(it) }
                val background = call(scenario, plugin, "read", JSONObject().put("key", account).put("authEpoch", 2))
                assertEquals(2L, background.callback)
                assertFalse(background.json.contains(secret))
                scenario.onActivity { plugin.onResume(it) }
                assertEquals(1L, call(scenario, plugin, "cancel", JSONObject().put("authEpoch", 1)).callback)
                val resumed = call(scenario, plugin, "read", JSONObject().put("key", account).put("authEpoch", 2))
                assertEquals(1L, resumed.callback)
                assertEquals(secret, JSONObject(resumed.json).getString("value"))
            } finally {
                scenario.onActivity { plugin.onResume(it) }
                assertEquals(1L, call(scenario, plugin, "remove", JSONObject().put("key", account).put("authEpoch", 2)).callback)
            }
        }
    }
}
