# Optional transcription relay

`lazysh-transcription` is a separate, optional Rust service for short dictation.
It requires a Unix host with private-file ownership/permission enforcement. Linux
fixtures are verified; macOS runtime operation and reverse-proxy deployment are
not yet verified. Other hosts fail before opening secrets or creating service
state. This service-only slice does not configure or upload audio from the lazysh
client. Whisper and Apple dictation defaults remain unchanged.

The operator supplies an OpenAI API key on the server. Device credentials are
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
recovered from storage. Later client integration will store that token in the
platform vault under a separate service enrollment.

## API contract

All JSON successes/errors contain `schemaVersion: 1`; responses are `no-store`.

| Method and path | Credential | Request and result |
| --- | --- | --- |
| `POST /v1/devices` | Administrator | JSON `{"label":"phone"}` with a nonempty, control-free label up to 64 UTF-8 bytes. Returns `{schemaVersion,device:{id,label},token}`. At most 128 enrolled devices. |
| `GET /v1/devices` | Administrator | Returns `{schemaVersion,devices:[{id,label}]}` without token hashes or secrets. |
| `DELETE /v1/devices/{id}` | Administrator | Revokes the token, cancels its current job, and returns 204. Cancellation still completes if the HTTP caller disappears after the database work starts. |
| `GET /v1/capabilities` | Device | Returns fixed model, supported language hints, sample rate, and WAV/sample bounds. |
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

Language hints are `auto`, `en`, `es`, `fr`, `de`, `pt`, `ja`, and `zh`. `auto`
omits a language field; the others use the documented singular multipart
`language` field. This is a provider hint, not an enforced output-language or
accuracy guarantee. The fixed request uses `model=gpt-transcribe`,
`response_format=json`, and filename `dictation.wav` at
`https://api.openai.com/v1/audio/transcriptions`. No client-provided URLs, models,
prompts, or arbitrary provider options are accepted. See the
[official OpenAI transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create).

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
already received by OpenAI or guarantee that a provider stops processing or
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
protection from operator crash dumps, or OpenAI retention policy. Responses and
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
independent. Client enrollment, microphone-to-WAV upload, editable draft staging,
and real-device acceptance remain follow-up work under issue #13.
