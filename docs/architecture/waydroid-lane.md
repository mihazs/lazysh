# Waydroid lane runbook

Status: **the harness exists and is tested against stub `waydroid` and `adb` executables; no journey is wired to it yet and no evidence file has been recorded.** The lane is the Android acceptance environment for the native terminal engine release ([decision of 2026-11-18](terminal-migration-plan.md#decision-of-2026-11-18-waydroid-is-the-android-acceptance-environment), [ADR 0001, Amendment 6](adr-0001-terminal-runtime.md#amendment-6-2026-11-18-waydroid-is-the-android-acceptance-environment)). This page covers the harness of [#2093](https://github.com/mihazs/lazysh/issues/2093); the journeys and the benchmarks that run inside it are separate slices. The harness moves no row of the [gate table](terminal-migration-plan.md#acceptance-gates-and-evidence): a row moves only when evidence written by a run of the lane is on `main`. Related: [benchmarks](terminal-benchmarks.md) · [Android instrumentation](../android-testing.md) · [mobile end-to-end suite](../../apps/client/mobile-e2e/README.md).

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
| `--apk <file>` | Installs the file with `adb install -r -t` (repeatable). The evidence records its SHA-256 |
| `--build <build.sh>` | Runs one of the build scripts that wrap `bench/android-apk.sh` (`bench/android-webview/build.sh`, `bench/android-canvas/build.sh`) with `ANDROID_HOME`, `JAVA_HOME`, a throwaway output path and, if set, `LAZYSH_WAYDROID_BUILD_ASSETS`, then installs the result |
| `--instrument <runner> <class>` | Runs `am instrument -w -r -e class <class> <runner>` (repeatable) and counts the status codes it prints |
| `--bench <name> <command>` | Runs a shell command (repeatable). It gets `LAZYSH_BENCH_ANDROID` (the serial, which `bun run bench:terminal` already honours), `LAZYSH_LANE_OUT` (a directory for its result files) and `LAZYSH_LANE_PACKAGE`. The files it leaves there are copied next to the evidence as `<evidence name>-<name>-<file>` and listed with their SHA-256; the command's exit status decides pass or fail, and a run with no result file fails |

Steps run in the order of the arguments. A failed install or build stops the run (the evidence says the rest did not run); a failed class or benchmark does not hide the ones after it.

### The program workloads on the lane

`apps/client/e2e/terminal-programs.spec.ts` replays W5 to W8 and W11 ([benchmarks](terminal-benchmarks.md#program-workloads-w5-to-w8-and-w11)) through xterm.js in the guest's Android System WebView when `LAZYSH_BENCH_ANDROID` is set, which the lane does for every `--bench` command:

```sh
apps/client/bench/waydroid-lane.sh --out docs/architecture/benchmarks/terminal-lane-programs-waydroid.json --label programs \
  --build apps/client/bench/android-webview/build.sh \
  --bench programs 'cd apps/client && LAZYSH_BENCH_OUT="$LAZYSH_LANE_OUT/programs.json" bun run bench:terminal -- --project desktop e2e/terminal-programs.spec.ts'
```

The spec fails when the WebView host loses the window focus, so nothing else may use the guest during the run. **This command has not been run:** the session did not start on the day it was written (see [Known blockers](#known-blockers)). The same workloads run on the native core with `examples/program_workloads.rs`, which is a host binary: no run of the core inside the guest exists, so the lane cannot yet put the two engines side by side in one guest.

### The lane never skips

An instrumentation class fails the lane when it runs no test, when a test is ignored or ends on an assumption (`INSTRUMENTATION_STATUS_CODE` -3 or -4), when a test fails or errors (-1, -2), or when the instrumentation does not finish (a crash, or a runner or class that is not installed). A benchmark fails on a non-zero exit, and also when it exits zero but leaves no result file in `LAZYSH_LANE_OUT` (a Playwright spec that skipped itself measured nothing). A run that could not start produces no evidence at all, so a missing file is never mistaken for a pass.

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

## Known blockers

On the maintainer's machine on 2026-11-18 the container is active and the session is stopped, and `waydroid session start` fails in `/usr/lib/waydroid/data/scripts/waydroid-net.sh start`, which needs root. The lane then exits 7 with that line and leaves the session stopped, and no evidence is written. Until it is repaired (as root, outside the lane), Android acceptance rests on the CI emulator, and nothing may be reported as a Waydroid result. The first recorded run of the lane against a live guest is the follow-up that this page's status line waits for.
