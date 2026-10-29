# Published Android APK smoke

The **Published Android ARM64 APK smoke** workflow accepts a stable public
release tag on manual dispatch (initially `v0.23.0`). Narrow same-repository PR
changes to this gate also exercise that stable public tag before merging. Each Google/FOSS case receives a separate owned
hosted VM and fresh Google APIs API35 x86_64 revision9 guest. It downloads the
nominated public APK; it never rebuilds, resigns or enables debugging in that APK.

The gate binds the tag's resolved source commit to `release.json`, and compares
its nominated signed Android receipt with the GitHub asset's size/digest and the
actual downloaded bytes. It checks application ID, version/code, nondebuggable
manifest, the reviewed public certificate pin (set as `ANDROID_SIGNER_SHA256`, without secret
or signing-key access) and every packaged
native library's ARM64 path/AArch64 ELF header. This verifies the nominated APK,
not completeness of today's release inventory: the initial 0.23.0 release predates
the newer companion asset set. Existing public assets and tags are never changed.

A separately debug-signed, self-instrumenting UI Automator APK targets its own
`app.lazysh.acceptance` package. Its isolated Gradle project uses the existing
wrapper and test/toolchain versions; the workflow checks a driver-only dry run
before building. It does not depend on or configure the Tauri application project.
The production application is another process, observed through normal Android
accessibility actions. No production certificate, root, `run-as`, native IPC,
WebView debugging, injected JavaScript or app automation flag is used.

Admission requires the reviewed image revision and actual guest API35,
`x86_64,arm64-v8a` ABI list, `libndk_translation.so` bridge and ARM64-to-x86_64 ISA
mapping. The guest's boot identity and build fingerprint are hashed observations,
not invented fingerprint pins or proof of a physical ARM64 CPU. The existing
QEMU PID/start-time/executable/argv/camera attestation is reused unchanged. Its
fixed ownership name remains `lazysh-runtime-api36`; this name is a nomination
only, while the image/API admission here explicitly requires 35. The AVD must be
absent before creation; an existing application or driver package is rejected.

The external driver saves a unique synthetic `.invalid` host, without connecting
or supplying credentials. It opens Edit and checks the name, address and username.
The host then stops/relaunches the application, verifies the same fields,
rechecks the APK digest, runs ordinary `adb install -r` with those identical bytes,
and relaunches/reads the fields again. Successful durable save/list commands pass
through the shipping protected native bridge and Rust configuration path, giving
JNI/startup evidence beyond a surviving window. A locked guest or unexpected UI
fails the phase; there is no fallback input path or retry.

Only finite receipts are uploaded: nominated public identity/digests/certificate,
hashed guest identities, sampled admission and completed phase booleans, and
closed failure/cleanup stages. The parent UI phase and the whitelisted existing
driver assertion stage are separate; missing, conflicting or unrecognized driver
results remain unavailable. Original child output is discarded. Raw hierarchy, screenshots, APK bytes, local paths,
input values and child output are not uploaded. Only successfully installed owned
packages are uninstalled. A lost install acknowledgement is an unconfirmed
cleanup outcome, never permission to adopt or remove an unknown installation.
Original failure and cleanup failure remain separate. Foreground children and UI
phases have finite deadlines and output limits.

This is translated ARM64 install/JNI/UI/same-version persistence evidence. It does
not establish physical Galaxy/Samsung behavior, ARM64 performance, graphics,
battery/audio, cross-version migration or full native feature parity. First hosted
execution of both flavors is required before calling this gate verified.

Sources: [external release UI Automator contract](https://developer.android.com/training/testing/other-components/ui-automator),
[AOSP self-instrumentation example](https://android.googlesource.com/platform/docs/source.android.com/+/7409ec325d2ac879e4630701ce238089c3bd2b0b/en/compatibility/tests/development/instr-self-e2e.md),
[official Google API image catalog](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml),
[ARM translation scope](https://android-developers.googleblog.com/2020/03/run-arm-apps-on-android-emulator.html).
Refs #467.

The pinned action resets `ANDROID_AVD_HOME` to `$HOME/.android/avd` before creating
the AVD ([immutable installer source](https://github.com/mihazs/lazysh-android-emulator-runner/blob/46beb5d59b664ea61462125a023549a5a7b0418b/src/sdk-installer.ts#L39)); the absence check uses that exact location. No private-AVD-home support is assumed.

The first closed driver-stage run admitted translation for both variants, then
failed FOSS at `NAME` and Google at `WORKSPACE`. These are distinct observations,
not proof of one JNI or accessibility cause. Chromium's Android accessibility
[`GetHint`](https://github.com/chromium/chromium/blob/49ec12cc413ffec766028509968b31d7d65fa0b7/content/browser/accessibility/browser_accessibility_android.cc#L790)
can append an AX placeholder when present. The earlier audit incorrectly inferred
that an HTML placeholder guarantees that AX attribute. Actual admitted Google and
FOSS samples instead report label-only hints: `Name`, `Hostname or IP`, and
`Username`. The strict selectors now use those observed exact labels. Observation
categories retain independent literals for label/placeholder variants, so changing
a selector cannot silently redefine the evidence. No substring, positional or
JavaScript fallback is used. Nested owned failures
keep their nearest closed stage rather than being hidden by an outer workspace
stage. The workspace wait, overall deadline, actual UI actions and exact saved
field readback remain unchanged. Successful hosted completion remains required.

The composite-hint revision still failed FOSS at `NAME` and Google at `WORKSPACE`;
that hypothesis alone did not resolve either run. Failure receipts now separate
the input field and lookup/click/set/readback operation. The readback flag is the
result of the original comparison, not an extra read or replacement assertion.
One failure-only accessibility sample caps editable nodes at 8 with explicit
overflow and classifies hints only against the known labels/placeholders, empty,
other or unavailable. It never retains actual hint/value strings. Foreground,
screen and keyguard flags are sampled observations, not proof of startup cause.
Missing queries remain null/unavailable; malformed or unexpected host report
fields are discarded wholesale. Observation failure cannot replace the original
UI failure, and diagnostic metadata cannot satisfy the success protocol.

The public 0.23.0 APK predates the later branding and viewport repairs. A genuine
old-public startup or clipping defect may legitimately fail this gate until a
corrected version is published; the driver must not bypass normal UI to obtain
a passing receipt.

At driver head `9d966d2`, both flavors failed `WORKSPACE` before input, with the
target foreground, screen on/unlocked and zero sampled editable fields. That
stage did not distinguish its initial readiness wait from the final unique
Add-host lookup. Those unchanged operations now report `WORKSPACE_READINESS`
and `WORKSPACE_ADD_HOST` separately. A failure-only sample additionally projects
exact Add-host/Open-host accessibility matches as zero, one, multiple or
unavailable, and target WebView accessibility presence as a nullable boolean.
The sample checks the original remaining driver deadline before each query;
expired or failed queries remain unavailable. It does not retain labels or
hierarchies and does not prove what was present throughout an earlier wait.
The 0.23.0 nomination, selectors, actions, waits and success protocol are unchanged.
