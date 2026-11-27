package app.lazysh.client

import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.Surface
import android.view.WindowInsets
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The full-functionality acceptance run of the native terminal engine on the Waydroid lane (docs/architecture/android-native-acceptance.md):
 * the cases a daily user meets, one after the other in one native session of the real app, each recorded as pass or fail with what it
 * observed (core text, surface pixels, clipboard, keyboard state), none stopping the next. The result is `native-acceptance.json` in the
 * evidence directory the lane pulls; the test fails when any case failed, after writing it. A case this guest cannot show is recorded as
 * `not-testable` with the reason, never as a pass. Fingers are real taps and swipes of `UiDevice` on screen coordinates read from the page
 * and the surface; the soft keyboard is the guest's own input method, whose keys are tapped.
 */
@RunWith(AndroidJUnit4::class)
class NativeAcceptanceTest {
    private val driver = NativeSessionDriver()
    private val instrumentation get() = driver.instrumentation
    private val device get() = UiDevice.getInstance(instrumentation)
    private val cases = JSONArray()
    private lateinit var id: String

    @Before fun theUnlockedPage() = driver.theUnlockedPage()

    @After fun leaveTheAppAsFound() {
        driver.leaveTheAppAsFound()
        for (command in listOf("wm size reset", "settings put system user_rotation 0", "settings put system accelerometer_rotation 1")) runCatching { driver.shell(command) }
    }

    /** Records a failed case and continues, unless Android has cancelled the run. */
    private fun case(name: String, title: String, priority: String = "P1", body: JSONObject.() -> Unit): Boolean {
        val started = SystemClock.elapsedRealtime()
        val evidence = JSONObject()
        val entry = JSONObject().put("id", name).put("title", title)
        val failure = runCatching { evidence.body() }.exceptionOrNull()
        val status = if (failure == null) "pass" else "fail"
        if (failure != null) {
            entry.put("priority", priority).put("error", (failure.message ?: failure.toString()).take(700))
        }
        val elapsed = SystemClock.elapsedRealtime() - started
        cases.put(entry.put("status", status).put("evidence", evidence).put("ms", elapsed))
        Log.i("lazysh-acceptance", "$name $status ${elapsed}ms")
        if (failure is InterruptedException) throw failure
        return failure == null
    }

    private fun notTestable(name: String, title: String, reason: String) {
        cases.put(JSONObject().put("id", name).put("title", title).put("status", "not-testable").put("reason", reason))
    }

    private fun check(what: String, holds: Boolean) = assertTrue(what, holds)

    private fun core() = driver.coreText(id)
    private fun rows() = core().lines().map { it.trim() }

    /** The screen position of the centre of a visible page element, or null: its CSS pixels turned into screen pixels through the WebView's own scale. */
    private fun pageCentre(selector: String, text: String? = null): Pair<Int, Int>? {
        val quotedText = text?.let { ", ${JSONObject.quote(it)}" } ?: ""
        val found = driver.js("(() => { const e = window.__lz.find(${JSONObject.quote(selector)}$quotedText); if (!e) return null; const r = e.getBoundingClientRect(); return {x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth}; })()")
        if (found == "null") return null
        return screenPoint(JSONObject(found))
    }

