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

For setup and usage, see [devices](../devices.md). Return to the [documentation map](../README.md).
