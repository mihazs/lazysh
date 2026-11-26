# Terminal native engine: feature parity with xterm.js

Issue [#2492](https://github.com/mihazs/lazysh/issues/2492). The evidence below includes changes merged through e5059649 and candidate verification through 2026-11-26. Every feature the app offers for xterm.js is listed with what proves it on the native engine, or the issue that closes the gap. The test, layer and CI job behind each row are listed in [the regression suite](native-engine-regression-suite.md). A row says **Works** only when a named test asserts it on the native path; a feature that shares engine-independent page code but has no native test is **Unproven**, not working. Environment limits apply to every row: no native session has been checked on a real device ([#2457](https://github.com/mihazs/lazysh/issues/2457)), the CI emulator draws with a software GPU behind a debug switch, and vendor keyboards, TalkBack and real GPU drivers are accepted risks.

| Status | Meaning |
| --- | --- |
| Works | A test on the native adapter, pane, core or emulator asserts it. |
| Partial | Some of it is tested; the issue names the rest. |
| Unproven | Engine-independent page code, or a path no test drives over a native pane. |
| Gap | Known not to work on native. |
| N/A | No engine dependency, or xterm.js-only machinery. |

**Summary: 54 features. Works 34, Partial 15, Unproven 2, Gap 0, N/A 3.**


## Input

| # | Feature | Native | Evidence or issue |
| --- | --- | --- | --- |
| 1 | Soft keyboard text, keys and composing text (Android) | Partial | `nativeSurfaceInput.test.ts`; `NativeTerminalInputTest` (emulator); `NativeTerminalSessionTest` types a command through the InputConnection and reads the answer (#2449). A real device: SwiftKey stutters, see [#2489](https://github.com/mihazs/lazysh/issues/2489). |
| 2 | Soft keyboard opens when the terminal is tapped or focused (Android) | Works | [PR #2495](https://github.com/mihazs/lazysh/pull/2495) enables the native editor on terminal focus. The installed Android test in `NativeTerminalSessionTest` observes the keyboard opening and the editor taking input. Physical SwiftKey behavior remains tracked in [#2489](https://github.com/mihazs/lazysh/issues/2489). |
| 3 | Typing in the composer and other page inputs while a native session is placed (Android) | Works | [PR #2495](https://github.com/mihazs/lazysh/pull/2495) releases the native editor when a page field takes focus. `nativeSurfaceInput.test.ts` covers the focus handoff, and `NativeTerminalSessionTest` verifies the installed app can hand the keyboard to the composer and back to the terminal. |
| 4 | Hardware keyboard keys encoded as xterm.js sends them (arrows, Ctrl, Alt, Option as Meta, function keys, application cursor keys) | Works | `e2e/terminal-native-input.spec.ts` (typed characters and editing keys arrive once, as keys); `NativeTerminalInputTest.hardwareShortcutsReachTheTerminalAsKeysAndSystemKeysDoNot`. |
| 5 | IME composition and the preedit drawn at the cursor (desktop) | Works | `e2e/terminal-native-input.spec.ts` (two compositions commit twice, a lost-focus composition is dropped, preedit at the cursor through a real Chromium input method). |
| 6 | Key interceptor: app shortcuts such as Ctrl+Shift+F (Find) see a key before the terminal | Works | `terminalAdapter.contract.ts` 'shows the UI every key event before the terminal' (run for native by `terminalBackends.contract.test.ts`); `e2e/terminal-native-input.spec.ts` 'the key interceptor sees a key first'. |
| 7 | Shift+PageUp and Shift+PageDown scroll the history | Works | `e2e/terminal-native-input.spec.ts`. |
| 8 | Toolbar modifiers Ctrl, Alt, Shift, AltGr, sticky and locked | Partial | [PR #2495](https://github.com/mihazs/lazysh/pull/2495) enables native toolbar modifiers. `TerminalPane.test.tsx` compares native and xterm.js toolbar bytes and checks sticky Ctrl on IME text. The independent mixed IME and toolbar ordering fix has passed an owned Android 16 SSH run and still awaits integration ([#2526](https://github.com/mihazs/lazysh/issues/2526#issuecomment-7184304261)). |
| 9 | Toolbar named keys (Esc, Tab, arrows, Home, End, Enter, Backspace), D-pad, key repeat, long-press alternates, custom chords, snippets | Partial | `TerminalPane.test.tsx` compares named key bytes under Ctrl, Alt and Shift across both adapters. The installed Android `NativeTerminalSessionTest` reads toolbar Esc, Tab, Home, End and Shift+Tab from the owned shell using `cat -vT`. See [#2493](https://github.com/mihazs/lazysh/issues/2493) for the remaining device combinations. |
| 10 | Toolbar Paste key and bracketed paste | Works | `TerminalPane.test.tsx` 'page features over a native pane' (toolbar Paste, bracketed only when asked; [PR #2509](https://github.com/mihazs/lazysh/pull/2509)); `nativeTerminalAdapter.test.ts` 'brackets a paste only while the program asked for it'; `e2e/terminal-native-input.spec.ts`; `nativeSurfaceInput.test.ts`. |
| 11 | Composer: Send, Insert, drafts, attachment tokens, share-to-terminal and dictation into the draft | Works | `TerminalPane.test.tsx` 'the composer on a native session' (Send pastes then Enter and clears, Insert pastes and clears; fixed by [PR #2497](https://github.com/mihazs/lazysh/pull/2497), #2496, the test fails on the parent commit). Focus and typing in the composer on Android: [#2490](https://github.com/mihazs/lazysh/issues/2490). |
| 12 | Private keyboard preference (Android) | Partial | `NativeTerminalInputTest.privateKeyboardAsksForAVisiblePasswordWithNoSuggestionsAndNoLearning` checks the native editor flags. The app-level preference wiring remains tracked in [#2679](https://github.com/mihazs/lazysh/issues/2679). |
| 13 | Hide keyboard when scrolling; Herdr switch tap does not raise the keyboard | Partial | `NativeTerminalSessionTest` verifies that a real upward swipe dismisses the keyboard when the setting is enabled. `TerminalImeEditorTest` covers the composition guard. The Herdr tap is tracked in [#2503](https://github.com/mihazs/lazysh/issues/2503) and [PR #2534](https://github.com/mihazs/lazysh/pull/2534). |
| 14 | Keyboard show and hide toolbar key | Unproven | Part of [#2489](https://github.com/mihazs/lazysh/issues/2489); no test drives the key over a native pane. |
| 15 | Unapplied-edit review notice for rewritten keyboard text | N/A | xterm.js heuristics for a DOM editor; the native keyboard commits through an InputConnection and never produces the notice. |

## Display and preferences

| # | Feature | Native | Evidence or issue |
| --- | --- | --- | --- |
| 16 | Draws the session on an Android GPU surface | Partial | `NativeTerminalSessionTest` (CI emulator, debug software-GPU switch; #2449) draws the owned shell's prompt and answer. A real device showed nothing: [#2457](https://github.com/mihazs/lazysh/issues/2457) (open, owner retest pending). |
| 17 | VT conformance: screens, keys, mouse reports | Partial | Cross-engine corpus and reviewed divergences (`packages/terminal-runtime/fixtures/divergences.json`, all entries decided; `osc52-target-letters` accepted 2026-11-22). No conformance run on the shipped Android path. |
| 18 | Themes: bundled, custom, imported and QR palettes | Works | `nativeTerminalAdapter.look.test.ts` (look sent once per change, in order, again after a refusal); renderer host tests in `native_terminal_surface/panes.rs`. No on-device pixel check of a non-default theme. |
| 19 | Font family and size | Works | `nativeTerminalAdapter.look.test.ts`; `nativeTerminalAdapter.fit.test.ts` (the cell follows font size and display density). |
| 20 | Imported fonts | Partial | `nativeTerminalAdapter.fonts.test.ts` (the app hands the fonts over before the look); the renderer drawing them is [#2223](https://github.com/mihazs/lazysh/issues/2223). |
| 21 | CJK fallback list, wide cells, emoji | Works | The installed Android native renderer test in `NativeTerminalSessionTest` reads actual surface pixels for CJK, emoji, combining marks and a ZWJ sequence ([#2507](https://github.com/mihazs/lazysh/issues/2507)). It checks the CJK fallback selection when both fonts are installed. The debug emulator result leaves hardware GPU coverage to the platform gate. |
| 22 | Cursor style and blink | Works | The native renderer and runtime tests verify that the preference applies until a VT program chooses its own cursor and returns when the program resets it ([#2218](https://github.com/mihazs/lazysh/issues/2218)). |
| 23 | Bright bold and custom bold colour | Works | The adapter contract verifies that the native surface receives and clears the custom colour. Runtime draw tests cover bright bold and the wgpu pixel test covers default-coloured bold, regular and explicitly coloured bold text ([#2506](https://github.com/mihazs/lazysh/issues/2506)). |
| 24 | History lines (scrollback) setting | Works | Applied when a session opens (`terminalBackends.ts`) and to an open session: `nativeTerminalAdapter.test.ts` 'native History lines setting', `tauriNativeCoreBridge.test.ts` (one `terminal_core_scrollback` per change, retried after a refusal), over the real core `nativeTerminalAdapter.realCore.test.ts` (more rows after a raise, the oldest dropped at once after a cut), `packages/terminal-runtime/tests/scrollback.rs` (the runtime and the hub's accounting), `local.rs` `the_real_core_keeps_the_history_lines_the_setting_changed_to` (the app's command over a PTY, range checked); closes [#2505](https://github.com/mihazs/lazysh/issues/2505). |
| 25 | Scrolling by finger or wheel, history, follow live output | Works | `terminalAdapter.contract.ts` 'scrolls through history and follows live output again'; `nativeTerminalAdapter.test.ts` (wheel by lines); `e2e/terminal-native-surface.spec.ts` 'a finger drag on the container still scrolls the native terminal'. |
| 26 | Mouse reporting to programs: click, drag, wheel | Works | `nativePointerSelection.test.ts` (press, motion and release in the cell under the pointer; none while the program does not track); `nativeTerminalAdapter.test.ts` (one wheel report per notch). The `mouseReporting` flag is false by definition (xterm.js' DOM dispatch). |
| 27 | Pinch zoom | Works | `TerminalPane.test.tsx` 'resizes the text with a pinch, up to the largest size, and sends the renderer the new look' ([PR #2509](https://github.com/mihazs/lazysh/pull/2509)); the grid refit: `nativeTerminalAdapter.fit.test.ts`. Real touch on an Android surface: [#2501](https://github.com/mihazs/lazysh/issues/2501). |
| 28 | Tap, swipe and two-finger gestures (configured actions) | Works | `TerminalPane.test.tsx` 'runs a configured two-finger swipe, tap and swipe action, and nothing while text is selected' ([PR #2509](https://github.com/mihazs/lazysh/pull/2509)). Double tap, triple tap and pull share the same handlers and are not driven separately. |
| 29 | Grid follows the pane: font change, display density, rotation, keyboard insets, remote PTY resize | Partial | `nativeTerminalAdapter.fit.test.ts`; `nativeTerminalAdapter.realCore.test.ts` 'sizes the real core to its pane'. Rotation and keyboard insets on Android: [#2502](https://github.com/mihazs/lazysh/issues/2502). |
| 30 | Mosh canonical resize | Partial | `nativeTerminalAdapter.test.ts` (canonical resize cases); `App.nativeSession.test.tsx` (Mosh session on the core). The Android Mosh case runs xterm.js: [#2500](https://github.com/mihazs/lazysh/issues/2500); leaving native for a Mosh session: [#2414](https://github.com/mihazs/lazysh/issues/2414). |
| 31 | Alternate screen, application cursor keys, mouse and bracketed-paste modes | Works | `terminalAdapter.contract.ts` 'reports modes from the stream'. |
| 32 | Shell directory (OSC 7) for relative host paths | Works | `terminalAdapter.contract.ts` 'reports the shell directory (OSC 7) and clipboard writes (OSC 52) as events'. |
| 33 | Title and bell events | N/A | Both adapters forward them (`nativeTerminalAdapter.test.ts`); nothing in the app consumes them for xterm.js either. |
| 34 | Inactive sessions keep parsing and do not draw | Works | `terminalAdapter.contract.ts` 'survives rapid active switching'; `nativeTerminalAdapter.test.ts` 'asks for nothing while inactive and catches up'. |

## Selection, search, links and clipboard

| # | Feature | Native | Evidence or issue |
| --- | --- | --- | --- |
| 35 | Touch: long-press selects the word, handles extend it, Copy | Works | `TerminalPane.test.tsx` 'selection on a native session' (jsdom, headless core). Android instrumentation drives native long press, handle drag and Copy in `NativeTerminalSessionTest` ([#2501](https://github.com/mihazs/lazysh/issues/2501)). |
| 36 | Mouse: drag, double click word, triple click line, Shift-click extends | Works | `nativePointerSelection.test.ts`. |
| 37 | Shift-drag selects locally under mouse tracking; mouse drag scrolls at the edge | Works | `nativePointerSelection.test.ts` 'mouse selection the way xterm.js does it' (both cases fail on the parent commit; [PR #2510](https://github.com/mihazs/lazysh/pull/2510), closes [#2504](https://github.com/mihazs/lazysh/issues/2504)). |
| 38 | Select all and Copy screen | Works | `TerminalPane.test.tsx` 'selects the whole buffer, history included, and copies the visible screen, from the selection actions' ([PR #2509](https://github.com/mihazs/lazysh/pull/2509)); `nativeTerminalAdapter.realCore.test.ts` (select-all from the core). |
| 39 | Selected text read from the core across wrapped lines and history | Works | `nativeTerminalAdapter.realCore.test.ts` 'gives the adapter the core's text where the window of rows has none'. |
| 40 | Typing clears the selection; a terminal reply does not | Works | `nativeTerminalAdapter.test.ts`. |
| 41 | Copy writes the Android clipboard | Works | `NativeTerminalSessionTest` verifies the exact Android clipboard text after both word selection and handle extension ([#2501](https://github.com/mihazs/lazysh/issues/2501)). |
| 42 | OSC 52 clipboard write offered for consent; a query never answered | Works | Policy over the real core: `nativeTerminalAdapter.realCore.test.ts` (osc52.json); the sheet over a native pane: `TerminalPane.test.tsx` 'offers a program's clipboard write for consent...' ([PR #2509](https://github.com/mihazs/lazysh/pull/2509)). Android instrumentation verifies the clipboard changes only after Allow. |
| 43 | Find in the terminal history (next, previous, wrap, scroll to hit) | Works | `TerminalPane.test.tsx` 'finds a word in the whole buffer, scrolls to it and selects its row, and wraps to the first match' ([PR #2509](https://github.com/mihazs/lazysh/pull/2509)); `terminalAdapter.contract.ts` 'searches the whole buffer, wrapping, in both directions'. |
| 44 | Links: URL, OSC 8 hyperlink, host path with the consent flow | Partial | `nativeLinkTap.test.ts`; `nativeTerminalAdapter.realCore.test.ts` (links.json, first and last cell of every link). Android instrumentation taps a printed URL and verifies the link prompt and Copy URL ([#2501](https://github.com/mihazs/lazysh/issues/2501)). |

## Multiplexer pages and page features

| # | Feature | Native | Evidence or issue |
| --- | --- | --- | --- |
| 45 | tmux, Zellij, Herdr, rmux: Jump To, window and pane controls, tab strip, copy mode, gestures | Partial | `NativeWorkspaceTest.ownedTmuxControlsWithNativeEngine` checks tmux Jump To, numbered windows, copy mode and OSC 52 clipboard consent on Android. The remaining controls and multiplexers are tracked in [#2500](https://github.com/mihazs/lazysh/issues/2500). |
| 46 | Herdr phone navigation cells | Works | `herdrNavigationCells.test.ts` runs the same cases over xterm.js and the native adapter on the stand-in core. |
| 47 | Herdr history swipe over a native pane | Unproven | [#2500](https://github.com/mihazs/lazysh/issues/2500). |
| 48 | Attachments: paste an uploaded file's path into the terminal | Partial | `attachmentPaste.test.tsx` covers the bytes; the page reads only `adapter.modes().bracketedPaste` (covered for native by the contract) and writes through the transport. Not driven end to end over a native session; the Android cases of #2500 do not include it. |
| 49 | Agent view, agent board, hooks | N/A | Host-side hooks and transcripts; the app reads the terminal adapter only in `TerminalPane`, `TerminalSelectionTools`, the screen-reader mirror, the attachment paste and the session setup in `App.tsx` (grep of `apps/client/src`). |

## Accessibility and engine management

| # | Feature | Native | Evidence or issue |
| --- | --- | --- | --- |
| 50 | Screen reader: mirror of the rows, or refusal while touch exploration or the preference is on | Partial | `terminalBackends.test.ts`; `TerminalPane.test.tsx` 'mirrors a native session's rows'; `androidScreenReader.test.ts`; `NativeScreenReaderTest` (emulator, no reader). TalkBack itself is an accepted risk. |
| 51 | Engine choice in Settings, kill switch, one-line reason | Works | `e2e/terminal-engine-setting.spec.ts`; `terminalBackendRegistry.test.ts`; `App.terminalEngine.test.tsx`. |
| 52 | Status bar names the engine | Works | `App.nativeSession.test.tsx` (native, fallback, after Switch to xterm.js), merged in [PR #2494](https://github.com/mihazs/lazysh/pull/2494). |
| 53 | Fall back to xterm.js when native cannot start or place a surface; Switch this session to xterm.js | Works | `App.nativeSession.test.tsx`; `nativeHandback.test.ts`; `e2e/terminal-engine-diagnostic.spec.ts`. Android failure case: [#2379](https://github.com/mihazs/lazysh/issues/2379); Mosh: [#2414](https://github.com/mihazs/lazysh/issues/2414). |
| 54 | Session lifecycle: stop and start, background, Activity recreation | Partial | `NativeTerminalSessionTest` stops and starts and draws again; the rest: [#2502](https://github.com/mihazs/lazysh/issues/2502). |


## Packaged Android acceptance evidence

- The owned Android 16 emulator passed 20 applicable native terminal scenarios, including the exact URL in the tap consent prompt. [Candidate run](https://github.com/mihazs/lazysh/pull/2520#issuecomment-7187951484) · [URL evidence](https://github.com/mihazs/lazysh/issues/2388#issuecomment-7186285072)
- A real SwiftKey installation typed a command, deleted and retyped its final letter, and submitted it to an owned SSH shell. The separate zsh test reproduced the missing inline suggestion and verified Right Arrow acceptance after restoring the native editor field flag. [Editing evidence](https://github.com/mihazs/lazysh/issues/602#issuecomment-7172708981) · [History evidence](https://github.com/mihazs/lazysh/issues/2652#issuecomment-7185833792)
- The combined Android SSH case confirmed Ctrl and Alt toolbar ordering, retained the shell PID on xterm.js, and checked native surface retirement. Owned transport tests confirmed live handback for Mosh and Eternal Terminal. [Android and toolbar evidence](https://github.com/mihazs/lazysh/pull/2520#issuecomment-7187951484) · [Transport tests](https://github.com/mihazs/lazysh/pull/2635)
- The Android keyboard device used its installed German layout for Right Alt and Q. The owned SSH PTY received exactly one `@`. [Physical-layout emulation](https://github.com/mihazs/lazysh/issues/2661#issuecomment-7187424997)
- The current Waydroid guest has no reachable ADB endpoint. Physical Android keyboard, graphics, and thermal verification remain open.

## Desktop and iOS evidence

- The native Linux terminal rendered inline suggestions in fish and zsh. Right Arrow accepted the suggestion, and Enter ran the full command. Separate native mouse tests verified SGR Ctrl+wheel reports and plain scrollback. [Shell history](https://github.com/mihazs/lazysh/issues/2652#issuecomment-7188595820) · [Pointer input](https://github.com/mihazs/lazysh/issues/2615#issuecomment-7187157645)
- The installed iOS simulator admitted Metal, attached a live SSH session, sent input through the app IPC, and received output on the WebView route after switching. The installed Workspace tools flow, physical iPhone lifecycle, and VoiceOver remain open. [Installed simulator run](https://github.com/mihazs/lazysh/actions/runs/45781635304/job/139779972510)
- The Linux Debian and AppImage rehearsals drew the native terminal on Wayland and opened xterm.js on X11. The hosted Windows NSIS rehearsal verified rollback and reported no supported hardware GPU. Public packages from the pending PR remain unverified. [Packaging evidence](https://github.com/mihazs/lazysh/pull/2693)

## Adapter capability flags

`nativeCapabilities` in `nativeTerminalAdapter.ts`: `selection`, `scrollback`, `screenInspection`, `canonicalMoshResize` and `customBoldColor` are true and each has a passing contract case (`terminalBackends.contract.test.ts` fails otherwise); `accessibility` is true only while the screen-reader mirror is mounted. False by declaration: `nativeRendering` (no case yet), `mouseReporting` (xterm.js' DOM wheel dispatch; the native equivalents are rows above), `ime` (xterm.js' input observation; [PR #2495](https://github.com/mihazs/lazysh/pull/2495) changes this).

## Browser end-to-end arm

`LAZYSH_E2E_TERMINAL_BACKEND=native` runs six Playwright specs (`terminal-ime`, `terminal-swiftkey`, `terminal-selection`, `terminal-clipboard`, `herdr-switch-tap`, `mosh-resize`). The browser has no core, so the registry refuses native and the arm is skipped in CI ([#2123](https://github.com/mihazs/lazysh/issues/2123)); none of those specs is evidence for a native row. The native Playwright specs (`terminal-native-input`, `terminal-native-surface`, `terminal-engine-*`) use a stand-in core and do run. When the native matrix arm runs, a case can pass only after it reads the native adapter through `onAdapter`; a successful availability probe alone leaves that case unverified.

## Ordered plan for the open gaps

1. P0 daily input: [#2489](https://github.com/mihazs/lazysh/issues/2489), [#2490](https://github.com/mihazs/lazysh/issues/2490), [#2493](https://github.com/mihazs/lazysh/issues/2493) (Android input work); the composer ([#2496](https://github.com/mihazs/lazysh/issues/2496)) is fixed in [PR #2497](https://github.com/mihazs/lazysh/pull/2497).
2. P0 proof of what the pane already does, over the native adapter in Vitest: Find, Paste, OSC 52, Select all, Copy screen and the gestures of #2498 are covered by [PR #2509](https://github.com/mihazs/lazysh/pull/2509) (closes [#2499](https://github.com/mihazs/lazysh/issues/2499)).
3. P0 on the CI emulator, once the first session case is stable: [#2501](https://github.com/mihazs/lazysh/issues/2501) (selection, Copy, links), [#2502](https://github.com/mihazs/lazysh/issues/2502) (rotation, keyboard insets, recreation), [#2500](https://github.com/mihazs/lazysh/issues/2500) (multiplexer pages).
4. P1: [#2503](https://github.com/mihazs/lazysh/issues/2503) (keyboard behaviour from a DOM editor), [#2507](https://github.com/mihazs/lazysh/issues/2507) (fonts on Android), [#2223](https://github.com/mihazs/lazysh/issues/2223).
