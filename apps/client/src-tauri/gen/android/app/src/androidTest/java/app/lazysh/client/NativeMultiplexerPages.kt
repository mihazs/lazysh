package app.lazysh.client

import android.view.inputmethod.EditorInfo

/**
 * What the multiplexer cases (#2500) do on the page and in a session other than the first: a view chosen in the Workspace tools sheet, text typed
 * into the keyboard editor of one named session, the display a Sessions page attached, and the page's state in a failure message.
 */
internal class NativeMultiplexerPages(private val driver: NativeSessionDriver) {
    private val tools = "[role=dialog][aria-label='Workspace tools']"

    fun page(expression: String) = driver.js(expression) == "true"

    /** What the page shows, for the step that failed: the labels of the buttons on screen, the session tabs and the multiplexer panels' text. */
    private fun seen() = driver.js("""(() => JSON.stringify({buttons: [...document.querySelectorAll('button')].filter(b => window.__lz.visible(b)).map(b => (b.getAttribute('aria-label') || b.textContent).trim()).slice(0, 60),
        tabs: [...document.querySelectorAll('.session-tabs [role=tab]')].map(t => t.textContent.trim()), panels: [...document.querySelectorAll('section.multiplexer-panel')].map(p => p.innerText.slice(0, 500))}))()""")

    fun <T> described(what: String, body: () -> T): T = try { body() } catch (error: Throwable) { throw AssertionError("$what: ${error.message}; the page showed ${seen()}", error) }

    /** One of the views a session has, chosen in the Workspace tools sheet as a finger does on a phone. */
    fun view(name: String) = described("the $name view") {
        PageDriver.poll("the $name view", 60) {
            if (page("window.__lz.click(${driver.quoted("$tools button")}, ${driver.quoted(name)})")) true
            else { if (!page("Boolean(document.querySelector(${driver.quoted(tools)}))")) driver.js("window.__lz.click(\"button[aria-label='Workspace tools']\") || window.__lz.click('button.mobile-tools')"); null }
        }
    }

    /** Text committed through the keyboard editor of that session, as the soft keyboard commits it; a line break is a carriage return. */
    fun type(session: String, text: String) {
        val host = checkNotNull(driver.ui { TerminalSurfaces.host(session) }) { "the placed session $session" }
        driver.ui { host.input.onCreateInputConnection(EditorInfo())?.commitText(text, 1) }
    }

    fun run(session: String, command: String) = type(session, "$command\n")

    /** The placed session, other than `parent`, whose core's screen has a row that `shows` accepts: the display a Sessions page attached. */
    fun placedDisplayShowing(parent: String, shows: (String) -> Boolean): String =
        PageDriver.poll("a placed display whose core shows the multiplexer", 90) {
            driver.ui { TerminalSurfaces.ids() }.firstOrNull { it != parent && driver.coreText(it).lines().any { row -> shows(row.trim()) } }
        }
}
