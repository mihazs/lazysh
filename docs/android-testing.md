# Android instrumentation

The Appium and WebdriverIO device suite (`apps/client/mobile-e2e`) drives the packaged app from outside the process, across the
native layer and the WebView. It is the layer for defects that need system gestures, a real input method or runtime
permission dialogs. See [Write and run Appium tests](how-to/write-and-run-appium-tests.md); it uses the same x86_64 debug APK
as the instrumented tests below and runs on the guest named by `ANDROID_SERIAL`.

## Controlled clock state for owned ntfy acceptance

The dedicated ntfy owner uses the source-pinned API36/default AOSP provisioner,
the attested QEMU process/AVD, and stable local ADB-server, transport, guest boot
and adbd identities. Guest SDK36 and absence of all three fixture packages are
required. This is never an operation on a physical device or an operator-selected
host. System-image field provenance and actual shell command support still need
qualification on the workflow-owned image; source support alone is not execution.

After downloads, APK preparation and trust inspection, before fixture packages or
enrollment state exist, the owner saves the exact automatic-time boolean, disables
and reads it back, then sets OS wall time **once** to freshly sampled host time plus
1000ms using ordinary-shell `cmd alarm set-time`. It does not request root, grant
permissions, change authenticated host timestamps, or retry a failed setup.
An independent Toybox `date +%s%3N` read with host wall/monotonic brackets must put
the entire guest-minus-host interval strictly above zero and at most2000ms.
Both millisecond quantization intervals are included; the readback uncertainty and
monotonic span must each be at most250ms. These are fixed fixture-admission bounds,
not production tolerances or increased acceptance deadlines. Exit0 from the setter
is insufficient: Android16's service deliberately reports success independently
of the native clock setter result.

The original notification callback, future/stale-event checks, replay protection,
durable receipts and native deadlines remain unchanged. Initial readback does not
prove later drift or exact UTC synchronization; a real native pass is still
required. This controlled positive-offset fixture does not qualify arbitrary user
clocks, automatic-time operation, near-expiry delivery, performance or physical
Samsung behavior. Exported receipts contain only closed setup/readback/restoration
states, the closed name of the setup step that last started (`packagesBefore`, `readAutoTime`,
`disableAutoTime`, `setTime`, `readTime`, `packagesAfter`, or `complete` after verified setup) and declared
bounds, never raw timestamps or command output. A failed setup keeps the step it stopped in through
restoration, so a recurrence of a pre-readback failure names which operation to investigate; the
step names that operation, not its cause.

Cleanup first stops owned children/reverses and removes fixture packages, then
independently verifies package/state absence before restoring and reading back the
original automatic-time boolean. Lost ownership or unestablished teardown blocks
restoration rather than changing time beneath retained high-water state. Primary
acceptance failures and closed cleanup-failure stages remain in the finite failure
receipt; setup/cleanup failure cannot produce a successful acceptance receipt.

