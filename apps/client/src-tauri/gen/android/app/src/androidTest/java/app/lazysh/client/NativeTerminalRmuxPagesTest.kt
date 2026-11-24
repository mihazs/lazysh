package app.lazysh.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The rmux pages of the app on a native session (#2500, #1862): the Sessions page names the rmux the host has (version 0.10.0, supported),
 * browses its sessions, attaches one as a display, and the numbered window control switches that display's window. The witness of the switch
 * is the host's own tree, which the Sessions page reads back and marks `active` on a window; the display itself is checked to be a native
 * pane that has drawn something. The shell starts the rmux server itself; the job installs the pinned rmux 0.10.0 for it.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalRmuxPagesTest : NativePagesCase() {
    @Test fun rmuxPagesBrowseAttachAndSwitchWindowsOnANativeSession() {
        session("native-rmux-pages") {
            val parent = startedShell()
            val rmux = "natrmux"
            val pages = NativeMultiplexerPages(driver)
            fun windowActive(label: String) = pages.described("the window $label active") {
                pages.view("Sessions")
                PageDriver.poll("$label marked active in the host's tree", 60) {
                    driver.js("Array.from(document.querySelectorAll('section.multiplexer-panel summary')).some(x => x.textContent.trim().startsWith(${driver.quoted(label)}) && x.textContent.includes('active'))").takeIf { it == "true" }
                }
            }

            step("the-owned-shell-starts-an-rmux-server-with-two-windows") {
                pages.run(parent, "command -v rmux >/dev/null && rmux new-session -d -s $rmux -n alpha && rmux new-window -d -t $rmux -n beta && echo rwins=\$(rmux list-windows -t $rmux | wc -l)")
                driver.awaitRow(parent, "rmux's answer for two windows", { it == "rwins=2" })
            }

            var display = ""
            step("the-sessions-page-browses-rmux-and-attaches-a-session-as-a-native-display") {
                pages.view("Sessions")
                pages.described("rmux discovery") {
                    PageDriver.poll("rmux named as supported", 60) { driver.js("/rmux 0\\.10\\.0 \\(/.test(document.querySelector('section.multiplexer-panel p.muted')?.textContent ?? '') || /rmux \\S+ \\(Supported\\)/.test(document.querySelector('section.multiplexer-panel p.muted')?.textContent ?? '')").takeIf { it == "true" } }
                    driver.click("section.multiplexer-panel button", "Browse rmux sessions")
                    PageDriver.poll("the rmux session listed", 60) { driver.js("Array.from(document.querySelectorAll('section.multiplexer-panel summary')).some(x => x.textContent.trim().startsWith('rmux: $rmux · 2 windows'))").takeIf { it == "true" } }
                    driver.click("section.multiplexer-panel button", "Attach $rmux")
                    PageDriver.poll("two session tabs, the second the display", 60) {
                        driver.js("(() => { const tabs = document.querySelectorAll('.session-tabs [role=tab]'); return tabs.length === 2 && tabs[1].textContent.includes('$rmux'); })()").takeIf { it == "true" }
                    }
                }
                // rmux draws its own status line; what the case needs is a placed native pane of a new session that holds text.
                display = pages.placedDisplayShowing(parent) { it.isNotBlank() }
                assertTrue("the page's panes are the native adapter's", pages.page("!document.querySelector('.terminal-canvas .xterm-screen')"))
            }

            step("the-numbered-window-control-switches-the-displays-window") {
                pages.view("Sessions")
                val region = "section[aria-label='rmux prefix shortcuts'] button"
                pages.described("the Window 1 shortcut") {
                    PageDriver.poll("Window 1 enabled", 60) { driver.js("Array.from(document.querySelectorAll(${driver.quoted(region)})).some(x => x.textContent.trim() === 'Window 1' && !x.disabled)").takeIf { it == "true" } }
                    driver.click(region, "Window 1")
                }
                windowActive("1: beta")
            }

            runCatching { pages.run(parent, "rmux kill-server") }
        }
    }
}
