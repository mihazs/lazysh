# Dictation

Whisper remains the default. On Linux x86_64, [Parakeet dictation](voice-parakeet.md)
adds an explicitly downloaded local model, automatic language detection, and a
reusable recognizer. Cancel discards its result while synchronous native work may
continue; controls remain busy until that worker finishes. Other platforms report
Parakeet unavailable.

Open Voice, explicitly download a catalog model or import a trusted Whisper tiny/base GGML `.bin` file, choose its language, and select Record speech. Microphone permission is requested only when recording starts. Stop and transcribe runs the model on this device. Edit the draft before copying it or staging it in the current terminal composer. Staging does not send a prompt.

Models come from the [official whisper.cpp model collection](https://huggingface.co/ggerganov/whisper.cpp/tree/main). English-only `.en` models require English; use multilingual tiny/base for other languages. The app imports at most three models, each at most 160 MiB, through 1 MiB chunks. Imports validate the GGML magic and supported tiny/base architecture dimensions, then publish without replacing an existing model. Remove selected model deletes its local copy. Only import model binaries from a trusted publisher: the native model parser is not a sandbox for hostile files.

## Compose a review draft

In the default review mode, each completed transcription appends to the latest
editable draft instead of replacing existing typed or dictated text. Nonempty
parts are separated by one line feed; existing whitespace and new transcription
text are preserved. Edits made while recording or inference is pending remain
part of the draft. Empty or whitespace-only results leave it unchanged.

The existing composer limit remains 65,536 UTF-16 code units. An append that would
exceed it keeps the entire prior draft and reports an error without truncation.
Recent history remains per transcription, subject to the existing capture/consent
and retention rules; it does not silently save the combined typed draft. Explicit
history reuse replaces the editable draft, which becomes the base for subsequent
review dictation.

Copy and Stage remain explicit. Direct dictation retains its separate clip-only
behavior: only the newly transcribed result is queued once with the options
captured for that recording, and the draft mirrors that clip. Accumulated review
text is never automatically replayed to the terminal. Cancellation, hidden views,
session changes, original access revocation and unmount still reject stale results.
No new engine, network request, model or provider behavior is introduced.

## Downloadable Whisper catalog

Choose **Downloadable model**, review its size and language, then select **Download selected model**. Viewing the catalog reads local metadata and never starts a network request. Downloads contact Hugging Face only after that explicit click; they send no audio, prompts, credentials or account tokens. They do not transcribe or send a draft automatically. Local file import remains available independently.

The catalog pins [publisher revision `5359861c739e955e79d9a303bcbc70fb988958b1`](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1). Upstream's [official download implementation](https://github.com/ggml-org/whisper.cpp/blob/master/models/download-ggml-model.sh) identifies this Hugging Face repository as its model source. Each file's pinned Git LFS pointer provides its exact size and SHA-256; these values were checked against the publisher's revision-specific tree API and raw pointers. The collection is published under MIT terms.

| Model | Bytes | SHA-256 |
| --- | ---: | --- |
| [Tiny English](https://huggingface.co/ggerganov/whisper.cpp/raw/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin) | 77,704,715 | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` |
| [Tiny multilingual](https://huggingface.co/ggerganov/whisper.cpp/raw/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin) | 77,691,713 | `be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21` |
| [Base English](https://huggingface.co/ggerganov/whisper.cpp/raw/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin) | 147,964,211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` |
| [Base multilingual](https://huggingface.co/ggerganov/whisper.cpp/raw/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin) | 147,951,465 | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |

Native IPC accepts only one of the four catalog IDs and a fresh request UUID, never a URL or caller-supplied digest. The downloader allows HTTPS on Hugging Face and its `hf.co` CDN domains, with at most five redirects. It uses no configured proxy or authorization headers, has a 20-second connection limit and a 15-minute overall request limit, and does not resume partial transfers. Server errors, mismatched declared/actual sizes, invalid GGML headers and incorrect SHA-256 values discard the partial file. A streaming SHA-256 check precedes the existing exclusive publication operation. Exact size and the three-model quota are checked before downloading, with quota rechecked at publication. Existing models are never replaced.

Only one download runs at a time. Progress reports bytes received and verification state. **Cancel download** requests cancellation of that exact job and waits for cleanup; closing/backgrounding the view also requests cancellation. A queued cancellation prevents that request UUID from starting. Cancellation and publication serialize at the final commit: a cancellation acknowledged first prevents installation; cancellation after successful publication reports that the model was already installed. Incomplete `.part` files are removed on failure/cancellation, future-drop and next startup. Failed downloads can be retried with a new request UUID.

Cargo tests stream deliberately fragmented data through a local HTTP fixture and the actual import path, checking hash mismatch, oversized/truncated responses, queued/body/header-wait cancellation, commit collisions, quota and cleanup. These fixtures validate transfer/publication behavior; they are not speech models or inference evidence. Vitest tests cover explicit opt-in, progress, busy/cancel states, quota, non-overwrite controls, verification errors and unmount cleanup. Production HTTPS redirect policy has separate boundary tests. Physical-device network, storage and background behavior still require acceptance testing.

Recordings last at most 30 seconds and remain in memory. Audio is mixed to mono and resampled to 16 kHz before native inference. One inference runs at a time with at most four CPU threads, a cancellation callback, and a two-minute inference limit. Native diagnostic logging is suppressed because it can contain dictated text. Cloud starts unconfigured and requires explicit enrollment and engine selection. Dictation history is temporary by default, with optional device-local persistence as described below.

The engine is [whisper-rs 0.16](https://codeberg.org/tazz4843/whisper-rs), backed by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Upstream whisper.cpp documents Linux, Windows, macOS, Android and iOS support; lazysh must still verify microphone permission, codec decoding, inference latency, battery and model memory on each advertised device. Android includes microphone runtime permissions; Apple bundles include a microphone purpose string and macOS audio-input entitlement. A denied or unsupported microphone reports an error and does not start inference.

Building the engine requires CMake and libclang alongside the platform C/C++ toolchain. Cargo config disables build-machine CPU tuning and optional x86 instruction sets so distributed binaries retain a portable baseline. The Android package task passes the selected NDK to CMake and uses the engine crate's supplied FFI bindings for its ARM64 target, avoiding host C-library headers during cross-compilation. Tauri detects and packages the NDK C++ shared runtime automatically. Hardware acceleration and CPU dispatch variants need separate measured release work.

Cargo tests validate import limits, ordering, non-overwrite publication, cancellation cleanup and audio rejection. Vitest tests validate resampling, model boundaries, microphone denial and explicit draft staging. The ignored native speech test accepts explicit external fixtures:

```sh
LAZYSH_WHISPER_TEST_MODEL=/path/to/ggml-tiny.en.bin \
LAZYSH_WHISPER_TEST_WAV=/path/to/jfk.wav \
cargo test -p lazysh voice::tests::local_whisper_transcribes_known_speech_without_network --locked -- --ignored
```

The speech fixture is the [official whisper.cpp JFK sample](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav), a mono 16 kHz PCM WAV. The test checks that inference returns its expected phrase. Model/audio downloads are external fixtures and are never bundled into the repository or fetched by the test. This is functional inference evidence, not an accuracy or device-performance benchmark.

## Apple SpeechAnalyzer

On supported iOS 26+ hardware, Voice also offers Apple's on-device SpeechAnalyzer engine. It requires a build using the iOS 26 SDK and Swift 6.2 or newer. Unsupported platforms and devices report the engine unavailable; Whisper remains available through its own model selection. Switching engines does not select a cloud provider.

Choose a supported BCP-47 language and explicitly install its Apple model before recording. This downloads system-managed model assets, not audio. The app reserves at most three languages. “Release” relinquishes this app's reservation; Apple may keep a shared model installed for another app or system feature. Capability checks report actual supported, installed and reserved language lists, and never initiate installation.

The existing microphone capture provides bounded mono 16 kHz PCM to the native plugin. Microphone access still requires permission. Apple's [speech authorization documentation](https://developer.apple.com/documentation/speech/asking-permission-to-use-speech-recognition) limits its separate server-transcription authorization process to `SFSpeechRecognizer`; this plugin uses SpeechAnalyzer and never calls that authorization API. AVAudioConverter prepares a compatible in-memory buffer; finalized SpeechTranscriber results populate the same editable draft. Audio is never written to a temporary file or uploaded. Cancellation and backgrounding reject pending results, cancel the analyzer or installation request, and prevent a cancelled request identifier from starting a queued operation. Native deadlines stop waiting after 120 seconds for transcription or 300 seconds for model installation; late results cannot replace a newer draft. Apple controls shared asset downloads and retention.

The implementation follows the current [SpeechAnalyzer API](https://developer.apple.com/documentation/speech/speechanalyzer), [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber) and [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory) contracts. Current SDK names differ from older WWDC snippets: this implementation uses `.transcription`, `reserve(locale:)`, and `release(reservedLocale:)`.

Rust tests validate the PCM, locale and request-ID boundary; UI tests cover explicit engine choice, installation and cancellation. Native Swift compilation is an iOS CI gate. No Apple microphone/model inference, accuracy, latency or battery claim has been verified on physical hardware.

An optional Unix-host [transcription relay](cloud-transcription.md) provides revocable device tokens and durable audio quotas for explicitly selected Cloud dictation. Remaining issue #13 work includes Parakeet on other platforms, forced-language support, and real-device acceptance.

## Explicit Cloud dictation

Whisper remains the initial engine. Select **Cloud** to configure your own relay;
there is no automatic cloud fallback when a local engine fails. Import its HTTPS
origin and an administrator-issued **device** token using **Verify and save Cloud
device**. This probes authenticated capabilities and quota before saving the
origin-bound enrollment in the platform credential vault. It does not record or
upload audio. No provider API key or administrator token belongs in this form.
No configured token is returned to the WebView or stored in browser preferences;
unsaved input is cleared on hidden/pagehide. Changing origin requires a new token.

Selecting Cloud or explicitly refreshing it checks the relay, not the provider's
account validity. Record remains disabled until capabilities and available service
audio quota have been verified. The panel shows device/shared remaining and total
audio seconds, the UTC quota window, and last check time. A shared limit can be
lower than a device limit; lowering an operator limit below prior usage correctly
shows zero remaining. These are operator-configured relay limits, not OpenAI or
reference client allowances. Other devices can consume quota after a check, so the server
remains authoritative at dispatch. Choose a language hint advertised by the
service; `auto` omits the hint. Hints do not guarantee an output language.

Only **Record speech** starts microphone capture. A local native reservation is
created before microphone access; relay registration occurs only after recording,
decoding and bounded mono 16 kHz PCM are ready. This avoids expiring its 30-second
upload slot while recording. Audio is encoded into canonical PCM16 WAV in native
memory (at most 960,044 bytes), never a temporary file, and uploaded only to the
enrolled origin's fixed relay API paths.

Cancel, a hidden WebView, pagehide, session change, unmount, or native window
destruction invalidates that exact recording. Desktop blur alone does not cancel:
microphone permission dialogs can move focus. A late local reservation is removed
without opening the microphone or creating a remote job. A queued transcription
cannot recreate a cancelled/expired reservation or use another session/window's
identifier. Configuration epochs reject results from replaced enrollments.

Once a relay job identifier is known, cancellation drops the upload/result wait
and attempts a bounded DELETE using the same origin and token snapshot. If the
registration response never supplied an identifier, cancellation sends no audio;
an empty job might exist and expires 30 seconds after server creation. An explicit
retry can receive an active-job error until it expires. Failed DELETE or offline
cleanup is reported as unconfirmed. Cancellation cannot retract received audio,
refund admitted service quota, or guarantee that a provider stops processing.
There are no automatic registration, upload or input retries.

**Forget Cloud device** cancels local recording work and removes this device's
saved enrollment. It does not perform administrator-only server revocation; the
administrator can revoke the issued token separately. OS credential calls are
bounded to one owned task. Cancelling a recording does not wait for a blocked OS
credential prompt, and no provider request starts from its late return. Another
credential operation reports busy until that OS call finishes.

Successful text follows the same editable draft, optional history consent and
explicit direct-delivery controls described below. Cloud does not enable direct
input or Enter. Returned text is bounded to 16 KiB UTF-8; the existing direct-input
guard rejects terminal controls and stale sessions. The relay stores no
transcripts, but opting into local Remember history can save the returned text on
this device under the normal history policy.

Native HTTPS fixtures verify the protocol, WAV encoding, validation, no redirects
or retries, origin/session/epoch binding, pending-registration cleanup and OS-vault
cancellation races. Vitest and desktop/phone Playwright use synthetic audio/IPC to
verify opt-in, quota/language UI and stale-result suppression. Android
instrumentation includes actual WebView-to-native status and invalid-token calls;
its runtime outcome must be checked in hosted CI. These checks do not establish
real provider/account compatibility, physical microphone behavior, native mobile
background-event ordering, accuracy, billing, or live end-to-end cloud dictation.

## Dictation history

Recent results remain available while Voice stays open. **Use in draft** restores the complete text to the editable draft; it never stages or sends it. **Delete** removes one result and **Clear history** removes all results. Closing Voice discards temporary history. No history text is saved by default.

Explicitly enable **Remember dictation history on this device** to save current and future results in this device's WebView IndexedDB storage. Saved history holds at most 20 complete entries and 256 KiB, keeping the newest entries that fit. Only text, a random entry identifier and the time dictation was started are stored, with consent and revision metadata. No raw audio, connection details or session identifiers are included. Text is not encrypted by lazysh; device storage access can expose dictated secrets. It is not synchronized or uploaded.

Saved results are available for up to seven days from when each dictation was started. Inference and reuse do not renew that timestamp. Expired entries are hidden and pruned when Voice opens, returns to the foreground, or checks storage while open. This does not promise deletion from disk while the app is closed. Disabling Remember deletes saved text and leaves current-view results temporary. A small text-free consent/revision tombstone remains so an old window cannot restore a deleted result.

Each append checks consent and the captured revision in the same IndexedDB read/write transaction as the save. Clear, Delete and consent changes replace the revision, preventing pending transcription results or stale windows from restoring removed text or re-enabling Remember. Concurrent valid appends merge against the current stored entries. Notifications refresh other open views, but save correctness does not depend on notification delivery. View cancellation and closing Voice invalidate pending additions; a completed transcription can still populate its editable draft after a history clear without being put back into history.

If local storage fails, Remember is never silently enabled. Failed deletion reports that the stored copy may remain; retry Delete or Clear history before closing. IndexedDB availability and WebView lifecycle behavior still require physical-device acceptance. Vitest covers temporary results, bounds, stale captures and editable reuse. Playwright uses real browser IndexedDB transactions in two pages to check stale writes, consent changes, concurrent appends, removal retries, queued cancellation and expiry pruning.

## Direct terminal dictation

Review in the editable draft remains the default. For the current Voice view only, explicitly enable **Type final result directly into terminal** to send each newly completed transcription to this connected terminal. **Auto-send: press Enter** is a separate option, initially off. Turning direct delivery off also turns Auto-send off. Both options reset when Voice closes or the active session changes, and cannot be changed during recording or inference. They do not apply to existing draft text or reused history.

Direct delivery types the final result immediately. Auto-send also appends Enter and can execute a shell command; other terminal programs can react to ordinary keystrokes even without Enter. The current engines return a completed transcript, so this is not word-by-word streaming. The draft remains editable after delivery, but editing it does not change input already sent. History's separate consent and retention policy is unchanged.

The app rechecks the exact active, connected session UUID, visible WebView, Voice view and recording generation immediately before a one-shot dispatch. A hidden WebView, cancellation, closed Voice view, disconnect intent or replaced session rejects its late result. Desktop window blur alone does not cancel: microphone permission UI can temporarily move focus. Physical-device lifecycle ordering still needs acceptance testing. Text and optional Enter use a single existing terminal-input call, preserving the same local/SSH/Mosh/ET routing. Native success acknowledges the bounded input queue, not remote execution. There are no automatic retries or later, separate Enter writes. Cancel cannot retract input already queued, and a lost connection can leave delivery uncertain.

Direct input requires a nonempty single line without terminal control characters, line separators or malformed Unicode, within 64 KiB of UTF-8 including the optional Enter. Multiline or rejected results remain in the draft for editing or explicit staging. Failed input reports the error and retains the draft; it is never resubmitted automatically. **Use in draft** in history continues to restore text only, even while direct mode is enabled.

Vitest checks Unicode/control/byte boundaries, captured choices, one-shot claims, stale-session and foreground checks, no retries, and draft-only history reuse. Playwright exercises the actual App/Voice/bridge path at desktop and phone widths using synthetic audio and native-IO fixtures. Those browser checks do not verify a real microphone, speech model, operating-system background behavior, terminal process, or physical-device input delivery.

## Interface language

Voice controls, progress and app-owned errors use the selected English, Brazilian
Portuguese or Spanish interface catalog. Recognition language stays independent:
its protocol codes and displayed endonyms do not change when the interface does.
Model filenames/catalog labels, engine names, transcripts and received native
reasons/errors remain verbatim. Initial client fallback explanations use the
catalog until a native capability response arrives, including a response with an
empty reason.

Language changes update the existing view. They do not restart a microphone,
model download, asset operation or inference, replace its request/channel IDs,
change the captured direct/Enter choice, resubmit a result or erase the editable
draft. Persistent local progress/error keys are translated while rendering;
Cloud cleanup warnings retain any preceding raw diagnostic. Synthetic Vitest and
Playwright checks verify these state transitions and exact final input payloads,
not real-device microphone/model or OS lifecycle behavior.
