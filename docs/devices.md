# Host devices and refreshed simulator frames

The optional Rust companion can inspect Android devices/emulators and iOS Simulators on the connected host. It invokes the host's installed SDK tools through the existing authenticated SSH connection. It does not install SDKs, pair devices, change debugging authorization, or expose a control server.

Android requires `adb` from platform-tools and, for virtual-device discovery/boot, the Android Emulator package with an existing AVD. `ANDROID_HOME` or `ANDROID_SDK_ROOT` selects the SDK; otherwise tools must be on the host's noninteractive `PATH`. A device must already authorize that host's debugging key. iOS requires macOS and an installed Xcode toolchain providing `xcrun simctl`.

```sh
lazysh-agent devices list --platform android
lazysh-agent devices screenshot --platform android --id emulator-5554
lazysh-agent devices tap --platform android --id emulator-5554 --x 100 --y 220
lazysh-agent devices swipe --platform android --id emulator-5554 --x 100 --y 500 --to-x 100 --to-y 100 --duration-ms 300
lazysh-agent devices key --platform android --id emulator-5554 --key home
lazysh-agent devices boot --platform android --id Pixel_API_36
lazysh-agent devices list --platform ios
lazysh-agent devices screenshot --platform ios --id 9C405382-203A-4DC0-A11B-B2FC37EBA881
```

Lists return `schemaVersion: 1`, `platform`, `devices`, `avds`, and `warnings`. Each device has an exact `id`, `name`, `state`, `kind`, and explicit `capabilities` for screenshot, tap, swipe, key, boot, shutdown, and reboot. Android lists distinguish unauthorized/offline devices from running devices. iOS lists include only iOS runtimes and expose unavailable or stopped simulators without pretending they are ready. Lists are capped at 100 connected devices and 100 AVDs. Missing Android SDK components are named in warnings; other SDK errors remain failures or discovery warnings.

Screenshots return a JPEG frame as `{schemaVersion, platform, id, mime, base64, width, height, imageWidth, imageHeight}`. `width`/`height` are the original device screenshot dimensions. `imageWidth`/`imageHeight` are the encoded preview dimensions. Pointer coordinates must be mapped from the actual displayed image rectangle, excluding any letterboxing, into the original dimensions. Refresh after rotation or display changes. These are explicit successive screenshots, not an H.264/video stream; refresh only while the device preview is visible and wait for a frame to finish before requesting another.

Raw PNG capture is bounded to 8 MiB, dimensions to 8192 pixels per side and 16 million total pixels, and decoder allocation to 128 MiB. Frames are reduced to fit 1280 pixels per side, with a second 720-pixel reduction if needed. Encoded JPEG data is capped at 512 KiB so its base64 JSON fits the SSH command's response budget. Invalid or oversized captures fail. iOS writes a screenshot to a new filename in a private temporary directory which is removed after capture, including on errors.

Touch and key controls are supported on Android using numeric pixel coordinates and fixed SDK key names. Keys are `back`, `home`, `enter`, `menu`, `power`, `volume-up`, and `volume-down`. iOS touch/swipe/key capabilities are false: this implementation does not infer undocumented `simctl` touch commands or require an unconfigured accessibility service.

Lifecycle actions are explicit `boot`, `shutdown`, or `reboot` subcommands. Android boot selects an exact AVD name returned by the SDK and uses its documented `-no-window` option for hosts without a display, preserving the SDK's normal snapshot behavior. Android shutdown applies only to emulator serials; physical-device shutdown is unsupported. iOS actions require an exact simulator UUID, never the ambiguous `booted` alias. Responses say `status: "requested"`; refresh discovery to confirm the resulting state. Booting intentionally leaves the SDK-owned emulator running after the short companion command exits. Rebooting or stopping a simulator interrupts the apps running inside it.

SDK arguments are passed separately without a host shell. Device IDs, simulator UUIDs, AVD names, coordinates and swipe duration are validated before commands run. SDK text output is capped at 256 KiB; commands time out after ten seconds each. Android discovery can invoke two SDK commands, so the SSH caller should allow at least 25 seconds. Ctrl-C, SIGHUP and SIGTERM cancellation kill and reap owned SDK children; Unix also kills their process group. Windows cancellation covers the owned child, not arbitrary independently launched descendant processes. The SDK's ordinary adb server may remain running. SDK stderr is not echoed into JSON or logs.

Verified with native Cargo tests: synthetic Android/iOS inventories, exact argument targeting, unsupported/hostile input rejection, image bounds/dimensions, private-file cleanup, AVD selection, and cancellation/timeout/output limits against an owned Rust test process. No installed SDK enumerated or controlled a developer's real devices during verification. Real SDK/device lifecycle, touch calibration, screenshot refresh latency, frame rate, battery use, continuous video, simulator accessibility automation and broader iOS controls remain [issue #19](https://github.com/mihazs/lazysh/issues/19) acceptance work.

Primary command references: [Android adb](https://developer.android.com/tools/adb), [Android Emulator command line](https://developer.android.com/studio/run/emulator-commandline), [AOSP input command implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/services/core/java/com/android/server/input/InputShellCommand.java), and [Apple Simulator screenshots](https://developer.apple.com/library/archive/documentation/IDEs/Conceptual/iOS_Simulator_Guide/InteractingwiththeiOSSimulator/InteractingwiththeiOSSimulator.html), inspected 2026-10-24. SDK behavior is version-sensitive; fixture tests do not certify an installed host toolchain.
