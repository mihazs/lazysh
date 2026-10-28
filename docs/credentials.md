# Credentials and SSH identities

Connection metadata lives in `hosts.json`. Passwords, private keys and passphrases are kept in memory by default. The connection dialog can explicitly save them after successful SSH authentication and PTY setup. Later connections can use saved credentials without returning their contents to the webview.

Saved credentials bind to the host address, port, username, bastion selection and verified server fingerprint. The SSH handshake verifies the current server key before reading saved secrets. Editing an identity deletes the old saved credentials before storing the edited host. Forget removes the OS item; deleting a host with saved credentials must remove its OS item before removing metadata. Operations for each host are serialized so a successful Forget cannot race an in-flight login into saving credentials again. A native-owned `credentialsStored` metadata flag records whether vault cleanup is required, including interrupted initial saves; it contains no credentials. A vault failure is reported and never falls back to a plaintext file.

The project-owned `packages/credential-vault` Tauri plugin exposes no frontend commands. Native Rust uses:

- macOS Keychain, Windows Credential Manager, and Linux Secret Service through `keyring` 3.6.3. Linux requires an available, unlocked Secret Service such as GNOME Keyring or KWallet. Windows uses bounded 2048-byte secret chunks, supporting envelopes up to 128 KiB despite Credential Manager's per-item limit. A generation manifest journals chunks before writes and atomically switches the active generation; interrupted updates preserve the prior complete credential and keep pending chunks discoverable for deletion.
- Android Keystore AES-256-GCM with a per-item authenticated key name. Ciphertext is stored in private preferences using synchronous commits. The AES key stays in Android Keystore. Application backups are disabled. Hardware backing depends on the device and is not asserted.
- iOS Keychain generic-password items with `WhenUnlockedThisDeviceOnly`, no iCloud synchronization, and update-before-add replacement that preserves existing values if an update fails.

Android and iOS offer explicit per-host **biometric unlock** when native capability checks find enrolled supported biometrics. Android uses strong biometric authentication bound to the exact AES-GCM cipher operation with an authentication-required Keystore key. Each operation requires authentication; changing enrolled biometrics invalidates protected keys. A failed or cancelled save keeps the previous encrypted item, and newly created unused keys are discarded. iOS uses a separate Keychain item protected with `biometryCurrentSet` and `WhenPasscodeSetThisDeviceOnly`; fresh `LAContext` instances disable authentication reuse. Protected entries are never read through an unprotected fallback. A changed enrollment requires forgetting saved credentials and entering them again.

Presence checks read metadata without unlocking secrets. Closing the connection dialog or backgrounding the app cancels pending native authentication. Private-key export is available only for saved private keys whose host has biometric protection enabled; export performs a fresh protected read and returns the key without its saved passphrase. It never grants a reusable unlock token. The generated/imported identity editor still handles keys supplied in the current session separately.

macOS offers Touch ID protection when biometrics are enrolled and the signed app can access the Data Protection Keychain. Protected items use `biometryCurrentSet`, a fresh authentication context with reuse disabled, and a separate Keychain service. A nonsecret policy marker routes interrupted saves and future reads to the protected store; ordinary Keychain credentials continue working without Data Protection Keychain access. Windows and Linux currently report biometric protection unavailable and retain ordinary OS-protected storage. Private-key export through the protected export command is unavailable there. Windows biometric support and physical-device resume-lock acceptance remain issue #9 work.

Connections, saved-key exports and explicit sync uploads/imports capture a credential-operation generation before waiting for network or host locks. Cancellation advances the Rust generation before blocking dispatch; queued workers keep the captured generation. Native Android/iOS/macOS gates reject a cancelled generation before presenting authentication and before delivering a credential. Once cancellation is acknowledged, late dispatches cannot resurrect authentication from that generation. A delayed cancellation acknowledgment does not cancel a newer request. Apple protected updates authenticate before entering a short, UI-free commit section that serializes with cancellation: cancellation before commit preserves the previous item, while an already committed write reports success. The client may still close the corresponding connection after that commit.

The SSH identities panel generates passphrase-encrypted Ed25519 OpenSSH keys, imports existing private keys, rejects public keys used as private identities, and displays the public key plus SHA-256 fingerprint. New identities require a passphrase of at least 12 bytes. Public keys can be selected/copied to a host's `authorized_keys`. Selecting “Use for connection” transfers the identity to the connection dialog in memory; saving it is separate and explicit.

Rust tests verify encryption/decryption, public-key correspondence, input bounds and host identity/protection binding. Android native JUnit tests reject malformed or downgraded ciphertext envelopes and stale authentication generations; the complete Android APK compiles with native biometric APIs. macOS test cases target isolated Keychain queries and cancellation without reading credentials or displaying biometric prompts. Those cases have been cross-compiled; execution is a macOS CI gate. Cross-target compilation and Clippy validate the module's Rust API use. Native biometric success/cancellation, enrollment changes, locked-device failures and delete durability still require device acceptance testing. A compile or unit-test pass does not verify hardware protection, biometric access or device-backup behavior. No real user biometric prompt has been triggered during development.


## Opt-in native resume protection

