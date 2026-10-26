# Host devices and simulator video

## Interface language

Device controls and client validation use English, Brazilian Portuguese or Spanish
without changing the selected device/platform, SDK request IDs, frame bytes,
source dimensions or coordinate mapping. A language change does not start/stop a
stream, capture a screenshot or grant input permission. The iOS companion socket
draft remains editable data; reported names, SDK states, native warnings/errors
and socket paths are not translated. Reboot/shutdown keep their explicit confirmation.

Synthetic Vitest/Playwright fixtures cover held startup and pulls, late cleanup,
retained errors, the screenshot timer, exact Android pixels/iOS points and key
values, plus real browser JPEG decoding and stable frame/draft identity while
changing language. These renderer checks do not execute SDK commands or establish
real-device input, video, latency, battery use or physical mobile WebView acceptance.

The optional Rust companion can inspect Android devices/emulators and iOS Simulators on the connected host. It invokes the host's installed SDK tools through the existing authenticated SSH connection. It does not install SDKs, pair devices, change debugging authorization, or expose a control server.

Android requires `adb` from platform-tools and, for virtual-device discovery/boot, the Android Emulator package with an existing AVD. `ANDROID_HOME` or `ANDROID_SDK_ROOT` selects the SDK; otherwise tools must be on the host's noninteractive `PATH`. A device must already authorize that host's debugging key. iOS requires macOS and an installed Xcode toolchain providing `xcrun simctl`.

```sh
lazysh-agent devices list --platform android
lazysh-agent devices screenshot --platform android --id emulator-5554
lazysh-agent devices tap --platform android --id emulator-5554 --x 100 --y 220
lazysh-agent devices swipe --platform android --id emulator-5554 --x 100 --y 500 --to-x 100 --to-y 100 --duration-ms 300
lazysh-agent devices key --platform android --id emulator-5554 --key home
lazysh-agent devices boot --platform android --id Pixel_API_36
lazysh-agent devices android --id emulator-5554 probe
lazysh-agent devices android --id emulator-5554 stream
lazysh-agent devices list --platform ios
lazysh-agent devices screenshot --platform ios --id 9C405382-203A-4DC0-A11B-B2FC37EBA881
```

Lists return `schemaVersion: 1`, `platform`, `devices`, `avds`, and `warnings`. Each device has an exact `id`, `name`, `state`, `kind`, and explicit `capabilities` for screenshot, tap, swipe, key, boot, shutdown, and reboot. Android lists distinguish unauthorized/offline devices from running devices. iOS lists include only iOS runtimes and expose unavailable or stopped simulators without pretending they are ready. Lists are capped at 100 connected devices and 100 AVDs. Missing Android SDK components are named in warnings; other SDK errors remain failures or discovery warnings.

Screenshots return a JPEG frame as `{schemaVersion, platform, id, mime, base64, width, height, imageWidth, imageHeight}`. `width`/`height` are the original device screenshot dimensions. `imageWidth`/`imageHeight` are the encoded preview dimensions. Pointer coordinates must be mapped from the actual displayed image rectangle, excluding any letterboxing, into the original dimensions. Refresh after rotation or display changes. These are explicit successive screenshots, not an H.264/video stream; refresh only while the device preview is visible and wait for a frame to finish before requesting another.

Raw PNG capture is bounded to 8 MiB, dimensions to 8192 pixels per side and 16 million total pixels, and decoder allocation to 128 MiB. Frames are reduced to fit 1280 pixels per side, with a second 720-pixel reduction if needed. Encoded JPEG data is capped at 512 KiB so its base64 JSON fits the SSH command's response budget. Invalid or oversized captures fail. iOS writes a screenshot to a new filename in a private temporary directory which is removed after capture, including on errors.

Touch and key controls are supported on Android using numeric pixel coordinates and fixed SDK key names. Keys are `back`, `home`, `enter`, `menu`, `power`, `volume-up`, and `volume-down`. Plain `simctl` iOS discovery reports touch/swipe/key capabilities false. Optional idb enables the explicitly verified controls described below.

## Optional view-only Android video

