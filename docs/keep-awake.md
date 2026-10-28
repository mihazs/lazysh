# Agent board display keep-awake

The agent activity panel has a **Keep display awake while this board is open**
control. It defaults off and stores only an exact boolean preference on this
device (`lazysh.agent-board.keep-awake.v1`); it is not part of synced preferences.
Choosing it never connects an agent, extends a remote process, changes a terminal
session or creates a background execution task.

The board must remain mounted, visible, foreground and unlocked. Disabling the
control, leaving/switching the board, losing window/document focus, backgrounding,
locking/revoking access and replacing/destroying the view release native ownership.
A later visible board obtains a fresh native ticket; old completions do not renew
access or reacquire an expired owner. Status text reports native confirmation and
errors rather than assuming a request succeeded. Unavailable platforms remain
explicit. Keeping the display on consumes battery. User sleep, lid-close and OS
power policies can still override these requests.

The native adapters use Android Activity and iOS UIApplication display flags,
macOS display-idle assertions and Windows display-only power requests. Linux uses
the XDG desktop portal's Idle request over a private Gio D-Bus connection. It waits
for the matching method reply and `Response(0)`, never just a returned handle.
Native acknowledgement means this board owns an acknowledged request; it does not
prove that the compositor or physical display timer honors it. The portal API
cannot universally report silent policy changes in a compositor/backend.

Linux acquisition has a five-second deadline, including connection setup and
previous cleanup. Exact cancellation runs before waiting for the admission mutex;
pending requests cannot block leaving the board. Cleanup sends bounded `Close`
calls and closes only the request's private connection, with explicit errors if
closure is not confirmed. Portal owner/connection loss or an explicit negative
response clears the matching visible ownership state, without polling or automatic
retry, including on subsequent focus changes. Turn the control off and on to
request ownership again after a loss or an issued acquisition fails. Read-only
metadata refreshes and normal acknowledged background/foreground resumption remain
unchanged. Events retain the original document/epoch/ticket; late success and old loss
events cannot restore or remove another owner. Missing session bus/portal, denied
requests and unsupported implementations remain explicit failures.

The removed GTK prototype used synchronous UI-thread calls and is not a fallback.
Compositor and physical-device acceptance remain under issue #81. Other languages and
feature-panel localization are tracked separately; this control adds no preference
schema, native permission text or credential policy change.

Native policy tests, actual OS API round trips, synthetic browser lifecycle tests
and physical hardware acceptance are separate. No simulator/unit result proves
screen timeout, lock-screen, battery or hardware behavior. Follow the native package
README for fixture commands and inspect PR/issue evidence for which targets ran.
The Linux native fixtures include the installed real portal frontend on an owned
private bus, with an explicitly controlled implementation backend and private XDG
storage. They distinguish frontend acknowledgement/Request cleanup from a real
compositor honoring the request; no user desktop service is contacted.

Primary API references: [Android screen-on flag](https://developer.android.com/develop/background-work/background-tasks/awake/screen-on),
[UIApplication idle timer](https://developer.apple.com/documentation/uikit/uiapplication/isidletimerdisabled),
[macOS display-idle assertion](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridledisplaysleep),
[Windows display power request](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powerclearrequest),
[XDG portal Inhibit](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Inhibit.html),
[portal Request lifecycle](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html),
and the removed [GTK inhibition](https://docs.gtk.org/gtk3/method.Application.inhibit.html)/
[query limits](https://docs.gtk.org/gtk3/method.Application.is_inhibited.html) approach.

The board observes the existing native main-window focus event in addition to DOM focus and visibility. If an earlier resume observation found native readiness unavailable, a later native focus event can refresh metadata under the original mounted access lease. This does not poll or retry an issued acquisition failure; hidden, unmounted or revoked views cannot acquire. Controlled frontend fixtures exercise this event ordering. The recurring Android #321 failure remains unproven as to cause: its late missing-board sample follows a 120-second foreground wait, exceeding the fixture's 90-second shell lifetime, and cannot establish the original foreground state.
