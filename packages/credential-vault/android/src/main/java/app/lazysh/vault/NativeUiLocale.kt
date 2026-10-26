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
    private val preferences = this.context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
    private data class State(val choice: String, val revision: String)
    companion object {
        private val mutations = Any()
        private fun localized(context: Context, language: String): Context {
            val configuration = Configuration(context.resources.configuration)
            configuration.setLocale(Locale.forLanguageTag(language))
            return context.createConfigurationContext(configuration)
        }
        fun presentationContext(context: Context): Context = try {
            NativeUiLocale(context).presentationContext()
        } catch (_: Exception) { localized(context, "en") }
    }

    private fun read(): State {
        val blob = preferences.getString("state", null) ?: return State("system", "0")
        check(blob.length <= 256) { "Cannot read native interface language" }
        val value = JSONObject(blob)
        val choice = value.getString("choice")
        val revision = value.getString("revision")
        check(value.length() == 2 && UiLocalePolicy.validChoice(choice) && revision != "0" && UiLocalePolicy.validRevision(revision)) {
            "Cannot read native interface language"
        }
        return State(choice, revision)
    }
    private fun resolved(state: State): String {
        val locales = context.resources.configuration.locales
        return UiLocalePolicy.resolve(state.choice, (0 until minOf(locales.size(), 16)).map { locales[it].toLanguageTag() })
    }
    private fun status(state: State) = JSObject().apply {
        put("nativeAuthority", true); put("choice", state.choice)
        put("resolvedLocale", resolved(state)); put("revision", state.revision)
    }
    fun status(): JSObject = synchronized(mutations) { status(read()) }
    fun set(choice: String, expectedRevision: String): JSObject = synchronized(mutations) {
        require(UiLocalePolicy.validChoice(choice) && UiLocalePolicy.validRevision(expectedRevision)) { "Invalid interface language" }
        val previous = read()
        check(previous.revision == expectedRevision) { "Interface language changed; refresh and retry" }
        if (previous.choice == choice) return@synchronized status(previous)
        val next = State(choice, UUID.randomUUID().toString())
        val blob = JSONObject().put("choice", next.choice).put("revision", next.revision).toString()
        check(preferences.edit().putString("state", blob).commit()) { "Cannot save native interface language" }
        status(next)
    }
    fun presentationContext(): Context {
        // Status still reports corrupt storage; presentation must never block the native lock.
        val language = synchronized(mutations) { runCatching { resolved(read()) }.getOrDefault("en") }
        return localized(context, language)
    }
}
