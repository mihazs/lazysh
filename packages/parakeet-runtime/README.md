# Parakeet runtime

Internal, synchronous CPU inference support for issue #13. This package is not connected to the client and does not add a dictation engine to the UI. It makes no provider requests and never downloads a speech model.

`VerifiedBundle::read_in(reader, private_parent)` accepts only the exact pinned Parakeet TDT 0.6B v3 INT8 catalog archive described in [PROVENANCE.md](PROVENANCE.md). It streams at most the expected compressed size plus one byte into an owned private file, checks the fixed SHA-256 before decompression, and extracts only four fixed files. There is no arbitrary-directory, arbitrary-ONNX, caller-selected digest, or unchecked model constructor. A private snapshot avoids changing the input between verification and extraction.

Preparation needs roughly 1.1 GiB of temporary disk space: the compressed snapshot and extracted files coexist briefly. The extracted `TempDir` belongs to the reusable `VerifiedBundle`, then to its `Recognizer`; transcription does not re-extract the archive. Dropping the recognizer destroys its native model before deleting the files. No model files are shipped here.

Storage validation runs before consuming model bytes. On Linux/Android, `private_parent` must already exist, belong to the effective user, and have no group/other permission bits (normally mode 0700). It is canonicalized once; only that canonical path is subsequently used. A root-to-leaf `symlink_metadata` walk rejects non-directories, changed symlinks, untrusted owners and untrusted write access. Sticky shared temporary directories may be ancestors when the next child's trusted ownership prevents replacement, but cannot themselves be the private parent. The extracted directory explicitly uses mode 0700 and files use 0600. Android additionally trusts only platform root/system (UID/GID 0/1000), not other application IDs. Apple and Windows model preparation currently fail closed until native ACL ancestry validation exists. Apple's extended ACLs can grant permissions independently of POSIX mode bits; native build support is not permission to load models on those platforms.

Safe Apple/Windows model storage remains an explicit issue #13 acceptance requirement before those client paths can be enabled, not a permanent platform exclusion. Platform validation may use retained verified descriptors/native handles instead of reopening mutable names; that alternative has not been implemented or tested here.

`Recognizer::new(bundle)` creates an exclusively owned CPU recognizer; `transcribe(&mut self, samples)` accepts finite normalized mono 16 kHz PCM lasting 0.1–30 seconds and returns at most 64 KiB of UTF-8 text. Parakeet v3 detects language automatically. There is no forced-language or translation parameter. The native provider is fixed to CPU, greedy decoding and two threads per ONNX session; that is not a process-wide thread-count guarantee.

The C++17 shim owns native models, streams and returned JSON, catches exceptions before Rust FFI, and copies bounded text into caller-owned storage. It uses the public JSON result API instead of the full token snapshot API, which has partial-allocation exception leaks in this pinned source. The shim itself logs no audio, transcript, or exception text. Upstream error diagnostics can still write to stderr/platform logs, and native fatal exits are not C++ exceptions.

## Cancellation and client integration

Calls are synchronous and cannot be interrupted through this API. A client may immediately cancel **delivery** of a result while its native worker continues. The client must keep the worker, recognizer, input and capacity lease alive until the call returns; it must not destroy the model, release its permit, delete files, or start replacement inference early. App lock/session generations must discard stale results. The UI should distinguish cancellation from work that is still finishing. This package does not call `RunOptionsSetTerminate` or promise a CPU/RAM cancellation deadline.

Client integration must wait for the resume-lock prerequisite to merge, then start from updated `main`. Reuse the native voice audio bounds, explicit model-download consent, cancellation IDs, output limits and editable draft/staging flows. Keep Whisper's 160 MiB limit separate. No arbitrary model import or automatic cloud fallback is permitted through this package.

## Build and checks

The build uses pinned official sherpa-onnx source/CMake with CPU static dependencies. It extracts only native build inputs, excluding upstream scripts and their absolute symlink. It downloads source/runtime dependencies, not model weights. `LAZYSH_PARAKEET_SOURCE_ARCHIVE` may point to a predownloaded source archive, but its fixed checksum is always checked. See provenance for the initial Linux proof and cross-platform limits.

From the repository root:

```sh
cargo test -p lazysh-parakeet-runtime --locked
cargo clippy -p lazysh-parakeet-runtime --all-targets --locked -- -D warnings
bunx turbo run test:parakeet-native --filter=@lazysh/parakeet-runtime
```

