package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Rect
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.lifecycle.Lifecycle
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals

/**
 * The real UI of the app as a user reaches a native terminal session, driven in the process (the page with DOM events, the surface with
 * `PixelCopy`, the keyboard editor through its `InputConnection`): the page's small driver, the engine choice in Settings, the owned
 * SSH host and its connection, and what the core and the surface hold. Shared by [NativeTerminalSessionTest] and [NativeAcceptanceTest]
 * (moved out of the first, unchanged), so the first native session through the real UI is written once.
 */
internal class NativeSessionDriver {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val scenario get() = NativeActivityFixture.scenario
    val fixture by lazy { ownedSshFixture() }
    val hostName by lazy { "Native session ${fixture.getString("nonce")}" }
    val evidence = JSONObject()
    private var previousSoftwareGpu: Boolean? = null
    private var savingHost = false
    private var connectingHost = false
    private var choseEngine = false
    val native = "input[name='terminal-engine'][value='native']"
    val nativePane = ".terminal-canvas[data-terminal-surface='native']"

    /** The page's small driver: DOM events the real UI reacts to, on elements that are on screen. Typing into a field uses the value setter React watches. */
    val pageScript = """window.__lz = {
        visible(e) { return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; },
        find(selector, text) {
          const shown = [...document.querySelectorAll(selector)].filter(e => this.visible(e));
          const name = e => (e.getAttribute('aria-label') || e.textContent).trim();
          // The exact name first: "Save host" must not be taken for "Save host settings".
          return text === undefined ? shown[0] : shown.find(e => name(e) === text) ?? shown.find(e => name(e).startsWith(text));
        },
        click(selector, text) { const e = this.find(selector, text); if (!e) return false; e.click(); return true; },
        set(selector, value) {
          const e = this.find(selector); if (!e) return false;
          const type = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement : e instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
          Object.getOwnPropertyDescriptor(type.prototype, 'value').set.call(e, value);
          e.dispatchEvent(new Event(e instanceof HTMLSelectElement ? 'change' : 'input', {bubbles: true})); return true;
        }}; true"""

    fun theUnlockedPage() {
        // A first connection asks for the notification permission; a system dialog would cover the page.
        runCatching { shell("pm grant app.lazysh.client android.permission.POST_NOTIFICATIONS") }
        PageDriver.awaitStartPage()
        // Wait for the app to load the debug JNI library before enabling the fixture's software renderer.
        if (InstrumentationRegistry.getArguments().getString("lazyshSoftwareGpu") == "true") previousSoftwareGpu = NativeSoftwareGpu.swap(true)
        PageDriver.js(pageScript)
        // The top bar stays, and the first-run gesture tour does not cover the page (the same two settings as NativeWorkspaceTest.keepTopBar).
        PageDriver.js("(() => { localStorage.setItem('lazysh.show-top-bar.v1', 'true'); localStorage.setItem('lazysh.gestureTour.v1', '999'); window.dispatchEvent(new Event('storage')); return true; })()")
    }

    fun leaveTheAppAsFound() {
        // What the case chose and saved is the app's: end the session, delete the host and give the engine choice back to Auto.
        if (connectingHost) runCatching {
            if (js("window.__lz.click(\"button[aria-label='Disconnect $hostName']\")") != "true") {
                click("button.mobile-tools, button[aria-label='Workspace tools']")
                click(".workspace-tools-end", "End $hostName connection")
            }
        }
        if (savingHost) runCatching {
            revealHosts()
            if (js("window.__lz.click(\"button[aria-label='Delete $hostName']\")") == "true") {
                click("[role=dialog] button", "Delete host")
            }
        }
        if (choseEngine) runCatching {
            openTerminalSettings()
            choose("input[name='terminal-engine'][value='auto']")
            click("button[aria-label='Close Preferences']")
        }
        runCatching { scenario.moveToState(Lifecycle.State.RESUMED) }
        previousSoftwareGpu?.let { NativeSoftwareGpu.swap(it) }
    }

