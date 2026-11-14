# Platform integration

Status: **proposed reference**. The "Verified today" column was read from the repository; "Required before native" lists gates that do not yet exist. Android is the optimization priority; the other four platforms share the same contract and must not regress. Related: [native rendering](native-rendering.md) · [runtime](terminal-runtime.md) · [migration plan](terminal-migration-plan.md).

## Platform matrix

| Platform | Verified today | Native surface strategy (to be proven) | Required before native is offered | Issues |
| --- | --- | --- | --- | --- |
| Android (P0) | `minSdkVersion` 24; `MainActivity : TauriActivity` with Kotlin plugins (clipboard, edge gestures, app icon, session background, vault, display idle); insets applied as content padding; instrumentation tests under `gen/android/app/src/androidTest` incl. an owned IME service; `SessionForegroundService` and `session_background.rs` own background execution; Mosh transport crate targets Android | `SurfaceView` first, `TextureView` if clipping, z-order or transitions demand it | Composition PoC, IME on Gboard and SwiftKey, hardware keyboard, touch and selection handles, TalkBack, lifecycle (pause/resume, recreation), GPU loss, thermal and battery data | [#1310](https://github.com/mihazs/lazysh/issues/1310), [#1327](https://github.com/mihazs/lazysh/issues/1327), [#1328](https://github.com/mihazs/lazysh/issues/1328), [#1329](https://github.com/mihazs/lazysh/issues/1329), [#1340](https://github.com/mihazs/lazysh/issues/1340) |
| iOS (P1) | Minimum 16.0; template `apple/project.yml.hbs`; Swift sources are Live Activity, Watch and test targets only; Mosh transport crate targets iOS; simulator CI job `native-ios-simulator` | Swift Tauri plugin with `MTKView` relative to the WKWebView | Composition PoC, safe areas and Dynamic Island, IME, VoiceOver | [#1311](https://github.com/mihazs/lazysh/issues/1311), [#1330](https://github.com/mihazs/lazysh/issues/1330) |
| Linux (P1) | WebKitGTK via Tauri; GUI test pattern in [native GUI testing](../native-gui-testing.md); local PTY via portable-pty; Mosh | Wayland subsurface and X11 child window (both to evaluate) | PoC on both display servers, IME, Orca | [#1331](https://github.com/mihazs/lazysh/issues/1331) |
| Windows (P1) | WebView2 via Tauri; local PTY via ConPTY (portable-pty); no Mosh transport target | Child HWND with Direct3D 12 | PoC, per-monitor DPI, TSF/IME, device-reset recovery, Narrator/NVDA | [#1332](https://github.com/mihazs/lazysh/issues/1332) |
| macOS (P1) | Minimum 13.0; WKWebView via Tauri; local PTY; Mosh | `CAMetalLayer` view relative to the web view | PoC, Retina scale, IME, VoiceOver | [#1333](https://github.com/mihazs/lazysh/issues/1333) |

Versions in `Cargo.lock`: tauri 2.12.5, wry 0.57.1, tao 0.37.2. Native CI jobs in `checks.yml`: `native-linux`, `native-desktop` (macOS and Windows), `native-android`, `native-android-runtime` (emulator), `native-ios-simulator`.

Transport availability follows the existing cfg gates in `apps/client/src-tauri/Cargo.toml`: the Mosh transport crate is a dependency on Linux, macOS, Android and iOS; the local PTY crate on Linux, macOS and Windows; the ET transport crate is unconditional. Per-platform acceptance of each transport is recorded in the [parity matrix](../reference/parity-matrix.md) and not re-derived here.

## libghostty-vt per platform

From `packages/herdr-upstream/crates/ghostty-vt/build.rs`:

| Platform | Zig target mapped | Built in CI today |
| --- | --- | --- |
| Linux x86_64 and aarch64 (gnu, musl) | yes | x86_64 gnu only (`herdr-native`, ubuntu-22.04) |
| macOS x86_64 and aarch64 | yes | no |
| iOS device and simulator (aarch64) | yes | no |
| Windows x86_64 and aarch64 (MSVC) | yes, optional `--libc` file | no |
| Android | **no; the build script panics for an unmapped target** | no |

Closing these gaps, without relaxing source integrity checks, is [#1312](https://github.com/mihazs/lazysh/issues/1312) (and #384 for acquisition reliability).

## Input, IME and keyboards

- Android soft keyboards: IME composition and commit semantics must not duplicate or corrupt text. Known open problems on the xterm path: #602 (autocomplete duplicates input), #1214 and #1215 (SwiftKey loses or corrupts input), #1245 (keyboard toggle). These stay valid fixes on the fallback and become test cases for the native bridge.
- Hardware keyboards, Shift+Enter (#805), toolbar Enter (#1043), modifier toolbar behaviour (`TerminalPane.tsx` `modifiedTerminalText` path) must be identical on both backends.
- Desktop and iOS parity (keyboard, IME, mouse, touch, selection, clipboard) is [#1334](https://github.com/mihazs/lazysh/issues/1334); desktop IME composition and CJK alignment verification is #982.

### Platform parity checklist ([#1334](https://github.com/mihazs/lazysh/issues/1334))

A platform stays on xterm.js until every row below is verified for it, with evidence in the pull request that ticks it. "Modelled" means the behaviour is checked on one host with the platform's rules emulated, which is not the platform: no native surface exists on any platform yet (#1327, #1330 to #1333), so nothing is verified on a device or a real OS.

| Area | Android | iOS | Linux | Windows | macOS |
| --- | --- | --- | --- | --- | --- |
| Keyboard: typed characters, Alt and Meta chords | not started (#1328) | not started | modelled | modelled | modelled |
| IME composition | not started (#1328) | not started | not started (#982) | not started | not started |
| Mouse reporting and wheel | not started | not started | not started | not started | not started |
| Touch and gestures | not started (#1328) | not started | n/a | n/a | n/a |
| Selection and clipboard | not started | not started | not started | not started | not started |
| Accessibility (#1329, #1335) | mirror built, no screen reader run | not started | not started | not started | not started |

Keyboard, as modelled. The events a platform's keyboard fires are not what the core should be sent. Option on macOS and AltGr on Windows and Linux type a character with Alt (and Ctrl) still set, and the core answers such an event with an Alt chord: measured on the core, AltGr+Q on a German layout (Windows) sends ESC NUL instead of `@`, AltGr+E sends ESC and Ctrl+E instead of the euro sign, and Option+L on macOS sends ESC and `¬` instead of `¬`. xterm.js applies a "third level shift" rule for these and a few more; `terminalPlatformKeys.ts` applies the same rules before an event reaches the core: the character is sent without Alt and Ctrl, Option as Meta sends the plain key under Alt, and Option+Left and Option+Right become ESC b and ESC f on macOS. The cases are in `apps/client/src/xterm/platformKeys.*.test.ts`, which load xterm.js 5.5.0 as each platform and hold it to the bytes recorded in `apps/client/e2e/fixtures/platform-keys/`; `packages/terminal-runtime/tests/platform_keys.rs` holds the core to the same fixtures. Differences kept on purpose, each listed with its reason in the fixtures: xterm.js turns Alt+arrow into Ctrl+arrow (the core sends the standard Alt form), and sends nothing for a Windows Ctrl+Alt chord that types no character (the core sends the chord). Not covered: iOS hardware keyboards (xterm.js treats iOS as neither macOS nor Windows, and its behaviour there has not been recorded), non-US layouts for punctuation under Option as Meta, dead keys, and the keys the app handles itself (copy, paste, search).

## Accessibility

| Platform | Service | Status |
| --- | --- | --- |
| Android | TalkBack | xterm path uses `screenReaderMode`; native path unproven ([#1329](https://github.com/mihazs/lazysh/issues/1329)) |
| iOS, macOS | VoiceOver | unproven ([#1335](https://github.com/mihazs/lazysh/issues/1335)) |
| Windows | Narrator, NVDA | unproven (#1335) |
| Linux | Orca | unproven (#1335) |

Rule: where accessibility is unproven for a platform, capability detection must not select the native backend while a screen reader is active.

## Lifecycle events to validate on devices

Surface destroy and recreate; pause and resume; Activity recreation; keyboard show and hide; display cutouts and insets; orientation and foldables; high-refresh displays; GPU context loss; thermal throttling; battery drain; background and resume of sessions. Existing evidence on the xterm path to preserve: Android Mosh background observation (`MoshBackgroundObservation.kt`), resume cover test, and the session background plugin tests.

## Validation gaps (authoring environment)

The session that wrote these documents had no physical Android device, no Android emulator, no iOS device, no Windows or macOS host, and no Zig toolchain. Therefore: no device claim, no device or native-candidate benchmark (the only measurements are the desktop xterm.js baseline in [benchmarks](terminal-benchmarks.md#measured-baseline)), no build of libghostty-vt on any target and no composition PoC result is asserted anywhere in this directory. Every such item is an open acceptance criterion on its issue.

## Risks

| Risk | Mitigation |
| --- | --- |
| Native surface cannot be composed with the WebView on a platform | Composition gate first; platform keeps xterm.js |
| IME regressions on Android keyboards | Native input never ships without the device matrix; xterm stays available |
| Accessibility regression | Capability refusal plus tested fallback |
| GPU driver variance | Real-hardware probe and self-test; fallback |
| Two VT implementations diverge in behaviour | Shared conformance fixtures with listed divergences |
| Build complexity (Zig, NDK, Xcode) | Pin versions; per-target jobs; keep #384 honest |
| Binary size growth | Record size per target in the build issue |