The App access settings control a separate, device-local resume lock. It starts
**off**. Enabling it installs an opaque native cover and requires a fresh biometric
read of a dedicated random proof item in the existing protected vault. The proof
is not an SSH identity and never reaches JavaScript. Android, iOS and macOS offer
this option only when native cover/lifecycle integration and enrolled biometric
protection are available; macOS additionally needs usable Data Protection Keychain
access. Windows and Linux return unavailable, without a password or plaintext
fallback. Unlocking the app does not unlock a host's protected credential: its next
use still requires the existing per-operation authentication.

On Android the lock follows activity stop/destruction; on iOS it follows actual
background entry. Temporary inactivity from a system sheet applies a privacy cover
without cancelling that sheet's authentication. macOS covers and locks on hiding,
minimizing, display/system sleep and user-session deactivation. Simply focusing
another desktop application does not lock this implementation. These are explicit
lazysh policies; the reference client's documentation does not specify its desktop triggers.
Enabled protection also starts locked after a cold launch. A separate nonsecret,
device-local policy file records enable intent atomically with private permissions.
Startup keeps recorded protection on even if the protected proof is missing. A
legacy or interrupted-enrollment proof also conservatively records protection on;
only absent/false intent together with an absent proof is the default-off case.
Corrupt, unreadable or unknown policy formats keep the native cover closed. This
file is excluded from sync and imports. Losing both app configuration and the OS
proof cannot be distinguished from a fresh installation; this is not protection
against operating-system compromise or wiping all local app state.

Native code owns the lock, its foreground generation and opaque access nonce.
Protected commands validate both the actual native state and the original nonce;
queued calls do not acquire a fresh generation after a later unlock. Successful
results and structured errors are checked again at serialization, and old frontend
continuations are bound to their original view generation. The native cover remains
until fresh authentication succeeds and the replacement UI acknowledges its reset.
Queued credential reads and writes also retain their original access lease. An OS
mutation that has already started keeps its per-host ownership until its metadata
update finishes, even if the caller is revoked; a new writer cannot race that
deletion or cleanup. Already dispatched OS calls cannot be rolled back. Late
clipboard reads cannot paste through a replacement terminal handler.

There is no frontend command that grants an unlock. During resume authentication,
cancellation or missing/invalidated proof leaves access locked. Before enable
intent is committed, a cancelled enable can return to the prior off
state only after its newly owned proof is successfully removed and absence is
confirmed. Once the true-intent commit is attempted, failures retain the recovery
proof and remain restrictive. Disabling first authenticates the proof, commits
false intent, then removes and confirms absence of the proof; an interrupted delete
or a remaining proof conservatively restores enabled intent. The owned operation
continues through admitted commits after caller cancellation, so an error does not
promise that the prior setting is unchanged. Enrollment changes can invalidate
this proof. There is currently no in-app recovery bypass for a lost
proof; do not treat this development preview as having recovery-key support.

Live terminal ownership and xterm buffers survive ordinary same-view background
locks. Android Activity/WebView replacement is a separate boundary: it invalidates
old requests even when protection is off, closes old renderer-owned connections
and PTYs, and waits for cleanup before accepting a fresh renderer. Reconnect to a
remote multiplexer to restore its server-side workspace; the old local xterm
registry is not restored across WebView replacement.

During ordinary locks, output pauses before
ordered channel messages are sent; raw acknowledgments may release credit for bytes
already delivered. Mosh keeps polling authenticated network state while rendering
is paused and emits a full redraw on resume, including the final screen when the
server exits while locked or the output queue is full. Cancellation, renderer
replacement or a closed receiver still ends that retained client promptly.
ET uses bounded backpressure and may
reconnect/replay after its consumer resumes; this is not a promise that its TCP
socket stays alive throughout a lock. New sessions remain native-pending until the
frontend's retained registry owns their ID and explicitly adopts them; revocation
cleans up unadopted sessions. Temporary bootstrap/control sessions are not adopted.

Protected speech, uploads, device streams and browser-preview listeners are
cancelled on lock. Policy changes invalidate manual model imports too; the next
explicit import clears the exact stale reservation, and stale requests cannot
write, finish or remove its replacement. Existing explicit Live Activity, watch and system-notification
exports are not withdrawn. Previously enabled SSH-agent forwarding also remains
active on its retained connection: the remote host can still request signatures
until that connection closes. The resume lock does not revoke that existing remote
authority or promise to stop every use of a key. Commands or bytes already dispatched to a remote system
cannot be recalled, and cancellation does not promise rollback or automatic retry.
App locking also does not defend against a compromised operating system, debugger,
or data an authenticated user previously copied out.

Verification uses native Rust authority/serialization/transport tests, Android
native gate tests, UIKit/WKWebView XCTest cover tests, and browser tests for retained
sessions, stale callbacks and reset acknowledgment. The iOS native task is
`bunx turbo run test:resume --filter=@lazysh/credential-vault` after `bun run build:ios`
with the existing isolated `APPLE_STATUS_SIMULATOR_ID`. Compile and synthetic tests
do not establish successful physical biometrics, enrollment recovery, background
execution guarantees, device energy behavior or signed-release eligibility. Those
remain explicit device acceptance gates. Development checks do not prompt for or
read real user credentials.
