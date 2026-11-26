# Waydroid lane runbook

Status: **the harness exists and is tested against stub `waydroid` and `adb` executables; no journey is wired to it yet. One live-guest run is recorded, `benchmarks/terminal-lane-core-waydroid.json` (see [First live run](#first-live-run)).** The lane is the Android acceptance environment for the native terminal engine release ([decision of 2026-11-18](terminal-migration-plan.md#decision-of-2026-11-18-waydroid-is-the-android-acceptance-environment), [ADR 0001, Amendment 6](adr-0001-terminal-runtime.md#amendment-6-2026-11-18-waydroid-is-the-android-acceptance-environment)). This page covers the harness of [#2093](https://github.com/mihazs/lazysh/issues/2093); the journeys and the benchmarks that run inside it are separate slices. The harness moves no row of the [gate table](terminal-migration-plan.md#acceptance-gates-and-evidence): a row moves only when evidence written by a run of the lane is on `main`. Related: [benchmarks](terminal-benchmarks.md) · [Android instrumentation](../android-testing.md) · [mobile end-to-end suite](../../apps/client/mobile-e2e/README.md).

## What it does

`apps/client/bench/waydroid-lane.sh` runs one lane from one command:

1. Checks that it can run and refuses, with its own exit code and a message that names the missing piece, when it cannot (see [Exit codes](#exit-codes)). It never skips and never reports a partial environment as a pass.
2. Takes the shared lane lock, because the guest is one shared resource (see [The lock](#the-lock)).
3. Attaches to a running Waydroid session, or starts one without showing its UI (`waydroid session start`, no `show-full-ui`), and waits for the guest to finish booting over `adb`.
4. Records the environment: Waydroid image, Android version, GPU path, app revision and the guest's input methods.
5. Runs its steps in the order given: build or install APKs, run named instrumentation classes, run named benchmark commands.
6. Tears down: stops the app, closes an `adb` connection it opened, stops a session it started and releases the lock, also when a step fails or the run is interrupted.
7. Writes one evidence JSON in the [baseline format](terminal-benchmarks.md#result-schema) (schema 1) and exits non-zero if any step failed.

It does not change the guest's window size, density, navigation mode or input method: a step that needs a phone-shaped window or another overlay owns that and restores it (the Appium suite's `support/device.ts` does, for example).

## Prerequisites

| Need | Why | When missing |
| --- | --- | --- |
| `waydroid` with an initialised image and an active container (`systemctl is-active waydroid-container`) | the guest | exit 3 or 4. Starting the container needs root: `sudo systemctl start waydroid-container` |
| A Wayland compositor: `WAYLAND_DISPLAY` naming a socket in `XDG_RUNTIME_DIR`, such as the desktop session | `waydroid session start` draws into it. Needed only to start a session: a running one is attached to as it is | exit 5. A headless compositor (for example `weston --backend=headless`) started by the caller also works |
| `adb` on `PATH` (or `ADB=<path>`) and `jq` | the guest is driven and the evidence is written with them | exit 3 |
| The guest at `192.168.240.112:5555` | the address of the Waydroid guest on this machine; `LAZYSH_WAYDROID_SERIAL` or `ANDROID_SERIAL` chooses another | exit 7 after `LAZYSH_WAYDROID_BOOT_WAIT_S` seconds |

The harness never uses `sudo` and never tries to repair the container.

## Run it

```sh
# The x86_64 debug APK of the app and its instrumentation APK, then a named class and a benchmark command.
bun run build:android:emulator
apps/client/bench/waydroid-lane.sh \
  --out docs/architecture/benchmarks/terminal-lane-surface-waydroid.json --label surface \
  --apk apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk \
  --apk <instrumentation apk> \
  --instrument app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner app.lazysh.client.NativeTerminalSurfaceTest \
  --bench <name> '<a command that writes its result files into "$LAZYSH_LANE_OUT">'
```

| Argument | Meaning |
| --- | --- |
| `--out <file>` | The evidence file (required). Written even when a step failed, with `status` `failed`; never written when the lane could not start |
| `--label <text>` | A name for the run, recorded in the evidence |
| `--package <id>` | The app under test (default `app.lazysh.client`): stopped at the end, and its version read for the evidence |
| `--uninstall <package>` | Removes a package and its data before the installs that follow it (repeatable; a package that is not installed is no error). A debug APK of another CI run has another signature and does not update in place |
| `--apk <file>` | Installs the file with `adb install -r -t` (repeatable). The evidence records its SHA-256 |
| `--build <build.sh>` | Runs one of the build scripts that wrap `bench/android-apk.sh` (`bench/android-webview/build.sh`, `bench/android-canvas/build.sh`) with `ANDROID_HOME`, `JAVA_HOME`, a throwaway output path and, if set, `LAZYSH_WAYDROID_BUILD_ASSETS`, then installs the result |
| `--instrument <runner> <class>` | Runs `am instrument -w -r -e class <class> <runner>` (repeatable) and counts the status codes it prints |
| (every `--instrument`) | The lane gives the class `-e lazyshRunId <run id>`, clears `/data/local/tmp/lazysh-evidence` on the guest before it and, after it, pulls what the class left there (`app.lazysh.client.Evidence`: JSON and pictures) beside the evidence as `<evidence name>-<class>-<file>`, listed with their SHA-256 in the step's `files` |
| `--bench <name> <command>` | Runs a shell command (repeatable). It gets `LAZYSH_BENCH_ANDROID` (the serial, which `bun run bench:terminal` already honours), `LAZYSH_LANE_OUT` (a directory for its result files) and `LAZYSH_LANE_PACKAGE`. The files it leaves there are copied next to the evidence as `<evidence name>-<name>-<file>` and listed with their SHA-256; the command's exit status decides pass or fail, and a run with no result file fails |

Steps run in the order of the arguments. A failed install or build stops the run (the evidence says the rest did not run); a failed class or benchmark does not hide the ones after it.

### Prebuilt APKs from CI

The `native-android-terminal-core` job uploads the x86_64 debug APK with the terminal core and its instrumentation APK as the artifact `lazysh-android-debug-x86_64` (kept 7 days). Download it from a run and install both without a local Android build:

```sh
gh run download <run> -n lazysh-android-debug-x86_64 -D /tmp/lazysh-apks
apps/client/bench/waydroid-lane.sh --out <evidence.json> --label <name> \
  --apk /tmp/lazysh-apks/universal/debug/app-universal-debug.apk \
  --apk /tmp/lazysh-apks/androidTest/universal/debug/app-universal-debug-androidTest.apk \
  --instrument app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner app.lazysh.client.NativeTerminalCoreTest
```

### The program workloads on the lane

`apps/client/e2e/terminal-programs.spec.ts` replays W5 to W8 and W11 ([benchmarks](terminal-benchmarks.md#program-workloads-w5-to-w8-and-w11)) through xterm.js in the guest's Android System WebView when `LAZYSH_BENCH_ANDROID` is set, which the lane does for every `--bench` command:

```sh
apps/client/bench/waydroid-lane.sh --out docs/architecture/benchmarks/terminal-lane-programs-waydroid.json --label programs \
  --build apps/client/bench/android-webview/build.sh \
  --bench programs 'cd apps/client && LAZYSH_BENCH_OUT="$LAZYSH_LANE_OUT/programs.json" bun run bench:terminal -- e2e/terminal-programs.spec.ts --project=desktop'
```

The spec fails when the WebView host loses the window focus, so nothing else may use the guest during the run. **This command has not been run:** the session did not start on the day it was written (see [Known blockers](#known-blockers)). The same workloads run on the native core with `examples/program_workloads.rs`, which is a host binary: no run of the core inside the guest exists, so the lane cannot yet put the two engines side by side in one guest.

### The lane never skips

An instrumentation class fails the lane when it runs no test, when a test is ignored or ends on an assumption (`INSTRUMENTATION_STATUS_CODE` -3 or -4), when a test fails or errors (-1, -2), or when the instrumentation does not finish (a crash, or a runner or class that is not installed). A benchmark fails on a non-zero exit, and also when it exits zero but leaves no result file in `LAZYSH_LANE_OUT` (a Playwright spec that skipped itself measured nothing). A run that could not start produces no evidence at all, so a missing file is never mistaken for a pass.

### The engine comparison on the lane

`apps/client/bench/androidEngineBench.ts` is the xterm.js arm of the same-run comparison of the native engine with xterm.js ([G14, G15 and the idle half of G16](terminal-benchmarks.md#same-run-comparison-on-the-waydroid-lane-g14-g15-g16-idle)). It runs the baseline spec (W0 to W4, W9, W12) in the guest's WebView, reads the guest's own counters (CPU and thread wakeups of the app and its WebView renderer processes, SurfaceFlinger frames, PSS) and writes one `android-engine-comparison` record. The native engine's driver writes the same record into the same lane run; `androidCompare.ts` then sets them side by side and exits non-zero when native loses:

```sh
WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/1000 apps/client/bench/waydroid-lane.sh \
  --out docs/architecture/benchmarks/terminal-lane-engine-xterm-waydroid.json --label engine-xterm --package app.lazysh.webviewbench \
  --bench xterm 'cd apps/client && bun bench/androidEngineBench.ts --out "$LAZYSH_LANE_OUT/record.json" --label engine-xterm'
bun apps/client/bench/androidCompare.ts docs/architecture/benchmarks/terminal-lane-engine-xterm-waydroid-xterm-record.json   # one record per arm; they must share the run id
```

The lane passes `waitForActivitiesToComplete=false` to AndroidJUnitRunner, matching Gradle. Android closes the app after it receives the result, so Tao's last-Activity exit cannot interrupt the result handoff. Missing or failed instrumentation results still fail the lane.

The host app of the benchmark page (`bench/android-webview`, built by `--build` or already installed) must be in the guest; `--package app.lazysh.webviewbench` makes the lane thaw and stop that app instead of the real one. The lane gives the run an id (`runId` in its evidence, for example `engine-xterm-20261122T204011Z`: the label and the start time) and exports it to every `--bench` command as `LAZYSH_LANE_RUN_ID`; a record carries it, and the compare script refuses records of different runs or guests. The benchmark is heavy on the host: start it through `/tmp/lazysh-heavy` on this machine, and note that the guest shares the host CPU and GPU with whatever else runs (the record keeps the host's load average at the end).

The native idle driver exercises W0 through the real app and an owned OpenSSH server. After installing the native debug APK and its instrumentation APK, add this benchmark step to the same lane run as the xterm.js arm:

```sh
--bench native-idle 'cd apps/client && bun bench/androidNativeBench.ts "$LAZYSH_LANE_OUT/native-idle.json"'
```

Pass `--xterm-idle` in a second step of the same lane run to use the packaged
xterm SSH path with the same idle counter interval. The xterm test checks
that the terminal has focus and that the requested cursor mode is visible
before taking the samples. Both drivers check installed APK digests before
and after measurement.

The paired Android 15 x86_64 emulator qualification used one installed APK
set and an owned SSH shell for each engine. Each row is the median of three
30-second windows. The native run used the software GPU switch.

| Cursor | Metric | Packaged xterm | Native |
| --- | --- | ---: | ---: |
| Blinking | CPU ms/s | 57.94 | 9.99 |
| Blinking | Wakeups/s | 602.93 | 17.19 |
| Blinking | Presented frames/s | 2.63 | 1.86 |
| Steady | CPU ms/s | 4.33 | 0.33 |
| Steady | Wakeups/s | 71.50 | 1.07 |
| Steady | Presented frames/s | 0.00 | 0.00 |

The idle target passed for this emulator pair. The complete comparator
returned `incomplete` because it received only W0. This result qualifies
the harness for the Waydroid run.

It records three 30-second windows for each cursor mode. The host measures the app and its WebView processes while device instrumentation waits without touching the terminal. The record includes the renderer's adapter and the guest counters. The same driver accepts `--check-streams` to verify the final visible rows for the full W2–W4 streams over OpenSSH at the native session's actual grid, five times per workload. Write this to a separate output file. The resulting correctness record carries the grid, byte counts, fixture SHA-256 hashes, and presentation samples. The shell command and its echo settle before sampling. Each sample records the time from stream release request to submission of the exact parsed byte watermark, and the host closes the counter window before the viewport check. The shell holds the final screen until the viewport and surface checks finish, then returns the prompt. The diagnostic interval still includes the release handshake and watermark polling. The same driver accepts `--check-shell` for five full W1 runs with 300 separate short-output bursts per run. Each burst waits for its own presentation watermark, and each run verifies the same final viewport as xterm. Its latency includes host release, SSH and PTY delivery. Pass `--check-input` for five runs of each idle W12 variant through the native editor and owned SSH echo: 200 single keys, 150 key-downs with repeats paced at up to 30 Hz, and 50 IME composition commits. Each input waits for its own presentation watermark and each run checks the echoed viewport. Pass `--check-flood` to replay W2 chunks from the owned SSH PTY while timing 200 echoed keys per run. The host Python 3 fixture writes an exact echo byte offset and holds each echo until it can be measured. Each next input arrives during a new output window. Pass `--check-commit` to show the native keyboard and send the same 200 single-letter Android IME commits used by the packaged xterm benchmark, five times. The record carries the actual grid and the input SHA-256. Set `LAZYSH_BENCH_ROWS` to the packaged xterm record’s rendered row count when the native pane is taller. The test caps the Android pane through its normal layout and checks both the native grid and remote PTY size before timing. Each IME echo also records Android dispatch to its first display capture with new glyph ink, using the same capture routine as packaged xterm. The native submission watermark remains a separate check. These diagnostics include SSH round-trip time. Pass `--check-memory` for native W9 PSS at one, five and ten real SSH sessions. The first reading uses a fresh session, and the multi-session readings follow 5,000 history lines per session. The driver checks the final line in each retained core and samples a stable process set. The driver then closes all ten sessions and measures PSS after each of five cycles that open, fill, and close five sessions. Each close verifies retirement of the tab, native surface, and native core. Pass `--check-background-5` or `--check-background-10` for five W9 runs of 200 echoed keys in the visible session. All sessions start with 5,000 history lines. Each inactive session streams 16 KiB chunks with a 10 ms pause between chunks and must advance its progress marker during each run. The output records a per-session chunk count and the foreground key-to-presentation timings. Matched W1–W4, W9 and W12 measurements remain open, so the comparison stays incomplete. For local emulator qualification, pass `--software-gpu` and set `LAZYSH_BENCH_ANDROID` and `LAZYSH_LANE_RUN_ID` explicitly. Emulator figures cannot establish the Waydroid targets.

Pass `--xterm-streams` to replay the same W2–W4 fixtures over packaged
xterm and OpenSSH. Set `LAZYSH_BENCH_ROWS` to the native arm’s row count if
the xterm pane is taller. Both records include installed APK hashes and
fixture hashes. Each xterm run checks every visible row before releasing
the shell. Its elapsed time includes DOM polling and the host release
handshake. On the Android 15 x86_64 emulator, all 15 packaged xterm samples
matched their expected 49 × 15 screens. The fixture hashes matched the
native stream run at the same grid.

Add `--stream-display` to both stream commands for a separate latency
pass. The fixture paints a colored space in the unused last column
after its final byte. Both arms time from the stream release request to
the first Android display capture containing the marker. The metric
includes the host handshake and screenshot capture, so it is an upper
bound on visibility. The text oracle still checks every final row.
Display passes omit CPU, wakeup and frame counters because repeated
captures add work. Keep the ordinary stream passes for those counters.

The Android 15 x86_64 emulator observed the marker and verified the
final text in all 15 runs per engine at 49 × 15, with matching fixture
and app APK hashes. The native arm used its debug software GPU.
Median time to display capture across five samples per workload was
2,257 ms versus 600 ms for plain output, 1,325 ms versus 203 ms for ANSI,
and 873 ms versus 210 ms for redraws (packaged xterm, then native).
These samples qualify the shared endpoint on the emulator.

For W1, run `--xterm-shell` and `--check-shell` with the same run ID
and grid. The packaged xterm arm checks every visible row after each of
the 300 bursts of command echoes, output, and prompts in all five runs.
Its per-burst timing ends at the DOM observation. The native timing ends
at the submission watermark. Both include SSH delivery. On the Android
15 x86_64 emulator, both arms completed 1,500 observations with matching
run ID, app APK hash, fixture hash, and 49 × 15 geometry.
Add `--stream-display` to both shell commands for a shared display
endpoint. Each burst paints a distinct completion color. The next burst
stays gated until capture and the engine’s own checkpoint both finish.
The evidence includes 300 capture latencies per run and omits CPU counters
from these screenshot passes.
On the Android 15 x86_64 emulator, both arms captured all 1,500 bursts
with the same marked fixture and app APK. The median of the five runs’
p50 and p95 readings was 80.6 and 101.3 ms for xterm, and 49.0 and
53.0 ms for native with the debug software GPU.

For W9 memory, pair `--xterm-memory` with `--check-memory` on the same
installed app APK. Both arms sample guest process PSS at one fresh SSH
session and at five and ten sessions after 5,000 history lines per
session. Each then samples PSS after five additional cycles of opening,
filling, and closing five sessions. The xterm arm checks that each tab
received its history and that its DOM renderer is removed on close.
The native arm also verifies surface and core retirement. PSS is sampled
immediately after cleanup and includes the Android app and its WebView
processes.

On one Android 15 x86_64 emulator run with matching app APK hashes, xterm
used 381 MiB at five sessions and 424 MiB at ten. Native used 399 MiB
and 405 MiB with its debug software GPU. After the fifth cleanup cycle,
xterm measured 573 MiB and native measured 353 MiB. The same run confirmed
tab and renderer retirement on every close. The samples qualify the
memory test on the emulator. Delayed reclamation and Waydroid measurements
remain open.

For input during sustained output, add `--stream-display` to
`--check-flood` and use `--xterm-flood --stream-display` for packaged
xterm. Set `LAZYSH_BENCH_ROWS` to the same keyboard-visible grid in both
arms. Each run sends 200 single-character IME commits. The owned SSH
fixture writes at least one 16 KiB chunk before arming each commit, then
continues offering 16 KiB chunks every 4 ms while it waits for input.
A unique color in the last row
identifies each echo in the composited Android capture. Each record includes
the input, marker, and flood fixture hashes for pair verification. The elapsed
time starts at IME dispatch and includes the display capture.

On the Android 15 x86_64 emulator, both engines passed all 1,000 echoes
at 49 × 12 with matching app APK, input, markers, and flood data. The
median across the five per-run p50 and p95 readings was 123.1 and
151.0 ms for xterm, and 92.4 and 114.9 ms for native with the debug
software GPU. The full Waydroid and multi-session input comparisons remain
open.

For input with five or ten open SSH sessions, add `--stream-display`
to `--xterm-background-5` or `--xterm-background-10` and pair it with the
matching `--check-background-5` or `--check-background-10` invocation.
Use the same keyboard-visible row count for both arms. The foreground
receives IME commits and their echoes while each other session offers
16 KiB chunks with a 10 ms pause. The driver waits for every background
worker's first receipt and requires each worker to advance during the
measurement. The output records each worker's progress alongside the
foreground display latencies.

At five sessions on the Android 15 x86_64 emulator, both engines
captured 1,000 echoes at 49 × 10 and all four background workers
advanced in every run. The median per-run p50 and p95 were 172.6 and
264.6 ms for packaged xterm, and 50.8 and 54.6 ms for native with the
debug software GPU.
At ten sessions, both engines again captured 1,000 echoes at 49 × 10,
with all nine background workers advancing in every run. The median
per-run p50 and p95 were 294.7 and 400.2 ms for packaged xterm, and 57.3
and 65.2 ms for native with the debug software GPU. These emulator
results qualify the fixture for the Waydroid comparison.

The packaged driver honors the lane's `--package` selection. A
side-by-side debug build must give the app and its instrumentation
distinct package IDs and use the test APK's package for its fixture
provider authorities. Use the same installed pair for both engines.
Android requires the existing signer when updating an installed
package, so a separate debug package can avoid replacing an unrelated
installation.

The packaged xterm path has a separate owned-SSH diagnostic. Run the Android
`NativeTerminalSessionTest#aNativeSessionDrawsTheShellTakesTypingAndIsDrawnAgainAfterStopAndStart`
with the standard `lazyshSshFixture` runner argument and `-e lazyshXtermSshEcho true`.
It selects xterm in Preferences, connects through the production SSH UI, and
commits 200 letters through the WebView input connection. The remote PTY echoes
each byte. `xterm-ssh-echo.json` records the WebView event-to-row timing and the
Android dispatch-to-row timing. Timestamp exchanges before and after the run
bound the offset between the two clocks. The diagnostic rejects a bound wider
than 2 ms and records the midpoint's uncertainty. The rendered row count is
also recorded. A test-only WebView message identifies each echoed row update.
Android waits for the corresponding visual state and records its window frame
commit. The dispatch-to-commit interval includes that notification and frame
scheduling. Both engines also use the test-only Android display capture
probe to time the first screenshot with new echo ink. That interval includes
the capture call and bounds when the glyph became visible in a screenshot. Matched Waydroid runs remain
pending. [#2606](https://github.com/mihazs/lazysh/issues/2606)

For a host-collected record, run the lane with the packaged debug app and its
instrumentation APK installed:

```sh
apps/client/bench/waydroid-lane.sh --out lane.json --owned-ssh-fixture \
  --bench xterm-ssh 'bun apps/client/bench/androidEngineBench.ts --packaged-ssh-echo --out "$LAZYSH_LANE_OUT/xterm-ssh.json"'
```

The host runs five fresh sessions against the same owned SSH fixture. It
requires one receipt and a successful runner verdict per repetition, plus
matching rendered grids, before writing the lane record. Each repetition checks the remote PTY size after input while the keyboard is still visible.

For the single-character IME diagnostic, run the native `--check-commit`
mode in the same lane with `LAZYSH_BENCH_ROWS` set to the xterm record’s
rendered row count. Then run
`bun apps/client/bench/androidImePair.ts xterm-ssh.json native-commit.json`.
The tool requires matching run, guest, display, PTY grid, input hash, and
the installed base and split APK digests before reporting each engine’s
median run p50 and p95. Both drivers verify their APK digests at the start
and end of measurement. Its output
covers this workload only. The full Android gate still requires the
remaining workloads and paired Waydroid runs.

## Exit codes

| Code | Meaning | Evidence file |
| --- | --- | --- |
| 0 | every step passed | written, `status` `passed` |
| 1 | a step failed | written, `status` `failed`, with `failures` |
| 2 | usage error (missing `--out`, nothing to run, a runner or class with shell characters, a bad benchmark name) | no |
| 3 | `waydroid`, `adb` or `jq` is not installed | no |
| 4 | the Waydroid container is not active | no |
| 5 | no Wayland compositor to start a session in | no |
| 6 | the lane lock was held for the whole wait | no |
| 7 | the session did not start or the guest did not boot in time; the message carries the last lines of `waydroid session start` | no |

## The lock

One Waydroid guest is shared by every run that touches it, and two UiAutomator or instrumentation sessions kill each other. The lane takes `mkdir /tmp/lazysh-waydroid-lane.lock` (`LAZYSH_WAYDROID_LOCK`), retries every 60 seconds for up to 60 minutes (`LAZYSH_WAYDROID_LOCK_POLL_S`, `LAZYSH_WAYDROID_LOCK_WAIT_S`), treats a lock older than 90 minutes as left by a dead run (`LAZYSH_WAYDROID_LOCK_STALE_MIN`) and removes its own when it ends. A caller that already holds the lock for a longer sequence sets `LAZYSH_WAYDROID_LOCK_HELD=1`. The Appium suite keeps its own per-serial advisory lock on top of this one.

## The evidence file

The top level follows [the baseline schema](terminal-benchmarks.md#result-schema): `schema` (1), `run` (`waydroid lane`), `label`, `status`, `failures`, `startedAt`, `finishedAt`, `host`, `toolchain`, `source` (the checkout the lane ran from) and `results`, plus the blocks below. An unknown value is `null`, never a guess.

- `environment`: `device` (serial, model, ABI, `wm size` and `wm density`), `waydroidImage` (Waydroid version, build fingerprint, display id, flavor, LineageOS version, and whether this run started the session), `androidVersion` (release and SDK), `gpuPath`, `appRevision` (commit and dirty flag of the checkout, and the installed package, its `versionName` and `versionCode`), `guestIme` (the default and the enabled input methods) and `vendorImesInstalled` (Gboard or SwiftKey packages found in the guest).
- `gpuPath.path` is `software` when the guest's GLES string or EGL names a software rasterizer (SwiftShader, llvmpipe, softpipe), `host-gl` for any other renderer, and `unknown` when neither could be read. The raw `egl`, `gralloc` and `glesRenderer` strings are beside it so the classification can be checked.
- `limits` and `acceptedRisk`: what Waydroid cannot establish, in every result. Each entry has an `id`, the `gate` it concerns and the status `accepted risk, not measured`, which is never "met": battery energy (G16), vendor input methods such as Gboard and SwiftKey (G6), real GPU drivers (G13), a real touch digitizer (G13), thermal behaviour (G14), the aarch64 build that ships (the guest is x86_64) and vendor WebView and ROM variation. A pull request that moves a gate with this evidence repeats them.
- `results`: one entry per step, in order. `install` (APK path, SHA-256, output), `instrumentation` (runner, class, passed, failed, skipped, reason) and `benchmark` (name, command, exit code, result files with SHA-256).

Committed evidence goes to `docs/architecture/benchmarks/` named `terminal-lane-<label>-waydroid.json`, with the benchmark files the lane copied beside it. Waydroid timings are not a device result, and a benchmark is compared with xterm.js only when both ran in the same lane run on the same guest.

## Test the harness

`bun test ./tests/waydroid-lane.test.ts` drives the script against stub `waydroid`, `adb` and `systemctl` executables on a `PATH` of their own and asserts exit codes, messages, the calls made to the guest and the evidence JSON: each refusal, the lock, a session started and torn down, a session attached to, the install, instrumentation and benchmark outcomes, the skipped, ignored, failed and crashed cases, and the build entry point. It runs without Waydroid, so it proves the script's logic and none of the guest's behaviour: a stub accepts whatever the script sends. The behaviour against a live guest is checked by a run of the lane itself.

## Capturing the README media

The README screenshots and clips are real captures from this guest, made through the Appium suite: [Capture the README screenshots and clips](../how-to/capture-readme-media.md). A new guest answers `adb connect` with `unauthorized` until its adb key is accepted once, and the lane never changes that.

## Known blockers

On the maintainer's machine on 2026-11-18 the container is active and the session is stopped, and `waydroid session start` fails in `/usr/lib/waydroid/data/scripts/waydroid-net.sh start`, which needs root. The lane then exits 7 with that line and leaves the session stopped, and no evidence is written. Until it is repaired (as root, outside the lane), Android acceptance rests on the CI emulator, and nothing may be reported as a Waydroid result. The first recorded run of the lane against a live guest is the follow-up that this page's status line waits for.

## First live run

2026-11-21, commit 9d61981c, the x86_64 debug and androidTest APKs of CI run 44869362726 (`lazysh-android-debug-x86_64`), guest `WayDroid x86_64 Device`, Android 13, ABI `x86_64`, GPU path `host-gl` (Mesa radeonsi). The evidence is [terminal-lane-core-waydroid.json](benchmarks/terminal-lane-core-waydroid.json), `status` `failed`.

- Ran: the session was attached to, both APKs installed (the 540 MB app APK included) and `app.lazysh.client.NativeTerminalCoreTest` started in the guest and its one test ran for 0.6 s.
- Failed: `IllegalArgumentException: An owned SSH fixture path is required` (`OwnedSshFixture.kt:9`). The test reads a host-written fixture from `-e lazyshSshFixture /data/local/tmp/lazysh-ui-ssh-<32 hex>/fixture.json`, which `tests/support/androidTerminalCore.ts` creates together with an owned OpenSSH server. The lane passes no such argument and starts no server, so the test never reached the core. This says nothing about the core in the guest: **no terminal composition, input or benchmark ran.**
- Next slice (done, see [Second run](#second-run-with-the-owned-ssh-fixture)): give the lane the owned SSH fixture.
- Operational note: Waydroid freezes the container when no app is shown, and `adb shell` then hangs; `waydroid app launch <package>` thaws it. `waydroid session start` must stay alive in the background.

## Owned SSH fixture, thawing and failure details

- `--owned-ssh-fixture` starts the owned OpenSSH server of `tests/support/sshFixture.ts` on the host through `tests/support/waydroidSshFixture.ts` (needs `bun`, `sshd`, `ssh-keygen`), reaches it from the guest with `adb reverse --no-rebind tcp:<port> tcp:<port>` (the same way CI's emulator job does; the server listens on host loopback, the app connects to the guest's own `127.0.0.1`), pushes the fixture to `/data/local/tmp/lazysh-ui-ssh-<nonce>/fixture.json` and passes `-e lazyshSshFixture <that path>` to every `--instrument` step. Teardown (also after a failed step or an interrupt) stops the server, removes the reverse and deletes the device directory. `LAZYSH_WAYDROID_FIXTURE_CMD` replaces the helper command in tests.
- The lane runs `waydroid app launch <package>` before it first talks to the guest, before each instrumentation step and before teardown, because a frozen container makes `adb shell` hang. A session it starts must still stay alive in the background of the caller (`waydroid session start` in a foreground `timeout` leaves it STOPPED); the lane does that itself.
- A failed or erring test is recorded in the instrumentation result as `failedTests` (class, test, message, stack) and its message is part of `reason` and of `failures`.

## Second run with the owned SSH fixture

2026-11-21, source commit a089c448 plus this change (`dirty: true` in the evidence), the same APKs as the first run (CI run 44869362726, artifact `lazysh-android-debug-x86_64`), guest as in the first run. The evidence is [terminal-lane-core-waydroid-run2.json](benchmarks/terminal-lane-core-waydroid-run2.json), `status` `passed`: both APKs installed and `app.lazysh.client.NativeTerminalCoreTest` ran 1 test, 1 passed, 0 failed, 0 skipped. The test drives the real core in the packaged app against the owned OpenSSH shell on this host. **No terminal composition, input or benchmark ran.** Reproduce:

```sh
WAYLAND_DISPLAY=wayland-1 XDG_RUNTIME_DIR=/run/user/1000 apps/client/bench/waydroid-lane.sh \
  --out docs/architecture/benchmarks/terminal-lane-core-waydroid-run2.json --label core-run2 --owned-ssh-fixture \
  --apk <artifact>/universal/debug/app-universal-debug.apk --apk <artifact>/androidTest/universal/debug/app-universal-debug-androidTest.apk \
  --instrument app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner app.lazysh.client.NativeTerminalCoreTest
```

## Composition cases and the native probe on the guest (#2383, #2381)

Recorded on 2026-11-22 on the same guest (Android 13 x86_64, host GL, Mesa radeonsi on a Navi 14), with the x86_64 debug APKs of CI run 45049588618 (`lazysh-android-debug-x86_64`, the head of [#2384](https://github.com/mihazs/lazysh/pull/2384): main plus the transparent WebView, built with the `native-terminal` feature). Two things were learnt that no earlier run showed.

**The composition cases pass on the guest.** [terminal-lane-composition-waydroid.json](benchmarks/terminal-lane-composition-waydroid.json), `status` `passed`: the three cases of `NativeTerminalCompositionTest` ran, each in its own instrumentation step, 3 passed, 0 failed, 0 skipped. They look at the composited screen (`UiAutomation.takeScreenshot`) on the real MainActivity and its Tauri WebView: a placed surface shows through the page's native pane and an opaque DOM overlay stays above it, the WebView is opaque again once the surface is removed, an xterm.js-style page looks the same with a surface placed, and a recreated Activity shows the surface again once its page places it. The class run as a whole (one `am instrument` for the three cases) ended with `Process crashed` in the second case, after the Activity recreation of the first; it happened twice, left no tombstone (`tombstoned: crash socket received short read`), and does not happen on the CI emulator. Cause unknown; the lane therefore runs each case on its own. These are composition cases with a stand-in pane and the surface painted by `BackgroundPainter`: the real pane over a drawn session is [the native session case](../android-testing.md#a-native-terminal-session-through-the-real-ui-2390).

**The guest gives wgpu an adapter that passes the shipping policy.** [terminal-probe-waydroid.json](benchmarks/terminal-probe-waydroid.json): `native_terminal_probe` answered `available: true`, `The native terminal can draw on AMD Radeon Graphics (RADV NAVI14) (Vulkan)`, in 99 ms (101 ms as the page waited), the first call of the process, with CPU rasterizers refused: the guest's Vulkan loader reaches the host's RADV driver. That was one call through the page (the WebView DevTools socket), not a lane step, because the probe case of #2381 was not in the APK that was installed; its lane run (`NativeTerminalCoreTest`, both policies, the adapters it saw and the cost) is still to be recorded. The CI emulator's answer for the same question is the opposite: SwiftShader only, refused under the shipping policy (`terminal-core-evidence/native-probe.json` of the `lazysh-android-terminal-core-results` artifact).

Operational notes from the day:

- Each CI run signs its debug APKs with a key of its own, so installing the artifact of another run over an installed one fails (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`); the guest's app and instrumentation packages were uninstalled first. The guest app held only a default preference and no host.
- `waydroid app launch app.lazysh.client` thaws the guest before a step, and the lane lock must be held for every use of the guest, including a launch or an uninstall: a window-focus change spoils another run that holds it.
- A desktop hard reset stops the Waydroid session (`Session: STOPPED`); starting it needs root, so the lane cannot start it again.

