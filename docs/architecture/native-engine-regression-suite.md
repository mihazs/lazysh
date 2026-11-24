# Native engine regression suite

Owner policy (2026-11-24): every native-engine change (a feature, a fix, a parity gap) ships its regression tests in the same pull request, at the lowest layer that reproduces the behaviour, and a fix's test fails on the parent commit. This page maps each feature or user-reported bug to the test that guards it, the layer and the CI job that runs it. The feature list and the open gaps are in [the parity matrix](terminal-native-parity.md); the bug rows of the project-wide index are in [regression-tests.md](../regression-tests.md).

Layers and where they run:

| Layer | Runs in CI job | Notes |
| --- | --- | --- |
| Vitest over the stand-in core (`createHeadlessCore`) | `client` (`client:test`) | The first choice: the real adapter and pane, no device. |
| Vitest over the real core (`nativeTerminalAdapter.realCore.test.ts`) | `herdr-native` | The runtime crate's stdio harness. |
| Playwright (`e2e/terminal-native-*.spec.ts`, `terminal-engine-*.spec.ts`) | `client` (`client:test-e2e`) | A stand-in core in a browser; the `LAZYSH_E2E_TERMINAL_BACKEND=native` arm of the six xterm specs is skipped there ([#2123](https://github.com/mihazs/lazysh/issues/2123)). |
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
| Grid follows the pane and the display density | `nativeTerminalAdapter.fit.test.ts`; `nativeTerminalAdapter.realCore.test.ts` 'sizes the real core to its pane' | Vitest | `client`; `herdr-native` |
| History lines setting reaches an open session: the core keeps the new number of rows, a cut drops the oldest at once | `nativeTerminalAdapter.test.ts` 'native History lines setting'; `tauriNativeCoreBridge.test.ts`; `nativeTerminalAdapter.realCore.test.ts`; `packages/terminal-runtime/tests/scrollback.rs`; `local.rs` `the_real_core_keeps_the_history_lines_the_setting_changed_to` | Vitest; Vitest over the real core; Rust | `client`; `herdr-native`; `native-terminal-bridge` |
| Imported fonts reach the app before the look | `nativeTerminalAdapter.fonts.test.ts` | Vitest | `client` |
| Pinch zoom and configured touch gestures over a native pane | `TerminalPane.test.tsx` 'page features over a native pane' (pinch; two-finger swipe, tap and swipe) | Vitest | `client` |
| Find, toolbar Paste, OSC 52 consent, Select all, Copy screen over a native pane | `TerminalPane.test.tsx` 'page features over a native pane'; 'selection on a native session' | Vitest | `client` |
| Touch selection, handles and Copy | `TerminalPane.test.tsx` 'selection on a native session' | Vitest | `client` |
| Mouse selection, mouse reports, Shift-drag and edge scrolling | `nativePointerSelection.test.ts` | Vitest | `client` |
| Links: URL, OSC 8, host paths | `nativeLinkTap.test.ts`; `nativeTerminalAdapter.realCore.test.ts` (links.json) | Vitest | `client`; `herdr-native` |
| Hardware keyboard, IME composition, key interceptor, Shift+PageUp | `e2e/terminal-native-input.spec.ts` | Playwright | `client` |
| Soft keyboard text, keys and preedit on Android | `nativeSurfaceInput.test.ts`; `NativeTerminalInputTest` | Vitest; instrumentation | `client`; `native-android-runtime` |
| Finger scroll over the surface, surface placement and teardown | `e2e/terminal-native-surface.spec.ts` | Playwright | `client` |
| A native session draws the shell, takes typing, redraws after stop and start; hosts tmux with its status line and panes | `NativeTerminalSessionTest` | Instrumentation | `native-android-terminal-session` |
| The core runs inside the app | `NativeTerminalCoreTest` | Instrumentation | `native-android-terminal-core` |
| Screen reader: mirror of the rows, or refusal | `terminalBackends.test.ts`; `TerminalPane.test.tsx` 'mirrors a native session's rows'; `androidScreenReader.test.ts`; `NativeScreenReaderTest` | Vitest; instrumentation | `client`; `native-android-runtime` |
| Engine choice, kill switch, reason line, fallback, Switch to xterm.js | `e2e/terminal-engine-setting.spec.ts`; `e2e/terminal-engine-diagnostic.spec.ts`; `terminalBackendRegistry.test.ts`; `App.terminalEngine.test.tsx`; `App.nativeSession.test.tsx`; `nativeHandback.test.ts` | Playwright; Vitest | `client` |
| Herdr navigation cells on both engines | `herdrNavigationCells.test.ts` | Vitest | `client` |

## Gaps that still need a test

Each open gap has an issue that names its test; the table is the list of tests to add next: [#2501](https://github.com/mihazs/lazysh/issues/2501) selection, Copy and link taps on a placed surface; [#2502](https://github.com/mihazs/lazysh/issues/2502) rotation, keyboard insets and recreation; [#2500](https://github.com/mihazs/lazysh/issues/2500) multiplexer pages; [#2503](https://github.com/mihazs/lazysh/issues/2503) keyboard behaviour that read a DOM editor; [#2507](https://github.com/mihazs/lazysh/issues/2507) fonts on Android; [#2506](https://github.com/mihazs/lazysh/issues/2506) bold colour. A pull request that closes one adds its row here.
