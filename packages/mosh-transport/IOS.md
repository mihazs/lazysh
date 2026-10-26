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
This launch path passed all six native tests and the two-client protocol test
in CI run 40172672432. The earlier intermittent stall happened before the test
runner's first output; its exact CoreSimulator startup cause remains unproven.
On a stalled simulator executable, the fixture keeps the original 45-second
failure deadline and adds at most five seconds of diagnostic observation before
terminating its owned process group. It records executable names/PIDs without
argv or environment, and attempts one-second stack samples of its tracked launcher
and an identifiable direct native child in that same process group. Shared
CoreSimulator daemons and unrelated processes are excluded. Missing diagnostic
tools do not prevent teardown; known fixture keys are redacted before truncation.
Diagnostic output retains up to 2 KiB of inventory status and the first 6 KiB
of each process sample, including PID/status and its call graph before long
Binary Images lists, within the overall 16 KiB limit. Compiler stdout/stderr
continue to retain their last 16 KiB. This instrumentation collects evidence;
it does not retry or establish the startup cause.
CI run 40177092696 stalled before `--list` output and its inventory command
was unavailable, so no stack was captured. The fixture now reports the inventory
failure status and still samples its known owned leader independently of that
inventory; child sampling continues to require positive ownership evidence.
Failure-only inventory now uses `/bin/ps -x -g <owned-PGID> -o
pid=,ppid=,pgid=,comm=` within the same one-second bound. There is exactly one
selection criterion: the owned process group. Apple's [ps manual](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.1)
defines `-g` as process-group selection and `-x` as including processes without
a controlling terminal. Its [implementation](https://github.com/apple-oss-distributions/adv_cmds/blob/main/ps/ps.c)
selects `KERN_PROC_PGRP` for one group selector; global or combined selectors
would obtain the wider process list. This narrows observation without changing
the launch, sampling, timeout or cleanup schedule.
For positively observed owned names, `observed_image_role` distinguishes exact
`xcrun`, `simctl`, and the expected native executable (`native`); all other
names are `unknown`. The unreaped tracked leader remains explicitly unknown if
inventory cannot identify it. An observed image does not prove entry into main,
test execution, or a cause for the stall, and an image may change before sampling.
Artifact 12663228981 from PR143 retained only an empty standalone discovery timeout
and timed-out inventory/sample observers; no executable image or stack was
established. Passing artifact 12661573984 from PR141 executed seven unit cases and
the official-peer fixture, without explaining that recurrence. Linux Cargo checks
cover formatting, ownership filtering and bounded failure behavior; the additional
macOS-only native test exercises the actual Apple selector against an owned child.
Neither Linux `ps` nor source inspection substitutes for executing that test and
the iOS fixture on macOS. The intermittent cause remains open in issue #45.
The peer communicates only with
ephemeral official Mosh 1.4.0 host servers on shared loopback, exercising two
parallel clients, UTF-8, remote PTY resize, and acknowledged shutdown. The host
fixture bounds build/start/execute deadlines and terminates its server processes;
the CI job owns simulator creation and final cleanup. No custom runner script,
external account, provisioning profile, or background entitlement is added.
App installation and hosted/UI acceptance run whenever the app build and
simulator setup succeeded and the workflow was not cancelled, even if this
independent raw-library fixture fails. Its failure still fails the job, and
result upload and simulator cleanup remain unconditional.

CI containment for [issue #45](https://github.com/mihazs/lazysh/issues/45) bounds
the iOS job to 60 minutes, each native XCTest step to eight minutes, and the
Watch build to eight minutes. Canonical XCTest commands enable
[180-second per-case timeouts](https://developer.apple.com/documentation/xctest/xctestcase/executiontimeallowance), retaining
default single execution without repetition or retry flags. Xcode rejected
`-test-iterations 1` as requiring a count greater than one, so that flag is
omitted rather than increasing the count. Case timeouts do not cover a runner
that stalls before starting a case; the step bounds cover that phase. App
installation is bounded to three minutes, and cleanup to two minutes.

The outer raw-fixture step has an 18-minute bound covering its existing build,
boot and execution budgets. Its 45-second executable deadlines and five-second
diagnostic budget are unchanged. The existing Bun command is captured with
`tee` and explicit `pipefail`, preserving its failure outcome. A separate
`lazysh-ios-mosh-diagnostics` artifact is uploaded immediately afterward, before
hosted acceptance, so a later stall cannot hide that completed raw evidence.
The existing result upload and simulator cleanup still run on failure. These
are new runner bounds and evidence retention, not a fix or diagnosis of the
intermittent startup cause. Runtime validation requires macOS CI.

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
The hosted test target uses that same `build/arm64-sim` product root through
`CONFIGURATION_BUILD_DIR`: Xcode requires the host app's `PlugIns` directory
to be a descendant of the test target's product directory. A host path outside
the default DerivedData products directory fails during build planning, before
any XCTest can run.
The invocation also sets this product directory globally: the launcher resolves
the host app through the invocation's products root, even when the test target's
own `CONFIGURATION_BUILD_DIR` and `TEST_HOST` point to the prebuilt app. In run
40180208893 the test bundle compiled into the correct app, but the launcher
searched DerivedData and neither hosted assertion ran. That run passed all six
raw native tests, official-server interoperability and the real workspace Save,
process relaunch and Delete test. The launcher correction subsequently passed
both hosted tests and workspace acceptance in run 40182020108 at `e9d9486`.
PR43 run 40185579849 at `6c104ec` also passed hosted and workspace acceptance,
despite an independent raw startup failure. These app-level passes do not
explain the intermittent raw startup cause, and the new containment bounds
still require CI validation.

```console
xcodebuild -project apps/client/src-tauri/gen/apple/lazysh.xcodeproj -scheme LazyshMoshAppTests -destination "platform=iOS Simulator,id=$APPLE_STATUS_SIMULATOR_ID" -test-timeouts-enabled YES -default-test-execution-time-allowance 180 -maximum-test-execution-time-allowance 180 test CODE_SIGNING_ALLOWED=NO CONFIGURATION_BUILD_DIR="$PWD/apps/client/src-tauri/gen/apple/build/arm64-sim"
```

The two tests read the actual host application's embedded SDK resource bundles,
verify the original upstream SHA-256 bytes and privacy properties, and invoke
`transport_capabilities` through its actual WKWebView/Tauri IPC bridge. They do
not mock the capability, start a user SSH session, or replace the library's
existing authenticated-UDP tests. Hosted app loading, resource bundling and
actual iOS app IPC are simulator verified by the hosted test passes above;
those results are distinct from the raw library tests and new CI bounds.
Physical-device SSH/Mosh handoff, network roaming, background/resume and energy
behavior remain acceptance work.