The existing `tests/android-ntfy.test.ts` Bun owner covers interval boundaries,
quantization, host discontinuities, unsupported/unchanged readback, ownership,
single-setting policy and teardown/restoration. The actual task remains
`bun run test:android-ntfy`; unit success does not replace its three native cases.
Primary Android16 source: [alarm service](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/apex/jobscheduler/service/java/com/android/server/alarm/AlarmManagerService.java),
[shell permissions](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/packages/Shell/AndroidManifest.xml),
[automatic-time commands](https://android.googlesource.com/platform/frameworks/base/+/99b01a65cc4c104933788b3143285ab6bae65827/services/core/java/com/android/server/timedetector/TimeDetectorShellCommand.java)
and [Toybox date precision](https://android.googlesource.com/platform/external/toybox/+/e21e76d30fa15996188b79affbc25cfd0c13deff/toys/posix/date.c).

## Build SDK

Install `platforms;android-36` and `platforms;android-37.0`. The app and shared push library compile
against 37; other native libraries retain 36. The build
keeps targetSdk 36, minSdk 24, Build Tools 36.0.0, NDK 29.0.14206865 and the API 36
runtime emulator. Compilation against newer APIs does not raise the minimum
device version or opt into newer target-SDK behavior. Existing AGP 9.3.1 and
Gradle 9.6.1 satisfy the [official API 37 compatibility requirements](https://developer.android.com/build/releases/agp-9-3-0-release-notes).
This permits the pending enrollment dependency's [OkHttp 5.5.1 API 37 build requirement](https://github.com/square/okhttp/blob/parent-5.5.1/okhttp/build.gradle.kts)
without suppressing AAR metadata validation or downgrading its AOSP certificate
blocklist fix. This prerequisite does not add enrollment or remote delivery.

## F-Droid push variant

`bun run build:android:fdroid` produces an unsigned ARM64 release APK with the opt-in Rust `fdroid` feature. The feature excludes the Android Google push Gradle project and native registration path. Remote push is reported unavailable; local inbox notifications remain independent. Normal Android builds retain Firebase, and iOS retains APNs. This does not establish F-Droid.org inclusion, release signing or automatic delivery.

On the workflow-owned AVD only, `bun run test:android-fdroid` builds the FOSS emulator APK, inspects its actual resolved runtime dependencies and packaged manifest/dex using SDK `apkanalyzer`, then runs the protected native push status/control case through the bundled WebView. The same case in ordinary instrumentation verifies normal Android reports its packaged FCM plugin. It never registers a real device or contacts a provider to prove the unsupported variant; both unsupported controls must reject. A missing local KVM device prevents AVD acceptance and must be reported rather than replaced with a desktop mock pass.

`LAZYSH_ANDROID_PUSH_VARIANT=google bunx moon run client:test-android-push-artifact` checks a previously built normal APK. Use `fdroid` for the Google-free variant; optionally set `LAZYSH_ANDROID_PUSH_APK` and `LAZYSH_ANDROID_PUSH_CONFIGURATION=universalReleaseRuntimeClasspath` for the unsigned release artifact. Both variants require the unchanged package/version identity and matching debug/release flag. The retained JSON contains the APK hash and fixed Google dependency/class/manifest booleans, not arbitrary manifest metadata. This verifies the identified Firebase/GMS blocker only; it is not a complete F-Droid licensing/scanner audit.

## Owned QR camera acceptance

The owned runtime build explicitly sets `VITE_LAZYSH_QR_CAMERA_TRACE=1`. Only that exact build-time value enables seven fixed console warnings at the real camera continuation boundaries: request, resolved, rejected, stale, attached, play_resolved and play_rejected. Normal builds do not log these markers. They contain no stream identifiers, payloads, device details or exception data, and logger failures are ignored. The `client:build-android-emulator` task declares this input through the process environment. These markers distinguish a pending media request from late stale resolution, actual video attachment and play-promise settlement without wrapping the API, adding observers or changing the original deadlines. They do not establish pixel delivery or successful decoding.

`bun run test:android-qr` is an explicit, uncached Linux/emulator-only task. It depends on the emulator APK build, installs that owned APK, resets only its camera permission before instrumentation, and selects `NativeWorkspaceTest.ownedQrCameraRequiresPermissionAndExplicitPreview`. It does not repeat the ordinary/theme/SSH methods. The ordinary cross-host task excludes this dedicated method. CI invokes QR serially after SSH and keeps the existing runtime deadline and failure collector.

The AVD uses `-camera-back imagefile:<absolute checkout>/apps/client/src-tauri/fixtures/theme-qr-camera-feed.png -camera-front none`, the official image-file camera mode. The separate640×480 camera-feed fixture places an unchanged212×212 decoder control at `(74,134)` on white pixels, centered in the source-supported top-left360×480 crop; its path, hash, actual negative frames and qualified calibration provenance are recorded in [the fixture notes](../apps/client/src-tauri/fixtures/theme-qr-camera.md). The reviewed QR fixture is nonsecret; no developer webcam or physical camera is used. The UI test denies the real AOSP permission sheet, verifies no preview and an enabled image-file fallback control, then explicitly scans again and allows camera use. If permission lifecycle cancels that attempt, it verifies cancellation/no stale preview and requires one new explicit Scan. It does not automatically revive an old access lease or bypass native decoding.

The launch must also end with supported QEMU `-qemu -pidfile <owned PID file>`. Set `LAZYSH_ANDROID_QR_EMULATOR_PID_FILE` to that explicit file; CI forwards its runner-temp path. An emulator-shaped serial or AVD name alone is insufficient. Before any APK install or permission mutation, the helper reads only that nominated live PID's bounded metadata, verifies same-user start identity, SDK QEMU executable, unique matching port/AVD and exact imagefile/front-none arguments, and checks the reviewed PNG's pinned SHA256. No process search, host-camera enumeration or raw argv logging occurs. Missing, replaced, ambiguous or mismatched evidence fails closed. The original identity/source is checked again before every install, permission change, instrumentation dispatch and permission cleanup; losing ownership does not authorize changes on a replacement emulator.

Acceptance requires the expected Rust-decoded preview, unchanged manual draft and preferences without Apply, explicit Cancel preview, detached video, and the successful scan's own native rear-camera unavailable→available observation. Each explicit attempt registers a distinct callback and waits for all rear cameras to be idle before arming; old queued releases cannot satisfy a later attempt. The observer does not open a camera. The real permission controller is discovered from one unambiguous native choice and verified as a system application; subsequent actions retain that owner. Permission cleanup runs after the instrumentation process finishes, remains conditional on pinned emulator ownership, and preserves the original failure. Scoped native JUnit reports live under `app/build/outputs/androidTest-results/qr-camera` and `reports/androidTests/qr-camera`; a successful job without the named non-skipped method is insufficient.

If the unchanged preview wait fails, its native fixture records bounded first/last observations of public video readiness/dimensions, playback/frame counters, track-state counts and finite owned QR status flags, including the first ready-frame observation if one was seen. The diagnostic callback wait is capped by the existing remaining deadline and falls back to fixed unavailable metadata; ActivityScenario dispatch retains framework semantics. Metadata contains no pixels, payloads, track identifiers, arbitrary DOM text or native decode counts, and does not wrap IPC or alter input/stream behavior.

The same existing samples also retain a compact first-attachment projection (readiness, paused state, live-track count and dimensions), bounded sample/frame/readiness maxima, and whether scanning or decoding status was ever observed. Attachment can establish that the stream reached the video before playback became ready; observed scanning follows the production `play()` await. Neither the permission label nor a missing observed milestone proves that `getUserMedia` remains unresolved, and observed decoding status is not a decode-call count. No new polling, media listener, API wrapper or renderer-global state is installed.

To distinguish delivered image geometry from a decode failure, this attested imagefile-camera test attempts one PNG capture within the same observation evaluation that finds a ready frame, at most 500 pixels per side and 192 KiB. A fresh 32-character lowercase hexadecimal runner nonce selects only `cache/lazysh-qr-frame-<nonce>.png` inside the target app. The native test validates the nonce and writes that private file without following links or overwriting another file. The owned host fixture checks pinned emulator ownership again, exports exactly that relative file with `adb exec-out run-as app.lazysh.client cat`, and stores a private `qr-camera/owned-frame-<nonce>.png` report artifact. A QR-specific binary reader stops excess output; the shared 16 KiB text-log cap remains unchanged. No pixel/base64 content is logged, and the exact owned device file is removed before permission cleanup. Export and cleanup failures preserve the original test failure; a missing optional diagnostic never substitutes for the unchanged preview assertion. This artifact is solely the owned synthetic camera source, not a screenshot or physical-camera capture. Offline image inspection/decoding is separate diagnostic evidence, never a replacement for the real UI preview acceptance.

The native fixture reserves the optional capture before that evaluation is dispatched. It rearms only after a bounded, valid combined response certifies that the video was not ready and capture was not attempted. A callback timeout, malformed response, exception or actual attempt permanently consumes the reservation; a late callback only completes its abandoned result holder and cannot start a second capture. Unknown attempt outcomes are reported as null, not false. Combined private responses are size-bounded before JSON parsing, and image data never enters the public observation report. This removes the separate ready-observation→capture-dispatch race; it does not diagnose or repair production canvas, camera or decode behavior.

If the single capture cannot save its frame, its retained report distinguishes unavailable video/context, draw/encode failure, encoded-size limit, native dispatch/callback failure, malformed native result/base64/header/dimensions, and private open/write/close failure. It exposes only fixed stage/reason enums, bounded encoded-character count and callback budget, and an optional bounded numeric OS errno. No exception class/message/cause, path, image or base64 is included. A missing frame remains inconclusive about the camera image until this phase evidence is available; no second capture or fallback is attempted.

Optional host export failures report only a closed finite phase/reason, observed exit code/signal, clamped binary byte count and binary-limit truncation flag. Phases distinguish process startup/completion, size/header/dimension checks, and private artifact directory/write operations. Signals are observed after existing process teardown and do not identify the original failure cause. Metadata never includes stderr, exception messages, paths, nonces or image bytes; malformed reporter input is discarded, and reporter exceptions cannot replace the original operation or acceptance failure. The shared 16 KiB text retention is unchanged. A larger PNG-shaped envelope fixture verifies binary transport/private permissions only, not PNG decoding acceptance.

The dedicated QR Gradle invocation alone sets `android.injected.androidTest.leaveApksInstalledAfterRun=true`, keeping the app and instrumentation APKs present until the host reads the nonce-owned cache file. In pinned AGP9.3.1, the default false configures UTP to uninstall both APKs in its post-suite hook; the [AOSP option documentation](https://android.googlesource.com/platform/tools/base/+/77b69cf85219f333699ba865d83ad999cbd8e077/build-system/gradle-core/src/main/java/com/android/build/gradle/options/BooleanOption.kt) describes this lifecycle. The fixture restores cleanup explicitly after export, exact nonce-file removal and CAMERA revocation: independently ownership-checked uninstall of `app.lazysh.client.test`, then `app.lazysh.client`. Each cleanup is attempted even after another fails, preserving the first failure. This is a source-supported diagnostic-file lifetime repair, not proof of the earlier unretained43-byte response content or a production QR-preview fix. Other Android test tasks retain their existing Gradle behavior.

The fixture tracks the existing 610-second overall budget, including a two-second owned-process teardown allocation for each command. It admits the unchanged full 540-second instrumentation wait only when required camera-permission cleanup, both APK uninstalls and a scheduling margin also fit. Each uninstall reserves five seconds plus its two-second teardown, fourteen extra seconds within the same610-second limit; insufficient setup budget refuses instrumentation before dispatch. Native frame capture is disabled before dispatch when its exact-file removal reserve cannot fit; the nonce remains validated. Optional export receives only the remaining allowance after removal, permission-cleanup and APK-uninstall reserves, and is skipped when none remains. File removal and final permission cleanup recheck ownership and remaining budget, so diagnostics cannot silently extend the deadline or consume required cleanup time. Native UI waits and the production 30-second scan limit are unchanged.

Actual hosted execution is reported separately from local Kotlin/Bun checks. Active-capture cancellation and DocumentsUI file-picker automation are deferred. Physical-device camera checks are explicitly skipped at the user's request because no physical devices are available; emulator coverage does not represent physical hardware or roaming acceptance.

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

moon first runs `build-android-emulator`, which builds the frontend and x86_64 Tauri debug APK. It then runs Gradle's `connectedUniversalDebugAndroidTest`. The Gradle invocation skips the native Rust task because the preceding Tauri build already produced its libraries; this avoids trying to contact an expired Tauri build-control process from a detached Gradle invocation. Both tasks bypass moon result caching.

The tests cover:

- The bundled Android WebView and real Tauri IPC: creating a fixture host, recreating the activity, and deleting that same uniquely named fixture.
- The actual Kotlin vault plugin with Android Keystore: private ciphertext persistence, plaintext roundtrip, metadata existence, altered authentication-tag refusal, and fixture deletion.
- Refusal of protected writes when strong biometrics are unavailable. Where strong biometrics are enrolled, the test starts a protected write and immediately cancels it, checking that no credential was saved.
- A stored fixture cannot be read by a cancelled operation or while the plugin is backgrounded; a later operation can read it after resume. This checks native cancellation/lifecycle gates without claiming a successful biometric authentication.

The ordinary workspace/vault tests create unique fixture entries without connecting to their placeholder hostname or using existing saved credentials. The separately selected owned SSH UI acceptance below makes a real authenticated connection using only its ephemeral identity. No successful biometric authentication, hardware-backed key protection, SSH roaming, battery use, or physical-device behavior is inferred from these tests.

Reports are generated under `apps/client/src-tauri/gen/android/app/build/reports/androidTests/connected/`. XML results are under the corresponding `build/outputs/androidTest-results/connected/` directory.

The tracked application manifest includes Tauri's paired `DEEP LINK PLUGIN` comment block and the `lazysh` VIEW/DEFAULT/BROWSABLE declaration. Keep that block when reviewing normal Tauri preparation: restoring it to an older tracked manifest can silently remove link routing from a cached incremental APK, because Cargo may not rerun the plugin's manifest updater. The markers let later preparation replace the existing block rather than append another filter. The app's standard `testUniversalDebugUnitTest` task parses the actual canonical XML; the existing first-Activity/warm-intent instrumentation verifies packaged resolution, rejects unrelated schemes, and requires explicit theme review before application. Manifest/package inspection establishes routing declarations, not successful native Activity delivery or authorization.

Use a dedicated AVD rather than a personal device or another developer's AVD. Hardware acceleration is recommended. Software emulation without `/dev/kvm` can take many minutes to complete first-boot package verification; a device visible to adb is not necessarily booted or ready for instrumentation. Gradle property-fetch timeouts or an unknown API level before boot completes are environment failures, not passing runtime tests.

The `native-android-runtime` GitHub Actions job uses an isolated Android 36 AOSP x86_64 AVD with KVM required, a five-minute boot deadline and the explicit `bun run test:android-ssh` task, which first runs the unchanged ordinary Android task. It uploads Gradle instrumentation reports even on failure. The system image is the SDK's `default` AOSP image, avoiding Google application startup work while retaining Android's WebView provider.

The runner is pinned to the [owned release-compatible derivative](https://github.com/mihazs/lazysh-android-emulator-runner/pull/2) at `46beb5d59b664ea61462125a023549a5a7b0418b`, based on the previously executed upstream release `a421e43855164a8197daf9d8d40fe71c6996bb0d`. Its only behavior option adds `unlock-screen` (default `true`); lazysh explicitly sets it to `false` to omit the post-boot synthetic MENU key. `NativeActivityFixture` already owns screen readiness and nonsecure keyguard dismissal. SDK versions, tracked runtime dependencies, boot waiting, requested settings, app/test commands, readiness assertions, deadlines and cleanup are unchanged. No ANR dismissal or acceptance retry is introduced. The action's 57 Jest tests exercise source and compiled entry points with mocked external commands; they do not establish emulator behavior. A successful consumer run would establish execution of the changed runner and app gates, not prove the cause of every historical ANR or a measured flake-rate improvement.

CI also retains `outputs/androidTest-results/system-diagnostics/` in the existing runtime artifact. An owned `adb logcat` collector starts before the Mosh fixture and APK build, includes any boot records still buffered, and filters system errors/warnings and `am_anr` events instead of application/WebView logs. It stops after 30 minutes or when its output reaches 1 MiB; earlier buffer eviction or the cap can leave gaps. Each output file has a 1 MiB limit, with eight fixed files at most. The collector is stopped and reaped on shell exit, before emulator teardown.

On test failure, native `dumpsys activity lastanr`, `lastanr-traces`, `dumpsys cpuinfo` and fixed kernel load/pressure fields are captured before teardown. Each command has a ten-second deadline plus at most two seconds for forced termination. Start/failure load samples and command exit codes distinguish missing, failed or truncated diagnostics; failure snapshots are not necessarily ANR-onset measurements. No root access, permission changes, dialog dismissal, DOM dump or acceptance retry is added. The original first failing test command's exit status remains the job result even when diagnostic collection fails. Android's [ANR guidance](https://developer.android.com/topic/performance/issues/anr) and [AOSP diagnostic implementation](https://android.googlesource.com/platform/frameworks/base/+/29d4a0a5d5ba/services/core/java/com/android/server/wm/ActivityTaskManagerService.java) describe the retained ANR records and traces; command availability and retained trace participants depend on the system image.

The expanded capture executed in PR #97's API36 run (`40251074938`, artifact `12620364277`, head `7d42ca4`). It retained a launcher no-focused-window ANR at 00:53:41.647 UTC, before the Mosh fixture, APK build and first Activity test at 01:00:23.339. The runner logged its synthetic MENU input at 00:53:36.923. This timing supports investigating premature input; separate host/guest clocks and the absent triggering event identity prevent proving that MENU caused the ANR. Native traces include a launcher main thread waiting in `RenderProxy::setStopped` and a RenderThread in emulated graphics synchronization. The ANR report records high guest CPU pressure; that does not establish the underlying host cause. Kernel pressure reads were denied and their nonzero exits retained. Issue #9 tracks the unresolved runtime failure.


## Owned SSH through the actual application

`bun run test:android-ssh` builds the existing emulator APK, runs the existing first-Activity theme acceptance and ordinary workspace/vault suite, then starts an explicit Bun-native host fixture and dedicated AndroidJUnit method. The ordinary cross-host `bun run test:android` task retains its existing behavior; only the explicit Linux-owned task adds the SSH gate. Each selection has separate Gradle XML/report directories; the ordinary runner excludes both separately selected methods. No test runs concurrent Gradle instrumentation against the emulator.

The explicit host task requires Linux, OpenSSH server/client, GNU timeout, and the existing SDK/JDK/NDK toolchain. The host fixture owns fresh Ed25519 server/client keys, a loopback OpenSSH listener, private HOME/ZDOTDIR/ENV/BASH_ENV and a deterministic interactive `/bin/sh` prompt. It disables user SSH rc hooks and does not read personal client SSH config. One `ANDROID_SERIAL`-specific adb reverse routes the emulator loopback to that listener. Private fixture JSON is staged only inside a newly created mode 0700 shell-owned device directory, with mode 0600 on the file; only its generated UUID path is an instrumentation argument. Key bytes never enter environment variables, command arguments, task hashes or emitted process errors.

`NativeWorkspaceTest.ownedOpenSshConnectsThroughRealUi` uses actual Add host/Save/Connect controls and selects SSH. It pastes the owned identity through Android's clipboard/native Paste key, compares only a boolean for field equality, checks the exact independently generated server fingerprint, and explicitly trusts it. Remember credentials stays off. The test requires the unique real prompt in xterm, sends a split printf challenge through Compose/Send (the draft paste followed by its separate Enter), requires expanded output absent from the echoed input, and waits for the returned prompt. Before disconnecting, the same authenticated session opens the actual Agents board and exercises its keep-awake checkbox through the shipping WebView/Rust/plugin path. It checks default off, explicit opt-in/off against the real Activity Window flag, release while the Activity is stopped, foreground reacquisition, board-unmount release, persisted-choice remount and final off. The test reads `FLAG_KEEP_SCREEN_ON`; it never sets the flag or calls a debug/native IPC replacement. Lifecycle movement uses Android ActivityScenario, and bounded flag observations do not extend existing typing/readiness or job deadlines. Failure cleanup resumes the owned Activity, turns off any checked board control, returns to Terminal and verifies flag release before the original SSH/clipboard cleanup.

The keyboard containment oracle compares all canvas/key/Esc/Tab `DOMRect` edges
against the actual `VisualViewport` double dimensions plus its layout-viewport
offsets, with finite positive geometry required and no rounding or tolerance.
The same small Android-test asset executes in the WebView and the existing Bun
owner's fractional-fit, overflow and offset-clipping cases. Native physical
WebView/IME bounds, the positive terminal row, and expansion after dismissal remain
separate assertions. WebView 133.0.6943.137 ([commit 49ec12c](https://github.com/chromium/chromium/commit/49ec12cc413ffec766028509968b31d7d65fa0b7))
returns [integer inner dimensions](https://github.com/chromium/chromium/blob/49ec12cc413ffec766028509968b31d7d65fa0b7/third_party/blink/renderer/core/frame/local_dom_window.cc#L1471)
but [double visual dimensions and offsets](https://github.com/chromium/chromium/blob/49ec12cc413ffec766028509968b31d7d65fa0b7/third_party/blink/renderer/core/frame/visual_viewport.cc#L444).
The distinction matters on the owned 2.625-density guest: a 412.190px full-width
rectangle exceeds integer innerWidth 412. That comparison alone cannot establish
physical overflow; the oracle uses the actual visible bounds instead.
Actual visual dimensions are retained only as bounded numeric failure metadata;
physical-device behavior remains a separate acceptance requirement.


It then disconnects and deletes its unique host. No fake native bridge, direct SSH/write IPC, JS input-value assignment, credential-vault bypass or production test endpoint is used.

Cleanup clears only the fixture-labeled clipboard and removes only the allocated reverse/device fixture path. SSH descendant retirement is fenced by the original live daemon PID/start identity and revalidated parent identities before recursion, followed by listener shutdown/reaping. Losing original ownership/liveness fails explicitly rather than adopting a later process tree or claiming full cleanup. Remote shell lifetime is additionally capped by the fixture's timeout; original UI readiness/typing budgets remain unchanged, and the runtime job's ceiling is 40 minutes so every guarded case can finish. Failures retain their original result if cleanup also fails. Native Bun tests cover real key authentication/refusal, prompt/challenge behavior, active-shell retirement, private file modes, bounded process deadlines and output omission. The process helper supports foreground fixture tools only; arbitrary background children outliving a reaped leader are unsupported. A native counterexample fails visibly and owns its separate child cleanup; a generic supervisor would be required before supporting daemonizing commands. The app method runs only when explicitly selected by its host task. Ordinary root CI tests exercise the host utility without requiring an emulator/OpenSSH installation. Linux-/proc-specific helper and real-host cases are explicitly skipped on other hosts; platform-independent output-omission checks still run. Explicit SSH acceptance on an unsupported host fails with its Linux requirement rather than silently skipping.

Local SDK/JDK compilation and host tests are separate from actual API36 execution. At implementation time this development host has no connected emulator or KVM device; no local app SSH runtime pass is claimed. Hosted app/WebView results must establish the UI path; they do not imply physical roaming, successful biometric prompts or every mobile SSH workflow.

## Debug Activity creation phases

Debug builds emit three fixed `LazyshActivityCreate` messages: `onCreate:enter`,
`onCreate:afterEdgeToEdge` and `onCreate:afterSuper`. They contain no runtime IDs,
saved state, exception text, stack, DOM or user data. The existing per-case native
logcat artifact can distinguish which app-owned creation call returned. Lifecycle
calls, native cover hooks, assertions and deadlines keep their original order.
Missing messages remain inconclusive; these phases do not identify a native lock,
crash cause or a completed recreation.

The standard app JUnit test reads the actual compiled `MainActivity.class` without
loading an Activity. Both debug and release unit-test variants are scheduled in
the Android build job, with AGP's `android.onlyEnableUnitTestForTheTestedBuildType`
set to `false` for that test invocation only: debug requires the fixed logging
operands; release requires their absence. This compiled-class check is separate from the actual API36
recreation acceptance required by #373. The debug diagnostic does not close that
runtime issue or establish the later owned SSH/Herdr acceptance.

For the dedicated owned SSH/Herdr failure report, the existing one-second continuity probe also samples the selected emulator's single `adbd` PID and `/proc/<pid>/stat` start tick under one shared deadline. Only their combined SHA-256 is retained; denied, malformed, missing or oversized reads remain explicitly unavailable/unrecognized/overflow. A changed sample supports daemon replacement; equal samples cannot exclude identity reuse, a transient connection loss, or unrelated listener removal. No host ADB process or listener discovery is performed. The collector reports its observed close offset and Gradle start/end offsets from the same monotonic origin (integer milliseconds, capped at one hour). These are host observation times, not OS termination timestamps or cause attribution. Existing test/collector deadlines and acceptance assertions are unchanged.

The dedicated Herdr invocation alone uses AGP's `android.injected.androidTest.leaveApksInstalledAfterRun=true`: its fixed owned application and instrumentation packages remain installed until the existing bounded failure probe finishes. Pinned AGP otherwise uninstalls them in `afterAll`, and Android removes a package's historical exit records on removal. A bounded exact-ID package-presence snapshot distinguishes absent, unavailable and unrecognized output; presence is not proof of a particular installed binary. Finally cleanup attempts both fixed packages on the selected owned emulator, retaining the original acceptance failure if cleanup also fails. The ordinary SSH/default tasks keep their existing installation lifecycle. This preserves diagnostic opportunity, not a claim that uninstall caused the runtime failure.

The owned-case streaming classifier also reads ActivityManager info messages, retaining only an exact `app.lazysh.client` force-stop prefix within the original START/END window. It maps the reason to finished-instrumentation, start-instrumentation, external-request or other, plus timestamp; caller PID/name, app ID, user ID and raw reason are discarded. These package-scoped records share the existing eight-record/64KiB bounds with fatal records and do not identify an affected PID or authenticate a caller. No matching row means unknown. Android may force-stop a target when instrumentation finishes, so a reported reason can be teardown following an earlier failure rather than its cause.

The owned Herdr case at source 78d9ca1 reached the later remote challenge assertion
after passing the actual docked-IME/native WebView bounds, whole canvas/keys/Esc/Tab
visual containment and post-dismiss terminal expansion checks. This is owned API 36
emulator evidence, not Samsung hardware acceptance or a complete case pass.
While Compose is open, its sheet covers the terminal output and the key row, so the
docked-IME check bounds the sheet, editor, Send and Close controls instead of the
canvas and keys. Send closes the sheet and refocuses xterm, which can reopen the
keyboard; a separate real-xterm browser fixture demonstrates that correct output plus
a later prompt remain in the buffer but cannot both be rendered at one visible row.
The native flow therefore dismisses the refocused keyboard ordinarily and reasserts
xterm focus before the unchanged non-echoable output and later-prompt checks. The
native clipboard paste that follows is checked as literal input without Enter before
an ordinary native Enter returns the prompt. It never injects terminal bytes through
a backend shortcut.

The independent native chooser failure remains observable through the existing
single tap and phone dialog assertion. A passive, case/token-owned observer retains
only finite geometry and trusted/target flags for pointer down/up/click; counts
are capped at 2 with an overflow flag. It records no field values, text or event
objects, changes no event behavior, and removes only its own listeners. Capture
and cleanup failures remain separate from the original assertion. Chromium's
[phone popup contract](https://github.com/chromium/chromium/blob/49ec12cc413ffec766028509968b31d7d65fa0b7/content/public/android/java/src/org/chromium/content/browser/input/SelectPopup.java#L137)
does not justify replacing the dialog matcher without an observed cause.


## Foreground Android clipboard (#523)

Explicit terminal Paste actions and attachment image Paste use app-private Android
mobile commands behind the main-window ACL and original native access lease. The
plugin explicitly rejects renderer plugin commands, preventing SDK mobile fallback. It reads only while its current Activity
is resumed and its current WebView is attached, shown and focused. Pause, focus,
document/Activity replacement, app locking and exact-owner cancellation invalidate
the read. No startup reads or clipboard listeners are installed. Other platforms
retain browser clipboard behavior; Android denial never falls back to browser reads.

One supervised provider worker has no queue and a five-second operation budget.
Cancellation signals the provider and closes its descriptor; an uncooperative provider
keeps the slot occupied until it actually exits. This cannot force termination of
arbitrary provider code. Errors contain closed categories, never clipboard contents,
URI strings or provider exception messages. Text uses the existing 64 KiB UTF-8
terminal input budget including bracketed-paste framing, without truncation or Enter.
Images require content URIs, PNG/JPEG signatures, 10 MiB actual stream bounds, at most
8192 pixels per dimension and eight megapixels.

`NativeWorkspaceTest` seeds synthetic ClipData and pastes a literal comment suffix
through the normal toolbar, retaining original native Enter and remote output checks.
Its plain SSH case uses an instrumentation-only UID-restricted synthetic provider
for PNG/JPEG preview, no automatic upload, non-content URI and oversize rejection.
The production APK contains no fixture provider or automation command. Original
deadlines and owned SSH shell lifetime are unchanged. The TS SSH fixture has no SFTP
subsystem/dispatch option; the separate Rust OpenSSH owner supports internal SFTP but
does not share that ForceCommand. This case does not add actual Android upload proof.
Explicit upload remains covered by existing attachment UI and Rust SFTP owners;
packaged Android upload and physical Samsung/SwiftKey behavior remain separate under
#20. Packaged clipboard behavior remains unverified until its owning run completes.

Clipboard admission uses the existing native-consent permit pattern rather than
relying on dispatch FIFO. Tauri 2.12.5 queues mobile commands through the Android
context; Wry 0.57.1 resolves its Activity/WebView when the JNI message is dequeued.
A delayed command therefore cannot establish ownership from whichever context is
current at that later point. Rust issues a private, single-use nonce bound to the
original access lease, request kind and document. Immediately before primary-clip
capture, Kotlin invokes one fixed JNI admission action; it cannot supply a renderer
callback. Cancellation and current-owner lifecycle/rebind events revoke the permit
synchronously. Provider work separately checks that original authority.

A cancelled slot remains occupied until native retirement acknowledges no admitted
worker or completed worker cleanup. Normal native completion retains the original
authority until Rust consumes the response, so closing a watch sender cannot turn
a successful response into cancellation. Late cancellation/retirement for A cannot
affect private permit B. The selector checks cancellation before polling native
dispatch. Regression owners cover cancel-before-admission, rebind before admission,
one-shot replay, original access/deadline, and successful response retirement.
Terminal reads also retire when their tab, connection or terminal context leaves,
including leave-and-return transitions. Browser fallback requires exactly boolean
false from the protected platform probe; malformed results never grant fallback.

At source `e3d3cfa9`, run40956660183/job123742295599 passed actual native literal
clipboard text, no-Enter and retained-focus checks in both owned SSH cases, then
failed the unchanged output-plus-later-prompt assertion. Artifact12936585942 SHA256
`03d5e00764ab93a75328078e94701aa533681824749f0003325b08c2ef336c97`
records an IME window at failure and hide-before-read followed by a later IME show
in both cases. Exact output-stage row geometry was not retained. The real-xterm
browser owner holds the native read and demonstrates that early dismissal can be
undone by delayed refocus; dismissing after completion restores the same visible
output/prompt oracle. The first fixture repair moved its same ordinary
dismissal after literal paste/focus acknowledgement and rechecked focus before its
unchanged native Enter. This was a test-precondition repair, not a production IME
policy change or proof of the precise failed row count. Image preview was not
reached in that run and remains unverified until the next owning runtime result.

At `3cf57504`, run40963042408/job123765068865 passed native text and the original
submission/output/prompt oracle in plain SSH, then failed before image reads because
the helper used `Attachments` while the real navigation caption is `Attach`. The
caption is corrected from the existing App/i18n/browser contract. Herdr stopped at
the earlier visible-literal acknowledgement with an IME window present; its data
does not distinguish clipping from a read failure. Artifact12938407687 SHA256 is
`20d771b4195ab8957d0cc972376d28d1b8a5c244d7f6dc3b0c9d74e8e3f6342b`.

The real Paste button now exposes its existing single-read ownership as `aria-busy`
and is disabled while pending. The native owner waits for client settlement and
focus, dismisses ordinarily, then checks the exact visible literal/no-Enter and
unchanged native Enter/output/prompt assertions. Idle cannot grant a pass, and no
payload or test-only completion API is exposed. Image reads remain unverified until
the case actually reaches them. Existing held-read tests cover current, stale/ABA
and unmounted completions; the isolated real-xterm clipping owner remains intact.

Source contracts: [Tauri mobile dispatch](https://docs.rs/crate/tauri/2.12.5/source/src/plugin/mobile.rs),
[Wry Android main pipe](https://docs.rs/crate/wry/0.57.1/source/src/android/main_pipe.rs).

Clipboard platform metadata is now preflighted after the existing native access
readiness acknowledgement, without reading clipboard data or blocking workspace
readiness. Only an exact boolean for the current access lease is cached. Unknown
or failed metadata fails closed; both Paste controls show localized checking/retry
labels. Retry checks metadata only and requires a new explicit Paste gesture. On
known non-Android and browser routes, text/image browser reads start synchronously
within that gesture, before any await. Android errors never fall back. Held probe,
lease replacement, malformed result, synchronous browser dispatch, and current/stale
read ownership are covered by the existing adapter/control/bootstrap owners.
This preserves the gesture required by WebKit's full DOM-paste access contract; it
is source-supported prevention, not a claim that a macOS runtime failure was seen.

At `4102aa6e`, run40972168595/job123795156355 passed the complete Herdr case
(61.591s), including literal clipboard text/no Enter, native Enter/output/prompt,
persistent-board lifecycle and guarded Chat; its host verified exact receiver bytes
and identity. Plain SSH reached first PNG setup only after its text assertions, then
the standalone instrumentation-provider process failed with
`NoClassDefFoundError: kotlin.jvm.internal.Intrinsics` at
`OwnedClipboardProvider.getType`. Artifact12943245679 SHA256 is
`fc8f378b56d7eb7c0488ab45181e005b855b425a8fa77b95d32cf0a7ee3a3f2a`.
The provider is now framework-only Java to avoid depending on the target app's
Kotlin runtime in its own process; URI/caller/content/size and file retirement checks
are preserved. No image preview was qualified by that aborted run. Host cleanup
reported no failure; the aborted SSH native finally remains unconfirmed. Manual
Android upload remains unexecuted; the next packaged case must qualify image reads.


The existing `test:android-ssh` owner also selects `ownedSshImeTransactionsThroughRealUi` through `LAZYSH_ANDROID_UI_IME=1`, with separate `ssh-ime-ui` reports. This opt-in case uses the current packaged app, ordinary hostkey/authentication UI, a source-bound raw receiver, and the test APK's fixed-operation InputMethodService. It never navigates to the separate Vite IME harness. In the closed `--ime-transactions NONCE` mode, the receiver emits a nonce-bound READY only after raw-mode/pid setup. After that genuine banner, native composing correction, tail extension, two ASCII deletions and an intentional repeat must produce exactly `there\x7f\x7fthe`, followed by six SwiftKey-shaped transactions (a predictive word typed letter by letter, a gesture word committed whole, Backspace inside the composing region, autocorrect by erasing the previous word and committing its replacement, a Backspace after the toolbar Esc key, and a word typed as letter commits and rewritten through a composing region, which is how SwiftKey edits a Chromium editor) that must add exactly `owned swipe ten \x7f\x7f\x7f\x7ftan \x1b\x7fweb `; a later current-connection marker must arrive once and a retained old connection must add nothing. Native waits for a distinct nonce-bound DELIVERED banner before the line-break steps; the receiver emits it only after writing and flushing the exact fixed wire stream. An earlier acknowledgement cannot hide later unexpected bytes. Commit return values and remote editor readbacks are not host-delivery acknowledgements: the host independently checks exact receiver bytes and the observed receiver PID/birth/executable hash.

This case requires the owned API36 AOSP emulator and the existing explicit receiver binary admission. It checks normal text/non-password EditorInfo and the absence of `NO_PERSONALIZED_LEARNING`, retaining existing suggestion/autocorrect hints, and logs the exact numeric `inputType` and `imeOptions` the framework gave the editor (`lazysh-ime-editor`) with Private keyboard off and on.

After the transactions and line breaks, the same case turns **Private keyboard in the terminal** on through the real Preferences switch (Android only, off by default, never synced) and focuses the terminal again. The shell then restarts the keyboard's input, and the test IME must be given a text editor with the visible-password variation, no suggestions, no autocorrect and `IME_FLAG_NO_PERSONALIZED_LEARNING`. The fixed text `owned-private-NONCE` is committed through that editor; the receiver emits a nonce-bound PRIVATE banner only when the whole earlier wire plus the two line breaks and exactly that text have arrived, and the host byte oracle then requires those exact bytes with nothing extra. Switching the setting off must restore the ordinary editor setup. The setting is applied by the focused terminal editor only (the Chat composer and other fields keep Chromium's setup), through a `onCreateInputConnection` override spliced into the generated `RustWebView` with `WRY_RUSTWEBVIEW_CLASS_EXTENSION` in `.cargo/config.toml`. This proves the setup and exact delivery on an AOSP emulator; it is not SwiftKey, Samsung or Gboard behavior. Fixture admission checks matched APK signers; provider access stays target-UID scoped with a fixed nonce, no arbitrary text arguments and only fixed transaction names. The original default/enabled IME state is restored before ordinary host cleanup; primary and cleanup failures remain distinct. No changed timeout, injected DOM value or replacement terminal wire is used. Local compilation/contracts do not establish native acceptance; physical SwiftKey/Samsung/Rex behavior, Unicode/non-tail edits and full IME parity remain unqualified.


The existing `test:android-ssh` owner selects the D-pad checkpoint with `LAZYSH_ANDROID_UI_DPAD=1` and separate `ssh-dpad-ui` reports; the generic Android suite excludes its fixture-dependent method. The packaged app authenticates to the owned SSH server, uses normal Preferences → Keyboard and gestures → Toolbar keys and order → Add dpad, and restores that toolbar change afterward. A real native tap sends one Up; a separate trusted MotionEvent stream retains one pointer/downTime from DOWN through held Up, Left, Down, Right and neutral MOVE phases before one UP. No injected DOM events or replacement terminal are used.

The closed test-only receiver mode `DIRECTORY --dpad-pan NONCE` validates a 32-lowercase-hex nonce before output mutation. READY follows raw mode/PID setup. Bounded nonce-bound counts are emitted only after each complete arrow has been written/flushed; progress alone is not a quiescence barrier. Within the original five-second gesture budget, native checks the rendered neutral state, allows 240ms to settle, snapshots counts, then verifies no change across another 240ms neutral pause and a 240ms post-UP pause. Native adds the D-pad toolbar preference (restoring it on cleanup) and sends exactly `owned-dpad-NONCE` once through ordinary Compose/Insert without Enter and waits for the real server DELIVERED banner before Disconnect. A fresh private count-only receipt is read using the existing retained-APK/run-as pattern; independent host PID/birth/executable/ancestor checks and final exact raw bytes must match that snapshot. Extra, malformed or reordered bytes remain failures even after an earlier progress/DELIVERED banner. Default silent receiver and IME mode behavior, hard 16KiB bound, private no-overwrite files and original timeouts remain intact. Local compilation/contracts are not actual Android execution, physical-device, keyboard or performance qualification.

The same raw-navigation case has a separately named `verifyPastBottomKeyboardDismiss` checkpoint after D-pad stop snapshots and before its unchanged drain marker. If an earlier D-pad assertion fails, this checkpoint is not reached and must not be counted as passed. It closes the pad normally and keeps the ordinary admitted AOSP LatinIME selected; the one-pixel owned test IME is never enabled or used for visibility. Real native IME insets, positive keyboard height and the resized WebView prove visibility before each attempt. The default-off upward stroke must leave that keyboard visible. After explicit normal-UI opt-in, Preferences is closed and the keyboard is freshly reopened/proved visible before another trusted physical finger-UP stroke (56 CSS pixels, positive wheel/toward bottom) must make the native IME hidden. Settings focus changes cannot satisfy that outcome.

The controlled shell/raw receiver never enables alternate-screen or mouse reporting. Each stroke uses one native DOWN, two monotonic upward MOVE events and one UP, with the original focused/resumed Activity, WebView/document/session retained. A nonce-owned passive capture receipt on the original scroll owner is registered after the app listeners; only bounded counts/trust/contact/retention/focus/direction booleans are read. Within the same five-second stroke budget, each actual DOM MOVE must be received before the next injection, and actual END receipt precedes keyboard outcomes; Window dispatch alone cannot qualify a coalesced or unprocessed move. The default-off editor must remain focused and the enabled editor must actually blur. The passive observer is removed independently without replacing the original failure. Geometry must fit the visible terminal above the real keyboard; insufficient 48-CSS-pixel room refuses admission. Keyboard readiness and each stroke retain the existing five-second bounds. No DOM input setter, fake touch event, keyboard-hide call, IME selection/flags change, new receiver protocol or CI flag is added. The existing final host byte oracle still requires the pre-overscroll stopped counts plus the fixed marker, so delayed extra input also fails. Normal UI restores the opt-in preference and toolbar; CANCEL/window-observer and preference cleanup preserve the primary failure. Named `checkpoint=reached`, `defaultOffVisible=true` and `nativeVerified=true hostByteOracle=pending` observations distinguish the native substage from later host-byte acceptance. Only the native `ssh-dpad-ui` run establishes Android emulator acceptance; local compilation and embedded-source models do not, and neither covers physical devices, other keyboards or performance.
The two packaged raw-input cases explicitly request `ownedReceiverRoot` in the
existing private-TTY SSH fixture. This reuses the protected owned root and private
NSS-home mounts already used by the Herdr fixture; it does not weaken the receiver's
ancestor ownership checks. Other SSH/Mosh/companion callers retain their prior
namespace. The option rejects tool, companion, Mosh, shared-navigation or non-private
TTY combinations before starting a process. The existing host owner includes an
`owned namespaced SSH raw receiver root` negative/positive control selected by
`LAZYSH_TEST_SSH_USER_NAMESPACE=1` and `LAZYSH_TEST_RECEIVER_BIN`: the old root must
reject before receiver output creation, while the owned root must deliver the exact
fixed IME wire through the same source-bound receiver. This host check is not an
Android input or gesture acceptance result.

The existing Linux namespaced-SSH CI selector includes this host control. Its source
image may retain Cargo executable permissions: admission requires an owned regular
non-link file (including Cargo hardlinks), owner execute and no group/other write. The actual
private execution copy remains single-link mode0500 with byte equality and ancestry checks.

### Recorded Conversation through owned SSH

The existing uncached `test:android-ssh` owner selects `ownedRecordedConversationsThroughRealUi` in its separate `recorded-conversation-ui` report namespace. It uses the current source-built host companion from `LAZYSH_TEST_AGENT_BIN`, ordinary packaged-app SSH authentication and small shared synthetic Codex/OpenCode V1/V2 records. The public specification is reused by the Rust reader tests; it is not an official CLI capture. Private official-corpus compatibility evidence is kept separately. After those records it opens eight pages built from `apps/agent/tests/fixtures/interaction-cards` (`tests/support/recordedCards.ts`): Claude waiting on a question and then answered with a proposed plan, a Claude turn with Markdown and collapsed thinking, Codex working, stopped and idle turns, Codex recorded plan and question cards, and OpenCode V1 todos with a multiple-choice question. Each page must render the exact card, status and Markdown text the fixture names. The Linux native GUI suite (`apps/client/native-e2e/ssh.spec.ts`) runs the same records and pages in `native-linux`.

The case requires exact selected messages, real reader overflow, Home/Refresh reading position and draft retention, return to the original terminal, explicit Stage without Send, and a fresh non-echo SSH challenge. Host checks retain the readonly corpus and companion hashes and original cleanup. Ordinary Android tests exclude this fixture-requiring method; its guarded host owner supplies the fixture and requires the exact executed JUnit case without skips. Compilation alone does not qualify this native flow, Android/vendor keyboards, or full platform parity.

## Gesture navigation and Samsung One UI (#1380)

The phone gestures (side menu, bottom menu, Agent view switch) start from handles and from swipe bands beside them, whose position comes from the live window insets. Android's own Back and Home gestures are detected from the screen edge, so a swipe that starts at the edge is the system's and the app never sees it. The app therefore does not compete for the edge: on gesture navigation a swipe starts in a band that begins just outside the system zone, `[system inset + 4 dp, system inset + zone width]` (default zone width 40 dp, so about 36 to 76 dp from the edge under the default Back sensitivity, 44 to 84 dp with the widest; Preferences allows 16 to 96 dp). The part of the band below the system inset is never claimed, the swipe must still travel inward past the 4 px slop with the direction lock, and the typing and selection guard still applies. On three-button navigation the system keeps no zone, so the band starts at the edge. The Edge swipes style (advanced) still starts at the physical edge and asks Android to exclude the handle rows. The Android shell reads `WindowInsetsCompat.Type.systemGestures()` and `Type.mandatorySystemGestures()` (and the `navigation_mode` setting as a hint), subtracts the padding the WebView already has, and hands the web layer the part of each system zone that reaches into the viewport: `{left, right, bottom, mandatoryBottom, navigation}` in dp. The web layer asks for it with the `edge_gesture_insets` command at start and hears every change as a `lazysh-gesture-insets` window event.

What each layer proves:

| Layer | Proves | Where |
| --- | --- | --- |
| JVM unit test | Exclusion rows are at most 200 dp, the bottom zone is never thinner than the launcher's swipe-up strip, stay above the bottom gesture zone and inside the window, for every navigation overlay (three buttons, `gestural`, `gestural_wide_back`, `gestural_extra_wide_back`), density and zone width; a zone counts only where it reaches past the padding; the JSON the shell sends | `EdgeGestureBandsTest` |
| Instrumented test | The real WebView keeps the claimed rects within its bounds and releases them; the reported insets are never negative and never exceed the window's own gesture insets (`NativeEdgeGestureExclusionTest`). Under each navigation overlay (`cmd overlay enable-exclusive`, restored in `finally`) the zones are the system's, the Home zone reaches the launcher's swipe-up strip, the claimed bands stay within the view, 200 dp and above the mandatory zone and follow a layout change; the IPC refuses a row over 200 dp or a zone outside 1 to 96 dp; after the activity is recreated the claims and the insets belong to the window in front and Back closes an open page first, 100 cycles (#1435, #1449) | `NativeEdgeGestureExclusionTest`, `NativeGestureNavigationTest` |
| Vitest and Playwright | The band follows the simulated insets (gesture navigation against three buttons, narrow and wide Back sensitivity, zone width): a touch at 0 dp or inside the system inset is ignored, inside the band it fires, beyond the band it is ignored; the typing and selection guard still applies The overlay matrix (`src/test/gestureOverlays.ts`, the geometry written out independently of the engine) tries 0 dp, inside the system zone, both ends of the band, its middle and just beyond it on each edge for every overlay, zone width (16, 40, 96 dp) and gesture style; Escape, the close buttons, the scrim and the opposite swipe close the navigation page and the bottom menu, and a Back handler exists whenever one is open, 100 cycles | `gestureInsets.test.tsx`, `gesture-matrix.spec.ts`, `App.test.tsx`, `TerminalPane.test.tsx`, `edgeGestures.test.tsx`, `edge-gestures.spec.ts`, `bottom-menu.spec.ts`, `view-swipe.spec.ts`, `side-menu.spec.ts`, `gesture-test.spec.ts` |
| Manual, real device | Home, Recents and Back are not triggered, and the menus open every time | the script below |

The CI emulator uses three-button or no system navigation, so it cannot show whether the system takes a swipe. Waydroid can: its Android 13 image carries the AOSP gestural overlays and the Quickstep launcher (see "Waydroid verification" below). Real-device validation on a gesture-navigation Samsung One UI phone is still a required acceptance gate for #1380 and has not been run; record every run in the table at the end.

### Waydroid verification

Run on the local Waydroid session (Android 13, x86_64, AOSP SystemUI with the Quickstep launcher) with the debug emulator build and `wm size 1080x2340; wm density 420` (a 411 x 815 dp phone viewport, density 2.625). The app connected over SSH to a throwaway `sshd` on the host (the guest reaches it at 192.168.240.1) with a throwaway key. Swipes are `adb shell input touchscreen swipe` (a real DOWN, MOVEs about 8 ms apart, UP; the system gesture monitors see them as they would a finger). State is read from the page over the WebView DevTools socket (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`): the side menu, the bottom menu, the session view and every touch the page received (`touchstart`, `touchend`, `touchcancel`). "Reached the app" counts a `touchstart` in the page; a count below ten means the system took the touch.

Navigation is switched with `cmd overlay enable-exclusive --category com.android.internal.systemui.navbar.threebutton` or `...navbar.gestural_wide_back`, then `settings get secure navigation_mode` (0 or 2) and the launcher check `cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME` (`com.android.launcher3.uioverrides.QuickstepLauncher`). Gesture style was set in the Preferences UI.

Handle build (before the swipe bands, see the band table below for the final build), ten tries each, every figure is opened (or closed) / tries:

| Navigation | Gesture style | Gesture | Result |
| --- | --- | --- | --- |
| 3-button | Automatic (edge swipes) | Left edge swipe, side menu | 10/10 (4/10 before the slop fix below) |
| 3-button | Automatic (edge swipes) | Bottom edge swipe, bottom menu | 10/10 |
| 3-button | Automatic (edge swipes) | Right edge swipe, Agent view | 10/10 |
| 3-button | Automatic (edge swipes) | Back key closes the side menu / the bottom menu | 10/10, 10/10 |
| 3-button | Handles | Drag the left / bottom / right handle | 10/10, 10/10, 10/10 |
| 3-button | Handles | Tap the left / bottom / right handle | 10/10, 10/10, 10/10 |
| 3-button | Handles | Back key closes the side menu / the bottom menu | 10/10, 10/10 |
| Gesture (`gestural_wide_back`) | Handles | Drag the left / bottom / right handle | 10/10, 10/10, 10/10 |
| Gesture | Handles | Tap the left / bottom / right handle | 10/10, 10/10, 10/10 |
| Gesture | Handles | Back key closes the side menu / the bottom menu | 10/10, 10/10 |
| Gesture | Handles | System Back gesture (edge swipe from x=2) closes the bottom menu / side menu / Agent view | 10/10, 10/10, 10/10 (0/10 before the scrim fix below: the app exited) |
| Gesture | Handles | Tap on the bottom menu scrim closes it | 10/10 |
| Gesture | Edge swipes | Left / right edge swipe at the claimed row | 29/30 (one of the first thirty went to the system), 10/10 |
| Gesture | Edge swipes | Bottom swipe from just above the Home zone | 10/10 |
| Gesture | Edge swipes | Left edge swipe outside the claimed row, bottom menu open | 10/10 taken by the system as Back (menu closed, side menu not opened), the page got `touchstart` then `touchcancel` |
| Gesture | Edge swipes | Swipe up from inside the Home zone (y 2300) | 3/3 taken by the system (the launcher came to the front) |

Swipe bands (the final build, ten tries each unless stated; band geometry as in the introduction, gesture style Automatic, zone width 40 dp). A swipe is `adb shell input touchscreen swipe x y x' y' 200` and `x` is in screen px (2.625 px per dp). "Taken by the system" is measured with the bottom menu open, so the system Back that ends the swipe does not leave the app: the menu closes, the side menu does not open, the app stays in front.

| Navigation | Start of the swipe | Expected | Result |
| --- | --- | --- | --- |
| `gestural_wide_back` (inset 32 dp, band 36 to 76 dp) | left, x=100 / 131 / 195 px (38 / 50 / 74 dp) | side menu opens | 10/10, 10/10, 10/10 |
| | right, x=930 px (57 dp from the right edge) | Agent view opens | 10/10 |
| | bottom, y=2150 px (48 dp above the viewport bottom; the band is 28 to 68 dp) | bottom menu opens | 10/10 |
| | left x=2 px (0.8 dp) and x=60 px (23 dp, inside the inset) | taken by the system | 10/10, 10/10 |
| | right x=1078 px and x=1030 px | taken by the system | 10/10, 10/10 |
| | left x=230 / 262 px (88 / 100 dp, beyond the band), right x=830 px, bottom y=2050 px (86 dp) | nothing opens, the page gets the touch | 10/10 each |
| | up from y=2300 px (inside the Home strip) | taken by the launcher | 3/3 |
| | vertical swipe, tap, selection active, toolbar swipes and taps inside the band | nothing opens; the toolbar still pages (10/10) and its keys still click (10/10); with a selection the band swipe is ignored 5/5 and opens again 5/5 once the selection is cleared | as listed |
| | drag / tap the left, bottom and right handle | menus open | 10/10 each (six rows) |
| | system Back gesture from x=2 closes the bottom menu / the Agent view | menu closed, app kept | 10/10, 10/10 |
| `gestural_extra_wide_back` (inset 40 dp, `mEdgeWidthLeft=105`, band 44 to 84 dp) | left x=120 / 168 / 215 px (46 / 64 / 82 dp) | side menu opens | 10/10 each |
| | right x=900 px, bottom y=2150 px | Agent view / bottom menu opens | 10/10, 10/10 |
| | left x=2 px and x=90 px (34 dp: outside the Wide setting's inset, inside this one), right x=1078 px and x=990 px | taken by the system | 10/10 each |
| | left x=250 / 300 px (95 / 114 dp), right x=830 px, bottom y=2050 px | nothing opens | 10/10 each |
| | zone width 96 dp: left x=350 px (133 dp) / x=400 px (152 dp) | opens / does not | 10/10, 0/5 |
| | zone width 16 dp: left x=150 px (57 dp) / x=190 px (72 dp) | opens / does not | 10/10, 0/5 |
| 3-button (no system zone, band 0 to 40 dp) | left x=2 px (edge) and x=90 px (34 dp), right x=1078 px, bottom y=2205 px | menus open | 10/10 each |
| | left x=150 px (57 dp, beyond the band) | nothing opens | 10/10 |

The same swipe is taken by the system or by the app depending only on the inset the shell reports, which follows the Back sensitivity overlay: the Wide and Extra wide overlays gave `{"left":32,...}` and a 40 dp inset (`mEdgeWidthLeft=84` and `105`), and the band followed with no setting changed. Test gestures (Preferences) printed `Swipe from the swipe area beside the left edge reached the app (194 px)` for x=131 and `Swipe from the left edge was taken by the system` for x=40, with `System zones: left 32 dp, right 32 dp, bottom 24 dp, Home 24 dp`.

Gesture navigation as the system reports it (`dumpsys activity service com.android.systemui/.SystemUIService`, `EdgeBackGestureHandler`): `mIsGesturalModeEnabled=true`, `mEdgeWidthLeft=84`, `mEdgeWidthRight=84` (32 dp), `mBottomGestureHeight=84.0`, `mExcludeRegion=SkRegion()` with the app in Handles mode (no exclusion claimed). `dumpsys window`: `ITYPE_LEFT_GESTURES frame=[0,0][84,2340]`, `ITYPE_RIGHT_GESTURES frame=[996,0][1080,2340]`, `ITYPE_BOTTOM_MANDATORY_GESTURES frame=[0,2256][1080,2340]`, `system_gesture_exclusion_limit_dp=200`, `mSystemGestureExclusion=SkRegion()`. In Edge swipes mode the app claims exactly its rows: `mSystemGestureExclusion=SkRegion((0,1478,63,2003)(1017,1478,1080,2003))` (24 dp wide, 200 dp tall, ending 104 dp above the bottom edge of the viewport). The Quickstep touch region (`dumpsys activity service com.android.launcher3/com.android.quickstep.TouchInteractionService`): `currentTouchableRotations=RectF(0.0, 2214.0, 1080.0, 2340.0)`, `mNavBarGesturalHeight=126`. The app's reported insets (the `lazysh-gesture-insets` event): `{"left":32,"right":32,"bottom":24,"mandatoryBottom":24,"navigation":"gesture"}` (and `bottom: 0` with the keyboard open), `{"left":0,"right":0,"bottom":0,"mandatoryBottom":0,"navigation":"buttons"}` with three buttons. Screenshots from the run: `/tmp/gw-16-3btn-terminal.png`, `gw-17-left-edge-3btn.png`, `gw-20-3btn-bottom-menu-open.png`, `gw-30-3btn-handles.png`, `gw-33-gestural-handles.png`, `gw-37-gestural-handles-fixed.png`, `gw-40-gestural-bottom-menu.png`, `gw-44-gestural-edges-mode.png` (kept on the author's machine, not in the repository).

What the run found, all fixed in this change:

1. **The edge recogniser never saw the swipe (left edge 4/10 on three-button navigation).** The engine waited for 10 CSS px of movement before deciding, but Chrome sends the first `touchmove` once the finger has crossed its own touch slop (8 dp) and that move is the last cancelable one; the following moves are not, and the page scrolls. The failing tries had a cancelable first move at dx 8 to 9 and then only non-cancelable ones. The decision slop is now 4 px (`edgeGestures.ts`), so the first move decides. 10/10 afterwards, on all three edges.
2. **The bottom handle sat inside the Home strip (0/10 on gesture navigation).** The insets report the 32 dp mandatory gesture zone, but the launcher takes any touch that starts in the bottom `navigation_bar_frame_height` (48 dp, `mNavBarGesturalHeight=126`), and the navigation bar window already covers 24 dp of that. The app reported 8 dp, so the handle (and the side rows) were drawn 8 dp above the screen's bottom padding and every drag from it went Home. Swipes began to reach the app at y 2214 (screen px) and above, exactly the launcher region. `EdgeGesturePlugin.kt` now never reports less than that strip when `navigation_mode` is gesture (`EdgeGestureBands.homeZone`, unit-tested); the handle moved up 16 dp and opens the menu 10/10, by drag and by tap.
3. **The system Back gesture exited the app instead of closing the bottom menu.** The bottom menu's scrim closed it on `pointerdown`. The Back gesture's finger lands on the scrim first (the system takes the touch a few milliseconds later), so the menu was already closed, the app had no Back handler registered any more and Back left the app (the logcat shows `Tauri/Plugin: app, command: removeListener` one millisecond after the gesture monitor stole the touch). The scrim now closes on `click`, which a touch the system took never produces, like the side menu's scrim.
4. **The left side-menu handle was not wired** now that the side menu (#1360) is on `main`: `App.tsx` renders `<GestureHandle edge="left" gesture="leftMenu">` while the menu is closed and the left swipe is enabled.

Left unverified on Waydroid, to be run on the real One UI phone below: One UI's own gesture hint strip, Back gesture sensitivity, the Edge panel and Samsung's gesture area (Quickstep's 48 dp region is the AOSP value; One UI's launcher may use another), a physical finger instead of injected events, rotation, the display cutout, predictive back animations, and `systemGestureExclusionRects` being honoured by the Samsung gesture handler. Two observations without a cause: one of thirty left-edge swipes in the Edge swipes style at the claimed row did not open the menu (the page saw `touchstart` then `touchcancel`; twenty more opened it), and twice, right after the activity was recreated by switching the navigation overlay and reconnecting, the first Back key after opening the side menu left the app instead of closing the menu (the app then showed its start page; it did not recur in the many Back presses before and after, and it is outside the gesture code, which only calls `onBackButtonPress`'s handler).

### Manual One UI script

Use a release or debug build with the gesture style left on **Automatic** (Preferences → Keyboard and gestures → Terminal touch gestures → Gesture style). Connect a session so the bottom bar and the Agent view are available. Repeat the whole script for each Settings → Display → Navigation bar combination:

1. **Swipe gestures** → **Swipe from sides and bottom**, with Back gesture sensitivity at its default, then at its highest.
2. **Swipe gestures** → **Swipe from bottom** only.
3. **Navigation buttons** (three-button navigation). Here **Automatic** must pick edge swipes.

For each combination:

1. Open Preferences → Keyboard and gestures → **Test gestures**. Write down the navigation line, the system zones (left, right, bottom, Home) and whether the diagram draws a red band on every side the system owns. Rotate the phone and write the zones again; they must change with the window. Open the Edge panel handle (if enabled) and note whether the zones change.
2. On that page swipe in from the left edge, the right edge and up from the bottom edge, ten times each. Under gesture navigation the system is expected to take most of these (the page then says so); write down how many of the ten it took on each edge, and whether any of them triggered Back, Home or Recents. That shows which edges the app cannot rely on.
3. Go back to the terminal. Drag the **bottom handle** up ten times in a row (close the menu with the grip, Back or a swipe down between attempts). The menu must open all ten times without Home or Recents appearing. Tap the handle ten times: it must open every time.
4. Drag the **right handle** to the left ten times: the Agent view must open each time without Back firing. Return with a swipe from the middle of the screen to the right, or the Terminal button.
5. Swipe bands, with the gesture style on **Automatic** or **Handles**. Read the system zones from **Test gestures** (say 32 dp left and right, 24 dp bottom). Swipe inward, ten times each, from just beyond the zone (zone + 8 dp), from the middle of the band (zone + 28 dp) and from the far end of the band (zone + 36 dp, with the default 40 dp width): each opens its menu (left: the side menu, right: the Agent view, bottom: the bottom menu), and none triggers Back or Home. From inside the zone (zone - 4 dp) and from the edge itself the system must take the swipe (Back), never the app; from 20 dp beyond the end of the band nothing happens. Change Back gesture sensitivity and repeat: the band moves with the zone, with no app setting changed. Then raise the zone width in Preferences (up to 96 dp) and check the band follows it. Swipe up the screen's left band, tap in it, and select terminal text next to it: scrolling, taps and selection must keep working.
6. Press Back with the bottom menu open: it must close the menu and stay in the session. Press Back again: normal Back behaviour (nothing is trapped).
7. With the keyboard open, repeat step 3: the handle sits above the keyboard and still opens the menu.
8. Switch Gesture style to **Edge swipes (advanced)**. Swipe from the left and right edges at the height of the handles, and up from just above the bottom handle row, ten times each. Outside the handle rows the Back gesture must still work (swipe in from the left edge near the top: Back). Switch to **Off**: no handle is drawn, the visible buttons are the only way in.
9. Start typing and, while the keyboard is composing a word, drag a handle: nothing opens. Select text and drag a handle: nothing opens. Two-finger swipes bound to **Open the bottom menu** or **Switch between the terminal and the Agent view** (Preferences → two-finger swipe bindings) follow the same rule.

Record: device model, One UI version, Android version, navigation mode, back sensitivity, results per step (n/10), and any swipe that triggered Back, Home or Recents. A step passes at 10/10. A failing combination blocks closing #1380.

| Date | Device | One UI / Android | Navigation | Result |
| --- | --- | --- | --- | --- |
| not yet run | | | | |

Known unverified points (Android documents none of them): whether the 200 dp exclusion cap applies per edge or per window, whether a WebView honours exclusion rects set on it for every touch, and what the Edge panel and back-sensitivity settings do to the reported zones. The script records the evidence for each.
