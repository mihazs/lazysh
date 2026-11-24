package app.lazysh.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Zellij pages of the app on a native session (#2500), as `NativeWorkspaceTest.ownedZellijThroughRealUi` drives them on xterm.js: the
 * Sessions page names the Zellij the host has, lists its sessions and attaches one as a display, and the numbered tab control of that
 * session's controls switches the display's tab. A pane's marker is the witness, read from the core's text of the display (never the DOM of
 * an xterm.js screen): the first tab's marker is on screen and the second's is not, then the other way round. The shell starts the
 * Zellij session itself, with two tabs that each print their marker; the job installs the pinned Zellij 0.45.1 for it.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalZellijPagesTest : NativePagesCase() {
    @Test fun zellijPagesDiscoverAttachAndSwitchTabsOnANativeSession() {
        session("native-zellij-pages") {
            val parent = startedShell()
            val nonce = driver.fixture.getString("nonce").take(8)
            val zellij = "natzel"
            val alpha = "ZA_$nonce"
            val beta = "ZB_$nonce"
            var display = ""
            val pages = NativeMultiplexerPages(driver)

            step("the-owned-shell-starts-a-zellij-session-with-two-tabs") {
                pages.run(parent, "command -v zellij >/dev/null && echo HAVE-ZELLIJ || echo NO-ZELLIJ")
                driver.awaitRow(parent, "the Zellij probe", { it == "HAVE-ZELLIJ" || it == "NO-ZELLIJ" }).also { assertTrue("the job's pinned Zellij is on the shell's path", it.lines().any { row -> row.trim() == "HAVE-ZELLIJ" }) }
                // One command pane per tab, each printing its marker, as the owned fixture's layout does.
                val tab = { name: String, marker: String -> "tab name=\"$name\" { pane command=\"sh\" borderless=true { args \"-c\" \"echo $marker; exec sleep 3600\"; }; }" }
                pages.run(parent, "printf 'layout {\\n%s\\n%s\\n}\\n' '${tab("alpha", alpha)}' '${tab("beta", beta)}' > /tmp/lzz-$nonce.kdl; zellij attach --create-background $zellij options --default-layout /tmp/lzz-$nonce.kdl; echo zel=\$(zellij list-sessions --no-formatting | grep -c $zellij)")
                driver.awaitRow(parent, "Zellij's answer for the session", { it == "zel=1" })
            }

            step("the-sessions-page-names-zellij-lists-its-sessions-and-attaches-one-as-a-native-display") {
                pages.view("Sessions")
                pages.described("Zellij discovery") {
                    PageDriver.poll("Zellij named by the Sessions panel", 60) { driver.js("/Zellij 0\\.45\\.1 \\(Supported\\)/.test(document.querySelector('section.multiplexer-panel p.muted')?.textContent ?? '')").takeIf { it == "true" } }
                    driver.click("section.multiplexer-panel button", "List zellij sessions")
                    PageDriver.poll("the session listed", 60) { driver.js("Array.from(document.querySelectorAll('section.multiplexer-panel .mux-row strong')).some(x => x.textContent.trim() === 'zellij: $zellij')").takeIf { it == "true" } }
                    driver.click("section.multiplexer-panel button", "Attach zellij $zellij")
                    PageDriver.poll("two session tabs, the second the display", 60) {
                        driver.js("(() => { const tabs = document.querySelectorAll('.session-tabs [role=tab]'); return tabs.length === 2 && tabs[1].textContent.includes('$zellij'); })()").takeIf { it == "true" }
                    }
                }
                display = pages.placedDisplayShowing(parent) { it == alpha }
                assertTrue("the page's panes are the native adapter's", pages.page("!document.querySelector('.terminal-canvas .xterm-screen')"))
                assertTrue("the first tab's marker is on screen and the second's is not", driver.coreText(display).lines().none { it.trim() == beta })
            }

            step("the-numbered-tab-control-switches-the-displays-tab") {
                pages.view("Sessions")
                pages.described("the Zellij controls") {
                    driver.click("section.multiplexer-panel button", "Control Zellij $zellij")
                    val controls = "section[aria-label='Zellij $zellij controls'] button"
                    PageDriver.poll("Tab 2 enabled", 60) { driver.js("Array.from(document.querySelectorAll(${driver.quoted(controls)})).some(x => x.textContent.trim() === 'Tab 2' && !x.disabled)").takeIf { it == "true" } }
                    driver.click(controls, "Tab 2")
                    PageDriver.poll("the action sent", 30) { driver.js("document.querySelector(\"section[aria-label='Zellij $zellij controls'] [role=status]\")?.textContent.trim() === 'Action sent to Zellij.'").takeIf { it == "true" } }
                }
                driver.awaitRow(display, "the second tab's marker", { it == beta })
                PageDriver.poll("the first tab's marker gone from the display", 30) { Unit.takeIf { driver.coreText(display).lines().none { it.trim() == alpha } } }
            }

            runCatching { pages.run(parent, "zellij kill-all-sessions -y; rm -f /tmp/lzz-$nonce.kdl") }
        }
    }
}
