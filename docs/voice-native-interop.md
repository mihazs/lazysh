# Combined native voice acceptance

Issue #13 requires checking the real client native graph before enabling Parakeet. The optional, default-off Cargo feature `parakeet-acceptance` links the existing Whisper implementation and sealed Parakeet runtime into the client test binary. It adds no IPC command, engine picker, model installer, or automatic fallback. The default-off normal dependency graph excludes Parakeet.

The two ignored Cargo tests run in separate processes, in both initialization orders. Each uses the actual client Whisper inference function and one owned Parakeet recognizer, repeats inference while the other engine is resident, and verifies stable output and model-file cleanup. The licensed [public LibriSpeech fixture](../packages/parakeet-runtime/tests/fixtures/librispeech/README.md), fixed WAV hash, independent corpus reference, and preselected normalized WER <= 0.10 threshold are shared with standalone acceptance. Whisper uses the existing `tiny.en` catalog model, exactly 77,704,715 bytes with SHA-256 `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f`. Inputs are explicitly supplied and verified; tasks do not download weights or use user recordings.

Run from the repository root with private local paths:

```sh
export LAZYSH_WHISPER_TEST_MODEL=/private/cache/ggml-tiny.en.bin
export LAZYSH_WHISPER_TEST_WAV=/private/cache/1272-128104-0000.wav
export LAZYSH_PARAKEET_TEST_ARCHIVE=/private/cache/parakeet-v3-int8.tar.bz2
bunx turbo run test:voice-interop --filter=@lazysh/client
bunx turbo run test:voice-interop:release --filter=@lazysh/client
```

Both tasks disable caching and require all three paths. Each process must exit successfully; a passing test-harness line followed by an abort is a failure. The initial experiment is Linux x86_64 only, with no inference acceptance claim for other architectures or platforms.

Linux CI also runs uncached `test:voice-interop:smoke` after the standalone package checks. It calls both pinned native version APIs and Whisper's native system-information initializer in the real feature-enabled client process, and requires a clean process exit without model weights or provider calls. The standalone CTest checks actual ORT environment/regex startup separately. This smoke check does not claim model loading or inference.

## Reproduced shutdown collision

Before isolation, both engine-order tests satisfied their transcript and cleanup assertions, then aborted with `free(): invalid pointer` during process shutdown. An enabled no-model metric test also aborted after reporting success, while the default-off client control exited zero. GDB located the failing finalization path in the system `libprotobuf-lite.so.36.1.0`, which Mosh links dynamically.

`nm -D -S -C` showed that the executable exported ORT's 8-byte `google::protobuf::internal::fixed_address_empty_string`, while system protobuf defined a 32-byte object under the same symbol. `LD_DEBUG=bindings` demonstrated that the DSO bound this object and `OnShutdownRun` to the executable's private ORT copy. This is evidence of symbol interposition, rather than evidence that Whisper's regex code caused this abort.

The bounded Linux correction preserves the named ORT archive using [`static:-bundle`](https://doc.rust-lang.org/reference/items/external-blocks.html#items.extern.attributes.link.modifiers.bundle), then passes [`--exclude-libs,libonnxruntime.a`](https://sourceware.org/binutils/docs/ld/Options.html#index-_002d_002dexclude_002dlibs) only in the feature-enabled client final link. It does not hide all archives, change global compiler flags, or change the pinned x64 ABI 0 / arm64 ABI 1 policy. The no-model process then exited zero; the private symbols disappeared from its dynamic export table, and `LD_DEBUG` showed system protobuf binding both symbols to itself. Other final consumers that combine this runtime with system protobuf need the same explicit archive isolation.

## Observed Linux results

On 2026-10-25, all four unchanged actual-engine tests passed and their processes exited zero after the correction. Host: Linux x86_64, AMD Ryzen 9 5900X, GCC 16.2.1; the native CMake code uses Release in both Cargo profiles. The release client uses the existing workspace LTO profile. Total test durations include private archive preparation, model loading, inference, and cleanup; they are not isolated inference latency measurements or controlled benchmarks.

| Cargo profile | Whisper then Parakeet | Parakeet then Whisper | Whisper WER | Parakeet WER |
| --- | ---: | ---: | ---: | ---: |
| Debug | 109.99 s | 111.55 s | 0.058824 | 0 |
| Release | 39.02 s | 38.28 s | 0.058824 | 0 |

Whisper returned `Mr. Quilter is the apostle of the middle classes, and we are glad to welcome his gospel.` Parakeet returned `mister Quilter is the apostle of the middle classes, and we are glad to welcome his gospel.` Every repeated/interleaved output was identical for its engine, and both private model directories were removed after native destruction. The threshold and models were not adjusted after observing the failure. The default-off native control, enabled no-model process, standalone Rust/native CTest regression, and enabled client Clippy checks also passed.

These results establish this bounded combined Linux fixture, not general accuracy, leak freedom, immediate memory release, or device support. Existing [standalone RSS observations](../packages/parakeet-runtime/README.md#observed-desktop-results) still show allocator/runtime retention after model destruction. No client engine is enabled by this experiment. Device memory, cancellation-drain ownership, access-generation delivery guards, model installation, and platform storage validation remain separate prerequisites.
