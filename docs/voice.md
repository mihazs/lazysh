# Private local dictation

Open Voice, explicitly download a catalog model or import a trusted Whisper tiny/base GGML `.bin` file, choose its language, and select Record speech. Microphone permission is requested only when recording starts. Stop and transcribe runs the model on this device. Edit the draft before copying it or staging it in the current terminal composer. Staging does not send a prompt.

Models come from the [official whisper.cpp model collection](https://huggingface.co/ggerganov/whisper.cpp/tree/main). English-only `.en` models require English; use multilingual tiny/base for other languages. The app imports at most three models, each at most 160 MiB, through 1 MiB chunks. Imports validate the GGML magic and supported tiny/base architecture dimensions, then publish without replacing an existing model. Remove selected model deletes its local copy. Only import model binaries from a trusted publisher: the native model parser is not a sandbox for hostile files.

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

Recordings last at most 30 seconds and remain in memory. Audio is mixed to mono and resampled to 16 kHz before native inference. One inference runs at a time with at most four CPU threads, a cancellation callback, and a two-minute inference limit. Native diagnostic logging is suppressed because it can contain dictated text. No cloud provider or automatic upload is configured. Dictation history is temporary by default, with optional device-local persistence as described below.

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

An optional Unix-host [transcription relay](cloud-transcription.md) provides a service-only foundation with revocable device tokens and durable quotas. It is not configured or contacted by this client yet. Remaining issue #13 work includes Parakeet, client enrollment/upload for explicitly selected cloud transcription, and real-device acceptance.

## Dictation history

Recent results remain available while Voice stays open. **Use in draft** restores the complete text to the editable draft; it never stages or sends it. **Delete** removes one result and **Clear history** removes all results. Closing Voice discards temporary history. No history text is saved by default.

Explicitly enable **Remember dictation history on this device** to save current and future results in this device's WebView IndexedDB storage. Saved history holds at most 20 complete entries and 256 KiB, keeping the newest entries that fit. Only text, a random entry identifier and the time dictation was started are stored, with consent and revision metadata. No raw audio, connection details or session identifiers are included. Text is not encrypted by lazysh; device storage access can expose dictated secrets. It is not synchronized or uploaded.

Saved results are available for up to seven days from when each dictation was started. Inference and reuse do not renew that timestamp. Expired entries are hidden and pruned when Voice opens, returns to the foreground, or checks storage while open. This does not promise deletion from disk while the app is closed. Disabling Remember deletes saved text and leaves current-view results temporary. A small text-free consent/revision tombstone remains so an old window cannot restore a deleted result.

Each append checks consent and the captured revision in the same IndexedDB read/write transaction as the save. Clear, Delete and consent changes replace the revision, preventing pending transcription results or stale windows from restoring removed text or re-enabling Remember. Concurrent valid appends merge against the current stored entries. Notifications refresh other open views, but save correctness does not depend on notification delivery. View cancellation and closing Voice invalidate pending additions; a completed transcription can still populate its editable draft after a history clear without being put back into history.

If local storage fails, Remember is never silently enabled. Failed deletion reports that the stored copy may remain; retry Delete or Clear history before closing. IndexedDB availability and WebView lifecycle behavior still require physical-device acceptance. Vitest covers temporary results, bounds, stale captures and editable reuse. Playwright uses real browser IndexedDB transactions in two pages to check stale writes, consent changes, concurrent appends, removal retries, queued cancellation and expiry pruning.
