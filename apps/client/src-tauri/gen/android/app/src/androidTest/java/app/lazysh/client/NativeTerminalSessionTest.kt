package app.lazysh.client

import android.content.ClipboardManager
import android.graphics.Bitmap
import android.os.Bundle
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.view.SurfaceView
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.math.roundToInt
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
    private var previousSoftwareGpu: Boolean? = null
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
        // A first connection asks for the notification permission; a system dialog would cover the page.
        runCatching { shell("pm grant app.lazysh.client android.permission.POST_NOTIFICATIONS") }
        PageDriver.awaitStartPage()
        // The CI emulator offers only a software adapter; the switch exists in a debug build only, and the probe reads it when the test selects the native engine.
        if (InstrumentationRegistry.getArguments().getString("lazyshSoftwareGpu") == "true") {
            previousSoftwareGpu = NativeSoftwareGpu.swap(true)
        }
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
        previousSoftwareGpu?.let { NativeSoftwareGpu.swap(it) }
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
            if (js("window.__lz.click(\"button[aria-label='Preferences']\") || window.__lz.click(\".dialog button\", \"Preferences\")") == "true") true
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
    private fun connect(ready: String = "false") {
        revealHosts()
        click("button[aria-label='Add host']")
        set("input[placeholder='Home workstation']", hostName)
        set("input[placeholder='workstation.local']", "127.0.0.1")
        set("input[placeholder='Your SSH username']", fixture.getString("username"))
        set(".port-field input", fixture.getInt("port").toString())
        // The default transport is Auto, which would try Mosh first; this case is about the native engine on the SSH route.
        set("[role=dialog] select:has(option[value='ssh'])", "ssh")
        click("button", "Save host")
        connectSavedHost(trustNewKey = true, ready = ready)
    }

    private fun connectSavedHost(trustNewKey: Boolean, ready: String = "false") {
        until("the saved host", 60, "Boolean(window.__lz.find(\"button[aria-label='Connect to $hostName']\"))")
        click("button[aria-label='Connect to $hostName']")
        until("the connection dialog", 60, "Boolean(window.__lz.find('[role=dialog] form .destination'))")
        click("[role=dialog] button", "Private key")
        set("[role=dialog] form.form-stack > label > textarea", fixture.getString("privateKey"))
        click("[role=dialog] form.form-stack button[type=submit]")
        if (trustNewKey) {
            val expectedKey = "document.querySelector('.fingerprint code')?.textContent === ${quoted(fixture.getString("fingerprint"))}"
            until("the expected host key or the owned shell prompt", 60, "($expectedKey) || ($ready)")
            if (js(expectedKey) == "true") click("button", "Trust key and connect")
        }
    }

    private fun session(replaced: String? = null) = PageDriver.poll("the placed native session", 120) {
        ui { TerminalSurfaces.ids().singleOrNull { it != replaced && TerminalSurfaces.state(it).let { state -> state.placed && state.ready } } }
    }

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
    private fun screenPoint(selector: String, label: String? = null): Pair<Int, Int> {
        val point = PageDriver.poll("visible touch target $selector", 15) {
            val result = js("""
                (() => {
                    const target = window.__lz.find(${quoted(selector)}${label?.let { ", ${quoted(it)}" } ?: ""});
                    if (!target) return null;
                    const rect = target.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
                    return target.contains(document.elementFromPoint(x,y)) ? [x,y,innerWidth] : null;
                })()
            """.trimIndent())
            result.takeIf { it.startsWith("[") }?.let(::JSONArray)
        }
        return ui { activity ->
            val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView))
            val origin = IntArray(2).also(web::getLocationOnScreen)
            val scale = web.width / point.getDouble(2)
            (origin[0] + point.getDouble(0) * scale).roundToInt() to
                (origin[1] + point.getDouble(1) * scale).roundToInt()
        }
    }

    private fun verifySelectionCopy(id: String) {
        val clipboard = instrumentation.targetContext.getSystemService(ClipboardManager::class.java)
        val previous = ui { clipboard.primaryClip }
        val marker = "lazysh${fixture.getString("nonce").take(8)}"
        val line = "$marker next"
        val device = UiDevice.getInstance(instrumentation)
        fun tap(selector: String, label: String) {
            val (x, y) = screenPoint(selector, label)
            assertEquals("the screen received the $label tap", true, device.click(x, y))
        }
        fun clipboardText() = ui { clipboard.primaryClip?.getItemAt(0)?.text?.toString() }
        fun expectCopy(expected: String) = PageDriver.poll("exact text on the Android clipboard", 15) {
            clipboardText()?.takeIf { it == expected }
        }
        fun printAtTop(text: String): Triple<Int, Int, Double> {
            typeIntoTheSurface("printf '\\033[2J\\033[H%s\\n' '$text'")
            awaitRow(id, "the marker on the first row", { it == text })
            val state = JSONObject(invoke("terminal_core_snapshot", id)).getJSONObject("state")
            val bounds = surfaceBounds()
            val width = bounds.width().toDouble() / state.getInt("columns")
            return Triple((bounds.left + 2.5 * width).roundToInt(),
                (bounds.top + 0.5 * bounds.height() / state.getInt("rows")).roundToInt(), width)
        }
        try {
            val (x, y, width) = printAtTop(line)
            fun selectWord() {
                assertEquals("the long press reached the native pane", true, device.swipe(x, y, x, y, 150))
                until("both native selection handles", 15, "document.querySelectorAll('[data-selection-handle]').length === 2")
            }
            selectWord()
            tap(".terminal-selection-tools button", "Copy")
            expectCopy(marker)
            evidence.put("nativeWordCopy", true)
            until("the copied selection to close", 15, "!document.querySelector('.terminal-selection-tools')")
            selectWord()
            val (handleX, handleY) = screenPoint("[data-selection-handle='end']")
            assertEquals("the finger dragged the end selection handle", true,
                device.swipe(handleX, handleY, handleX + ((line.length - marker.length) * width).roundToInt(), handleY, 20))
            // Let WebView settle the drag before starting the next, separate tap.
            device.waitForIdle()
            tap(".terminal-selection-tools button", "Copy")
            expectCopy(line)
            evidence.put("nativeSelectionHandleCopy", true)

            val url = "https://example.com/lazysh"
            val (linkX, linkY) = printAtTop(url)
            assertEquals("the screen received the terminal link tap", true, device.click(linkX, linkY))
            val link = "[aria-label='Terminal link']"
            until("the terminal link confirmation", 15, "document.querySelector(${quoted("$link p")})?.textContent === ${quoted(url)}")
            tap("$link button", "Copy URL")
            expectCopy(url)
            evidence.put("nativeLinkCopy", true)
            tap("$link button", "Dismiss link")

            val remote = "lazyshclipboard"
            val encoded = android.util.Base64.encodeToString(remote.toByteArray(), android.util.Base64.NO_WRAP)
            typeIntoTheSurface("printf '\\033]52;c;$encoded\\007'")
            val consent = "[aria-label='Remote clipboard request']"
            until("the remote clipboard confirmation", 15, "document.querySelector(${quoted("$consent pre")})?.textContent === ${quoted(remote)}")
            assertEquals("the clipboard stays unchanged before consent", url, clipboardText())
            tap("$consent button", "Allow this copy")
            expectCopy(remote)
            evidence.put("nativeOsc52ConsentCopy", true)
        } finally {
            ui { if (previous == null) clipboard.clearPrimaryClip() else clipboard.setPrimaryClip(previous) }
        }
    }

    private fun hostTmux(id: String) {
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

    private fun measureIdle(port: Int) {
        require(port in 1..65535)
        val probe = JSONObject(PageDriver.invoke("native_terminal_probe"))
        assertEquals("the native benchmark has an adapter", true, probe.getBoolean("available"))
        instrumentation.sendStatus(2, Bundle().apply { putString("lazyshNativeBenchmarkGpu", probe.getJSONObject("adapter").toString()) })
        val id = startNativeSession()
        val prompt = fixture.getString("prompt").trim()
        val nonce = fixture.getString("nonce")
        awaitRow(id, "the prompt before measuring idle", { it.startsWith(prompt) })
        awaitInk("the prompt before measuring idle") { ink(it, 0 until it.height / 6) > 40 }

        for ((variant, cursor) in listOf("blink-on" to 1, "blink-off" to 2)) {
            // Set the cursor in the SSH stream and check the marker before opening a measurement window.
            val marker = "lazysh-idle-$variant"
            typeIntoTheSurface("printf '\\033[$cursor q%s\\n' '$marker'")
            awaitRow(id, "the idle cursor mode", { it == marker })
            repeat(3) { sample ->
                val before = coreText(id)
                Socket().use { socket ->
                    socket.connect(InetSocketAddress("127.0.0.1", port), 5000)
                    socket.soTimeout = 45_000
                    socket.getOutputStream().write("$nonce $variant $sample\n".toByteArray(Charsets.US_ASCII))
                    // The host samples the guest while this thread blocks and the terminal is untouched.
                    assertEquals("the host completed the idle window", "done", socket.getInputStream().bufferedReader(Charsets.US_ASCII).readLine())
                }
                assertEquals("the idle screen text stays unchanged", before, coreText(id))
            }
        }
    }

    private fun checkXtermSshEcho() {
        val choice = "input[name='terminal-engine'][value='xterm']"
        openEngineSettings()
        choose(choice)
        until("xterm chosen", 30, "document.querySelector(${quoted(choice)}).checked")
        click("button[aria-label='Close Preferences']")
        val screen = ".terminal-canvas .xterm-screen"
        val prompt = quoted(fixture.getString("prompt").trim())
        val ready = """(() => {
            const screen = window.__lz.find(${quoted(screen)});
            return screen?.querySelector('.xterm-rows')?.textContent.trimEnd() === $prompt
                && !document.querySelector(${quoted(nativePane)});
        })()"""
        connect(ready)
        until("the owned SSH prompt on xterm", 60, ready)

        val expected = "abcdefghij".repeat(20)
        val marker = "lazysh-xterm-echo-ready"
        val command = "stty -icanon -echo -opost; printf '\\033[?25l\\033[2J\\033[H%s %s\\r\\n' '$marker' \"\$(stty size)\"; " +
            "dd bs=1 count=${expected.length} status=none; stty icanon echo; printf '\\r\\nlazysh-grid %s\\r\\n' \"\$(stty size)\""
        click("button[aria-label='Compose']")
        set(".terminal-compose textarea", command)
        val (sendX, sendY) = screenPoint(".terminal-compose button[aria-label='Send']:not(:disabled)")
        assertTrue("the composer receives the Send tap", UiDevice.getInstance(instrumentation).click(sendX, sendY))
        val firstRow = "window.__lz.find(${quoted(screen)})?.querySelector('.xterm-rows > div')?.textContent.trimEnd()"
        until("the remote raw echo program", 60, "$firstRow?.startsWith(${quoted("$marker ")}) === true")
        val size = Regex("$marker ([1-9][0-9]*) ([1-9][0-9]*)").matchEntire(JSONTokener(js(firstRow)).nextValue() as String)
        val (promptRows, cols) = checkNotNull(size) { "the SSH PTY's rows and columns" }.destructured
        val editorReady = """(() => {
            const editor = document.activeElement;
            return editor.matches('.terminal-canvas .xterm-helper-textarea') && !editor.readOnly;
        })()"""
        if (js(editorReady) != "true") click("button[aria-label='Show keyboard'], button[aria-label='Toggle keyboard']")
        until("the active xterm keyboard editor", 15, editorReady)

        fun keyboardVisible() = ui { activity ->
            ViewCompat.getRootWindowInsets(activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true
        }
        var lastRows = 0
        var stableSince = 0L
        PageDriver.poll("the xterm grid to settle with the keyboard visible", 15) {
            val keyboardVisible = keyboardVisible()
            val rows = js("window.__lz.find(${quoted(screen)})?.querySelector('.xterm-rows')?.children.length").toIntOrNull() ?: 0
            if (!keyboardVisible || rows != lastRows) {
                lastRows = rows
                stableSince = System.nanoTime()
            }
            true.takeIf { keyboardVisible && rows > 0 && System.nanoTime() - stableSince >= 500_000_000 }
        }

        // Each WebView timestamp falls inside its Android call interval.
        fun clockOffset() = List(8) {
            val before = System.nanoTime() / 1e6
            val web = js("performance.now()").toDouble()
            val after = System.nanoTime() / 1e6
            (before - web) to (after - web)
        }.reduce { left, right -> maxOf(left.first, right.first) to minOf(left.second, right.second) }
        val beforeClock = clockOffset()

        assertEquals("observe trusted keys and rendered echoes", "true", js("""(() => {
            const screen = window.__lz.find(${quoted(screen)});
            const rows = screen.querySelector('.xterm-rows');
            const editor = screen.parentElement.querySelector('.xterm-helper-textarea');
            const expected = ${quoted(expected)};
            const proof = { samples: [], renderedAt: [], rows: 0, stable: true };
            let started, framePort;
            const connectPort = event => {
                if (event.data !== 'lazysh-xterm-frame-probe' || event.ports.length !== 1) return;
                framePort = event.ports[0];
                window.removeEventListener('message', connectPort);
                proof.framePortReady = true;
            };
            window.addEventListener('message', connectPort);
            editor.addEventListener('beforeinput', event => {
                if (event.isTrusted && event.data === expected[proof.samples.length]) started = event.timeStamp;
            });
            const observer = new MutationObserver(() => {
                if (started === undefined) return;
                const count = proof.samples.length + 1;
                const lines = Array.from(rows.children, row => row.textContent.trimEnd());
                if (lines[0] !== ${quoted("$marker $promptRows $cols")} || !lines.slice(1).join('').startsWith(expected.slice(0, count))) return;
                if (count === 1) proof.rows = rows.children.length;
                else proof.stable &&= rows.children.length === proof.rows;
                const renderedAt = performance.now();
                proof.samples.push(renderedAt - started);
                proof.renderedAt.push(renderedAt);
                framePort.postMessage(String(count));
                started = undefined;
                if (count === expected.length) observer.disconnect();
            });
            observer.observe(rows, { subtree: true, childList: true, characterData: true });
            window.__lazyshXtermEcho = proof;
            return true;
        })()"""))
        check(Build.VERSION.SDK_INT >= 29) { "Frame submission measurement requires Android 10" }
        val frames = LinkedBlockingQueue<Pair<Int, Double>>()
        val port = ui { activity ->
            val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) as WebView
            check(web.isAttachedToWindow && web.isHardwareAccelerated)
            val (local, page) = web.createWebMessageChannel()
            local.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(port: WebMessagePort, message: WebMessage) {
                    val echo = checkNotNull(message.data?.toIntOrNull())
                    web.postVisualStateCallback(echo.toLong(), object : WebView.VisualStateCallback() {
                        override fun onComplete(requestId: Long) {
                            web.viewTreeObserver.registerFrameCommitCallback {
                                frames.add(requestId.toInt() to System.nanoTime() / 1e6)
                            }
                            web.invalidate()
                        }
                    })
                }
            })
            web.postWebMessage(WebMessage("lazysh-xterm-frame-probe", arrayOf(page)), Uri.parse(checkNotNull(web.url)))
            local
        }
        val echoBounds = JSONArray(js("""(() => {
            const rows = window.__lz.find(${quoted(screen)}).querySelectorAll('.xterm-rows > div');
            const first = rows[1].getBoundingClientRect();
            const last = rows[${(expected.length + cols.toInt() - 1) / cols.toInt()}].getBoundingClientRect();
            return [first.left, first.top, first.right, last.bottom, innerWidth];
        })()"""))
        val pixels = ui { activity ->
            val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView))
            val origin = IntArray(2).also(web::getLocationOnScreen)
            val scale = web.width / echoBounds.getDouble(4)
            val bounds = Rect(
                origin[0] + (echoBounds.getDouble(0) * scale).roundToInt(),
                origin[1] + (echoBounds.getDouble(1) * scale).roundToInt(),
                origin[0] + (echoBounds.getDouble(2) * scale).roundToInt(),
                origin[1] + (echoBounds.getDouble(3) * scale).roundToInt(),
            )
            bounds
        }.let { TerminalEchoPixels(instrumentation.uiAutomation, it) }
        val displayTimings = mutableListOf<Double>()
        val dispatches = mutableListOf<Double>()
        val frameTimings = mutableListOf<Double>()
        try {
            until("the WebView frame probe port", 10, "window.__lazyshXtermEcho.framePortReady === true")
            for ((index, key) in expected.withIndex()) {
                val dispatchedAt = ui { activity ->
                    val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView))
                    val editor = checkNotNull(web.onCreateInputConnection(EditorInfo()))
                    val started = System.nanoTime() / 1e6
                    assertTrue("the WebView receives key ${index + 1}", editor.commitText(key.toString(), 1))
                    started
                }
                dispatches.add(dispatchedAt)
                displayTimings.add(pixels.awaitEcho(dispatchedAt))
                val (echo, committedAt) = checkNotNull(frames.poll(10, TimeUnit.SECONDS)) {
                    "The WebView did not submit a frame for echo ${index + 1}"
                }
                assertEquals("the committed frame corresponds to the current echo", index + 1, echo)
                frameTimings.add(committedAt - dispatchedAt)
            }
        } finally {
            ui { port.close() }
        }
        val afterClock = clockOffset()
        val lower = maxOf(beforeClock.first, afterClock.first)
        val upper = minOf(beforeClock.second, afterClock.second)
        assertTrue("Android and WebView clocks agree to within 2 ms: $lower..$upper", upper - lower in 0.0..2.0)
        val proof = JSONObject(js("window.__lazyshXtermEcho"))
        val rendered = proof.getJSONArray("renderedAt")
        val androidTimings = dispatches.mapIndexed { index, dispatch ->
            val elapsed = rendered.getDouble(index) + (lower + upper) / 2 - dispatch
            assertTrue("the DOM update follows Android dispatch", elapsed >= 0)
            elapsed
        }
        assertTrue("each committed frame follows its row update within clock uncertainty",
            frameTimings.zip(androidTimings).all { (frame, dom) -> frame + (upper - lower) / 2 >= dom })
        val timings = proof.getJSONArray("samples")
        assertTrue("the rendered row count stayed stable", proof.getInt("rows") > 0 && proof.getBoolean("stable"))
        assertEquals("the 200 rendered echoes", expected.length, timings.length())
        assertTrue("all echo latencies are valid", (0 until timings.length()).all { timings.getDouble(it).let { ms -> ms.isFinite() && ms >= 0 } })
        val finalGrid = quoted("lazysh-grid ${proof.getInt("rows")} $cols")
        until("the final SSH PTY size to match the xterm grid", 15, """Array.from(
            window.__lz.find(${quoted(screen)}).querySelectorAll('.xterm-rows > div'),
            row => row.textContent.trimEnd()).includes($finalGrid)""")
        assertTrue("xterm did not create a native surface", ui { TerminalSurfaces.ids().isEmpty() })
        closeOwnedXtermTab()
        val inputSha256 = java.security.MessageDigest.getInstance("SHA-256")
            .digest(expected.toByteArray(Charsets.US_ASCII)).joinToString("") { "%02x".format(it) }
        val record = JSONObject().put("engine", "xterm").put("transport", "ssh").put("inputSha256", inputSha256)
            .put("ptyRowsBeforeFocus", promptRows.toInt()).put("ptyColumns", cols.toInt())
            .put("renderedRows", proof.getInt("rows")).put("ptyRowsAfterInput", proof.getInt("rows"))
            .put("webViewBeforeInputToDomMs", timings)
            .put("clockUncertaintyMs", (upper - lower) / 2).put("androidDispatchToDomMs", JSONArray(androidTimings))
            .put("androidDispatchToFrameCommitMs", JSONArray(frameTimings))
            .put("androidDispatchToDisplayCaptureMs", JSONArray(displayTimings))
        Evidence.record("xterm-ssh-echo", record)
        instrumentation.sendStatus(2, android.os.Bundle().apply { putString("lazyshXtermSshEcho", record.toString()) })
    }

    private fun closeOwnedXtermTab() {
        val ownedTabClose = ".session-tabs button[aria-label='Disconnect $hostName']"
        act("""(() => {
            const buttons = document.querySelectorAll(${quoted(ownedTabClose)});
            if (buttons.length !== 1 || buttons[0].disabled) return false;
            buttons[0].click();
            return true;
        })()""", "disconnect the exact owned SSH tab")
        until("the owned xterm session to close", 30, "!document.querySelector(${quoted(ownedTabClose)})")
    }

    private fun checkBuildTimeKillSwitch() {
        val override = js("localStorage.getItem('lazysh.terminal.backend')")
        js("""(() => {
            const key = 'lazysh.preferences.v1';
            const preferences = JSON.parse(localStorage.getItem(key) ?? '{}');
            localStorage.setItem(key, JSON.stringify({...preferences, version: 1, terminalEngine: 'native'}));
            localStorage.setItem('lazysh.terminal.backend', 'native');
            return true;
        })()""")
        try {
            scenario.recreate()
            PageDriver.awaitStartPage()
            PageDriver.js(driver)
            val probe = JSONObject(PageDriver.invoke("native_terminal_probe"))
            assertEquals("the app build cannot offer the native core", false, probe.getBoolean("available"))
            val cell = PageDriver.invoke("native_terminal_surface_cell", "{fontSize:14,dpr:1}")
            assertEquals("the surface command reports the build-time switch", "error The native terminal is disabled in this build", cell)
            openEngineSettings()
            until("Native disabled in Preferences", 30, "document.querySelector(${quoted(native)})?.disabled === true")
            click("button[aria-label='Close Preferences']")
            val prompt = quoted(fixture.getString("prompt").trim())
            val ready = """(() => {
                const rows = document.querySelector('.terminal-canvas .xterm-rows');
                return rows?.textContent.trimEnd() === $prompt && !document.querySelector(${quoted(nativePane)});
            })()"""
            connect(ready)
            until("the real SSH prompt in xterm", 30, ready)
            closeOwnedXtermTab()
            Evidence.record("native-kill-switch", JSONObject().put("probe", probe).put("nativeChoiceDisabled", true).put("sshPromptDrawnInXterm", true))
        } finally {
            js("(() => { const prior = $override; if (prior === null) localStorage.removeItem('lazysh.terminal.backend'); else localStorage.setItem('lazysh.terminal.backend', prior); return true; })()")
        }
    }

    @Test fun aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart() {
        if (InstrumentationRegistry.getArguments().getString("lazyshKillSwitch") == "true") {
            checkBuildTimeKillSwitch()
            return
        }
        val idlePort = InstrumentationRegistry.getArguments().getString("lazyshIdleBenchPort")
        if (idlePort != null) {
            measureIdle(idlePort.toInt())
            return
        }
        if (InstrumentationRegistry.getArguments().getString("lazyshXtermSshEcho") == "true") {
            checkXtermSshEcho()
            return
        }
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
            verifySelectionCopy(id)
            // The pane follows a rotation, the keyboard and a recreated Activity (#2502).
            val fresh = followsTheDevice(id)

            // A multiplexer in the reconnected session, drawn by the core on its new surface.
            hostTmux(fresh)
        } catch (error: Throwable) {
            evidence.put("failure", (error.message ?: error.toString()).take(700))
            throw error
        } finally {
            Evidence.record("native-session", evidence)
        }
    }

    /** The grid the core holds, as the pane told it (columns, rows). */
    private fun coreGrid(session: String) = JSONObject(invoke("terminal_core_snapshot", session)).getJSONObject("state").let { it.getInt("columns") to it.getInt("rows") }

    /** What the remote pty answers to `stty size` (rows, columns), read from the core's text under a tag that nothing else prints. */
    private fun ptyGrid(session: String, tag: String): Pair<Int, Int> {
        typeIntoTheSurface("echo $tag=\$(stty size)")
        val row = awaitRow(session, "the pty's size for $tag", { Regex("$tag=\\d+ \\d+").matches(it) }).lines().last { Regex("$tag=\\d+ \\d+").matches(it.trim()) }.trim()
        val (rows, columns) = row.substringAfter("=").split(" ").map(String::toInt)
        return columns to rows
    }

    /** The cell the renderer draws for the page's configured font size, in device pixels (`native_terminal_surface_cell`). */
    private fun cellOfTheSession(): Pair<Int, Int> {
        val dpr = JSONTokener(js("window.devicePixelRatio")).nextValue().toString().toDouble()
        val fontSize = js("JSON.parse(localStorage.getItem('lazysh.preferences.v1'))?.fontSize ?? 14").toInt()
        return JSONObject(PageDriver.invoke("native_terminal_surface_cell", "{fontSize:$fontSize,dpr:$dpr}")).let { it.getInt("width") to it.getInt("height") }
    }

    /**
     * The pane holds the grid the session has (#2502): the core's grid is the whole cells of the surface, the remote pty has the same size, the
     * prompt is drawn (no blank frame) and the session still answers. `name` labels the evidence of the step.
     */
    private fun assertThePaneHoldsItsGrid(session: String, name: String, tag: String): Pair<Int, Int> {
        val cell = cellOfTheSession()
        val bitmap = settled("$name: a drawn surface") { ink(it) > 40 }
        val (columns, rows) = coreGrid(session)
        val fits = columns to rows
        evidence.put("$name-surface", "${bitmap.width}x${bitmap.height}").put("$name-cell", "${cell.first}x${cell.second}").put("$name-grid", "$columns x $rows")
        Evidence.recordPicture("native-session-$name", bitmap)
        assertTrue("$name: the grid is whole cells of the surface: $columns columns of ${cell.first}px in ${bitmap.width}px", columns >= bitmap.width / cell.first - 1 && columns <= bitmap.width / cell.first)
        assertTrue("$name: the grid is whole rows of the surface: $rows rows of ${cell.second}px in ${bitmap.height}px", rows >= bitmap.height / cell.second - 1 && rows <= bitmap.height / cell.second)
        assertEquals("$name: the remote pty has the grid the pane holds", fits, ptyGrid(session, tag))
        return fits
    }

    /** What decides the pane's size right now, for the evidence and for a failure: the keyboard's inset, the surface on screen and the page's anchor. */
    private fun paneState(session: String): String {
        val view = surfaceView()
        val screen = ui { activity ->
            val decor = activity.window.decorView
            val insets = androidx.core.view.ViewCompat.getRootWindowInsets(decor)
            val ime = androidx.core.view.WindowInsetsCompat.Type.ime()
            "imeVisible=${insets?.isVisible(ime)} imeBottom=${insets?.getInsets(ime)?.bottom} decor=${decor.width}x${decor.height}" +
                (view?.let { v -> IntArray(2).also(v::getLocationOnScreen).let { " surface@${it[0]},${it[1]} ${v.width}x${v.height}" } } ?: " no surface")
        }
        val anchor = js("(() => { const r = document.querySelector(${quoted(nativePane)})?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height, window.innerHeight, window.devicePixelRatio].join(' ') : 'no anchor'; })()")
        return "$screen anchor(x y w h innerHeight dpr)=$anchor grid=${coreGrid(session)}"
    }

    /** Waits for the window orientation and a new grid. The keyboard can make a portrait surface wider than it is tall. */
    private fun awaitTheGridToFollow(session: String, landscape: Boolean, previous: Pair<Int, Int>) =
        PageDriver.poll("the pane to be ${if (landscape) "landscape" else "portrait"} with a new grid", 90) {
            val view = surfaceView()
            val sideways = ui { activity -> activity.window.decorView.let { it.width > it.height } }
            if (view != null && sideways == landscape && coreGrid(session) != previous) true else null
        }

    /**
     * The native pane follows the device (#2502): a rotation, the soft keyboard and a recreated Activity each leave the grid the core holds at the
     * whole cells of the surface, the remote pty the same size, the prompt drawn and the session taking input; the keyboard leaves the last row
     * of the pane above itself. A step of the one session case (a second case would start from the page the first leaves).
     */
    private fun followsTheDevice(id: String): String {
        val device = UiDevice.getInstance(instrumentation)
        val imeSetting = "show_ime_with_hard_keyboard"
        val previousIme = shell("settings get secure $imeSetting").decodeToString().trim()
        try {
            ui { activity -> SoftKeyboard.set(activity.window, false) }
            PageDriver.poll("the soft keyboard to be hidden before layout checks", 30) {
                ui { activity -> SoftKeyboard.visible(activity.window) }.takeIf { !it }
            }
            val portrait = assertThePaneHoldsItsGrid(id, "portrait", "pa")

            // A rotation: the window turns, the pane is placed again at its new size and the core is refitted to it.
            device.setOrientationLeft()
            awaitTheGridToFollow(id, true, portrait)
            val landscape = assertThePaneHoldsItsGrid(id, "landscape", "pb")
            assertTrue("landscape is wider than portrait ($landscape, $portrait)", landscape.first > portrait.first && landscape.second < portrait.second)
            device.setOrientationNatural()
            awaitTheGridToFollow(id, false, landscape)
            val portraitAgain = assertThePaneHoldsItsGrid(id, "portrait-again", "pc")

            // The soft keyboard shows over the lower part of the window: the pane gives way, and its last row stays above the keyboard.
            shell("settings put secure $imeSetting 1")
            typeIntoTheSurface("seq 1 200")
            awaitRow(id, "the numbers", { it == "200" })
            val input = checkNotNull(ui { activity ->
                (EdgeGestureExclusion.webView(activity.window.decorView)?.parent as? ViewGroup)?.let { frame -> (0 until frame.childCount).map(frame::getChildAt).filterIsInstance<TerminalInputView>().firstOrNull() }
            }) { "the session's keyboard editor" }
            ui { activity -> input.requestFocus(); SoftKeyboard.set(activity.window, true) }
            PageDriver.poll("the soft keyboard to show", 60) { ui { activity -> SoftKeyboard.visible(activity.window) }.takeIf { it } }
            evidence.put("keyboardShown", paneState(id))
            try { awaitTheGridToFollow(id, false, portraitAgain) }
            catch (error: AssertionError) { throw AssertionError("${error.message}; ${paneState(id)}", error) }
            val withKeyboard = assertThePaneHoldsItsGrid(id, "keyboard", "pd")
            assertTrue("the keyboard took rows from the pane ($withKeyboard, $portraitAgain)", withKeyboard.second < portraitAgain.second)
            val paneView = checkNotNull(surfaceView())
            val above = ui { activity ->
                val view = paneView
                val bottom = IntArray(2).also(view::getLocationOnScreen).let { it[1] + view.height }
                val keyboardTop = activity.window.decorView.height - (androidx.core.view.ViewCompat.getRootWindowInsets(activity.window.decorView)?.getInsets(androidx.core.view.WindowInsetsCompat.Type.ime())?.bottom ?: 0)
                bottom to keyboardTop
            }
            evidence.put("keyboardPaneBottomAndTop", "${above.first} ${above.second}")
            assertTrue("the pane ends above the keyboard (${above.first} <= ${above.second})", above.first <= above.second)
            val last = settled("the last row with the keyboard up") { true }
            val cell = cellOfTheSession()
            assertTrue("the last row of the pane is drawn", ink(last, (withKeyboard.second - 1) * cell.second until withKeyboard.second * cell.second) > 0)
            ui { activity -> SoftKeyboard.set(activity.window, false) }
            PageDriver.poll("the soft keyboard to hide", 60) { ui { activity -> SoftKeyboard.visible(activity.window) }.takeIf { !it } }
            awaitTheGridToFollow(id, false, withKeyboard)
            val withoutKeyboard = assertThePaneHoldsItsGrid(id, "keyboard-away", "pe")
            assertTrue("hiding the keyboard gives rows back", withoutKeyboard.second > withKeyboard.second)

            // Renderer replacement retires its sessions. Reconnect through the new page with fresh SSH authentication.
            typeIntoTheSurface("echo before-recreate")
            awaitRow(id, "the marker", { it == "before-recreate" })
            scenario.recreate()
            PageDriver.awaitStartPage()
            PageDriver.js(driver)
            val retired = PageDriver.poll("the old core to retire", 30) {
                invoke("terminal_core_text", id).takeIf { it == "error No native terminal core for this session" }
            }
            evidence.put("oldCoreRetired", retired.startsWith("error "))
            assertEquals("the new page has no old terminal pane", "false", js("Boolean(document.querySelector(${quoted(nativePane)}))"))

            revealHosts()
            connectSavedHost(trustNewKey = false)
            val fresh = try {
                session(replaced = id)
            } catch (error: AssertionError) {
                runCatching {
                    evidence.put("reconnectSurfaceStates", JSONArray(ui {
                        TerminalSurfaces.ids().map { sessionId ->
                            val state = TerminalSurfaces.state(sessionId)
                            JSONObject().put("oldSession", sessionId == id)
                                .put("placed", state.placed).put("ready", state.ready)
                        }
                    }))
                    evidence.put("reconnectNativePane", js("Boolean(document.querySelector(${quoted(nativePane)}))") == "true")
                    evidence.put("reconnectXtermPane", js("Boolean(document.querySelector('.terminal-canvas .xterm-screen'))") == "true")
                    val failure = js("""JSON.parse(localStorage.getItem('lazysh.terminal.failure.native') ?? 'null')?.reason ?? ''""")
                    evidence.put("reconnectNativeFailure", JSONTokener(failure).nextValue())
                }
                throw error
            }
            awaitRow(fresh, "the new shell prompt", { it == fixture.getString("prompt").trim() })
            val pane = checkNotNull(surfaceView())
            val centre = ui {
                val origin = IntArray(2).also(pane::getLocationOnScreen)
                (origin[0] + pane.width / 2) to (origin[1] + pane.height / 2)
            }
            device.click(centre.first, centre.second)
            PageDriver.poll("the new pane to open the keyboard", 30) {
                ui { activity -> SoftKeyboard.visible(activity.window) }.takeIf { it }
            }
            typeIntoTheSurface("echo after-recreate")
            awaitRow(fresh, "the new session taking input", { it == "after-recreate" })
            assertTrue("the new session does not show the old screen", coreText(fresh).lines().none { it.trim() == "before-recreate" })
            assertThePaneHoldsItsGrid(fresh, "recreated", "pf")
            return fresh
        } finally {
            runCatching { device.setOrientationNatural(); device.unfreezeRotation() }
            runCatching { shell("settings ${if (previousIme == "null") "delete secure $imeSetting" else "put secure $imeSetting $previousIme"}") }
        }
    }
}
