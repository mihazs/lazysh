package app.lazysh.client

import android.content.Context
import android.content.SharedPreferences
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.lang.reflect.InvocationTargetException
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Own cosmetic preferences and blank native views only; no proof or authentication calls. */
@RunWith(AndroidJUnit4::class)
class NativeUiLocaleTest {
    private class Fixture {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "lazysh-locale-test-${UUID.randomUUID()}"
        val preferences: SharedPreferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
        val type = Class.forName("app.lazysh.vault.NativeUiLocale")
        fun adapter(): Any = type.getConstructor(Context::class.java, String::class.java).newInstance(context, name)
        fun status(adapter: Any): JSONObject = type.getMethod("status").invoke(adapter) as JSONObject
        fun set(adapter: Any, choice: String, revision: String): JSONObject =
            type.getMethod("set", String::class.java, String::class.java).invoke(adapter, choice, revision) as JSONObject
        fun strings(adapter: Any): Context = type.getMethod("presentationContext").invoke(adapter) as Context
        fun text(context: Context, key: String): String {
            val id = context.resources.getIdentifier(key, "string", context.packageName)
            assertNotEquals("Native locale resource must be bundled", 0, id)
            return context.getString(id)
        }
    }
    private fun fixture(block: (Fixture) -> Unit) {
        val fixture = Fixture()
        try { block(fixture) } finally { fixture.context.deleteSharedPreferences(fixture.name) }
    }
    @Test fun persistedChoiceRejectsStaleChangesAndMalformedStoredState() = fixture { f ->
        val adapter = f.adapter()
        val originalLocales = f.context.resources.configuration.locales.toLanguageTags()
        val initial = f.status(adapter)
        assertTrue(initial.getBoolean("nativeAuthority"))
        assertEquals("system", initial.getString("choice")); assertEquals("0", initial.getString("revision"))
        assertFalse("Getter must not initialize persistent state", f.preferences.contains("state"))
        val spanish = f.set(adapter, "es", "0")
        val revision = spanish.getString("revision")
        assertEquals(UUID.fromString(revision).toString(), revision)
        assertEquals("es", spanish.getString("resolvedLocale"))
        assertEquals("lazysh está bloqueado", f.text(f.strings(f.adapter()), "lazysh_resume_title"))
        assertEquals(originalLocales, f.context.resources.configuration.locales.toLanguageTags())
        assertEquals(revision, f.status(f.adapter()).getString("revision"))
        assertEquals(revision, f.set(adapter, "es", revision).getString("revision"))
        for ((choice, expected) in listOf("en" to "0", "es-MX" to revision)) {
            assertThrows(InvocationTargetException::class.java) { f.set(adapter, choice, expected) }
            assertEquals("es", f.status(adapter).getString("choice"))
        }
        assertTrue(f.preferences.edit().putString("state", "{\"choice\":\"fr\",\"revision\":\"$revision\"}").commit())
        assertThrows(InvocationTargetException::class.java) { f.status(adapter) }
        assertEquals("lazysh is locked", f.text(f.strings(adapter), "lazysh_resume_title"))
    }
    @Test fun translatingTheCoveredViewPreservesFailureAndNativeGeneration() = fixture { f ->
        val adapter = f.adapter()
        f.set(adapter, "pt-BR", "0")
        val strings = f.strings(adapter)
        NativeActivityFixture.scenario.onActivity { activity ->
            val coverType = Class.forName("app.lazysh.vault.ResumeCover")
            val cover = coverType.getConstructor(android.app.Activity::class.java).newInstance(activity)
            val blank = WebView(activity)
            val originalSecure = activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE
            activity.findViewById<ViewGroup>(android.R.id.content).addView(blank)
            try {
                coverType.getMethod("load", WebView::class.java, android.app.Activity::class.java).invoke(cover, blank, activity)
                val gate = coverType.getDeclaredField("gate").apply { isAccessible = true }.get(cover)
                val generation = gate.javaClass.getMethod("getNativeGeneration").invoke(gate)
                coverType.getMethod("relabel", Context::class.java).invoke(cover, strings)
                val overlay = coverType.getDeclaredField("overlay").apply { isAccessible = true }.get(cover) as View
                assertEquals("Iniciando o lazysh", overlay.contentDescription.toString())
                coverType.getMethod("failure").invoke(cover)
                val unlock = coverType.getDeclaredField("unlock").apply { isAccessible = true }.get(cover) as View
                assertEquals("Initialization failures retain a visible recovery action", View.VISIBLE, unlock.visibility)
                coverType.getMethod("relabel", Context::class.java).invoke(cover, strings)
                val detail = coverType.getDeclaredField("status").apply { isAccessible = true }.get(cover) as TextView
                val title = coverType.getDeclaredField("title").apply { isAccessible = true }.get(cover) as TextView
                assertEquals("O lazysh está bloqueado", title.text.toString())
                assertTrue(detail.text.toString().startsWith("O desbloqueio falhou"))
                assertEquals(generation, gate.javaClass.getMethod("getNativeGeneration").invoke(gate))
                assertEquals(View.INVISIBLE, blank.visibility)
                assertFalse(blank.isEnabled)
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
            } finally {
                (blank.parent as? ViewGroup)?.removeView(blank)
                val overlay = coverType.getDeclaredField("overlay").apply { isAccessible = true }.get(cover) as? View
                (overlay?.parent as? ViewGroup)?.removeView(overlay)
                activity.window.setFlags(originalSecure, WindowManager.LayoutParams.FLAG_SECURE)
                blank.destroy()
            }
        }
    }
}
