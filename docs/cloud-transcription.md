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
in Moshi's hosted service or a promise of any vendor subscription allowance.

## Run and enroll

Build with `bunx turbo run build --filter=@lazysh/transcription-service` or
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

All JSON successes/errors contain `schemaVersion: 1`; responses are `no-store`.

| Method and path | Credential | Request and result |
| --- | --- | --- |
| `POST /v1/devices` | Administrator | JSON `{"label":"phone"}` with a nonempty, control-free label up to 64 UTF-8 bytes. Returns `{schemaVersion,device:{id,label},token}`. At most 128 enrolled devices. |
| `GET /v1/devices` | Administrator | Returns `{schemaVersion,devices:[{id,label}]}` without token hashes or secrets. |
| `DELETE /v1/devices/{id}` | Administrator | Revokes the token, cancels its current job, and returns 204. Cancellation still completes if the HTTP caller disappears after the database work starts. |
| `GET /v1/capabilities` | Device | Returns configured backend profile in the historical `model` field, supported language hints, sample rate, and WAV/sample bounds. |
| `GET /v1/quota` | Device | Returns `{schemaVersion,quota}` with UTC window start/end, device/global limit/used/remaining samples. Divide samples by 16,000 for audio seconds. |
| `POST /v1/transcriptions` | Device | JSON `{"language":"auto"}`. Returns `{schemaVersion,jobId,uploadWithinSeconds:30}`. Creates an empty in-memory slot, not a provider request. Only one current job per device. |
| `PUT /v1/transcriptions/{jobId}/audio` | Same device | `Content-Type: audio/wav` and the raw canonical WAV. Returns `{schemaVersion,jobId,text,quota}`. Only the first upload can start; an active duplicate returns 409. |
| `DELETE /v1/transcriptions/{jobId}` | Same device | Cancels a registered/uploading/running job and returns 204. An absent or differently owned job returns 404. |

Job IDs and device IDs are opaque random hexadecimal identifiers. Upload never
creates a missing job, so an upload after acknowledged cancellation cannot
recreate it. Invalid input, provider failure, cancellation, and successful
completion remove the current upload slot. An unused slot expires after 30
seconds. Restart discards all job slots; register a fresh job after an explicit
user retry. There are no automatic retries or replayed transcripts.

Language hints are `auto`, `en`, `es`, `fr`, `de`, `pt`, `ja`, and `zh`. For the default OpenAI backend, `auto`
omits a language field; the others use the documented singular multipart
`language` field. This is a provider hint, not an enforced output-language or
accuracy guarantee. The fixed request uses `model=gpt-transcribe`,
`response_format=json`, and filename `dictation.wav` at
`https://api.openai.com/v1/audio/transcriptions`. No client-provided URLs, models,
prompts, or arbitrary provider options are accepted. See the
[official OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

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
upstream fixtures. Actual whisper.cpp execution, model output/accuracy and
engine-side cancellation have **not** been verified by this slice and remain
acceptance work under [#345](https://github.com/mihazs/lazysh/issues/345).

## Quota and cancellation semantics

Only canonical 44-byte-header RIFF/WAVE PCM16 is accepted: format 1, mono,
16 kHz, byte rate 32,000, block alignment 2, exact RIFF/data lengths, no extra
chunks, and 1,600–480,000 samples (0.1–30 seconds). The maximum body is 960,044
bytes, enforced on bytes actually read, including chunked requests. Other WAV
layouts must be converted before upload.

After validation and before provider dispatch, an immediate SQLite transaction
rechecks enrollment and debits both daily counters by the exact PCM sample count.
Concurrent devices cannot overspend the shared limit. Counters survive restart;
revocation does not refund the global counter. A backward day transition fails
closed instead of resetting it. UTC midnight advances the window; the host clock
must be correct. Quota exhaustion returns 429 without contacting the provider.

Quota measures admitted audio, not successful text or provider billing. Once
debited, a provider rejection, network failure, cancellation, dropped response,
process crash, or uncertain dispatch outcome does not refund it. A crash after
debit but before dispatch can therefore consume quota without a provider call.
This conservative boundary prevents retries or cancellation from bypassing the
limit. Changing the operator's quota flags requires restarting the service and
does not erase already-used samples.

Explicit cancellation, revocation, request disconnect, deadline, and shutdown
drop local provider work and release its capacity. They cannot retract audio
already received by the configured upstream or guarantee that a provider stops processing or
charging. A request accepted before revocation may already have sent bytes.
Authentication and dispatch admission are checked independently; revocation and
job cleanup retain their serialization guard even if their caller is dropped.

## Resource and privacy boundaries

There are at most 16 HTTP connections, 32 headers/16 KiB HTTP header buffering,
a five-second header deadline, and a 60-second connection/request lifetime.
At most four uploads/provider operations run concurrently; extra uploads fail
without a queued audio buffer. Upload reading has a ten-second deadline. Provider
connection setup is limited to ten seconds and its complete response to 45
seconds. Provider response bodies are bounded to 64 KiB and returned UTF-8 text
to 16 KiB. HTTP redirects, environment proxies, and automatic retries are disabled.
Database tasks have four owned permits; dropped callers cannot queue unbounded
detached blocking work. Waiting HTTP calls remain subject to the connection and
request bounds.

The service writes only device IDs, token hashes, labels, and aggregate quota
counters to private SQLite storage. It never writes audio, transcripts, job
contents, raw tokens, or provider credentials to its database or logs. Audio and
text are handled in memory; this is not a guarantee of forensic memory erasure,
protection from operator crash dumps, or upstream retention policy. Responses and
errors never expose upstream bodies, provider error messages, database paths, or
credential values. There is no tracing/request logging middleware. Configure the
external proxy accordingly.

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
