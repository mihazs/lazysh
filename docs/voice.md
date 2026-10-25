# Private local dictation

Open Voice, import a trusted Whisper tiny/base GGML `.bin` model, choose its language, and select Record speech. Microphone permission is requested only when recording starts. Stop and transcribe runs the model on this device. Edit the draft before copying it or staging it in the current terminal composer. Staging does not send a prompt.

Models come from the [official whisper.cpp model collection](https://huggingface.co/ggerganov/whisper.cpp/tree/main). English-only `.en` models require English; use multilingual tiny/base for other languages. The app imports at most three models, each at most 160 MiB, through 1 MiB chunks. Imports validate the GGML magic and supported tiny/base architecture dimensions, then publish without replacing an existing model. Remove selected model deletes its local copy. Only import model binaries from a trusted publisher: the native model parser is not a sandbox for hostile files.

Recordings last at most 30 seconds and remain in memory. Audio is mixed to mono and resampled to 16 kHz before native inference. One inference runs at a time with at most four CPU threads, a cancellation callback, and a two-minute inference limit. Native diagnostic logging is suppressed because it can contain dictated text. No cloud provider or automatic upload is configured. Dictation history holds the latest 20 results only while the view stays open and can be cleared.

The engine is [whisper-rs 0.16](https://codeberg.org/tazz4843/whisper-rs), backed by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Upstream whisper.cpp documents Linux, Windows, macOS, Android and iOS support; lazysh must still verify microphone permission, codec decoding, inference latency, battery and model memory on each advertised device. Android includes microphone runtime permissions; Apple bundles include a microphone purpose string and macOS audio-input entitlement. A denied or unsupported microphone reports an error and does not start inference.

Building the engine requires CMake and libclang alongside the platform C/C++ toolchain. Cargo config disables build-machine CPU tuning and optional x86 instruction sets so distributed binaries retain a portable baseline. The Android package task passes the selected NDK to CMake and uses the engine crate's supplied FFI bindings for its ARM64 target, avoiding host C-library headers during cross-compilation. Tauri detects and packages the NDK C++ shared runtime automatically. Hardware acceleration and CPU dispatch variants need separate measured release work.

Cargo tests validate import limits, ordering, non-overwrite publication, cancellation cleanup and audio rejection. Vitest tests validate resampling, model boundaries, microphone denial and explicit draft staging. The ignored native speech test accepts explicit external fixtures:

```sh
LAZYSH_WHISPER_TEST_MODEL=/path/to/ggml-tiny.en.bin \
LAZYSH_WHISPER_TEST_WAV=/path/to/jfk.wav \
cargo test -p lazysh voice::tests::local_whisper_transcribes_known_speech_without_network --locked -- --ignored
```

The speech fixture is the [official whisper.cpp JFK sample](https://github.com/ggml-org/whisper.cpp/blob/master/samples/jfk.wav), a mono 16 kHz PCM WAV. The test checks that inference returns its expected phrase. Model/audio downloads are external fixtures and are never bundled into the repository or fetched by the test. This is functional inference evidence, not an accuracy or device-performance benchmark.

Remaining issue #13 work includes Parakeet, Apple SpeechAnalyzer, optional explicitly configured cloud transcription, downloadable model catalogs, persistent history preferences, and real-device acceptance. The initial implementation provides CPU Whisper with manual trusted model import.
