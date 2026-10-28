# Self-hosted webhook relay

`lazysh-notifications` is an optional Rust service for one account and one fixed HTTPS webhook destination. It is **disabled by default**. This foundation does not register mobile devices, send APNs/FCM messages, install agent hooks, or make suspended native apps reachable. Existing local notifications and native registration remain separate.

An explicit alternative [encrypted Web Push server mode](web-push-server.md) adds private device enrollment/challenge primitives for the free-software push path. It does not yet connect Android enrollment or establish native notification delivery; the webhook mode below remains unchanged.

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

## Opt in the host companion

The companion can durably admit its **new normalized state transitions** to this relay. This is a separate, default-off preference; enabling inbox monitoring or installing lifecycle hooks does not enable publishing. Provision a dedicated private source envelope first, then explicitly configure the companion on its host:

```sh
lazysh-agent relay status
lazysh-agent relay configure --expected-revision 0 --enable \
  --capability-file /private/relay-config/build-source
lazysh-agent relay flush --limit 8 --deadline-seconds 30
```

Use the current local `revision` from `relay status` for every configure or disable. A private-CA relay also requires explicit `--relay-ca-file FILE` on configure. Omit `--enable` to save a verified binding without enabling admission. Enable rejects a remotely disabled destination. Configure probes and atomically pins the relay account, source, target generation, origin and exact private capability/CA bytes; it does not send old events. The credential files remain owner-only and must remain at their checked paths. Even a whitespace-only file change invalidates the captured binding; explicitly configure again after any intended identity or trust-file change.

Ordinary `ingest` performs no networking and starts no asynchronous runtime. In the same SQLite transaction as the local state update, an enabled companion queues a random stable event UUID only when the normalized state changes to `working`, `needs_attention` or `done`. Repeated state observations do not enqueue another event. It never uploads the session ID, agent label, pane ID, prompt, transcript, command, project directory or host address. The relay supplies the independently provisioned public alias. A known full local outbox preserves the local update and increments the durable `capacityFailures` counter; unexpected SQL/disk errors roll back the whole ingest rather than claiming a capacity rejection.

**Flush is explicit.** By default nothing installs a schedule, modifies hook configuration, starts a daemon, or sends pending work. Invoke flush yourself, explicitly start the foreground sender below, or configure an operator-owned schedule separately. This manual drain is not complete background mobile push. It owns one persistent private `relay-publisher.lock`, takes at most eight jobs, and stops admitting requests at the selected 1–30 second dispatch deadline. Existing SQLite admission retains its separate three-second shared budget; filesystem/OS work is not a hard real-time promise. A concurrent flush fails busy. The drain guard spans each admitted POST and its synchronous local finalization, including interruption; no detached local writer can complete after releasing that ownership.

The dedicated `/v1/bound-events` protocol requires the original account/source/target generation both for new admission and matching-receipt reconciliation. An older relay that lacks this route fails closed; the companion never falls back to the manual `/v1/events` endpoint. A lost response may retry only the same UUID and original binding. `relayRecorded` means the relay recorded a matching receipt, **not** that the destination accepted it. The companion retains receipt IDs in its private local database; its CLI exposes aggregate local status rather than a receipt list or a remote delivery-status probe. JSON flush reports include retry/blocked counts, a finite `lastFailure` class and a stop reason; `limit` reports exhausted dispatch slots; `drained` means no job was due at the last claim, so future retries can still remain. Successful process completion alone does not mean delivery. Status counts are local and make no remote probe.

Local queued work expires after 24 hours, permits at most three persisted admitted attempts with a two-second retry delay, and retains at most 1,000 pending plus 100 terminal records. The local capacity-failure counter survives reconfiguration. Terminal counts cover only those retained records, not lifetime delivery totals. A crash, killed drain or expired request after admission has an unknown remote outcome, even if the local record is later cancelled or blocked. Deleting local terminal metadata does not revoke the relay's original receipt.

```sh
lazysh-agent relay disable --expected-revision 1
```

Disable persists and advances the local revision, cancelling all old pending rows without rewriting their original configuration. Re-enable requires another explicit configure with the new revision; old rows never become fresh work. Configuration/remote-generation changes also require explicit reconfiguration. Disable cannot recall a POST already admitted locally, a receipt already recorded by the relay or an effect already accepted by the destination. Revoke the source at the relay as well when its remote authority must end. Protect the companion's private plaintext database and its retained WAL/SHM metadata; use a consistent SQLite backup rather than copying only the main file.

## Explicit foreground sender

After explicitly enabling the local binding, you can start one foreground process instead of invoking flush repeatedly:

```sh
lazysh-agent relay run --expected-revision 1
```

Pass the current local revision from `relay status`. This command does **not** enable admission, install itself, change hooks, configure a scheduler, fork into the background or enroll a provider/device. Keep the process running yourself or explicitly manage it with your own supervisor. OS service installation, reboot/login activation and host sleep/wake behavior are not implemented or verified here. Native mobile APNs/FCM delivery remains separate #14 work.

Run owns the existing private drain lock, one runtime and one cancellation handler throughout its lifetime, including idle periods. Other Run/flush invocations fail busy. Hooks continue their existing synchronous local transactions and never wait on this drain lock. Idle operation polls policy and due-work metadata once per second with short read-only queries, without reading capability/CA files, constructing TLS clients or probing the network. Expired and interrupted local rows are maintained without requiring credential files.

