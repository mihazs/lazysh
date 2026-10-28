# Private UnifiedPush relay enrollment

This optional F-Droid Android flow connects the [encrypted Web Push server foundation](web-push-server.md) to native enrollment and challenge confirmation. It is **challenge-only**: host event payloads and notification display remain ignored. It does not complete #344 or establish real distributor interoperability merely by compiling or passing protocol fixtures. No app subscription, Google account or mandatory paid provider is required. You operate the relay and choose a compatible free-software distributor/service.

## Connect explicitly

Install and configure a UnifiedPush distributor. Enable system notification permission through the inbox, then open the native push controls and opt in. Registration-only behavior remains available. Pause existing registration before connecting a relay, so enrollment starts with a new connector instance.

The relay administrator first runs the [server setup](web-push-server.md), creates a fresh private one-time enrollment capability and supplies its exact HTTPS origin and code over a secure channel. Choose **Connect or resume delivery service**. A native Android dialog accepts those values; they never become WebView fields, IPC arguments, browser history or renderer preferences. Over-limit pastes remain invalid. The dialog disables saving/autofill, uses a password field and secure window, and cancels when its Activity is left.

The native client persists an original request ID and a fresh device credential under direct Android Keystore AEAD before contacting the server. A lost bootstrap response can be resumed explicitly with the original identity/code; it does not silently create another device. The server code expires after ten minutes. An expired/consumed enrollment may require an explicit administrator reset; changing credentials is not automatic recovery.

After bootstrap, the existing explicit distributor selection runs with the server's public VAPID key. A current non-temporary endpoint is uploaded privately. Only a successfully decrypted, bounded challenge for that exact connector instance/device/generation can be confirmed. A challenge arriving before the subscription HTTP response waits in one bounded in-memory slot until its ID matches that response. Plaintext fallback, event messages, malformed/unknown fields, duplicates, stale instances and wrong identities cannot grant native confirmation.

Use **Refresh registration status** to inspect progress. Endpoint verification does not enable the server destination, send host history or display notifications. Even if an operator separately enables the server, this Android slice continues ignoring event/display messages. Full delivery is separate work.

## Storage, cancellation and trust

The one-time code is removed from encrypted state after bootstrap acknowledgement. Lazysh's endpoint/auth/device snapshot remains in a dedicated encrypted namespace; no challenge nonce/message body is persisted. The connector separately owns its protocol state: on this app's supported Android versions it Keystore-encrypts the ECDH private key, while its auth salt/public key and registration metadata use app-private preferences. This is not a claim that every SDK field or transient JVM string is encrypted/zeroized. Android backup remains disabled. Lazysh's private classes redact their string representations; public status and fixed errors contain no origin, endpoint, code or credential.

Keystore/key/storage failure fails closed without a plaintext fallback or overwriting unreadable ciphertext. A restored ciphertext whose Keystore key is unavailable cannot be adopted. Automatic recovery/credential replacement is not implemented; preserve existing app data and coordinate an explicit administrator reset rather than deleting unrelated SSH/vault state.

Pause retires local registration before cleanup; queued/late operations must retain their original consent and private snapshot. It cancels admitted enrollment/verification calls and requests authenticated removal with the original device credential. An already admitted remote effect cannot be recalled. Cleanup uncertainty retains a private removal-pending state for explicit retry; cleanup never grants new delivery authority. Restart/status inspection does not automatically register or send HTTP requests.

Production uses pinned Apache-2.0 OkHttp 5.5.1 with normal Android TLS certificate/hostname validation, no environment/system proxy, no redirects, no automatic connection retry, a three-second connection budget and ten-second whole-call timeout. Responses are bounded to 4 KiB; decrypted challenges to 2 KiB. Synchronous OS/Keystore/filesystem work remains subject to platform behavior. There is no production certificate, resolver, HTTP-client or test-trust override. Tests may inject a fake protocol driver into an isolated controller, without changing the production transport.

Normal Android FCM and iOS APNs registration are unchanged; private relay enrollment is rejected outside the F-Droid Android build. Existing local inbox notifications remain independent.

## Verification boundary and remaining acceptance

Planned native project gates are Kotlin/JUnit lifecycle interleavings, frontend protected-command consent tests, Rust unsupported-platform checks, and actual Android Keystore/ciphertext-corruption/strict-parser instrumentation on an owned F-Droid APK. Those parser tests receive a synthetic decrypted flag; they are not SDK decryption, actual distributor, background or notification-presentation proof.

Real interoperability requires a separately pinned FOSS distributor/server and owned emulator/private network: bootstrap through the production native transport, register with the returned VAPID key, capture only finite ownership receipts, route the server's actual encrypted challenge through the distributor/SDK, and observe server confirmation plus native verified state. TLS must remain verified; any fixture CA belongs only to the owned test environment, never a production override. Device/process death, response-loss recovery, rotation, revocation, duplicate/replayed messages and background behavior need separate observed outcomes. A free-software ntfy setup is one candidate, subject to executable verification; no distributor acceptance is claimed here.

Primary sources: [UnifiedPush AND_3.1.0](https://unifiedpush.org/developers/spec/android/), the pinned official connector 3.3.5 source APIs, [ntfy's Android/F-Droid behavior](https://docs.ntfy.sh/subscribe/phone/), and [OkHttp's maintained release history](https://github.com/lysine-dev/okhttp/blob/main/CHANGELOG.md). The HTTP pin includes the upstream AOSP trust-store certificate correction; these source statements do not establish runtime acceptance.
