# Reference-client parity matrix

Audit date: 2026-11-04. Source: `main` at `aa1e2f34`. Scope: Android and desktop (Linux and Windows; macOS only where CI evidence exists). iOS appears only to justify `n/a`.

This matrix splits the rows of the [Behavior checklist and Agent coverage tables](../reference-evidence.md#behavior-checklist) into concrete sub-behaviors and states, per platform, whether lazysh implements each one and whether an automated test of observable behavior proves it on that platform. It is an audit snapshot, not a release claim. Re-audit after a change instead of editing one cell from memory. The reference product is called "the reference client" throughout, as in the evidence catalog.

## Status definitions

| Status | Meaning |
| --- | --- |
| `verified` | Implemented, and an automated observable-behavior test on that platform runs in a CI job and passed on `main` in the audited window (see [CI evidence](#ci-evidence)). Accepted tests: Android emulator instrumentation or an Android runtime harness, the Linux native GUI suite, a real-runtime Rust integration test, or Playwright in the matching project (`phone` for Android-shaped UI, `desktop` for desktop UI) when the behavior is purely web UI. |
| `implemented` | Code exists and is reachable from the UI on that platform, but platform verification is missing or only unit-level/mocked: Vitest/jsdom, Playwright against the mocked native bridge for a native behavior, Rust tests with in-process fakes, an `#[ignore]` test that no CI job runs, a test that only runs on macOS, or a native case that is currently red. |
| `partial` | Some of the behavior exists; the Missing column says exactly what is absent. |
| `missing` | Not implemented, or not reachable on that platform. |
| `n/a` | Platform-specific on the reference client too (for example iOS-only surfaces or desktop-only launch arguments); the reason is given. |

Reading rules:

- **Desktop** `verified` means Linux unless the cell names Windows. Windows has no SSH GUI test, so a Windows-only gap is not repeated in every row. It is tracked once in [Gaps](#gaps) (#492, #457).
- Playwright serves the Vite UI with a mocked native bridge (`apps/client/e2e/fixtures/nativeBridge.ts`) in Chromium. It never verifies SSH, transports, keystores, biometrics, push, files or other native effects.
- Abbreviations: `NWT` = `apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt`; `ssh.spec` = `apps/client/native-e2e/ssh.spec.ts`; `TJF` = `apps/client/src-tauri/src/tmux_jump_fixture.rs`; `HGF` = `apps/client/src-tauri/src/herdr_guard_fixture.rs`; `MX` = `apps/client/src-tauri/src/multiplexer.rs`; `MP` = `apps/client/src/MultiplexerPanel.tsx`; `TP` = `apps/client/src/TerminalPane.tsx`; `PP` = `apps/client/src/PreferencesPanel.tsx`; `prefs` = `apps/client/src/preferences.ts`; `SS` = `apps/client/e2e/simple-shortcuts.spec.ts`; `src-tauri` = `apps/client/src-tauri/src`. Other paths are repository-relative.
- Job names: `NAR` = `native-android-runtime`, `NAA` = `native-android-auxiliary`, `NAH` = `native-android-herdr-navigation`, `NANT` = `native-android-ntfy`, `NL` = `native-linux`, `NLR` = `native-linux-runtimes`, `ND` = `native-desktop`, `PW` = Playwright in the `client` job (both projects unless marked).

## CI evidence

All jobs are in `.github/workflows/checks.yml`.

| Job | What it runs on a real runtime | State on `main` (2026-11-04) |
| --- | --- | --- |
| `native-android-runtime` | API 36 x86_64 emulator. `test:android-theme-links`, then all androidTest instrumentation except owned cases (`test:android`), then `tests/android-ssh.test.ts` and `tests/android-ssh-host.test.ts`, which drive the owned real-UI cases: OpenSSH trust and login, IME, D-pad, Mosh upload, Mosh background, companion install, Herdr Chat over SSH and Mosh, recorded Codex and OpenCode conversations. | Red on run 41802219276 (`3fa76b14`), only at the Herdr-over-Mosh Chat case. Green on 41735086913 (`bb8acd4e`). The recorded-conversation case is new in `aa1e2f34` and failed on its PR (#934). |
| `native-android-herdr-navigation` | Two-display stock Herdr navigation through the Android UI. | Green. |
| `native-android-mosh` | `packages/mosh-transport` official-server interoperability on the emulator. | Green. |
| `native-android-auxiliary` | Push registration and UnifiedPush instrumentation, QR camera theme import, companion emulator inventory and screenshot. | Green. |
| `native-android-ntfy` (fdroid, google) | Real ntfy encrypted enrollment, challenge and authenticated pause. | fdroid red on the last two runs; google green on 41802219276, red on the run in progress. |
| `native-android` | Android build plus JVM unit tests. These are unit-level, not device evidence. | Green. |
| `native-linux` | Linux non-ignored Rust tests; selected `#[ignore]` real OpenSSH, Mosh, tmux and Herdr tests; the Linux native GUI suite (`apps/client/native-e2e`, real Tauri app under WebKitWebDriver, Xvfb and a disposable Secret Service); the published companion GUI install; `test:mosh`; `test:tmux`; real tmux Chat input. | Red since run 41603977806 (`66e309a3`, 2026-11-03, last fully green). The GUI step fails on the Mosh attachment-reconnect case (#935), so later steps (`test:published-native-gui`, `test:mosh`, `test:tmux`, tmux Chat) were skipped on every later `main` run. Rows that rely on those steps count as `verified` from the 2026-11-03 run. |
| `native-linux-runtimes` | Ubuntu 24.04. `test:openssh` (SFTP, listing, remote reads, Git diff, preview forwarding with port fallback and teardown over real OpenSSH), `test:multiplexers` (real tmux, stock Herdr and official Zellij 0.45.1 lifecycle), `test:et` (official ET 7.0.0 built from its checksum-verified release source), `test:voice` (local Whisper on pinned public fixtures) and `test:parakeet-product` (real Parakeet manager with the pinned public archive). Each suite runs even when an earlier one fails. | Added after this audit; no `main` run yet. Rows citing it stay `implemented` until it is green on `main`. |
| `native-desktop` (macos-latest, windows-latest) | Release checks, credential-vault non-ignored tests, Windows NSIS install/repair/uninstall, `desktop_launch::`, local PTY and ConPTY (`test:local`), display-idle, `app_lock::`, companion storage; macOS host clipboard. | Green on both. |
| `client` | Vitest and Playwright (mocked native bridge). | Green. |

At audit time no CI job ran `test:et`, `test:openssh`, `test:multiplexers`, `test:voice` or `test:parakeet-product`; `native-linux-runtimes` now runs them on Linux. No CI job runs the full `test:voice-interop`. The Linux Codex and OpenCode native conversation cases (`ssh.spec:116,163`) are skipped in CI because their manifests are not provided. `ssh.rs:5794` (`macos_host_clipboard_roundtrip`) also exercises SFTP upload, preview forwarding and teardown, but only on the macOS runner.

## Summary

251 sub-behaviors, counting each Agent coverage row once.

| Platform | verified | implemented | partial | missing | n/a |
| --- | --- | --- | --- | --- | --- |
| Android | 70 | 130 | 26 | 15 | 10 |
| Desktop | 74 | 124 | 29 | 18 | 6 |

Most `implemented` rows are not missing features. They are reachable code whose platform proof is unit-level, mocked, ignored, macOS-only or currently red. The [Gaps](#gaps) section groups them into issues.

## Connections

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Named saved hosts (add, edit, delete, persist) | verified | verified | Host editor `apps/client/src/App.tsx:428-651`; storage `src-tauri/ssh.rs:108-145,211-241`. NWT:3556 (save, recreate Activity, delete; NAR); `native-e2e/sshUi.ts:58-69` via ssh.spec:21 (NL). | Windows GUI. |
| Username and port | verified | verified | `App.tsx:551-572`, `ssh.rs:170-198`. Ephemeral ports typed through the real UI: NWT:3286-3291 (NAR), `sshUi.ts:62-63` (NL). | — |
| Password authentication | implemented | implemented | `App.tsx:965-980`; `ssh.rs:1116-1121`. In-process russh only: `ssh.rs:5274,5356`. Every device and GUI fixture disables passwords (`tests/support/sshFixture.ts:175`). | Native GUI or emulator case against a password-enabled sshd. |
| Private-key authentication | verified | verified | `App.tsx:1071-1080`; `ssh.rs:1102-1115`. NWT:3313-3319 in ownedOpenSshConnectsThroughRealUi (NAR); `sshUi.ts:33-46` (NL). | — |
| Encrypted private key with passphrase | implemented | implemented | Passphrase field `App.tsx:1081-1087`; `ssh.rs:1103-1106`. Unit test `src-tauri/identities.rs:100-119`. | Native login with a passphrase-protected key. |
| First-use host-key trust (explicit SHA256 review) | verified | verified | Trust dialog `App.tsx:871-900`; `ssh.rs:620-665,1012-1042`. NWT:3320-3324 (no terminal before trust; NAR); `sshUi.ts:75-78` (NL). | — |
| Changed host-key refusal | implemented | implemented | `ssh.rs:1028-1035`; UI error with no trust shortcut `App.tsx:845`. In-process russh `ssh.rs:5274-5307`; Vitest `App.test.tsx:989`. | Real sshd whose key rotates after pinning. |
| Auto transport fallback (Mosh, then ET, then SSH) | implemented | implemented | `App.tsx:186-265` (order `:206`, skip reasons `:211`). Vitest `App.test.tsx:1436-1503`. Windows skips Mosh. | No native case selects Auto. |
| Forced transport selection | verified | verified | `App.tsx:580-584,915-931`; forced modes never fall back (`:254`). Forced Mosh: NWT:2883,3296 (NAR); ssh.spec:387 (NL). Forced SSH in every SSH case. | Forced ET anywhere; Mosh is compiled out on Windows (`src-tauri/mosh.rs:77-84`). |
| Mosh UDP port range | implemented | verified | `App.tsx:415-416`; validation `mosh.rs:48-58`; bootstrap `-p` `mosh.rs:60-68`. Single-port range in `test:mosh` `ssh.rs:6057-6060` (NL). | Android case with a non-default range. Windows has no Mosh. |
| Mosh server path | implemented | verified | `App.tsx:414`; quoted command `mosh.rs:60-67`. TJF:1336-1356 custom missing path fails safely (NL). | Android case with a custom path. |
| Experimental TCP-based ET | implemented | implemented | `src-tauri/et.rs:16-151` (refuses bastion and agent forwarding, `:103-106`). `test:et` (`ssh.rs:5787`, `packages/et-transport/tests/official.rs:194`) runs in `NLR`. | First green `NLR` run on `main` makes desktop `verified`; Android ET case. |

## SSH identity and routing

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Generate key (Ed25519, passphrase-encrypted) | implemented | implemented | `src-tauri/identities.rs:63-93`; `apps/client/src/CredentialsPanel.tsx:29-31,54` via Connect, then Private key, then "Generate or inspect" (`App.tsx:1088-1097`). Unit test `identities.rs:100`; mocked `e2e/credentials-locales.spec.ts:6`. | Native generate-then-login. Generated keys are not kept in a key library. |
| Import private key from a file | missing | missing | Only a textarea (`CredentialsPanel.tsx:51`, `App.tsx:1071`). | File-picker import. |
| Paste private key | verified | verified | `App.tsx:1071`; `identities.rs:44-61`. NWT:3314-3315 (NAR); `sshUi.ts:39-45` (NL). | — |
| Reject public-key input | implemented | implemented | `identities.rs:36-38`; unit test `:116-118`. Connect reports a generic decode error (`ssh.rs:1103`). | UI-level native case. |
| Show fingerprint | implemented | implemented | `identities.rs:21-30`; `CredentialsPanel.tsx:56`. Mocked `credentials-locales.spec.ts:6`. | Native run. |
| Export public key | implemented | implemented | Read-only field and clipboard copy `CredentialsPanel.tsx:40-45,56`. Mocked clipboard `credentials-locales.spec.ts:6`. | Native clipboard check. |
| SSH-only bastion routing (one hop) | implemented | implemented | `App.tsx:592-610,939-964`; `src-tauri/routing.rs:5-83`; Mosh and ET skipped for bastion routes (`App.tsx:211`, `et.rs:105`). In-process russh `routing.rs:264,313,349`. | Two real sshd hops on a native runtime. |
| Agent forwarding: opt-in, single identity, off by default | implemented | implemented | `App.tsx:611-631` (new hosts have no `forwardAgent`, `:459-467`); `ssh.rs:1089-1094,1135-1137`. Unit tests `src-tauri/forward_agent.rs:181,236`. | Real `ssh-add -l` or signature through the forwarded agent. |
| VPN through ordinary OS routing | implemented | implemented | No VPN code; plain TCP connect `ssh.rs:968-976`. Vitest accepts tailnet and IPv6 targets (`App.test.tsx:816`). | Parity by design; nothing app-specific to verify. |

## Session lifetime

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Several concurrent sessions | verified | verified | Registry `apps/client/src/AccessShell.tsx:100-113`. NWT:1941 (second Herdr tab; NAR), NWT:2383 (NAH); ssh.spec:453-538 (two hosts, sockets unchanged; NL). | — |
| Switch, close and reopen | verified | verified | Close NWT:1384-1396 and `sshUi.ts:111-115`; switch ssh.spec:512-529; reopen with saved credentials ssh.spec:349-370 (NL). | Android reopen with saved credentials. |
| Last-session resume after restart | implemented | implemented | Intents in localStorage `apps/client/src/workspace.ts:21,59-85`; explicit "Restore previous workspace" `App.tsx:1498-1610,1886-1888`. Vitest; mocked `e2e/hosts.spec.ts:153`. | Native restart-and-restore case. Restore is explicit, not automatic. |
| Reconnect reattaches tmux and Herdr | implemented | implemented | `App.tsx:1543-1577` (`attachTmux`, `attachMultiplexer`). Attach primitives are real-tested (`test:tmux`, HGF), not this restore flow. | Native restore-then-reattach case. |
| Zellij initial attach without automatic restoration | implemented | implemented | Restore skips Zellij (`App.tsx:1524-1526`). Real attach `zellij.rs:97` runs in `NLR` (`test:multiplexers`). | Same limit as the reference client; First green `NLR` run on `main` makes desktop `verified`. |
| Optional client environment flag | missing | missing | PTY request sends no environment (`ssh.rs:1700`); no env request anywhere in `apps/client`. | Opt-in env request (for example a client marker variable). |
| Mosh survives backgrounding and SSH control loss | verified | verified | NWT:2487,2723-2753 ownedMoshSurvivesBusyBackgroundThroughRealUi (`tests/android-ssh-host.test.ts:194`, NAR); ssh.spec:540 (UDP daemon survives client and server SSH closure; NL). | No IP-roaming or network-switch test (`docs/multiplexers.md:233-235`); Windows has no Mosh. |

## Terminal and history

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Local scrollback with finger and wheel scrolling | verified | verified | TP:275-361. SS:523-729 scroll real xterm history (PW phone and desktop). | — |
| Bounded scrollback (100 to 20000 lines) | implemented | implemented | `prefs:54,98,154`; PP:103-104. Unit test `apps/client/src/preferences.test.ts:49-62`. | Change the preference and assert trimming. |
| New output does not pull a reader out of history | implemented | implemented | Stock xterm behavior; TP:471-477 keeps the anchor on height-only resize. SS:938-940 and `e2e/mosh-resize.spec.ts:59-78` cover resize, not new output. | Write output while scrolled up and assert the viewport stays put. |
| Mosh keeps local history honest (no reconstructed remote scrollback) | verified | verified | `apps/client/src/moshResize.ts:33-37`. NWT:1768-1865 verifyMoshResize (row count stable; NAR); `mosh-resize.spec.ts:59,286-330` (PW, captured frames). | No in-app notice; the limit is documented in `docs/connections.md:201`. Android case is flaky with the Herdr-over-Mosh run. |
| Durable history, search and copy through tmux copy mode | implemented | implemented | Copy mode = prefix + `[` (`apps/client/src/MultiplexerShortcuts.tsx:23,28`, `MP:132`). Unit test only. | Real tmux copy-mode search and copy. |
| Search local history | verified | verified | TP:569-586,736-740 (Ctrl+Shift+F at TP:391). `e2e/i18n.spec.ts:230-232`, SS:903-910 (PW). | — |
| Copy selection to device clipboard | implemented | implemented | TP:534-539,794. SS:913-943 stubs the clipboard. | Read the real OS clipboard after copying. |

## Touch gestures

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Configurable single tap | verified | verified | TP:629-641,684; PP:118. SS:387-389,501-503 (exact bytes). | Physical touch. |
| Double and triple tap | implemented | implemented | TP:632-640. Unit test `TerminalPane.test.tsx:671`; persistence `e2e/preferences.spec.ts:83,95`. | Playwright execution of the gesture. |
| One-finger swipes | implemented | implemented | TP:345-346,679-686. Unit test `TerminalPane.test.tsx:698`. | Gesture execution test. |
| Two-finger swipes (four directions) | implemented | implemented | TP:599-609,687-698. Unit tests `TerminalPane.test.tsx:607,698,939`. | Gesture execution test. |
| Pinch changes font size | implemented | implemented | TP:655-675,692-693; PP:106. Unit test `TerminalPane.test.tsx:939`. | Playwright or device pinch. |
| Pinch zooms the multiplexer pane | missing | missing | Pinch only changes font size; pane zoom is a button (`MultiplexerShortcuts.tsx:23-24`). | Map pinch to pane zoom. |
| Header pull depths | missing | missing | No pull or overscroll gesture in `apps/client/src`. | — |
| Toolbar alternate (long-press) actions | missing | missing | Toolbar keys only hold-to-repeat (TP:780-787). | — |
| D-pad arrows, tap and held pan | verified | verified | TP:173-227,704-707,749-757. NWT:2481,4399-4600 ownedSshDpadPanThroughRealUi (NAR); ssh.spec:208-320 (NL). | — |
| D-pad corners (defaults or custom chord) | verified | verified | TP:753-755; `prefs:58,105`; PP:121. SS:384-385 custom corner chord (PW). | Default corner actions are unit-only. |
| Reset gestures | verified | verified | PP:122. `preferences.spec.ts:98-100,119-120` (PW). | Corner reset not asserted. |
| Defaults distinguish tab, pane and workspace/session levels | missing | missing | Every default is "none" (`prefs:57-58`); actions exist for lazysh sessions and Zellij only (`prefs:17`). | Level-aware tmux/Herdr/Zellij defaults. |

## Keyboard and shortcuts

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Reorderable terminal toolbar | implemented | implemented | PP:44-51,127-128. Add and remove through the real UI: NWT:4907-4915 (NAR), ssh.spec:214-221 (NL). Reordering is unit-only (`PreferencesPanel.test.tsx:117`). | Test that moves a key and checks the toolbar order. |
| Ctrl, Alt/Meta, AltGr and Shift with lock | verified | verified | TP:529-533,760-772; `apps/client/src/terminal.ts:57-61`. `i18n.spec.ts:217,233-234`, SS:757 (PW); one-shot Shift over real SSH NWT:4943-4961 (NAR). | — |
| Arrow keys with hold-to-repeat | verified | verified | TP:20,82-86,780-787. SS:111-127 (PW); D-pad cases above. | — |
| Enter and Backspace keys | verified | verified | `prefs:13`. Toolbar Enter over real SSH NWT:4949-4955 (NAR); SS:96-109 (PW). | Backspace is unit-only. |
| Snippets | implemented | implemented | PP:131-139; toolbar inserts into the composer (TP:791). Persistence `e2e/shortcut-capacity.spec.ts:4`. | End-to-end snippet activation. |
| Simple modifier sequences | verified | verified | `apps/client/src/simpleChord.ts:7-32`; `ChordBuilder.tsx:25-34`. SS:293-341 (PW). | — |
| Validated advanced chords, function keys, per-step modifiers | verified | verified | `prefs:176-226`; `ChordBuilder.tsx:36-44`. SS:469-504 (Alt+F12 sends `\x1b[24;3~`); `preferences.spec.ts:80-104` (PW). | — |
| Hardware app shortcut (Ctrl/Cmd+K palette) | verified | verified | `apps/client/src/keyboard.ts:3-15`; `App.tsx:1692-1711`. `e2e/workspace.spec.ts:14`, `preferences.spec.ts:143` (PW). | Physical Android keyboard. |
| Hardware session shortcuts (Ctrl+1 to 9, O, N, W) | implemented | implemented | `keyboard.ts:13-15`; `App.tsx:1696-1708`. Unit test `keyboard.test.ts:13-29`. | Playwright key-press test. |
| Hardware terminal keys (Shift+Enter, modified named keys) | verified | verified | TP:390-405. Shift+Enter NWT:4955 (NAR); SS:96-109 (PW). | — |
| Option as Meta | n/a | n/a | macOS-only key (PP:112; `prefs:99,154`); Linux, Windows and Android send ESC+key for Alt. macOS checked only with a Mac user agent (`e2e/terminal-ime.spec.ts:440-464`). | macOS native test (#958 scopes the control). |
| Optional toolbar auto-hide | partial | implemented | Auto-hide only for fine pointers (TP:155,363-369; PP:107); touch Android has a manual Show/Hide button (TP:711). No tests. | Touch auto-hide; any test. |

## Clipboard and links

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Paste into the terminal | verified | implemented | TP:548-568,773; `apps/client/src/deviceClipboard.ts:88-98` (Android native read `src-tauri/clipboard.rs:8,195`). NWT:3463-3476 (NAR). Desktop: only Ctrl+V into the Chat draft is native-tested (ssh.spec:421-436). | Linux native test of the toolbar Paste button. |
| Preserve raw pasted text | verified | verified | Literal clip with no Enter NWT:3463-3476 and exact draft paste NWT:2252 (NAR); exact draft bytes ssh.spec:436-447 (NL). | — |
| Long-press touch selection | missing | implemented | Android: `user-select:none` and `pointer-events:none` on coarse pointers (`apps/client/src/styles.css:692-696`), no touch selection handler. Desktop: xterm mouse selection plus Copy (TP:794); clipboard stubbed in SS:913-943. | Touch selection (Android); native copy test (desktop). |
| Open or copy a URL | implemented | implemented | TP:28-36,377-380,540-547,733-735; `src-tauri/links.rs:4-45`. Vitest and Rust parse tests only. | Device or GUI link-open test. |
| OSC 52 remote-to-device clipboard with consent | implemented | implemented | TP:382-389,727-732; `prefs:161-172` (write-only, 64 KiB). `i18n.spec.ts:222-229` with a mocked clipboard. | Assert the real OS clipboard. |
| Multiplexer escape passthrough (tmux DCS-wrapped OSC 52) | missing | missing | No DCS handler and no tmux `set-clipboard` setup. | — |

## CJK and IME

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| IME composition in the terminal (agent TUIs) | verified | implemented | `apps/client/src/terminalIme.ts`; `terminal.ts:36-55`. NWT:4705-4969 ownedSshImeTransactionsThroughRealUi with a real IME service over SSH (`tests/android-ssh-host.test.ts:186`, NAR). Desktop: Chromium-emulated composition only (`e2e/terminal-ime.spec.ts`, SS:739-842). | Real WebKitGTK input method in the Linux GUI suite. |
| Compose before sending (Composer, then Paste draft) | verified | verified | `apps/client/src/TerminalComposer.tsx`; TP:742-746. NWT:3350-3458 over real SSH (NAR); `i18n.spec.ts:44-63` (PW). | — |
| Mixed Latin/CJK cell alignment | implemented | implemented | Stock xterm width rules (no unicode11 addon); CJK face limited to CJK code points (`apps/client/src/fonts.ts:94`). `e2e/theme-rendering.spec.ts:117` checks colour only. | Cell-width rendering test. |
| Configurable glyph fallback | verified | verified | `prefs:53,95`; PP:80,87-92; `fonts.ts:94,111-113`. `preferences.spec.ts:14-39` (import, select, reload; PW). | — |
| IME in the Chat composer | implemented | implemented | `apps/client/src/ChatPanel.tsx:562` (composition guards). Unit tests `ChatPanel.test.tsx:281`, `ChatPanel.terminalInput.test.tsx:41`. | Device IME case in Chat. |

## Appearance

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Whole-app theme | verified | verified | `apps/client/src/appearance.ts:7-17`; PP:73. `native-e2e/appearance.spec.ts:65-99` (NL); NWT:872-978 native `--theme-bg` (NAR). | — |
| Terminal theme | verified | verified | `prefs:8-12,148-155`; PP:74-77. `e2e/theme-rendering.spec.ts:17-244` (PW). | — |
| Custom theme import (JSON or share code) | verified | verified | `apps/client/src/ThemeImportPanel.tsx:18-22,40-49`. `e2e/theme-import.spec.ts:5-44` (PW). | — |
| Theme import from the clipboard | partial | implemented | `ThemeImportPanel.tsx:32-35` uses `navigator.clipboard.readText`, not the native Android read path (`deviceClipboard.ts:88-97`), so the button may fail in the Android WebView; pasting into the field works. Unit tests only. | Native Android read and a device test. |
| Theme import by QR | verified | implemented | `apps/client/src/themeQr.ts:62-120`; `src-tauri/theme_qr.rs:63,155`. NWT:1124 ownedQrCameraRequiresPermissionAndExplicitPreview (NAA). Desktop: decoder unit tests and `e2e/theme-qr.spec.ts:54` with a synthetic camera. | Desktop camera or image-file scan in the GUI. |
| Theme import by deep link | verified | implemented | `src-tauri/theme_links.rs:85-115`. NWT:872 themeLinksUseFirstActivityAndWarmIntentWithExplicitReview (NAR). Desktop: mock-runtime test `theme_links.rs:153-235`; mocked `e2e/theme-links.spec.ts:7`. | Real OS URL dispatch on Linux and Windows. |
| On-demand font download | implemented | implemented | `apps/client/src/fontDownload.ts:18-32`. `e2e/font-download.spec.ts:14,28` cover failure and CSP; the success case (`:37`) needs `LAZYSH_NOTO_LIVE=1`. | Success path in CI. |
| Imported fonts (TTF, OTF, WOFF, TTC; four max) | verified | verified | `fonts.ts:118-150`; PP:85-94. `preferences.spec.ts:14-56` (PW). | Native file chooser not exercised. |
| CJK fallback font | verified | verified | Covered by glyph fallback above. | — |
| Cursor shape and blink | implemented | implemented | PP:101-102; `prefs:96-97,154`. Unit test `preferences.test.ts:49`. | Rendering test. |
| App icon selection | missing | missing | `apps/client/src/AppIconPanel.tsx`; `packages/apple-status/src/lib.rs:172-179` reports unavailable on every non-iOS target (`native-e2e/appearance.spec.ts:69-70` asserts the notice). | Android launcher-alias icons. Desktop icon switching is not established for the reference client either. |
| UI locale (en, pt-BR, es, system) | verified | verified | PP:63-66; `apps/client/src/i18n/nativeLocale.ts`. `NativeUiLocaleTest.kt:42,65` (NAR); `i18n.spec.ts:64`, `e2e/native-locale.spec.ts:5` (PW). | macOS native locale (#79). |
| Session list or card preference | verified | verified | PP:72; `prefs:88`. `e2e/session-layout.spec.ts:45-99` (PW). | — |
| iOS glass | n/a | n/a | iOS-only material on the reference client. | — |

## Secure storage and sync

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Secrets in the platform keystore, separate from host metadata | verified | verified | Vault record `src-tauri/vault.rs:41-102`; Secret Service and Windows backends `packages/credential-vault/src/lib.rs:492-505`; Android AES-GCM AndroidKeyStore (`VaultPlugin.kt:120-131,197-215`). `NativeVaultTest.kt:51` (only ciphertext stored, tampering rejected; NAR); ssh.spec:324-347 (Secret Service entry, `hosts.json` free of secrets; NL). | Windows real keyring (`os_vault_roundtrip`, `lib.rs:829`, is ignored); Android app-level save-credentials flow. |
| Host-key fingerprints in secure storage | partial | partial | Pins are plaintext in `hosts.json` (`ssh.rs:127-128`; mode 0600 on Unix only, `:225-229`); a copy is bound in the vault record (`vault.rs:48,104-119`). | Fingerprints are not held in the keystore the way the reference row implies. |
| Delete credentials with the host | implemented | implemented | `ssh.rs:568-571` removes the vault entry; changed identity purges (`:490-501`). Explicit Forget verified on Linux (ssh.spec:373-379); NWT:3582 deletes a host without saved credentials. | Delete a host that holds saved credentials, then assert the keystore entry is gone. |
| Biometric gate for key use | implemented | missing | Android BiometricPrompt BIOMETRIC_STRONG with an auth-bound key (`VaultPlugin.kt:120-160`); per-host opt-in `App.tsx:619-628`. Linux and Windows report unavailable (`credential-vault/src/lib.rs:565-571`); macOS implemented. `NativeVaultTest.kt:84` only proves fail-closed. | Emulator with an enrolled fingerprint completing a read. Linux/Windows support decision. |
| Biometric resume lock | implemented | missing | `apps/client/src/AccessPanel.tsx`, `AccessShell.tsx:134-147`; Android resume gate. Linux and Windows unavailable (`lib.rs:277-283`). `NativeResumeCoverTest.kt:20` (cover and FLAG_SECURE, no OS auth; NAR); `app_lock::` policy (ND). | Device lock, authenticate and unlock case. |
| Separate settings sync toggle | implemented | implemented | `apps/client/src/SyncPanel.tsx:258-264,308-339`; `src-tauri/sync.rs:95`. Unit test `sync.rs:1452`; mocked `e2e/sync-locales.spec.ts:21-40`. | Native WebDAV round trip (#17). |
| Separate credential sync toggle | implemented | implemented | `SyncPanel.tsx:266-272`; `sync.rs:95-96`; biometric policy never transfers (`sync.rs:1606`). | Same as above (#17). |
| Biometric confirmation for private-key export | implemented | missing | Export only with `biometricUnlock` and stored credentials (`App.tsx:1009-1056`); native refusal `vault.rs:313-347`. Vitest `App.test.tsx:1267,1334`. Linux and Windows lack biometrics. | Device test with enrolled biometrics. |

## Multiplexer discovery

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Discover tmux and list sessions, windows and panes | implemented | verified | MX:333-430,547; MP:55,136,150. TJF:1850 real `multiplexer_tree` (`test:tmux`, NL). | Android tmux case. |
| Detect Herdr and list servers | verified | verified | MX:197-215,240-265; MP:137-142. NWT:1936-1973,2376-2381 (NAR, NAH); ssh.spec:485,505-507 (NL). | — |
| Detect Zellij and list sessions | implemented | implemented | MX:216,250-251. Real test `src-tauri/zellij.rs:97` runs in `NLR`; `e2e/multiplexer-locales.spec.ts:7-59` is mocked. | First green `NLR` run on `main` makes desktop `verified`. |
| Recent project directories from agent history | implemented | implemented | MP:103-114,129-131 (newest first, deduplicated). Vitest `MultiplexerPanel.test.tsx:27`. | Real companion history feeding the list. |
| Start a workspace in a chosen directory | implemented | partial | tmux `-c` MX:481-486; Herdr `apps/client/src/HerdrPanel.tsx:54`; Zellij `ZellijPanel.tsx:30`. Only tmux create-with-directory is real-tested (TJF:1892-1903, NL). | Herdr and Zellij create on desktop; any Android case. |

## tmux

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Attach to a session (including named server `-L`) | implemented | verified | MX:90-97; `App.tsx:2254-2260`. TJF:836,1715 (`test:tmux`, NL). | Android tmux case. |
| Create a session (explicit or saved create-if-missing default) | implemented | verified | MX:113-133,172-195; host editor `App.tsx:573-577`. TJF:1256,1892 (`test:tmux`); TJF:1474 (Mosh entry, NL). | Android tmux default. |
| Configurable prefix | implemented | implemented | `MultiplexerShortcuts.tsx:15-36`. `e2e/awake-shortcuts-locales.spec.ts:20-44` checks bytes against a mocked writer. | Real PTY delivery and persistence. |
| Window and pane actions | implemented | partial | MX:434-545; MP:152-163. Rename session, split, create window and wrong-server refusal real-tested (TJF:1809-1890, NL). Select window, rename window and zoom in MX:702, which runs in `NLR`. | First green `NLR` run on `main` makes desktop `verified`; Android case. |
| Numbered window controls | implemented | implemented | Prefix plus digit `MultiplexerShortcuts.tsx:41`; Jump To by index `apps/client/src/TmuxJumpPanel.tsx:64-70`. | Remote-effect test. |
| Detach | implemented | implemented | prefix+d `MultiplexerShortcuts.tsx:22`; closing the tab detaches (MP:166). | Assert the session survives detach. |
| Project-directory launcher | implemented | implemented | MP:119,129-131,147. | Same as recent directories. |

## Herdr

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Persistent named servers: list and attach | verified | verified | MX:35,78-87; `ssh.rs:3168-3229`. NWT:1938-1941,2380-2383,3330-3339 (NAR); HGF:241-276 two named servers, ssh.spec:387-451 saved default via Mosh (NL). | — |
| Workspaces, tabs and panes tree | verified | verified | `src-tauri/herdr.rs:6-41,334`; `apps/client/src/HerdrNavigation.tsx:119-127`. NWT:2391-2394 (NAH); ssh.spec:485 (NL). | — |
| Focus workspace, tab or pane | verified | partial | `herdr.rs:350-417`; `App.tsx:1835-1867`. NWT:1970-1981,2357-2372 (NAR, NAH). Desktop real test covers FocusWorkspace only (HGF:383). | Desktop tab and pane focus. |
| Create and rename workspaces and tabs, split | implemented | implemented | `herdr.rs:212-330`; `HerdrPanel.tsx:10-14,54-71`. Real test `herdr.rs:667` runs in `NLR` with the same-run stock Herdr. | First green `NLR` run on `main` makes desktop `verified`. |
| Configurable prefix and numbered tabs | implemented | implemented | `MultiplexerShortcuts.tsx:23,41`; tab numbers `HerdrPanel.tsx:62`. | Prefix delivery and remote effect. |
| Pane zoom | implemented | implemented | `herdr.rs:327-329`; `HerdrPanel.tsx:66`. Real zoom in `herdr.rs:667` (`NLR`). | First green `NLR` run on `main` makes desktop `verified`. |
| Per-agent state | partial | implemented | `apps/client/src/useHerdrNavigation.ts:13-52`; `HerdrNavigation.tsx:14,128-130`. Mocked `e2e/workspace.spec.ts:1199-1205`. The Android real case shows only "Unknown status" (NWT:1495-1511). | Real Herdr with a non-unknown agent state. |
| Exact event context (agent to its pane, workspace, tab, cwd) | verified | implemented | `HerdrNavigation.tsx:128`; `App.tsx:1856-1863`; `apps/client/src/HerdrSessionDetails.tsx:17-28`. NWT:1490-1497,2393,2400 (NAR, NAH). Desktop mocked `workspace.spec.ts:385-387`. | Desktop exact-pane navigation case. |

## Zellij

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Detect, list and attach | implemented | implemented | MX:43,98-99,216; MP:138-142. Real test `zellij.rs:97` runs in `NLR`; mocked `multiplexer-locales.spec.ts`. | First green `NLR` run on `main` makes desktop `verified`. |
| Initial auto-attach (saved default) | implemented | implemented | `App.tsx:573-577,822`; MX:172-195. TJF:1381,1587 ignored. | Run TJF:1587 in CI. |
| Shortcut panel | implemented | implemented | `apps/client/src/ZellijPanel.tsx:33-40` (prefix panel deliberately excluded, MP:132). Vitest `ZellijPanel.test.tsx:8`. | Real action effect. |
| Numbered tabs (1 to 20 plus number field) | implemented | implemented | `ZellijPanel.tsx:36-39`. Mocked `e2e/zellij-quick-tabs.spec.ts:7-46`. Real go-to-tab in `zellij.rs:97` (`NLR`). | First green `NLR` run on `main` makes desktop `verified`. |
| Remote action bridge | implemented | implemented | `zellij.rs:37,53,56`; unit tests `zellij.rs:76-92`; real tab and pane actions `zellij.rs:97` (`NLR`). | First green `NLR` run on `main` makes desktop `verified`. |
| Jump tree, deep links, custom prefix, reconnect restoration | n/a | n/a | Not offered by the reference client for Zellij; lazysh also has none. | — |

## Jump navigation

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Live tmux session and window tree with jump | implemented | verified | `src-tauri/tmux_jump.rs:796-804`; `TmuxJumpPanel.tsx:23-57` (tmux tabs only, `App.tsx:1333,2026`). TJF:830,836,1717,1871 (`test:tmux`, NL); `e2e/tmux-jump.spec.ts:8-108` (PW). | Android tmux Jump case. |
| Live Herdr workspace and tab tree | verified | verified | `HerdrNavigation.tsx:119-127`. NWT:2357-2394 (NAH); ssh.spec:481-489 (NL). | — |
| Current item marker | implemented | verified | tmux `aria-current` `TmuxJumpPanel.tsx:63-66` (TJF:836 real binding; `tmux-jump.spec.ts:56,85-88`); Herdr `data-current` `HerdrNavigation.tsx:66-68` not asserted. | Herdr current marker on either platform; Android tmux. |
| Herdr agent state in the tree | partial | implemented | Same evidence as Herdr per-agent state. | Real non-unknown state. |
| List, accordion and grid layouts with remembered preference | partial | partial | tmux layouts and `lazysh.multiplexer.layout` (`TmuxJumpPanel.tsx:16-19,38-41`; MP:50,72) verified in `tmux-jump.spec.ts:10,54,77-83` (PW). The Herdr tree has only collapse and expand (`HerdrNavigation.tsx:122-125`). | Herdr list, accordion and grid layouts. |
| Plain shell reports unavailable | verified | verified | No Jump To for a non-tmux tab (`App.tsx:2020-2026`); "Jump To unavailable" on failure (`TmuxJumpPanel.tsx:59`). `tmux-jump.spec.ts:46` (PW). | — |
| Zellij reports unavailable | implemented | implemented | Same `kind!=='tmux'` gate (`App.tsx:1333`). | Test with a Zellij-attached tab. |

## Agent hooks and companion

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Install the companion from the app | verified | verified | `src-tauri/companion.rs:105`; `apps/client/src/CompanionInstallPanel.tsx`. NWT:2486,3172-3276 ownedCompanionInstallsThroughRealUi (NAR); `ssh.rs:5813` (NL) and `apps/client/published-native-e2e/companion.test.ts:13` (NL, last run 2026-11-03). | Windows GUI; Windows host adapter (#490); in-app installer (#476). |
| Normalize lifecycle events (Working, Needs you, Done) | implemented | implemented | `apps/agent/src/lib.rs:204-359`; `apps/agent/src/hooks.rs:117-292`. Host tests `apps/agent/tests/cli.rs` (`agent` job). | Client-runtime case that sends a real hook event and sees a populated board. |
| Managed hook configuration preserves existing hooks | implemented | implemented | `apps/agent/src/hook_setup/mod.rs:76-89`; discovery Linux-only (`hook_setup/discovery.rs:347`). `apps/client/src/CompanionHooksPanel.tsx:93-145`. Host tests `apps/agent/tests/hook_setup.rs` (`agent`); client test mocked (`workspace.spec.ts:637`). | Real client Inspect, Install and Remove against a real profile; macOS hosts report managed setup unsupported. |
| Read local agent transcripts | verified | verified | `apps/agent/src/transcript.rs:105-204`; `ChatPanel.tsx:277-350`. Claude records NWT:2243-2248 (NAR); ssh.spec:399-404 (NL). | Desktop Codex/OpenCode cases skipped in CI. |
| Terminal works without the companion | verified | verified | `apps/client/src/AgentPanel.tsx:166`; `src-tauri/account_usage.rs:63-65`. SSH prompt before install NWT:3328-3330 (NAR); `published-native-e2e/companion.test.ts:24-31` (NL). | — |

## Agent board

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Per-session Needs you, Working and Done | implemented | implemented | `AgentPanel.tsx:27,197`; `apps/agent/src/lib.rs:626-668`. Mocked `e2e/agent-board-locales.spec.ts:39-84`; Android only proves the empty board (NWT:1498-1499). | Real hook events rendered on a native runtime. |
| Group by project and host | partial | partial | Grouped by state only (`AgentPanel.tsx:197`); one board per connection; project is card text with search (`:177-179`). | Project and cross-host grouping. |
| Latest events collapse into one row | implemented | implemented | Upsert on agent and session (`apps/agent/src/lib.rs:594-597`); host test `cli.rs:72`. | Client runtime. |
| Valid approval rows take priority | implemented | implemented | Approvals render above the board (`AgentPanel.tsx:162-164,199`). Mocked `agent-board-locales.spec.ts:25-30`. | Claude only; separate panel. |
| Archive | missing | missing | No archive or dismiss action. | — |
| Age-out | implemented | implemented | Seven-day retention, 100-row cap (`apps/agent/src/lib.rs:61,615-633`); host tests `cli.rs:172,202`. | Not configurable; no client runtime test. |
| Optional display keep-awake | verified | verified | `apps/client/src/KeepAwakeControl.tsx:9-12` (default off); `src-tauri/keep_awake.rs:67-126`. NWT:1420-1605 and `NativeKeepAwakeTest.kt:11` (NAR); `packages/display-idle/src/portal/tests/real_frontend.rs:336` (NL); `display-idle/src/desktop/platform.rs:170` (ND, Windows). | Desktop GUI-to-native path is mocked (`keep-awake.spec.ts:43`); physical idle acceptance (#81). |
| Release when hidden or backgrounded | verified | implemented | NWT:1574-1595 (NAR). Desktop focus gate `display-idle/src/lib.rs:17-27`; mocked `keep-awake.spec.ts:67,87`. | Desktop native focus-loss case. |

## Usage and context

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Provider and account rate-limit windows | implemented | verified | `src-tauri/account_usage.rs:37-75`; `apps/client/src/AccountUsage.tsx:22-30`. `ssh/tests/account_usage_fixture.rs:76-113` via `ssh.rs:5820` (NL); collectors in ND. Android only mocked (`e2e/account-usage.spec.ts:3`, phone). | Android runtime case. |
| Freshness timestamps | implemented | implemented | `apps/client/src/accountUsageReport.ts:28-31`; `UsagePanel.tsx:75-81`. `packages/account-usage/tests/report.rs:109`. | Rendered timestamp on a native runtime. |
| Manual refresh | implemented | implemented | `AccountUsage.tsx:15`; `UsagePanel.tsx:116`. | No runtime test. |
| Optional background collection | partial | partial | Polls every five minutes only while visible (`apps/client/src/useAccountUsage.ts:4,37`); no host background collector. | Opt-in background collection (#18). |
| Transcript-supported context remaining | partial | partial | Codex last-response tokens only (`UsagePanel.tsx:50-52`); remaining is always Unknown (`:133`). | Other agents and a computed remaining value (#18). |
| Missing data stays unknown | implemented | implemented | `UsagePanel.tsx:83`; host tests `apps/agent/tests/usage.rs:42`. | Client runtime. |

## Native chat

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Messages over the existing transcript | verified | verified | `ChatPanel.tsx:496-540`. Claude NWT:2248 (NAR); ssh.spec:403-404 (NL). | Codex/OpenCode on desktop CI; Android recorded case red (#934). |
| Markdown and code | implemented | implemented | react-markdown with links and images neutered (`ChatPanel.tsx:507-516`). | No e2e asserts formatting; no syntax highlighting. |
| Images | implemented | implemented | Opt-in images for Claude, Codex and Grok (`ChatPanel.tsx:159,527`; `apps/agent/src/transcript.rs:396-421`). Mocked `e2e/claude-inline-images.spec.ts:35`, `codex-inline-images.spec.ts:65`, `grok-inline-images.spec.ts:21`. | `ssh.rs:5806` (recorded images over OpenSSH) is ignored. |
| Thinking | implemented | implemented | Collapsed details (`ChatPanel.tsx:518-520`). Vitest `ChatPanel.test.tsx:319`. | Any e2e or runtime test. |
| Tool cards and results | verified | verified | `ChatPanel.tsx:518-523`. `e2e/claude-tool-error.spec.ts:4`, `grok-tool-status.spec.ts:4` (PW, rendering). | Real companion tool payloads. |
| Plans and questions | partial | partial | Grok plans as text (`apps/agent/src/transcript/grok_acp.rs:80,209`); OpenCode questions only as lifecycle state (`hooks.rs:277`). | Plan and question cards. |
| Working and stop state | partial | partial | Stop sends Escape (`src-tauri/tmux_chat.rs:198`; `ChatTerminalInput.tsx:202`), byte-checked NWT:2265-2267 and ssh.spec:446-447. | No working indicator in Chat. |
| Editable composer | verified | verified | `ChatPanel.tsx:561-571`. NWT:3117-3162 (NAR); ssh.spec:405-445 (NL). | — |
| Prompt returns to the same live Herdr session | verified | verified | `ChatTerminalInput.tsx:140-190`. NWT:2483,2485,2254-2264 ownedGuardedHerdrChat and ownedMoshDefaultHerdrChat (NAR; the Mosh case is flaky); ssh.spec:387-451, HGF:241 (NL). | Windows. |
| Prompt returns to the same live tmux session | implemented | verified | `tmux_chat.rs:59-201`; `App.tsx:2231`. TJF:2159 real_tmux_chat_original_display… and TJF:1092 (NL). | Android tmux Chat input; Zellij has no Chat input. |
| Unsupported interactions direct to the terminal | verified | verified | Placeholders (`transcript.rs:399`, `ChatPanel.tsx:525`), Open terminal and Stage (`:564`). NWT:3160-3162 (NAR); `codex-inline-images.spec.ts:81` (PW). | — |

## Agent coverage

The chat UI is shared web code; transcripts are read by the companion over SSH. A chat-view cell is `verified` only when a real-runtime CI case reads that agent's transcript on that platform. Format fixtures run in the `agent` job and are host evidence only.

| Agent (reference tier) | Transcript adapter | Lifecycle hooks | Tests | Android | Desktop |
| --- | --- | --- | --- | --- | --- |
| Claude Code (Chat View) | `apps/agent/src/transcript.rs:529-559`; `transcript/conversation.rs:12` | `apps/agent/src/lib.rs:225-355` (managed) | Fixtures `apps/agent/tests/transcript.rs:52`; live records NWT:2243-2248 (NAR), ssh.spec:399-404 (NL) | verified | verified |
| Codex (Chat View) | `transcript.rs:560-614`; `codex_conversation.rs:276` | `hooks.rs:14` (managed) | Fixtures `conversation.rs:294-752`; NWT ownedRecordedConversationsThroughRealUi is red (#934); ssh.spec:116 skipped | implemented | implemented |
| OpenCode (Chat View) | `transcript/database.rs:46`; `opencode_conversation.rs:65` | `hooks.rs:91,264`, `hooks/opencode.js` (managed) | Fixtures `database_transcript.rs:95,206`; Android case red (#934); ssh.spec:163 skipped | implemented | implemented |
| Antigravity (Chat View) | `antigravity.rs:122` (explicit file only) | none | `antigravity_transcript.rs:26-285` | implemented | implemented |
| Kimi (Chat View) | `event_adapters.rs:82` | `lib.rs:225`, `hooks.rs:62` (manual) | `additional_adapters.rs:63`; `cli.rs:353,465` | implemented | implemented |
| Cursor (Chat View) | `cursor.rs:6` | `hooks.rs:95,117` (managed) | `cursor_transcript.rs:6-68`; `cli.rs:1033` | implemented | implemented |
| Grok Build (Chat View) | `grok_acp.rs:30`; `grok_conversation.rs:22` | none | `grok_acp_transcript.rs`, `grok_conversation.rs`; mocked `e2e/grok-*.spec.ts` | implemented | implemented |
| Pi (Chat View) | `transcript.rs:484-527` | none | `transcript.rs:134,171` | implemented | implemented |
| OMP (Chat View) | `transcript.rs:484`; `discovery.rs:54` | none | `transcript.rs:160,221` | implemented | implemented |
| Hermes (Chat View) | `database.rs:46` | none | `database_transcript.rs:31,79` | implemented | implemented |
| Qoder (Chat View) | `transcript.rs:529` (Claude-shaped) | none | `additional_adapters.rs:42` | implemented | implemented |
| Factory Droid (Chat View) | `droid.rs:6` | `hooks.rs:46` (managed) | `droid_transcript.rs:10-67`; `cli.rs:465` | implemented | implemented |
| GitHub Copilot (Chat View) | `event_adapters.rs:4` | `hooks.rs:75`, `lib.rs:235-257` (managed) | `additional_adapters.rs:10`; `cli.rs:384` | implemented | implemented |
| Amp (Chat View) | `amp_json.rs:5` (explicit export only) | `hooks.rs:113,164` (managed) | `amp_json_transcript.rs:10-93`; `cli.rs:1097` | implemented | implemented |
| Devin (Chat View) | `atif.rs:6` (ATIF export) | none | `atif_transcript.rs:25-278` | implemented | implemented |
| OmO (Chat View) | `transcript.rs:484` | none | `omo_transcript.rs:6,35` | implemented | implemented |
| jcode (Chat View) | `jcode.rs:31` | none | `additional_adapters.rs:125,163` | implemented | implemented |
| Gemini (agent-aware) | none (rejected, `tmux_chat.rs:863`) | `hooks.rs:31`, `lib.rs:262-305` (managed) | `cli.rs:465`; `hook_setup.rs:1347` | implemented | implemented |
| Qwen Code (agent-aware) | none | none; Herdr detection only (`packages/herdr-upstream/src/detect/manifests/qwen.toml`) | — | partial | partial |
| Other CLIs (terminal compatibility) | none | Cline `hooks.rs:185-221`; generic schema `lib.rs:209` | `cli.rs:1133,1241` | verified | verified |

Adapter paths are under `apps/agent/src/transcript/` and tests under `apps/agent/tests/` unless shown otherwise. Only Claude, Codex, OpenCode and Grok have a Conversation view and follow; the others are records-only with manual refresh. Terminal compatibility is verified by the generic SSH cases. Qwen lacks lifecycle hooks, so it is agent-aware only under Herdr.

## Remote approvals

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Allow or deny a pending request remotely | implemented | implemented | `apps/agent/src/approvals.rs:205-291,327-370`; `src-tauri/approvals.rs:6-84`; `apps/client/src/ApprovalPanel.tsx:99-127`. Host tests `apps/agent/tests/approvals.rs:106,152`; mocked client. | Claude only (`approvals.rs:19-21`); no client-runtime case. |
| Exact multiplexer pane targeting | partial | partial | Pane from `TMUX_PANE` only (`apps/agent/src/main.rs:288`), bound into the decision (`approvals.rs:357`). | Herdr and Zellij pane identity. |
| Re-validate the pending prompt before answering | implemented | implemented | Lease, hash, expiry and pane checks (`approvals.rs:317-360`); host tests `approvals.rs:237,308`. | Validates the hook request, not a fresh screen capture. |
| Answer at the host clears the remote request | implemented | implemented | Lease release and cleanup (`approvals.rs:76-95,196-203`); host test `approvals.rs:182`. | Client runtime. |
| Works across tmux, Herdr and Zellij | partial | partial | Not tied to a multiplexer, but Claude only and pane context only on tmux (`src-tauri/approvals.rs:41-47`). | Herdr/Zellij targeting; non-Claude agents. |

## Host settings

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Transcript discovery toggle | implemented | implemented | `apps/agent/src/settings.rs:26,50-53`; `main.rs:195-202`; `apps/client/src/CompanionSettingsPanel.tsx:56`. Host tests `apps/agent/tests/settings.rs:122`. | Client runtime. |
| Usage collection toggle | partial | partial | Gates only recorded counters (`main.rs:197`). | Quota reads ungated; no background collection (#18). |
| Nested-agent suppression | missing | missing | No code. | #18. |
| Unlocked-desktop notification suppression | missing | missing | No code in the relay or notification client. | #18. |
| HTTP port scanning toggle | partial | partial | Per-panel probe and automatic controls (`apps/client/src/PreviewPanel.tsx:161-163`), not persisted and not a host setting. | Persisted host setting (#18). |
| Simulator streaming toggle | partial | partial | One `deviceToolsEnabled` flag gates inventory, capture, streams and control (`settings.rs:28`). | Separate streaming toggle (#18). |
| Independent settings with documented restart semantics | implemented | implemented | Three checkboxes with revision checks (`CompanionSettingsPanel.tsx:39-61`); apply to new operations without restart. Host tests `settings.rs:35,64,97`. | Client runtime. |

## Dictation

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Whisper models: catalog download, import, local inference | implemented | implemented | `apps/client/src/VoicePanel.tsx:288-356,596-609`; `src-tauri/voice.rs:453-483`. Catalog tests use a fixture HTTP client; real inference `voice.rs:589-601` runs on Linux in `NLR` (`test:voice`). | First green `NLR` run on `main` verifies Linux; other platforms. |
| Parakeet local model | missing | partial | `src-tauri/voice/parakeet.rs:52-83` (Linux x86_64 only). `NLR` runs `test:parakeet-product` (install, warm reuse, removal). | Windows and Android support. |
| Apple SpeechAnalyzer | n/a | n/a | iOS-only (`packages/apple-speech/src/lib.rs:27`). | — |
| Optional metered cloud engine | implemented | implemented | `VoicePanel.tsx:469-477,699-705`; `src-tauri/voice/cloud.rs`. Fake HTTPS backend `voice/cloud/tests.rs:566,589` (NL); Android IPC reaches validation only (NWT:4285). | Client against the real transcription service (#345). |
| Language selection | implemented | implemented | `VoicePanel.tsx:662-687,702-704`; `voice.rs:354`. Mocked `e2e/voice-locales.spec.ts:8`. | Native non-English inference. |
| Editable draft mode | verified | verified | `VoicePanel.tsx:417-420,777-785`. `e2e/voice-composition.spec.ts:4,26` (PW). | — |
| Optional auto-send | implemented | implemented | `VoicePanel.tsx:422-430,746-753`; `voiceDelivery.ts`. Mocked `e2e/direct-dictation.spec.ts:5,38`. | Dictated text plus Enter reaching a real PTY. |
| Transcription history | verified | verified | `apps/client/src/voiceHistory.ts`, `VoiceHistoryPanel.tsx`. `e2e/voice-history.spec.ts:59,112` (PW). | — |
| Model removal | implemented | implemented | `voice.rs:332-344`; `VoicePanel.tsx:652-661,696`. Unit tests only. | Native removal check. |

## Attachments

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| File source (any type, 10 MiB cap) | implemented | implemented | `apps/client/src/AttachmentPanel.tsx:184`; `attachment.ts:2-10`; `src-tauri/attachment_upload.rs:15`. Linux GUI case ssh.spec:652 is red (#935). | Android file chooser; green Linux case. |
| Camera and photo source | implemented | partial | `AttachmentPanel.tsx:185` (`capture="environment"`); Android `CAMERA` permission. Desktop gets an image file chooser only. | Device camera case; no desktop live capture. |
| Clipboard image source | verified | implemented | `src-tauri/clipboard.rs:195-205`. NWT:2492-2547 (PNG and JPEG staged, oversize rejected; NAR). Desktop `deviceClipboard.ts:110-117` uses `navigator.clipboard.read`; native returns unsupported (`clipboard.rs:207`). | WebKitGTK and WebView2 clipboard image case. |
| SSH copy to the host (SFTP, no overwrite) | verified | implemented | NWT:2550-2623 ownedMoshUploadsLargeClipboardImageThroughRealUi (large PNG, existing destination kept; NAR). Linux ssh.spec:626-680 is red on every recent `main` run (#935, #512); macOS `ssh.rs:5794` (ND) passes. | Green Linux case; Windows. |
| Paste a host-local path into the terminal | implemented | implemented | `AttachmentPanel.tsx:180`; `App.tsx:1264-1272`; `attachmentPaste.ts:8-15`. Mocked `e2e/attachment-terminal-paste.spec.ts:11`. | PTY receipt of the pasted path. |
| Attach to an editable prompt or Chat draft | verified | verified | `AttachmentPanel.tsx:182`; `ChatPanel.tsx:554`. `e2e/attachment-locales.spec.ts:7`, `chat-attachments.spec.ts:5` (PW). | — |
| Optional host clipboard handoff (Mac host) | implemented | implemented | `src-tauri/host_clipboard.rs:13`; `AttachmentPanel.tsx:182`. Only `ssh.rs:5794` on a macOS client (ND). | Android, Linux and Windows clients against a Mac host. |
| Crop and annotate images | verified | verified | `AttachmentPanel.tsx:153-160,194-201`; `attachment.ts` `validateCrop`. `attachment-locales.spec.ts:7` (PW); editor canvas on device NWT:2521-2523. | — |

## Shareable uploads

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Optional HTTPS upload service with expiring URLs | implemented | verified | `apps/client/src/SharePanel.tsx:215-219,387`; `src-tauri/lib.rs:163-173`. Real share-service over TLS `src-tauri/share/tests.rs:278` (NL). | Android runtime case. |
| Upload history and delete | implemented | verified | `SharePanel.tsx:181-190,290`; `share/tests.rs:278` (NL). | Android runtime case. |
| Thumbnails | implemented | implemented | `SharePanel.tsx:302-315,435-436`; fake server `share/tests.rs:416,521`. | Real service thumbnail fetch. |
| Expiry-aware copy and delete | verified | verified | `SharePanel.tsx:302,433-447`. `e2e/share-locales.spec.ts:6` (PW). | Expired state is Vitest-only. |
| Separate from private host-local transfer | implemented | implemented | Separate Share dialog (`App.tsx:2507`) and per-session Attach (`:2237`); separate native stacks. | — |

## Diff review and files

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Staged, unstaged and untracked changes | implemented | implemented | `apps/client/src/RepositoryPanel.tsx:258-264`; `src-tauri/repository.rs:260-281`. Real local Git `repository.rs:488`; staged and unstaged diff over real OpenSSH in `test:openssh` (`NLR`). Untracked files are not covered over SSH. | Untracked status over SSH; green `NLR` on `main`. |
| Per-file side-by-side highlighted hunks | partial | partial | Side-by-side table `RepositoryPanel.tsx:87-89,274`; `e2e/repository-annotations.spec.ts:6-12`. | Diff rows are not syntax-highlighted. |
| Binary-file listing | implemented | implemented | `RepositoryPanel.tsx:269,274`; `repository.rs:363`. | UI test for binary entries. |
| Remembered file | implemented | implemented | sessionStorage `lazysh-review:{session}` (`RepositoryPanel.tsx:149,192`). Vitest only. | Reload test. |
| Working tree and historical commits | implemented | implemented | `RepositoryPanel.tsx:145,239-250`; `repository.rs:295,325,386`. Mocked `e2e/file-review-locales.spec.ts:11`. | Native history and tree browsing over SSH. |
| Line comments included in the next prompt | verified | verified | `RepositoryPanel.tsx:207-233,276` posts a prompt draft consumed at TP:267. `repository-annotations.spec.ts:6-34`, `file-review-locales.spec.ts:43-46` (PW). | Source files are mocked. |
| CLI entry point | missing | missing | No review subcommand in `apps/agent/src/main.rs:194-330`. | — |
| Files: browse and code view | implemented | implemented | `apps/client/src/SessionTools.tsx:28-250`; `CodePreview.tsx:10-28`. Mocked `file-review-locales.spec.ts:11-35`. Remote listing and reads over real OpenSSH in `test:openssh` (`NLR`). | First green `NLR` run on `main` makes desktop `verified`. |
| Markdown viewing | implemented | implemented | `RepositoryPanel.tsx:6,270-272`. Vitest only. | Any e2e. |
| Media viewing | partial | partial | Images up to 2 MB in repository review only (`RepositoryPanel.tsx:71-77,176-178,268`); Files is text only. | Media in Files; video, audio and PDF. |

## Browser previews

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Discover HTTP listeners (process, port, interface) | implemented | implemented | `src-tauri/previews.rs:318-349,390-435`; `PreviewPanel.tsx:112-121,169`. Parse tests `previews.rs:712,722`; mocked `e2e/preview-periodic.spec.ts:5`. | Real discovery over SSH in CI. |
| Optional port or range allowlist | implemented | implemented | `PreviewPanel.tsx:14-30,63,113,161`; `previews.rs:394-416`. | Allowlist persistence test. |
| Confirm selection before forwarding | implemented | implemented | Explicit Open after selecting (`PreviewPanel.tsx:100,169`). | — |
| Forward over SSH to device loopback, same port or unused fallback | implemented | implemented | `previews.rs:48-99` (port 0 fallback at `:88-90`). Verified only on the macOS runner (`ssh.rs:6897-6916` in `ssh.rs:5794`, ND). | Linux, Windows and Android runtime cases. |
| Tear down forwards when the session closes | implemented | implemented | `ssh.rs:6950-6960`, macOS runner only. | Same as above. |
| Element comments included in the next prompt | partial | partial | Opt-in picker proxy `src-tauri/previews/proxy.rs`, `apps/client/src/previewAnnotations.ts`; `e2e/previews.spec.ts:8,39`, `preview-locales.spec.ts:49-53` with a picker fixture. | Selector, bounds and note only; no visual annotation (#11). |

## Simulator previews

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Inventory of host simulators, emulators and devices | implemented | implemented | `apps/agent/src/devices.rs:362-363,476-483`; client `apps/client/src/DevicePanel.tsx`. Host-side real emulator inventory and screenshot `apps/agent/src/devices/tests.rs:360` (NAA). Mocked `e2e/device-locales.spec.ts:6`. | Client-side runtime case; iOS simulator on a Mac host. |
| Video streaming | partial | partial | iOS `devices/idb.rs:331`; Android screenrecord is view-only (`devices/android.rs:1,139`). | Android touch on video; CI video test (#19). |
| Touch and button control | partial | partial | `DevicePanel.tsx:233-235,451-460,526-532`; `devices.rs:570-650`. Android control through screenshots only. | Real-device control test (#19). |
| Boot, reboot and shutdown | implemented | implemented | `DevicePanel.tsx:462-474,555-558`; `devices.rs:102-118,598-684`. | Real lifecycle test (#19). |
| Agent accessibility actions | missing | missing | No accessibility tree or actions. | #19. |

## Notifications

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Push registration, enrollment and pause | verified | missing | `apps/client/src/PushSettingsPanel.tsx`. NWT:3844-4247 and `tests/android-ntfy.test.ts:613` (real ntfy, NANT); NWT:4248, `UnifiedPushEnrollmentTest.kt:26,53` (NAA). Desktop provider is `none` (`packages/push-registration/src/lib.rs:52-56`). | FCM registration test; desktop remote push. NANT fdroid is currently red (#945, #879). |
| Local test notification, permission and pause | implemented | implemented | `src-tauri/notifications.rs:63-81`; `apps/client/src/NotificationPanel.tsx:85-97`. | OS notification test. |
| Custom webhook alerts | implemented | implemented | `apps/notification-service/src/lib.rs:33-110`; tests `src/tests.rs:1356` (`agent`). | Host service; no client UI. |
| Normalized agent-event inbox | implemented | implemented | `apps/client/src/notificationStore.ts:6,56`; polling `NotificationPanel.tsx:9-54`. Vitest only. | e2e or native inbox test. |
| Notification actions | implemented | partial | `NotificationPanel.tsx:56-62`; `notifications.rs:51-56`. Remote ntfy notification asserted to have no actions (NWT:4213). | Desktop action support; action test. |
| Cross-device delivery | verified | missing | Background remote event shown privately NWT:4190-4220 (NANT). Desktop has foreground polling only. | Desktop remote delivery. |
| tmux and Herdr active-session deep links | partial | partial | Opens the source session's Agents board (`App.tsx:1638-1657`); stored `paneId` unused (`notificationStore.ts:79-82`). | Pane-level navigation and a test (#14). |
| iOS ActivityKit lifecycle | n/a | n/a | iOS-only. | — |

## Apple surfaces

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Live Activities, Dynamic Island, watchOS | n/a | n/a | iOS/watchOS only on the reference client (`packages/apple-status/src/lib.rs:3,165-251`). The Android connection foreground notification (`SessionForegroundService.kt:33-36`) is not an agent-status equivalent. | — |

## Desktop

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| Local host terminal | n/a | verified | Desktop-only (`src-tauri/local.rs:16-30`); `App.tsx:1455-1458,1937`. `native-e2e/singleton.spec.ts:38-53` (NL); `test:local` `local.rs:1314-1450` (ND, macOS and Windows). | Android: desktop surface on the reference client too. |
| Remote hosts | verified | verified | ssh.spec:21 (NL); NWT:2480 (NAR). | Windows GUI (#492). |
| Session and Chat switching | verified | verified | `App.tsx:2425`. ssh.spec:511-529; NWT:2341-2356; `e2e/session-layout.spec.ts:45-60`. | — |
| Workspace and agent sidebar | verified | verified | `App.tsx:2011-2030`. ssh.spec:478-497; NWT:1505-1511,2358-2359. | — |
| Command palette | partial | partial | `App.tsx:2354-2400` launches hosts and local terminals only. `preferences.spec.ts:143-148`. | Command actions. |
| Files with code, Markdown and media viewing | partial | partial | See Diff review and files. | Media viewing and real remote reads. |
| Forwarded previews | implemented | implemented | See Browser previews. | Linux/Windows runtime case. |
| Line and element comments in the next prompt | partial | partial | Line comments verified (PW); element comments partial (#11). | Visual element annotation. |
| Terminal ownership stays on the host | implemented | verified | Detach hint MP:166. TJF:2569 fresh SSH restores the same durable pane (`test:tmux`); TJF:1474 and HGF:158 survive bootstrap closure (NL). | Android reattach case. |

## Desktop launch interface

| Sub-behavior | Android | Desktop | Evidence | Missing / what would verify |
| --- | --- | --- | --- | --- |
| `-dir` opens a local terminal in a directory | n/a | verified | `src-tauri/desktop_launch.rs:55-145` (desktop-only). `singleton.spec.ts:38-53` real shell `pwd` (NL); `desktop_launch.rs:685-721` (ND); `local.rs:1314-1369`. | Windows warm GUI delivery (#457). |
| `-host` selects a saved host | n/a | verified | `desktop_launch.rs:102-110,360-447`. `singleton.spec.ts:13-30` (NL). | — |
| `-mux tmux`, `tmux:SERVER` or `herdr` | n/a | partial | `desktop_launch.rs:35-51,111-130`; MP:30-37,56-57,124,135. `singleton.spec.ts:32-35` checks admission and the notice only; the post-connect picker is Vitest-only. | GUI case through connect, requested picker and attach (#86). |

## Gaps

Every row that is not `verified` on Android or desktop, grouped and ordered by user impact: terminal, input, connections, multiplexers, agents and Chat first. `n/a` rows are excluded. "A" and "D" give the Android and desktop statuses. An issue number marks the record that owns the gap; new issues opened by this audit are marked *(new)*.

| # | Gap | A / D | Issue |
| --- | --- | --- | --- |
| 1 | Terminal history: scrollback bound, new output while scrolled up, tmux copy-mode search and copy, real OS clipboard on copy | implemented / implemented | #981 *(new)* |
| 2 | Desktop IME, CJK cell width and Chat IME: real WebKitGTK input method; CJK alignment rendering; device IME in Chat | verified-terminal, implemented-Chat / implemented | #982 *(new)* |
| 3 | Touch gestures and toolbar: pinch pane zoom, header pull depths, long-press alternate actions, level-aware defaults, touch toolbar auto-hide, executed double-tap, swipe and pinch tests, toolbar reorder, snippets and session shortcut tests | missing to implemented / missing to implemented | #983 *(new)* |
| 4 | Clipboard and links: Android long-press selection, tmux OSC 52 passthrough, native URL-open and OSC 52 clipboard checks, desktop toolbar Paste | missing to implemented / missing to implemented | #984 *(new)* |
| 5 | SSH authentication, routing and transports: password, encrypted key, rotated host key, bastion, agent forwarding, Auto fallback and ET on native runtimes; Android Mosh range and path | implemented / implemented | #985 *(new)*; umbrella #8 |
| 6 | Key management and fingerprint custody: file import, UI-level public-key rejection, native generate, fingerprint and export checks, fingerprints outside the keystore | missing to partial / missing to partial | #986 *(new)*; umbrella #9 |
| 7 | Biometrics and credential lifecycle: enrolled-biometric unlock, resume lock and private-key export on Android; Linux and Windows biometric support; delete-host keystore check; Windows keyring | implemented / missing | #987 *(new)*; umbrella #9 |
| 8 | Session restore and client environment: native restart, restore and reattach for tmux and Herdr; optional client environment flag | implemented, missing / implemented, missing | #988 *(new)*; umbrella #7 |
| 9 | Windows native GUI: SSH terminal, Mosh absence, saved hosts and every Linux-only `verified` desktop row | — / implemented | #492, #457 |
| 10 | Real multiplexer lifecycle in CI: tmux window actions and zoom, Herdr create, rename and zoom, Zellij detect, attach, tabs and actions; Android tmux attach, Jump and Chat input | implemented / partial to implemented | #989 *(new)*; umbrella #7 |
| 11 | Herdr navigation: live non-unknown agent state, current marker, list, accordion and grid layouts, desktop tab and pane focus and exact-pane context | partial / partial to implemented | #990 *(new)*; related #591, #634 |
| 12 | Desktop launch `-mux` end-to-end | n/a / partial | #86 |
| 13 | Agent board: project and host grouping, archive, real-event rendering on native runtimes | partial to missing / partial to missing | #991 *(new)* |
| 14 | Native Chat: Markdown, thinking, plans, questions and working indicator; image transport; follow polling; Android recorded Codex and OpenCode case (red); Linux Codex and OpenCode cases skipped in CI | partial to implemented / partial to implemented | #992 *(new)*; #934, #927, #923; umbrella #5 |
| 15 | Agent coverage beyond Claude: live transcript acceptance for the other 16 Chat View agents; Qwen lifecycle reporting | implemented / implemented | #5 |
| 16 | Remote approvals: non-Claude agents, Herdr and Zellij pane targeting, client-runtime case | partial / partial | #6 |
| 17 | Usage, context and host settings: background collection, context remaining, nested-agent and unlocked-desktop suppression, persisted port-scan and streaming toggles; Android usage runtime case | partial / partial | #18 |
| 18 | Companion hooks: real lifecycle event into the board, managed setup round trip from the client, macOS managed setup | implemented / implemented | #603 |
| 19 | Desktop workspace: command palette actions, media viewing in Files, Markdown and Files over real SSH | partial / partial | #993 *(new)* |
| 20 | OpenSSH Files, previews and diff over real SSH on Linux, Windows and Android (`test:openssh` not in CI): SFTP read and upload, listener discovery, forwarding, teardown, Git status and history | implemented / implemented | #994 *(new)*; umbrella #10, #11 |
| 21 | Attachments: green Linux upload-recovery case, Android file chooser, desktop camera and clipboard images, host clipboard handoff from non-macOS clients, PTY receipt of pasted paths | implemented / implemented to partial | #935, #512; umbrella #12 |
| 22 | Diff review: syntax-highlighted hunks, CLI entry point, binary and remembered-file tests | partial to missing / partial to missing | #10 |
| 23 | Element annotations in previews | partial / partial | #11 |
| 24 | Dictation: real Whisper inference in CI, Parakeet on Android and Windows, cloud provider against the real service, native auto-send, model removal | missing to implemented / partial to implemented | #13, #345 |
| 25 | Shareable uploads: Android runtime case, real-service thumbnails | implemented / implemented | #12 |
| 26 | Appearance: Android clipboard theme import, Android app icon selection, desktop QR and deep-link dispatch, font-download success path, cursor rendering test | partial to missing / implemented to missing | #995 *(new)*; umbrella #16 |
| 27 | Notifications: desktop remote push and delivery, inbox and action tests, pane-level deep links, FCM registration test, red F-Droid ntfy job | implemented to partial / missing to partial | #14, #344, #945, #879 |
| 28 | Keep-awake: desktop GUI path and focus-loss release, physical idle acceptance | verified / implemented | #81 |
| 29 | Simulator previews: Android video touch, real control and lifecycle tests, accessibility actions | partial to missing / partial to missing | #19 |
| 30 | UI locale on macOS native | verified / verified (Linux) | #79 |

Accessibility, performance and release-size gates from the evidence catalog are outside this matrix and stay with #20.
