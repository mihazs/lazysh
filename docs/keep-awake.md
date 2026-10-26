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

The bounded native foundation uses Android Activity and iOS UIApplication display
flags, macOS display-idle assertions, Windows display-only power requests.
Linux reports unavailable until a bounded asynchronous desktop-portal backend
exists. The GTK prototype was removed because its UI-thread synchronous calls
cannot bound cleanup against a nonreplying session manager. Portal `Response`/exact
`Close` lifecycle, prompt pending cancellation and compositor acceptance remain
required under issue #81. Other languages and
feature-panel localization are tracked separately; this control adds no preference
schema, native permission text or credential policy change.

Native policy tests, actual OS API round trips, synthetic browser lifecycle tests
and physical hardware acceptance are separate. No simulator/unit result proves
screen timeout, lock-screen, battery or hardware behavior. Follow the native package
README for fixture commands and inspect PR/issue evidence for which targets ran.

Primary API references: [Android screen-on flag](https://developer.android.com/develop/background-work/background-tasks/awake/screen-on),
[UIApplication idle timer](https://developer.apple.com/documentation/uikit/uiapplication/isidletimerdisabled),
[macOS display-idle assertion](https://developer.apple.com/documentation/iokit/kiopmassertiontypepreventuseridledisplaysleep),
[Windows display power request](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powerclearrequest),
[GTK inhibition](https://docs.gtk.org/gtk3/method.Application.inhibit.html) and
[query limits](https://docs.gtk.org/gtk3/method.Application.is_inhibited.html).
