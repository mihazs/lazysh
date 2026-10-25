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

The source-controlled target lives in `src-tauri/apple/project.yml.hbs` and the
fixture in `src-tauri/apple/UITests/WorkspaceUITests.swift`. Tauri generates the
Xcode project during `build:ios`. The UI runner deliberately has no app-build
dependency: the app's Rust build phase needs a live Tauri CLI. Instead it launches
the already built and installed `app.lazysh.client` by bundle identifier.

The command requests unsigned simulator testing (`CODE_SIGNING_ALLOWED=NO`).
Standalone-runner compilation and the real WKWebView accessibility queries still
require macOS CI acceptance; Linux configuration checks do not establish either.
These tests cover local workspace persistence, not device signing, SSH sessions,
push delivery, or physical biometric hardware.
