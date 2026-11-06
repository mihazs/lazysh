# Self-hosted webhook relay

`lazysh-notifications` is an optional Rust service for one account and one fixed HTTPS destination: an authenticated webhook by default, an explicitly selected Gotify application, or an [Apprise API](#deliver-through-apprise) stateful key that fans out to Telegram, Discord, Slack, Matrix, email, Pushover, ntfy and the other services Apprise supports. It is **disabled by default**. This foundation does not register mobile devices, send APNs/FCM messages, install agent hooks, or make suspended native apps reachable. Existing local notifications and native registration remain separate.

The separate [encrypted Web Push server mode](web-push-server.md) supports explicit Google/FOSS Android UnifiedPush enrollment and separately consented bound-event display. The webhook mode below remains unchanged; see [Android setup](push-registration.md#firebase-free-android-setup) for the distributor and relay steps.

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

## Deliver through Gotify without Firebase

Gotify delivery uses your Gotify server and the official Gotify client. It is a
separate destination from lazysh's encrypted UnifiedPush/ntfy enrollment; it does
not make Gotify a lazysh-native push receiver or automatically open a session.
[Gotify-UP is deprecated and does not support the current UnifiedPush protocol](https://unifiedpush.org/users/distributors/gotify/).

Create an application in your own Gotify server, following its
[message API documentation](https://gotify.net/docs/pushmsg). Save its application
token in a new owner-only regular file using your secret manager, rather than a
command argument or URL query. This is a Gotify-issued application token, not a
relay capability generated by `keygen`. Store the exact HTTPS message URL, such
as `https://push.example/message` (or a reverse-proxy prefix ending in `/message`),
in a separate owner-only URL file. Both files use the same private-file and
no-symlink checks as the relay's existing configuration. Tokens must be nonempty,
at most 512 printable ASCII bytes without spaces, and different from the relay
admin capability. TLS verification remains mandatory; redirects and environment
HTTP proxies remain disabled.

```sh
lazysh-notifications serve --data-dir /private/relay-state \
  --admin-file /private/relay-config/admin \
  --destination-format gotify \
  --destination-file /private/relay-config/gotify-url \
  --destination-token-file /private/relay-config/gotify-application-token
```

The destination starts disabled. Provision a dedicated source and explicitly
run the existing `destination --enable` command as described above. The worker
sends a JSON message with the fixed title `lazysh`, the provisioned public alias
and finite state only (`working`, `needs_attention` or `done`). Needs-attention
messages use priority 5; other states use priority 2. The Gotify application token
is sent only as `X-Gotify-Key`; no transcript, prompt, project path, SSH credential,
source capability or enrollment key is included in the message.

Agent hooks can feed the existing companion's normalized state transitions to
this source when its relay publisher is explicitly configured and running below.
A terminal or multiplexer integration can use its own dedicated source envelope
with `publish --capability-file FILE --event-id UUID --state done` (or `working`
and `needs-attention`). The caller must persist/reuse that event UUID after an
unknown result. No automatic shell, tmux, Herdr or Zellij event detector is
installed by selecting Gotify.

When changing an existing relay from webhook to Gotify, stop its process and use
`configure-destination` with the same four private-path arguments and explicit
`--destination-format gotify`, then restart and re-enable it. Destination identity
includes the format, so an ordinary restart with a different format fails closed
even if URL and token match. Administrative reconfiguration increments its
existing generation, disables delivery and cancels old pending work. Bound companion
configurations must explicitly adopt the new target generation before sending
new work; the existing source-capability authentication is unchanged.

Gotify HTTP success means server acceptance, not Android display. The relay keeps
its existing bounded retries, but Gotify's API does not promise to deduplicate
`Idempotency-Key`, so a lost response can produce duplicate notifications. Stop,
revocation or reconfiguration cannot recall an already accepted message. Actual
Gotify server/client, Android background and physical-device delivery acceptance
remain separate checks.

## Deliver through Apprise

Apprise delivery uses your own [Apprise API server](https://github.com/caronc/apprise-api)
(`caronc/apprise-api`, published on Docker Hub as `caronc/apprise`), not the Python
library, so the relay needs no Python runtime. The Apprise server stores the downstream
service URLs and their secrets under a **stateful configuration key**; the relay only
knows the one `/notify/<KEY>` endpoint and never sees a Telegram, Discord, Slack or
email credential.

Run the Apprise API server on a private network and save a configuration under a key
(1–128 letters, digits, `_` or `-`), following its
[stateful configuration documentation](https://github.com/caronc/apprise-api#persistent-stateful-storage-solution).
Tags written as `tag=URL` in that configuration let the relay select a subset:

```sh
docker run --detach --name apprise --publish 127.0.0.1:8000:8000 \
  --volume /private/apprise-config:/config caronc/apprise:2.0.2
curl --fail -H 'Content-Type: application/json' http://127.0.0.1:8000/add/lazysh-alerts \
  --data '{"format":"text","config":"phone=tgram://BOT_TOKEN/CHAT_ID\nteam=slack://TOKEN_A/TOKEN_B/TOKEN_C"}'
```

Apprise API accepts **unauthenticated** requests by default, and the relay does not use
its optional Basic Auth. Put it behind your own HTTPS reverse proxy that checks a
Bearer token, and do not expose port 8000. For example, with nginx:

```nginx
location /apprise/notify/ {
    if ($http_authorization != "Bearer REPLACE_WITH_PROXY_TOKEN") { return 401; }
    proxy_set_header Authorization "";
    proxy_pass http://127.0.0.1:8000/notify/;
}
```

Store the exact HTTPS endpoint, such as `https://alerts.example/apprise/notify/lazysh-alerts`,
in an owner-only URL file, and the proxy token in another owner-only file. The URL rules
are the relay's usual ones (HTTPS only; no userinfo, query, fragment, controls or
backslashes), and the path must end in `/notify/<KEY>` with no trailing slash. The token
must be nonempty, at most 512 printable ASCII bytes without spaces, and different from the
admin capability. Both files get the private-file and no-symlink checks used for Gotify.
TLS verification stays mandatory; redirects and environment HTTP proxies stay disabled.

```sh
lazysh-notifications serve --data-dir /private/relay-state \
  --admin-file /private/relay-config/admin \
  --destination-format apprise \
  --destination-file /private/relay-config/apprise-url \
  --destination-token-file /private/relay-config/apprise-proxy-token \
  --apprise-tag phone
```

The token is sent as `Authorization: Bearer` for your proxy to check. Without a token
file, `serve` and `configure-destination` refuse to start unless you pass
`--destination-unauthenticated`, which acknowledges that anyone who can reach the
endpoint can send through your key. `--apprise-tag TAG` (1–64 letters, digits, `_` or
`-`) is repeatable up to eight times; the relay sends the sorted set comma-joined, which
Apprise treats as "any of these tags". Without a tag, Apprise applies its default
selection for the key.

The destination starts disabled; provision a source and run `destination --enable` as
above. Each event is a JSON `POST` with only these fields:

| State | `title` | `body` | `type` |
| --- | --- | --- | --- |
| `working` | `lazysh · <alias>` | `An agent is working.` | `info` |
| `needs-attention` | `lazysh · <alias>` | `An agent needs your attention.` | `warning` |
| `done` | `lazysh · <alias>` | `An agent finished.` | `success` |

`format` is always `text`, and `tag` is present only when you configured tags. The
fixed English sentences carry no prompt, project path, command, transcript, SSH
credential or source capability. The stable receipt ID is still sent as
`Idempotency-Key`; Apprise ignores it, so the relay's receipts and the bounded retry
rules below are what prevent repeated delivery.

Receipts finish in a closed set of states. HTTP 200 is `accepted`. HTTP 424, which
Apprise returns when one or more downstream services failed, is `partial` and is not
retried, so a broken downstream service cannot start a retry storm. Other non-200
answers, including 401 from your proxy and 404 for an unknown key, are `rejected`
without a retry. HTTP 408, 429, 5xx, timeouts and connection failures use the relay's
three-attempt retry and then `failed_unknown`. Like every admitted request, `partial`
and `rejected` keep `mayHaveReachedDestination` true. The host companion's bound
publisher accepts `partial` and `rejected` receipts, so a `relay run` that republishes
an event after a lost acknowledgement records the original receipt instead of retrying.

Destination identity is `apprise`, the endpoint, the token digest and the sorted tag
set. Changing the format, URL, token or tags needs `configure-destination` with the
same arguments as `serve`, which starts a new target generation, disables delivery and
cancels old pending work, exactly as for Gotify. Webhook and Gotify identities are
unchanged.

**Stateless mode is not supported.** Apprise's stateless `/notify` route takes the
downstream service URLs in each request, which would put every downstream secret into
lazysh's files. Use a stateful key instead.

## Emit terminal, tmux, Herdr and agent events

The existing `lazysh-notifications publish` command is the authenticated emitter;
no new event kind is needed. Install that CLI on the emitting host (build the
notification-service package if it is not installed), provision a separate source
capability for each integration with the `source-create` procedure above, and
explicitly enable its destination. The Android app alone does not install this
host CLI. Public aliases should be generic, such as `Terminal` or `Agent`; never
use a project path, host address or prompt as an alias.

For explicit shell/multiplexer callbacks, save this small operator-owned script
as `/private/hooks/publish-event`, mode0700. Replace the CLI/source paths with
your installed executable and provisioned private capability. Create the
owner-only `/private/relay-events` directory first. It records the fixed event ID
and state before networking so an unknown result can be retried with exactly the
same pair; it is an example emitter, not an automatic retry daemon or archive.

```sh
#!/bin/sh
umask 077
case "$1" in working|needs-attention|done) state=$1 ;; *) exit 2 ;; esac
event_id=$(uuidgen) || exit 1
record=$(mktemp /private/relay-events/event.XXXXXX) || exit 1
printf '%s %s\n' "$event_id" "$state" > "$record" || exit 1
exec /opt/lazysh/bin/lazysh-notifications publish \
  --capability-file /private/relay-config/terminal-source \
  --event-id "$event_id" --state "$state"
```

This needs the host's `uuidgen` and `mktemp` tools. Keep the record after an
unknown result; retry the CLI with its saved UUID/state, not by rerunning the
script and generating a new event. Inspect the returned relay receipt before
manually retiring records. Only the finite state/public alias reaches the
notification destination; the script does not send command arguments or output.

Terminal command completion, in any ordinary shell (including a tmux/Herdr or
Zellij pane), can explicitly invoke it after the command:

```sh
your-command
result=$?
state=done
test "$result" -eq 0 || state=needs-attention
/private/hooks/publish-event "$state"
```

For tmux, append an explicit notification hook rather than replacing existing
hooks. These use its supported [event hooks](https://github.com/tmux/tmux/wiki/Events):

```sh
tmux set-hook -ag alert-bell 'run-shell -b "/private/hooks/publish-event needs-attention"'
tmux set-hook -ag pane-exited 'run-shell -b "/private/hooks/publish-event done"'
```

`pane-exited` means a pane process exited and was removed; use `pane-died`
instead for panes retained by `remain-on-exit`. Neither event means an individual
interactive shell command finished. Use the completion wrapper for that case.
Do not interpolate pane titles, current directories, terminal output or agent
text into these shell commands.

For Herdr, use the same wrapper in an existing pane, or explicitly run it with
the installed CLI's existing `pane run` command, choosing your real session and
pane identifiers:

```sh
herdr --session work pane run w1:p1 'your-command; result=$?; state=done; test "$result" -eq 0 || state=needs-attention; /private/hooks/publish-event "$state"'
```

This reports that selected command's completion; it does not observe every Herdr
pane, infer an agent's attention from terminal text, or mirror Herdr's local
notification banners. For actual agent attention/done transitions, install the
[managed provider hooks](agent-hooks.md) with their preview/status/expected-plan
consent flow, then configure the companion publisher below. For example, use
`lazysh-agent hooks preview --agent codex`, inspect
`hooks status --agent codex --profile-root /home/user/.codex`, and install using
that status's exact `installPlan`. Configuring the relay does not install hooks.
The foreground `relay run` process is also a separate explicit opt-in. The same
source paths work with the encrypted ntfy destination, the external Gotify
client or an Apprise key; no destination selection installs these callbacks automatically.

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

Webhook destinations receive only `schemaVersion:1`, `receiptId`, `eventId`, finite `kind` and their admin-provisioned public `alias`. Gotify destinations receive the fixed `title`, public-alias/state `message` and finite `priority` described above. Apprise destinations receive the fixed `title`, `body`, `type`, `format` and optional `tag` described above, and their 424, 4xx and retryable answers end as described in that section. All formats send the receipt ID as the stable HTTP `Idempotency-Key` across attempts and restarts; that header alone does not deduplicate effects. For webhook and Gotify, only HTTP 2xx marks `accepted`; for Apprise only HTTP 200 does. Either way this is the destination's successful HTTP response, **not** proof that a device displayed it or a human saw it. Exactly-once webhook effects require receiver-side idempotency; Gotify provides no verified guarantee here, so retries may produce duplicate notifications.

One worker admits one POST at a time. Admission is durably recorded before networking. A request timeout, crash, shutdown or revocation after admission can leave an unknown remote outcome; `mayHaveReachedDestination` remains conservatively true. Disconnecting a request cannot retract a remote effect. The worker performs at most three admitted attempts, with a two-second retry delay and a ten-second per-request budget (three-second connection budget). Queued work expires after 24 hours using the service host's clock. `failed_unknown`, `expired_unknown` and `cancelled_unknown` do not assert non-delivery, and neither do the Apprise-only `partial` and `rejected` states.

Disable/revoke cancels queued work and aborts an affected admitted request; already-admitted effects may still finish remotely. Disable and each explicit enable advance the persisted generation. Re-enabling never freshens old receipts, even after restart. New events are rejected while disabled. On restart, interrupted requests may retry only with their original target identity/generation and the same key. Supplying a different destination format, URL/key or admin identity fails closed.

To change a destination, stop the service, then run `configure-destination` with the same private-file arguments as `serve`. This requires the existing admin identity, cancels old pending work, advances generation and leaves delivery disabled, including when the supplied destination is unchanged. Explicitly enable it after restarting. Admin key replacement and account recovery are outside this first service version; changing an admin file does not silently adopt queued work.

There are at most 128 retained source identities, 1,000 pending events and 10,000 retained receipts. Capacity exhaustion rejects new identities/events rather than deleting an accepted idempotency record or evicting queued work. There is no automatic retention/archive tool in this slice. Export/archive and start a new explicitly provisioned account when the finite lifetime receipt capacity is reached. Do not delete individual database rows to free space or reuse old identities.

## Verification and limits

Standard Cargo fixtures own their temporary storage, loopback listeners and TLS receiver certificate. They exercise real HTTP ingest-to-TLS-delivery-to-receipt, auth, source isolation, dedup conflicts, private no-overwrite files/CLI output, actual child-process source creation with a committed lost TLS response and same-envelope resume, explicit-CA/wrong-host/no-CA handling, restart/idempotency, target binding, held POST/revoke, redirect rejection, timeout, shutdown, one-worker and capacity bounds. No external notification provider, user credentials, model, device or deployment is contacted. An in-process Apprise API stub checks the method, path, Bearer and `Idempotency-Key` headers, JSON body, type mapping and tags, plus 200, 424, 4xx, 408, 429 and 5xx handling and retries through the real worker. The `native-linux-runtimes` CI job also starts the official `caronc/apprise` 2.0.2 image, pinned by digest, behind an owned TLS proxy that checks the Bearer token. Its stateful key's only targets are loopback `json://` receivers, and the test asserts the tagged receiver got each mapped title, message and type, that a failing downstream service ends `partial`, and that a wrong proxy token ends `rejected`. Companion fixtures additionally execute the real CLI through owned TLS relay and destination servers, lost-ACK process recovery, exclusive drain/disable races, original-generation rejection, exact capability binding, downgrade rejection and dispatch deadlines. Native app push/account binding and physical background delivery remain future #14 acceptance, not a capability advertised by this service.
