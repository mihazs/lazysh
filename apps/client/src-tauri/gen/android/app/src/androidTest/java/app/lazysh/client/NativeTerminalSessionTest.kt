package app.lazysh.client

import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject

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
    private val driver = NativeSessionDriver()

    @Before fun theUnlockedPage() = driver.theUnlockedPage()

    @After fun leaveTheAppAsFound() = driver.leaveTheAppAsFound()

    @Test fun aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart() { with(driver) {
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

            // A multiplexer in the same session, drawn by the core on the surface that has just been given back.
            hostTmux(id)
        } finally {
            Evidence.record("native-session", evidence)
        }
    } }
}