Cargo's desktop native integration test builds the fake-C-API exception/ownership fixture plus a real no-model ORT environment/regex fixture. Linux additionally asserts the pinned architecture's libstdc++ ABI. Android/iOS builds do not execute host CTest. Rust fixtures test the sealed archive boundary using small generated non-model payloads. No custom test runner or scripts directory is used. macOS/Windows execution of the new ORT startup fixture remains pending CI.

## Explicit Linux speech acceptance

The ignored Cargo integration test uses the small [licensed public LibriSpeech fixture](tests/fixtures/librispeech/README.md), with a fixed WAV hash and independent 17-word corpus reference. It prepares the actual fixed catalog archive, loads one real recognizer, requires normalized word error rate <= 0.10 (chosen before inference), checks ten identical outputs using the same recognizer, and verifies that its model directory disappears after native destruction. It reports phase timings, `getrusage` process peak RSS and Linux `/proc/self/status` current RSS without an invented allocator-dependent RAM cap.

Explicitly supply the manually downloaded, hash-pinned archive; these tasks never download weights, and a missing environment variable fails rather than silently skipping:

```sh
LAZYSH_PARAKEET_TEST_ARCHIVE=/private/cache/parakeet-v3-int8.tar.bz2 \
  bunx turbo run test:parakeet-inference --filter=@lazysh/parakeet-runtime
LAZYSH_PARAKEET_TEST_ARCHIVE=/private/cache/parakeet-v3-int8.tar.bz2 \
  bunx turbo run test:parakeet-inference:release --filter=@lazysh/parakeet-runtime
```

Both tasks disable Turbo caching. Normal `test:rust` runs the inexpensive WAV/provenance and metric fixtures but leaves real inference ignored; normal CI exercises actual ORT startup without a model.

### Observed desktop results

On 2026-10-25, both profiles passed the unchanged reference/threshold and all ten calls returned `mister Quilter is the apostle of the middle classes, and we are glad to welcome his gospel.` Normalized word error rate was zero. Host: Linux x86_64, AMD Ryzen 9 5900X (24 logical CPUs), GCC 16.2.1. Native CMake code was Release in both runs; the Rust preparation pipeline used the indicated Cargo profile. CPU is fixed with two threads per ONNX session, not a process-wide two-thread guarantee.

| Cargo profile | Prepare archive (s) | Load model (s) | First inference (ms) | Second inference (ms) | Calls 3–10 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Debug | 98.124445 | 1.706526 | 391.114 | 389.813 | 381.141–382.922 |
| Release | 26.307601 | 1.667505 | 404.338 | 389.054 | 380.740–382.168 |

| Cargo profile | Process peak after ten calls (KiB) | Current RSS, calls 2–10 (KiB) | Current RSS after model drop (KiB) |
| --- | ---: | ---: | ---: |
| Debug | 1,091,640 | 1,092,992 | 651,916 |
| Release | 1,048,308 | 1,049,424 | 651,472 |

Current RSS stayed at the listed value through calls 2–10, so this bounded run showed a plateau rather than continued per-call growth. After destruction the files were removed, but RSS did **not** return to baseline: allocator/runtime retention remains visible. This does not prove leak freedom, a strict RAM cap, or immediate OS memory release. `getrusage` and `/proc` are independently sampled approximate kernel counters and can differ slightly; the fixture does not impose agreement between them.

These are observations from one shared desktop host, not controlled device benchmarks or latency guarantees. Preparation includes private spooling, hashes and decompression of the already downloaded archive, without network access. OS caches/frequency were not controlled. The release preparation cost remains substantial: a future client manager must retain/reuse the recognizer rather than re-extract for each dictation. Long-lived use, model replacement and mobile memory/battery acceptance remain separate work.

The first actual attempt exposed a native invalid-free abort before model loading. The Linux static ABI fix and a reproduced-red/then-green no-model regression are documented in [PROVENANCE.md](PROVENANCE.md). This is not a model-quality or acceptance-threshold workaround. Combined client C++/Whisper linking remains unverified and must be checked before product integration.

Real archive layout and the one English acceptance sample have now been exercised on Linux x64. General/multilingual accuracy, repeated model replacement, cancellation-drain latency, thermals, battery cost, Windows/macOS loading, Android API 24/16 KiB compatibility and iOS device/simulator acceptance remain pending. A single desktop fixture does not establish those claims. Apple/Windows model preparation remains fail-closed in this branch; client integration and automatic downloads remain absent.
