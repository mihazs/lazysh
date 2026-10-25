# Parakeet runtime

Internal, synchronous CPU inference support for issue #13. This package is not connected to the client and does not add a dictation engine to the UI. It makes no provider requests and never downloads a speech model.

`VerifiedBundle::read_in(reader, private_parent)` accepts only the exact pinned Parakeet TDT 0.6B v3 INT8 catalog archive described in [PROVENANCE.md](PROVENANCE.md). It streams at most the expected compressed size plus one byte into an owned private file, checks the fixed SHA-256 before decompression, and extracts only four fixed files. There is no arbitrary-directory, arbitrary-ONNX, caller-selected digest, or unchecked model constructor. A private snapshot avoids changing the input between verification and extraction.

Preparation needs roughly 1.1 GiB of temporary disk space: the compressed snapshot and extracted files coexist briefly. The extracted `TempDir` belongs to the reusable `VerifiedBundle`, then to its `Recognizer`; transcription does not re-extract the archive. Dropping the recognizer destroys its native model before deleting the files. No model files are shipped here.

Storage validation runs before consuming model bytes. On Linux/Android, `private_parent` must already exist, belong to the effective user, and have no group/other permission bits (normally mode 0700). It is canonicalized once; only that canonical path is subsequently used. A root-to-leaf `symlink_metadata` walk rejects non-directories, changed symlinks, untrusted owners and untrusted write access. Sticky shared temporary directories may be ancestors when the next child's trusted ownership prevents replacement, but cannot themselves be the private parent. The extracted directory explicitly uses mode 0700 and files use 0600. Android additionally trusts only platform root/system (UID/GID 0/1000), not other application IDs. macOS adds a descriptor walk using `openat` with `O_NOFOLLOW` and a native Darwin ACL check, rather than treating mode bits as the complete security boundary. Each opened directory is checked for trusted ownership, local ownership-enforcing storage and actual extended ACL grants. Delete, security, owner, attribute and unknown ALLOW grants are rejected even when masked by mode 0700 or marked inherit-only. Read/search and create-only ancestor grants do not by themselves permit replacement of an existing trusted child; private parent and newly created objects admit no nonzero ALLOW grants. ACL DENY entries only restrict access and are retained. Unreadable or unsupported security information fails closed. This conservative policy may reject custom ACLs granting even the owner additional access.

The private parent is checked before creating any child, preventing an inherited unsafe grant from exposing the model during a later cleanup window. Created directories and file descriptors are checked again. Retaining a descriptor does not itself prevent a UNIX directory rename; the trusted ancestry and ACL checks establish the path-reopening boundary used by the unchanged sherpa API.

iOS and Windows model preparation still fail closed pending their own native storage implementations and acceptance. macOS native ACL fixtures and the pinned native runtime must pass on macOS CI before accepting that platform; a Linux source check is not macOS execution.

Safe iOS/Windows model storage remains an explicit issue #13 acceptance requirement before those client paths can be enabled, not a permanent platform exclusion. Platform validation may use retained verified descriptors/native handles instead of reopening mutable names; that alternative has not been implemented or tested here.

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

On macOS, Cargo also builds a standard CTest fixture that exercises real filesystem ACL creation/retrieval, mode-masked grants, inheritance, safe deny entries, private file handles and create-only ancestor classification without loading a model. The macOS CI task separately builds and links the pinned runtime and exercises its version check.

Cargo's native integration test builds a CTest fixture against a fake implementation of the official C API. It exercises exceptions, allocation failure, ownership, output limits, malformed JSON and invalid audio without models or inference. Rust fixtures test the sealed archive boundary using small generated non-model payloads. No custom test runner or scripts directory is used.

Real archive layout, real-model recognition/accuracy, cold/warm memory, cancellation-drain latency, thermals, Windows/macOS links, Android API 24/16 KiB compatibility and iOS device/simulator acceptance remain unverified. A successful static build or fake-boundary test does not establish those claims.
