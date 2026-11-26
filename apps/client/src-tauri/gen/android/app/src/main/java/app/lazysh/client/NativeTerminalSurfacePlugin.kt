package app.lazysh.client

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The renderer's way to the native terminal surface (#1327): the app commands `native_terminal_surface_*` reach these. Only the
 * native backend, which only an explicit Native choice selects, calls them; a disabled host refuses (`TerminalSurfaces.enabled`).
 */
@TauriPlugin
class NativeTerminalSurfacePlugin(private val owner: Activity) : Plugin(owner) {
    /** Runs on the UI thread against the activity in front, which is not the one Tauri built this plugin with after a recreation (#1462). */
    private fun dispatchOnUi(invoke: Invoke, block: (Activity, String, JSObject) -> Unit) {
        val activity = currentActivity(owner)
        activity.runOnUiThread {
            try {
                val args = invoke.getArgs()
                val id = args.getString("session")
                if (id.isEmpty() || id.length > 64) throw SurfaceUnavailable("native_surface_session")
                block(activity, id, args)
            } catch (error: SurfaceUnavailable) { invoke.reject(error.message)
            } catch (_: JSONException) { invoke.reject("native_surface_arguments") }
        }
    }

    private fun onUi(invoke: Invoke, block: (Activity, String, JSObject) -> SurfaceState?) =
        dispatchOnUi(invoke) { activity, id, args ->
            val state = block(activity, id, args)
            if (state == null) invoke.resolve() else invoke.resolve(json(state))
        }

    private fun json(state: SurfaceState) = JSObject().apply {
        put("placed", state.placed); put("ready", state.ready); put("generation", state.generation)
        put("width", state.width); put("height", state.height)
        state.drawing?.let { put("drawing", it) }; state.reason?.let { put("reason", it) }
    }

    /** Puts the session's surface at a DOM anchor and creates the session on first use. */
    @Command fun place(invoke: Invoke) = onUi(invoke) { activity, id, args ->
        val anchor = SurfaceAnchor(args.getDouble("x"), args.getDouble("y"), args.getDouble("width"), args.getDouble("height"), args.getDouble("dpr"))
        if (!anchor.isValid) throw SurfaceUnavailable("native_surface_anchor")
        TerminalSurfaces.place(activity, id, anchor, args.getInt("background"))
    }

    @Command fun remove(invoke: Invoke) = onUi(invoke) { _, id, _ -> TerminalSurfaces.remove(id); null }

    /** Long poll: resolves with what the keyboard typed since the last call (a list of `text`, `key` and `preedit` events), once each. */
    @Command fun input(invoke: Invoke) = dispatchOnUi(invoke) { _, id, args ->
        if (args.isNull("barrier")) {
            TerminalSurfaces.takeInput(id) { events -> invoke.resolve(JSObject().apply { put("events", JSONArray(events.map(::eventJson))) }) }
        } else {
            TerminalSurfaces.markInput(id, args.getInt("barrier"))
            invoke.resolve()
        }
    }

    @Command fun focus(invoke: Invoke) = onUi(invoke) { _, id, args ->
        TerminalSurfaces.focus(id, args.getBoolean("focused"), args.optBoolean("keyboard", true), args.optBoolean("ifIdle"))
        null
    }

    @Command fun state(invoke: Invoke) = onUi(invoke) { _, id, _ -> TerminalSurfaces.state(id) }
}

/** The page's `CoreKeyInput` for a key, so it goes to the core as it is. */
internal fun eventJson(event: SurfaceInput): JSONObject = when (event) {
    is SurfaceInput.Text -> JSONObject().put("type", "text").put("text", event.text)
    is SurfaceInput.Barrier -> JSONObject().put("type", "barrier").put("ticket", event.ticket)
    is SurfaceInput.Paste -> JSONObject().put("type", "paste").put("text", event.text)
    is SurfaceInput.Preedit -> JSONObject().put("type", "preedit").put("text", event.text ?: JSONObject.NULL)
    is SurfaceInput.Key -> with(event.key) {
        JSONObject().put("type", "key").put("code", code).put("key", key)
            .put("mods", JSONObject().put("shift", shift).put("ctrl", ctrl).put("alt", alt).put("meta", meta))
            .put("repeat", repeat).put("release", release).put("composing", false)
    }
}
