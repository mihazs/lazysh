# Self-hosted webhook relay

`lazysh-notifications` is an optional Rust service for one account and one fixed HTTPS webhook destination. It is **disabled by default**. This foundation does not register mobile devices, send APNs/FCM messages, install agent hooks, or make suspended native apps reachable. Existing local notifications and native registration remain separate.

## Run a private relay

Build with `bunx turbo run build --filter=@lazysh/notification-service`. Run on a supported local Unix filesystem. Keep the state directory and all capability/configuration files owner-only. The listener is loopback HTTP only; place it behind your own HTTPS reverse proxy, preserving Authorization and limiting request bodies. Do not expose its HTTP port publicly. No deployment or external endpoint is configured automatically.

Create a private configuration directory, then generate **different** admin and destination capabilities into explicit new paths:

```sh
chmod 700 /private/relay-config
lazysh-notifications keygen --output /private/relay-config/admin
lazysh-notifications keygen --output /private/relay-config/destination-key
```

`keygen` prints only `{"created":true}` and never overwrites a file. Provision the destination key at your owned receiver separately. Store the exact HTTPS destination URL in an owner-only `destination-url` file; URL path segments can contain secrets, so the URL is never a command argument or log field. URLs reject userinfo, query, fragments, controls and backslashes. No redirects or environment HTTP proxies are followed. The receiver must validate its Bearer capability and deduplicate the stable `Idempotency-Key` before triggering an effect.

```sh
lazysh-notifications serve --data-dir /private/relay-state \
  --admin-file /private/relay-config/admin \
  --destination-file /private/relay-config/destination-url \
  --destination-token-file /private/relay-config/destination-key
```

The default listener is `127.0.0.1:7350`. The database uses the shared checked namespace, local-filesystem admission, private regular-file checks, a lifetime OS lock and FULL synchronous transactions. A second service or offline configuration command cannot mutate that directory while the service owns it. This is private plaintext metadata storage, not encryption against the owning OS account. Back up using SQLite's consistent backup mechanism; protect copies as carefully as the live state.

## Provision a source safely

Use the HTTPS origin you own. For a private-CA relay, source/admin client commands accept explicit `--relay-ca-file FILE`: an owner-only PEM certificate of at most 16 KiB. It adds a trusted certificate while preserving hostname/chain verification, redirect rejection and proxy isolation. Default system/WebPKI trust is unchanged. This option is rejected for `serve`, `configure-destination` and `keygen`; it does not change outbound destination trust. Never use a certificate you have not independently verified.

The admin capability is distinct from every source capability and the destination key.

```sh
lazysh-notifications source-create --origin https://relay.example \
  --admin-file /private/relay-config/admin --alias build-server \
  --output /private/relay-config/build-source
```

The command first reads the account ID, creates and fsyncs a private recovery envelope, then provisions its UUID, public alias and capability hash. Only the public source ID is printed. A lost POST response does not require a second source: run `source-resume` with the **same** origin, admin file and `--capability-file` path. Resume revalidates the private output namespace and syncs the existing envelope and its directory before provisioning, without rewriting its bytes. The server accepts only the same source UUID/hash/alias/account; conflicts and revoked IDs cannot be silently overwritten or revived. Copy the private source envelope to the intended publisher through your own secure channel. Never place capability contents in arguments, shell history or logs.

Explicitly enable the configured destination:

```sh
lazysh-notifications destination --origin https://relay.example \
  --admin-file /private/relay-config/admin --enable
lazysh-notifications publish --capability-file /private/relay-config/build-source \
  --event-id 12ee701a-a54e-47af-bbb2-54d7c7d8cb40 --state needs-attention
```

Reuse that event ID when retrying an unknown publish outcome. Valid states are `working`, `needs-attention` and `done`. Input contains no summary, project path, prompt, command, transcript or SSH credentials. Sources cannot choose their public alias per event. Duplicate `(source ID,event ID)` with the same kind returns the original receipt; a changed kind conflicts. The same event ID from another source has its own independent receipt.

`receipt --capability-file FILE --receipt-id UUID` reports only that source's result. `status --origin ORIGIN --admin-file FILE` reports account, enabled state and target generation. Omit `--enable` on `destination` to persistently disable. Use `source-revoke --origin ORIGIN --admin-file FILE --source-id UUID` to revoke one source. Revocation also prevents later source provisioning retries from reviving it.

## Delivery and revocation boundary

The destination receives only `schemaVersion:1`, `receiptId`, `eventId`, finite `kind` and its admin-provisioned public `alias`. The receipt ID is the stable HTTP `Idempotency-Key` across attempts and restarts. Only HTTP 2xx marks `accepted`: this means the destination accepted the request, **not** that a device displayed it or a human saw it. Exactly-once effects depend on the destination honoring idempotency.

One worker admits one POST at a time. Admission is durably recorded before networking. A request timeout, crash, shutdown or revocation after admission can leave an unknown remote outcome; `mayHaveReachedDestination` remains conservatively true. Disconnecting a request cannot retract a remote effect. The worker performs at most three admitted attempts, with a two-second retry delay and a ten-second per-request budget (three-second connection budget). Queued work expires after 24 hours using the service host's clock. `failed_unknown`, `expired_unknown` and `cancelled_unknown` do not assert non-delivery.

Disable/revoke cancels queued work and aborts an affected admitted request; already-admitted effects may still finish remotely. Disable and each explicit enable advance the persisted generation. Re-enabling never freshens old receipts, even after restart. New events are rejected while disabled. On restart, interrupted requests may retry only with their original target identity/generation and the same key. Supplying a different destination URL/key or admin identity fails closed.

To change a destination, stop the service, then run `configure-destination` with the same private-file arguments as `serve`. This requires the existing admin identity, cancels old pending work, advances generation and leaves delivery disabled, including when the supplied destination is unchanged. Explicitly enable it after restarting. Admin key replacement and account recovery are outside this first service version; changing an admin file does not silently adopt queued work.

There are at most 128 retained source identities, 1,000 pending events and 10,000 retained receipts. Capacity exhaustion rejects new identities/events rather than deleting an accepted idempotency record or evicting queued work. There is no automatic retention/archive tool in this slice. Export/archive and start a new explicitly provisioned account when the finite lifetime receipt capacity is reached. Do not delete individual database rows to free space or reuse old identities.

## Verification and limits

Standard Cargo fixtures own their temporary storage, loopback listeners and TLS receiver certificate. They exercise real HTTP ingest-to-TLS-delivery-to-receipt, auth, source isolation, dedup conflicts, private no-overwrite files/CLI output, actual child-process source creation with a committed lost TLS response and same-envelope resume, explicit-CA/wrong-host/no-CA handling, restart/idempotency, target binding, held POST/revoke, redirect rejection, timeout, shutdown, one-worker and capacity bounds. No external notification provider, user credentials, model, device or deployment is contacted. Native push/account binding and physical background delivery remain future #14 acceptance, not a capability advertised by this service.
