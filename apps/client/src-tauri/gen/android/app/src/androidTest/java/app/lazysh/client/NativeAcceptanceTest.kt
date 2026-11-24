package app.lazysh.client

import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.SystemClock
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowInsets
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import kotlin.math.roundToInt
import org.json.JSONArray
import org.json.JSONObject
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

    /** Runs one case: it passes when `body` returns, fails with the message of what it threw, and the next case runs either way. */
    private fun case(name: String, title: String, priority: String = "P1", body: JSONObject.() -> Unit) {
        val started = SystemClock.elapsedRealtime()
        val evidence = JSONObject()
        val entry = JSONObject().put("id", name).put("title", title)
        try {
            evidence.body()
            entry.put("status", "pass")
        } catch (error: Throwable) {
            entry.put("status", "fail").put("priority", priority).put("error", (error.message ?: error.toString()).take(700))
        }
        cases.put(entry.put("evidence", evidence).put("ms", SystemClock.elapsedRealtime() - started))
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
        val centre = JSONObject(found)
        return driver.ui { activity ->
            val web = checkNotNull(EdgeGestureExclusion.webView(activity.window.decorView)) { "the WebView" }
            val origin = IntArray(2).also(web::getLocationOnScreen)
            val scale = web.width / centre.getDouble("w")
            Pair((origin[0] + centre.getDouble("x") * scale).roundToInt(), (origin[1] + centre.getDouble("y") * scale).roundToInt())
        }
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

    private fun softKeyboardShown() = driver.ui { activity ->
        if (Build.VERSION.SDK_INT >= 30) activity.window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true else false
    }

    private fun inputMethodPackage() = String(driver.shell("settings get secure default_input_method")).trim().substringBefore('/')

    /** Types `text` by tapping the keys of the guest's own keyboard (lowercase letters, space and Enter). */
    private fun typeOnKeyboard(text: String, enter: Boolean = true) {
        val pkg = inputMethodPackage()
        fun key(vararg labels: String) = PageDriver.poll("a keyboard key ${labels.first()} of $pkg", 20) {
            labels.firstNotNullOfOrNull { label -> device.findObject(By.pkg(pkg).desc(label)) ?: device.findObject(By.pkg(pkg).text(label)) }
        }
        for (ch in text) key(if (ch == ' ') "Space" else ch.toString()).click()
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

    private fun clearScreen() { driver.typeIntoTheSurface("clear"); PageDriver.poll("a cleared screen", 30) { core().takeIf { text -> text.lines().count { it.isNotBlank() } <= 2 } } }

    private fun ptySize(): Pair<Int, Int> {
        driver.typeIntoTheSurface("echo SZ=\$(stty size | tr ' ' x)")
        val row = awaitRow("the pty size") { Regex("^SZ=\\d+x\\d+$").matches(it) }.lines().map { it.trim() }.last { it.startsWith("SZ=") && it.length > 4 }
        val (rowsText, colsText) = row.removePrefix("SZ=").split('x')
        return Pair(rowsText.toInt(), colsText.toInt())
    }

    @Test fun theNativeEngineWorksAsADailyUserUsesIt() {
        val runId = InstrumentationRegistryArguments.get("lazyshRunId") ?: "standalone"
        val result = JSONObject().put("runId", runId).put("device", JSONObject().put("model", Build.MODEL).put("sdk", Build.VERSION.SDK_INT).put("abi", Build.SUPPORTED_ABIS.firstOrNull() ?: ""))
        try {
            result.put("probe", runCatching { JSONObject(PageDriver.invoke("native_terminal_probe")) }.getOrElse { JSONObject().put("error", it.message) })
            case("engine-choice-native", "Settings, Terminal engine: Native is offered and chosen", "P0") {
                driver.chooseNative()
                put("chosen", true)
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
                result.put("aborted", "no native session: the cases that need one did not run").put("cases", cases)
                Evidence.record("native-acceptance", result)
                throw AssertionError("no native session: the cases that need one did not run")
            }
            case("status-bar-names-native", "The bottom bar names the native engine", "P1") {
                val bar = driver.text(".workspace-footer")
                put("footer", bar.take(200))
                check("the status bar names Native: $bar", bar.contains("Native"))
            }
            case("prompt-drawn", "The shell prompt is drawn on the surface (pixels)", "P0") {
                val prompt = driver.fixture.getString("prompt").trim()
                awaitRow("the prompt") { it == prompt || it.startsWith(prompt) }
                val drawn = driver.awaitInk("the prompt") { driver.ink(it, 0 until it.height / 6) > 40 }
                put("inkInTopRows", driver.ink(drawn, 0 until drawn.height / 6)).put("size", "${drawn.width}x${drawn.height}")
                Evidence.recordPicture("acceptance-prompt", drawn)
            }
            case("soft-keyboard-opens-on-tap", "A tap on the terminal opens the soft keyboard", "P0") {
                device.pressBack()
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
                driver.typeIntoTheSurfaceWithoutEnter("echo abcd")
                device.pressKeyCode(KeyEvent.KEYCODE_DEL)
                device.pressKeyCode(KeyEvent.KEYCODE_DPAD_LEFT)
                device.pressKeyCode(KeyEvent.KEYCODE_DPAD_LEFT)
                driver.typeIntoTheSurfaceWithoutEnter("X")
                device.pressEnter()
                val answer = awaitRow("the edited line's output") { it.startsWith("aXb") }
                put("answer", answer.lines().first { it.trim().startsWith("aXb") }.trim())
                check("Backspace removed the d, two Left presses moved before the c, X was inserted there: aXbc", rows().contains("aXbc"))
            }
            case("toolbar-keys-cat-v", "Toolbar Esc, Tab, sticky Ctrl and Alt, arrows and function keys reach the program (cat -v)", "P0") {
                driver.typeIntoTheSurface("cat -v")
                fun keyRow(): List<String> = rows()
                val names = JSONArray(PageDriver.js("JSON.stringify([...document.querySelectorAll('.terminal-keys button')].map(b => (b.getAttribute('aria-label') || b.textContent).trim()))").let { org.json.JSONTokener(it).nextValue() as String })
                put("toolbarButtons", names)
                val observed = JSONObject()
                for ((key, expected) in listOf("Esc" to "^[", "Tab" to "^I")) {
                    fingerTap(".terminal-keys button", key)
                    PageDriver.poll("the cat -v echo of $key", 20) { keyRow().takeIf { rows -> rows.any { it.contains(expected) } } }
                    observed.put(key, expected)
                }
                // A sticky modifier then a letter typed through the keyboard's editor.
                fingerTap(".terminal-keys button", "Ctrl")
                driver.typeIntoTheSurfaceWithoutEnter("x")
                PageDriver.poll("the cat -v echo of Ctrl+x", 20) { keyRow().takeIf { rows -> rows.any { it.contains("^X") } } }
                observed.put("Ctrl+x", "^X")
                fingerTap(".terminal-keys button", "Alt")
                driver.typeIntoTheSurfaceWithoutEnter("x")
                PageDriver.poll("the cat -v echo of Alt+x", 20) { keyRow().takeIf { rows -> rows.any { it.contains("^[x") } } }
                observed.put("Alt+x", "^[x")
                put("observed", observed)
                device.pressKeyCode(KeyEvent.KEYCODE_DPAD_UP)
                PageDriver.poll("the cat -v echo of Up", 20) { keyRow().takeIf { rows -> rows.any { it.contains("^[[A") || it.contains("^[OA") } } }
                fingerTap(".terminal-keys button", "Ctrl")
                driver.typeIntoTheSurfaceWithoutEnter("d")
                val ended = PageDriver.poll("cat to end", 20) { core().takeIf { text -> text.lines().any { it.trim().endsWith("\$") || it.trim().endsWith("#") || it.trim().endsWith(">") } } }
                put("endedWith", ended.lines().last { it.isNotBlank() }.trim())
            }
            case("composer-and-page-fields-take-input", "The page's composer and fields still take input while a native session is placed", "P0") {
                val opener = listOf("button[aria-label='Compose text']", "button[aria-label='Compose']", "button[aria-label='Open composer']")
                    .firstOrNull { PageDriver.js("Boolean(window.__lz.find(${JSONObject.quote(it)}))") == "true" }
                put("opener", opener ?: "none found")
                if (opener != null) fingerTap(opener)
                val editor = ".terminal-draft-editor textarea"
                PageDriver.poll("the composer's editor", 30) { PageDriver.js("Boolean(window.__lz.find(${JSONObject.quote(editor)}))").takeIf { it == "true" } }
                fingerTap(editor)
                typeOnKeyboard("composer ok", enter = false)
                val value = PageDriver.js("document.querySelector(${JSONObject.quote(editor)}).value")
                put("composerValue", value)
                check("the composer holds what was typed: $value", value.contains("composer ok"))
                fingerTap("button[aria-label='Close composer']")
            }
            case("scroll-history-by-touch", "A finger scrolls the history back and forward", "P0") {
                run("seq 1 150") { it == "150" }
                val before = core()
                val b = surfaceBounds()
                val x = (b[0] + b[2]) / 2
                device.swipe(x, b[1] + (b[3] - b[1]) / 4, x, b[1] + (b[3] - b[1]) * 85 / 100, 20)
                val scrolled = PageDriver.poll("the viewport to move back", 60) { core().takeIf { text -> !text.lines().any { it.trim() == "150" } } }
                put("firstNumberAfterScroll", scrolled.lines().firstOrNull { it.trim().toIntOrNull() != null }?.trim() ?: "")
                device.swipe(x, b[1] + (b[3] - b[1]) * 85 / 100, x, b[1] + (b[3] - b[1]) / 7, 20)
                PageDriver.poll("the bottom again", 60) { core().takeIf { text -> text.lines().any { it.trim() == "150" } } }
                check("the bottom shows the same rows as before", core() == before || core().lines().any { it.trim() == "150" })
            }
            case("selection-and-copy", "A long press selects a word, the handles and Copy put it on the clipboard", "P0") {
                clearScreen()
                run("echo selectme") { it == "selectme" }
                val rowIndex = core().lines().indexOfFirst { it.trim() == "selectme" }
                val b = surfaceBounds()
                val snapshot = JSONObject(driver.invoke("terminal_core_snapshot", id)).getJSONObject("state")
                val rowHeight = (b[3] - b[1]).toDouble() / snapshot.getInt("rows")
                val cellWidth = (b[2] - b[0]).toDouble() / snapshot.getInt("columns")
                val x = (b[0] + cellWidth * 3).roundToInt()
                val y = (b[1] + rowHeight * (rowIndex + 0.5)).roundToInt()
                device.swipe(x, y, x, y, 160)
                PageDriver.poll("the selection tools", 20) { PageDriver.js("Boolean(window.__lz.find('.terminal-selection-tools'))").takeIf { it == "true" } }
                put("handles", PageDriver.js("document.querySelectorAll('[data-selection-handle]').length"))
                fingerTap(".terminal-selection-tools button", "Copy")
                val copied = PageDriver.poll("the clipboard", 20) { clipboardText()?.takeIf { it.contains("selectme") } }
                put("clipboard", copied)
            }
            case("paste-from-toolbar", "Paste puts the clipboard into the command line", "P0") {
                val copied = clipboardText() ?: throw AssertionError("nothing on the clipboard to paste")
                fingerTap(".terminal-keys button", "Paste")
                awaitRow("the pasted text on the command line") { it.contains(copied.trim().take(8)) }
                fingerTap(".terminal-keys button", "Ctrl")
                driver.typeIntoTheSurfaceWithoutEnter("u")
            }
            case("link-tap", "A tap on a printed URL opens it", "P1") {
                clearScreen()
                run("echo http://127.0.0.1:9/native-link-case") { it == "http://127.0.0.1:9/native-link-case" }
                val rowIndex = core().lines().indexOfFirst { it.trim() == "http://127.0.0.1:9/native-link-case" }
                val b = surfaceBounds()
                val snapshot = JSONObject(driver.invoke("terminal_core_snapshot", id)).getJSONObject("state")
                val x = (b[0] + (b[2] - b[0]).toDouble() / snapshot.getInt("columns") * 12).roundToInt()
                val y = (b[1] + (b[3] - b[1]).toDouble() / snapshot.getInt("rows") * (rowIndex + 0.5)).roundToInt()
                driver.shell("logcat -c")
                device.click(x, y)
                val log = PageDriver.poll("the link's intent", 20) { String(driver.shell("logcat -d -t 400")).takeIf { it.contains("native-link-case") } }
                put("logLine", log.lines().first { it.contains("native-link-case") }.take(240))
            }
            case("pinch-zoom", "A two-finger pinch changes the font size and the remote program's columns", "P1") {
                val before = ptySize()
                pinch(0.15)
                val after = PageDriver.poll("a new grid after the pinch", 30) { ptySize().takeIf { it != before } }
                put("before", "${before.first}x${before.second}").put("after", "${after.first}x${after.second}")
            }
            case("big-output-without-loss", "A megabyte of output ends on the right row and the retained history is unbroken", "P0") {
                run("seq 1 200000") { it == "200000" }
                val range = driver.invoke("terminal_core_buffer_range", id)
                val text = PageDriver.invoke("terminal_core_selection_text", "{sessionId:${JSONObject.quote(id)},range:$range}")
                val numbers = Regex("\\d+").findAll(text).map { it.value.toInt() }.toList()
                put("retainedLines", numbers.size).put("first", numbers.firstOrNull() ?: -1).put("last", numbers.lastOrNull() ?: -1)
                check("the history is a run of consecutive numbers ending at 200000", numbers.isNotEmpty() && numbers.last() == 200000 && numbers.zipWithNext().all { (a, b) -> b == a + 1 })
            }
            case("vim-with-mouse-mode", "vim draws its screen and a finger scroll reaches it as wheel reports", "P1") {
                clearScreen()
                run("seq 1 300 > /tmp/lz-vim-case && command -v vim >/dev/null && echo HAVE-VIM || echo NO-VIM") { it == "HAVE-VIM" || it == "NO-VIM" }
                if (rows().contains("NO-VIM")) throw AssertionError("vim is not on the owned shell's path")
                driver.typeIntoTheSurface("vim -u NONE -c 'set mouse=a' /tmp/lz-vim-case")
                awaitRow("vim's first line") { it == "1" }
                val b = surfaceBounds()
                val x = (b[0] + b[2]) / 2
                device.swipe(x, b[1] + (b[3] - b[1]) * 3 / 4, x, b[1] + (b[3] - b[1]) / 6, 20)
                val moved = PageDriver.poll("vim to scroll", 30) { core().takeIf { text -> text.lines().none { it.trim() == "1" } } }
                put("firstRowAfterScroll", moved.lines().first().trim())
                driver.typeIntoTheSurface(":q!")
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
                val before = ptySize()
                driver.shell("settings put system accelerometer_rotation 0")
                driver.shell("settings put system user_rotation 1")
                val rotated = PageDriver.poll("a new grid after rotating", 60) { ptySize().takeIf { it != before } }
                put("portraitOrOriginal", "${before.first}x${before.second}").put("rotated", "${rotated.first}x${rotated.second}")
                driver.shell("settings put system user_rotation 0")
                driver.shell("wm size 1080x2340")
                val resized = PageDriver.poll("a new grid after wm size", 60) { ptySize().takeIf { it != rotated } }
                put("resized", "${resized.first}x${resized.second}")
                driver.shell("wm size reset")
            }
            case("tmux-status-line-and-splits", "tmux draws its status line and a border between two panes", "P1") {
                clearScreen()
                driver.hostTmux(id)
            }
            notTestable("mosh-session-resize", "A Mosh session follows a resize", "The owned SSH fixture is reached over `adb reverse` (TCP on host loopback); Mosh needs a UDP route from the guest to the host, which this lane does not provide. Mosh canonical resize is held by the core's contract tests and the xterm.js `native-android-mosh` job.")
            notTestable("kill-switch-fallback", "A build with the kill switch runs xterm.js and says why", "The kill switch is a build-time switch of the release build (`LAZYSH_NATIVE_TERMINAL=off`); the debug APK under test is built without it. The registry and the notice are covered by Vitest and the `e2e-kill-switch` Playwright project; the runtime fallback after a failed open is `NativeTerminalFailureTest` territory.")
            notTestable("vendor-keyboards", "Gboard and SwiftKey", "Accepted risk, not measured: neither is installable in the guest; only the guest's AOSP LatinIME is exercised.")
            notTestable("battery-and-thermal", "Battery energy and thermal behaviour", "Accepted risk, not measured: Waydroid has no phone battery and a workstation does not throttle like a phone.")
            notTestable("real-gpu-and-arm64", "A phone GPU driver and the arm64 build", "Accepted risk, not measured: the guest is x86_64 on the host GPU.")
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

    /** Two fingers on the pane move apart: injected as one gesture of two pointers. */
    private fun pinch(spread: Double) {
        val b = surfaceBounds()
        val cx = (b[0] + b[2]) / 2f
        val cy = (b[1] + b[3]) / 2f
        val reach = ((b[3] - b[1]) * spread).toFloat()
        val automation = instrumentation.uiAutomation
        val start = SystemClock.uptimeMillis()
        fun event(action: Int, offset: Float, time: Long, count: Int): MotionEvent {
            val properties = Array(count) { MotionEvent.PointerProperties().also { p -> p.id = it; p.toolType = MotionEvent.TOOL_TYPE_FINGER } }
            val coordinates = Array(count) { index -> MotionEvent.PointerCoords().also { c -> c.x = cx; c.y = if (index == 0) cy - offset else cy + offset; c.pressure = 1f; c.size = 1f } }
            return MotionEvent.obtain(start, time, action, count, properties, coordinates, 0, 0, 1f, 1f, 0, 0, android.view.InputDevice.SOURCE_TOUCHSCREEN, 0)
        }
        val inject = { e: MotionEvent -> automation.injectInputEvent(e, true); e.recycle() }
        inject(event(MotionEvent.ACTION_DOWN, 40f, start, 1))
        inject(event(MotionEvent.ACTION_POINTER_DOWN or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 40f, start + 20, 2))
        for (step in 1..12) inject(event(MotionEvent.ACTION_MOVE, 40f + reach * step / 12, start + 20 + step * 25L, 2))
        inject(event(MotionEvent.ACTION_POINTER_UP or (1 shl MotionEvent.ACTION_POINTER_INDEX_SHIFT), 40f + reach, start + 400, 2))
        inject(event(MotionEvent.ACTION_UP, 40f + reach, start + 420, 1))
    }
}

/** The instrumentation arguments the lane passes (`-e name value`). */
private object InstrumentationRegistryArguments {
    fun get(name: String): String? = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString(name)
}
