# Apple status surfaces

Issue [#15](https://github.com/mihazs/lazysh/issues/15) tracks iOS Live Activities, Dynamic Island and the native watchOS companion. This implementation is a bounded local status and review surface. Watch approval execution, APNs delivery and independent remote Watch access remain pending.

## Use

Open **Apple status** in a connected session's tools. **Start Live Activity** explicitly starts a generic agent-count activity when ActivityKit is available and authorized. **Enable Watch status** shares the same bounded status with an installed paired Watch app. Nothing is enabled automatically or persisted as an automatic opt-in.

Counts include agent activity reported within the previous minute. They are recent reports, not proof that a remote process remains alive. Up to eight pending approval identifiers can appear in the Watch inbox. Prompts, tool inputs, host names, project paths and credentials are excluded. In **Usage**, explicitly inspect a transcript and select **Use latest report for Watch**. The selected report is held in memory for that exact SSH session and supplies separate nullable input, output, cache-read and cache-write counters. No counters are summed. The Watch shows the report's original recording time and freshness, which degrades at the original deadline instead of restarting whenever agent status is refreshed. Missing data stays unavailable rather than becoming an estimated quota or billing total.

After explicit opt-in, collection runs every ten seconds while the same connected SSH session is selected and the iPhone app is visible. Moving between tools preserves its controller and subscription. Backgrounding pauses collection; the last snapshot expires within sixty seconds. Selecting another session, disconnecting or stopping status disables its subscription and clears its surfaces. These surfaces do not grant continuous SSH execution while iOS suspends the app.

Watch **Refresh from iPhone** requests the phone's current cached snapshot. **Review on iPhone** opens the existing approval screen only while the matching iPhone session is selected and the app is active. Review never sends an approval decision. The approval screen fetches and confirms the exact request using the existing identity/hash safety gate. Unreachable, disabled, expired or mismatched requests fail closed. No approval is queued for later execution.

## Native project

The source-controlled `apps/client/src-tauri/apple/project.yml.hbs` uses Tauri's official [`bundle.iOS.template`](https://v2.tauri.app/reference/config/) configuration. It extends the [locked CLI 2.12.4 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-cli/templates/mobile/ios/project.yml); upgrading the CLI requires reviewing its Rust build/link/plugin placeholders. Generated `gen/apple` project files remain disposable. No project patch scripts are used.

The template embeds an iOS WidgetKit Live Activity extension, a SwiftUI single-target Watch app, a Watch WidgetKit complication extension, and a native XCTest target. Modern ActivityContent APIs require iOS 16.2; the main app retains its iOS 16.0 minimum and runtime-gates ActivityKit calls. Watch app and complication targets require watchOS 10. Dynamic Island presentation requires compatible hardware. iOS 18/watchOS 11 can also mirror Live Activities into Smart Stack; that system behavior does not replace the separate Watch inbox.

`packages/apple-status` owns the Rust/native bridge and shared native validation. Each opt-in generates a UUID subscription. Disabling retires that UUID, older sequences cannot overwrite newer state, and delayed cleanup from a previous subscription cannot disable a newer one. The native boundary validates clocks, counts, identifiers, expiry, maximum eight approvals and a 3,500-byte snapshot ceiling. ActivityKit receives only counts and dates, well below its combined 4 KB limit. Watch payloads are bounded to 4 KB and sent with `updateApplicationContext`, which replaces superseded queued state. Delivery ordering uses a native-process UUID and monotonic sequence; wall-clock corrections cannot block a newer snapshot or clear. A bounded 8 KB local Watch cache retains that ordering across Watch app restarts, including up to 64 retired native-process identifiers. Complications use a timeline entry at expiry to replace stale counts with an instruction to open lazysh.

The Watch app and its complication share a local App Group container `group.app.lazysh.client.status`. App Groups do not synchronize data between iPhone and Watch; WatchConnectivity performs that transfer. The group and all bundle identifiers must be registered under the signing team. Native targets inherit the configured development team and version, and `WKCompanionAppBundleIdentifier` binds the Watch app to `app.lazysh.client`.

Local ActivityKit updates use `pushType: nil`; this slice needs no APNs provider or push entitlement. Future remote updates require an authenticated relay, APNs token lifecycle/provisioning, expiry enforcement and explicit authorization. See Apple's [ActivityKit lifecycle](https://developer.apple.com/documentation/activitykit/displaying-live-data-with-live-activities), [WatchConnectivity transfer semantics](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity), [Watch project configuration](https://developer.apple.com/documentation/watchos-apps/setting-up-a-watchos-project) and [App Groups](https://developer.apple.com/documentation/xcode/configuring-app-groups).

## Verification

Rust boundary tests use the workspace Cargo suite. Frontend tests use the client Vitest suite. Native XCTest tests compile the same `StatusSnapshot.swift` and `StatusCursor` implementation used by the plugin and Watch targets; they cover expiry, replay, disable/re-enable and delayed old-subscription cleanup.

On macOS with Xcode and an installed iOS/watchOS simulator runtime:

```sh
bun run build:ios
bunx turbo run build:watchos --filter=@lazysh/apple-status
export APPLE_STATUS_SIMULATOR_ID="$(xcrun simctl create lazysh-status-tests com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro)"
bunx turbo run test:apple-status --filter=@lazysh/apple-status
xcrun simctl delete "$APPLE_STATUS_SIMULATOR_ID"
```

The test task invokes native `xcodebuild test` against the `LazyshStatusTests` scheme with a concrete simulator UUID. CI creates and deletes its own simulator and compiles the Watch app/complications separately. Simulator builds are unsigned; device distribution requires valid signing and App Group provisioning.

Physical-device ActivityKit, Dynamic Island, WatchConnectivity delivery, complication scheduling and signed installation are not verified by Linux tests or an unsigned simulator build. Paired iPhone/Watch acceptance must verify lock/unlock, stale presentation, cancellation, old request replay, app suspension and unavailable-phone behavior before claiming full parity.
