# Native display-idle ownership

Private Tauri adapters for issue #81. JavaScript has no plugin commands; the app
exposes only protected status/acquire and exact-owner cleanup. This changes display
idle behavior, not SSH, agent processes, network keepalives or background tasks.

`status` issues a native ticket without acquiring OS resources. `acquire` consumes
one `{epoch,ticket}`; `release` fences that exact ticket even if acquisition has not
arrived. Native background/focus/view lifecycle events rotate the epoch. Tickets
come from native state, so a renderer reload cannot reset their counter. A Rust
document generation rotates synchronously on page-load/revocation; a serialized
native cleanup barrier precedes later status calls. Old status snapshots and queued
acquisitions cannot cross that boundary. All setters execute on the native UI
thread and check actual foreground ownership independently of renderer state.

Platform APIs:

- Android: Activity `FLAG_KEEP_SCREEN_ON`, cleared on pause/stop/destruction,
  window focus loss, view detach/hide and rebind. No wake-lock permission.
- iOS: `UIApplication.isIdleTimerDisabled`, cleared on resign-active/background,
  window/scene deactivation, view detach/hide and document loading.
- macOS: an owned IOPM `PreventUserIdleDisplaySleep` assertion.
- Windows: an owned `PowerRequestDisplayRequired` handle, without system/away-mode
  requests. Native close follows successful decrement; failures remain explicit.
- Linux: asynchronous Gio XDG `Inhibit(flags=8)`, with a private bus connection,
  pinned unique portal owner and matching method handle plus `Response(0)`.
  The existing locked Gio/GLib crates are direct Linux dependencies; no new crate
  versions or portal plugin are introduced. A missing bus/service, denial, invalid
  response or acquisition deadline reports an error. No GTK inhibition fallback.

This foundation does not establish desktop-wide compositor or physical-device
parity. Native flags/handles and synthetic browser fixtures are different evidence
from physical display timeout, user sleep overrides, battery use and hardware.

Linux retains serialized admission ordering, but exact pending cancellation and
document invalidation run through short native ticket-policy locks BEFORE waiting
for that serialization mutex. Async work runs on the existing GLib main context;
UI closures never wait for remote replies. Original authority is checked again
after async discovery immediately before `Inhibit`, and the existing atomic
original-lease admission callback runs after acknowledgement. Acquisition expires
after five seconds (the caller has a one-second delivery fallback); individual
method calls use one-second timeouts. `Close` has a half-second call timeout and a
one-second forced connection-close timer. Cleanup waits at most two seconds and
retains unconfirmed resource metadata instead of claiming release. State permits
one current operation and one retiring connection; failed retirement prevents
further connections from accumulating.

Owner/connection loss and observable negative responses produce a bounded event
for the ORIGINAL document/epoch/ticket, never the document current at callback
time. The UI subscribes before acquisition, fences loss-before-reply and does not
replay requests after loss. The standard Request API has no universal Closed or
permission-revoked signal; silent backend/compositor policy changes are not
observable. `Response(0)` means portal acknowledgement, not physical timer proof.
Setup and cleanup use detached `MainContext::spawn` tasks, which remain queued
even while the context has no owner; `invoke` is not used for these operations.
An observed loss or fresh issued acquisition failure requires explicit off/on
before another acquisition; focus changes do not replay it. Metadata-only failures
do not latch this gate, and normal acknowledged foreground resumption is preserved.
Remaining #81 acceptance includes actual desktop/compositor and hardware tests.

