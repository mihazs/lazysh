package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Rect
import android.system.Os
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
        // The CI emulator offers only a software adapter; the switch exists in a debug build only, and the probe reads it when the page first asks.
        if (InstrumentationRegistry.getArguments().getString("lazyshSoftwareGpu") == "true") Os.setenv("LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU", "1", true)
        // A first connection asks for the notification permission; a system dialog would cover the page.
        runCatching { shell("pm grant app.lazysh.client android.permission.POST_NOTIFICATIONS") }
        PageDriver.awaitStartPage()
        PageDriver.js(pageScript)
        // The top bar stays, and the first-run gesture tour does not cover the page (the same two settings as NativeWorkspaceTest.keepTopBar).
        PageDriver.js("(() => { localStorage.setItem('lazysh.show-top-bar.v1', 'true'); localStorage.setItem('lazysh.gestureTour.v1', '999'); window.dispatchEvent(new Event('storage')); return true; })()")
    }

    fun leaveTheAppAsFound() {
        // What the case chose and saved is the app's: end the session, delete the host and give the engine choice back to Auto.
        runCatching { act("window.__lz.click(\"button[aria-label='Disconnect $hostName']\")") }
        runCatching { revealHosts(); act("window.__lz.click(\"button[aria-label='Delete $hostName']\")") }
        runCatching { openEngineSettings(); choose("input[name='terminal-engine'][value='auto']"); act("window.__lz.click(\"button[aria-label='Close Preferences']\")") }
        runCatching { scenario.moveToState(Lifecycle.State.RESUMED) }
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
    fun openEngineSettings() {
        PageDriver.poll("the Preferences page", 60) {
            if (js("window.__lz.click(\"button[aria-label='Preferences']\")") == "true") true
            else { js("window.__lz.click('button.mobile-tools') || window.__lz.click(\"button[aria-label='Workspace tools']\")"); null }
        }
        click(".settings-navigation button", "Terminal and accessibility")
    }

    fun revealHosts() = PageDriver.poll("the hosts list", 60) {
        if (js("Boolean(window.__lz.find(\"button[aria-label='Add host']\"))") == "true") true
        else { js("window.__lz.click(\"button[aria-label='Open hosts']\")"); js("window.__lz.click(\"button[data-workspace-mode='connections']\")"); null }
    }

    fun chooseNative() {
        openEngineSettings()
        try { until("the Native engine offered", 60, "(() => { const r = document.querySelector(${quoted(native)}); return !!r && !r.disabled; })()") }
        catch (error: AssertionError) { throw AssertionError("${error.message}: ${text("#terminal-engine-native-off")}", error) }
        choose(native)
        until("Native chosen", 30, "document.querySelector(${quoted(native)}).checked")
        evidence.put("engineChoice", "native")
        click("button[aria-label='Close Preferences']")
    }

    /** The host through the real editor, then the connection through its dialog, trusting the host key the way a user's tap does. */
    fun connect() {
        revealHosts()
        click("button[aria-label='Add host']")
        set("input[placeholder='Home workstation']", hostName)
        set("input[placeholder='workstation.local']", "127.0.0.1")
        set("input[placeholder='Your SSH username']", fixture.getString("username"))
        set(".port-field input", fixture.getInt("port").toString())
        // The default transport is Auto, which would try Mosh first; this case is about the native engine on the SSH route.
        set("[role=dialog] select:has(option[value='ssh'])", "ssh")
        click("button", "Save host")
        until("the saved host", 60, "Boolean(window.__lz.find(\"button[aria-label='Connect to $hostName']\"))")
        click("button[aria-label='Connect to $hostName']")
        until("the connection dialog", 60, "Boolean(window.__lz.find('[role=dialog] form .destination'))")
        click("[role=dialog] button", "Private key")
        set("[role=dialog] form.form-stack > label > textarea", fixture.getString("privateKey"))
        click("[role=dialog] form.form-stack button[type=submit]")
        until("the host key to review", 60, "document.querySelector('.fingerprint code')?.textContent === ${quoted(fixture.getString("fingerprint"))}")
        click("button", "Trust key and connect")
    }

    fun session() = PageDriver.poll("the placed native session", 120) { ui { TerminalSurfaces.ids().singleOrNull() } }

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

    fun typeIntoTheSurface(command: String) {
        typeIntoTheSurfaceWithoutEnter(command)
        // A line break the keyboard commits as text is a carriage return, as in NativeTerminalInputTest.
        typeIntoTheSurfaceWithoutEnter("\n")
    }

    /** `text` committed through the surface's own `InputConnection`, as the keyboard commits it. */
    fun typeIntoTheSurfaceWithoutEnter(text: String) {
        val input = checkNotNull(ui { activity ->
            (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<TerminalInputView>().firstOrNull() }
        }) { "the session's keyboard editor" }
        ui { input.onCreateInputConnection(EditorInfo())?.commitText(text, 1) }
    }

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
        val pty = awaitRow(id, "the pty's size", { it.startsWith("ptysize=") && it.length > "ptysize=".length })
        evidence.put("ptySize", pty.lines().first { it.trim().startsWith("ptysize=") && it.trim().length > "ptysize=".length }.trim())
        evidence.put("coreSnapshot", runCatching { JSONObject(invoke("terminal_core_snapshot", id)).getJSONObject("state").let { "${it.getInt("rows")} ${it.getInt("columns")}" } }.getOrElse { "unreadable: ${invoke("terminal_core_snapshot", id).take(200)}" })
        // The server and a second pane, through tmux's own commands: the answers are text the core parsed.
        typeIntoTheSurface("echo term=\$TERM; tmux -f /dev/null new-session -d -s native-mux && tmux split-window -d -h -t native-mux && echo panes=\$(tmux list-panes -t native-mux | wc -l)")
        val answered = awaitRow(id, "tmux's answer for two panes", { it == "panes=2" })
        evidence.put("tmuxTerm", answered.lines().firstOrNull { it.trim().startsWith("term=") }?.trim() ?: "")
        // The client attached: tmux draws its two panes with a border and its status line on the last row, as the core's text holds them.
        // tmux cuts the status line's left part ("[native-mux] ") to its default length of 10 characters, which is why the row starts "[native-mu".
        typeIntoTheSurface("tmux attach -t native-mux")
        val screen = awaitRow(id, "tmux's status line on the last row", { it.startsWith("[native-mu") && it.contains("0:bash") })
        evidence.put("tmuxStatusLine", screen.lines().last { it.startsWith("[native-mu") }.trim()).put("tmuxScreenRows", screen.lines().size)
        assertEquals("the status line is the screen's last row", screen.lines().last { it.isNotBlank() }.trim(), screen.lines().last { it.startsWith("[native-mu") }.trim())
        awaitRow(id, "the border between tmux's two panes", { it.contains("│") })
        typeIntoTheSurface("tmux kill-server")
    }
}