    fun shell(command: String) = android.os.ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes() }

    fun quoted(text: String) = JSONObject.quote(text)
    fun js(expression: String) = PageDriver.js(expression)
    fun until(what: String, seconds: Long, expression: String) = PageDriver.poll(what, seconds) { js(expression).takeIf { it == "true" } }
    fun act(expression: String, what: String = expression) = PageDriver.poll(what, 60) { js(expression).takeIf { it == "true" } }
    fun click(selector: String, text: String? = null) = act("window.__lz.click(${quoted(selector)}${text?.let { ", ${quoted(it)}" } ?: ""})", "a click on $selector ${text ?: ""}")
    fun set(selector: String, value: String) = act("window.__lz.set(${quoted(selector)}, ${quoted(value)})", "a value for $selector")
    /** A radio button is clicked wherever it is: the choice's styling may hide the input itself. */
    fun choose(selector: String) = act("(() => { const r = document.querySelector(${quoted(selector)}); if (!r) return false; r.click(); return true; })()", "a click on $selector")
    fun text(selector: String) = (JSONTokener(js("document.querySelector(${quoted(selector)})?.textContent ?? ''")).nextValue() as? String) ?: ""

    fun <T> ui(block: (MainActivity) -> T) = PageDriver.onActivity(block)

    /** The Preferences page, Terminal and accessibility, where the engine for new sessions is chosen. */
    fun openTerminalSettings(category: String = "Terminal and accessibility") {
        PageDriver.poll("the Preferences page", 60) {
            if (js("window.__lz.click(\"button[aria-label='Preferences']\") || window.__lz.click(\".dialog button\", \"Preferences\")") == "true") true
            else { js("window.__lz.click('button.mobile-tools') || window.__lz.click(\"button[aria-label='Workspace tools']\")"); null }
        }
        click(".settings-navigation button", category)
    }

    fun revealHosts() = PageDriver.poll("the hosts list", 60) {
        if (js("Boolean(window.__lz.find(\"button[aria-label='Add host']\"))") == "true") true
        else { js("window.__lz.click(\"button[aria-label='Open hosts']\")"); js("window.__lz.click(\"button[data-workspace-mode='connections']\")"); null }
    }

    /**
     * Waits for Settings to offer Native. The app's GPU probe answers no for now when it overruns its 2 s budget (a cold start on a loaded emulator)
     * and keeps its real answer for the next start of the page (#2221): a new page asks again and gets it, so an overrun is retried once.
     */
    private fun awaitNativeOffered() {
        val offered = "(() => { const r = document.querySelector(${quoted(native)}); return !!r && !r.disabled; })()"
        val overran = "(document.querySelector('#terminal-engine-native-off')?.textContent ?? '').includes('probe took longer')"
        fun await(what: String) {
            try { until(what, 60, "$offered || $overran") }
            catch (error: AssertionError) { throw AssertionError("${error.message}: ${text("#terminal-engine-native-off")}", error) }
        }
        await("the Native engine offered")
        if (js(offered) == "true") return
        evidence.put("probeOverranOnce", true)
        scenario.recreate()
        PageDriver.awaitStartPage()
        PageDriver.js(pageScript)
        openTerminalSettings()
        await("the Native engine offered by a new page")
        if (js(offered) != "true") throw AssertionError("A new page was refused Native too: ${text("#terminal-engine-native-off")}")
    }

    fun chooseNative() {
        openTerminalSettings()
        try {
            awaitNativeOffered()
            choose(native)
            choseEngine = true
            until("Native chosen", 30, "document.querySelector(${quoted(native)}).checked")
            evidence.put("engineChoice", "native")
        } finally {
            runCatching { js("window.__lz.click(\"button[aria-label='Close Preferences']\")") }
        }
    }

    /** The host through the real editor, then the connection through its dialog, trusting the host key the way a user's tap does. */
    fun connect(ready: String = "false") {
        revealHosts()
        click("button[aria-label='Add host']")
        set("input[placeholder='Home workstation']", hostName)
        val mosh = fixture.optBoolean("mosh", false)
        set("input[placeholder='workstation.local']", if (mosh) "10.0.2.2" else "127.0.0.1")
        set("input[placeholder='Your SSH username']", fixture.getString("username"))
        set(".port-field input", fixture.getInt("port").toString())
        set("[role=dialog] select:has(option[value='ssh'])", if (mosh) "mosh" else "ssh")
        click("button", "Save host")
        savingHost = true
        connectSavedHost(trustNewKey = true, ready = ready)
    }

    fun connectSavedHost(trustNewKey: Boolean = false, ready: String = "false") {
        revealHosts()
        until("the saved host", 60, "Boolean(window.__lz.find(\"button[aria-label='Connect to $hostName']\"))")
        click("button[aria-label='Connect to $hostName']")
        until("the connection dialog", 60, "Boolean(window.__lz.find('[role=dialog] form .destination'))")
        click("[role=dialog] button", "Private key")
        set("[role=dialog] form.form-stack > label > textarea", fixture.getString("privateKey"))
        click("[role=dialog] form.form-stack button[type=submit]")
        connectingHost = true
        if (trustNewKey) {
            val expectedKey = "document.querySelector('.fingerprint code')?.textContent === ${quoted(fixture.getString("fingerprint"))}"
            until("the expected host key or the owned shell prompt", 60, "($expectedKey) || ($ready)")
            if (js(expectedKey) == "true") click("button", "Trust key and connect")
        }
    }

    fun session(replaced: String? = null) = PageDriver.poll("the placed native session", 120) {
        ui { TerminalSurfaces.ids().singleOrNull { it != replaced && TerminalSurfaces.state(it).let { state -> state.placed && state.ready } } }
    }

    fun invoke(command: String, session: String) = PageDriver.invoke(command, "{sessionId:${quoted(session)}}")
    fun coreText(session: String) = JSONArray("[" + invoke("terminal_core_text", session) + "]").getString(0)
    fun awaitRow(session: String, what: String, row: (String) -> Boolean) = PageDriver.poll("the core's screen to show $what", 90) { coreText(session).takeIf { text -> text.lines().any { row(it.trim()) } } }

    fun surfaceView() = ui { activity ->
        (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<SurfaceView>().firstOrNull() }
    }

    fun surfacePixels() = PageDriver.pixelsOf(checkNotNull(surfaceView()) { "the placed surface" })

    /** The pixels of `rows` of the bitmap that are not the pane's background, taken from its bottom right corner (no row reaches it before the screen is full). */
    fun ink(bitmap: Bitmap, rows: IntRange = 0 until bitmap.height): Int {
        val background = bitmap.getPixel(bitmap.width - 1, bitmap.height - 1)
        var count = 0
        for (y in rows) for (x in 0 until bitmap.width) if (bitmap.getPixel(x, y) != background) count++
        return count
    }

    fun checksum(bitmap: Bitmap): Int {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return pixels.contentHashCode()
    }

    fun awaitInk(what: String, enough: (Bitmap) -> Boolean): Bitmap {
        var last = 0
        try { return PageDriver.poll("ink for $what on the surface", 90) { surfacePixels().takeIf { bitmap -> last = ink(bitmap); enough(bitmap) } } }
        catch (error: AssertionError) { throw AssertionError("${error.message}; the surface held $last non-background pixels", error) }
    }

    /** The surface once two captures in a row agree (the renderer has finished drawing) and `wanted` holds of it. */
    fun settled(what: String, wanted: (Bitmap) -> Boolean): Bitmap {
        var last: Int? = null
        return PageDriver.poll("a settled surface for $what", 90) {
            val bitmap = surfacePixels()
            val sum = checksum(bitmap)
            val steady = sum == last
            last = sum
            bitmap.takeIf { steady && wanted(it) }
        }
    }

    /** The settled surface once it differs from `other`, the one it showed before what the case just did. */
    fun settledAfter(what: String, other: Bitmap) = settled(what) { checksum(it) != checksum(other) }

    fun terminalEditor() = checkNotNull(ui { activity ->
        (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<TerminalInputView>().firstOrNull() }
    }) { "the session's keyboard editor" }

    fun typeIntoTheSurface(command: String, enter: Boolean = true) {
        val input = terminalEditor()
        ui {
            val connection = checkNotNull(input.onCreateInputConnection(EditorInfo()))
            connection.commitText(command, 1)
            if (enter) connection.commitText("\n", 1)
        }
    }

    fun typeIntoTheSurfaceWithoutEnter(text: String) = typeIntoTheSurface(text, enter = false)

    /** A finger drag over the pane, on the screen, the way a user scrolls it. */
    fun drag(fromFraction: Double, toFraction: Double) {
        val view = checkNotNull(surfaceView())
        val bounds = ui { IntArray(2).also(view::getLocationOnScreen).let { Rect(it[0], it[1], it[0] + view.width, it[1] + view.height) } }
        val x = bounds.centerX()
        UiDevice.getInstance(instrumentation).swipe(x, bounds.top + (bounds.height() * fromFraction).roundToInt(), x, bounds.top + (bounds.height() * toFraction).roundToInt(), 20)
    }

    /** Chooses Native, connects to the owned shell and returns the placed native session's id once the page shows its native pane. */
    fun startNativeSession(): String {
        chooseNative()
        connect()
        until("the native pane on the page", 120, "Boolean(document.querySelector(${quoted(nativePane)})) && !document.querySelector('.terminal-canvas .xterm-screen')")
        return session()
    }


    /**
     * A multiplexer in the native session (B10): tmux started from the session's shell runs a server and splits a window, the core shows
     * what tmux answers, and the attached client's two panes, border and status line (#2487) are in the core's text. It reads the core's text, not the DOM, runs at the end of the one case (a second case in this
     * class starts from the page the first leaves) and needs the tmux the job installs.
     */
    fun hostTmux(id: String) {
        typeIntoTheSurface("command -v tmux >/dev/null && echo HAVE-TMUX || echo NO-TMUX")
        val probe = awaitRow(id, "the tmux probe", { it == "HAVE-TMUX" || it == "NO-TMUX" })
        evidence.put("tmuxOnPath", probe.lines().any { it.trim() == "HAVE-TMUX" })
        assertEquals("the owned shell has tmux on its path", true, probe.lines().any { it.trim() == "HAVE-TMUX" })
        // The size the remote pty has and the size the core has: a tmux client draws for the first and the core clips to the second.
        typeIntoTheSurface("echo ptysize=\$(stty size)")
        val ptyPattern = Regex("ptysize=[0-9]+ [0-9]+")
        val pty = awaitRow(id, "the pty's size", ptyPattern::matches).lineSequence().map(String::trim).first(ptyPattern::matches)
        val snapshot = JSONObject(invoke("terminal_core_snapshot", id)).getJSONObject("state")
        val grid = "${snapshot.getInt("rows")} ${snapshot.getInt("columns")}"
        assertEquals("the reconnected host PTY and the native grid agree", "ptysize=$grid", pty)
        evidence.put("ptySize", pty).put("coreSnapshot", grid)
        val nonce = fixture.getString("nonce")
        require(nonce.matches(Regex("[a-f0-9]{32}"))) { "Invalid owned tmux socket nonce" }
        val mux = "tmux -L lazysh-native-$nonce"
        try {
            // The server and a second pane, through tmux's own commands: the answers are text the core parsed.
            typeIntoTheSurface("echo term=\$TERM; $mux -f /dev/null new-session -d -s native-mux -n check && $mux set-option -t native-mux status-left '[mux] ' && $mux set-option -t native-mux status-right '' && $mux split-window -d -h -t native-mux && echo panes=\$($mux list-panes -t native-mux | wc -l)")
            val answered = awaitRow(id, "tmux's answer for two panes", { it == "panes=2" })
            evidence.put("tmuxTerm", answered.lines().firstOrNull { it.trim().startsWith("term=") }?.trim() ?: "")
            // The client attached: tmux draws its two panes with a border and its status line on the last row, as the core's text holds them.
            // The compact status keeps the window number visible on a narrow grid.
            typeIntoTheSurface("$mux attach -t native-mux")
            val screen = awaitRow(id, "tmux's status line on the last row", { it.startsWith("[mux]") && it.contains("0:check") })
            evidence.put("tmuxStatusLine", screen.lines().last { it.startsWith("[mux]") }.trim()).put("tmuxScreenRows", screen.lines().size)
            assertEquals("the status line is the screen's last row", screen.lines().last { it.isNotBlank() }.trim(), screen.lines().last { it.startsWith("[mux]") }.trim())
            awaitRow(id, "the border between tmux's two panes", { it.contains("│") })
        } finally {
            runCatching { typeIntoTheSurface("$mux kill-server") }
        }
    }
}