Protocol evidence: [Inhibit](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Inhibit.html),
[Request](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Request.html),
and [pinned portal implementation](https://github.com/flatpak/xdg-desktop-portal/blob/49075617ff70ba2dc793dddb796a0a515fbebd7a/desktop-portal/inhibit.c).
The implementation emits success after the backend method completes; a policy
that filters all requested flags can produce no response, requiring the deadline.
The portal's own tests also distinguish backend method completion from effective
compositor policy. No physical-effect inference is made from this acknowledgement.

## Native checks

Use existing Cargo/Gradle/XCTest tasks:

- `cargo test -p tauri-plugin-lazysh-display-idle --lib` — policy plus, on Linux,
  actual Gio calls against an owned `dbus-daemon`/native fake portal. It does not use
  or mutate the user's session bus. Fixtures cover early/late signals, denial,
  missing replies, original guards, malformed handles, owner/connection loss,
  cancellation, forced private-connection cleanup and repeated peer retirement.
  The same Cargo task also launches the installed **real portal frontend** and
  permission store with a controlled `org.freedesktop.impl.portal.Inhibit` backend.
  Those two interoperability fixtures check acknowledged acquisition/exact backend
  Close and cancellation during a held backend reply. The backend is controlled;
  this is not compositor, physical timeout or complete board/WebView acceptance.
  Each fixture owns a private bus with no installed/user activation directories, private XDG
  configuration/data/runtime directories and explicitly reaped child processes.
  Its sole private activation entry for the already-running frontend executes
  `/usr/bin/false` if absent, so discovery cannot launch a desktop service.
  The fixture asserts the activatable-name allowlist. System GSettings schemas
  are read with the memory backend, without user settings.
  Child-only environment settings include both bus addresses; the user's session
  and system buses, desktop backends and configuration are never used.
  Native Linux CI installs `dbus-daemon` and `xdg-desktop-portal` (including
  `xdg-permission-store`) and runs the uncached package task through the client
  dependency graph. Local Linux runs require those binaries under `/usr/libexec`
  or `/usr/lib`; missing dependencies fail explicitly rather than silently skip.
  To run only the real frontend fixtures:
  `cargo test --locked -p tauri-plugin-lazysh-display-idle --lib portal::tests::real_frontend`.
- Development GTK prototype evidence is superseded, not current API acceptance:
  the actual positive probe failed; a later actual portal-only rejection probe
  passed. Both logs were retained under `/tmp/lazysh-awake-gtk-{actual,negative}.log`
  and the finding recorded on issue #81. Neither establishes bounded calls or
  positive inhibition. The prototype and its manual GTK fixture were removed
  rather than shipping a potentially UI-blocking implementation. GTK 3.24.52 was
  installed; [upstream source](https://github.com/GNOME/gtk/blob/gtk-3-24/gtk/gtkapplication-dbus.c)
  uses `G_MAXINT` for synchronous Inhibit/IsInhibited calls.
- Android `:tauri-plugin-lazysh-display-idle:testDebugUnitTest` tests policy and
  compiles the adapter/debug-only real-Window fixture. App instrumentation calls
  that fixture on the existing Activity. The separately selected owned-SSH
  `NativeWorkspaceTest.ownedOpenSshConnectsThroughRealUi` also exercises the shipping
  Agents board checkbox against the actual Activity flag, explicit opt-in/off,
  background/foreground and board-unmount/remount lifecycle. It uses the existing
  authenticated SSH fixture, not a fake IPC/native flag setter. Actual packaged
  device/emulator execution is required before claiming this pipeline passed;
  neither fixture asserts physical display timeout or battery behavior.
- iOS policy/real-UIApplication fixtures are in the existing hosted
  `LazyshMoshAppTests` target. SDK execution is required before an iOS runtime claim.
- macOS/Windows Cargo tests perform actual API acquire/release round trips in
  desktop CI; merely cross-compiling is not execution evidence.

Gradle's generated `android/build/**` artifacts and Tauri's generated
`android/.tauri/**` SDK copy have explicit scanner scopes. The SDK comes from
locked Tauri 2.12.5 (`mobile/android`); its `Plugin.kt` matches the installed crate
byte-for-byte (SHA256 `c5dc0d1b59ac2024399afd0893f1182ae583b4d4f2cc88a5ba7864d365f77f7c`).
The generated copy retains upstream MIT/Apache-2.0 notices and is not committed.
All handwritten Rust/Kotlin/Swift source and tests remain included.
