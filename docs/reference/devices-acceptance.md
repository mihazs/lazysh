# Host device acceptance evidence

## Android SDK acceptance

The Android runtime CI job additionally runs the native Cargo case
`devices::tests::android_owned_emulator_inventory_and_screenshot` against its
explicitly selected `emulator-5580`, after the app instrumentation checks. The
case uses the production SDK runner to discover that emulator and capture its
screen, then decodes the returned JPEG and checks identity, source dimensions,
preview dimensions and payload bounds. It prints dimensions only and retains no
screen capture. It is ignored in ordinary test runs because it requires the SDK
and an owned emulator; `LAZYSH_TEST_ANDROID_SERIAL` must explicitly match
`ANDROID_SERIAL` before any SDK command executes.

The same job also runs `devices::tests::android_owned_emulator_video_gestures_follow_the_display_size`
against that emulator. It taps with the real display size, shrinks the display with
`wm size`, checks that a gesture mapped from the old size is refused with
`DeviceDimensionsChanged` while one mapped from the new size is accepted, and
resets the size afterwards (also when an assertion fails). It rotates nothing and
reads no screen content.

This gate does not exercise touch calibration to pixel accuracy, lifecycle commands,
the video stream, SSH/frontend delivery, latency, battery use or physical devices.
Those remain under issue #19. A passing synthetic inventory/image fixture alone does not
establish the real SDK gate's result.

