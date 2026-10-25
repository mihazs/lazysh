# Android native dependency sources

These are unmodified upstream production sources and matching generated protobuf
messages. `vendor-android.sha256` pins every included file and is verified
before Android compilation. There are no build-time downloads.

| Component | Source pin | Original archive SHA-256 | License |
| --- | --- | --- | --- |
| Protobuf-lite | [protobuf v36.2](https://github.com/protocolbuffers/protobuf/tree/v36.2) | `7e7eaf580ec77f1a392ff1ab1013c13d3b04a6716f002f697f67f3c1113f0530` | BSD, `vendor-android/protobuf/LICENSE` |
| Abseil | [20250512.1](https://github.com/abseil/abseil-cpp/tree/20250512.1) | `9b7a064305e9fd94d124ffa6cc358592eb42b5da588fb4e07d09254aa40086db` | Apache-2.0, `vendor-android/abseil/LICENSE` |
| utf8_range | Included in the protobuf v36.2 source snapshot | Same protobuf archive | MIT, `vendor-android/protobuf/third_party/utf8_range/LICENSE` |

Archives use GitHub codeload URLs `https://codeload.github.com/OWNER/REPO/tar.gz/refs/tags/TAG`.
The protobuf tag resolves to commit `2c74169b34066ceb8ddb6b882fcb3fb32d737a55`
(annotated tag object `424e1b0a184baa5a3c75061a1febd5f60a0a3707`);
Abseil resolves to `76bb24329e8bf5f39704eb10d21b9a80befa7c81`.
Protobuf runtime sources/headers follow the exact upstream
`libprotobuf_lite_srcs`/`libprotobuf_lite_hdrs` lists, together with their CMake
dependency declarations and utf8_range. Abseil includes its headers, production
sources, CMake configuration, and required auxiliary library sources; test,
benchmark, and fuzz executables are omitted. Original notices remain intact.
The lazysh-owned native CMake project composes these upstream files without
building a compiler, full protobuf runtime, tests, or shared dependency libraries.

`vendor-android/generated/` comes from the three pinned Mosh schemas in
`vendor/src/protobufs` using official `protoc` **36.2**, command
`protoc --cpp_out=vendor-android/generated -Ivendor/src/protobufs vendor/src/protobufs/{hostinput,userinput,transportinstruction}.proto`.
The generation compiler was `protoc-36.2-linux-x86_64.zip` from the official
protobuf v36.2 release, SHA-256
`121f6c7afe1d4d0e3ea6aab9432038599250134cbf4474cb1167d2c7decd4278`.
It is not included or executed during Android builds. Generated messages inherit
the source schemas' GPL-3.0-or-later provenance and Mosh notices.

OpenSSL **3.6.3** is built from the pinned Cargo source package
`openssl-src 300.6.1+3.6.3`; Cargo.lock pins its registry checksum. The builder is
MIT/Apache-2.0 and OpenSSL is Apache-2.0. Its complete original source and notices
are supplied through the Cargo source package. Only static `libcrypto` is linked.
`OPENSSL-LICENSE.txt` is an exact copy of that pinned source package's
`openssl/LICENSE.txt` for embedding in application notices without referencing a
developer's Cargo registry path. OpenSSL copyright belongs to its original
authors; its source files retain their individual copyright notices.
Android's public NDK supplies zlib, logging, libc, and libc++; the test executable
and app must use the matching `libc++_shared.so`.

Preserve these notices and the corresponding dependency sources when preparing
linked distributions. This package does not publish a mobile release.