    private fun screenPoint(point: JSONObject) = driver.ui { activity ->
        val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) { "the WebView" }
        val origin = IntArray(2).also(web::getLocationOnScreen)
        val scale = web.width / point.getDouble("w")
        Pair((origin[0] + point.getDouble("x") * scale).roundToInt(), (origin[1] + point.getDouble("y") * scale).roundToInt())
    }

    /** One real finger tap on a page element. */
    private fun fingerTap(selector: String, text: String? = null) {
        val at = PageDriver.poll("a tappable $selector ${text ?: ""}", 30) { pageCentre(selector, text) }
        device.click(at.first, at.second)
    }

    /** The surface's bounds on the screen. */
    private fun surfaceBounds(): IntArray {
        val view = checkNotNull(driver.surfaceView()) { "the placed surface" }
        return driver.ui { IntArray(2).also(view::getLocationOnScreen).let { origin -> intArrayOf(origin[0], origin[1], origin[0] + view.width, origin[1] + view.height) } }
    }

    private fun surfaceTap(fractionX: Double, fractionY: Double) {
        val b = surfaceBounds()
        device.click((b[0] + (b[2] - b[0]) * fractionX).roundToInt(), (b[1] + (b[3] - b[1]) * fractionY).roundToInt())
    }

    private fun terminalFontSize() = PageDriver.js("JSON.parse(localStorage.getItem('lazysh.preferences.v1'))?.fontSize ?? 14").toInt()

    /** The core search reports physical cells even when the plain-text viewport joins wrapped lines. */
    private fun cellCentre(needle: String): Pair<Int, Int> {
        val state = JSONObject(driver.invoke("terminal_core_snapshot", id)).getJSONObject("state")
        val top = state.getJSONObject("viewport").getInt("top")
        val args = JSONObject().put("sessionId", id).put("query", needle).put("direction", "backward")
            .put("from", top + state.getInt("rows"))
        val hit = JSONObject(PageDriver.invoke("terminal_core_search", args.toString()))
        val row = hit.getInt("row") - top
        require(row in 0 until state.getInt("rows")) { "The expected text is off screen" }
        val column = hit.getInt("column") + needle.length / 2
        val dpr = PageDriver.js("devicePixelRatio").toDouble()
        val cell = JSONObject(PageDriver.invoke("native_terminal_surface_cell", "{fontSize:${terminalFontSize()},dpr:$dpr}"))
        val x = cell.getInt("width") * (column + 0.5) / dpr
        val y = cell.getInt("height") * (row + 0.5) / dpr
        val point = PageDriver.js("(() => { const r = document.querySelector('.terminal-canvas[data-terminal-surface=native]').getBoundingClientRect(); return {x: r.left + $x, y: r.top + $y, w: innerWidth}; })()")
        return screenPoint(JSONObject(point))
    }

    private fun softKeyboardShown() = driver.ui { activity ->
        if (Build.VERSION.SDK_INT >= 30) activity.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true else false
    }

    private fun inputMethodPackage() = String(driver.shell("settings get secure default_input_method")).trim().substringBefore('/')

    /** Types `text` by tapping the keys of the guest's own keyboard (lowercase letters, space and Enter). */
    private fun typeOnKeyboard(text: String, enter: Boolean = true, autoCapitalized: Boolean = false) {
        val pkg = inputMethodPackage()
        fun key(vararg labels: String) = PageDriver.poll("a keyboard key ${labels.first()} of $pkg", 20) {
            labels.firstNotNullOfOrNull { label -> device.findObject(By.pkg(pkg).desc(label)) ?: device.findObject(By.pkg(pkg).text(label)) }
        }
        for (ch in text) {
            val label = if (ch == ' ') "Space" else ch.toString()
            val labels = if (autoCapitalized && ch.isLetter()) arrayOf(label, label.uppercase()) else arrayOf(label)
            key(*labels).click()
        }
        if (enter) key("Enter", "Return", "Go", "Done", "Send").click()
    }

    private fun keyboardKeys(): List<String> {
        val pkg = inputMethodPackage()
        return device.findObjects(By.pkg(pkg)).mapNotNull { it.contentDescription ?: it.text }.distinct().take(80)
    }

    /** Types into the session as the surface's editor would receive it (the keyboard side, replayed in the process) and waits for the shell to answer. */
    private fun run(command: String, answer: (String) -> Boolean = { true }) {
        driver.typeIntoTheSurface(command)
        PageDriver.poll("the answer to $command", 60) { core().takeIf { text -> text.lines().any { answer(it.trim()) } } }
    }

    private fun awaitRow(what: String, row: (String) -> Boolean) = driver.awaitRow(id, what, row)

    private fun awaitPrompt() {
        val prompt = driver.fixture.getString("prompt").trim()
        PageDriver.poll("the fixture prompt on the native screen", 20) {
            core().lineSequence().joinToString("") { it.trimEnd() }.endsWith(prompt).takeIf { it }
        }
    }

    private fun clearScreen() {
        driver.typeIntoTheSurface("\u0015clear")
        PageDriver.poll("a cleared screen", 30) { core().takeIf { text -> text.lines().count { it.isNotBlank() } <= 2 } }
    }

    private fun ptySize(): Pair<Int, Int> {
        val marker = "SZ" + java.util.UUID.randomUUID().toString().take(4)
        // Hold the answer on screen. On a short grid the wrapped shell prompt can scroll it out.
        driver.typeIntoTheSurface("echo $marker=\$(stty size | tr ' ' x); read -r _")
        try {
            val pattern = Regex("^$marker=(\\d+)x(\\d+)$")
            val grid = PageDriver.poll("the pty size", 5) {
                core().lineSequence().mapNotNull { pattern.matchEntire(it.trim()) }.firstOrNull()
            }
            val (rows, columns) = grid.destructured
            return Pair(rows.toInt(), columns.toInt())
        } finally {
            driver.typeIntoTheSurface("")
        }
    }

    private fun paneGrid(): Pair<Int, Int> {
        val bounds = surfaceBounds()
        val dpr = PageDriver.js("devicePixelRatio").toDouble()
        val cell = JSONObject(PageDriver.invoke("native_terminal_surface_cell", "{fontSize:${terminalFontSize()},dpr:$dpr}"))
        return (bounds[3] - bounds[1]) / cell.getInt("height") to (bounds[2] - bounds[0]) / cell.getInt("width")
    }

    private fun awaitPtyGrid(stage: String, previous: Pair<Int, Int>? = null): Pair<Int, Int> {
        var last: Pair<Int, Int>? = null
        return PageDriver.poll("the settled pane, core and PTY grid $stage", 60) {
            if (softKeyboardShown()) {
                device.pressBack()
                last = null
                return@poll null
            }
            val pane = paneGrid()
            val stable = pane == last
            last = pane
            if (!stable || pane == previous || pane.first < 2 || pane.second < 2) return@poll null
            val state = JSONObject(driver.invoke("terminal_core_snapshot", id)).getJSONObject("state")
            val core = state.getInt("rows") to state.getInt("columns")
            pane.takeIf { it == core && it == ptySize() && it == paneGrid() && !softKeyboardShown() }
        }
    }

    @Test fun theNativeEngineWorksAsADailyUserUsesIt() {
        val runId = InstrumentationRegistryArguments.get("lazyshRunId") ?: "standalone"
        val result = JSONObject().put("runId", runId).put("device", JSONObject().put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT).put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: ""))
        try {
            result.put("probe", runCatching { JSONObject(PageDriver.invoke("native_terminal_probe")) }.getOrElse { JSONObject().put("error", it.message) })
            val nativeChosen = case("engine-choice-native", "Settings, Terminal engine: Native is offered and chosen", "P0") {
                driver.chooseNative()
                put("chosen", true)
            }
            if (!nativeChosen) {
                val reason = "Native engine could not be selected; see the probe and engine choice case"
                result.put("aborted", reason)
                throw AssertionError(reason)
            }
            case("native-session-connects", "The owned SSH host connects and a native pane replaces the xterm.js one", "P0") {
                driver.connect()
                PageDriver.poll("the native pane", 120) {
                    PageDriver.js("Boolean(document.querySelector(${JSONObject.quote(driver.nativePane)})) && !document.querySelector('.terminal-canvas .xterm-screen')").takeIf { it == "true" }
                }
                id = driver.session()
                put("sessionId", id)
            }
            if (!::id.isInitialized) {
                result.put("aborted", "no native session: the cases that need one did not run")
                throw AssertionError("no native session: the cases that need one did not run")
            }
            case("status-bar-names-native", "The bottom bar names the native engine", "P1") {
                val bar = driver.text(".workspace-footer")
                put("footer", bar.take(200))
                check("the status bar names Native: $bar", bar.contains("Native"))
            }
            case("prompt-drawn", "The shell prompt is drawn on the surface (pixels)", "P0") {
                awaitPrompt()
                val drawn = driver.awaitInk("the prompt") { driver.ink(it, 0 until it.height / 6) > 40 }
                put("inkInTopRows", driver.ink(drawn, 0 until drawn.height / 6)).put("size", "${drawn.width}x${drawn.height}")
                Evidence.recordPicture("acceptance-prompt", drawn)
            }
            case("soft-keyboard-opens-on-tap", "A tap on the terminal opens the soft keyboard", "P0") {
                if (softKeyboardShown()) device.pressBack()
                PageDriver.poll("the soft keyboard to finish hiding", 20) { (!softKeyboardShown()).takeIf { it } }
                surfaceTap(0.5, 0.3)
                PageDriver.poll("the soft keyboard", 20) { softKeyboardShown().takeIf { it } }
                put("keyboardShown", true).put("imePackage", inputMethodPackage())
            }
            case("type-with-the-guest-keyboard", "Typing with the guest's input method reaches the shell and is echoed", "P0") {
                put("keys", JSONArray(keyboardKeys()))
                typeOnKeyboard("echo imetyped")
                awaitRow("the typed command's output") { it == "imetyped" }
            }
            case("enter-backspace-arrows", "Enter, Backspace and the arrow keys edit the command line", "P0") {
                awaitPrompt()
                // Start stdout with a hard break even if the shell's editable line wrapped.
                val command = "printf '\\n%s\\n' abcd"
                driver.typeIntoTheSurfaceWithoutEnter(command)
                awaitRow("the unedited command line") { it.endsWith(command) }
                device.pressKeyCode(KeyEvent.KEYCODE_DEL)
                device.pressKeyCode(KeyEvent.KEYCODE_DPAD_LEFT)
                device.pressKeyCode(KeyEvent.KEYCODE_DPAD_LEFT)
                driver.typeIntoTheSurfaceWithoutEnter("X")
                device.pressEnter()
                val answer = try {
                    awaitRow("the edited line's output") { it == "aXbc" }
                } catch (failure: AssertionError) {
                    put("lastScreenRows", JSONArray(rows().takeLast(5)))
                    throw failure
                }
                put("answer", answer.lines().first { it.trim() == "aXbc" }.trim())
            }
            case("toolbar-keys-cat-v", "Toolbar Esc, Tab, sticky Ctrl and Alt, and Up reach the program", "P0") {
                driver.typeIntoTheSurface("echo acceptance-cat-ready; cat -vT")
                awaitRow("cat to start") { it == "acceptance-cat-ready" }
                try {
                    fingerTap(".terminal-keys button", "esc")
                    fingerTap(".terminal-keys button", "tab")
                    fingerTap(".terminal-keys button", "ctrl")
                    driver.typeIntoTheSurfaceWithoutEnter("x")
                    fingerTap(".terminal-keys button", "Alt")
                    driver.typeIntoTheSurfaceWithoutEnter("x")
                    device.pressKeyCode(KeyEvent.KEYCODE_DPAD_UP)
                    device.pressEnter()
                    val expected = setOf("^[^I^X^[x^[[A", "^[^I^X^[x^[OA")
                    val observed = awaitRow("cat -vT to show the toolbar sequence") { it in expected }
                    put("observed", observed.lines().map(String::trim).first { it in expected })
                } finally {
                    fingerTap(".terminal-keys button", "ctrl")
                    driver.typeIntoTheSurfaceWithoutEnter("c")
                }
                awaitPrompt()
            }
            case("composer-and-page-fields-take-input", "The page's composer and fields still take input while a native session is placed", "P0") {
                val opener = listOf("button[aria-label='Compose text']", "button[aria-label='Compose']", "button[aria-label='Open composer']")
                    .firstOrNull { PageDriver.js("Boolean(window.__lz.find(${JSONObject.quote(it)}))") == "true" }
                put("opener", opener ?: "none found")
                if (opener != null) fingerTap(opener)
                val editor = ".terminal-draft-editor textarea"
                val closer = "button[aria-label='Close composer']"
                try {
                    PageDriver.poll("the composer's editor", 30) { PageDriver.js("Boolean(window.__lz.find(${JSONObject.quote(editor)}))").takeIf { it == "true" } }
                    fingerTap(editor)
                    typeOnKeyboard("composer ok", enter = false, autoCapitalized = true)
                    val value = PageDriver.js("document.querySelector(${JSONObject.quote(editor)}).value")
                    put("composerValue", value)
                    check("the composer holds what was typed: $value", value.equals(JSONObject.quote("composer ok"), ignoreCase = true))
                } finally {
                    if (pageCentre(closer) != null) fingerTap(closer)
                }
            }
            case("scroll-history-by-touch", "A finger scrolls the history back and forward", "P0") {
                run("seq 1 150") { it == "150" }
                awaitPrompt()
                fun viewportTop() = JSONObject(driver.invoke("terminal_core_snapshot", id))
                    .getJSONObject("state").getJSONObject("viewport").getLong("top")
                val before = viewportTop()
                put("bottomRow", before)
                val bounds = surfaceBounds()
                val x = (bounds[0] + bounds[2]) / 2
                val y = bounds[1]
                val height = bounds[3] - y
                device.swipe(x, y + height / 4, x, y + height * 85 / 100, 20)
                val scrolled = PageDriver.poll("the viewport to move back", 15) { viewportTop().takeIf { it < before } }
                put("scrolledRow", scrolled)
                device.swipe(x, y + height * 85 / 100, x, y + height / 7, 20)
                PageDriver.poll("the bottom again", 15) { viewportTop().takeIf { it == before } }
                awaitPrompt()
            }
            case("selection-and-copy", "A long press selects a word, the handles and Copy put it on the clipboard", "P0") {
                clearScreen()
                val word = "sel" + java.util.UUID.randomUUID().toString().take(6)
                run("echo $word") { it == word }
                awaitPrompt()
                val (x, y) = cellCentre(word)
                device.swipe(x, y, x, y, 160)
                PageDriver.poll("the selection tools", 20) { PageDriver.js("Boolean(window.__lz.find('.terminal-selection-tools'))").takeIf { it == "true" } }
                val handles = PageDriver.js("document.querySelectorAll('[data-selection-handle]').length")
                check("both selection handles are present", handles == "2")
                put("handles", handles.toInt())
                val beforeCopy = clipboardText()
                fingerTap(".terminal-selection-tools button", "Copy")
                try {
                    put("clipboard", PageDriver.poll("the clipboard", 20) { clipboardText()?.takeIf { it == word } })
                } finally {
                    put("clipboardChanged", clipboardText() != beforeCopy)
                }
            }
            case("paste-from-toolbar", "Paste puts the clipboard into the command line", "P0") {
                val copied = clipboardText() ?: throw AssertionError("nothing on the clipboard to paste")
                fingerTap(".terminal-keys button", "paste")
                val prompt = driver.fixture.getString("prompt").trim()
                PageDriver.poll("the pasted text on the current command line", 30) {
                    core().substringAfterLast(prompt, "").trim().takeIf { it == copied.trim() }
                }
                fingerTap(".terminal-keys button", "ctrl")
                driver.typeIntoTheSurfaceWithoutEnter("u")
            }
            case("link-tap", "A tap on a printed URL opens the link prompt", "P1") {
                clearScreen()
                run("echo http://127.0.0.1:9/native-link-case") { it == "http://127.0.0.1:9/native-link-case" }
                awaitPrompt()
                val (x, y) = cellCentre("http://127")
                device.click(x, y)
                val prompt = ".terminal-consent"
                PageDriver.poll("the printed URL in the link prompt", 20) {
                    pageCentre("$prompt p", "http://127.0.0.1:9/native-link-case")
                }
                check("the link prompt offers Open in browser", pageCentre("$prompt button", "Open in browser") != null)
                fingerTap("$prompt button", "Dismiss link")
                put("prompt", true)
            }
            case("osc52-clipboard-consent", "A remote clipboard write needs consent", "P0") {
                val copied = "OSC52_" + java.util.UUID.randomUUID().toString().take(8)
                val command = "printf '\\033]52;c;%s\\007' \"\$(printf %s $copied | base64)\""
                run(command)
                val prompt = ".terminal-consent[aria-label='Remote clipboard request']"
                PageDriver.poll("the remote clipboard consent with the payload", 20) { pageCentre("$prompt pre", copied) }
                check("the remote text has not reached the clipboard before consent", clipboardText() != copied)
                fingerTap("$prompt button", "Allow this copy")
                PageDriver.poll("the approved text in the Android clipboard", 20) { clipboardText()?.takeIf { it == copied } }
                put("clipboardMatches", true)
            }
            case("pinch-zoom", "A two-finger pinch changes the font size and the remote program's columns", "P1") {
                val before = ptySize()
                pinch(0.15, expand = terminalFontSize() < 32)
                val after = PageDriver.poll("a new grid after the pinch", 30) { ptySize().takeIf { it != before } }
                put("before", "${before.first}x${before.second}").put("after", "${after.first}x${after.second}")
            }
            case("big-output-without-loss", "A megabyte of output ends on the right row and the retained history is unbroken", "P0") {
                run("seq 1 200000") { it == "200000" }
                val range = driver.invoke("terminal_core_buffer_range", id)
                val text = PageDriver.invoke("terminal_core_selection_text", "{sessionId:${JSONObject.quote(id)},range:$range}")
                val history = JSONTokener(text).nextValue() as String
                val numbers = history.lineSequence().map { it.trim().toIntOrNull() }.takeWhile { it != null }.filterNotNull().toList()
                put("retainedLines", numbers.size).put("first", numbers.firstOrNull() ?: -1).put("last", numbers.lastOrNull() ?: -1)
                check("the history is a run of consecutive numbers ending at 200000", numbers.isNotEmpty() && numbers.last() == 200000 && numbers.zipWithNext().all { (a, b) -> b == a + 1 })
            }
            case("vim-with-mouse-mode", "vim draws its screen and a finger scroll reaches it as wheel reports", "P1") {
                clearScreen()
                run("seq 1 300 > /tmp/lz-vim-case && command -v vim >/dev/null && echo HAVE-VIM || echo NO-VIM") { it == "HAVE-VIM" || it == "NO-VIM" }
                if (rows().contains("NO-VIM")) throw AssertionError("vim is not on the owned shell's path")
                // The file banner can stop Vim at a hit-enter prompt on the narrow guest.
                driver.typeIntoTheSurface("vim -u NONE --cmd 'set shortmess+=F' -c 'set mouse=a' /tmp/lz-vim-case")
                try {
                    awaitRow("vim's first line") { it == "1" }
                    val b = surfaceBounds()
                    val x = (b[0] + b[2]) / 2
                    device.swipe(x, b[1] + (b[3] - b[1]) * 3 / 4, x, b[1] + (b[3] - b[1]) / 6, 20)
                    val moved = PageDriver.poll("vim to scroll", 30) { core().takeIf { text -> text.lines().none { it.trim() == "1" } } }
                    put("firstRowAfterScroll", moved.lines().first().trim())
                } finally {
                    device.pressKeyCode(KeyEvent.KEYCODE_ESCAPE)
                    driver.typeIntoTheSurface(":q!")
                }
            }
            case("stop-and-start", "Stop and start of the window draws the session again from the core's state", "P0") {
                val before = driver.surfacePixels()
                driver.scenario.moveToState(Lifecycle.State.CREATED)
                driver.scenario.moveToState(Lifecycle.State.RESUMED)
                PageDriver.poll("the resumed window", 120) { if (NativeActivityFixture.readiness(driver.scenario).ready && PageDriver.js("Boolean(window.__TAURI_INTERNALS__?.invoke)") == "true") true else null }
                PageDriver.poll("a new generation of the surface", 90) {
                    JSONObject(PageDriver.invoke("native_terminal_surface_state", "{session:${JSONObject.quote(id)}}")).takeIf { it.getBoolean("ready") && it.getInt("generation") >= 2 }
                }
                val after = driver.settled("the session after stop and start") { driver.ink(it) > 0 }
                put("inkBefore", driver.ink(before)).put("inkAfter", driver.ink(after))
            }
            case("rotation-and-resize", "Rotation and a window resize give the remote program a new size", "P0") {
                val before = awaitPtyGrid("before rotation")
                val auto = String(driver.shell("settings get system accelerometer_rotation")).trim().toInt()
                val rotation = String(driver.shell("settings get system user_rotation")).trim().toInt()
                val size = Regex("Override size: (\\d+x\\d+)").find(String(driver.shell("wm size")))?.groupValues?.get(1) ?: "reset"
                val target = if (device.displayRotation == Surface.ROTATION_90) Surface.ROTATION_0 else Surface.ROTATION_90
                try {
                    driver.shell("settings put system accelerometer_rotation 0")
                    driver.shell("settings put system user_rotation $target")
                    PageDriver.poll("the requested display rotation", 30) { true.takeIf { device.displayRotation == target } }
                    val rotated = awaitPtyGrid("after rotation", before)
                    put("portraitOrOriginal", "${before.first}x${before.second}").put("rotated", "${rotated.first}x${rotated.second}")
                    driver.shell("settings put system user_rotation 0")
                    driver.shell("wm size 720x1280")
                    PageDriver.poll("the requested display size", 30) {
                        true.takeIf { device.displayWidth == 720 && device.displayHeight == 1280 }
                    }
                    val resized = awaitPtyGrid("after the window resize", rotated)
                    put("resized", "${resized.first}x${resized.second}")
                } finally {
                    driver.shell("wm size $size")
                    driver.shell("settings put system user_rotation $rotation")
                    driver.shell("settings put system accelerometer_rotation $auto")
                }
            }
            case("tmux-status-line-and-splits", "tmux draws its status line and a border between two panes", "P1") {
                clearScreen()
                driver.hostTmux(id)
                put("statusLine", driver.evidence.getString("tmuxStatusLine"))
                    .put("rows", driver.evidence.getInt("tmuxScreenRows"))
            }
            notTestable("mosh-session-resize", "A Mosh session follows a resize", "The owned SSH fixture is reached over `adb reverse` (TCP on host loopback); Mosh needs a UDP route from the guest to the host, which this lane does not provide. Mosh canonical resize is held by the core's contract tests and the xterm.js `native-android-mosh` job.")
            notTestable("kill-switch-fallback", "A build with the kill switch runs xterm.js and says why", "The kill switch is a build-time switch of the release build (`LAZYSH_NATIVE_TERMINAL=off`); the debug APK under test is built without it. The registry and the notice are covered by Vitest and the `e2e-kill-switch` Playwright project; the runtime fallback after a failed open is `NativeTerminalFailureTest` territory.")
            notTestable("vendor-keyboards", "Other input methods", "This run exercises ${inputMethodPackage()}; it does not cover other input methods.")
            notTestable("battery-and-thermal", "Battery energy and thermal behaviour", "Accepted risk, not measured: Waydroid has no phone battery and a workstation does not throttle like a phone.")
            notTestable("real-gpu-and-arm64", "A phone GPU driver and the arm64 build", "Accepted risk, not measured: the guest is x86_64 on the host GPU.")
        } catch (cancelled: InterruptedException) {
            result.put("aborted", "Android interrupted the acceptance run")
            throw cancelled
        } finally {
            result.put("cases", cases)
            Evidence.record("native-acceptance", result)
        }
        val failed = (0 until cases.length()).map { cases.getJSONObject(it) }.filter { it.getString("status") == "fail" }
        assertTrue("acceptance cases failed: ${failed.joinToString { it.getString("id") }}", failed.isEmpty())
    }

    private fun clipboardText(): String? = driver.ui { activity ->
        (activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString()
    }

    /** Two fingers on the pane change their separation: injected as one gesture of two pointers. */
    private fun pinch(spread: Double, expand: Boolean) {
        val b = surfaceBounds()
        val cx = (b[0] + b[2]) / 2f
        val cy = (b[1] + b[3]) / 2f
        val reach = ((b[3] - b[1]) * spread).toFloat()
        val from = if (expand) 40f else 40f + reach
        val to = if (expand) 40f + reach else 40f
        val automation = instrumentation.uiAutomation
        val start = SystemClock.uptimeMillis()
        fun event(action: Int, offset: Float, time: Long, count: Int): MotionEvent {
            val properties = Array(count) { MotionEvent.PointerProperties().also { p -> p.id = it; p.toolType = MotionEvent.TOOL_TYPE_FINGER } }
            val coordinates = Array(count) { index -> MotionEvent.PointerCoords().also { c -> c.x = cx; c.y = if (index == 0) cy - offset else cy + offset; c.pressure = 1f; c.size = 1f } }
            return MotionEvent.obtain(start, time, action, count, properties, coordinates, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
        }
        val inject = { e: MotionEvent -> automation.injectInputEvent(e, true); e.recycle() }
        inject(event(MotionEvent.ACTION_DOWN, from, start, 1))
        inject(event(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), from, start + 20, 2))
        for (step in 1..12) inject(event(MotionEvent.ACTION_MOVE, from + (to - from) * step / 12, start + 20 + step * 25L, 2))
        inject(event(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), to, start + 400, 2))
        inject(event(MotionEvent.ACTION_UP, to, start + 420, 1))
    }
}

/** The instrumentation arguments the lane passes (`-e name value`). */
private object InstrumentationRegistryArguments {
    fun get(name: String): String? = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString(name)
}
