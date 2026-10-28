# Free-software Web Push server foundation

The optional Rust notification service can use one encrypted Web Push destination instead of its existing webhook. This is a server-side foundation for #344. It does **not** enroll the Android application, display notifications, or complete remote push. The current F-Droid connector still ignores received messages. There is no lazysh subscription, paid account requirement, bundled hosting, or feature gate. You operate the relay and a compatible push service/distributor; infrastructure costs, availability and network access remain yours.

## Configure an explicit destination policy

Use the existing private Unix storage and HTTPS reverse-proxy requirements in [notification-relay.md](notification-relay.md). Create an owner-only configuration directory. Generate distinct admin and enrollment capabilities with the existing `keygen` command. Keep their contents out of command arguments and logs.

Building this Rust service requires a C compiler, `pkg-config` and OpenSSL development headers/libraries for the production ECE encryption dependency (for example, `libssl-dev` on Debian/Ubuntu). Outbound HTTP still uses the existing reqwest/Rustls client; the Web Push library's HTTP-client features are disabled. This does not add OpenSSL or a Google push dependency to the Android application.

```sh
lazysh-notifications push-config-generate \
  --output /private/relay-config/push.json \
  --push-origin https://push.example:8443 \
  --address 192.0.2.10 --contact mailto:operator@example.invalid
lazysh-notifications serve-push --data-dir /private/relay-state \
  --admin-file /private/relay-config/admin \
  --push-config-file /private/relay-config/push.json
```

The example address is documentation-only: replace it with addresses you control and have verified independently. The private JSON file owns a generated P-256 VAPID key and stable device-slot UUID. It is created once without overwrite; only the public VAPID key is printed. Never publish or copy the file into an APK. A configuration accepts one exact HTTPS origin, including any nondefault port, and one to four explicitly approved IP addresses. Paths and opaque subscription queries remain device-specific; they never appear in status or error output.

The outbound client connects only to those fixed addresses, preserving the origin hostname and normal certificate/hostname verification. It follows neither HTTP redirects nor environment proxies. Literal-IP origins require exactly that same pinned IP. Private/loopback networks are allowed only through this explicit operator policy. No runtime DNS refresh, discovery or automatic pin replacement occurs. An address change requires stopping the service and deliberately reconfiguring it. Production has no custom-CA switch for the push service; the test certificate option exists only in Rust test-support builds.

To change mode, VAPID/slot identity, origin or pins, stop the service and use `configure-push` with the same arguments as `serve-push` except `--listen`. This preserves the existing admin identity, cancels old pending work, clears the previous device enrollment, advances the account target generation and leaves delivery disabled. Existing webhook `serve` and `configure-destination` behavior is unchanged. Neither mode falls back to the other.

## Enrollment and confirmation contract

### Opt-in bound event format

`push-config-generate --event-format bound-v2` creates a private target for the new
event format. The default remains `legacy`; existing private configurations omit
this optional field and retain their original serialization and identity. Unknown
format names reject. The format participates in target identity: changing it uses
the deliberate `configure-push` lifecycle above, cancels prior pending work and
requires fresh enrollment before the operator enables delivery. No old snapshot is
silently converted or sent to a new target.

The encrypted version-2 event contains exactly `schemaVersion:2`, `deviceId`,
`generation`, `receiptId`, `eventId`, `kind`, `alias`, `issuedAt` and `expiresAt`.
The device generation is the confirmed enrollment generation, not the relay's
separate account target generation. Timestamps are Unix seconds. The first network
admission freezes the original subscription/device binding and timestamps in the
existing private snapshot row; retries and restarts reuse them. Expiry is at most
300 seconds after that admission, further limited by the queued event's expiry.
Each transport TTL is limited to the remaining window at claim time. An expired snapshot admits
no new request; its terminal status retains the existing uncertain-delivery flag.
A clock preceding the captured issuance fails closed instead of refreshing it.
An already-admitted POST can complete later and cannot be retracted; a native
consumer must still enforce the absolute payload expiry when it receives it.

The clear/wire limits remain 2 KiB/4 KiB, with the original three-attempt ceiling.
Only the existing public alias and finite kind accompany opaque event/receipt IDs;
no endpoint, key, prompt, transcript or host path enters the event. Legacy event,
webhook and encrypted enrollment-challenge formats are unchanged. Transport
acceptance does not establish native receipt or display. The current Android
enrollment receiver does not display these events; explicit native consent,
bounded durable deduplication and actual notification acceptance are separate work.

### Provision the private enrollment

Provision a new private enrollment capability, then install its hash through the authenticated admin client:

```sh
lazysh-notifications keygen --output /private/relay-config/enrollment
lazysh-notifications push-enrollment --origin https://relay.example \
  --admin-file /private/relay-config/admin \
  --capability-file /private/relay-config/enrollment
```

The capability expires after ten minutes. Transfer it over your own secure channel to the intended device. Native Android enrollment UI/storage is a separate prerequisite; the endpoints below are a protocol contract, not an instruction to paste device secrets into a browser console. All endpoints require the relay's authenticated HTTPS origin and reject bodies above 4 KiB. Invalid metadata produces finite error classes, never reflected request values.