Android video requires an existing host `ffmpeg` executable with its H.264 decoder, MJPEG encoder, multipart JPEG muxer, and FPS filter. Lazysh probes those components and the device's `shell_v2` feature, and asks `screenrecord` to parse the capture options before `--help` exits without recording. It never installs FFmpeg or copies a capture server to the device. The output-format switch is implemented in AOSP but marked unofficial and omitted from its help text; incompatible vendor implementations fail the probe or stream instead of claiming support.

Choose **Verify Android video tools**, then **Start video preview**. The companion runs fixed argument arrays equivalent to `adb -s SERIAL shell -T -n screenrecord --output-format=h264 --bit-rate 2000000 --time-limit 180 --size WIDTHxHEIGHT -`, piping H.264 directly into its owned host FFmpeg process. `-T` disables terminal transformations, and shell-v2 separates stderr and exit status from video bytes. Encoder dimensions preserve the initial screenshot aspect ratio, fit within 1280 pixels, and use even dimensions. FFmpeg accepts only the pipe protocol and H.264 input, limits individual allocations to 64 MiB and decoded images to 1,638,400 pixels, uses one codec/filter thread, and emits a target eight JPEG frames per second. Multipart headers are limited to 1024 bytes and each JPEG to 512 KiB before the shared bounded decoder and latest-frame bridge accept it. Android video frame dimensions describe the decoded preview, not a touch coordinate space.

This preview is **view-only**: Android's documented recording behavior does not support rotation reliably, so video frames cannot safely provide touch coordinates. Stopping video, hiding the panel, or a stream failure keeps pointer input disabled until **Capture screen** supplies a fresh screenshot. Existing screenshot refresh and explicitly enabled screenshot controls remain available. Rotation-aware video input remains issue #19 work. Video has no audio or recording/download feature, stops after three minutes, and can fail when a device has no compatible AVC encoder. Startup requires a first valid frame within ten seconds. After that, an unchanged screen keeps its previous image until another frame arrives, cancellation, or the total deadline. Native frame pulls wait up to fifteen seconds and return an explicit idle response without updating the image or capture sequence. Idle-screen cadence still requires device acceptance testing.

Cancellation, SSH stdin EOF/disconnect, output backpressure timeout, and failure kill and reap both owned host children. AOSP's shell-v2 daemon sends SIGHUP to its subprocess on protocol disconnect and waits for its exit; the explicit 180-second recording limit also bounds incompatible vendor behavior. Lazysh never kills unrelated screenrecord processes or restarts the shared adb server. Source contracts: [AOSP recording implementation](https://android.googlesource.com/platform/frameworks/av/+/refs/heads/main/cmds/screenrecord/screenrecord.cpp), [adb subprocess lifecycle](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/daemon/shell_service.cpp), [FFmpeg multipart JPEG framing](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mpjpeg.c), and [Android recording limitations](https://developer.android.com/tools/adb#screenrecord).

The real Cargo codec fixture has executed an installed FFmpeg 9.0.2 H.264-to-JPEG pipeline, cancellation after a validated frame, and malformed-input failure. Other native tests reject missing device protocol/decoder capabilities and oversized/truncated multipart data. This does not verify a device AVC encoder, vendor adb lifecycle, rotation behavior, actual frame rate, or battery cost; Android emulator/device acceptance remains pending.

## Optional continuous iOS preview

On a macOS host, install Meta's `idb` CLI and configure its companion independently with a Unix-domain socket. Lazysh never installs or launches a companion server. Select an iOS Simulator, enter the existing socket's absolute host path, and choose **Verify iOS companion**. The socket and its final directory must be owned by the SSH account and deny group/other access. Every ancestor must be a real directory owned by that account or root, without group/other write access; root-owned sticky ancestors such as `/private/tmp` are permitted above the private final directory. Symlinks, parent traversal, and TCP addresses are rejected. Verification uses `idb --companion <socket> --no-prune-dead-companion describe --json` and requires an exact matching simulator UUID, booted state, and explicitly reported point dimensions; older incompatible companions fail closed.

