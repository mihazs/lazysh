# Source, artifact and license provenance

Inspected 2026-10-25. lazysh-owned integration code uses the workspace GPL-3.0-or-later license. Upstream source, runtime libraries, Unicode data and model weights retain their original terms; the GPL license does not replace them.

## Native source

- Upstream: [sherpa-onnx 2.0.0](https://github.com/k2-fsa/sherpa-onnx/tree/8abb7c8f87eae85b2e75f9a4115236c978980add), commit `8abb7c8f87eae85b2e75f9a4115236c978980add`.
- [Source archive](https://codeload.github.com/k2-fsa/sherpa-onnx/tar.gz/8abb7c8f87eae85b2e75f9a4115236c978980add): 11,883,245 bytes; observed SHA-256 `a5a7aac23fdc35fc4caf12e5a8ba63dc425ddb414904640bf13c4e7f38c3632b`. This is a checked download identity, not a publisher signature.
- Only root `CMakeLists.txt`/`LICENSE`, `cmake/`, `sherpa-onnx/` and `toolchains/` are extracted. Upstream build sources are unchanged. Upstream scripts include an absolute symlink; they are excluded, not extracted with relaxed safety settings.
- Official [C API](https://github.com/k2-fsa/sherpa-onnx/blob/8abb7c8f87eae85b2e75f9a4115236c978980add/sherpa-onnx/c-api/c-api.h), [Parakeet example](https://github.com/k2-fsa/sherpa-onnx/blob/8abb7c8f87eae85b2e75f9a4115236c978980add/c-api-examples/nemo-parakeet-c-api.c), and [implementation](https://github.com/k2-fsa/sherpa-onnx/blob/8abb7c8f87eae85b2e75f9a4115236c978980add/sherpa-onnx/c-api/c-api.cc).

The disabled CMake features are Python/JNI, binaries/examples, PortAudio, websocket, TTS, diarization and optional accelerator providers. This remains the broad upstream ASR core; it is not a bespoke Parakeet-only fork. Static link inputs follow the upstream no-TTS library list, with the owning shim first.

The public full result getter allocates raw result/token buffers before later throwing operations. The shim therefore uses `SherpaOnnxGetOfflineStreamResultAsJson` and `SherpaOnnxDestroyOfflineStreamResultJson`, a single returned allocation with RAII for the local JSON string, then parses at most 4 MiB of JSON and copies at most 64 KiB of text. This does not bound upstream intermediate tensor/JSON allocation. Fatal `_Exit` calls on malformed metadata still exist; only the sealed authenticated catalog bundle may reach model loading.

## Declared dependency pins

These identities come from the pinned upstream CMake files. FetchContent checks their archive hashes. Do not substitute unversioned host ONNX Runtime libraries.

| Dependency | Pinned revision/version | SHA-256 |
| --- | --- | --- |
| kaldi-native-fbank | 1.22.4 | `257fea639585ca6ee00860493bb9d7ab32488b8a5407ffe434c1f361ea545fae` |
| kissfft | `febd4caeed32e33ad8b2e0bb5ea77542c40f18ec` | `497103e664168ebe39580b757adbe616f6cf85a16572af581ca7bc42d0ab13fd` |
| utf8proc | 2.12.0 | `f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111` |
| kaldi-decoder | 0.3.0 | `b9f34cfb4fd3b1344100eead79ef4d37aa15962274b9e3056de345021f76a1b0` |
| kaldifst | 1.8.0 | `3f247b7e5a2409071202f5e2bc6200060f66728c0a3443c03923ad2723e040b3` |
| OpenFST fork | 1.8.5-2026-04-10 | `c3549940384cbe4fa9f18c2bcfb1bfbd0a80492fd1b0bfa27433cee395a6a199` |
| Eigen | 5.0.1 | `e9c326dc8c05cd1e044c71f30f1b2e34a6161a3b6ecf445d56b53ff1669e3dec` |
| simple-sentencepiece | 0.7 | `1748a822060a35baa9f6609f84efc8eb54dc0e74b9ece3d82367b7119fdc75af` |
| nlohmann/json | 3.12.0 | `4b92eb0c06d10683f7447ce9406cb97cd4b453be18d7279320f7b2f025c10187` |

The root sherpa Eigen recipe resolves 5.0.1; it overrides kaldi-decoder's separate 3.4.0 recipe through the CMake module path. The initial configure log confirms the 5.0.1 resolution.

ONNX Runtime is **1.28.2**, from the upstream-selected [runtime distribution](https://github.com/csukuangfj/onnxruntime-libs/releases/tag/v1.28.2):

| Static target | SHA-256 |
| --- | --- |
| Linux x64 glibc 2.17 | `2dada92465b40a16fb5011956d93eaf90e3091cf621a953e5371a5e6a687794e` |
| Linux arm64 glibc 2.17 | `fba13fa68dbc9305512869bfa74f53a15e7af983c44ba8a9cbecbce5c21b33b3` |
| macOS arm64 | `bf6e35dc9440d2899c3d21f52b1045fb99176a6ae822281b7245c5418cc338ab` |
| macOS x64 | `cf879fe1fae47078d84fea4d8d4f8d5e38da813c9c3890dd5cc2ff28524c71c8` |
| Android arm64-v8a | `bc68410f35f13df82c260830bf476ee5565f5efd0ec7622297829a929613c6c0` |
| Android x86_64 | `f49dbf456ffe71dd417afb2123ef15202f8f57a4b2a05f12af1cf71f55448137` |
| Windows x64 MD Release | `6fdf64a246ff8c46a303f84b7514e94eda63ae8fefa94491b157f9c14449dbaa` |
| iOS static XCFramework | `2c2299acbb461d26d4bac4bc85985d40e7c7177ed6072703ae0846d88b0b4599` |

The iOS archive digest is the publisher release API digest; no iOS archive was downloaded during the initial Linux proof. Its device/simulator slice paths follow the official iOS recipe. Android uses API 24 and the caller's NDK toolchain; final 16 KiB ELF compatibility needs execution/build evidence. Windows uses the dynamic CRT to match normal Cargo MSVC builds. All platforms must share the client's existing C++ runtime rather than bundle conflicting runtimes.

## Runtime licenses

Retain source copyright notices and applicable notices when redistributing binaries/source. Bundled license texts are in `licenses/`:

- sherpa-onnx, kaldi-native-fbank, kaldi-decoder, kaldifst/OpenFST and simple-sentencepiece: Apache-2.0. Original per-file authorship remains in the pinned source archives.
- ONNX Runtime: MIT, plus its upstream third-party notices (included).
- Eigen: MPL-2.0. Keep the covered source available with its license; this dependency is not an all-permissive closure.
- kissfft: BSD-3-Clause, including its copyright/COPYING notice.
- utf8proc: MIT and the Unicode data terms in its full license file.
- nlohmann/json: MIT.
- Rust `bzip2` wrapper: MIT OR Apache-2.0; its `libbz2-rs-sys` backend uses bzip2-1.0.6 terms (included). Other Rust dependencies retain Cargo-declared licenses and locked checksums.

## Model catalog

- Original model: [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3/blob/541d1f99c6b0c3cd0b11a95167540bb8edefd82b/README.md), model revision `541d1f99c6b0c3cd0b11a95167540bb8edefd82b`, **CC-BY-4.0**. Preserve NVIDIA attribution, model/license links and conversion changes. These weights are not relicensed as GPL.
- Conversion: [sherpa INT8 bundle](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8/tree/2bda32ec70b097a55adaa07d9a7173915b43cc78), revision `2bda32ec70b097a55adaa07d9a7173915b43cc78`.
- [Fixed release archive](https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2): 487,170,055 bytes, publisher SHA-256 `5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf`.
- Three ONNX file sizes/hashes and vocabulary size are pinned in `src/bundle.rs`. The vocabulary is authenticated by the complete archive digest; no independent vocabulary SHA-256 was obtained. Only four fixed leaf names are extracted. Extra regular files/directories are bounded and ignored; links and paths outside the expected prefix fail.

No model artifact has been downloaded or decoded for this package. Real archive layout and inference compatibility are therefore still unverified. The future client download/distribution must include model attribution/license/provenance alongside the verified bundle.

## Initial proof

Before package implementation, unmodified official native sources were built in `/tmp` on Linux x64 with CMake 4.4.4/GCC 16.2.1, CPU/static, optional features disabled. A C++17 probe linked the full published no-TTS static library order. CTest passed two checks: linked ABI reports 2.0.0 and an empty model config returns failure without loading a model. This establishes that Linux build/link slice only; it is not a speech, performance, mobile, or CI acceptance result.

The package's Linux Cargo fixtures include the real linked version check, sealed archive validation, explicit directory/file permissions and real-filesystem unsafe ancestry/sticky-temp/symlink replacement cases. Android's narrow root/system identity allowlist follows [AOSP filesystem identities](https://source.android.com/docs/core/permissions/filesystem); other application IDs are not trusted. Apple and Windows model preparation fail closed pending native ACL validation. Apple's [native ACL declarations](https://github.com/apple-oss-distributions/Libc/blob/main/include/sys/acl.h) define independent mutation/delete/security grants; POSIX mode bits alone are not used to claim that boundary there.

The Cargo-driven CTest fixture substitutes the public C API to exercise exceptions, invalid inputs, output capacity and resource cleanup; it does not instantiate or run a real speech model. The archive fixtures use small generated payloads through a private test-only catalog, while the public API remains sealed to the fixed production catalog. The Linux CI task runs the standalone package through Turbo independently of client integration.
