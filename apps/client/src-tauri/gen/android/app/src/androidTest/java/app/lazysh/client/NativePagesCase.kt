package app.lazysh.client

import androidx.lifecycle.Lifecycle
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before

/**
 * The frame of a case that drives the app's own pages on a native session (#2500, #2501): one session of the real UI, its steps recorded one by
 * one in the evidence file the case names, and a failure at the end when any step failed, so one run shows the outcome of every step.
 */
abstract class NativePagesCase {
    internal val driver = NativeSessionDriver()
    private val steps = JSONObject()
    private val failures = mutableListOf<String>()

    @Before fun theUnlockedPage() = driver.theUnlockedPage()

    // The job runs each class in a freshly installed app (tests/support/androidTerminalCore.ts), so what the case chose and saved goes with the install
    // and no cleanup through the page is needed; the window is only given back as it was.
    @After fun leaveTheWindowResumed() { runCatching { driver.scenario.moveToState(Lifecycle.State.RESUMED) } }

    protected fun step(name: String, body: () -> Unit) {
        try { body(); steps.put(name, "pass") } catch (error: Throwable) {
            steps.put(name, "fail: ${error.message}")
            failures.add("$name: ${error.message}")
            screenshot("step-${failures.size}")
        }
    }

    /** What the screen showed when something failed, kept beside the evidence. */
    private fun screenshot(name: String) {
        runCatching { driver.instrumentation.uiAutomation.takeScreenshot()?.let { Evidence.recordPicture("failed-$name", it) } }
    }

    /** Chooses Native, connects to the owned shell and returns the session's id once the core holds the shell's prompt. */
    protected fun startedShell(): String {
        val id = driver.startNativeSession()
        val prompt = driver.fixture.getString("prompt").trim()
        driver.awaitRow(id, "the prompt", { it == prompt || it.startsWith(prompt) })
        return id
    }

    /** Runs `body` (which starts the session and runs the steps), records the evidence under `evidence` and fails if a step did. */
    protected fun session(evidence: String, body: () -> Unit) {
        driver.evidence.put("steps", steps)
        try { body() } catch (error: Throwable) { screenshot("session"); throw error } finally { Evidence.record(evidence, driver.evidence) }
        assertTrue("steps failed: $failures", failures.isEmpty())
    }
}
