# Android instrumentation

Android runtime tests use the application module's standard `src/androidTest/java/` source set, AndroidJUnitRunner, ActivityScenario and Espresso-Web. They are separate from the vault module's local JVM JUnit tests.

The suite retains one shared activity until AndroidJUnitRunner finishes. Destroying the last Tauri activity intentionally exits its native process, which also hosts instrumentation; per-test activity closure would discard test results. The standard runner argument `waitForActivitiesToComplete=false` prevents AndroidJUnitRunner's automatic activity-finisher listener from destroying that shared activity between test methods. Configuration-change recreation remains exercised by the workspace test.

The workspace fixture locates/clicks DOM controls with Espresso-Web, then types through Espresso's native `typeTextIntoFocusedView`. Espresso-Web's JavaScript `webKeys` atom assigns the input value directly, which updates React's value tracker before its synthetic event and can leave controlled form state unchanged. The test checks fixture values and form validity, and reports the exact readiness stage and visible form error without dumping page contents.

Install the Android SDK, JDK 21 and NDK version declared by the application. Set `JAVA_HOME`, `ANDROID_HOME` and `NDK_HOME` for your toolchain. Start a dedicated x86_64 emulator and wait until this command returns `1`:

```sh
adb -s emulator-5580 shell getprop sys.boot_completed
```

Run the package-owned task against that specific device:

```sh
ANDROID_SERIAL=emulator-5580 bun run test:android
```

Turbo first runs `build:android:emulator`, which builds the frontend and x86_64 Tauri debug APK. It then runs Gradle's `connectedUniversalDebugAndroidTest`. The Gradle invocation skips the native Rust task because the preceding Tauri build already produced its libraries; this avoids trying to contact an expired Tauri build-control process from a detached Gradle invocation. Both tasks bypass Turbo result caching.

The tests cover:

- The bundled Android WebView and real Tauri IPC: creating a fixture host, recreating the activity, and deleting that same uniquely named fixture.
- The actual Kotlin vault plugin with Android Keystore: private ciphertext persistence, plaintext roundtrip, metadata existence, altered authentication-tag refusal, and fixture deletion.
- Refusal of protected writes when strong biometrics are unavailable. Where strong biometrics are enrolled, the test starts a protected write and immediately cancels it, checking that no credential was saved.
- A stored fixture cannot be read by a cancelled operation or while the plugin is backgrounded; a later operation can read it after resume. This checks native cancellation/lifecycle gates without claiming a successful biometric authentication.

The tests create unique fixture entries and never connect to a fixture SSH hostname or use existing saved credentials. No successful biometric authentication, hardware-backed key protection, SSH roaming, battery use, or physical-device behavior is inferred from these tests.

Reports are generated under `apps/client/src-tauri/gen/android/app/build/reports/androidTests/connected/`. XML results are under the corresponding `build/outputs/androidTest-results/connected/` directory.

The tracked application manifest includes Tauri's paired `DEEP LINK PLUGIN` comment block and the `lazysh` VIEW/DEFAULT/BROWSABLE declaration. Keep that block when reviewing normal Tauri preparation: restoring it to an older tracked manifest can silently remove link routing from a cached incremental APK, because Cargo may not rerun the plugin's manifest updater. The markers let later preparation replace the existing block rather than append another filter. The app's standard `testUniversalDebugUnitTest` task parses the actual canonical XML; the existing first-Activity/warm-intent instrumentation verifies packaged resolution, rejects unrelated schemes, and requires explicit theme review before application. Manifest/package inspection establishes routing declarations, not successful native Activity delivery or authorization.

Use a dedicated AVD rather than a personal device or another developer's AVD. Hardware acceleration is recommended. Software emulation without `/dev/kvm` can take many minutes to complete first-boot package verification; a device visible to adb is not necessarily booted or ready for instrumentation. Gradle property-fetch timeouts or an unknown API level before boot completes are environment failures, not passing runtime tests.

The `native-android-runtime` GitHub Actions job uses an isolated Android 36 AOSP x86_64 AVD with KVM required, a five-minute boot deadline and the same `bun run test:android` task. It uploads Gradle instrumentation reports even on failure. The system image is the SDK's `default` AOSP image, avoiding Google application startup work while retaining Android's WebView provider.

The runner is pinned to the [owned release-compatible derivative](https://github.com/mihazs/lazysh-android-emulator-runner/pull/2) at `46beb5d59b664ea61462125a023549a5a7b0418b`, based on the previously executed upstream release `a421e43855164a8197daf9d8d40fe71c6996bb0d`. Its only behavior option adds `unlock-screen` (default `true`); lazysh explicitly sets it to `false` to omit the post-boot synthetic MENU key. `NativeActivityFixture` already owns screen readiness and nonsecure keyguard dismissal. SDK versions, tracked runtime dependencies, boot waiting, requested settings, app/test commands, readiness assertions, deadlines and cleanup are unchanged. No ANR dismissal or acceptance retry is introduced. The action's 57 Jest tests exercise source and compiled entry points with mocked external commands; they do not establish emulator behavior. A successful consumer run would establish execution of the changed runner and app gates, not prove the cause of every historical ANR or a measured flake-rate improvement.

CI also retains `outputs/androidTest-results/system-diagnostics/` in the existing runtime artifact. An owned `adb logcat` collector starts before the Mosh fixture and APK build, includes any boot records still buffered, and filters system errors/warnings and `am_anr` events instead of application/WebView logs. It stops after 30 minutes or when its output reaches 1 MiB; earlier buffer eviction or the cap can leave gaps. Each output file has a 1 MiB limit, with eight fixed files at most. The collector is stopped and reaped on shell exit, before emulator teardown.

On test failure, native `dumpsys activity lastanr`, `lastanr-traces`, `dumpsys cpuinfo` and fixed kernel load/pressure fields are captured before teardown. Each command has a ten-second deadline plus at most two seconds for forced termination. Start/failure load samples and command exit codes distinguish missing, failed or truncated diagnostics; failure snapshots are not necessarily ANR-onset measurements. No root access, permission changes, dialog dismissal, DOM dump or acceptance retry is added. The original first failing test command's exit status remains the job result even when diagnostic collection fails. Android's [ANR guidance](https://developer.android.com/topic/performance/issues/anr) and [AOSP diagnostic implementation](https://android.googlesource.com/platform/frameworks/base/+/29d4a0a5d5ba/services/core/java/com/android/server/wm/ActivityTaskManagerService.java) describe the retained ANR records and traces; command availability and retained trace participants depend on the system image.

The expanded capture executed in PR #97's API36 run (`40251074938`, artifact `12620364277`, head `7d42ca4`). It retained a launcher no-focused-window ANR at 00:53:41.647 UTC, before the Mosh fixture, APK build and first Activity test at 01:00:23.339. The runner logged its synthetic MENU input at 00:53:36.923. This timing supports investigating premature input; separate host/guest clocks and the absent triggering event identity prevent proving that MENU caused the ANR. Native traces include a launcher main thread waiting in `RenderProxy::setStopped` and a RenderThread in emulated graphics synchronization. The ANR report records high guest CPU pressure; that does not establish the underlying host cause. Kernel pressure reads were denied and their nonzero exits retained. Issue #9 tracks the unresolved runtime failure.
