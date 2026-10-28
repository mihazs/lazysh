# Real ntfy encrypted-challenge acceptance

This opt-in native fixture targets the enrollment interoperability left unverified
by the parser/Keystore tests. It does not enable host events or display a remote
notification. Source preparation and compilation alone are not a passing runtime
receipt; observed results must identify their exact checkout and artifacts.

The separate `native-android-ntfy` job owns a fresh API36 emulator and its own
35-minute budget. The original Android runtime job, order and 30-minute limit are
unchanged. Its imagefile camera arguments are used only to reuse the existing
exact emulator-process attestation; this test never opens a camera or physical
device. No app subscription or paid provider account is required.

## Pinned upstream software

[ntfy-provenance.json](../apps/client/src-tauri/fixtures/ntfy-provenance.json)
pins the official ntfy2.34.0 Linux archive and ntfy Android1.25.2 F-Droid release,
their SHA256 digests and the documented Android signing certificate. Both upstream
sources use Apache-2.0. The fixture verifies archive/member type, whole artifact
hashes, APK identity/signature and a complete bounded dex scan for Google/Firebase
components before installation. The existing app artifact oracle independently
checks lazysh's native FOSS dependency graph. No upstream Go code is authored or
modified; the unmodified official server is an external test dependency.

The pinned F-Droid APK retains an inert Firebase action and notification-icon
metadata for its upstream dummy `android.app.Service` implementation. Only those
exact manifest tag shapes are admitted; Google push classes, components,
permissions and altered declarations remain rejected. This is not a namespace
exemption for executable Firebase code.

The selected distributor uses the connector SDK's supported older Android
protocol compatibility path. This is not a claim that ntfy1.25.2 implements every
AND_3.1.0 feature or enforces the application's VAPID key at registration.

## Ownership and trust

Run `bun run test:android-ntfy` only on the explicitly selected owned Linux/x86_64
emulator. The task builds the current F-Droid native app and native Rust test
fixture through Turbo/Cargo. The existing PID/start identity/UID/executable/AVD,
unique port and imagefile/front-none attestation runs before commands and cleanup.
All three fixture packages must initially be absent; no personal app data is
cleared to make that precondition pass.

The fixture owns loopback TLS listeners, exact no-rebind adb reverse mappings,
private temporary files and foreground child processes. A nonce-bound input file
is transferred over stdin into the debug app's private namespace with mode0600;
credentials never become command-line arguments or WebView inputs. Android reads
it without following a final symlink, checks its owner/type/size/mode and removes
it. Native credential values enter the actual secure dialog's fields; this is
programmatic native-field entry, not a physical keyboard accuracy test.

The native Gradle property `lazyshUnifiedPushAcceptanceCa` is accepted only for
an explicit small debug-task allowlist with the exact F-Droid provider project.
It generates a debug resource overlay containing one owned bounded CA and
Android's `debug-overrides`; the base network policy is preserved. The CA is not
an IPC/preference/environment HTTP override. Enrollment uses its unchanged
production HTTP constructor with certificate and hostname validation enabled.
The unknown-CA case must preserve the fixed redacted production failure; the
owned peer independently observes a rejected TLS handshake and zero HTTP calls.
Ntfy trusts its exact owned server certificate through its supported certificate
review UI, after matching the full SHA256 fingerprint. System trust is untouched.

The normal artifact gate checks both the fixture CA filename and decoded XML for
absence. The acceptance APK must contain exactly the owned CA, remain debuggable
and retain the current canonical native library byte-for-byte. Afterward the
fixture rebuilds ordinary debug and release resource artifacts without the
property and checks absence again. That release resource check skips native Rust
release compilation and is not full release-build/runtime proof. The fixture APK
is private test output and is never included in the job's artifacts.

## Actual oracles and limits

The native test opens real ntfy settings and the lazysh native credential dialog,
then uses the ordinary registration and relay code. A test-only relay gate waits
until the Activity is backgrounded before sending its real encrypted challenge.
The SDK must decrypt it and the native state must bind the original device and
generation. The server independently observes an accepted confirmation with an
active exact-generation subscription. The app then pauses through protected IPC,
and both native cleanup and authenticated server revocation must complete.

The original encrypted wire is replayed through real ntfy while confirmed and
after pause. The bounded observation requires only one server confirmation and
no restored native authority. Transport acceptance of a replay is not proof that
every replay callback ran, nor a universal exactly-once guarantee. The Activity
background case is not Doze, process death, battery-optimization or physical-device
background-delivery acceptance. Event delivery remains disabled throughout.

Framework reports/logcat may contain upstream registration metadata. They remain
in the private temporary directory and are removed during owned cleanup. Only
finite JSON stage/exit/pass/ownership/provenance receipts are uploaded; raw
credential, endpoint, message, private error or screenshot output is excluded.
Cleanup preserves the primary failure and reports a separate finite cleanup
failure. Normal native JUnit/Cargo/Bun checks and independent security review are
required before the PR hook; real hosted native execution is required for a
runtime claim.

Primary references: [UnifiedPush Android specification](https://unifiedpush.org/developers/spec/android/),
[ntfy distributor/self-hosting](https://docs.ntfy.sh/subscribe/phone/#unifiedpush),
[ntfy private server UnifiedPush ACLs](https://docs.ntfy.sh/config/#example-unifiedpush),
[Android debug trust overrides](https://developer.android.com/privacy-and-security/security-config#debug-overrides),
[Android14+ Conscrypt trust store](https://source.android.com/docs/core/ota/modular-system/conscrypt),
and [APK Analyzer resource commands](https://developer.android.com/tools/apkanalyzer).
