package app.lazysh.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The tmux pages of the app on a native session (#2500), as `NativeWorkspaceTest.ownedTmuxThroughRealUi` drives them on xterm.js: the
 * Sessions page discovers a tmux server the owned shell started and attaches it as a display, the numbered window control and Jump To
 * switch its windows, and copy mode ends in the page's consent sheet for the OSC 52 write tmux makes, whose Allow writes the Android
 * clipboard. Every read is the core's text (`terminal_core_text`) of the session, never the DOM of an xterm.js screen, and the case
 * fails when a pane is not the native adapter's. One session; each step is recorded in `native-tmux-pages.json` and the case fails at
 * the end if any step did. Not a required check: it runs in `native-android-terminal-session`.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalTmuxPagesTest : NativePagesCase() {
    private val pages = NativeMultiplexerPages(driver)

    @Test fun tmuxPagesDiscoverAttachSwitchWindowsAndCopyWithConsentOnANativeSession() {
        session("native-tmux-pages") {
            val parent = startedShell()
            val nonce = driver.fixture.getString("nonce").take(8)
            val server = "natpages"
            var display = ""
            fun displayRow(what: String, wanted: (String) -> Boolean) = driver.awaitRow(display, what, wanted)

            step("the-owned-shell-starts-a-tmux-server-with-two-windows") {
                // vi keys and the OSC 52 write are the server's: `-f` is read once, when the server starts.
                pages.run(parent, "printf 'set -g mode-keys vi\\nset -g set-clipboard on\\n' > /tmp/lzp-$nonce.conf; tmux -f /tmp/lzp-$nonce.conf new-session -d -s $server -n alpha && tmux new-window -d -t $server -n beta && echo wins=\$(tmux list-windows -t $server | wc -l)")
                driver.awaitRow(parent, "tmux's answer for two windows", { it == "wins=2" })
            }

            step("the-sessions-page-discovers-the-server-and-attaches-it-as-a-native-display") {
                pages.view("Sessions")
                pages.described("discovery of $server") {
                    PageDriver.poll("the server in the Sessions panel", 60) {
                        driver.js("Array.from(document.querySelectorAll('section.multiplexer-panel summary')).some(x => x.textContent.trim().startsWith(${driver.quoted("$server · 2 windows")}))").takeIf { it == "true" }
                    }
                    driver.click("section.multiplexer-panel button", "Attach $server")
                    PageDriver.poll("two session tabs, the second the display", 60) {
                        driver.js("(() => { const tabs = document.querySelectorAll('.session-tabs [role=tab]'); return tabs.length === 2 && tabs[1].textContent.includes(${driver.quoted(server)}); })()").takeIf { it == "true" }
                    }
                }
                // The display is a native session too: tmux's own status line is on the last row of its core.
                display = pages.placedDisplayShowing(parent) { it.startsWith("[$server]") }
                assertTrue("the page's panes are the native adapter's", pages.page("!document.querySelector('.terminal-canvas .xterm-screen')"))
                val status = displayRow("tmux's status line with both windows") { it.startsWith("[$server]") && it.contains("0:alpha") && it.contains("1:beta") }
                driver.evidence.put("tmuxStatusLine", status.lines().last { it.startsWith("[$server]") }.trim())
            }

            fun windowActive(index: String, name: String) = displayRow("window $index $name current") { it.startsWith("[$server]") && it.contains("$index:$name*") }
            fun shortcut(label: String) = pages.described("the $label shortcut") {
                pages.view("Sessions")
                val region = "section[aria-label='tmux prefix shortcuts'] button"
                PageDriver.poll("the $label shortcut enabled", 60) { driver.js("Array.from(document.querySelectorAll(${driver.quoted(region)})).some(x => x.textContent.trim() === ${driver.quoted(label)} && !x.disabled)").takeIf { it == "true" } }
                driver.click(region, label)
            }

            step("the-numbered-window-control-switches-the-displays-window") {
                shortcut("Window 1")
                windowActive("1", "beta")
                shortcut("Window 0")
                windowActive("0", "alpha")
            }

            step("jump-to-switches-the-displays-window") {
                pages.described("Jump To") {
                    pages.view("Workspaces")
                    PageDriver.poll("the tmux Jump To panel", 60) { driver.js("Boolean(window.__lz.find(\"section[aria-label='tmux Jump To'] button\", '1: beta'))").takeIf { it == "true" } }
                    driver.click("section[aria-label='tmux Jump To'] button", "1: beta")
                }
                windowActive("1", "beta")
            }

            step("copy-mode-ends-in-the-consent-sheet-and-allow-writes-the-clipboard") {
                val touch = NativeSessionTouch(driver, display)
                val marker = "CPY_$nonce"
                // The pane of the display, printed from two arguments so the typed command never holds the marker as one word.
                pages.view("Terminal")
                pages.run(display, "printf '%s%s\\n' CPY_ $nonce")
                displayRow("the marker in the display's pane") { it == marker }
                shortcut("Copy mode")
                displayRow("tmux's copy mode position indicator") { it.contains("[0/") }
                pages.view("Terminal")
                // One key at a time with a pause, as a finger types: tmux 3.4 did not copy when the keys arrived in one write. The cursor starts below the marker.
                for (key in listOf("k", "V", "\n")) { pages.type(display, key); Thread.sleep(250) }
                displayRow("tmux left copy mode") { !it.contains("[0/") && it.startsWith("[$server]") }
                pages.described("the consent sheet") {
                    PageDriver.poll("the clipboard request", 30) { driver.js("Array.from(document.querySelectorAll('[role=region]')).some(x => x.getAttribute('aria-label') === 'Remote clipboard request' && x.textContent.includes(${driver.quoted(marker)}))").takeIf { it == "true" } }
                }
                assertTrue("the copied line is not on the clipboard before Allow", touch.clipboardText()?.startsWith(marker) != true)
                touch.tapElement("button", "Allow this copy")
                PageDriver.poll("the clipboard to hold the copied line", 20) { touch.clipboardText()?.takeIf { it.trim() == marker } }
                assertEquals("the sheet closed after Allow", true, pages.page("!Array.from(document.querySelectorAll('[role=region]')).some(x => x.getAttribute('aria-label') === 'Remote clipboard request')"))
            }

            // The server goes: the display ends with it, and the case's cleanup disconnects the host.
            runCatching { pages.run(parent, "tmux kill-server; rm -f /tmp/lzp-$nonce.conf") }
        }
    }
}
