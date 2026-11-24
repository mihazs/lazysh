# Android native engine: Waydroid full-functionality run

Status: **the run is built (`NativeAcceptanceTest`) and has not produced a recorded result yet.** The Waydroid guest's WebView renderer was not starting when the first run was attempted (every app with a WebView stayed on its splash; see [Runs](#runs)), so every case below is "not yet run". No case is marked pass here without a record on `main`. Tracking: [#2519](https://github.com/mihazs/lazysh/issues/2519), part of [#2093](https://github.com/mihazs/lazysh/issues/2093). Related: [Waydroid lane](waydroid-lane.md) · [migration plan](terminal-migration-plan.md) · [native input](android-native-input.md) · [benchmarks](terminal-benchmarks.md).

The question it answers: on the Android environment the project accepts instead of a phone, does the native terminal engine do what a daily user does with a terminal, with the guest's own keyboard and a finger? It is one instrumentation class, `app.lazysh.client.NativeAcceptanceTest`, run by the [lane](waydroid-lane.md) (which holds the guest lock, installs the debug APK of a CI run, starts the owned SSH fixture, and keeps the class's evidence beside its own):

```sh
gh run download <checks run on main> -n lazysh-android-debug-x86_64 -D /tmp/apks
WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/1000 apps/client/bench/waydroid-lane.sh \
  --out docs/architecture/benchmarks/terminal-lane-native-acceptance-waydroid.json --label native-acceptance --owned-ssh-fixture \
  --uninstall app.lazysh.client.test --uninstall app.lazysh.client \
  --apk /tmp/apks/universal/debug/app-universal-debug.apk --apk /tmp/apks/androidTest/universal/debug/app-universal-debug-androidTest.apk \
  --instrument app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner app.lazysh.client.NativeAcceptanceTest
```

The class works through one native session of the real app: it chooses Native in Settings, connects to the owned OpenSSH of this host, and runs the cases in order; a case that fails is recorded and the next one runs. Fingers are `UiDevice` taps and swipes on screen coordinates read from the page and the surface, the keyboard is the guest's AOSP LatinIME (its keys are tapped), and the observations are the core's text, `PixelCopy` of the surface, the clipboard and the logcat. The result is `native-acceptance.json` (run id, device, the native probe's answer including the adapter, and one entry per case with `pass`, `fail` or `not-testable`, its priority when failing, what it observed and why it failed), copied beside the lane's evidence.

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
| `toolbar-keys-cat-v` | Esc, Tab, sticky Ctrl and Alt, Up | `cat -v` echoes (`^[`, `^I`, `^X`, `^[x`, `^[[A`) |
| `composer-and-page-fields-take-input` | Types into the composer while the session is placed | the composer's value |
| `scroll-history-by-touch` | Scrolls the history with a finger | the core's viewport |
| `selection-and-copy` | Long-presses a word; handles and Copy | the clipboard |
| `paste-from-toolbar` | Pastes | the command line |
| `link-tap` | Taps a printed URL | the logcat of the intent |
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

A case fails the run, and each failure becomes an issue (P0 for anything a daily user hits) before the case can be called anything else; a case turns into a regression test by staying in this class, which the lane re-runs.
