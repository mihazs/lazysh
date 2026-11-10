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

This gate does not exercise touch calibration, lifecycle commands, video,
SSH/frontend delivery, latency, battery use or physical devices. Those remain
under issue #19. A passing synthetic inventory/image fixture alone does not
establish the real SDK gate's result.

The initial [API 36 emulator run](https://github.com/mihazs/lazysh/actions/runs/40268377280/job/121395629728)
passed the exact case at source `cb9be42`: a 1080×1920 screen became a valid
720×1280 JPEG. This is screenshot/discovery evidence for that owned emulator,
separate from the synthetic interface checks in the [host devices guide](../devices.md#interface-language).

For setup and usage, see [devices](../devices.md). Return to the [documentation map](../README.md).