The initial [API 36 emulator run](https://github.com/mihazs/lazysh/actions/runs/40268377280/job/121395629728)
passed the exact case at source `cb9be42`: a 1080×1920 screen became a valid
720×1280 JPEG. This is screenshot/discovery evidence for that owned emulator,
separate from the synthetic interface checks in the [host devices guide](../devices.md#interface-language).

## Android video acceptance

The `native-android-auxiliary` job, which runs on `main` only, also runs the native Cargo case
`devices::android::tests::owned_device::owned_emulator_video_delivers_frames_while_idle_and_after_a_change`
against `emulator-5580` with an installed FFmpeg. It presses Home, starts the real
`screenrecord` and FFmpeg pipeline on the idle screen, requires a first frame within the ten-second
startup limit, opens Settings and requires a later frame that shows it (a 16x16 grayscale comparison
with the first frame), then returns to Home. Without the idle screenshot an idle screen ends in
`DeviceTimeout`. Only dimensions and the comparison result are reported; no capture is kept.

The same case passed on a Waydroid Android 13 x86_64 guest (1920x1080), with the emulator-only guard
lifted for that run: the first frame arrived 2.9 s after the stream started (about 2.6 s of that
the companion's own probe), then one screenshot about every 1.1 s while the screen was idle (54 KB
each), and about eight video frames a second from the moment Settings opened. No physical device, no
Android emulator run and no iOS video was observed. Waydroid's `screencap` output and `adb features`
list need the reading fixes of [#1859](https://github.com/mihazs/lazysh/pull/1859).

## Device panel on the owned emulator

The `native-android-ssh-parity` job also drives the real app through the Device panel. The case
`ownedSshDevicePanelCapturesTheOwnedEmulatorThroughRealUi` connects to an owned key-only OpenSSH
daemon that has the current `lazysh-agent` and the job's Android SDK (`ANDROID_HOME`) in its
environment, opens Devices, chooses **Find devices** and requires `emulator-5580` in the list as
running. After selecting it, the panel must offer Capture screen, input, reboot and shutdown but
not boot. **Capture screen** must then show a JPEG that the WebView decodes, with the shape of
the emulator's own display and more than a flat colour. The host's `adb` server lists the same
emulator that runs the app, which is why this case reads the panel and presses nothing else.

Decision on the lifecycle half of #1730: it is a documented limit, not a second owned AVD.
Reboot and Shutdown from the panel would end the emulator that runs the app and the job's own
verdict, and Boot only applies to a stopped AVD. A second AVD in the job would double the
emulator memory (`ram-size: 3072M`) and boot allowance (`emulator-boot-timeout: 300`) the
30-minute job already reserves, for a case that would still only exercise `adb` and `emulator`
commands the host Cargo cases already check by exact arguments. The case never enables input
for the same reason: a tap would land on the app under test.

The case does not cover video, touch calibration, latency, battery use, a physical device or an
iOS Simulator. A synthetic inventory in Vitest or Playwright does not establish this case's
result.

## iOS Simulator idb acceptance

The non-required [`ios-idb-acceptance`](../../.github/workflows/ios-idb-acceptance.yml) workflow runs the
optional idb path of [issue #1731](https://github.com/mihazs/lazysh/issues/1731) on a GitHub-hosted macOS
runner: it builds the ignored Cargo case `devices::idb::tests::owned_simulator_idb_preview_touch_and_lifecycle`,
installs idb from a pinned commit of `meta/homebrew-fb`, creates and boots a fresh iPhone 16 Pro Simulator,
starts `idb_companion` on a private socket (`0700` directory, `0600` socket) and runs the case with
`LAZYSH_TEST_IOS_UDID` and `LAZYSH_TEST_IDB_SOCKET` naming them. It runs on pull requests that touch
`apps/agent/src/devices*`, on pushes to `main`, weekly and on demand. It is separate from `checks.yml` and
`main-verdict.yml` because idb is third-party: a new idb release must not turn an unrelated pull request red.
The job summary records the macOS, Xcode, iOS runtime and idb versions under test. The case prints counts,
dimensions and timings only, never screen contents.

The case drives the production adapter, not idb directly, and checks in order:

1. `simctl` discovery lists the exact UUID as a booted simulator, and `idb describe` through the companion socket
   binds the same UUID and reports the screen in points (402×874 on the iPhone 16 Pro, whose screenshot is
   1206×2622 pixels, a whole multiple of 3).
2. With Settings in front, the accessibility frame of its **General** button (points) is tapped at its centre
   through the adapter and **General** opens. This is the touch calibration: the point comes from the
   Simulator's own frame, not from a screenshot.
3. An edge swipe (2, 437) to (301, 437) over 400 ms returns to the Settings list, Home leaves Settings, and
   the volume and Lock buttons are accepted (no observable effect is asserted for those three).
4. The production `idb video-stream --format minicap` command delivers a first frame and then at least three
   frames, two of them different, after the foreground app changes. Frames are JPEGs of 604×1312 for the 402×874
   point screen. Cancelling the preview ends the owned `idb` child process (checked in the process table).
5. `shutdown` and `boot` by exact UUID reach `Shutdown` and `Booted` as confirmed by `simctl` discovery, controls
   fail closed while the Simulator is down, and the same companion verifies the Simulator again after the boot.

[Run 43750896350](https://github.com/mihazs/lazysh/actions/runs/43750896350) passed at source `58925c0f` on
`macos-26-arm64` (macOS 26.7.2, Xcode 26.6, iOS 26.5 runtime) with idb, idb-cli and idb-companion 1.7.8
(companion built 2026-11-01).

What the real run established that fixture tests could not:

- idb 1.7.8 rejects `idb tap`, `idb swipe` and `idb button` as top-level commands (`invalid choice`). They are
  `idb ui tap|swipe|button`. The adapter ran the top-level form, so no input ever reached a Simulator; it now runs
  the `ui` form, with a unit test on the exact argument list.
- Everything else the adapter assumed held on this host: `--companion` accepts the Unix socket path,
  `describe --json` reports `width_points`/`height_points`, the Minicap header and length framing parse, a
  tap in points lands on the element with that frame, and the companion keeps serving the same UUID across a
  shutdown and boot.
- `idb ui describe-all` answers only while an app is in front: on the home screen it exits 1 with "named no
  frontmost application" (run 43732516114; `describe-point` answered there). A call can also take seconds on a loaded host. It is therefore **not** treated as stable and no iOS accessibility tree
  is added; the case uses it only to read a frame in points and to observe an effect.
- A hosted runner's few CPUs are shared with the Simulator, and commands that take well under a second on an idle
  Mac passed the adapter's ten-second limit now and then: the first `simctl list` after CoreSimulatorService had
  been idle, a screenshot, a tap, and above all `simctl shutdown` (7 s in the passing run, 23 s and 66 s in
  others, with the companion attached). The case retries repeatable commands up to twice and prints every timeout;
  a timed-out shutdown request is reported rather than failed and the state discovery confirms is asserted.
  The limit itself is tracked in [#1911](https://github.com/mihazs/lazysh/issues/1911).
- Frame rate on the 3-core runner was between 2.4 and 5.8 frames per second reaching the adapter in earlier
  runs with controls active (the companion's own log said 8.0 to 8.7 at the start of a stream). One earlier run saw
  no changed frame within 30 seconds of launching Settings although the companion logged 8 frames per second; the
  next run did not repeat it and its cause is not established.

Not covered, still open under [issue #19](https://github.com/mihazs/lazysh/issues/19): physical iOS devices,
Intel Macs, any Xcode, iOS or idb version other than the one above, `reboot` (it runs the same shutdown and boot
under the same limit), delivery through the SSH command channel to the app and its WebView, rotation, input
latency and battery use, and an iOS accessibility tree.

For setup and usage, see [devices](../devices.md). Return to the [documentation map](../README.md).
