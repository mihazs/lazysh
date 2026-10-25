# Android instrumentation

Android runtime tests use the application module's standard `src/androidTest/java/` source set, AndroidJUnitRunner, ActivityScenario and Espresso-Web. They are separate from the vault module's local JVM JUnit tests.

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

Use a dedicated AVD rather than a personal device or another developer's AVD. Hardware acceleration is recommended. Software emulation without `/dev/kvm` can take many minutes to complete first-boot package verification; a device visible to adb is not necessarily booted or ready for instrumentation. Gradle property-fetch timeouts or an unknown API level before boot completes are environment failures, not passing runtime tests.

The `native-android-runtime` GitHub Actions job uses an isolated Android 36 AOSP x86_64 AVD with KVM required, a five-minute boot deadline and the same `bun run test:android` task. It uploads Gradle instrumentation reports even on failure. The system image is the SDK's `default` AOSP image, avoiding Google application startup work while retaining Android's WebView provider. The emulator runner's configuration and boot handling follow its [official action documentation](https://github.com/ReactiveCircus/android-emulator-runner).
