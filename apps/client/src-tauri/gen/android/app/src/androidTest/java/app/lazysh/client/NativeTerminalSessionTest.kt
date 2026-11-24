package app.lazysh.client

import android.graphics.Bitmap
import android.graphics.Rect
import android.system.Os
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import kotlin.math.roundToInt
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The first native terminal session through the real UI (#2093, #1327): the real page of the real MainActivity chooses Native in Settings,
 * connects to an owned OpenSSH on this host (reached over `adb reverse`) as a user would, and the Rust core's output is drawn by the renderer
 * on the surface below the transparent WebView. The case looks at the pixels of that surface and of the composited screen, types into the
 * session through the surface's own `InputConnection` (the keyboard side replayed in the process, as `NativeTerminalInputTest` does),
 * scrolls it with a finger and stops and starts the window. The page is driven with DOM events, not touch (`window.__lz`): it is the real
 * UI, not a real finger. The CI emulator has no GPU the shipping policy accepts, so it runs with the debug software switch (instrumentation
 * argument `lazyshSoftwareGpu`); the Waydroid lane runs it without. What it leaves for the job is `native-session.json` and two pictures.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalSessionTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val scenario get() = NativeActivityFixture.scenario
    private val fixture by lazy { ownedSshFixture() }
    private val hostName by lazy { "Native session ${fixture.getString("nonce")}" }
    private val evidence = JSONObject()
    private val native = "input[name='terminal-engine'][value='native']"
    private val nativePane = ".terminal-canvas[data-terminal-surface='native']"

    /** The page's small driver: DOM events the real UI reacts to, on elements that are on screen. Typing into a field uses the value setter React watches. */
    private val driver = """window.__lz = {
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

    @Before fun theUnlockedPage() {
        // The CI emulator offers only a software adapter; the switch exists in a debug build only, and the probe reads it when the page first asks.
        if (InstrumentationRegistry.getArguments().getString("lazyshSoftwareGpu") == "true") Os.setenv("LAZYSH_NATIVE_TERMINAL_SOFTWARE_GPU", "1", true)
        // A first connection asks for the notification permission; a system dialog would cover the page.
        runCatching { shell("pm grant app.lazysh.client android.permission.POST_NOTIFICATIONS") }
        PageDriver.awaitStartPage()
        PageDriver.js(driver)
        // The top bar stays, and the first-run gesture tour does not cover the page (the same two settings as NativeWorkspaceTest.keepTopBar).
        PageDriver.js("(() => { localStorage.setItem('lazysh.show-top-bar.v1', 'true'); localStorage.setItem('lazysh.gestureTour.v1', '999'); window.dispatchEvent(new Event('storage')); return true; })()")
    }

    @After fun leaveTheAppAsFound() {
        // What the case chose and saved is the app's: end the session, delete the host and give the engine choice back to Auto.
        runCatching {
            if (js("window.__lz.click(\"button[aria-label='Disconnect $hostName']\")") != "true" &&
                js("Boolean(document.querySelector(${quoted(nativePane)}))") == "true"
            ) {
                if (js("Boolean(window.__lz.find('.workspace-tools-end'))") != "true") click("button.mobile-tools, button[aria-label='Workspace tools']")
                click(".workspace-tools-end", "End $hostName connection")
            }
        }
        runCatching {
            revealHosts()
            if (js("window.__lz.click(\"button[aria-label='Delete $hostName']\")") == "true") click("[role=dialog] button", "Delete host")
        }
        runCatching { openEngineSettings(); choose("input[name='terminal-engine'][value='auto']"); act("window.__lz.click(\"button[aria-label='Close Preferences']\")") }
        runCatching { scenario.moveToState(Lifecycle.State.RESUMED) }
    }

    private fun shell(command: String) = android.os.ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use { it.readBytes() }

    private fun quoted(text: String) = JSONObject.quote(text)
    private fun js(expression: String) = PageDriver.js(expression)
    private fun until(what: String, seconds: Long, expression: String) = PageDriver.poll(what, seconds) { js(expression).takeIf { it == "true" } }
    private fun act(expression: String, what: String = expression) = PageDriver.poll(what, 60) { js(expression).takeIf { it == "true" } }
    private fun click(selector: String, text: String? = null) = act("window.__lz.click(${quoted(selector)}${text?.let { ", ${quoted(it)}" } ?: ""})", "a click on $selector ${text ?: ""}")
    private fun set(selector: String, value: String) = act("window.__lz.set(${quoted(selector)}, ${quoted(value)})", "a value for $selector")
    /** A radio button is clicked wherever it is: the choice's styling may hide the input itself. */
    private fun choose(selector: String) = act("(() => { const r = document.querySelector(${quoted(selector)}); if (!r) return false; r.click(); return true; })()", "a click on $selector")
    private fun text(selector: String) = (JSONTokener(js("document.querySelector(${quoted(selector)})?.textContent ?? ''")).nextValue() as? String) ?: ""

    private fun <T> ui(block: (MainActivity) -> T) = PageDriver.onActivity(block)

    /** The Preferences page, Terminal and accessibility, where the engine for new sessions is chosen. */
    private fun openEngineSettings() {
        PageDriver.poll("the Preferences page", 60) {
            if (js("window.__lz.click(\"button[aria-label='Preferences']\")") == "true") true
            else { js("window.__lz.click('button.mobile-tools') || window.__lz.click(\"button[aria-label='Workspace tools']\")"); null }
        }
        click(".settings-navigation button", "Terminal and accessibility")
    }

    private fun revealHosts() = PageDriver.poll("the hosts list", 60) {
        if (js("Boolean(window.__lz.find(\"button[aria-label='Add host']\"))") == "true") true
        else { js("window.__lz.click(\"button[aria-label='Open hosts']\")"); js("window.__lz.click(\"button[data-workspace-mode='connections']\")"); null }
    }

    private fun chooseNative() {
        openEngineSettings()
        try { until("the Native engine offered", 60, "(() => { const r = document.querySelector(${quoted(native)}); return !!r && !r.disabled; })()") }
        catch (error: AssertionError) { throw AssertionError("${error.message}: ${text("#terminal-engine-native-off")}", error) }
        choose(native)
        until("Native chosen", 30, "document.querySelector(${quoted(native)}).checked")
        evidence.put("engineChoice", "native")
        click("button[aria-label='Close Preferences']")
    }

    /** The host through the real editor, then the connection through its dialog, trusting the host key the way a user's tap does. */
    private fun connect() {
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

    private fun session() = PageDriver.poll("the placed native session", 120) { ui { TerminalSurfaces.ids().singleOrNull() } }

    private fun invoke(command: String, session: String) = PageDriver.invoke(command, "{sessionId:${quoted(session)}}")
    private fun coreText(session: String) = JSONArray("[" + invoke("terminal_core_text", session) + "]").getString(0)
    private fun awaitRow(session: String, what: String, row: (String) -> Boolean) = PageDriver.poll("the core's screen to show $what", 90) { coreText(session).takeIf { text -> text.lines().any { row(it.trim()) } } }

    private fun surfaceView() = ui { activity ->
        (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<SurfaceView>().firstOrNull() }
    }

    private fun surfacePixels() = PageDriver.pixelsOf(checkNotNull(surfaceView()) { "the placed surface" })

    /** The pixels of `rows` of the bitmap that are not the pane's background, taken from its bottom right corner (no row reaches it before the screen is full). */
    private fun ink(bitmap: Bitmap, rows: IntRange = 0 until bitmap.height): Int {
        val background = bitmap.getPixel(bitmap.width - 1, bitmap.height - 1)
        var count = 0
        for (y in rows) for (x in 0 until bitmap.width) if (bitmap.getPixel(x, y) != background) count++
        return count
    }

    private fun checksum(bitmap: Bitmap): Int {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return pixels.contentHashCode()
    }

    private fun awaitInk(what: String, enough: (Bitmap) -> Boolean): Bitmap {
        var last = 0
        try { return PageDriver.poll("ink for $what on the surface", 90) { surfacePixels().takeIf { bitmap -> last = ink(bitmap); enough(bitmap) } } }
        catch (error: AssertionError) { throw AssertionError("${error.message}; the surface held $last non-background pixels", error) }
    }

    /** The surface once two captures in a row agree (the renderer has finished drawing) and `wanted` holds of it. */
    private fun settled(what: String, wanted: (Bitmap) -> Boolean): Bitmap {
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
    private fun settledAfter(what: String, other: Bitmap) = settled(what) { checksum(it) != checksum(other) }

    private fun typeIntoTheSurface(command: String, enter: Boolean = true) {
        val input = checkNotNull(ui { activity ->
            (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<TerminalInputView>().firstOrNull() }
        }) { "the session's keyboard editor" }
        ui {
            val connection = checkNotNull(input.onCreateInputConnection(EditorInfo()))
            connection.commitText(command, 1)
            // A line break the keyboard commits as text is a carriage return, as in NativeTerminalInputTest.
            if (enter) connection.commitText("\n", 1)
        }
    }

    private fun surfaceBounds(): Rect {
        val view = checkNotNull(surfaceView())
        return ui { IntArray(2).also(view::getLocationOnScreen).let { Rect(it[0], it[1], it[0] + view.width, it[1] + view.height) } }
    }

    /** A finger drag over the pane, on the screen, the way a user scrolls it. */
    private fun drag(fromFraction: Double, toFraction: Double) {
        val bounds = surfaceBounds()
        val x = bounds.centerX()
        UiDevice.getInstance(instrumentation).swipe(x, bounds.top + (bounds.height() * fromFraction).roundToInt(), x, bounds.top + (bounds.height() * toFraction).roundToInt(), 20)
    }

    /** Chooses Native, connects to the owned shell and returns the placed native session's id once the page shows its native pane. */
    private fun startNativeSession(): String {
        chooseNative()
        connect()
        until("the native pane on the page", 120, "Boolean(document.querySelector(${quoted(nativePane)})) && !document.querySelector('.terminal-canvas .xterm-screen')")
        return session()
    }

    /**
     * Who owns the keyboard (#2489, #2490): the terminal's editor takes Android's view focus when the page asks for it and the keyboard
     * is served to it, a field of the page that takes DOM focus gets the keys instead (the editor lets go), and the terminal gets them
     * back when it asks again. The oracle is the keys themselves, injected by the shell as a keyboard would: where they land says who
     * holds the focus.
     */
    private fun keyboardOwnership(id: String) {
        val prompt = fixture.getString("prompt").trim()
        val input = checkNotNull(ui { activity ->
            (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<TerminalInputView>().firstOrNull() }
        }) { "the session's keyboard editor" }
        val imm = instrumentation.targetContext.getSystemService(android.view.inputmethod.InputMethodManager::class.java)

        fun keyboardVisible() = ui { activity ->
            ViewCompat.getRootWindowInsets(activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        PageDriver.invoke("native_terminal_surface_focus", "{session:${quoted(id)},focused:false}")
        PageDriver.poll("the editor and keyboard to be closed before the tap", 30) {
            (ui { !input.hasFocus() } && !keyboardVisible()).takeIf { it }
        }
        val bounds = surfaceBounds()
        assertEquals("the screen received the plain terminal tap", true, UiDevice.getInstance(instrumentation).click(bounds.centerX(), bounds.centerY()))
        try {
            PageDriver.poll("the native editor to be served and the keyboard to open after the tap", 30) {
                (ui { input.hasFocus() && imm.isActive(input) } && keyboardVisible()).takeIf { it }
            }
        } catch (error: AssertionError) {
            val keyboard = keyboardVisible()
            val editor = ui { "focus=${input.hasFocus()}, served=${imm.isActive(input)}, attached=${input.isAttachedToWindow}" }
            throw AssertionError("${error.message}; editor $editor, keyboardVisible=$keyboard", error)
        }
        evidence.put("keyboardOpenedOnTap", true)
        evidence.put("keyboardEditorServed", true)
        shell("input text ab")
        awaitRow(id, "the keys typed at the focused editor", { it.startsWith(prompt) && it.endsWith("ab") })

        // A field of the page takes DOM focus, as the composer, a dialog or the search box does.
        js("(() => { const f = document.createElement('input'); f.id = 'lz-probe'; document.body.appendChild(f); f.focus(); return true; })()")
        PageDriver.poll("the editor to let go of the focus", 30) { ui { !input.hasFocus() }.takeIf { it } }
        // The WebView takes Android's focus and the page then reports itself focused; keys sent before that have no document to reach.
        try { PageDriver.poll("the page to be the focused document", 30) { js("document.hasFocus() && document.activeElement && document.activeElement.id === 'lz-probe'").takeIf { it == "true" } } }
        catch (error: AssertionError) {
            val web = ui { activity -> EdgeGestureExclusion.webView(activity.window.decorView)?.let { "webViewFocus=${it.hasFocus()} windowFocus=${it.hasWindowFocus()} editorFocus=${input.hasFocus()}" } }
            throw AssertionError("${error.message}; $web; page=${js("JSON.stringify({focus: document.hasFocus(), active: document.activeElement && document.activeElement.tagName + '#' + document.activeElement.id})")}", error)
        }
        shell("input text zz")
        PageDriver.poll("the keys to reach the page's field", 30) { js("document.getElementById('lz-probe').value").takeIf { it == "\"zz\"" } }
        assertEquals("the terminal got none of the page field's keys", false, coreText(id).lines().any { it.trim().endsWith("abzz") || it.trim().endsWith("zz") })
        js("(() => { const f = document.getElementById('lz-probe'); f.blur(); f.remove(); return true; })()")

        // The terminal asks again and the keys come back to it.
        PageDriver.invoke("native_terminal_surface_focus", "{session:${quoted(id)},focused:true}")
        PageDriver.poll("the editor to hold the focus again", 30) { ui { input.hasFocus() }.takeIf { it } }
        shell("input text cd")
        awaitRow(id, "the keys typed after the page's field", { it.startsWith(prompt) && it.endsWith("abcd") })
        typeIntoTheSurface("")
        evidence.put("keyboardHandedBackAndForth", true)
    }

    /**
     * The toolbar's keys on the native session (#2493): `cat -vT` shows what the shell receives. Esc, Tab, Home, End and Shift+Tab are pressed on
     * the page's toolbar, then Ctrl and a letter the soft keyboard commits (the toolbar's modifier applies to the next character typed), then
     * Enter; Ctrl+D ends cat. The answer is the one row of caret notation the bytes make.
     */
    private fun toolbarKeys(id: String) {
        // The keys go to cat, not to the shell's line editor: wait until the shell has printed the marker and so started it.
        typeIntoTheSurface("echo catv-started; cat -vT")
        awaitRow(id, "cat to have started", { it == "catv-started" })
        Thread.sleep(500)
        for (key in listOf("esc", "tab", "Home", "End")) click("button", key)
        click("button", "Shift")
        click("button", "tab")
        click("button", "ctrl")
        // The IME queues the letter and Enter together so Enter cannot consume the sticky Ctrl first.
        typeIntoTheSurface("a")
        try { awaitRow(id, "cat -vT's caret notation of the toolbar's keys", { it == "^[^I^[[H^[[F^[[Z^A" }) }
        catch (error: AssertionError) { throw AssertionError("${error.message}; the screen held:\n${coreText(id)}", error) }
        click("button", "ctrl")
        click("button", "d")
        awaitRow(id, "the prompt after cat ended", { it == fixture.getString("prompt").trim() })
        evidence.put("toolbarKeysThroughCatV", true)
    }

    /**
     * A multiplexer in the native session (B10): tmux started from the session's shell runs a server and splits a window, the core shows
     * what tmux answers, and the attached client's two panes, border and status line (#2487) are in the core's text. It reads the core's text, not the DOM, runs at the end of the one case (a second case in this
     * class starts from the page the first leaves) and needs the tmux the job installs.
     */
    private fun hostTmux(id: String) {
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
        typeIntoTheSurface("echo term=\$TERM; tmux -f /dev/null new-session -d -s native-mux -n check && tmux split-window -d -h -t native-mux && echo panes=\$(tmux list-panes -t native-mux | wc -l)")
        val answered = awaitRow(id, "tmux's answer for two panes", { it == "panes=2" })
        evidence.put("tmuxTerm", answered.lines().firstOrNull { it.trim().startsWith("term=") }?.trim() ?: "")
        // The client attached: tmux draws its two panes with a border and its status line on the last row, as the core's text holds them.
        // tmux cuts the status line's left part ("[native-mux] ") to its default length of 10 characters, which is why the row starts "[native-mu".
        typeIntoTheSurface("tmux attach -t native-mux")
        val screen = awaitRow(id, "tmux's status line on the last row", { it.startsWith("[native-mu") && it.contains("0:check") })
        evidence.put("tmuxStatusLine", screen.lines().last { it.startsWith("[native-mu") }.trim()).put("tmuxScreenRows", screen.lines().size)
        assertEquals("the status line is the screen's last row", screen.lines().last { it.isNotBlank() }.trim(), screen.lines().last { it.startsWith("[native-mu") }.trim())
        awaitRow(id, "the border between tmux's two panes", { it.contains("│") })
        typeIntoTheSurface("tmux kill-server")
    }

    @Test fun aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart() {
        val started = System.nanoTime()
        fun elapsed() = (System.nanoTime() - started) / 1_000_000
        evidence.put("probe", JSONObject(PageDriver.invoke("native_terminal_probe")))
        try {
            val id = startNativeSession()
            evidence.put("sessionOpenedMs", elapsed())

            // The core's own output: the owned shell's prompt, and a surface the renderer drew it on.
            val prompt = fixture.getString("prompt").trim()
            awaitRow(id, "the prompt", { it == prompt || it.startsWith(prompt) })
            val drawn = awaitInk("the prompt") { ink(it, 0 until it.height / 6) > 40 }
            evidence.put("promptDrawnMs", elapsed()).put("inkAfterPrompt", ink(drawn)).put("inkInTopRows", ink(drawn, 0 until drawn.height / 6))
            assertEquals("nothing is drawn far below the one row of output", 0, ink(drawn, drawn.height / 2 until drawn.height))
            Evidence.recordPicture("native-session-surface-prompt", drawn)
            // The page over the surface is what a user sees: the WebView lets it through (A4), so the screen holds the same ink.
            val screen = checkNotNull(instrumentation.uiAutomation.takeScreenshot()) { "the screenshot" }
            Evidence.recordPicture("native-session-screen-prompt", screen)

            // Typing through the keyboard's InputConnection reaches the shell and its answer is drawn. A steady cursor keeps the picture the same from frame to frame.
            typeIntoTheSurface("printf '\\033[2 q'; ${fixture.getString("challenge")}")
            val answer = fixture.getString("expected")
            awaitRow(id, "the program's answer", { it == answer })
            // The typed line and the answer add far more ink than a steady cursor does.
            val typed = settled("the answer") { ink(it) > ink(drawn) + 200 }
            evidence.put("answerDrawnMs", elapsed()).put("inkAfterAnswer", ink(typed))

            // Output that does not fit the screen, then a finger scrolls the pane back through it.
            typeIntoTheSurface("seq 1 150")
            awaitRow(id, "the last number", { it == "150" })
            val bottom = settledAfter("the numbers", typed)
            val atBottom = coreText(id)
            drag(0.25, 0.85)
            val scrolled = PageDriver.poll("the viewport to move back through the output", 60) { coreText(id).takeIf { text -> !text.lines().any { it.trim() == "150" } } }
            val moved = settledAfter("the scrolled screen", bottom)
            evidence.put("scrolledBack", scrolled.lines().firstOrNull { it.trim().toIntOrNull() != null }?.trim() ?: "").put("bottomRows", atBottom.lines().size)
            Evidence.recordPicture("native-session-surface-scrolled", moved)
            drag(0.85, 0.15)
            awaitRow(id, "the bottom again", { it == "150" })
            val back = settledAfter("the bottom again", moved)
            assertEquals("the same rows are drawn the same way after the finger came back", checksum(bottom), checksum(back))

            // Stop and start: the window takes the surface and gives a new one, and the session is drawn again from the core's state.
            scenario.moveToState(Lifecycle.State.CREATED)
            scenario.moveToState(Lifecycle.State.RESUMED)
            // The page is the session's workspace now, not the start page `awaitStartPage` waits for.
            PageDriver.poll("the resumed window", 120) { if (NativeActivityFixture.readiness(scenario).ready && js("Boolean(window.__TAURI_INTERNALS__?.invoke)") == "true") true else null }
            PageDriver.poll("a new generation of the surface", 90) {
                JSONObject(PageDriver.invoke("native_terminal_surface_state", "{session:${quoted(id)}}")).takeIf { it.getBoolean("ready") && it.getInt("generation") >= 2 }
            }
            val again = settled("the session after stop and start") { true }
            evidence.put("afterStopAndStartMs", elapsed()).put("sameChecksum", checksum(again) == checksum(back))
            Evidence.recordPicture("native-session-surface-restarted", again)
            assertEquals("the new surface shows the session as the old one did", checksum(back), checksum(again))

            // The keyboard is the terminal's when it asks and the page's when a page field takes it.
            keyboardOwnership(id)
            // Every toolbar key writes what the shell expects; the modifiers apply to the soft keyboard's next character.
            toolbarKeys(id)

            // A multiplexer in the same session, drawn by the core on the surface that has just been given back.
            hostTmux(id)
        } catch (error: Throwable) {
            evidence.put("failure", (error.message ?: error.toString()).take(700))
            throw error
        } finally {
            Evidence.record("native-session", evidence)
        }
    }
}