**Start video preview** opens one authenticated SSH command channel and invokes `idb video-stream --format minicap --fps 8 --compression-quality 0.35 --scale-factor 0.5`. This is a continuous JPEG video source with Minicap length framing, separate from screenshot refresh. It does not provide H.264, audio, recording, or a guaranteed frame rate. Each JPEG is bounded to 512 KiB and decoded under allocation/dimension limits before delivery. Native state retains only the newest frame, and the webview has one outstanding frame pull. There is no listening network endpoint or accumulating webview event queue. A preview stops after 15 minutes or ten seconds without a delivered source frame.

Enable device input explicitly after verification. iOS tap/swipe coordinates use the companion's **screen points**, not Retina screenshot pixels. Every control action verifies current companion identity and point dimensions again. Home, lock/power, and volume buttons are supported. Unsupported keys are rejected. Rotation that changes the aspect ratio stops the stream; verify the companion again before resuming. Stop, hidden preview, panel removal, SSH disconnect, stdin EOF, and termination signals cancel owned video children; children are killed and reaped, while the independently configured companion remains running.

The source contract was inspected at Meta idb commit `6079df9f441313b20b476e084b5a8747a14571bf`: [CLI video options](https://github.com/facebook/idb/blob/6079df9f441313b20b476e084b5a8747a14571bf/idb/cli/commands/video.py), [Minicap framing](https://github.com/facebook/idb/blob/6079df9f441313b20b476e084b5a8747a14571bf/FBVideoCore/Writers/JPEGFrameWriters.swift), [point dimensions](https://github.com/facebook/idb/blob/6079df9f441313b20b476e084b5a8747a14571bf/idb/common/types.py), and [HID controls](https://github.com/facebook/idb/blob/6079df9f441313b20b476e084b5a8747a14571bf/idb/cli/commands/hid.py). Installed idb/Xcode combinations can differ; command failure leaves screenshot mode available.

Lifecycle actions are explicit `boot`, `shutdown`, or `reboot` subcommands. Android boot selects an exact AVD name returned by the SDK and uses its documented `-no-window` option for hosts without a display, preserving the SDK's normal snapshot behavior. Android shutdown applies only to emulator serials; physical-device shutdown is unsupported. iOS actions require an exact simulator UUID, never the ambiguous `booted` alias. Responses say `status: "requested"`; refresh discovery to confirm the resulting state. Booting intentionally leaves the SDK-owned emulator running after the short companion command exits. Rebooting or stopping a simulator interrupts the apps running inside it.

SDK arguments are passed separately without a host shell. Device IDs, simulator UUIDs, AVD names, coordinates and swipe duration are validated before commands run. SDK text output is capped at 256 KiB; commands time out after ten seconds each. Android discovery can invoke two SDK commands, so the SSH caller should allow at least 25 seconds. Ctrl-C, SIGHUP and SIGTERM cancellation kill and reap owned SDK children; Unix also kills their process group. Windows cancellation covers the owned child, not arbitrary independently launched descendant processes. The SDK's ordinary adb server may remain running. SDK stderr is not echoed into JSON or logs.

Verified with native Cargo tests: synthetic Android/iOS inventories, exact argument targeting, unsupported/hostile input rejection, image bounds/dimensions, private-file cleanup, AVD selection, private socket policy, companion identity/point binding, truncated/oversized video framing, cancellation during output backpressure, and bounded latest-frame storage. Vitest checks late startup cleanup and one outstanding pull. No installed SDK enumerated or controlled a developer's real devices during verification. Actual macOS idb/Xcode video, touch calibration, hardware encoding availability, device lifecycle, latency, frame rate, battery use, and broader iOS controls remain [issue #19](https://github.com/mihazs/lazysh/issues/19) acceptance work.

Primary command references: [Android adb](https://developer.android.com/tools/adb), [Android Emulator command line](https://developer.android.com/studio/run/emulator-commandline), [AOSP input command implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/input/InputShellCommand.java), and [Apple Simulator screenshots](https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/iOS_Simulator_Guide/InteractingwiththeiOSSimulator/InteractingwiththeiOSSimulator.html), inspected 2026-10-24. SDK behavior is version-sensitive; fixture tests do not certify an installed host toolchain.
