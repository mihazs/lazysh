package app.lazysh.vault

import android.content.Context
import android.content.res.Configuration
import app.tauri.plugin.JSObject
import org.json.JSONObject
import java.util.IllformedLocaleException
import java.util.Locale
import java.util.UUID

internal object UiLocalePolicy {
    fun validChoice(choice: String) = choice in setOf("system", "en", "pt-BR", "es")
    fun validRevision(value: String) = value == "0" ||
        (value.length == 36 && runCatching { UUID.fromString(value).toString() == value }.getOrDefault(false))
    fun resolve(choice: String, requested: List<String>): String {
        require(validChoice(choice))
        if (choice != "system") return choice
        for (tag in requested.take(16)) {
            if (tag.isEmpty() || tag.length > 80) continue
            val locale = try { Locale.Builder().setLanguageTag(tag).build() }
            catch (_: IllformedLocaleException) { continue }
            when (locale.language) {
                "pt" -> return "pt-BR"
                "en", "es" -> return locale.toLanguageTag()
            }
        }
        return "en"
    }
}

/** Cosmetic preferences are independent of credential epochs and native cover authority. */
internal class NativeUiLocale(context: Context, preferencesName: String = "lazysh-ui-locale") {
    private val context = context.applicationContext ?: context
    private val store = synchronized(stores) {
        stores.getOrPut(preferencesName) {
            val preferences = this.context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            UiLocaleStore(
                read = { decode(preferences.getString("state", null)) },
                write = { next ->
                    val blob = JSONObject().put("choice", next.choice).put("revision", next.revision).toString()
                    check(preferences.edit().putString("state", blob).commit()) { "Cannot save native interface language" }
                },
            )
        }
    }
    companion object {
        private val stores = mutableMapOf<String, UiLocaleStore>()
        val worker = UiLocaleWorkQueue()
        private fun localized(context: Context, language: String): Context {
            val configuration = Configuration(context.resources.configuration)
            configuration.setLocale(Locale.forLanguageTag(language))
            return context.createConfigurationContext(configuration)
        }
        fun presentationContext(context: Context): Context = try {
            NativeUiLocale(context).presentationContext()
        } catch (_: Exception) { localized(context, "en") }
        private fun decode(blob: String?): UiLocaleState {
            if (blob == null) return UiLocaleState("system", "0")
            check(blob.length <= 256) { "Cannot read native interface language" }
            val value = JSONObject(blob)
            val choice = value.getString("choice")
            val revision = value.getString("revision")
            check(value.length() == 2 && UiLocalePolicy.validChoice(choice) && revision != "0" && UiLocalePolicy.validRevision(revision)) {
                "Cannot read native interface language"
            }
            return UiLocaleState(choice, revision)
        }
    }
    private fun resolved(state: UiLocaleState): String {
        val locales = context.resources.configuration.locales
        return UiLocalePolicy.resolve(state.choice, (0 until minOf(locales.size(), 16)).map { locales[it].toLanguageTag() })
    }
    private fun status(state: UiLocaleState) = JSObject().apply {
        put("nativeAuthority", true); put("choice", state.choice)
        put("resolvedLocale", resolved(state)); put("revision", state.revision)
    }
    // These storage methods run on the owned worker; presentation never acquires its lock.
    fun status(): JSObject = status(store.refresh())
    fun set(choice: String, expectedRevision: String): JSObject = status(store.set(choice, expectedRevision))
    fun presentationContext(): Context {
        // Status still reports corrupt storage; presentation must never block the native lock.
        val language = runCatching { resolved(store.presentation()) }.getOrDefault("en")
        return localized(context, language)
    }
}