Every enabled start has a fixed **two-second startup quiet period**, including process recovery. Signals and local policy changes remain observable during this period. Before each actual claim, the sender freshly validates and compares the complete original private capability/CA binding; that exact captured client sends the claimed event. It never adopts replacement file contents, another account/source or another target generation. File changes during an already-admitted request cannot revoke it, but must fail validation before the next claim. Idle operation does not promise to detect every transient filesystem mutation.

The in-flight POST remains the same future across periodic policy checks: a tick never reconstructs or repeats it. After a transient transport/protocol/capacity failure, Run waits at least two seconds before **any** new admission, in addition to the persisted per-job delay. Existing three-attempt ceilings, 24-hour expiry and retention/capacity bounds remain unchanged. A stopped/restarted process keeps the original IDs and gets the same startup quiet period.

Disable or any reconfiguration stops the running sender; its pinned command cannot adopt the newer revision on restart. Permanent binding/auth/protocol rejection finalizes the current claimed row and exits nonzero, leaving other original work pending. While a blocked row remains for that revision, Run refuses even automatic restarts with `RelayOperatorActionRequired`. Inspect local status and take explicit operator action; an explicitly verified configure with the current revision creates a new revision and cancels old pending work. One-shot flush remains an explicit operator action with its existing behavior.

Ctrl-C/SIGTERM and policy changes cancel the request and synchronously attempt original-claim finalization before releasing drain ownership. Already-admitted remote effects remain uncertain; unexpected storage errors may leave a durable interrupted claim for recovery. Cancellation does not interrupt synchronous OS/filesystem operations or shorten the existing SQLite budgets. Networking keeps its existing three-second connect/ten-second request limits.

The command emits a bounded final JSON report only after owned networking/runtime/lock cleanup; it produces no periodic stdout stream that could block the dispatcher on an unread pipe. A normal cancelled/disabled/configuration-changed stop exits successfully with its explicit reason; invalid revision, permanent rejection and unexpected storage/runtime failures exit nonzero with a fixed safe error class. Use `relay status` separately for aggregate local pending/blocked/unknown counts while it runs. Neither process liveness nor `relayRecorded` establishes destination/device/human delivery.

## Delivery and revocation boundary

The destination receives only `schemaVersion:1`, `receiptId`, `eventId`, finite `kind` and its admin-provisioned public `alias`. The receipt ID is the stable HTTP `Idempotency-Key` across attempts and restarts. Only HTTP 2xx marks `accepted`: this means the destination accepted the request, **not** that a device displayed it or a human saw it. Exactly-once effects depend on the destination honoring idempotency.

One worker admits one POST at a time. Admission is durably recorded before networking. A request timeout, crash, shutdown or revocation after admission can leave an unknown remote outcome; `mayHaveReachedDestination` remains conservatively true. Disconnecting a request cannot retract a remote effect. The worker performs at most three admitted attempts, with a two-second retry delay and a ten-second per-request budget (three-second connection budget). Queued work expires after 24 hours using the service host's clock. `failed_unknown`, `expired_unknown` and `cancelled_unknown` do not assert non-delivery.

Disable/revoke cancels queued work and aborts an affected admitted request; already-admitted effects may still finish remotely. Disable and each explicit enable advance the persisted generation. Re-enabling never freshens old receipts, even after restart. New events are rejected while disabled. On restart, interrupted requests may retry only with their original target identity/generation and the same key. Supplying a different destination URL/key or admin identity fails closed.

To change a destination, stop the service, then run `configure-destination` with the same private-file arguments as `serve`. This requires the existing admin identity, cancels old pending work, advances generation and leaves delivery disabled, including when the supplied destination is unchanged. Explicitly enable it after restarting. Admin key replacement and account recovery are outside this first service version; changing an admin file does not silently adopt queued work.

There are at most 128 retained source identities, 1,000 pending events and 10,000 retained receipts. Capacity exhaustion rejects new identities/events rather than deleting an accepted idempotency record or evicting queued work. There is no automatic retention/archive tool in this slice. Export/archive and start a new explicitly provisioned account when the finite lifetime receipt capacity is reached. Do not delete individual database rows to free space or reuse old identities.

## Verification and limits

Standard Cargo fixtures own their temporary storage, loopback listeners and TLS receiver certificate. They exercise real HTTP ingest-to-TLS-delivery-to-receipt, auth, source isolation, dedup conflicts, private no-overwrite files/CLI output, actual child-process source creation with a committed lost TLS response and same-envelope resume, explicit-CA/wrong-host/no-CA handling, restart/idempotency, target binding, held POST/revoke, redirect rejection, timeout, shutdown, one-worker and capacity bounds. No external notification provider, user credentials, model, device or deployment is contacted. Companion fixtures additionally execute the real CLI through owned TLS relay and destination servers, lost-ACK process recovery, exclusive drain/disable races, original-generation rejection, exact capability binding, downgrade rejection and dispatch deadlines. Native app push/account binding and physical background delivery remain future #14 acceptance, not a capability advertised by this service.
