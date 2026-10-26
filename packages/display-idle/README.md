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
- Linux: explicitly unavailable. The shipping adapter makes no GTK/D-Bus idle
  calls. The initial GTK prototype was removed: even a confirmable GNOME/Xfce
  service could block GTK's UI-thread synchronous calls for an effectively
  unbounded timeout. A cookie/query guard cannot make that path cancellable.

This foundation does not establish desktop-wide compositor or physical-device
parity. Native flags/handles and synthetic browser fixtures are different evidence
from physical display timeout, user sleep overrides, battery use and hardware.

Remaining issue #81 acceptance includes a native Gio/D-Bus XDG portal backend that
waits for successful `Response`, closes/cancels exact request handles on every
lifecycle transition, handles late responses, and verifies compositor behavior.
Implement that phase from fresh merged main. The acquire path must not hold the native serialization mutex while awaiting
portal responses: cancellation/Close needs a prompt independent path. Do not treat
an unconfirmed GTK cookie or the retained failed positive prototype probe as
successful display inhibition.

## Native checks

Use existing Cargo/Gradle/XCTest tasks:

- `cargo test -p tauri-plugin-lazysh-display-idle --lib` — bounded ownership policy.
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
  that fixture on the existing Activity; it does not assert physical timeout or
  claim the entire plugin/renderer pipeline was exercised.
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
