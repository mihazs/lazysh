# Native engine regression suite

Owner policy (2026-11-24): every native-engine change (a feature, a fix, a parity gap) ships its regression tests in the same pull request, at the lowest layer that reproduces the behaviour, and a fix's test fails on the parent commit. This page maps each feature or user-reported bug to the test that guards it, the layer and the CI job that runs it. The feature list and the open gaps are in [the parity matrix](terminal-native-parity.md); the bug rows of the project-wide index are in [regression-tests.md](../regression-tests.md).

Layers and where they run:

| Layer | Runs in CI job | Notes |
| --- | --- | --- |
| Vitest over the stand-in core (`createHeadlessCore`) | `client` (`client:test`) | The first choice: the real adapter and pane, no device. |
| Vitest over the real core (`nativeTerminalAdapter.realCore.test.ts`) | `herdr-native` | The runtime crate's stdio harness. |
| Playwright (`e2e/terminal-native-*.spec.ts`, `terminal-engine-*.spec.ts`) | `client` (`client:test-e2e`) | The browser registry spec exercises output, IME, clipboard consent and touch selection with a stand-in core. Herdr tap and selection tests use both backends. Clipboard and link tests use the real Rust core in `herdr-native`. The App Mosh fixture exercises early output and remote resize on both backends. The IME spec runs repeated CJK and emoji, hardware input and focus-boundary cases on native. The xterm-specific observer cases and Android SwiftKey traces stay in that backend’s browser arm ([#2123](https://github.com/mihazs/lazysh/issues/2123)). |
| Rust renderer and surface host tests | `native-terminal-bridge` | A software GPU; not a required check. |
| Instrumentation, a placed native session | `native-android-terminal-session` | Dedicated job, new Android UI cases go here. |
| Instrumentation, the core in the app | `native-android-terminal-core` | `NativeTerminalCoreTest`. |
| Instrumentation, other classes (`NativeTerminalInputTest`, `NativeScreenReaderTest`, surface host) | `native-android-runtime` | Required but wedge-prone ([#2313](https://github.com/mihazs/lazysh/issues/2313)): no new case goes here. |

## User-reported bugs

| Report | Status | Test (path and title) | Layer | CI job |
| --- | --- | --- | --- | --- |
| [#2457](https://github.com/mihazs/lazysh/issues/2457) the native engine displays nothing on a real device | Open: owner retest pending | `NativeTerminalSessionTest.aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart` (prompt ink on the placed surface and on the screenshot through the page, #2449) | Instrumentation | `native-android-terminal-session` |
| [#2489](https://github.com/mihazs/lazysh/issues/2489) the soft keyboard does not open, SwiftKey not fluid | In review: [#2495](https://github.com/mihazs/lazysh/pull/2495) | `nativeSurfaceInput.test.ts` (keyboard editor gives way to a page field and returns); `TerminalImeEditorTest.aRecordedSwiftKeySequenceSendsExactlyTheBytesTheRemoteLineNeeds`; `InputRelayTest` paste cases; `NativeTerminalSessionTest` step `keyboardOwnership` (keys land in the terminal, then in a page field, then in the terminal) | Vitest; JVM; instrumentation | `client`; `native-android`; `native-android-terminal-session` |
| [#2490](https://github.com/mihazs/lazysh/issues/2490) the composer and page fields do not take input | In review: [#2495](https://github.com/mihazs/lazysh/pull/2495) | `nativeSurfaceInput.test.ts` 'lets go of the keyboard editor, keeping the keyboard open, when a field of the page takes focus...'; `NativeTerminalSessionTest` step `keyboardOwnership` with a probe input (not the real agent composer). The composer's Send and Insert are guarded below ([#2496](https://github.com/mihazs/lazysh/issues/2496)) | Vitest; instrumentation | `client`; `native-android-terminal-session` |
| [#2491](https://github.com/mihazs/lazysh/issues/2491) the status bar does not name the engine | Fixed ([#2494](https://github.com/mihazs/lazysh/pull/2494)) | `App.nativeSession.test.tsx`: 'names the engine of the session in the status bar next to the terminal type, and follows the session when it moves to xterm.js' and 'names xterm.js in the status bar when the native engine could not be opened' | Vitest | `client` |
| [#2493](https://github.com/mihazs/lazysh/issues/2493) the toolbar keys do not work | In review: [#2495](https://github.com/mihazs/lazysh/pull/2495) | `TerminalPane.test.tsx` 'toolbar keys on a native session (#2493)': 'writes the same bytes for every toolbar key alone and under Ctrl, Alt and Shift as the xterm.js pane does', 'applies a sticky Ctrl to the next character the soft keyboard types, once'; `nativeTerminalAdapter.test.ts` (`ime` claimed, the contract's two ime cases); `NativeTerminalSessionTest` step `toolbarKeys` (`cat -v` reads `^[^I^[[H^[[F^[[Z^A`) | Vitest; instrumentation | `client`; `native-android-terminal-session` |
| [#2496](https://github.com/mihazs/lazysh/issues/2496) the composer's Send did not submit on native | Fixed ([#2497](https://github.com/mihazs/lazysh/pull/2497)) | `TerminalPane.test.tsx`: 'the composer on a native session' (Send pastes, then Enter, and clears; Insert pastes and clears), fails on the parent | Vitest | `client` |
| SwiftKey fluency on a device | Open | Physical device acceptance, [#1793](https://github.com/mihazs/lazysh/issues/1793); no automated case reproduces vendor keyboards | Device | none |

## Features

| Feature | Test (path and title) | Layer | CI job |
| --- | --- | --- | --- |
| Adapter contract: bytes in order, modes, scroll, selection, search, OSC 7 and OSC 52 events, active switching, disposal | `terminalAdapter.contract.ts` run by `terminalBackends.contract.test.ts` | Vitest | `client` |
| The same contract over the real core | `nativeTerminalAdapter.realCore.test.ts` | Vitest over the real core | `herdr-native` |
| Adapter semantics: window of rows, paste bracketing, wheel, search, canonical Mosh resize, input order | `nativeTerminalAdapter.test.ts` | Vitest | `client` |
| Renderer look (theme, font, cursor, bold) sent once per change | `nativeTerminalAdapter.look.test.ts`; `panes.rs` host tests | Vitest; Rust | `client`; `native-terminal-bridge` |
| Saved toolbar actions | `TerminalPane.test.tsx` runs a saved chord and a held alternate over a native session. It checks the exact transport bytes, suppresses the duplicate menu and click events, and inserts the edited snippet through the native adapter without submitting it. | Vitest | `client` |
| Native D-pad holds | `TerminalPane.test.tsx` checks shifted repeat bytes across a directional pan, cancellation at release, and an unmodified accessible activation after the hold. | Vitest | `client` |
| Cursor style and blink at native core open, after preference changes, and after DECSCUSR reset | `tauriNativeCoreBridge.test.ts`; `terminal_core.rs`; `terminal-runtime/tests/renderer.rs`; native renderer host pixel test | Vitest; Rust frame and pixel checks | `client`; `herdr-native`; `native-terminal-bridge` |
| CJK, emoji, combining marks and ZWJ sequences drawn in their cells with the device's fonts | `NativeTerminalSessionTest.aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart` (cell-by-cell surface pixels and, when the image supplies Noto Serif CJK, Settings-driven glyph changes and restoration); `packages/terminal-renderer-wgpu/tests/text.rs` `the_fonts_of_an_android_system_directory_are_found_with_the_cjk_font_in_a_collection` (Android's `/system/fonts` layout, the CJK font as a collection) | Instrumentation; Rust renderer host | `native-android-terminal-session`; `native-terminal-bridge` |
| Mosh canonical resize on Android ([#1317](https://github.com/mihazs/lazysh/issues/1317)) | `tests/android-native-session.test.ts` runs the installed app against an owned Mosh server over the emulator host route. It checks the native surface, its grid, the remote PTY size before and after rotation, and the same shell PID after rotation. The host checks exactly one server bootstrap. | Instrumentation and host fixture | `native-android-terminal-session` |
