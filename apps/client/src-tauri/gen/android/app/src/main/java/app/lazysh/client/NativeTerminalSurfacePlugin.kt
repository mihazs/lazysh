package app.lazysh.client

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONException

/**
 * The renderer's way to the native terminal surface (#1327): the app commands `native_terminal_surface_*` reach these. Only the
 * developer-only native backend calls them; a release build refuses (`TerminalSurfaces.enabled`).
 */
@TauriPlugin
class NativeTerminalSurfacePlugin(private val owner: Activity) : Plugin(owner) {
    /** Runs on the UI thread against the activity in front, which is not the one Tauri built this plugin with after a recreation (#1462). */
    private fun onUi(invoke: Invoke, block: (Activity, String, JSObject) -> SurfaceState?) {
        val activity = currentActivity(owner)
        activity.runOnUiThread {
            try {
                val args = invoke.getArgs()
                val id = args.getString("session")
                if (id.isEmpty() || id.length > 64) throw SurfaceUnavailable("native_surface_session")
                val state = block(activity, id, args)
                if (state == null) invoke.resolve() else invoke.resolve(json(state))
            } catch (error: SurfaceUnavailable) { invoke.reject(error.message)
            } catch (_: JSONException) { invoke.reject("native_surface_arguments") }
        }
    }

    private fun json(state: SurfaceState) = JSObject().apply {
        put("placed", state.placed); put("ready", state.ready); put("generation", state.generation)
        put("width", state.width); put("height", state.height)
    }

    /** Puts the session's surface at a DOM anchor and creates the session on first use. */
    @Command fun place(invoke: Invoke) = onUi(invoke) { activity, id, args ->
        val anchor = SurfaceAnchor(args.getDouble("x"), args.getDouble("y"), args.getDouble("width"), args.getDouble("height"), args.getDouble("dpr"))
        if (!anchor.isValid) throw SurfaceUnavailable("native_surface_anchor")
        TerminalSurfaces.place(activity, id, anchor, args.getInt("background"))
    }

    @Command fun remove(invoke: Invoke) = onUi(invoke) { _, id, _ -> TerminalSurfaces.remove(id); null }

    @Command fun state(invoke: Invoke) = onUi(invoke) { _, id, _ -> TerminalSurfaces.state(id) }
}