| Endpoint | Authorization | Request and result |
| --- | --- | --- |
| `POST /v1/admin/push/enrollment` | Admin Bearer | `{capability}` starts the empty slot, disables delivery and returns finite expiry/generation metadata. |
| `POST /v1/admin/push/reset` | Admin Bearer | A fresh `{capability}` explicitly revokes the old device and pending work, advances generation and starts a new disabled enrollment. |
| `POST /v1/push/bootstrap` | Enrollment Bearer | `{requestId, credential}` installs a device-generated, distinct 256-bit hexadecimal credential. An exact retry with the same request UUID/credential succeeds until enrollment expiry; a different request cannot consume it again. Returns device-slot UUID, generation, public VAPID key and confirmation state. |
| `POST /v1/push/subscription` | Device Bearer | `{requestId, endpoint, p256dh, auth}` stages the exact subscription and sends an encrypted challenge. Returns challenge ID and push-service acceptance, without the nonce or subscription. An exact retry of the pending request resends its original encrypted challenge until expiry. |
| `POST /v1/push/confirm` | Device Bearer | `{challengeId, nonce}` confirms the five-minute challenge received and decrypted by that subscription. It does not enable event delivery automatically. |
| `POST /v1/push/revoke` | Device Bearer | Idempotently removes current subscription/challenge authority, disables delivery and cancels pending events. It cannot enroll another device. |

UUIDs must be nonnil. Endpoint length is at most 1,000 bytes. The P-256 uncompressed public key and 16-byte auth secret use unpadded base64url, matching the UnifiedPush connector. Only a confirmed subscription permits the existing explicit `destination --enable` action. The administrator must provision source capabilities separately; enabling local inbox monitoring or registration never enables this service.

Changing the endpoint with the same public key/auth secret requires a fresh encrypted challenge. A changed key requires explicit admin reset and a new enrollment/device credential. Retained capability hashes prevent role reuse or revival of old credentials; there are at most 256 enrollment/device capabilities per account lifetime. Reaching that limit fails closed. Keep consistent backups private; there is no automatic archive/account migration in this slice.

The challenge envelope contains `schemaVersion:1`, `kind:"challenge"`, device ID, device generation, challenge ID and a random nonce. The server stores only the nonce hash and encrypted challenge, not a plaintext copy of the nonce. A nonce cannot confirm another challenge or an expired/revoked device. The clear event envelope contains only the existing receipt/event IDs, finite kind and administrator-provisioned public alias; it excludes transcripts, prompts, project paths and SSH credentials. The clear payload is capped at 2 KiB and encrypted wire at 4 KiB using `aes128gcm`; TTL is 300 seconds. VAPID audience binds the exact approved HTTPS origin, including its port.

## Delivery and ownership limits

The existing finite outbox, three-attempt ceiling, retry delay, 24-hour event expiry, stable receipt identity and unknown-outcome semantics remain. The first event admission privately snapshots that event's endpoint/key material. Later confirmed endpoint rotation affects new admissions; it cannot silently redirect an already admitted retry. Encryption and VAPID headers are generated for each attempt against the original snapshot. The receiving implementation must deduplicate receipt IDs; Web Push acceptance alone does not establish exactly-once delivery.

Reset/revoke cancels pending work and removes stored active/pending subscription snapshots; SQLite deletion is not secure erasure against the owning OS account or backups. The private database/configuration contains endpoint capabilities and keys needed for delivery. Protect it as carefully as the admin capability. Public status/receipts and fixed errors do not expose these values. There is no message-content logging or history endpoint.

An enrollment challenge POST admitted before reset/revoke may still reach the old endpoint, but its confirmation is then rejected. Likewise an event admitted before cancellation may already have reached the push service. No cancellation recalls remote effects. HTTP 2xx means only that the configured push service accepted the encrypted request. Android distributor routing, authenticated native enrollment, decryption, deduplication, notification permission, process death/reboot, and actual notification presentation remain unimplemented/unverified by this server slice. No APNs/FCM delivery is added.

## Protocol and implementation provenance

- [UnifiedPush Android protocol AND_3.1.0](https://unifiedpush.org/developers/spec/android/) defines registration keys and the 4,096-byte message limit; [developer guidance](https://unifiedpush.org/developers/intro/) recommends validating subscriptions with a challenge.
- [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291) defines encrypted Web Push; [RFC 8292](https://www.rfc-editor.org/rfc/rfc8292) defines VAPID audience binding.
- Production uses Apache-2.0 `web-push` 0.11.0 without its HTTP-client features and its [supported VAPID claim override](https://docs.rs/web-push/0.11.0/web_push/struct.VapidSignatureBuilder.html#method.add_claim). Both inspected candidate libraries omit a nondefault port in their default audience; lazysh explicitly supplies the approved origin. The independently implemented MIT/Apache-2.0 `web-push-native` 0.5.0 is a development-only decryptor in native tests.

No real distributor or Android notification receipt is established by those sources or the private TLS fixture. Follow #344 for end-to-end acceptance.
