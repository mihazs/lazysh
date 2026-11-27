# Android native engine: Waydroid full-functionality run

Status: **the owned Android emulator passed 20 runnable cases.** The current Waydroid guest has no reachable ADB endpoint, so it cannot start the lane. An earlier attempt reached the guest and encountered a sandboxed WebView renderer startup failure ([#2552](https://github.com/mihazs/lazysh/issues/2552)). See [Runs](#runs) for the scope of both results. Tracking: [#2519](https://github.com/mihazs/lazysh/issues/2519), part of [#2093](https://github.com/mihazs/lazysh/issues/2093). Related: [Waydroid lane](waydroid-lane.md) · [migration plan](terminal-migration-plan.md) · [native input](android-native-input.md) · [benchmarks](terminal-benchmarks.md).

The question it answers: on the Android environment the project accepts instead of a phone, does the native terminal engine do what a daily user does with a terminal, with the guest's own keyboard and a finger? It is one instrumentation class, `app.lazysh.client.NativeAcceptanceTest`, run by the [lane](waydroid-lane.md) (which holds the guest lock, installs the debug APK of a CI run, starts the owned SSH fixture, and keeps the class's evidence beside its own):

```sh
gh run download <checks run on main> -n lazysh-android-debug-x86_64 -D /tmp/apks
WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/1000 apps/client/bench/waydroid-lane.sh \
  --out docs/architecture/benchmarks/terminal-lane-native-acceptance-waydroid.json --label native-acceptance --owned-ssh-fixture \
  --uninstall app.lazysh.client.test --uninstall app.lazysh.client \
  --apk /tmp/apks/universal/debug/app-universal-debug.apk --apk /tmp/apks/androidTest/universal/debug/app-universal-debug-androidTest.apk \
  --instrument app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner app.lazysh.client.NativeAcceptanceTest
```

The class works through one native session of the real app: it chooses Native in Settings, connects to the owned OpenSSH of this host, and runs the cases in order; a case that fails is recorded and the next one runs. Fingers are `UiDevice` taps and swipes on screen coordinates read from the page and the surface, the test taps the guest's installed software keyboard, and the observations are the core's text, `PixelCopy` of the surface, the clipboard and the logcat. The result is `native-acceptance.json` (run id, device, the native probe's answer including the adapter, and one entry per case with `pass`, `fail` or `not-testable`, its priority when failing, what it observed and why it failed), copied beside the lane's evidence.

For a supplemental run on an owned Android emulator with SwiftShader, set the instrumentation argument `lazyshSoftwareGpu=true` using the debug build. The report includes the adapter returned by the native probe.

## The cases

| Id | What a user does | Observed through |
| --- | --- | --- |
| `engine-choice-native` | Settings, Terminal engine: Native is offered and chosen | the radio button |
| `native-session-connects` | Connects to the owned host; a native pane replaces the xterm.js one | the page's pane and the placed session |
| `status-bar-names-native` | The bottom bar names the engine | the footer text |
| `prompt-drawn` | The prompt is on screen | the core's text and the surface's pixels |
| `soft-keyboard-opens-on-tap` | Taps the terminal and the soft keyboard opens | the window insets |
| `type-with-the-guest-keyboard` | Types with the guest's keyboard | the core's text after tapping LatinIME keys |
| `enter-backspace-arrows` | Edits the command line with Enter, Backspace, Left | the command's output |
| `toolbar-keys-cat-v` | Esc, Tab, sticky Ctrl and Alt, Up | `cat -vT` prints (`^[`, `^I`, `^X`, `^[x`, `^[[A`) |
| `composer-and-page-fields-take-input` | Types into the composer while the session is placed | the composer's value |
| `scroll-history-by-touch` | Scrolls the history with a finger | the core's viewport |
| `selection-and-copy` | Long-presses a word and taps Copy | both selection handles and the exact clipboard text |
| `paste-from-toolbar` | Pastes | the command line |
| `link-tap` | Taps a printed URL | the link prompt shows the URL and offers Open in browser |
| `osc52-clipboard-consent` | Runs a remote OSC 52 write and taps Allow | the prompt previews the payload and the Android clipboard receives it after consent |
| `pinch-zoom` | Pinches | the remote pty's size |
| `big-output-without-loss` | Prints 200,000 lines | the retained history is consecutive and ends at 200000 |
| `vim-with-mouse-mode` | Scrolls vim with mouse mode on | vim's first row |
| `stop-and-start` | Leaves the app and comes back | the surface generation and its pixels |
| `rotation-and-resize` | Rotates, resizes the window | the remote pty's size |
| `tmux-status-line-and-splits` | Runs tmux with a split | the core's text |

Not testable on Waydroid, and recorded as such in every run: **Mosh session and resize** (the owned fixture is reached over `adb reverse`, which is TCP; Mosh needs a UDP route from the guest to the host), **kill switch** (a release-build switch; the debug APK has none; covered by Vitest and the `e2e-kill-switch` project), and the accepted risks: **Gboard and SwiftKey**, **battery and thermal**, **a phone GPU and the arm64 build**.

## Runs

| Run | Commit | APK | Result |
| --- | --- | --- | --- |
| first attempt, 2026-11-24 | main `d265826e` (CI run of the debug APK) | `lazysh-android-debug-x86_64` | **not run**: the guest's WebView renderer processes failed to attach (`Process ...sandboxed_process0... failed to attach`, `start timeout`, every app with a WebView stays on its splash), so no case started |
| owned API 36 emulator, 2026-11-24 | test APK `d2f09de1`, [#2495](https://github.com/mihazs/lazysh/pull/2495) app and [#2551](https://github.com/mihazs/lazysh/pull/2551) CSS | x86_64 debug, SwiftShader and Gboard, CSS applied to the debug WebView | **20 passed**, five outside the run’s scope. The remote PTY reported 23×32 in portrait, 4×42 in landscape and 82×78 after resizing. The private tmux server drew its status line and pane border. |
| packaged APK, owned API 36 emulator, 2026-11-24 | [#2495](https://github.com/mihazs/lazysh/pull/2495) app with [#2551](https://github.com/mihazs/lazysh/pull/2551) CSS compiled in, test APK `a5db9df4` | x86_64 debug, SwiftShader and Gboard | **18 passed**, five outside scope. Rotation and resize reported 12×16 → 2×22 → 43×41. Tmux drew `[mux] 0:check*` and the pane border. Selection copied a different value in a later rerun, and URL tapping was intermittent. |
| packaged APK repeat, owned API 36 emulator, 2026-11-24 | same app APK, test APK `d7aab6c5` | x86_64 debug, SwiftShader and Gboard | **20 passed**, five outside scope. Touch scrolling moved the viewport from 174 to 171, Copy returned the selected word, and the URL prompt opened. The remote PTY grid changed 23×32 → 4×42 → 82×78. Tmux drew `[mux] 0:check*` and the split border. |
| packaged APK wraps regression, owned API 36 emulator, 2026-11-24 | same app APK, test APK `b2016086` | x86_64 debug, SwiftShader and Gboard | **20 passed in each of two runs**. The starting grids were 6×16 and 11×32. Copy and link taps found the expected physical cells in both runs. Five cases remained outside the run’s scope. |
| reconciled acceptance harness, owned API 36 emulator, 2026-11-24 | harness based on main `78bb17d7`, packaged app with #2556, #2566, #2561 and #2579 applied | x86_64 debug, SwiftShader and Gboard, 430×932 | **20 passed**, five outside scope. The wrapped edit command produced the separate output row `aXbc`. Selection, link prompt, clipboard consent, rotation and tmux passed. Waydroid WebView startup remains tracked in [#2552](https://github.com/mihazs/lazysh/issues/2552). |
| Clean main build, owned API 36 emulator, 2026-11-25 | app `ff40f241`, test APK `8887f4af` | x86_64 debug, SwiftShader and Google LatinIME | **20 passed**, five outside scope. JUnit completed in 77.195 s. The remote PTY reported 17×21 in portrait, 2×29 after rotation, and 8×14 after resize (rows × columns). Tmux drew its status line and split border. [Run details](https://github.com/mihazs/lazysh/issues/2519#issuecomment-7164195764). |
| Reconciled main replay, owned Android 16 emulator, 2026-11-26 | main `4e8524ba` with [#2684](https://github.com/mihazs/lazysh/pull/2684) and this harness | x86_64 debug, SwiftShader and AOSP LatinIME, 430×932. APK SHA-256 `393c4339cbf54a831b6a87965b5a249f422444e17a7eabacaf4c3e93e97b31f1` | **20 passed**, five outside scope. The composer accepted the keyboard’s auto-capitalized text and closed before the remaining native pane checks. The run covered scrolling, selection and paste, OSC 52, 200,000 output lines, vim, rotation and tmux. |

A case fails the run, and each failure becomes an issue (P0 for anything a daily user hits) before the case can be called anything else; a case turns into a regression test by staying in this class, which the lane re-runs.
