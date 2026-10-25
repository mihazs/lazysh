# iOS native Mosh validation

The package's iOS build uses the same pinned protobuf-lite, Abseil, utf8_range,
generated messages, and OpenSSL sources as Android. Historical
`vendor-android` paths and their checksums stay in place; there is no second
source snapshot. Desktop system dependencies and Android NDK selection remain
separate. The app enables the existing verified-SSH Mosh handoff on iOS; Windows remains unsupported. The native library was verified on the iOS Simulator in CI run 40166263884: six native tests and the two-client official-server protocol test passed with Xcode 26.6 / SDK 26.5.

Full Xcode is required. The native build selects `iphoneos` for
`aarch64-apple-ios`, and `iphonesimulator` for `aarch64-apple-ios-sim` or
`x86_64-apple-ios`, through the selected Xcode's `xcrun`. CMake receives the target
SDK, architecture, and `iOS` system explicitly. Rust selects its corresponding
SDK for the target. `IPHONEOS_DEPLOYMENT_TARGET` defaults to **16.0**, matching
the application's existing minimum; neither a newer SDK nor simulator changes
that deployment target. Static compiler probes avoid signing test programs.
OpenSSL's pinned source builder has native iOS/device/simulator configurations.
The SDK supplies zlib and libc++; Android-only logging/dl libraries are omitted.

Source evidence:

- [Rust iOS platform requirements](https://doc.rust-lang.org/rustc/platform-support/apple-ios.html)
- [Tauri prerequisites](https://tauri.app/start/prerequisites/) and its installed
  `tauri-utils` iOS minimum-system-version/deployment-target mapping
- [Apple Xcode SDK/deployment support](https://developer.apple.com/xcode/system-requirements/)
- [Cargo simulator execution in libsignal's native testing guide](https://github.com/signalapp/libsignal/blob/main/TESTING.md)

On the macOS CI runner, report `xcodebuild -version` and both SDK versions, then
link the device native test executable without running or signing it:

```console
IPHONEOS_DEPLOYMENT_TARGET=16.0 cargo test -p lazysh-mosh-transport --target aarch64-apple-ios --lib --no-run --locked
```

`bun run test:ios-mosh` uses a native Cargo host fixture with the existing
isolated `APPLE_STATUS_SIMULATOR_ID`. It cross-builds the library unit tests and
`ios_peer` integration test, resolves their exact Cargo JSON artifact paths,
and executes them through `xcrun simctl spawn --standalone`, matching
[Swift's command-line simulator test runner](https://github.com/swiftlang/swift/blob/main/test/lit.cfg).
A bounded `--list` preflight requires all six native security tests by name
before executing the suite, distinguishing executable startup failures from
test-body failures. It does not retry launches or increase suite deadlines.
This launch change addresses an intermittent CI stall before the test runner's
first output; its effectiveness remains unverified until macOS CI executes it.
The peer communicates only with
ephemeral official Mosh 1.4.0 host servers on shared loopback, exercising two
parallel clients, UTF-8, remote PTY resize, and acknowledged shutdown. The host
fixture bounds build/start/execute deadlines and terminates its server processes;
the CI job owns simulator creation and final cleanup. No custom runner script,
external account, provisioning profile, or background entitlement is added.

Native linking and simulator execution are distinct acceptance results. Physical
device bootstrap, app session handoff, suspension/resume, network roaming, and
battery measurements remain separate checks. This repository's Linux environment
has no Xcode SDK and cannot execute iOS builds or simulator tests locally.

The original Mosh COPYING/COPYING.iOS and dependency licenses remain intact.
Apple lists [Abseil and Protobuf as SDKs requiring privacy manifests](https://developer.apple.com/support/third-party-SDK-requirements/).
Their exact upstream `PrivacyInfo.xcprivacy` files are preserved and hashed in
the shared source snapshot. When enabling the app integration for distribution,
the app's XcodeGen template builds distinct `LazyshMoshAbseilPrivacy.bundle` and `LazyshMoshProtobufPrivacy.bundle` resource targets and embeds them in the application. Each target references the original vendored manifest directly, without duplicating or replacing an app-level privacy manifest. The resource bundles have distinct product names and generated bundle metadata, and contain no executable. Validate the resulting Xcode archive privacy report before distribution.
No signed application release or App Store submission is performed here.

## Actual app acceptance

The `LazyshMoshAppTests` hosted XCTest target uses the already built Tauri app at
`$(SRCROOT)/build/arm64-sim/lazysh.app/lazysh`, matching the current native build
output. It has no application dependency, and disables implicit dependencies,
so `xcodebuild test` cannot rerun the app's always-run Rust phase after the Tauri
CLI options server has exited. The scheme must run after `bun run build:ios`.

```console
xcodebuild -project apps/client/src-tauri/gen/apple/lazysh.xcodeproj -scheme LazyshMoshAppTests -destination "platform=iOS Simulator,id=$APPLE_STATUS_SIMULATOR_ID" test CODE_SIGNING_ALLOWED=NO
```

The two tests read the actual host application's embedded SDK resource bundles,
verify the original upstream SHA-256 bytes and privacy properties, and invoke
`transport_capabilities` through its actual WKWebView/Tauri IPC bridge. They do
not mock the capability, start a user SSH session, or replace the library's
existing authenticated-UDP tests. Hosted app loading, resource bundling and
actual iOS app IPC remain unverified until this scheme passes in macOS/Xcode CI;
the earlier library simulator pass does not establish those app-level results.
Physical-device SSH/Mosh handoff, network roaming, background/resume and energy
behavior remain acceptance work.
