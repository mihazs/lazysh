package app.lazysh.client

import android.app.Activity
import android.app.Instrumentation
import android.content.IntentFilter
import android.content.Intent
import android.os.PatternMatcher
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * What xterm.js does with a finger, on a placed native session (#2501): a long press selects the word under it, the handles extend the
 * selection and Copy leaves exactly the selected text on the Android clipboard, a tap on a printed URL offers the link and Open in browser
 * starts the ACTION_VIEW intent, and an OSC 52 write from the shell opens the page's consent sheet whose Allow writes the clipboard. The
 * fingers are real touches in the window ([NativeSessionTouch]), the text is the core's, the clipboard is the system's. One session; each step
 * is recorded in `native-gestures.json` and the case fails at the end if any step did, so a run shows every step's outcome. Not a required
 * check: it runs in `native-android-terminal-session`.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalGesturesTest {
    private val driver = NativeSessionDriver()
    private val steps = JSONObject()
    private val failures = mutableListOf<String>()

    @Before fun theUnlockedPage() {
        // A class that ran before this one leaves the app on the page its own cleanup reached: show the hosts list before the start page is awaited.
        runCatching { PageDriver.js(driver.pageScript); driver.revealHosts() }
        driver.theUnlockedPage()
    }

    @After fun leaveTheAppAsFound() = driver.leaveTheAppAsFound()

    private fun step(name: String, body: () -> Unit) {
        try { body(); steps.put(name, "pass") } catch (error: Throwable) {
            steps.put(name, "fail: ${error.message}")
            failures.add("$name: ${error.message}")
        }
    }

    private fun hasRegion(label: String, text: String) =
        "Array.from(document.querySelectorAll('[role=region]')).some(x => x.getAttribute('aria-label') === ${driver.quoted(label)} && x.textContent.includes(${driver.quoted(text)}))"

    @Test fun aRealFingerSelectsCopiesAndTapsLinksOnTheNativeSurfaceAndAnOsc52WriteAsksConsent() {
        driver.evidence.put("steps", steps)
        try {
            val id = driver.startNativeSession()
            val prompt = driver.fixture.getString("prompt").trim()
            driver.awaitRow(id, "the prompt", { it == prompt || it.startsWith(prompt) })
            val touch = NativeSessionTouch(driver, id)
            val nonce = driver.fixture.getString("nonce").take(8)
            // Measured again before every touch: a tap may open the soft keyboard, which gives the pane another height and moves the rows.
            fun pointOn(row: String, word: String, offset: Int = word.length / 2): NativeSessionTouch.Point {
                val grid = touch.grid()
                val (line, column) = touch.locate(row, word)
                driver.evidence.put("grid", "${grid.columns}x${grid.rows} cells of ${grid.cellWidth}x${grid.cellHeight} px at ${grid.left},${grid.top}")
                return grid.centreOf(column + offset, line)
            }

            // The words are printed from two arguments, so the typed command never holds one as a word.
            val word = "PICK_$nonce"
            val row = "$word one two"
            driver.typeIntoTheSurface("printf '%s%s one two\\n' PICK_ $nonce")
            driver.awaitRow(id, "the printed row", { it == row })
            val toolsOpen = "Boolean(window.__lz.find('.terminal-selection-tools'))"

            step("long-press-selects-the-word-and-copy-writes-exactly-it") {
                assertTrue("a previous clip is not the word", touch.clipboardText() != word)
                touch.longPress(pointOn(row, word))
                PageDriver.poll("the selection actions", 20) { driver.js(toolsOpen).takeIf { it == "true" } }
                driver.evidence.put("handles", driver.js("document.querySelectorAll('[data-selection-handle]').length"))
                assertEquals("a touch selection draws two handles", "2", driver.js("document.querySelectorAll('[data-selection-handle]').length"))
                touch.tapElement(".terminal-selection-tools button", "Copy")
                touch.awaitClipboard(word)
                PageDriver.poll("the selection actions closed after Copy", 20) { driver.js("!($toolsOpen)").takeIf { it == "true" } }
                touch.letTheClipboardPreviewGo()
            }

            step("an-end-handle-dragged-four-cells-extends-the-selection-and-copy-writes-it") {
                touch.longPress(pointOn(row, word))
                PageDriver.poll("the selection actions", 20) { driver.js(toolsOpen).takeIf { it == "true" } }
                val handle = PageDriver.poll("the end handle", 20) { touch.centreOfElement("[data-selection-handle='end']") }
                // " one" is four cells past the word: the selection ends on the e of one.
                touch.drag(handle, NativeSessionTouch.Point((handle.x + 4 * touch.grid().cellWidth).toFloat(), handle.y))
                touch.tapElement(".terminal-selection-tools button", "Copy")
                touch.awaitClipboard("$word one")
                touch.letTheClipboardPreviewGo()
            }

            step("a-tap-on-a-printed-url-offers-the-link-and-open-in-browser-starts-the-intent") {
                val path = "/l/$nonce"
                val url = "https://example.invalid$path"
                driver.typeIntoTheSurface("printf '%s%s\\n' https://example.invalid/l/ $nonce")
                driver.awaitRow(id, "the printed link", { it == url })
                touch.tap(pointOn(url, url))
                PageDriver.poll("the link prompt", 20) { driver.js(hasRegion("Terminal link", url)).takeIf { it == "true" } }
                val view = IntentFilter(Intent.ACTION_VIEW).apply {
                    addDataScheme("https"); addDataAuthority("example.invalid", null); addDataPath(path, PatternMatcher.PATTERN_LITERAL)
                }
                // A blocking monitor stands in for the browser, so the intent is seen without any handler installed.
                val monitor = driver.instrumentation.addMonitor(view, Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null), true)
                try {
                    touch.tapElement("button", "Open in browser")
                    PageDriver.poll("an ACTION_VIEW intent for $url", 20) { Unit.takeIf { monitor.hits >= 1 } }
                    assertEquals("Open in browser starts exactly one intent", 1, monitor.hits)
                } finally { driver.instrumentation.removeMonitor(monitor) }
            }

            step("an-osc-52-write-opens-the-consent-sheet-and-allow-writes-the-clipboard") {
                val copied = "OSC52_$nonce"
                // The typed command holds the text in plain form, the sheet holds it only once the shell has written the sequence.
                driver.typeIntoTheSurface("printf '\\033]52;c;%s\\007' \"\$(printf %s $copied | base64)\"")
                PageDriver.poll("the clipboard request", 20) { driver.js(hasRegion("Remote clipboard request", copied)).takeIf { it == "true" } }
                assertTrue("the write is not made before Allow", touch.clipboardText() != copied)
                touch.tapElement("button", "Allow this copy")
                touch.awaitClipboard(copied)
            }
        } finally {
            Evidence.record("native-gestures", driver.evidence)
        }
        assertTrue("steps failed: $failures", failures.isEmpty())
    }
}
