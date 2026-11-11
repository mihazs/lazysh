# Optional transcription relay

`lazysh-transcription` is a separate, optional Rust service for short dictation.
It requires a Unix host with private-file ownership/permission enforcement. Linux
fixtures are verified; macOS runtime operation and reverse-proxy deployment are
not yet verified. Other hosts fail before opening secrets or creating service
state. The client's explicitly selected [Cloud engine](voice.md#explicit-cloud-dictation)
can enroll a device and upload bounded dictation. No service is configured by
default; local Whisper and Apple dictation defaults remain unchanged.

By default the operator supplies an OpenAI API key on the server. An explicit
[self-hosted whisper.cpp option](#self-hosted-whispercpp) needs no paid API key.
Device credentials are
separate revocable tokens; the provider key and administrator token must never be
given to a device client. This is an operator-hosted integration, not enrollment
in the reference client's hosted service or a promise of any vendor subscription allowance.

## Run and enroll

Build with `bunx moon run transcription-service:build` or
`cargo build --release -p lazysh-transcription --locked`. Generate an administrator
token with `lazysh-transcription keygen`, saving its output in a private regular
file. Save your provider key in another private regular file. Both must be owned
by the service user, have no group/other permissions, and have no hard links or
symlink leaf. Secrets are read from these files, not command-line values or
environment variables. The data directory must be dedicated, owner-only, and
used by one service process.

```sh
lazysh-transcription serve \
  --admin-token-file /private/relay/admin-token \
  --provider-key-file /private/relay/openai-key \
  --data-dir /private/relay/state \
  --device-seconds-per-day 300 \
  --global-seconds-per-day 1800 \
  --listen 127.0.0.1:7348
```

These quota values are operator-chosen examples, not provider allowances. Both
flags are required. Per-device limits allow 1–86,400 audio seconds/day; the global
limit allows 1–11,059,200 seconds/day independently. The service listens only on
loopback. Expose it through your own authenticated-device-accessible HTTPS reverse
proxy, with audio/body/header logging disabled. TLS, proxy configuration, provider
credentials/account access, and billing remain the operator's responsibility.
There is no bundled deployment or automatic account lookup.

Requests use `Authorization: Bearer <token>`. No cookies or CORS origins are
enabled. Keep administrator credentials in private operator tooling, not in the
client's settings or URLs. Enrollment returns a device token once; it cannot be
recovered from storage. The client's Cloud enrollment stores an administrator-issued
device token in its separate platform-vault account; it never needs the administrator token.

## API contract

See [api contract](reference/cloud-transcription.md#api-contract) for details.

## Self-hosted whisper.cpp

To select the separate free-software backend, replace `--provider-key-file` with
`--whisper-cpp-port 8080` in the relay command. The flags are mutually exclusive;
without the new flag the OpenAI key and behavior remain required. The port must
be a nonzero integer within 1–65535. The relay constructs only
`http://127.0.0.1:<port>/inference`; devices cannot choose this port, an upstream
URL, model path, prompt, credentials or arbitrary provider options. Redirects,
environment proxies and retries stay disabled. No OpenAI credential is read or
sent in this mode. All app features are free; hosting, electricity and network
costs remain the operator's responsibility.

The supported protocol profile is the official MIT-licensed whisper.cpp
[v1.9.5 server](https://github.com/ggml-org/whisper.cpp/tree/d1be6fde11ac6e0407606b4e42fe72d34add8037/examples/server),
source commit `d1be6fde11ac6e0407606b4e42fe72d34add8037`. It accepts multipart
`file` (`dictation.wav`), `response_format=json` and an explicit `language`
(including `auto`); it returns JSON text. There is no OpenAI `model` field or
Authorization header. In particular, omitting `language` would select the
server's English default, so this adapter sends `auto` explicitly.

Build and run that upstream separately, as an unprivileged isolated process
reachable only by the relay. Bind it to `127.0.0.1`, keep `--convert`, debug and
realtime/progress printing disabled, and keep proxy/request/audio logging off.
The example server also exposes unauthenticated `/load` and permissive browser
CORS: never publish it directly or expose those routes through the relay's
public proxy. A private network namespace for both processes can separate it
from other local applications. No upstream process is launched, model downloaded
or network namespace configured by lazysh.

One eligible initial model is the multilingual `base` model, not `base.en`.
The pinned [model documentation](https://github.com/ggml-org/whisper.cpp/blob/d1be6fde11ac6e0407606b4e42fe72d34add8037/models/README.md)
provides conversion from original weights and identifies its 142 MiB ggml file
with SHA-1 `465707469ff3a37a2b9b8d8f89f2f99de7299dac`. The original
[Whisper code and weights are MIT-licensed](https://github.com/openai/whisper#license).
Verify artifact provenance and integrity before loading. This documentation does
not download or attest an operator's loaded model. Hardware speed, memory use
and accuracy depend on the chosen model and host; the existing 45-second relay
deadline is unchanged and is not a performance guarantee.

The unchanged schema-1 capability shape uses the closed profile value
`model: "whisper.cpp"` rather than `gpt-transcribe`; the UI labels it a backend.
This is configured protocol identity, not model-weight or remote-host attestation.
Old clients reject the new profile. Updated clients keep local dictation and
existing enrollment/consent behavior; select Cloud and refresh metadata explicitly
to inspect the relay. There is no automatic provider fallback or upload replay.

Native owned HTTP fixtures verify this profile's multipart/auto-language contract,
absence of provider credentials, response bounds/redaction, no retries/redirects,
quota retention and cancellation/revocation of the connection. These are fake
upstream fixtures; by themselves they do not establish real engine execution,
accuracy or engine-side cancellation. Broader acceptance remains under
[#345](https://github.com/mihazs/lazysh/issues/345).
The subsequent [owned Linux engine acceptance](whisper-relay-acceptance.md)
records a real pinned-engine/base-model run, its exact proof and remaining limits.

## Quota and cancellation semantics

See [quota and cancellation semantics](reference/cloud-transcription.md#quota-and-cancellation-semantics) for details.

## Resource and privacy boundaries

See [resource and privacy boundaries](reference/cloud-transcription.md#resource-and-privacy-boundaries) for details.

## Verification and rollback

`cargo test -p lazysh-transcription --locked` uses synthetic WAVs, temporary
private state, the compiled CLI, ephemeral loopback HTTP/TCP providers, and a
paused Tokio clock for provider deadlines. Unit-test provider dispatch refuses
the production endpoint, so a broken test cannot accidentally contact OpenAI.
Fixtures check authentication separation, enrollment/revocation, quota races and
restart/day behavior, WAV/JSON/body bounds, language hints, non-retry/redirect
behavior, cancellation during upload/header/body phases, real disconnect and
shutdown cleanup, private files, and dropped-caller database races. These tests
do not establish real OpenAI compatibility, billing, accuracy, deployment, or
physical-device behavior.

Rollback is stopping the optional service. Revoke device tokens before retiring
it if the endpoint may return. Preserve the private database to preserve quotas;
deleting it resets device enrollment and usage accounting. Local dictation is
independent. Client enrollment and editable Cloud dictation are available through
the explicitly selected Cloud engine; real-provider and physical-device acceptance
remain follow-up work under issue #13.
