package app.lazysh.client

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

    @Before fun theUnlockedPage() {
        // A class that ran before this one leaves the app on the page its own cleanup reached: show the hosts list before the start page is awaited.
        runCatching { PageDriver.js(driver.pageScript); driver.revealHosts() }
        driver.theUnlockedPage()
    }

    @After fun leaveTheAppAsFound() = driver.leaveTheAppAsFound()

    protected fun step(name: String, body: () -> Unit) {
        try { body(); steps.put(name, "pass") } catch (error: Throwable) {
            steps.put(name, "fail: ${error.message}")
            failures.add("$name: ${error.message}")
        }
    }

    /** Runs `body` (which starts the session and runs the steps), records the evidence under `evidence` and fails if a step did. */
    protected fun session(evidence: String, body: () -> Unit) {
        driver.evidence.put("steps", steps)
        try { body() } finally { Evidence.record(evidence, driver.evidence) }
        assertTrue("steps failed: $failures", failures.isEmpty())
    }
}
