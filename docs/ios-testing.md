# iOS workspace UI acceptance

`bun run test:ios-workspace` runs a standard XCUITest against the actual installed
simulator app. It types into the host form, saves a unique `uitest-<uuid>` host,
terminates and relaunches the process, then deletes that host through confirmation.
It never connects to SSH, sets JavaScript values, or mocks native IPC.

On macOS with Xcode, Bun, and the repository's iOS build prerequisites installed,
run from the repository root:

```sh
bun install --frozen-lockfile
bun run build:ios
export APPLE_STATUS_SIMULATOR_ID="$(xcrun simctl create lazysh-workspace-ui com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro)"
xcrun simctl boot "$APPLE_STATUS_SIMULATOR_ID"
xcrun simctl bootstatus "$APPLE_STATUS_SIMULATOR_ID" -b
xcrun simctl install "$APPLE_STATUS_SIMULATOR_ID" apps/client/src-tauri/gen/apple/build/arm64-sim/lazysh.app
bun run test:ios-workspace
```

Delete only this isolated simulator afterward, including after a failed test:

```sh
xcrun simctl delete "$APPLE_STATUS_SIMULATOR_ID"
```

Results, screenshots, and failure diagnostics are in
`apps/client/src-tauri/gen/apple/workspace-ui.xcresult`; archive or remove that
generated result bundle before rerunning. CI uploads it even when the test fails
and always deletes its isolated simulator. No existing user simulator is used.

On workspace failure, CI also retains `lazysh-ios-workspace-metadata` within the
app acceptance artifact. This filesystem-only probe records a SHA-256 of the
generated PBX project, whitelisted project/workspace target configurations, and
the selected simulator's persisted UDID, runtime, device type and state. Persisted
state does **not** establish live simulator availability. Unknown schemas or
conversion failures are marked unavailable. Inputs are capped at 2 MiB for PBX
and 64 KiB for the device plist; filtered files are capped at 32 KiB, configuration
lists at 32, arrays at eight values and strings at 128 characters with explicit
truncation markers. Private conversion files are removed without upload. The
probe runs no SDK or simulator commands and does not change XCTest's destination,
deadline or original result. It is diagnostic evidence, not a destination fix.

The source-controlled target lives in `src-tauri/apple/project.yml.hbs` and the
fixture in `src-tauri/apple/UITests/WorkspaceUITests.swift`. Tauri generates the
Xcode project during `build:ios`. The UI runner deliberately has no app-build
dependency: the app's Rust build phase needs a live Tauri CLI. Instead it launches
the already built and installed `app.lazysh.client` by bundle identifier.

`build:ios` requests ad-hoc signing for the simulator app and its embedded targets.
The simulator-only identity is `-`; device signing and development teams are not
configured by this test workflow. Do not add `--no-sign` to this build: Tauri's
unsigned path clears `CODE_SIGN_ENTITLEMENTS`, and the resulting host failed the
noninteractive Keychain probe with `errSecMissingEntitlement`. CI retains the
generated plist and actual signature/Mach-O entitlement sections; project settings
alone do not prove that the built app has usable grants. The signed-build probe and
bootstrap checks must pass before treating this configuration as verified.

The test commands still request unsigned test bundles (`CODE_SIGNING_ALLOWED=NO`)
and use the already built app without rebuilding or signing its target.
The workspace test also passes `IDE_DISABLED_OS_ACTIVITY_DT_MODE=1` to its
separately launched app. The hosted-test scheme's environment does not cover this
launch: run 40215178597 passed Keychain/bootstrap checks, then its UI launch had
`OS_ACTIVITY_DT_MODE=YES` and timed out taking an accessibility snapshot of the
Open hosts button. Applying the same logging control is a targeted experiment;
that run did not retain a stack proving the timeout's cause. The original touch,
persistence and deletion assertions and deadlines remain unchanged.
Standalone-runner compilation and the real WKWebView accessibility queries still
require macOS CI acceptance; Linux configuration checks do not establish either.
These tests cover local workspace persistence, not device signing, SSH sessions,
push delivery, or physical biometric hardware.
